import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeIncident, outageSpans, incidentOutageOnDay } from '../public/incident-model.mjs';
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
  assert.equal(dayStatus({ operational: 144, major_outage: 1 }, 'major_outage'), 'major_outage');
  assert.equal(dayStatus({ operational: 144, partial_outage: 2 }), 'partial_outage');
  assert.equal(dayStatus({ partial_outage: 1, major_outage: 1 }), 'major_outage');
  assert.equal(dayStatus({ operational: 144, degraded: 3 }, 'major_outage'), 'major_outage');
  assert.equal(dayStatus({ operational: 144 }), 'operational');
  assert.equal(dayStatus({ unknown: 2, major_outage: 1 }), 'degraded');
  assert.equal(dayStatus({}), 'unknown');
  assert.equal(dayStatus({}, 'partial_outage'), 'partial_outage');
  assert.equal(dayStatus({ operational: 4 }, 'major_outage'), 'major_outage');
  assert.equal(dayStatus({ major_outage: 1 }, 'partial_outage'), 'partial_outage');
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
  for (const date of ['2026-10-29', '2026-10-30', '2026-11-01', '2026-11-02']) {
    assert.equal(incidentOutageOnDay(spans, date), 'major_outage', date);
  }
  assert.equal(incidentOutageOnDay(spans, '2026-10-25'), 'partial_outage');
  for (const date of ['2026-10-28', '2026-10-31', '2026-10-20', '2026-11-03']) {
    assert.equal(incidentOutageOnDay(spans, date), undefined, date);
  }
  assert.equal(incidentOutageOnDay(undefined, '2026-10-29'), undefined);
});

test('outage evidence is limited to the outage interval in a longer degraded incident', () => {
  const evidence = (status, at) => ({ evidence: { status, observedAt: at } });
  const incident = {
    componentId: 'assistant',
    status: 'degraded',
    openedAt: '2026-10-09T07:34:00Z',
    resolvedAt: '2026-10-15T07:16:00Z',
    updates: [
      evidence('degraded', '2026-10-09T07:34:00Z'),
      evidence('major_outage', '2026-10-13T10:20:00Z'),
      evidence('unknown', '2026-10-13T10:35:00Z'),
      evidence('degraded', '2026-10-14T00:00:00Z'),
    ],
  };
  const spans = outageSpans([incident], Date.parse('2026-10-16T00:00:00Z')).assistant;
  assert.equal(incidentOutageOnDay(spans, '2026-10-12'), undefined);
  assert.equal(incidentOutageOnDay(spans, '2026-10-13'), 'major_outage');
  assert.equal(incidentOutageOnDay(spans, '2026-10-14'), undefined);
});

test('a monitor update can carry a failed latest check without confirming an outage', () => {
  const openedAt = '2026-11-01T10:00:00Z';
  const update = {
    id: 'open', stage: 'investigating', source: 'monitor', at: openedAt,
    message: 'Two fresh observations confirmed needs attention: Response slower than target. Latest check: major outage, Check timed out.',
    evidence: { status: 'major_outage', reasonCode: 'timeout', observedAt: openedAt },
  };
  const incident = normalizeIncident({
    id: 'assistant-issue', componentId: 'assistant', title: 'Assistant issue',
    openedAt, status: 'degraded', updates: [update],
  });
  const now = Date.parse('2026-11-01T12:00:00Z');
  assert.equal(outageSpans([incident], now).assistant, undefined);
  assert.equal(dayStatus({ degraded: 4, major_outage: 1 }), 'degraded');
  update.evidence.confirmedStatus = 'partial_outage';
  const withConfirmedLevel = normalizeIncident({ ...incident, updates: [update] });
  assert.equal(incidentOutageOnDay(outageSpans([withConfirmedLevel], now).assistant, '2026-11-01'), 'partial_outage');
});

test('legacy step-down before midnight ends the outage despite a worse latest check', () => {
  const openedAt = '2026-11-01T23:00:00Z';
  const steppedAt = '2026-11-01T23:55:00Z';
  const resolvedAt = '2026-11-02T02:00:00Z';
  const incident = {
    componentId: 'assistant', status: 'degraded', openedAt, resolvedAt,
    updates: [
      { evidence: { status: 'major_outage', observedAt: openedAt } },
      { message: 'Fresh observations now confirm needs attention: Response slower than target. Latest check: major outage, Check timed out.',
        evidence: { status: 'major_outage', observedAt: steppedAt } },
    ],
  };
  const spans = outageSpans([incident], Date.parse(resolvedAt)).assistant;
  assert.equal(incidentOutageOnDay(spans, '2026-11-01'), 'major_outage');
  assert.equal(incidentOutageOnDay(spans, '2026-11-02'), undefined);
});

test('an unconfirmed recovery before midnight does not end a confirmed outage', () => {
  const openedAt = '2026-11-01T23:00:00Z';
  const firstPass = '2026-11-01T23:55:00Z';
  const resolvedAt = '2026-11-02T02:00:00Z';
  const incident = {
    componentId: 'assistant', status: 'major_outage', openedAt, resolvedAt,
    updates: [
      { evidence: { status: 'major_outage', observedAt: openedAt } },
      { stage: 'monitoring', evidence: { status: 'operational', observedAt: firstPass } },
      { stage: 'resolved', evidence: { status: 'operational', observedAt: resolvedAt } },
    ],
  };
  const spans = outageSpans([incident], Date.parse(resolvedAt)).assistant;
  assert.equal(incidentOutageOnDay(spans, '2026-11-02'), 'major_outage');
  assert.equal(spans[0].until, Date.parse(resolvedAt));
});
