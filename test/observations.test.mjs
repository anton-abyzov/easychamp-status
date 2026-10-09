import test from 'node:test';
import assert from 'node:assert/strict';
import { recordObservation } from '../scripts/observations.mjs';
const stamp = m => new Date(Date.parse('2026-10-07T18:00:00Z') + m * 60000).toISOString();
const sample = (sourceId, at, status) => ({ sourceId, observedAt: stamp(at), status });
test('cached rendering cannot confirm a second failure on a new HTTP-only pass', () => {
  const first = { status: 'degraded', samples: [sample('http', 0, 'operational'), sample('render', 0, 'degraded')] };
  const a = recordObservation(first); assert.equal(a.counter.bad, 1);
  const second = { status: 'degraded', samples: [sample('http', 5, 'operational'), sample('render', 0, 'degraded')] };
  const b = recordObservation(second, a.counter); assert.equal(b.isNew, false); assert.equal(b.counter.bad, 1);
  const fresh = { status: 'degraded', samples: [sample('http', 15, 'operational'), sample('render', 15, 'degraded')] };
  assert.equal(recordObservation(fresh, b.counter).counter.bad, 2);
});
test('replayed freshness sample cannot double-count failure or recovery', () => {
  for (const status of ['degraded', 'operational']) {
    const current = { status, samples: [sample('feed', 0, status)] };
    const first = recordObservation(current); const replay = recordObservation(current, first.counter);
    assert.equal(replay.isNew, false); assert.deepEqual(replay.counter, first.counter);
  }
});
test('expiry changes the visible state but cannot count new failure or recovery', () => {
  const before = recordObservation({ status: 'degraded', samples: [sample('feed', 0, 'degraded')] });
  const expired = recordObservation({ status: 'unknown', samples: [sample('feed', 0, 'unknown')] }, before.counter);
  assert.equal(expired.isNew, false); assert.equal(expired.counter.bad, 0); assert.equal(expired.counter.good, 0);
});
test('fresh HTTP with cached successful render cannot close an incident', () => {
  const first = recordObservation({ status: 'operational', samples: [sample('http', 0, 'operational'), sample('render', 0, 'operational')] });
  const cached = recordObservation({ status: 'operational', samples: [sample('http', 5, 'operational'), sample('render', 0, 'operational')] }, first.counter);
  assert.equal(cached.isNew, false); assert.equal(cached.counter.good, 1);
});
const job = (at, status, extra = {}) => ({ status, reasonCode: status === 'degraded' ? 'run_failed' : 'verification_unavailable', samples: [{ sourceId: 'feed', observedAt: stamp(at), status, reasonCode: status === 'degraded' ? 'run_failed' : 'verification_unavailable', lastAttemptOutcome: 'unknown', lastAttemptAt: null, lastCompletedSuccessAt: null, ...extra }] });
const failed = (at, attempt, extra = {}) => job(at, 'degraded', { lastAttemptOutcome: 'failed', lastAttemptAt: stamp(attempt), ...extra });
function confirmFailure() {
  const a = recordObservation(failed(0, -5)); const b = recordObservation(failed(5, -5), a.counter);
  assert.equal(b.counter.confirmedStatus, 'degraded'); assert.equal(b.counter.failedAttemptAt, stamp(-5));
  return b.counter;
}
test('a newer completed success clears a run_failed confirmation when destination verification is unavailable', () => {
  const counter = confirmFailure();
  const stuck = recordObservation(job(10, 'unknown'), counter); assert.equal(stuck.counter.confirmedStatus, 'degraded');
  const recovered = recordObservation(job(70, 'unknown', { lastCompletedSuccessAt: stamp(60) }), stuck.counter);
  assert.equal(recovered.counter.confirmedStatus, null); assert.equal(recovered.counter.failedAttemptAt, null); assert.equal(recovered.counter.good, 0);
});
test('a newer succeeded attempt clears a run_failed confirmation', () => {
  const recovered = recordObservation(job(70, 'unknown', { lastAttemptOutcome: 'succeeded', lastAttemptAt: stamp(60) }), confirmFailure());
  assert.equal(recovered.counter.confirmedStatus, null);
});
test('a success older than the failed attempt, or future-dated, keeps the confirmation', () => {
  for (const success of [-30, 200]) assert.equal(recordObservation(job(70, 'unknown', { lastCompletedSuccessAt: stamp(success) }), confirmFailure()).counter.confirmedStatus, 'degraded');
});
test('an ongoing failure keeps the confirmation and tracks the latest failed attempt', () => {
  const later = recordObservation(failed(70, 60, { lastCompletedSuccessAt: stamp(30) }), confirmFailure());
  assert.equal(later.counter.confirmedStatus, 'degraded'); assert.equal(later.counter.failedAttemptAt, stamp(60));
  assert.equal(recordObservation(job(80, 'unknown', { lastCompletedSuccessAt: stamp(30) }), later.counter).counter.confirmedStatus, 'degraded');
});
test('non run_failed confirmations are not cleared by a completed success', () => {
  const stale = at => ({ status: 'degraded', reasonCode: 'destination_stale', samples: [{ sourceId: 'feed', observedAt: stamp(at), status: 'degraded', reasonCode: 'destination_stale', lastCompletedSuccessAt: stamp(at - 1) }] });
  const a = recordObservation(stale(0)); const b = recordObservation(stale(5), a.counter); assert.equal(b.counter.failedAttemptAt, null);
  assert.equal(recordObservation(job(70, 'unknown', { lastCompletedSuccessAt: stamp(60) }), b.counter).counter.confirmedStatus, 'degraded');
});
test('legacy latched counter is seeded from the open run_failed incident and then clears', async () => {
  const { seedConfirmedIncidents } = await import('../scripts/incidents.mjs');
  const counters = { 'feed-results': { evidence: { feed: { observedAt: stamp(0), status: 'unknown' } }, bad: 0, good: 0, confirmedStatus: 'degraded' } };
  seedConfirmedIncidents(counters, { schemaVersion: 1, incidents: [{ id: 'feed-results-1', componentId: 'feed-results', title: 'Match results & schedules: degraded service', status: 'degraded', reasonCode: 'run_failed', openedAt: stamp(-60), updatedAt: stamp(-60), resolvedAt: null, stage: 'investigating', updates: [] }] });
  assert.equal(counters['feed-results'].failedAttemptAt, stamp(-60));
  const before = recordObservation(job(10, 'unknown', { lastCompletedSuccessAt: stamp(-90) }), counters['feed-results']); assert.equal(before.counter.confirmedStatus, 'degraded');
  assert.equal(recordObservation(job(20, 'unknown', { lastCompletedSuccessAt: stamp(15) }), before.counter).counter.confirmedStatus, null);
});
