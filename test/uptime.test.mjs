import test from 'node:test';
import assert from 'node:assert/strict';
import { appendSample, prune, intervals, summarize, combine, recentChecks } from '../public/uptime.mjs';
import { CAPS, RETENTION_DAYS, recordTimeline, serializeTimeline, emptyTimeline } from '../scripts/timeline.mjs';
import { httpProbe } from '../scripts/http-probe.mjs';

const series = samples => { const s = []; for (const [at, code, reason] of samples) appendSample(s, { at, code, reason }, 900); return s; };

test('samples are stored once, in order, and merge only within the cap', () => {
  const s = [];
  assert.equal(appendSample(s, { at: 0, code: 'o', reason: 'ok' }, 900), true);
  assert.equal(appendSample(s, { at: 0, code: 'o' }, 900), false, 'replay');
  assert.equal(appendSample(s, { at: 300, code: 'o' }, 900), true);
  assert.equal(appendSample(s, { at: 200, code: 'p' }, 900), false, 'out of order');
  assert.equal(appendSample(s, { at: 600, code: 'x' }, 900), false, 'unknown code');
  assert.equal(appendSample(s, { at: 600.5, code: 'o' }, 900), false, 'non-integer time');
  appendSample(s, { at: 600, code: 'p', reason: 'timeout' }, 900);
  appendSample(s, { at: 900, code: 'p', reason: 'http_error' }, 900);
  appendSample(s, { at: 2000, code: 'o' }, 900);
  appendSample(s, { at: 3500, code: 'o' }, 900);
  assert.deepEqual(s, [[0, 300, 'o', 2], [600, 600, 'p', 1, 'timeout'], [900, 900, 'p', 1, 'http_error'], [2000, 2000, 'o', 1], [3500, 3500, 'o', 1]]);
});

test('a check covers time until the next check, never beyond the cap; longer silence is unchecked', () => {
  const list = intervals(series([[0, 'o'], [300, 'o'], [2000, 'p', 'timeout']]), 900, 2300);
  assert.deepEqual(list.map(iv => [iv.start, iv.end, iv.code]), [[0, 1200, 'o'], [2000, 2300, 'p']]);
  const s = summarize(list, 0, 2300);
  assert.equal(s.o, 1200); assert.equal(s.downSec, 300); assert.equal(s.uncoveredSec, 800);
  assert.equal(s.uptime, 1200 / 1500); assert.equal(s.coverage, 1500 / 2300);
  assert.equal(s.failedChecks, 1); assert.equal(s.knownChecks, 3);
  assert.equal(s.episodes, 1); assert.equal(s.longestDownSec, 300); assert.equal(s.sustainedDownSec, 0, 'one failed check is a blip');
});

test('consecutive failed checks are sustained even when their reasons differ; unknown is neither up nor down', () => {
  const list = intervals(series([[0, 'o'], [300, 'p', 'timeout'], [600, 'p', 'http_error'], [900, 'o'], [1200, 'u', 'stale'], [1500, 'o'], [1800, 'p', 'timeout'], [2100, 'o']]), 900, 2400);
  const s = summarize(list, 0, 2400);
  assert.equal(s.downSec, 900); assert.equal(s.sustainedDownSec, 600); assert.equal(s.episodes, 2); assert.equal(s.longestDownSec, 600);
  assert.equal(s.u, 300); assert.equal(s.knownSec, 2100); assert.equal(s.uptime, 1200 / 2100);
  assert.equal(s.failedChecks, 3); assert.equal(s.knownChecks, 7);
});

test('windows split intervals proportionally and the final check never extends past now', () => {
  const list = intervals(series([[0, 'o'], [600, 'p', 'timeout']]), 900, 700);
  assert.equal(list.at(-1).end, 700);
  const s = summarize(list, 300, 700);
  assert.equal(s.o, 300); assert.equal(s.downSec, 100); assert.equal(s.knownChecks, 2); assert.equal(s.uncoveredSec, 0);
  assert.equal(summarize([], 0, 600).uptime, null, 'no evidence is not 100%');
});

test('combined core totals take the worst service at each moment and leave uncovered time uncovered', () => {
  const a = intervals(series([[0, 'o'], [300, 'p'], [600, 'o']]), 900, 900);
  const b = intervals(series([[0, 'o'], [300, 'o'], [600, 'd', 'slow']]), 900, 900);
  const c = [{ start: 2000, end: 2300, code: 'o', n: 1 }];
  const all = combine([a, b, c]);
  assert.deepEqual(all.map(iv => [iv.start, iv.end, iv.code]), [[0, 300, 'o'], [300, 600, 'p'], [600, 900, 'd'], [2000, 2300, 'o']]);
  const s = summarize(all, 0, 2300);
  assert.equal(s.downSec, 300); assert.equal(s.slowSec, 300); assert.equal(s.uncoveredSec, 1100);
});

test('recent checks expand segments with their recorded first and last times', () => {
  const s = series([[0, 'o'], [300, 'o'], [600, 'o'], [900, 'p', 'timeout']]);
  assert.deepEqual(recentChecks(s, 24), [{ at: 0, code: 'o', reason: undefined }, { at: 300, code: 'o', reason: undefined }, { at: 600, code: 'o', reason: undefined }, { at: 900, code: 'p', reason: 'timeout' }]);
  assert.deepEqual(recentChecks(s, 2).map(c => c.at), [600, 900]);
});

test('pruning keeps segments that still cover the retention window', () => {
  const s = series([[0, 'o'], [5000, 'p'], [10000, 'o']]);
  prune(s, 5800, 900);
  assert.deepEqual(s.map(seg => seg[0]), [5000, 10000]);
});

const registry = { probes: [{ id: 'web-http', type: 'http' }, { id: 'web-render', type: 'browser' }], components: [{ id: 'web', probes: ['web-http', 'web-render'] }, { id: 'feed', freshness: true }] };
const NOW = Date.parse('2026-10-23T16:00:00Z');
const iso = ms => new Date(ms).toISOString();
const snapshot = (ms, http = 'operational') => ({
  state: { probes: { 'web-http': { status: http, reasonCode: http === 'operational' ? 'ok' : 'timeout', observedAt: iso(ms) }, 'web-render': { status: 'operational', reasonCode: 'ok', observedAt: iso(ms - 60000) } } },
  view: { components: [{ id: 'feed', samples: [{ status: 'unknown', reasonCode: 'stale', observedAt: iso(ms) }] }] },
});

test('the timeline records each probe once per new check and rejects future or invalid evidence', () => {
  let { timeline, advanced } = recordTimeline(null, registry, snapshot(NOW).state, snapshot(NOW).view, NOW);
  assert.deepEqual(advanced.sort(), ['feed', 'web-http', 'web-render']);
  ({ timeline, advanced } = recordTimeline(timeline, registry, snapshot(NOW).state, snapshot(NOW).view, NOW + 300000));
  assert.deepEqual(advanced, [], 'a replayed snapshot adds nothing');
  const later = snapshot(NOW + 300000, 'partial_outage');
  ({ timeline, advanced } = recordTimeline(timeline, registry, later.state, later.view, NOW + 300000));
  assert.deepEqual(timeline.series['web-http'], [[NOW / 1000, NOW / 1000, 'o', 1], [NOW / 1000 + 300, NOW / 1000 + 300, 'p', 1, 'timeout']]);
  assert.deepEqual(timeline.series.feed, [[NOW / 1000, NOW / 1000 + 300, 'u', 2, 'stale']], 'freshness checks merge into one unknown run');
  const future = snapshot(NOW + 3600000);
  ({ advanced } = recordTimeline(timeline, registry, future.state, future.view, NOW + 600000));
  assert.deepEqual(advanced, [], 'evidence dated in the future is invalid');
  ({ advanced } = recordTimeline(timeline, registry, { probes: { 'web-http': { status: 'bogus', observedAt: iso(NOW + 900000) } } }, { components: [] }, NOW + 900000));
  assert.deepEqual(advanced, []);
});

test('the timeline drops removed probes and data older than the retention window, and serializes losslessly', () => {
  const timeline = emptyTimeline();
  timeline.series.gone = [[0, 0, 'o', 1]];
  timeline.series['web-http'] = [[NOW / 1000 - (RETENTION_DAYS + 1) * 86400, NOW / 1000 - (RETENTION_DAYS + 1) * 86400, 'p', 1]];
  const { timeline: next } = recordTimeline(timeline, registry, snapshot(NOW).state, snapshot(NOW).view, NOW);
  assert.equal(next.series.gone, undefined);
  assert.deepEqual(next.series['web-http'], [[NOW / 1000, NOW / 1000, 'o', 1]]);
  assert.deepEqual(next.caps, CAPS);
  assert.deepEqual(JSON.parse(serializeTimeline(next)), next);
  assert.deepEqual(recordTimeline({ schemaVersion: 2 }, registry, {}, { components: [] }, NOW).timeline.series, {}, 'unknown schema starts fresh');
});

test('HTTP evidence names the Cloudflare location that answered', async () => {
  const probe = { id: 'web-http', type: 'http', url: 'https://example.easychamp.com/', bodyIncludes: 'EasyChamp', maxResponseMs: 60000, expiresSeconds: 900 };
  const answer = ray => ({ now: () => NOW, fetcher: async () => new Response('<title>EasyChamp</title>', { status: 200, headers: ray ? { 'cf-ray': ray } : {} }) });
  assert.equal((await httpProbe(probe, answer('8d2f1a3b4c5d6e7f-MIA'))).edge, 'MIA');
  assert.equal((await httpProbe(probe, answer('not-a-ray'))).edge, undefined);
  assert.equal((await httpProbe(probe, answer(null))).edge, undefined);
  const failed = await httpProbe(probe, { now: () => NOW, fetcher: async () => new Response('bad gateway', { status: 522, headers: { 'cf-ray': '8d2f1a3b4c5d6e7f-ATL' } }) });
  assert.equal(failed.status === 'operational', false); assert.equal(failed.edge, 'ATL', 'failures keep the location too');
});
