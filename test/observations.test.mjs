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
