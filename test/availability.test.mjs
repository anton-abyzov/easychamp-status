import test from 'node:test';
import assert from 'node:assert/strict';
import { AVAILABILITY, availabilityState, confirmedSeverity } from '../scripts/observations.mjs';
import { advanceIncidents } from '../scripts/incidents.mjs';
import { publishHeartbeat } from '../scripts/heartbeat.mjs';
import { appendSample, recentChecks } from '../public/uptime.mjs';

const T0 = Date.parse('2026-10-23T15:00:00Z') / 1000;
// One HTTP check every five minutes, as the collector runs.
const checks = codes => [...codes].map((code, i) => ({ at: T0 + i * 300, code, reason: code === 'o' ? undefined : 'timeout' }));
const nowAfter = list => (list.at(-1).at + 60) * 1000;
const state = (codes, previous = null, now) => { const list = checks(codes); return availabilityState(list, previous, now ?? nowAfter(list)); };

test('one failed check is a blip, two of the latest four within 30 minutes confirm an issue', () => {
  assert.equal(state('oooop').confirmed, null);
  assert.equal(state('ooopo').confirmed, null);
  const flapping = state('oopop');
  assert.equal(flapping.confirmed, 'partial_outage');
  assert.equal(flapping.reasonCode, 'timeout');
  assert.equal(flapping.failed, 2); assert.equal(flapping.checked, 4);
  assert.equal(flapping.since, new Date((T0 + 600) * 1000).toISOString());
  // October 23, 15:50Z: two consecutive timeouts must confirm without waiting for the render probe.
  assert.equal(state('ooopp').confirmed, 'partial_outage');
});

test('failures further apart than the window or span do not confirm', () => {
  assert.equal(state('poooop').confirmed, null, 'outside the latest four checks');
  const sparse = [{ at: T0, code: 'p', reason: 'timeout' }, { at: T0 + 1900, code: 'p', reason: 'timeout' }];
  assert.equal(availabilityState(sparse, null, (T0 + 1960) * 1000).confirmed, null, 'outside 30 minutes');
});

test('a confirmed issue latches until six consecutive known checks pass', () => {
  let previous = state('opp');
  assert.equal(previous.confirmed, 'partial_outage');
  for (let passes = 1; passes <= AVAILABILITY.clear; passes++) {
    previous = state('opp' + 'o'.repeat(passes), previous);
    assert.equal(previous.confirmed, passes < AVAILABILITY.clear ? 'partial_outage' : null, `${passes} passes`);
  }
});

test('unknown checks neither confirm nor clear an issue', () => {
  assert.equal(state('uupuu').confirmed, null);
  const confirmed = state('pp');
  const unknowns = state('pp' + 'u'.repeat(12), confirmed);
  assert.equal(unknowns.confirmed, 'partial_outage');
  // Slow answers are known passes for availability.
  assert.equal(state('pp' + 'dododo', confirmed).confirmed, null);
  // Passes separated by unknowns still count; the unknowns do not.
  assert.equal(state('pp' + 'ououououou', confirmed).confirmed, 'partial_outage');
  assert.equal(state('pp' + 'ouououououo', confirmed).confirmed, null);
});

test('a stalled collector keeps the issue open instead of inventing recovery', () => {
  const confirmed = state('pp');
  const later = availabilityState(checks('pp'), confirmed, (T0 + 4 * 3600) * 1000);
  assert.equal(later.confirmed, 'partial_outage');
  assert.equal(later.checked, 0);
});

test('major failures escalate and a lesser failure does not downgrade the open issue', () => {
  assert.equal(state('pm').confirmed, 'major_outage');
  const major = state('mm');
  assert.equal(state('mmopp', major).confirmed, 'major_outage');
  assert.equal(state('mmopp', major).since, major.since);
});

test('future-dated checks are ignored and replayed checks are recorded once', () => {
  const list = [...checks('op'), { at: T0 + 3600, code: 'p', reason: 'timeout' }];
  assert.equal(availabilityState(list, null, (T0 + 700) * 1000).confirmed, null);
  const series = [];
  for (const sample of [...checks('op'), ...checks('op')]) appendSample(series, sample, 900);
  assert.equal(recentChecks(series, 24).length, 2, 'the replayed run adds nothing');
  assert.equal(availabilityState(recentChecks(series, 24), null, (T0 + 400) * 1000).confirmed, null);
  appendSample(series, { at: T0 + 600, code: 'p', reason: 'timeout' }, 900);
  assert.equal(availabilityState(recentChecks(series, 24), null, (T0 + 660) * 1000).confirmed, 'partial_outage');
});

const component = { id: 'console', name: 'Organizer Console', status: 'operational', reasonCode: 'ok', observedAt: '2026-10-23T15:20:00Z', samples: [{ sourceId: 'console-http', status: 'operational', reasonCode: 'ok', observedAt: '2026-10-23T15:20:00Z' }] };
const observe = (availability, extra = {}) => ({ isNew: true, counter: { bad: 0, good: 3, confirmedStatus: null, availability }, availability, availabilityAdvanced: true, ...extra });
const confirmed = (status = 'partial_outage', failed = 2) => ({ confirmed: status, reasonCode: 'timeout', since: '2026-10-23T15:10:00Z', failed, checked: 4 });

test('an intermittent issue opens one incident, escalates and is never resolved while confirmed', () => {
  const payload = { schemaVersion: 1, incidents: [] };
  advanceIncidents(payload, component, observe(confirmed()), '2026-10-23T15:20:00Z');
  assert.equal(payload.incidents.length, 1);
  // advanceIncidents normalizes the document on every call; always read the current record.
  const incident = () => payload.incidents[0];
  assert.equal(incident().title, 'Organizer Console: availability issue');
  assert.equal(incident().status, 'partial_outage');
  assert.match(incident().updates[0].message, /^2 of the latest 4 availability checks failed: Check timed out\./);
  advanceIncidents(payload, component, observe(confirmed()), '2026-10-23T15:25:00Z');
  assert.equal(payload.incidents.length, 1); assert.equal(incident().updates.length, 1); assert.equal(incident().updatedAt, '2026-10-23T15:25:00Z');
  advanceIncidents(payload, component, observe(confirmed('major_outage', 3)), '2026-10-23T15:30:00Z');
  assert.equal(incident().status, 'major_outage'); assert.equal(incident().updates.length, 2);
  // Passing checks while the rule is latched: still open, no monitoring or recovery update.
  advanceIncidents(payload, component, observe(confirmed(), { availabilityAdvanced: false }), '2026-10-23T15:35:00Z');
  assert.equal(incident().resolvedAt, null); assert.equal(incident().updates.length, 2);
  // Six passes cleared the rule; the existing recovery path resolves it.
  advanceIncidents(payload, component, observe({ confirmed: null, reasonCode: null, since: null, failed: 0, checked: 4 }), '2026-10-23T16:05:00Z');
  assert.equal(incident().resolvedAt, '2026-10-23T16:05:00Z'); assert.equal(incident().stage, 'resolved');
});

test('confirmed intermittent issues count in the heartbeat the owner alert reads', async () => {
  assert.equal(confirmedSeverity({ confirmedStatus: null, availability: confirmed() }), 'partial_outage');
  assert.equal(confirmedSeverity({ confirmedStatus: 'degraded', availability: confirmed('major_outage') }), 'major_outage');
  assert.equal(confirmedSeverity({ confirmedStatus: null, availability: { confirmed: null } }), null);
  assert.equal(confirmedSeverity({ confirmedStatus: 'degraded' }), 'degraded');
  const view = { components: [{ id: 'console', status: 'operational' }, { id: 'watch', status: 'operational' }, { id: 'home', status: 'partial_outage' }], counters: { console: { bad: 0, good: 3, confirmedStatus: null, availability: confirmed() }, watch: { bad: 0, good: 3, confirmedStatus: null, availability: { confirmed: null } }, home: { bad: 1, good: 0, confirmedStatus: null, availability: { confirmed: null } } } };
  let event;
  await publishHeartbeat(view, '2026-10-23T15:20:00Z', { NEW_RELIC_STATUS_LICENSE_KEY: 'test', NEW_RELIC_STATUS_ACCOUNT_ID: '1' }, async (_url, options) => { event = JSON.parse(options.body)[0]; return new Response('', { status: 200 }); });
  assert.equal(event.confirmedOutageComponents, 1, 'only the confirmed intermittent issue, not the single failed check');
  assert.equal(event.outageComponents, 1);
});

test('once six passes clear the rule, an availability-only incident resolves on any later run without a recent failure', () => {
  const cleared = (failed = 0) => ({ confirmed: null, reasonCode: null, since: null, failed, checked: 4 });
  const run = (payload, status, counter, failed, at) => advanceIncidents(payload, { ...component, status, reasonCode: status === 'operational' ? 'ok' : status === 'unknown' ? 'browser_unavailable' : 'rendering_slow' }, { isNew: true, counter: { bad: 0, good: 0, confirmedStatus: null, ...counter, availability: cleared(failed) }, availability: cleared(failed), availabilityAdvanced: true }, at);
  // Reviewer scenario S7: a single slow render on the clearing run, then the render check is blocked.
  const s7 = { schemaVersion: 1, incidents: [] };
  advanceIncidents(s7, component, observe(confirmed()), '2026-10-23T15:20:00Z');
  run(s7, 'degraded', { bad: 1 }, 1, '2026-10-23T15:50:00Z');
  assert.equal(s7.incidents[0].resolvedAt, null, 'not on a run with a recent failed check');
  run(s7, 'unknown', {}, 0, '2026-10-23T15:55:00Z');
  assert.equal(s7.incidents[0].resolvedAt, '2026-10-23T15:55:00Z');
  assert.equal(s7.incidents[0].updates.at(-1).message, 'Six consecutive availability checks passed.');
  assert.match(s7.incidents[0].postmortem.summary, /six consecutive passing availability checks/);
  // Reviewer scenario S9: render alternates slow and ok; it resolves on the first run without a recent failure.
  const s9 = { schemaVersion: 1, incidents: [] };
  advanceIncidents(s9, component, observe(confirmed()), '2026-10-23T15:20:00Z');
  run(s9, 'degraded', { bad: 1 }, 0, '2026-10-23T15:50:00Z');
  assert.equal(s9.incidents[0].resolvedAt, '2026-10-23T15:50:00Z');
  // A consecutive-rule confirmation still holds the incident open.
  const held = { schemaVersion: 1, incidents: [] };
  advanceIncidents(held, component, observe(confirmed()), '2026-10-23T15:20:00Z');
  run(held, 'major_outage', { bad: 2, confirmedStatus: 'major_outage' }, 0, '2026-10-23T15:50:00Z');
  assert.equal(held.incidents[0].resolvedAt, null, 'the render check still confirms an outage');
  // Services without the availability rule (data jobs) are untouched by it.
  const job = { schemaVersion: 1, incidents: [] };
  advanceIncidents(job, component, { isNew: true, counter: { bad: 2, good: 0, confirmedStatus: 'degraded' } }, '2026-10-23T15:20:00Z');
  advanceIncidents(job, { ...component, status: 'degraded', reasonCode: 'run_failed' }, { isNew: true, counter: { bad: 2, good: 0, confirmedStatus: 'degraded' } }, '2026-10-23T15:20:00Z');
  advanceIncidents(job, { ...component, status: 'unknown', reasonCode: 'stale' }, { isNew: true, counter: { bad: 0, good: 0, confirmedStatus: 'degraded' } }, '2026-10-23T15:25:00Z');
  assert.equal(job.incidents[0]?.resolvedAt ?? null, null);
});

test('while availability is latched the consecutive rule still escalates and never downgrades the incident', () => {
  const payload = { schemaVersion: 1, incidents: [] };
  advanceIncidents(payload, component, observe(confirmed('partial_outage')), '2026-10-23T15:20:00Z');
  const major = { ...component, status: 'major_outage', reasonCode: 'http_error' };
  advanceIncidents(payload, major, { ...observe(confirmed('partial_outage')), counter: { bad: 2, good: 0, confirmedStatus: 'major_outage' } }, '2026-10-23T15:25:00Z');
  assert.equal(payload.incidents[0].status, 'major_outage', 'escalated by the render check');
  const slow = { ...component, status: 'degraded', reasonCode: 'rendering_slow' };
  advanceIncidents(payload, slow, { ...observe(confirmed('partial_outage')), counter: { bad: 3, good: 0, confirmedStatus: 'major_outage' } }, '2026-10-23T15:30:00Z');
  assert.equal(payload.incidents[0].status, 'major_outage', 'not downgraded to degraded');
  const updates = payload.incidents[0].updates.length;
  advanceIncidents(payload, slow, { ...observe(confirmed('partial_outage')), counter: { bad: 4, good: 0, confirmedStatus: 'major_outage' } }, '2026-10-23T15:35:00Z');
  assert.equal(payload.incidents[0].updates.length, updates, 'no update churn between the two rules');
});
