import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { edgeWindow, classifyEdge, edgeProbes, originError } from '../scripts/edge-probe.mjs';
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
const row = (colo, edgeResponseStatus, count, originResponseStatus = edgeResponseStatus >= 520 ? 0 : edgeResponseStatus) => ({ count, dimensions: { coloCode: colo, edgeResponseStatus, originResponseStatus } });
const window = { start: Date.parse('2026-10-26T00:52:00Z'), end: Date.parse('2026-10-26T00:57:00Z') };
const ok = data => async () => new Response(JSON.stringify({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: data }] } }, errors: null }), { status: 200 });

test('only answers Cloudflare could not get from the origin count as failures', () => {
  assert(originError(522, 0)); assert(originError(520, 0)); assert(originError(524, 0)); assert(originError(504, 0));
  assert(!originError(502, 502)); assert(!originError(503, 503)); assert(!originError(404, 404)); assert(!originError(200, 200));
});

test('windows follow on from the previous window and never reuse traffic', () => {
  assert.deepEqual(edgeWindow(mia, undefined, T), { start: Date.parse('2026-10-26T00:52:00Z'), end: Date.parse('2026-10-26T00:57:00Z') });
  const previous = { windowEnd: '2026-10-26T00:53:00Z' };
  assert.deepEqual(edgeWindow(mia, previous, T), { start: Date.parse('2026-10-26T00:53:00Z'), end: Date.parse('2026-10-26T00:57:00Z') });
  assert.equal(edgeWindow(mia, { windowEnd: '2026-10-26T00:57:00Z' }, T), null);
  // After a long collector silence the window restarts instead of spanning hours.
  assert.deepEqual(edgeWindow(mia, { windowEnd: '2026-10-25T23:00:00Z' }, T), { start: Date.parse('2026-10-26T00:52:00Z'), end: Date.parse('2026-10-26T00:57:00Z') });
});

test('traffic thresholds: too few requests is unknown, isolated errors pass, sustained shares fail', () => {
  const at = classifyEdge(mia, [row('MIA', 200, 20), row('MIA', 522, 9)], window);
  assert.equal(at.status, 'unknown'); assert.equal(at.reasonCode, 'low_traffic'); assert.equal(at.requests, 29); assert.equal(at.observedAt, at.windowEnd);
  assert.equal(classifyEdge(mia, [row('MIA', 200, 400), row('MIA', 522, 2)], window).status, 'operational');
  assert.equal(classifyEdge(mia, [row('MIA', 200, 400), row('MIA', 522, 3), row('ATL', 522, 400)], window).status, 'operational');
  assert.equal(classifyEdge(mia, [row('MIA', 200, 290), row('MIA', 522, 10)], window).status, 'degraded');
  const partial = classifyEdge(mia, [row('MIA', 200, 90), row('MIA', 522, 10), row('MIA', 503, 50)], window);
  assert.equal(partial.status, 'partial_outage'); assert.equal(partial.reasonCode, 'origin_unreachable'); assert.equal(partial.requests, 150); assert.equal(partial.originErrors, 10);
  assert.equal(classifyEdge(mia, [row('MIA', 200, 10), row('MIA', 522, 30)], window).status, 'major_outage');
  // Application errors that the origin itself returned are measured by the HTTP checks.
  assert.equal(classifyEdge(mia, [row('MIA', 200, 40), row('MIA', 502, 60)], window).status, 'operational');
});

test('missing token, API errors and network failures are unknown and send no credential elsewhere', async () => {
  let calls = 0;
  const none = await edgeProbes([mia, atl], {}, {}, T, async () => { calls++; });
  assert.equal(calls, 0); assert.equal(none['edge-mia'].status, 'unknown'); assert.equal(none['edge-mia'].reasonCode, 'edge_not_configured'); assert.equal(none['edge-mia'].observedAt, iso(window.end));
  const env = { CLOUDFLARE_ANALYTICS_TOKEN: 'test-token' };
  for (const send of [async () => new Response('{}', { status: 500 }), async () => { throw new Error('offline'); },
    async () => new Response(JSON.stringify({ data: null, errors: [{ message: 'authz' }] }), { status: 200 })]) {
    const result = await edgeProbes([mia], {}, env, T, send);
    assert.equal(result['edge-mia'].status, 'unknown'); assert.equal(result['edge-mia'].reasonCode, 'analytics_unavailable');
  }
});

test('one query covers both locations and keeps the previous evidence when no new minute is complete', async () => {
  const sent = [];
  const send = async (url, options) => { sent.push({ url, options }); return ok([row('MIA', 200, 100), row('MIA', 522, 100), row('ATL', 200, 300)])(); };
  const result = await edgeProbes([mia, atl], {}, { CLOUDFLARE_ANALYTICS_TOKEN: 'test-token' }, T, send);
  assert.equal(sent.length, 1); assert.equal(sent[0].url, 'https://api.cloudflare.com/client/v4/graphql'); assert.equal(sent[0].options.headers.Authorization, 'Bearer test-token');
  const body = JSON.parse(sent[0].options.body);
  assert.deepEqual(body.variables, { zone: mia.zoneTag, since: iso(window.start), until: iso(window.end), colos: ['MIA', 'ATL'] });
  assert.equal(result['edge-mia'].status, 'major_outage'); assert.equal(result['edge-atl'].status, 'operational');
  assert(!JSON.stringify(result).includes('test-token'));
  const again = await edgeProbes([mia], result, { CLOUDFLARE_ANALYTICS_TOKEN: 'test-token' }, T + 20000, async () => { throw new Error('must not query'); });
  assert.equal(again['edge-mia'], result['edge-mia']);
});

test('the regional component shows each location and names the failure', () => {
  const now = window.end + 60000;
  const state = { generatedAt: iso(now), probes: { 'edge-mia': classifyEdge(mia, [row('MIA', 200, 90), row('MIA', 522, 10)], window), 'edge-atl': classifyEdge(atl, [row('ATL', 200, 5)], window) }, freshness: {} };
  const component = viewState(registry, state, now).components.find(c => c.id === 'regional-access');
  assert.equal(component.status, 'partial_outage'); assert.equal(component.reasonCode, 'origin_unreachable');
  const [miami, atlanta] = component.measurements;
  assert.equal(miami.label, 'Visitor access via Miami'); assert.equal(miami.status, 'partial_outage'); assert.equal(miami.value, 10); assert.equal(miami.unit, '%'); assert.match(miami.summary, /10 of 100 visitor requests/);
  assert.equal(atlanta.status, 'unknown'); assert.match(atlanta.summary, /5 visitor requests; at least 30/);
  // Counts that do not add up are rejected instead of shown as up.
  const forged = viewState(registry, { ...state, probes: { ...state.probes, 'edge-atl': { status: 'operational', reasonCode: 'ok', observedAt: iso(window.end) } } }, now);
  assert.equal(forged.components.find(c => c.id === 'regional-access').measurements[1].reasonCode, 'invalid_evidence');
  assert.equal(seriesKinds(registry)['edge-mia'], 'edge'); assert.equal(CAPS.edge, 900);
});

test('two failing Miami windows open one incident and count in the New Relic heartbeat', async () => {
  const payload = { schemaVersion: 1, incidents: [] };
  let counter; let previous = {}; let view;
  const failing = [row('MIA', 200, 80), row('MIA', 522, 20), row('ATL', 200, 200)];
  for (const minute of [0, 5]) {
    const now = T + minute * 60000;
    const probes = await edgeProbes([mia, atl], previous, { CLOUDFLARE_ANALYTICS_TOKEN: 'test-token' }, now, ok(failing));
    previous = probes;
    view = viewState(registry, { generatedAt: iso(now), probes, freshness: {} }, now);
    const component = view.components.find(c => c.id === 'regional-access');
    const observation = recordObservation(component, counter); counter = observation.counter;
    advanceIncidents(payload, component, observation, iso(now));
  }
  assert.equal(confirmedSeverity(counter), 'partial_outage');
  assert.equal(payload.incidents.length, 1); assert.match(payload.incidents[0].title, /Access from Miami and Atlanta: availability issue/);
  let event;
  await publishHeartbeat({ components: view.components.filter(c => c.id === 'regional-access'), counters: { 'regional-access': counter } }, iso(T), { NEW_RELIC_STATUS_LICENSE_KEY: 'k', NEW_RELIC_STATUS_ACCOUNT_ID: '1' },
    async (_url, options) => { event = JSON.parse(options.body)[0]; return new Response('', { status: 200 }); });
  assert.equal(event.confirmedOutageComponents, 1);
});
