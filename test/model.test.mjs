import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIncident, outageSpans, spanTouchesDay } from '../public/incident-model.mjs';
import { currentEvidence, verifyFreshness, componentState, viewState, rollup, dayStatus } from '../public/model.mjs';
const now = Date.parse('2026-10-07T18:00:00Z');
const stamp = minutes => new Date(now + minutes * 60000).toISOString();
const good = { status: 'operational', reasonCode: 'verified', observedAt: stamp(-1), lastCompletedSuccessAt: stamp(-30), lastDestinationVerifiedAt: stamp(-5), nextDueAt: stamp(30), graceSeconds: 300 };
test('missing, expired, future and invalid samples never become green', () => {
  assert.equal(currentEvidence(null, 900, now).status, 'unknown');
  for (const at of [stamp(-16), stamp(2), 'not a timestamp']) assert.equal(currentEvidence({ status: 'operational', reasonCode: 'ok', observedAt: at }, 900, now).status, 'unknown');
});
test('green imports need completed work and destination verification', () => {
  assert.equal(verifyFreshness(good, now).status, 'operational');
  for (const key of ['lastCompletedSuccessAt', 'lastDestinationVerifiedAt', 'nextDueAt']) assert.equal(verifyFreshness({ ...good, [key]: null }, now).status, 'unknown');
  assert.equal(verifyFreshness({ ...good, reasonCode: 'ok' }, now).status, 'unknown');
  assert.equal(verifyFreshness({ ...good, lastDestinationVerifiedAt: stamp(-31) }, now).status, 'unknown');
});
test('schedule grace, source age and destination age are enforced', () => {
  assert.equal(verifyFreshness({ ...good, nextDueAt: stamp(-2) }, now).status, 'operational');
  assert.equal(verifyFreshness({ ...good, nextDueAt: stamp(-6) }, now).status, 'degraded');
  assert.equal(verifyFreshness({ ...good, lastCompletedSuccessAt: stamp(-200), lastDestinationVerifiedAt: stamp(-100) }, now, { maxSuccessHours: 2, maxDestinationHours: 1 }).status, 'degraded');
  assert.equal(verifyFreshness({ ...good, observedAt: stamp(-21) }, now).status, 'unknown');
  assert.equal(verifyFreshness({ ...good, graceSeconds: 28801 }, now, { maxGraceSeconds: 28800 }).status, 'unknown');
});
test('a valid no-change import stays healthy and inactive seasonal feeds are explicit', () => {
  assert.equal(verifyFreshness(good, now).status, 'operational');
  assert.equal(verifyFreshness({ status: 'maintenance', reasonCode: 'inactive', observedAt: stamp(-1) }, now).status, 'maintenance');
});
test('HTTP liveness cannot replace missing required rendering', () => {
  const registry = { probes: [{ id: 'http', expiresSeconds: 900 }, { id: 'render', expiresSeconds: 2100 }] };
  const c = { id: 'home', probes: ['http', 'render'] };
  const state = { probes: { http: { status: 'operational', reasonCode: 'ok', observedAt: stamp(-1) } } };
  assert.equal(componentState(c, state, registry, now).status, 'unknown');
  state.probes.render = { status: 'degraded', reasonCode: 'rendering_slow', observedAt: stamp(-1) };
  assert.equal(componentState(c, state, registry, now).status, 'degraded');
});
test('confirmed outage remains visible alongside unknown dependency coverage', () => {
  assert.equal(rollup([{ status: 'unknown' }, { status: 'major_outage' }]), 'major_outage');
  assert.equal(rollup([{ status: 'operational' }, { status: 'unknown' }]), 'unknown');
});
test('unconnected functional services and expired collection stay unknown', () => {
  const registry = { groups: [{ id: 'core' }], probes: [], components: [{ id: 'chat', group: 'core', probes: [] }] };
  const view = viewState(registry, { generatedAt: stamp(-16) }, now);
  assert.equal(view.status, 'unknown'); assert.equal(view.collector.status, 'unknown');
});
test('one isolated failed sample is not an outage day, a confirmed incident or repeat is', () => {
  assert.equal(dayStatus({ operational: 144, major_outage: 1 }), 'degraded');
  assert.equal(dayStatus({ operational: 133, degraded: 1, partial_outage: 1 }), 'degraded');
  assert.equal(dayStatus({ operational: 144, major_outage: 1 }, true), 'major_outage');
  assert.equal(dayStatus({ operational: 144, partial_outage: 2 }), 'partial_outage');
  assert.equal(dayStatus({ partial_outage: 1, major_outage: 1 }), 'major_outage');
  assert.equal(dayStatus({ operational: 144, degraded: 3 }, true), 'degraded');
  assert.equal(dayStatus({ operational: 144 }), 'operational');
  assert.equal(dayStatus({ unknown: 2, major_outage: 1 }), 'degraded');
  assert.equal(dayStatus({}), 'unknown');
});
test('outage spans cover every UTC day an outage incident touched, including stepped-down ones', () => {
  const incident = (id, status, openedAt, resolvedAt, evidence) => normalizeIncident({ id, componentId: 'club-sites', title: 'Club websites: issue', status, reasonCode: 'timeout', openedAt, resolvedAt, stage: resolvedAt ? 'resolved' : 'investigating', updates: [{ id: `${id}-open`, stage: 'investigating', at: openedAt, message: 'Confirmed.', source: 'monitor', evidence: { status: evidence, reasonCode: 'timeout', observedAt: openedAt } }] });
  const spans = outageSpans([
    incident('over-midnight', 'major_outage', '2026-10-29T23:50:00.000Z', '2026-10-30T00:20:00.000Z', 'major_outage'),
    incident('stepped-down', 'degraded', '2026-10-25T10:00:00.000Z', '2026-10-25T11:00:00.000Z', 'partial_outage'),
    incident('only-slow', 'degraded', '2026-10-20T10:00:00.000Z', '2026-10-20T11:00:00.000Z', 'degraded'),
    incident('still-open', 'major_outage', '2026-11-01T10:00:00.000Z', null, 'major_outage'),
  ], Date.parse('2026-11-02T01:00:00Z'))['club-sites'];
  assert.equal(spans.length, 3);
  for (const date of ['2026-10-29', '2026-10-30', '2026-10-25', '2026-11-01', '2026-11-02']) assert.equal(spanTouchesDay(spans, date), true, date);
  for (const date of ['2026-10-28', '2026-10-31', '2026-10-20', '2026-11-03']) assert.equal(spanTouchesDay(spans, date), false, date);
  assert.equal(spanTouchesDay(undefined, '2026-10-29'), false);
});
