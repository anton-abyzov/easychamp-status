import test from 'node:test';
import assert from 'node:assert/strict';
import { recordObservation, confirmedStatus, confirmedSeverity } from '../scripts/observations.mjs';
import { advanceIncidents, applyOwnerUpdate, incidentDocument, seedConfirmedIncidents } from '../scripts/incidents.mjs';
import { normalizeIncident, normalizeIncidents, safePublicUrl, safeText } from '../public/incident-model.mjs';
import { viewState } from '../public/model.mjs';
import { sanitizeFreshness } from '../scripts/freshness-contract.mjs';
import { readFileSync } from 'node:fs';
const registry = JSON.parse(readFileSync(new URL('../config/components.json', import.meta.url), 'utf8'));

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

const severities = (...statuses) => { const run = harness(); return statuses.map((status, i) => run.step(status, i * 5, status === 'unknown' ? 'stale' : undefined).counter.confirmedStatus); };
const [M, P, D, O, U] = ['major_outage', 'partial_outage', 'degraded', 'operational', 'unknown'];
test('a confirmed outage holds while any of the latest three checks reached it, then steps down, then clears on two passes', () => {
  assert.deepEqual(severities(M, M, D, P, U, O, O), [null, M, M, M, M, P, null]);
  const run = harness(); ['major_outage', 'major_outage', 'degraded', 'partial_outage', 'unknown', 'operational', 'operational'].forEach((status, i) => run.step(status, i * 5));
  assert.ok(run.payload.incidents[0].resolvedAt);
});
test('one outage observation among lesser failures or passes never confirms an outage', () => {
  // October 24, 2026: one assistant timeout among provider-capacity observations was
  // confirmed as a major outage and held the outage alert open for more than 32 hours.
  assert.deepEqual(severities(D, D, M, D, D), [null, D, D, D, D]);
  assert.deepEqual(severities(D, M), [null, D], 'from a fresh counter too');
  assert.deepEqual(severities(O, M, O, M, O), [null, null, null, null, null], 'a failure between passes is never two consecutive failures');
  const run = harness(); run.step('degraded', 0); run.step('degraded', 5);
  assert.equal(confirmedSeverity(run.step('major_outage', 10).counter), 'degraded');
});
test('an outage that keeps returning between slower checks is confirmed and does not flap', () => {
  assert.deepEqual(severities(P, D, P, D, P, D), [null, D, P, P, P, P], 'two of three partial outages confirm it while two failures are consecutive');
  assert.deepEqual(severities(M, D, M, D, D, D), [null, D, M, M, M, D]);
  assert.deepEqual(severities(M, M), [null, M], 'two consecutive outage observations still confirm it at once');
});
test('the public incident carries the confirmed severity and its reason, not a single worse check', () => {
  const run = harness(); run.step('degraded', 0, 'provider_capacity_low'); const updates = run.step('degraded', 5, 'provider_capacity_low').incident.updates.length;
  const spike = run.step('major_outage', 10, 'timeout');
  assert.equal(spike.incident.status, 'degraded'); assert.equal(spike.incident.reasonCode, 'provider_capacity_low'); assert.match(spike.incident.title, /degraded service$/);
  assert.equal(spike.incident.updates.length, updates, 'a single worse check neither changes nor flips the incident');
  assert.equal(run.step('degraded', 15, 'provider_capacity_low').incident.updates.length, updates);
  const mixed = harness(); mixed.step('degraded', 0, 'slow'); const slow = mixed.step('major_outage', 5, 'http_error').incident;
  assert.equal(slow.status, 'degraded'); assert.equal(slow.reasonCode, 'slow'); assert.match(slow.title, /degraded performance$/);
  assert.equal(slow.updates[0].message, 'Two fresh observations confirmed needs attention: Response slower than target. Latest check: major outage, Unexpected HTTP response.');
  assert.equal(slow.updates[0].evidence.status, 'major_outage', 'the evidence is still the latest check');
  const escalated = mixed.step('major_outage', 10, 'http_error').incident;
  assert.equal(escalated.status, 'major_outage'); assert.equal(escalated.reasonCode, 'http_error'); assert.match(escalated.title, /availability issue$/);
  assert.equal(escalated.updates.at(-1).message, 'Fresh observations continue to confirm major outage: Unexpected HTTP response.');
  const unconfirmed = { schemaVersion: 1, incidents: [] }; const observation = recordObservation(component('major_outage', 5, 'timeout'), { bad: 1, good: 0 });
  advanceIncidents(unconfirmed, component('major_outage', 5, 'timeout'), observation, at(5));
  assert.equal(observation.counter.bad, 2); assert.equal(confirmedStatus(observation.counter), null); assert.equal(unconfirmed.incidents.length, 0, 'no incident without a confirmed level');
  const opened = harness(); opened.step('major_outage', 0, 'timeout'); const first = opened.step('degraded', 5, 'provider_capacity_low').incident;
  assert.equal(first.status, 'degraded'); assert.equal(first.updates[0].message, 'Two fresh observations confirmed needs attention: AI provider balance is low.');
  const outage = harness(); outage.step('major_outage', 0, 'timeout'); const confirmedOutage = outage.step('major_outage', 5, 'timeout').incident;
  assert.equal(confirmedOutage.status, 'major_outage'); assert.match(confirmedOutage.title, /availability issue$/); assert.equal(confirmedOutage.updates[0].message, 'Two fresh observations confirmed major outage: Check timed out.');
});
test('a past outage steps down when lesser failures alternate with passes or unknown checks', () => {
  assert.deepEqual(severities(M, M, O, D, O, D), [null, M, M, M, D, D]);
  assert.deepEqual(severities(M, M, D, U, D, U, D), [null, M, M, M, M, M, D]);
  assert.deepEqual(severities(M, M, D, D, D, P, P), [null, M, M, M, D, D, P], 'a returning outage is confirmed again, so it alerts again');
});
test('a latched counter written before the severity window steps down from its recorded evidence', () => {
  // Production counter on October 25, 2026: degraded evidence, 395 failures, major outage latched.
  const counter = { evidence: { feed: { observedAt: at(0), status: 'degraded' } }, bad: 395, good: 0, confirmedStatus: 'major_outage', failedAttemptAt: null };
  const next = recordObservation(component('degraded', 5, 'provider_capacity_low'), counter);
  assert.equal(next.counter.confirmedStatus, 'degraded'); assert.deepEqual(next.counter.recent, [['degraded', null], ['degraded', 'provider_capacity_low']]);
  const outage = { ...counter, evidence: { feed: { observedAt: at(0), status: 'major_outage' } } };
  assert.equal(recordObservation(component('degraded', 5, 'provider_capacity_low'), outage).counter.confirmedStatus, 'major_outage', 'a recorded outage among the latest checks holds');
  const unknownEvidence = { ...counter, evidence: { feed: { observedAt: at(0), status: 'unknown' } }, bad: 0 };
  assert.equal(recordObservation(component('major_outage', 5), unknownEvidence).counter.confirmedStatus, 'major_outage', 'a single check never escalates; the held level is kept');
});
// A scheduled job whose destination cannot be verified reports unknown after a successful run,
// never operational. Its run_failed incident must close when a later run succeeds, or every
// later failure would be folded into one silent incident.
test('under an availability latch the incident shows the higher level either rule confirms', () => {
  const payload = { schemaVersion: 1, incidents: [] }; let counter;
  const step = (status, minute, reason, availability) => { const current = component(status, minute, reason); const observation = { ...recordObservation(current, counter), availability, availabilityAdvanced: true }; counter = observation.counter; advanceIncidents(payload, current, observation, at(minute)); return payload.incidents[0]; };
  const partial = { confirmed: 'partial_outage', reasonCode: 'timeout', since: at(0), failed: 2, checked: 4 };
  step('major_outage', 0, 'timeout', partial); assert.equal(step('major_outage', 5, 'timeout', partial).status, 'major_outage');
  step('degraded', 10, 'slow', partial); assert.equal(step('degraded', 15, 'slow', partial).status, 'major_outage', 'an outage among the latest three holds');
  const latched = step('degraded', 20, 'slow', partial);
  assert.equal(confirmedStatus(counter), 'degraded'); assert.equal(confirmedSeverity({ ...counter, availability: partial }), 'partial_outage', 'what the owner alert counts'); assert.equal(latched.status, 'partial_outage'); assert.equal(latched.reasonCode, 'timeout');
  assert.equal(latched.updates.at(-1).message, '2 of the latest 4 availability checks failed: Check timed out. Failures are intermittent; the issue stays open until six consecutive checks pass. Latest check: needs attention, Response slower than target.');
  const cleared = step('degraded', 25, 'slow', { confirmed: null, reasonCode: null, since: null, failed: 0, checked: 4 });
  assert.equal(cleared.status, 'degraded'); assert.equal(cleared.reasonCode, 'slow'); assert.equal(cleared.resolvedAt, null);
  assert.equal(cleared.updates.at(-1).message, 'Fresh observations continue to confirm needs attention: Response slower than target.');
});
const jobAt = (minute, status, reasonCode, extra = {}) => ({ id: 'test-feed', name: 'Test feed', status, reasonCode, observedAt: at(minute), samples: [{ sourceId: 'feed', status, reasonCode, observedAt: at(minute), lastAttemptOutcome: 'unknown', lastAttemptAt: null, lastCompletedSuccessAt: null, ...extra }] });
const jobFailed = (minute, attempt) => jobAt(minute, 'degraded', 'run_failed', { lastAttemptOutcome: 'failed', lastAttemptAt: at(attempt) });
const jobSucceeded = (minute, success) => jobAt(minute, 'unknown', 'verification_unavailable', { lastCompletedSuccessAt: at(success) });
// `at` is the collection time; production records each snapshot minutes after it was observed.
function jobHarness(payload = { schemaVersion: 1, incidents: [] }, counter) {
  return { payload, step(current, recordedAt = current.observedAt) { const observation = recordObservation(current, counter); counter = observation.counter; advanceIncidents(payload, current, observation, recordedAt); return { counter, incidents: payload.incidents, observation }; } };
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
  assert.equal(recovered.incidents[0].updates.at(-1).message, 'A scheduled run completed successfully after the failure. Destination freshness is still unverified.');
  assert.deepEqual(recovered.incidents[0].updates.at(-1).evidence, { status: 'unknown', reasonCode: 'verification_unavailable', observedAt: at(20) });
  assert.match(recovered.incidents[0].postmortem.summary, /Recovery confirmed by a successful scheduled run after the failure: /); assert.doesNotMatch(recovered.incidents[0].postmortem.summary, /upper bound/);
  assert.equal(run.step(jobSucceeded(25, 15)).incidents.length, 1, 'the same success does nothing more');
  const single = run.step(jobFailed(30, 28)); assert.equal(single.incidents.length, 1, 'one failure after a close confirms nothing'); assert.equal(confirmedStatus(single.counter), null);
  const again = run.step(jobFailed(35, 28));
  assert.equal(again.incidents.length, 2); assert.notEqual(again.incidents[0].id, opened.id); assert.equal(again.incidents[0].resolvedAt, null);
});
test('unchecked, older or future successes and other failure kinds keep a job incident open', () => {
  for (const [label, evidence] of [
    ['in progress', jobAt(20, 'unknown', 'in_progress', { lastCompletedSuccessAt: at(15) })],
    ['invalid evidence', jobAt(20, 'unknown', 'invalid_evidence', { lastCompletedSuccessAt: at(15) })],
    ['inactive', jobAt(20, 'unknown', 'inactive', { lastCompletedSuccessAt: at(15) })],
    ['success before the failed run', jobSucceeded(20, -10)],
    ['success at the failed attempt itself', jobSucceeded(20, -5)],
    ['future-dated success', jobSucceeded(20, 200)],
    ['latest attempt failed, dated before the success', jobAt(20, 'unknown', 'verification_unavailable', { lastCompletedSuccessAt: at(15), lastAttemptOutcome: 'failed', lastAttemptAt: at(10) })],
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
  assert.match(newer.incidents[0].updates.at(-1).message, /after the last recorded failure\. Earlier recoveries did not close this incident/);
  assert.match(newer.incidents[0].postmortem.summary, /the duration is an upper bound\.$/);
});
test('with production timing the incident closes on the run that clears the failure', () => {
  // Snapshots are recorded 3 minutes after they are observed, so the incident's last activity
  // (minute 8) is later than a success completed at minute 7. Only the cleared confirmation
  // can close it on this run; waiting for a success newer than minute 8 would add a whole
  // schedule period (a day for daily jobs).
  const run = jobHarness(); run.step(jobFailed(0, -5), at(3)); run.step(jobFailed(5, -5), at(8));
  assert.equal(run.payload.incidents[0].updatedAt, at(8));
  const recovered = run.step(jobSucceeded(10, 7), at(13));
  assert.equal(recovered.observation.superseded, true); assert.equal(recovered.incidents[0].resolvedAt, at(13));
});
test('a failed or running attempt after the success never closes a job incident', () => {
  for (const [label, extra] of [
    ['failed after the success', { lastAttemptOutcome: 'failed', lastAttemptAt: at(18) }],
    ['running after the success', { lastAttemptOutcome: 'running', lastAttemptAt: at(18) }],
    ['unknown outcome started after the success', { lastAttemptOutcome: 'unknown', lastAttemptAt: at(18) }],
  ]) {
    const run = jobHarness(); run.step(jobFailed(0, -5)); run.step(jobFailed(5, -5));
    const after = run.step(jobAt(20, 'unknown', 'verification_unavailable', { lastCompletedSuccessAt: at(15), ...extra }));
    assert.equal(after.observation.superseded, false, label); assert.equal(confirmedStatus(after.counter), 'degraded', label); assert.equal(after.incidents[0].resolvedAt, null, label);
  }
  const run = jobHarness(); run.step(jobFailed(0, -5)); run.step(jobFailed(5, -5));
  assert.ok(run.step(jobAt(20, 'unknown', 'verification_unavailable', { lastCompletedSuccessAt: at(15), lastAttemptOutcome: 'succeeded', lastAttemptAt: at(12) })).incidents[0].resolvedAt, 'the succeeded latest attempt itself is the recovery');
});
test('a missed schedule between failed runs does not leave the job incident unclosable', () => {
  const missed = (minute, due) => jobAt(minute, 'degraded', 'schedule_missed', { nextDueAt: at(due) });
  const run = jobHarness(); run.step(jobFailed(0, -5)); run.step(jobFailed(5, -5));
  run.step(missed(10, 8)); const held = run.step(missed(15, 8));
  assert.equal(held.counter.failedAttemptAt, at(8)); assert.equal(held.incidents[0].reasonCode, 'schedule_missed');
  run.step(jobFailed(20, 18)); assert.equal(run.step(jobFailed(25, 18)).counter.failedAttemptAt, at(18));
  assert.equal(run.step(jobSucceeded(30, 16)).incidents[0].resolvedAt, null, 'a success before the latest failed run');
  const recovered = run.step(jobSucceeded(40, 35));
  assert.equal(recovered.incidents[0].resolvedAt, at(40)); assert.equal(recovered.incidents.length, 1);
});
test('a missed schedule closes after a run completes past the missed due time, not before', () => {
  const missed = (minute, due) => jobAt(minute, 'degraded', 'schedule_missed', { nextDueAt: at(due) });
  const run = jobHarness(); run.step(missed(0, -10)); run.step(missed(5, -10));
  assert.equal(run.step(jobSucceeded(10, -20)).incidents[0].resolvedAt, null, 'the last success came before the missed due time');
  assert.equal(run.step(jobSucceeded(20, 15)).incidents[0].resolvedAt, at(20));
  // A lagging provider snapshot can report a miss whose due time is after its own observation.
  const future = jobHarness(); future.step(missed(0, 30)); assert.equal(future.step(missed(5, 30)).counter.failedAttemptAt, at(30), 'the miss is dated to its due time');
  assert.equal(future.step(jobSucceeded(40, 25)).incidents[0].resolvedAt, null, 'a success before the due time');
  assert.equal(future.step(jobSucceeded(50, 45)).incidents[0].resolvedAt, at(50));
});
test('a job failure without its own time is dated by its observation and still closes on a later run', () => {
  // Review finding on October 25, 2026: a confirmation formed on an undated failure could never be superseded.
  const missed = (minute, due) => jobAt(minute, 'degraded', 'schedule_missed', { nextDueAt: at(due) });
  const run = jobHarness(); run.step(jobFailed(0, -5)); run.step(missed(5, 10));
  assert.equal(run.step(jobFailed(20, 18)).counter.failedAttemptAt, at(18), 'a later dated failure dates the confirmation');
  run.step(jobFailed(25, 18));
  assert.equal(run.step(jobSucceeded(40, 35)).incidents[0].resolvedAt, at(40));
  const undated = minute => jobAt(minute, 'degraded', 'run_failed', { lastAttemptOutcome: 'failed' });
  const bare = jobHarness(); bare.step(undated(0)); assert.equal(bare.step(undated(5)).counter.failedAttemptAt, at(5));
  assert.equal(bare.step(jobSucceeded(10, 3)).incidents[0].resolvedAt, null, 'a success before the failure was observed');
  assert.equal(bare.step(jobSucceeded(20, 8)).incidents[0].resolvedAt, at(20));
  // A stale destination joining a confirmed run failure needs verified recovery from then on.
  const stale = jobHarness(); stale.step(jobFailed(0, -5)); stale.step(jobFailed(5, -5));
  assert.equal(stale.step(jobAt(10, 'degraded', 'destination_stale', { lastCompletedSuccessAt: at(9) })).counter.failedAttemptAt, null);
  assert.equal(stale.step(jobSucceeded(20, 15)).incidents[0].resolvedAt, null);
});
test('cleared or legacy counters never close an incident that needs verified recovery', () => {
  const stale = minute => jobAt(minute, 'degraded', 'destination_stale', { lastCompletedSuccessAt: at(minute - 1) });
  // A stale destination confirmed first: the later run failures cannot be cleared by a run success.
  const run = jobHarness(); run.step(stale(0)); run.step(stale(5)); run.step(jobFailed(10, 8)); const failing = run.step(jobFailed(15, 8));
  assert.equal(failing.incidents[0].reasonCode, 'run_failed'); assert.equal(failing.counter.failedAttemptAt, null);
  const after = run.step(jobSucceeded(30, 25));
  assert.equal(confirmedStatus(after.counter), 'degraded'); assert.equal(after.incidents[0].resolvedAt, null, 'the stale destination still needs verified recovery');
  // A legacy cleared counter with an open destination_stale incident.
  const incident = { ...legacy(), reasonCode: 'destination_stale', updatedAt: at(0) };
  const legacyRun = jobHarness({ schemaVersion: 1, incidents: [incident] }, { evidence: { feed: { observedAt: at(0), status: 'unknown' } }, bad: 0, good: 0, confirmedStatus: null, failedAttemptAt: null });
  assert.equal(legacyRun.step(jobSucceeded(20, 15)).incidents[0].resolvedAt, null);
});
test('the collector pipeline closes the stuck feed incident from a real freshness payload', () => {
  // The October 25, 2026 production shape, through sanitizeFreshness and viewState.
  const component = registry.components.find(c => c.id === 'feed-results');
  const now = Date.parse('2026-10-25T16:26:32.129Z');
  const raw = { id: 'feed-results', status: 'unknown', reasonCode: 'verification_unavailable', measurementKind: 'destination_validation', observedAt: '2026-10-25T16:20:09.000Z', lastCompletedSuccessAt: '2026-10-25T16:03:11.000Z', lastDestinationVerifiedAt: null, nextDueAt: '2026-10-25T16:21:00.000Z', lastAttemptAt: null, lastAttemptStartedAt: null, graceSeconds: 3600, lastAttemptOutcome: 'unknown', destinationVerification: 'unavailable', lastAttemptDeadlineSeconds: null, suspended: null, schedule: null, timeZone: null, metrics: null };
  const state = { schemaVersion: 1, generatedAt: new Date(now).toISOString(), probes: {}, freshness: { 'feed-results': sanitizeFreshness(raw, component, now) }, counters: {} };
  const current = viewState(registry, state, now).components.find(c => c.id === 'feed-results');
  assert.equal(current.status, 'unknown'); assert.equal(current.reasonCode, 'verification_unavailable');
  const incident = { id: 'feed-results-1791424102502', componentId: 'feed-results', title: 'Match results & schedules: degraded service', status: 'degraded', reasonCode: 'run_failed', openedAt: '2026-10-08T01:48:22.502Z', updatedAt: '2026-10-23T23:56:01.333Z', resolvedAt: null, stage: 'investigating', updates: [] };
  const payload = { schemaVersion: 1, incidents: [incident] };
  const observation = recordObservation(current, { evidence: { 'feed-results': { observedAt: '2026-10-25T16:15:09.000Z', status: 'unknown' } }, bad: 0, good: 0, confirmedStatus: null, failedAttemptAt: null });
  advanceIncidents(payload, current, observation, state.generatedAt);
  assert.equal(payload.incidents[0].resolvedAt, state.generatedAt); assert.doesNotThrow(() => incidentDocument(payload));
  const failedLater = { ...raw, lastAttemptOutcome: 'failed', lastAttemptAt: '2026-10-25T16:10:00.000Z' };
  const failedView = viewState(registry, { ...state, freshness: { 'feed-results': sanitizeFreshness(failedLater, component, now) } }, now).components.find(c => c.id === 'feed-results');
  const kept = { schemaVersion: 1, incidents: [{ ...incident, updates: [] }] };
  advanceIncidents(kept, failedView, recordObservation(failedView, { evidence: { 'feed-results': { observedAt: '2026-10-25T16:15:09.000Z', status: 'unknown' } }, bad: 0, good: 0, confirmedStatus: null, failedAttemptAt: null }), state.generatedAt);
  assert.equal(kept.incidents[0].resolvedAt, null, 'a failed attempt after the success keeps it open');
});
test('a confirmed job failure keeps its incident open even with an older success on record', () => {
  const run = jobHarness(); run.step(jobFailed(0, -5)); run.step(jobFailed(5, -5));
  const failing = run.step(jobAt(10, 'degraded', 'run_failed', { lastAttemptOutcome: 'failed', lastAttemptAt: at(8), lastCompletedSuccessAt: at(-30) }));
  assert.equal(failing.incidents[0].resolvedAt, null); assert.equal(failing.incidents.length, 1);
});
