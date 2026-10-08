import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { viewState, time, REASONS, STATUSES } from '../public/model.mjs';
import { safeFetch, monitorHeaders } from './auth.mjs';
import { publishHeartbeat } from './heartbeat.mjs';
import { recordObservation, evidenceIdentity } from './observations.mjs';
import { sanitizeFreshness } from './freshness-contract.mjs';
import { advanceIncidents, seedConfirmedIncidents, incidentDocument } from './incidents.mjs';
import { blockedRequestEvidence, initialRenderBlocked, blockedRequestCounts } from './render-coverage.mjs';

const registry = JSON.parse(await readFile('config/components.json', 'utf8'));
async function load(path, fallback) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fallback; } }
const previous = await load('data/status.json', { probes: {}, freshness: {}, counters: {} });
const state = { schemaVersion: 1, generatedAt: new Date().toISOString(), probes: { ...previous.probes }, freshness: {}, counters: { ...previous.counters } };
const browserRun = process.argv.includes('--browser');
const evidence = (status, reasonCode, extra = {}) => ({ status, reasonCode, observedAt: new Date().toISOString(), ...extra });

async function boundedBody(response, max = 2000000) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let bytes = 0; const chunks = [];
  try { while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > max) throw new Error('body_limit'); chunks.push(value); } }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

async function httpProbe(probe) {
  const start = performance.now();
  try {
    const response = await safeFetch(probe.url, { signal: AbortSignal.timeout(18000), headers: { 'User-Agent': 'EasyChamp-Status-Monitor/1.0 (+https://status.easychamp.com)', Accept: probe.jsonFields ? 'application/json' : 'text/html' } }, probe.monitorAuth ? process.env.STATUS_MONITOR_TOKEN : null);
    if (response.status === 429 && (response.headers.get('x-ec-shed') === 'headless' || (probe.monitorAuth && process.env.STATUS_MONITOR_TOKEN && response.headers.get('x-ec-shed') === 'ratelimit'))) { await response.body?.cancel(); return evidence('unknown', 'automation_blocked'); }
    if (response.status !== 200) { await response.body?.cancel(); return evidence('major_outage', 'http_error', { httpStatus: response.status }); }
    const body = await boundedBody(response);
    const responseMs = Math.round(performance.now() - start);
    if (probe.bodyIncludes && !body.includes(probe.bodyIncludes)) return evidence('partial_outage', 'content_mismatch', { responseMs });
    if (probe.jsonFields) {
      let data; try { data = JSON.parse(body); } catch { return evidence('partial_outage', 'schema_mismatch', { responseMs }); }
      if (!data || Object.entries(probe.jsonFields).some(([key, type]) => typeof data[key] !== type)) return evidence('partial_outage', 'schema_mismatch', { responseMs });
    }
    return evidence(responseMs > probe.maxResponseMs ? 'degraded' : 'operational', responseMs > probe.maxResponseMs ? 'slow' : 'ok', { responseMs, httpStatus: 200 });
  } catch (error) { return evidence('major_outage', error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'network_error'); }
}

async function batch(items, action, concurrency = 4) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => { while (next < items.length) { const item = items[next++]; state.probes[item.id] = await action(item); } }));
}
await batch(registry.probes.filter(p => p.type === 'http'), httpProbe);

if (browserRun) {
  const { chromium } = await import('playwright');
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.STATUS_BROWSER_CHANNEL === 'chrome' ? { channel: 'chrome' } : {}) });
    await batch(registry.probes.filter(p => p.type === 'browser'), async probe => {
      const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
      if (probe.monitorAuth) await context.route('**/*', async route => { await route.continue({ headers: monitorHeaders(route.request().url(), process.env.STATUS_MONITOR_TOKEN, route.request().headers()) }); });
      const page = await context.newPage();
      const blockedRequests = [];
      page.on('response', response => {
        if (response.status() !== 429 || !['headless', 'ratelimit', 'fingerprint'].includes(response.headers()['x-ec-shed'])) return;
        const request = response.request();
        blockedRequests.push(blockedRequestEvidence({ resourceType: request.resourceType(), headers: request.headers(), url: request.url() }));
      });
      await page.addInitScript(() => {
        window.__statusLcp = 0;
        new PerformanceObserver(list => { for (const e of list.getEntries()) window.__statusLcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
      });
      try {
        const response = await page.goto(probe.url, { waitUntil: 'domcontentloaded', timeout: 22000 });
        if (response?.status() === 429 && (await response.allHeaders())['x-ec-shed'] === 'headless') return evidence('unknown', 'automation_blocked');
        if (!response || response.status() !== 200) return evidence('major_outage', 'http_error', { httpStatus: response?.status() || 0 });
        await page.waitForTimeout(6000);
        if (initialRenderBlocked(blockedRequests)) return evidence('unknown', 'automation_blocked');
        const title = await page.title();
        const metrics = await page.evaluate(() => ({ lcpMs: Math.round(window.__statusLcp || 0), textLength: document.body?.innerText.trim().length || 0, pendingVisibleImages: [...document.images].filter(i => { const r = i.getBoundingClientRect(); return r.width > 40 && r.height > 40 && r.top < innerHeight && r.bottom > 0 && (!i.complete || i.naturalWidth === 0); }).length }));
        if (!new RegExp(probe.titlePattern).test(title) || metrics.textLength < 30) return evidence('partial_outage', 'content_mismatch');
        if (metrics.lcpMs <= 0) return evidence('unknown', 'invalid_evidence');
        const slow = metrics.lcpMs > probe.maxLcpMs;
        const incomplete = metrics.pendingVisibleImages > 0;
        return evidence(slow || incomplete ? 'degraded' : 'operational', slow ? 'rendering_slow' : incomplete ? 'rendering_incomplete' : 'ok', { lcpMs: metrics.lcpMs });
      } catch (error) { return evidence('unknown', error.name === 'TimeoutError' ? 'timeout' : 'browser_unavailable'); }
      finally {
        if (probe.monitorAuth || blockedRequests.length) console.log(JSON.stringify({ probe: probe.id, blockedRequests: blockedRequestCounts(blockedRequests) }));
        await context.close();
      }
    }, 2);
  } catch { for (const p of registry.probes.filter(p => p.type === 'browser')) state.probes[p.id] = evidence('unknown', 'browser_unavailable'); }
  finally { await browser?.close(); }
}

const allowedFreshness = new Set(registry.components.filter(c => c.freshness).map(c => c.id));
function validPayloadIdentity(components) { return new Set(components.map(c => c?.id)).size === allowedFreshness.size && components.every(c => c && allowedFreshness.has(c.id)); }
try {
  const response = await fetch(registry.freshnessUrl, { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('unavailable');
  const payload = JSON.parse(await boundedBody(response, 40000));
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.components) || payload.components.length !== allowedFreshness.size
      || !validPayloadIdentity(payload.components)) throw new Error('invalid');
  for (const raw of payload.components) {
    const component = registry.components.find(c => c.id === raw.id);
    state.freshness[raw.id] = sanitizeFreshness(raw, component);
  }
} catch { /* Preserve explicit missing evidence, never last known green. */ }
for (const id of allowedFreshness) if (!state.freshness[id]) { const c=registry.components.find(c=>c.id===id); state.freshness[id] = { ...sanitizeFreshness(null,c), reasonCode:'collector_unavailable' }; }

state.generatedAt = new Date().toISOString();
const view = viewState(registry, state);
const oldView = viewState(registry, previous, time(previous.generatedAt) || Date.now());
const history = await load('data/history.json', { schemaVersion: 1, days: {} });
let incidentPayload;
try { incidentPayload = JSON.parse(await readFile('data/incidents.json', 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw new Error('invalid_incident_document'); incidentPayload = { schemaVersion: 1, incidents: [] }; }
const incidents = incidentDocument(incidentPayload);
seedConfirmedIncidents(state.counters, incidents);
const day = state.generatedAt.slice(0, 10);
history.days[day] ||= {};
for (const component of view.components) {
  const before = state.counters[component.id] || { bad: 0, good: 0 };
  if (!before.evidence && previous.generatedAt) before.evidence = evidenceIdentity(oldView.components.find(c => c.id === component.id));
  const observation = recordObservation(component, before);
  state.counters[component.id] = observation.counter;
  advanceIncidents(incidents, component, observation, state.generatedAt);
  if (!observation.isNew) continue;
  const counts = history.days[day][component.id] ||= {};
  counts[component.status] = (counts[component.status] || 0) + 1;
}
const cutoff = Date.now() - 90 * 86400000;
for (const date of Object.keys(history.days)) if (Date.parse(`${date}T00:00:00Z`) < cutoff) delete history.days[date];
// Never evict an unresolved incident because newer incidents consumed a cap.
incidents.incidents = [...incidents.incidents.filter(i => !i.resolvedAt), ...incidents.incidents.filter(i => i.resolvedAt).slice(0, 300)];
await mkdir('data', { recursive: true });
for (const [name, payload] of [['status', state], ['history', history], ['incidents', incidents]]) await writeFile(`data/${name}.json`, JSON.stringify(payload, null, 2) + '\n');
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `observed_at=${state.generatedAt}\n`);
console.log(JSON.stringify({ at: state.generatedAt, components: view.components.length, known: view.components.filter(c => c.status !== 'unknown').length, browserRun }));
console.log(JSON.stringify({ heartbeat: await publishHeartbeat({ ...view, counters: state.counters }, state.generatedAt) }));
