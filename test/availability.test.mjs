import test from 'node:test';
import assert from 'node:assert/strict';
import { runFromProbes, advanceRuns, windowEvidence, availabilityStats, RUN_RETENTION_MS } from '../public/availability.mjs';
import { recordObservation } from '../scripts/observations.mjs';

const T0 = Date.parse('2026-10-23T15:00:00Z');
const min = m => T0 + m * 60000;
const at = m => new Date(min(m)).toISOString();
const run = (m, f = [], n = 10) => ({ at: at(m), n, f, s: [] });

test('a run counts only probes observed in this pass and never unknown evidence', () => {
  const probes = {
    a: { status: 'major_outage', observedAt: at(1) },
    b: { status: 'operational', observedAt: at(1) },
    c: { status: 'major_outage', observedAt: at(-5) },
    d: { status: 'unknown', observedAt: at(1) },
    e: { status: 'degraded', observedAt: at(1) },
  };
  assert.deepEqual(runFromProbes(probes, ['a', 'b', 'c', 'd', 'e'], min(0)), { at: at(1), n: 3, f: ['a'], s: ['e'] });
  assert.equal(runFromProbes({ c: probes.c }, ['c'], min(0)), null);
});

test('runs deduplicate by time, drop invalid rows and expire after retention', () => {
  const now = min(0);
  const old = { at: new Date(now - RUN_RETENTION_MS - 1).toISOString(), n: 10, f: [] };
  const runs = advanceRuns([old, run(-5), { at: 'bad', n: 1, f: [] }, { at: at(-4), n: 1, f: ['a', 'b'] }], run(-5), now);
  assert.deepEqual(runs.map(r => r.at), [at(-5)]);
  assert.equal(advanceRuns(runs, run(0), now).length, 2);
});

test('one isolated failed request stays operational', () => {
  const runs = [run(0), run(5, ['console-http']), run(10)];
  assert.equal(windowEvidence(runs, min(10)).status, 'operational');
});

test('alternating failures across sites confirm an intermittent outage although every site passes next time', () => {
  const runs = [run(0, ['console-http', 'home-http']), run(5), run(10, ['coach-http']), run(15)];
  const e = windowEvidence(runs, min(15));
  assert.equal(e.status, 'partial_outage');
  assert.equal(e.reasonCode, 'intermittent_failures');
  assert.deepEqual(e.affected, ['coach-http', 'console-http', 'home-http']);
  assert.equal(e.failedChecks, 3);
});

test('half the sites failing in the latest run is a widespread failure', () => {
  assert.equal(windowEvidence([run(0, ['a', 'b', 'c', 'd', 'e'])], min(0)).status, 'major_outage');
});

test('failures older than 45 minutes clear the window; stale or missing runs are unknown', () => {
  const runs = [run(0, ['a', 'b']), run(5, ['c']), ...Array.from({ length: 10 }, (_, i) => run(10 + i * 5))];
  assert.equal(windowEvidence(runs, min(55)).status, 'operational');
  assert.equal(windowEvidence(runs, min(55 + 16)).status, 'unknown');
  assert.equal(windowEvidence([], min(0)).status, 'unknown');
});

test('replayed window evidence cannot confirm twice; two fresh runs confirm', () => {
  const component = e => ({ id: 'request-reliability', status: e.status, samples: [{ ...e, sourceId: 'request-window' }] });
  const first = windowEvidence([run(0, ['a', 'b']), run(5, ['c'])], min(5));
  let observed = recordObservation(component(first));
  observed = recordObservation(component(first), observed.counter);
  assert.equal(observed.isNew, false);
  assert.equal(observed.counter.confirmedStatus ?? null, null);
  const second = windowEvidence([run(0, ['a', 'b']), run(5, ['c']), run(10)], min(10));
  observed = recordObservation(component(second), observed.counter);
  assert.equal(observed.counter.confirmedStatus, 'partial_outage');
});

test('an isolated failed sample has zero proven minutes and an upper bound limited by its neighbours', () => {
  const runs = [run(0), run(5, ['a']), run(11), run(60)];
  const s = availabilityStats(runs, min(0), min(60));
  assert.equal(s.failingMinutesLower, 0);
  assert.equal(s.failingMinutesUpper, 11);
  assert.equal(s.failedChecks, 1);
  assert.equal(s.unmonitoredMinutes, 49, 'the 49-minute gap is unknown, not outage');
  assert.equal(s.episodes, 1);
});

test('consecutive failures of one service give a proven span; overlapping services are not double counted', () => {
  const runs = [run(0), run(5, ['a', 'b']), run(10, ['a', 'b']), run(15, ['a']), run(20)];
  const s = availabilityStats(runs, min(0), min(20));
  assert.equal(s.failingMinutesLower, 10);
  assert.equal(s.failingMinutesUpper, 20);
  assert.equal(s.failedChecks, 5);
  assert.equal(s.unmonitoredMinutes, 0);
});

test('a monitoring gap breaks a failure streak instead of becoming outage time', () => {
  const runs = [run(0, ['a']), run(40, ['a']), run(45)];
  const s = availabilityStats(runs, min(0), min(45));
  assert.equal(s.failingMinutesLower, 0);
  assert.equal(s.unmonitoredMinutes, 40);
  assert.equal(s.failingMinutesUpper, 5, 'only monitored time can be counted as possible failure');
});

test('statistics clip to the requested range and can scope to selected services', () => {
  const runs = [run(-10), run(-5, ['a']), run(0, ['a']), run(5), run(10, ['b'])];
  const s = availabilityStats(runs, min(0), min(10), ['a']);
  assert.equal(s.failingMinutesLower, 0);
  assert.equal(s.failingMinutesUpper, 5);
  assert.equal(s.failedChecks, 1);
  assert.equal(s.checks, 3);
});
