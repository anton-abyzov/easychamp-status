import test from 'node:test';
import assert from 'node:assert/strict';
import { VANTAGE, parseWorkerDocument, fetchWorkerDocument, reconcileVantages, nextVantageDocument } from '../scripts/vantage.mjs';
import { REASONS } from '../public/model.mjs';

const now = Date.parse('2026-11-18T18:08:00Z');
const iso = (offset = 0) => new Date(now + offset * 1000).toISOString();
const ids = ['a', 'b', 'c', 'd', 'e'];
const registry = {
  probes: [...ids.map(id => ({ id: `${id}-http`, type: 'http', url: `https://${id}.example/` })), { id: 'a-render', type: 'browser', url: 'https://a.example/' }, { id: 'feed', type: 'feed', url: 'https://f.example/' }],
  components: [...ids.map(id => ({ id, probes: [`${id}-http`, ...(id === 'a' ? ['a-render'] : [])] })), { id: 'feed-c', probes: ['feed'] }],
};
const fail = (offset = 0, reasonCode = 'timeout') => ({ status: 'major_outage', reasonCode, observedAt: iso(offset) });
const ok = (offset = 0) => ({ status: 'operational', reasonCode: 'ok', observedAt: iso(offset) });
const doc = results => ({ generatedAt: iso(-30), results });
const run = (probes, worker, extra = {}) => reconcileVantages({ registry, probes, probedIds: new Set(Object.keys(probes)), worker: worker && parseWorkerDocument({ schemaVersion: 1, ...doc(worker) }, now), ...extra });

test('runner-only failure becomes probe_path_suspect (unknown, never counts) and is recorded', () => {
  const verdict = run({ 'a-http': fail() }, { 'a-http': ok(-20) });
  assert.equal(verdict.probes['a-http'].status, 'unknown');
  assert.equal(verdict.probes['a-http'].reasonCode, 'probe_path_suspect');
  assert.deepEqual(verdict.probes['a-http'].suspectOf, { status: 'major_outage', reasonCode: 'timeout' });
  assert.equal(verdict.events[0].outcome, 'suspect');
  assert.ok(REASONS.probe_path_suspect);
});

test('both vantages failing leaves the runner failure counting', () => {
  const verdict = run({ 'a-http': fail() }, { 'a-http': fail(-20) });
  assert.deepEqual(verdict.probes, {});
  assert.deepEqual(verdict.events, []);
});

test('missing, stale, malformed, skewed or unmeasured worker results leave the runner failure counting', () => {
  const probes = { 'a-http': fail() };
  assert.deepEqual(run(probes, null).probes, {});
  assert.equal(parseWorkerDocument({ schemaVersion: 1, generatedAt: iso(-VANTAGE.docMaxAgeSeconds - 1), results: { 'a-http': ok() } }, now), null);
  assert.equal(parseWorkerDocument({ schemaVersion: 2, generatedAt: iso(), results: {} }, now), null);
  assert.equal(parseWorkerDocument({ schemaVersion: 1, generatedAt: 'nope', results: {} }, now), null);
  assert.equal(parseWorkerDocument([], now), null);
  assert.deepEqual(run(probes, { 'a-http': { ...ok(), observedAt: iso(-VANTAGE.resultSkewSeconds - 5) } }).probes, {});
  assert.deepEqual(run(probes, { 'a-http': { status: 'unknown', reasonCode: 'automation_blocked', observedAt: iso(-10) } }).probes, {});
  assert.deepEqual(run(probes, { 'b-http': ok(-10) }).probes, {});
  assert.deepEqual(run(probes, { 'a-http': { status: 'bogus', reasonCode: 'x', observedAt: iso(-10) } }).probes, {});
});

test('fetchWorkerDocument fails closed on every transport problem', async () => {
  const good = { schemaVersion: 1, generatedAt: iso(-10), results: { 'a-http': ok() } };
  const get = fetcher => fetchWorkerDocument('https://v.example/v1/latest', { fetcher, now: () => now });
  assert.equal((await get(async () => Response.json(good))).results['a-http'].status, 'operational');
  assert.equal(await get(async () => new Response('x', { status: 503 })), null);
  assert.equal(await get(async () => new Response('not json')), null);
  assert.equal(await get(async () => { throw new Error('timeout'); }), null);
  assert.equal(await fetchWorkerDocument('http://v.example/', { fetcher: async () => Response.json(good), now: () => now }), null);
  assert.equal(await fetchWorkerDocument('', { now: () => now }), null);
  assert.equal(await fetchWorkerDocument(undefined, { now: () => now }), null);
});

test('4+ unrelated failures the worker confirms count immediately (real shared outage)', () => {
  const probes = Object.fromEntries(['a', 'b', 'c', 'd'].map((id, i) => [`${id}-http`, fail(i * 10)]));
  const verdict = run(probes, Object.fromEntries(Object.keys(probes).map(id => [id, fail(-20)])));
  assert.deepEqual(verdict.probes, {});
  assert.equal(verdict.summary.cluster, 4);
});

test('4+ cluster the worker contradicts becomes suspect for each probe', () => {
  const probes = Object.fromEntries(['a', 'b', 'c', 'd'].map((id, i) => [`${id}-http`, fail(i * 10)]));
  const verdict = run(probes, Object.fromEntries(Object.keys(probes).map(id => [id, ok(-20)])));
  assert.equal(Object.keys(verdict.probes).length, 4);
  assert.ok(Object.values(verdict.probes).every(p => p.reasonCode === 'probe_path_suspect' && p.cluster === true));
});

test('a cluster with a missing worker counts (a missing vantage never suppresses a failure)', () => {
  const probes = Object.fromEntries(['a', 'b', 'c', 'd'].map((id, i) => [`${id}-http`, fail(i * 10)]));
  assert.deepEqual(run(probes, null).probes, {});
});

test('a partly confirmed cluster holds back only the probes the worker passes', () => {
  const probes = Object.fromEntries(['a', 'b', 'c', 'd'].map((id, i) => [`${id}-http`, fail(i * 10)]));
  const verdict = run(probes, { 'a-http': fail(-20), 'b-http': fail(-20), 'c-http': ok(-20), 'd-http': ok(-20) });
  assert.deepEqual(Object.keys(verdict.probes).sort(), ['c-http', 'd-http']);
});

test('failures spread beyond the cluster window are not a cluster', () => {
  const probes = Object.fromEntries(['a', 'b', 'c', 'd'].map((id, i) => [`${id}-http`, fail(i * 100)]));
  assert.equal(run(probes, {}).summary.cluster, 0);
});

test('render failures are held only inside a cluster, and only when the worker reached the URL', () => {
  const alone = run({ 'a-render': { ...fail(), reasonCode: 'slow' } }, { 'a-http': ok(-10) });
  assert.deepEqual(alone.probes, {});
  const probes = { 'a-render': fail(), 'b-http': fail(5), 'c-http': fail(10), 'd-http': fail(15) };
  const held = run(probes, { 'a-http': ok(-10), 'b-http': ok(-10), 'c-http': ok(-10), 'd-http': ok(-10) });
  assert.equal(held.probes['a-render'].reasonCode, 'probe_path_suspect');
  assert.deepEqual(run(probes, { 'a-http': fail(-10), 'b-http': ok(-10), 'c-http': ok(-10), 'd-http': ok(-10) }).probes['a-render'], undefined);
});

test('feed, edge and cached probes are never touched', () => {
  const probes = { feed: fail(), 'e-http': fail() };
  const verdict = reconcileVantages({ registry, probes, probedIds: new Set(['e-http']), worker: parseWorkerDocument({ schemaVersion: 1, ...doc({ 'e-http': ok(-10), feed: ok(-10) }) }, now), previous: {} });
  assert.deepEqual(Object.keys(verdict.probes), ['e-http']);
});

test('persistent valve: the runner failure counts again after persistentRuns consecutive holds', () => {
  let previous = {};
  const outcomes = [];
  for (let i = 0; i < VANTAGE.persistentRuns; i++) {
    const verdict = run({ 'a-http': fail() }, { 'a-http': ok(-20) }, { previous });
    outcomes.push(verdict.events[0].outcome);
    previous = nextVantageDocument(previous, verdict, now);
  }
  assert.deepEqual(outcomes, ['suspect', 'suspect', 'counted_persistent']);
  const last = run({ 'a-http': fail() }, { 'a-http': ok(-20) }, { previous: { suspects: { 'a-http': { runs: VANTAGE.persistentRuns - 1, since: iso(-900) } } } });
  assert.deepEqual(last.probes, {});
  // A healthy run resets the streak.
  assert.equal(nextVantageDocument({ suspects: {} }, run({ 'a-http': ok() }, { 'a-http': ok() }, { previous: { suspects: { 'a-http': { runs: 2 } } } }), now).suspects['a-http'], undefined);
});

test('suspect checks never reach 2-of-4: unknown neither confirms nor clears', async () => {
  const { availabilityState } = await import('../scripts/observations.mjs');
  const T0 = Date.parse('2026-11-18T18:00:00Z') / 1000;
  const checks = codes => [...codes].map((code, i) => ({ at: T0 + i * 300, code, reason: code === 'o' ? undefined : code === 'u' ? 'probe_path_suspect' : 'timeout' }));
  const at = list => (list.at(-1).at + 60) * 1000;
  const state = (codes, previous = null) => { const l = checks(codes); return availabilityState(l, previous, at(l)); };
  assert.equal(state('ouuuu').confirmed, null);
  assert.equal(state('oupuu').confirmed, null);
  assert.equal(state('oopp').confirmed, 'partial_outage');
  const latched = state('opp');
  assert.equal(state('oppuuuuuu', latched).confirmed, 'partial_outage', 'suspects do not clear a latched issue');
  assert.equal(verdictStatus(), 'unknown');
  function verdictStatus() { return run({ 'a-http': fail() }, { 'a-http': ok(-20) }).probes['a-http'].status; }
});

test('event log keeps 14 days and at most maxEvents', () => {
  const old = { at: iso(-15 * 86400), probe: 'a-http' }, fresh = { at: iso(-60), probe: 'a-http' };
  const next = nextVantageDocument({ events: [old, fresh] }, { events: [{ at: iso(), probe: 'b-http' }], suspects: {} }, now);
  assert.deepEqual(next.events.map(e => e.probe), ['a-http', 'b-http']);
  const many = Array.from({ length: VANTAGE.maxEvents + 50 }, () => ({ at: iso(), probe: 'a-http' }));
  assert.equal(nextVantageDocument({ events: many }, { events: [], suspects: {} }, now).events.length, VANTAGE.maxEvents);
});
