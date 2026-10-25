import test from 'node:test';
import assert from 'node:assert/strict';
import { recordObservation, confirmedStatus, confirmedSeverity } from '../scripts/observations.mjs';
import { advanceIncidents, applyOwnerUpdate, incidentDocument, seedConfirmedIncidents } from '../scripts/incidents.mjs';
import { normalizeIncident, normalizeIncidents, safePublicUrl, safeText } from '../public/incident-model.mjs';

const at = minutes => new Date(Date.parse('2026-10-07T18:00:00Z') + minutes * 60000).toISOString();
const component = (status, minute, reasonCode = status === 'operational' ? 'ok' : status === 'unknown' ? 'stale' : 'run_failed') => ({ id: 'test-feed', name: 'Test feed', status, reasonCode, observedAt: at(minute), samples: [{ sourceId: 'feed', status, reasonCode, observedAt: at(minute), nextDueAt: at(480) }] });
const legacy = resolvedAt => ({ id: 'test-feed-123', componentId: 'test-feed', title: 'Test feed: degraded service', status: 'degraded', reasonCode: 'run_failed', openedAt: at(0), updatedAt: resolvedAt || at(0), resolvedAt: resolvedAt || null });
function harness() {
  const payload = { schemaVersion: 1, incidents: [] }; let counter;
  return { payload, step(status, minute, reason) { const current = component(status, minute, reason); const observation = recordObservation(current, counter); counter = observation.counter; advanceIncidents(payload, current, observation, at(minute)); return { counter, incident: payload.incidents[0], observation }; } };
}
test('two failures, unknown, replayed recovery and two fresh successes form one durable incident', () => {
  const run = harness();
  assert.equal(run.step('degraded', 0).incident, undefined);
  const { incident } = run.step('degraded', 5); const id = incident.id;
  assert.equal(incident.stage, 'investigating'); assert.equal(incident.deadlineAt, at(480)); assert.match(incident.title, /degraded service/);
  assert.equal(run.step('degraded', 5).observation.isNew, false); assert.equal(run.payload.incidents.length, 1);
  const missing = run.step('unknown', 10); assert.equal(missing.counter.good, 0); assert.equal(confirmedStatus(missing.counter), 'degraded'); assert.equal(missing.incident.resolvedAt, null);
  const first = run.step('operational', 15); assert.equal(first.incident.stage, 'monitoring'); assert.equal(first.incident.resolvedAt, null); assert.equal(confirmedStatus(first.counter), 'degraded');
  assert.equal(run.step('operational', 15).observation.isNew, false);
  const recovered = run.step('operational', 20); assert.equal(recovered.incident.id, id); assert.equal(recovered.incident.stage, 'resolved'); assert.equal(recovered.incident.resolvedAt, at(20)); assert.equal(confirmedStatus(recovered.counter), null);
  assert.equal(recovered.incident.postmortem.state, 'draft'); assert.equal(recovered.incident.postmortem.url, undefined); assert.match(recovered.incident.postmortem.summary, /owner review/); assert.match(recovered.incident.postmortem.summary, /15 minutes/);
  assert.deepEqual(recovered.incident.updates.map(update => update.stage), ['investigating', 'investigating', 'monitoring', 'resolved']);
  run.step('degraded', 25); run.step('degraded', 30); assert.equal(run.payload.incidents.length, 2); assert.notEqual(run.payload.incidents[0].id, id);
});
test('an intervening unknown or maintenance breaks the recovery streak without clearing confirmation', () => {
  for (const gap of ['unknown', 'maintenance']) {
    const run = harness(); run.step('degraded', 0); run.step('degraded', 5); run.step('operational', 10); run.step(gap, 15, gap === 'maintenance' ? 'inactive' : 'stale');
    const current = run.step('operational', 20); assert.equal(current.counter.good, 1); assert.equal(current.incident.resolvedAt, null); assert.equal(confirmedStatus(current.counter), 'degraded');
    assert.equal(run.step('operational', 25).incident.stage, 'resolved');
  }
});
test('cached rendering can neither open an incident nor close an existing incident', () => {
  const payload = { schemaVersion: 1, incidents: [legacy()] };
  const previous = { bad: 0, good: 1, confirmedStatus: 'degraded', evidence: { http: { observedAt: at(0), status: 'operational' }, render: { observedAt: at(0), status: 'operational' } } };
  const current = { ...component('operational', 5), samples: [{ sourceId: 'http', status: 'operational', observedAt: at(5) }, { sourceId: 'render', status: 'operational', observedAt: at(0) }] };
  const observation = recordObservation(current, previous); advanceIncidents(payload, current, observation, at(5));
  assert.equal(observation.isNew, false); assert.equal(payload.incidents[0].resolvedAt, null);
});
test('legacy unresolved incidents seed confirmation even after old unknown counter resets', () => {
  const payload = { schemaVersion: 1, incidents: [legacy(), { ...legacy(at(2)), id: 'resolved-feed-123', componentId: 'resolved-feed' }] };
  const counters = { 'test-feed': { bad: 0, good: 0, evidence: { feed: { observedAt: at(0), status: 'unknown' } } }, 'resolved-feed': { bad: 0, good: 0 } };
  seedConfirmedIncidents(counters, payload); assert.equal(counters['test-feed'].confirmedStatus, 'degraded'); assert.equal(counters['resolved-feed'].confirmedStatus, undefined);
  assert.equal(confirmedStatus(recordObservation(component('unknown', 5), counters['test-feed']).counter), 'degraded');
  const explicit = { 'test-feed': { bad: 0, good: 0, confirmedStatus: null } }; seedConfirmedIncidents(explicit, payload); assert.equal(explicit['test-feed'].confirmedStatus, null);
});
test('owner stages are audited, idempotent, and cannot bypass automatic recovery', () => {
  const run = harness(); run.step('degraded', 0); const id = run.step('degraded', 5).incident.id;
  const context = { login: 'owner', at: at(7), updateId: 'owner-123' };
  const investigating = applyOwnerUpdate(run.payload, { incidentId: id, stage: 'investigating', message: 'The failed import remains under investigation; recovery is unconfirmed.' }, { ...context, updateId: 'owner-investigating' });
  assert.equal(investigating.incidents[0].stage, 'investigating'); assert.equal(investigating.incidents[0].updates.at(-1).source, 'owner');
  const identified = applyOwnerUpdate(run.payload, { incidentId: id, stage: 'identified', message: 'The owner identified a cause and is reviewing the repair.' }, context);
  assert.equal(identified.incidents[0].stage, 'identified'); assert.deepEqual(identified.incidents[0].updates.at(-1).author, { login: 'owner' });
  assert.equal(applyOwnerUpdate(identified, { incidentId: id, stage: 'identified', message: 'The owner identified a cause and is reviewing the repair.' }, { ...context, at: at(8) }).incidents[0].updates.length, 2);
  assert.throws(() => applyOwnerUpdate(identified, { incidentId: id, stage: 'resolved', message: 'Done' }, context), /invalid_owner_update/);
  assert.throws(() => applyOwnerUpdate(identified, { incidentId: id, stage: 'writeup_published', message: 'Reviewed', url: 'https://example.com/report' }, context), /requires_resolved/);
  assert.throws(() => applyOwnerUpdate(identified, { incidentId: id, stage: 'monitoring', message: 'token=private' }, context), /invalid_owner_update/);
  assert.throws(() => applyOwnerUpdate(identified, { incidentId: id, stage: 'monitoring', message: 'Reviewed' }, { ...context, at: at(1) }), /invalid_owner_context/);
});
test('a write-up becomes published only through a reviewed owner update with a safe link', () => {
  const run = harness(); run.step('degraded', 0); run.step('degraded', 5); run.step('operational', 10); const id = run.step('operational', 15).incident.id;
  const context = { login: 'owner', at: at(20), updateId: 'owner-456' };
  assert.throws(() => applyOwnerUpdate(run.payload, { incidentId: id, stage: 'writeup_published', message: 'Reviewed', url: 'javascript:alert(1)' }, context), /safe_url/);
  const published = applyOwnerUpdate(run.payload, { incidentId: id, stage: 'writeup_published', message: 'Owner-reviewed incident findings.', url: 'https://example.com/postmortems/test' }, context);
  const row = normalizeIncident(published.incidents[0]); assert.equal(row.stage, 'writeup_published'); assert.equal(row.postmortem.state, 'published'); assert.equal(row.postmortem.publishedAt, at(20));
  const newer = applyOwnerUpdate(published, { incidentId: id, stage: 'writeup_published', message: 'Updated owner-reviewed findings.', url: 'https://example.com/postmortems/newer' }, { login: 'owner', at: at(25), updateId: 'owner-789' });
  const replay = applyOwnerUpdate(newer, { incidentId: id, stage: 'writeup_published', message: 'Owner-reviewed incident findings.', url: 'https://example.com/postmortems/test' }, { ...context, at: at(30) });
  assert.equal(replay.incidents[0].postmortem.url, 'https://example.com/postmortems/newer'); assert.equal(replay.incidents[0].updates.length, newer.incidents[0].updates.length);
  assert.throws(() => applyOwnerUpdate(published, { incidentId: id, stage: 'identified', message: 'Changed' }, context), /immutable/);
});
test('legacy normalization preserves facts without inventing detailed observations or a published write-up', () => {
  const row = normalizeIncident(legacy(at(20))); assert.equal(row.stage, 'resolved'); assert.equal(row.postmortem, undefined); assert.equal(row.updates.length, 2); assert.match(row.updates[1].message, /unavailable/);
  const unsafe = normalizeIncident({ ...legacy(at(20)), stage: 'writeup_published', postmortem: { state: 'published', summary: 'Reviewed', url: 'https://127.0.0.1/admin' } }); assert.equal(unsafe.stage, 'resolved'); assert.equal(unsafe.postmortem.state, 'draft');
  const unsafeSummary = normalizeIncident({ ...legacy(at(20)), stage: 'writeup_published', postmortem: { state: 'published', summary: 'token=private', url: 'https://example.com/report' } }); assert.equal(unsafeSummary.stage, 'resolved');
  assert.equal(normalizeIncidents({ incidents: [legacy(), { id: 'invalid' }] }).length, 1);
});
test('durable writers fail closed instead of silently dropping malformed or duplicate records', () => {
  assert.throws(() => incidentDocument({ schemaVersion: 1, incidents: [legacy(), { id: 'invalid' }] }), /invalid_incident_records/);
  assert.throws(() => incidentDocument({ schemaVersion: 1, incidents: [legacy(), { ...legacy(), id: 'test-feed-456' }] }), /duplicate_open_incidents/);
  assert.throws(() => incidentDocument({ schemaVersion: 1, incidents: [{ ...legacy(), resolvedAt: 'invalid' }] }), /invalid_incident_records/);
});
test('public owner prose rejects common provider credentials, private keys and credential-bearing connection URLs', () => {
  const connection = new URL('mongodb+srv://example.com/db'); connection.username = 'fixture-user'; connection.password = 'fixture-password';
  for (const value of ['NRAK-' + 'a'.repeat(32), 'NRAL-' + 'a'.repeat(32), 'NRII-' + 'a'.repeat(32), 'AKIA' + 'A'.repeat(16), '-----BEGIN PRIVATE KEY-----', '-----BEGIN CERTIFICATE-----', connection.href, 'https://example.com/path?access_token=private']) assert.equal(safeText(value), false, value);
  assert.equal(safeText('The owner is reviewing the failed import.'), true);
});
test('public write-up URLs reject credentials, private address forms and credential query strings', () => {
  for (const value of ['http://example.com/report', 'https://user:pass@example.com/report', 'https://localhost/report', 'https://10.0.0.1/report', 'https://[::1]/report', 'https://app.internal/report', 'https://example.com/report?token=private', 'https://example.com/report#token=private', 'https://example.com/report#%74oken=private', 'https://example.com/' + 'NRII-' + 'a'.repeat(32), 'https://example.com:8443/report']) assert.equal(safePublicUrl(value), null, value);
  assert.equal(safePublicUrl('https://github.com/org/repo/blob/main/docs/report.md'), 'https://github.com/org/repo/blob/main/docs/report.md');
});

test('a confirmed outage holds through one lesser failure, steps down after two, and clears after two passing checks', () => {
  const run = harness(); run.step('major_outage', 0); run.step('major_outage', 5);
  assert.equal(run.step('degraded', 10).counter.confirmedStatus, 'major_outage', 'one lesser failure does not step down');
  assert.equal(run.step('partial_outage', 15).counter.confirmedStatus, 'partial_outage', 'two consecutive lesser failures confirm the higher of the two');
  assert.equal(run.step('unknown', 20).counter.confirmedStatus, 'partial_outage');
  assert.equal(run.step('operational', 25).counter.confirmedStatus, 'partial_outage');
  assert.equal(run.step('operational', 30).counter.confirmedStatus, null); assert.ok(run.payload.incidents[0].resolvedAt);
});
test('one outage observation among lesser failures never confirms an outage', () => {
  // October 24, 2026: one assistant timeout among provider-capacity observations was
  // confirmed as a major outage and held the outage alert open for more than 32 hours.
  const run = harness(); run.step('degraded', 0); run.step('degraded', 5);
  const spike = run.step('major_outage', 10);
  assert.equal(spike.counter.confirmedStatus, 'degraded'); assert.equal(confirmedSeverity(spike.counter), 'degraded');
  assert.equal(run.step('degraded', 15).counter.confirmedStatus, 'degraded');
  run.step('major_outage', 20); assert.equal(run.step('major_outage', 25).counter.confirmedStatus, 'major_outage', 'two consecutive outage observations still confirm it');
  assert.equal(run.step('partial_outage', 30).counter.confirmedStatus, 'major_outage');
});
test('a stepped-down outage that returns is confirmed again, so it alerts again', () => {
  const run = harness(); run.step('major_outage', 0); run.step('major_outage', 5); run.step('degraded', 10);
  assert.equal(run.step('degraded', 15).counter.confirmedStatus, 'degraded');
  run.step('partial_outage', 20); assert.equal(run.step('partial_outage', 25).counter.confirmedStatus, 'partial_outage');
  assert.equal(run.payload.incidents.length, 1, 'the open incident follows the failure; it is not resolved by a lesser failure');
});
test('a latched counter written before lastStatus steps down from its recorded evidence', () => {
  // Production counter on October 25, 2026: degraded evidence, 395 failures, major outage latched.
  const counter = { evidence: { feed: { observedAt: at(0), status: 'degraded' } }, bad: 395, good: 0, confirmedStatus: 'major_outage', failedAttemptAt: null };
  const next = recordObservation(component('degraded', 5, 'provider_capacity_low'), counter);
  assert.equal(next.counter.confirmedStatus, 'degraded'); assert.equal(next.counter.lastStatus, 'degraded');
  const outage = { ...counter, evidence: { feed: { observedAt: at(0), status: 'major_outage' } } };
  assert.equal(recordObservation(component('degraded', 5, 'provider_capacity_low'), outage).counter.confirmedStatus, 'major_outage', 'one lesser failure after recorded outage evidence holds');
});

// A scheduled job whose destination cannot be verified reports unknown after a successful run,
// never operational. Its run_failed incident must close when a later run succeeds, or every
// later failure would be folded into one silent incident.
const jobAt = (minute, status, reasonCode, extra = {}) => ({ id: 'test-feed', name: 'Test feed', status, reasonCode, observedAt: at(minute), samples: [{ sourceId: 'feed', status, reasonCode, observedAt: at(minute), lastAttemptOutcome: 'unknown', lastAttemptAt: null, lastCompletedSuccessAt: null, ...extra }] });
const jobFailed = (minute, attempt) => jobAt(minute, 'degraded', 'run_failed', { lastAttemptOutcome: 'failed', lastAttemptAt: at(attempt) });
const jobSucceeded = (minute, success) => jobAt(minute, 'unknown', 'verification_unavailable', { lastCompletedSuccessAt: at(success) });
function jobHarness(payload = { schemaVersion: 1, incidents: [] }, counter) {
  return { payload, step(current) { const observation = recordObservation(current, counter); counter = observation.counter; advanceIncidents(payload, current, observation, current.observedAt); return { counter, incidents: payload.incidents, observation }; } };
}
test('a run_failed incident closes when a later run succeeds and the next failure opens a new one', () => {
  const run = jobHarness();
  run.step(jobFailed(0, -5)); const opened = run.step(jobFailed(5, -5)).incidents[0];
  assert.equal(opened.reasonCode, 'run_failed'); assert.equal(opened.resolvedAt, null);
  const running = run.step(jobAt(10, 'unknown', 'in_progress', { lastAttemptOutcome: 'running', lastAttemptAt: at(8), lastCompletedSuccessAt: at(9) }));
  assert.equal(running.incidents[0].resolvedAt, null, 'a run in progress is not a recovery'); assert.equal(confirmedStatus(running.counter), 'degraded');
  const recovered = run.step(jobSucceeded(20, 15));
  assert.equal(recovered.observation.superseded, true); assert.equal(confirmedStatus(recovered.counter), null);
  assert.equal(recovered.incidents[0].id, opened.id); assert.equal(recovered.incidents[0].resolvedAt, at(20)); assert.equal(recovered.incidents[0].stage, 'resolved');
  assert.match(recovered.incidents[0].updates.at(-1).message, /completed successfully after the failed run\. Destination freshness is still unverified\./);
  assert.deepEqual(recovered.incidents[0].updates.at(-1).evidence, { status: 'unknown', reasonCode: 'verification_unavailable', observedAt: at(20) });
  assert.match(recovered.incidents[0].postmortem.summary, /Recovery confirmed by a successful scheduled run after the failed run/);
  assert.equal(run.step(jobSucceeded(25, 15)).incidents.length, 1, 'the same success does nothing more');
  run.step(jobFailed(30, 28)); const again = run.step(jobFailed(35, 28));
  assert.equal(again.incidents.length, 2); assert.notEqual(again.incidents[0].id, opened.id); assert.equal(again.incidents[0].resolvedAt, null);
});
test('unchecked, older or future successes and other failure kinds keep a job incident open', () => {
  for (const [label, evidence] of [
    ['in progress', jobAt(20, 'unknown', 'in_progress', { lastCompletedSuccessAt: at(15) })],
    ['invalid evidence', jobAt(20, 'unknown', 'invalid_evidence', { lastCompletedSuccessAt: at(15) })],
    ['inactive', jobAt(20, 'unknown', 'inactive', { lastCompletedSuccessAt: at(15) })],
    ['success before the failed run', jobSucceeded(20, -10)],
    ['future-dated success', jobSucceeded(20, 200)],
  ]) {
    const run = jobHarness(); run.step(jobFailed(0, -5)); run.step(jobFailed(5, -5));
    const after = run.step(evidence);
    assert.equal(after.incidents[0].resolvedAt, null, label); assert.equal(confirmedStatus(after.counter), 'degraded', label);
  }
  const stale = minute => jobAt(minute, 'degraded', 'destination_stale', { lastCompletedSuccessAt: at(minute - 1) });
  const run = jobHarness(); run.step(stale(0)); run.step(stale(5));
  assert.equal(run.step(jobSucceeded(20, 15)).incidents[0].resolvedAt, null, 'a stale destination needs verified recovery');
});
test('an open run_failed incident left behind by an already-cleared counter closes on the next newer success', () => {
  // Production state on October 25, 2026: the counter rule cleared the confirmation, but the
  // incident stayed open and silenced every later failure of the job.
  const incident = { ...legacy(), updatedAt: at(60), updates: [{ id: 'test-feed-123-open', stage: 'investigating', at: at(0), message: 'Two fresh observations confirmed needs attention: Scheduled import failed.', source: 'monitor', evidence: { status: 'degraded', reasonCode: 'run_failed', observedAt: at(0) } }, { id: 'test-feed-123-unknown', stage: 'investigating', at: at(60), message: 'Latest evidence is unknown: Destination freshness unverified. The incident remains open; recovery is unconfirmed.', source: 'monitor', evidence: { status: 'unknown', reasonCode: 'verification_unavailable', observedAt: at(60) } }] };
  const counter = { evidence: { feed: { observedAt: at(60), status: 'unknown' } }, bad: 0, good: 0, confirmedStatus: null, failedAttemptAt: null };
  const run = jobHarness({ schemaVersion: 1, incidents: [incident] }, counter);
  const older = run.step(jobSucceeded(70, 50));
  assert.equal(older.observation.superseded, false); assert.equal(older.incidents[0].resolvedAt, null, 'a success older than the last recorded activity proves nothing new');
  const newer = run.step(jobSucceeded(90, 80));
  assert.equal(newer.incidents[0].resolvedAt, at(90)); assert.equal(newer.incidents[0].stage, 'resolved');
});
test('a confirmed job failure keeps its incident open even with an older success on record', () => {
  const run = jobHarness(); run.step(jobFailed(0, -5)); run.step(jobFailed(5, -5));
  const failing = run.step(jobAt(10, 'degraded', 'run_failed', { lastAttemptOutcome: 'failed', lastAttemptAt: at(8), lastCompletedSuccessAt: at(-30) }));
  assert.equal(failing.incidents[0].resolvedAt, null); assert.equal(failing.incidents.length, 1);
});
