import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { edgeWindow, classifyEdge, edgeProbes, originError, ROW_LIMIT } from '../scripts/edge-probe.mjs';
import { viewState } from '../public/model.mjs';
import { recordObservation, confirmedSeverity } from '../scripts/observations.mjs';
import { advanceIncidents } from '../scripts/incidents.mjs';
import { publishHeartbeat } from '../scripts/heartbeat.mjs';
import { seriesKinds, CAPS } from '../scripts/timeline.mjs';
const registry = JSON.parse(readFileSync(new URL('../config/components.json', import.meta.url), 'utf8'));
const mia = registry.probes.find(p => p.id === 'edge-mia');
const atl = registry.probes.find(p => p.id === 'edge-atl');
const T = Date.parse('2026-10-26T01:00:30Z');
const iso = ms => new Date(ms).toISOString();
const minute = n => iso(Date.parse('2026-10-26T00:52:00Z') + n * 60000).replace('.000Z', 'Z');
// row(colo, edge status, count, minute index, origin status)
const row = (colo, edgeResponseStatus, count, m = 0, originResponseStatus = edgeResponseStatus >= 520 ? 0 : edgeResponseStatus) => ({ count, dimensions: { datetimeMinute: minute(m), coloCode: colo, edgeResponseStatus, originResponseStatus } });
const spread = (colo, status, count, minutes = [0, 1, 2, 3, 4]) => minutes.map(m => row(colo, status, count / minutes.length, m));
const window = { start: Date.parse('2026-10-26T00:52:00Z'), end: Date.parse('2026-10-26T00:57:00Z') };
const answer = data => async () => new Response(JSON.stringify({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: data }] } }, errors: null }), { status: 200 });
const env = { CLOUDFLARE_ANALYTICS_TOKEN: 'test-token' };

test('only answers Cloudflare could not get from the origin count as failures', () => {
  assert(originError(522, 0)); assert(originError(520, 0)); assert(originError(524, 0)); assert(originError(504, 0));
  assert(!originError(502, 502)); assert(!originError(503, 503)); assert(!originError(404, 404)); assert(!originError(200, 200));
});

test('windows chain on measured minutes, wait for a full window and cap long silences', () => {
  assert.deepEqual(edgeWindow(mia, undefined, T), window);
  assert.deepEqual(edgeWindow(mia, { measuredUntil: '2026-10-26T00:51:00Z' }, T), { start: Date.parse('2026-10-26T00:51:00Z'), end: window.end });
  // Bunched runs never judge a window shorter than five minutes.
  assert.equal(edgeWindow(mia, { measuredUntil: '2026-10-26T00:53:00Z' }, T), null);
  assert.equal(edgeWindow(mia, { measuredUntil: '2026-10-26T00:57:00Z' }, T), null);
  assert.deepEqual(edgeWindow(mia, { measuredUntil: '2026-10-25T23:00:00Z' }, T), { start: window.end - mia.maxWindowSeconds * 1000, end: window.end });
});

test('traffic thresholds: thin traffic keeps collecting, isolated or one-minute errors pass, sustained shares fail', () => {
  const thin = classifyEdge(mia, [...spread('MIA', 200, 20), row('MIA', 522, 9, 1)], window);
  assert.equal(thin.status, 'unknown'); assert.equal(thin.reasonCode, 'low_traffic'); assert.equal(thin.requests, 29); assert.equal(thin.observedAt, thin.windowEnd);
  assert.equal(thin.measuredUntil, iso(window.start));
  const capped = { start: window.end - mia.maxWindowSeconds * 1000, end: window.end };
  assert.equal(classifyEdge(mia, [row('MIA', 200, 5)], capped).measuredUntil, iso(window.end));
  assert.equal(classifyEdge(mia, [...spread('MIA', 200, 400), row('MIA', 522, 2, 0), row('MIA', 522, 1, 1)], window).status, 'operational');
  // Two errors in two minutes is a high share of thin traffic but not enough evidence.
  assert.equal(classifyEdge(mia, [...spread('MIA', 200, 30), row('MIA', 522, 1, 1), row('MIA', 522, 1, 2)], window).status, 'operational');
  assert.equal(classifyEdge(mia, [...spread('MIA', 200, 30), row('MIA', 522, 2, 1), row('MIA', 522, 1, 2)], window).status, 'partial_outage');
  // A burst inside one minute is not enough, whatever its share.
  assert.equal(classifyEdge(mia, [...spread('MIA', 200, 50), row('MIA', 522, 50, 4)], window).status, 'operational');
  const partial = classifyEdge(mia, [...spread('MIA', 200, 90), row('MIA', 522, 5, 1), row('MIA', 522, 5, 2), ...spread('MIA', 503, 50)], window);
  assert.equal(partial.status, 'partial_outage'); assert.equal(partial.reasonCode, 'origin_unreachable'); assert.equal(partial.requests, 150); assert.equal(partial.originErrors, 10); assert.equal(partial.errorMinutes, 2); assert.equal(partial.measuredUntil, iso(window.end));
  assert.equal(classifyEdge(mia, [...spread('MIA', 200, 290), ...spread('MIA', 522, 10)], window).status, 'degraded');
  assert.equal(classifyEdge(mia, [...spread('MIA', 200, 10), ...spread('MIA', 522, 30)], window).status, 'major_outage');
  assert.equal(classifyEdge(mia, [...spread('MIA', 200, 400), ...spread('ATL', 522, 400)], window).status, 'operational');
  // Application errors that the origin itself returned are measured by the HTTP checks.
  assert.equal(classifyEdge(mia, [...spread('MIA', 200, 40), ...spread('MIA', 502, 60)], window).status, 'operational');
});

test('missing token, API errors, truncated answers and network failures are unknown and keep the window chain', async () => {
  let calls = 0;
  const none = await edgeProbes([mia, atl], {}, {}, T, async () => { calls++; });
  assert.equal(calls, 0); assert.equal(none['edge-mia'].status, 'unknown'); assert.equal(none['edge-mia'].reasonCode, 'edge_not_configured'); assert.equal(none['edge-mia'].observedAt, iso(window.end));
  const previous = { 'edge-mia': { status: 'operational', reasonCode: 'ok', measuredUntil: '2026-10-26T00:50:00Z' } };
  for (const send of [async () => new Response('{}', { status: 500 }), async () => { throw new Error('offline'); },
    async () => new Response(JSON.stringify({ data: null, errors: [{ message: 'authz' }] }), { status: 200 }),
    async () => new Response(JSON.stringify({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: spread('MIA', 200, 400) }] } }, errors: [{ message: 'partial' }] }), { status: 200 }),
    answer(Array.from({ length: ROW_LIMIT }, () => row('MIA', 200, 1)))]) {
    const result = await edgeProbes([mia], previous, env, T, send);
    assert.equal(result['edge-mia'].status, 'unknown'); assert.equal(result['edge-mia'].reasonCode, 'analytics_unavailable');
    assert.equal(result['edge-mia'].measuredUntil, '2026-10-26T00:50:00Z');
  }
});

test('one query covers both locations and the monitored hosts, and keeps evidence until a window completes', async () => {
  const sent = [];
  const send = async (url, options) => { sent.push({ url, options }); return answer([...spread('MIA', 200, 100), ...spread('MIA', 522, 100), ...spread('ATL', 200, 300)])(); };
  const result = await edgeProbes([mia, atl], {}, env, T, send);
  assert.equal(sent.length, 1); assert.equal(sent[0].url, 'https://api.cloudflare.com/client/v4/graphql'); assert.equal(sent[0].options.headers.Authorization, 'Bearer test-token');
  const body = JSON.parse(sent[0].options.body);
  assert.deepEqual(body.variables, { zone: mia.zoneTag, since: iso(window.start), until: iso(window.end), colos: ['MIA', 'ATL'], hosts: mia.hosts });
  assert(mia.hosts.includes('console.easychamp.com') && mia.hosts.includes('easychamp.com'));
  assert.match(body.query, /clientRequestHTTPHost_in:\$hosts/);
  assert.equal(result['edge-mia'].status, 'major_outage'); assert.equal(result['edge-atl'].status, 'operational');
  assert(!JSON.stringify(result).includes('test-token'));
  const again = await edgeProbes([mia], result, env, T + 20000, async () => { throw new Error('must not query'); });
  assert.equal(again['edge-mia'], result['edge-mia']);
  // A quiet window that is still collecting keeps the last verdict instead of a new unknown.
  const quiet = await edgeProbes([mia], result, env, T + 5 * 60000, answer([row('MIA', 200, 10)]));
  assert.equal(quiet['edge-mia'], result['edge-mia']);
  const fresh = await edgeProbes([mia], {}, env, T, answer([row('MIA', 200, 10)]));
  assert.equal(fresh['edge-mia'].reasonCode, 'low_traffic');
});

test('each location is its own service, validated before it counts, in its own overview group', () => {
  const now = window.end + 60000;
  const probes = { 'edge-mia': classifyEdge(mia, [...spread('MIA', 200, 90), ...spread('MIA', 522, 10)], window), 'edge-atl': classifyEdge(atl, [row('ATL', 200, 5)], window) };
  const view = viewState(registry, { generatedAt: iso(now), probes, freshness: {} }, now);
  const miami = view.components.find(c => c.id === 'access-miami'), atlanta = view.components.find(c => c.id === 'access-atlanta');
  assert.equal(miami.status, 'partial_outage'); assert.equal(miami.reasonCode, 'origin_unreachable'); assert.equal(atlanta.status, 'unknown');
  assert.equal(miami.measurements[0].label, 'Visitor access via Miami'); assert.equal(miami.measurements[0].dimension, 'regional'); assert.equal(miami.measurements[0].value, 10); assert.match(miami.measurements[0].summary, /10 of 100 visitor requests/);
  assert.match(atlanta.measurements[0].summary, /5 visitor requests so far; at least 30/);
  const regional = view.measurements.find(m => m.id === 'regional');
  assert.equal(regional.status, 'partial_outage'); assert.equal(regional.rows.length, 2);
  assert(!view.measurements.find(m => m.id === 'availability').rows.some(r => r.id.startsWith('edge-')));
  assert.equal(view.summary.title, 'Some visitors cannot reach EasyChamp');
  // Counts that do not add up are unknown everywhere, including the alert count.
  const forged = viewState(registry, { generatedAt: iso(now), probes: { ...probes, 'edge-atl': { status: 'major_outage', reasonCode: 'origin_unreachable', observedAt: iso(window.end) } }, freshness: {} }, now);
  assert.equal(forged.components.find(c => c.id === 'access-atlanta').status, 'unknown');
  assert.equal(forged.components.find(c => c.id === 'access-atlanta').reasonCode, 'invalid_evidence');
  assert.equal(seriesKinds(registry)['edge-mia'], 'edge'); assert.equal(CAPS.edge, 1200);
});

test('unknown regional evidence leaves the public endpoint headline alone', () => {
  const now = window.end + 60000;
  const probes = Object.fromEntries(registry.probes.filter(p => p.type === 'http').map(p => [p.id, { status: 'operational', reasonCode: 'ok', observedAt: iso(now), httpStatus: 200, responseMs: 100 }]));
  const view = viewState(registry, { generatedAt: iso(now), probes, freshness: {} }, now);
  assert.equal(view.measurements.find(m => m.id === 'availability').status, 'operational');
  assert.equal(view.measurements.find(m => m.id === 'regional').status, 'unknown');
  assert.equal(view.summary.title, 'Public endpoint checks are passing');
});

async function replay(windows) {
  const payload = { schemaVersion: 1, incidents: [] };
  const counters = {}; let previous = {}; let view;
  for (const [i, data] of windows.entries()) {
    const now = T + i * 5 * 60000;
    const send = typeof data === 'function' ? async (_url, options) => answer(data(JSON.parse(options.body).variables))() : answer(data);
    previous = { ...previous, ...await edgeProbes([mia, atl], previous, env, now, send) };
    view = viewState(registry, { generatedAt: iso(now), probes: previous, freshness: {} }, now);
    for (const id of ['access-miami', 'access-atlanta']) {
      const component = view.components.find(c => c.id === id);
      const observation = recordObservation(component, counters[id]); counters[id] = observation.counter;
      advanceIncidents(payload, component, observation, iso(now));
    }
  }
  return { payload, counters, view };
}

test('two failing Miami windows open one incident and count in the New Relic heartbeat', async () => {
  const failing = [...spread('MIA', 200, 80), ...spread('MIA', 522, 20), ...spread('ATL', 200, 200)];
  const { payload, counters, view } = await replay([failing, failing]);
  assert.equal(confirmedSeverity(counters['access-miami']), 'partial_outage');
  assert.equal(payload.incidents.length, 1); assert.equal(payload.incidents[0].title, 'Access from Miami: availability issue');
  let event;
  await publishHeartbeat({ components: view.components.filter(c => c.id.startsWith('access-')), counters }, iso(T), { NEW_RELIC_STATUS_LICENSE_KEY: 'k', NEW_RELIC_STATUS_ACCOUNT_ID: '1' },
    async (_url, options) => { event = JSON.parse(options.body)[0]; return new Response('', { status: 200 }); });
  assert.equal(event.confirmedOutageComponents, 1);
});

test('Miami recovers on its own traffic while Atlanta is too quiet to judge', async () => {
  const failing = [...spread('MIA', 200, 80), ...spread('MIA', 522, 20), row('ATL', 200, 10)];
  const healthy = [...spread('MIA', 200, 150), row('ATL', 200, 10)];
  const { payload, counters } = await replay([failing, failing, healthy, healthy]);
  assert.equal(confirmedSeverity(counters['access-miami']), null);
  assert.equal(payload.incidents.length, 1); assert.notEqual(payload.incidents[0].resolvedAt, null);
});

test('quiet hours still prove recovery once enough traffic has been collected', async () => {
  const failing = [...spread('MIA', 200, 80), ...spread('MIA', 522, 20)];
  // Two requests a minute: each verdict needs fifteen minutes of traffic.
  const quiet = ({ since, until }) => Array.from({ length: (Date.parse(until) - Date.parse(since)) / 60000 }, (_, i) => ({ count: 2, dimensions: { datetimeMinute: iso(Date.parse(since) + i * 60000), coloCode: 'MIA', edgeResponseStatus: 200, originResponseStatus: 200 } }));
  const run = await replay([failing, failing, quiet, quiet, quiet, quiet, quiet, quiet]);
  assert.equal(confirmedSeverity(run.counters['access-miami']), null);
  assert.notEqual(run.payload.incidents[0].resolvedAt, null);
});

test('a short burst across a window boundary never confirms an outage', async () => {
  const before = [...spread('MIA', 200, 200), row('MIA', 522, 10, 4)];
  const after = [...spread('MIA', 200, 200), row('MIA', 522, 10, 0)];
  const { payload, counters } = await replay([before, after]);
  assert.equal(confirmedSeverity(counters['access-miami']), null); assert.equal(payload.incidents.length, 0);
});
