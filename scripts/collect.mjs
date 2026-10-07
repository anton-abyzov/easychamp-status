import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { viewState, time, REASONS, STATUSES } from '../public/model.mjs';
import { safeFetch, monitorHeaders } from './auth.mjs';
import { publishHeartbeat } from './heartbeat.mjs';

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
    if (response.status === 429 && response.headers.get('x-ec-shed') === 'headless') { await response.body?.cancel(); return evidence('unknown', 'automation_blocked'); }
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
    browser = await chromium.launch({ headless: true });
    await batch(registry.probes.filter(p => p.type === 'browser'), async probe => {
      const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
      if (probe.monitorAuth) await context.route('**/*', async route => { await route.continue({ headers: monitorHeaders(route.request().url(), process.env.STATUS_MONITOR_TOKEN, route.request().headers()) }); });
      const page = await context.newPage();
      await page.addInitScript(() => {
        window.__statusLcp = 0;
        new PerformanceObserver(list => { for (const e of list.getEntries()) window.__statusLcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
      });
      try {
        const response = await page.goto(probe.url, { waitUntil: 'domcontentloaded', timeout: 22000 });
        if (response?.status() === 429 && (await response.allHeaders())['x-ec-shed'] === 'headless') return evidence('unknown', 'automation_blocked');
        if (!response || response.status() !== 200) return evidence('major_outage', 'http_error', { httpStatus: response?.status() || 0 });
        await page.waitForTimeout(6000);
        const title = await page.title();
        const metrics = await page.evaluate(() => ({ lcpMs: Math.round(window.__statusLcp || 0), textLength: document.body?.innerText.trim().length || 0, pendingVisibleImages: [...document.images].filter(i => { const r = i.getBoundingClientRect(); return r.width > 40 && r.height > 40 && r.top < innerHeight && r.bottom > 0 && (!i.complete || i.naturalWidth === 0); }).length }));
        if (!new RegExp(probe.titlePattern).test(title) || metrics.textLength < 30) return evidence('partial_outage', 'content_mismatch');
        if (metrics.lcpMs <= 0) return evidence('unknown', 'invalid_evidence');
        const slow = metrics.lcpMs > probe.maxLcpMs || metrics.pendingVisibleImages > 0;
        return evidence(slow ? 'degraded' : 'operational', slow ? 'rendering_slow' : 'ok', { lcpMs: metrics.lcpMs });
      } catch (error) { return evidence('unknown', error.name === 'TimeoutError' ? 'timeout' : 'browser_unavailable'); }
      finally { await context.close(); }
    }, 2);
  } catch { for (const p of registry.probes.filter(p => p.type === 'browser')) state.probes[p.id] = evidence('unknown', 'browser_unavailable'); }
  finally { await browser?.close(); }
}

const allowedFreshness = new Set(registry.components.filter(c => c.freshness).map(c => c.id));
const allowedFields = ['id', 'status', 'observedAt', 'lastCompletedSuccessAt', 'lastDestinationVerifiedAt', 'nextDueAt', 'graceSeconds', 'reasonCode'];
try {
  const response = await fetch(registry.freshnessUrl, { signal: AbortSignal.timeout(12000), headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('unavailable');
  const payload = JSON.parse(await boundedBody(response, 100000));
  if (payload.schemaVersion !== 1 || !Array.isArray(payload.components)) throw new Error('invalid');
  for (const component of payload.components) {
    if (!allowedFreshness.has(component.id) || state.freshness[component.id]) continue;
    const safe = Object.fromEntries(allowedFields.filter(k => Object.hasOwn(component, k)).map(k => [k, component[k]]));
    if (!STATUSES.includes(safe.status) || !Object.hasOwn(REASONS, safe.reasonCode)) continue;
    if (Object.entries(safe).some(([k, v]) => k !== 'graceSeconds' && typeof v !== 'string' && v !== null)) continue;
    for (const key of ['observedAt', 'lastCompletedSuccessAt', 'lastDestinationVerifiedAt', 'nextDueAt']) safe[key] = time(safe[key]) === null ? null : new Date(time(safe[key])).toISOString();
    if (!Number.isInteger(safe.graceSeconds) || safe.graceSeconds < 0 || safe.graceSeconds > 604800) { safe.graceSeconds = 0; safe.status = 'unknown'; safe.reasonCode = 'invalid_evidence'; }
    if (!safe.observedAt) { safe.status = 'unknown'; safe.reasonCode = 'invalid_evidence'; }
    state.freshness[component.id] = safe;
  }
} catch { /* Preserve explicit missing evidence, never last known green. */ }
for (const id of allowedFreshness) if (!state.freshness[id]) state.freshness[id] = evidence('unknown', 'collector_unavailable');

state.generatedAt = new Date().toISOString();
const view = viewState(registry, state);
const history = await load('data/history.json', { schemaVersion: 1, days: {} });
const incidents = await load('data/incidents.json', { schemaVersion: 1, incidents: [] });
const day = state.generatedAt.slice(0, 10);
history.days[day] ||= {};
for (const component of view.components) {
  const counts = history.days[day][component.id] ||= {};
  counts[component.status] = (counts[component.status] || 0) + 1;
  const bad = ['degraded', 'partial_outage', 'major_outage'].includes(component.status);
  const before = state.counters[component.id] || { bad: 0, good: 0 };
  state.counters[component.id] = { bad: bad ? before.bad + 1 : 0, good: component.status === 'operational' ? before.good + 1 : 0 };
  const open = incidents.incidents.find(i => i.componentId === component.id && !i.resolvedAt);
  if (bad && state.counters[component.id].bad >= 2) {
    if (!open) incidents.incidents.unshift({ id: `${component.id}-${Date.now()}`, componentId: component.id, title: `${component.name}: ${component.status === 'degraded' ? 'degraded performance' : 'availability issue'}`, status: component.status, reasonCode: component.reasonCode, openedAt: state.generatedAt, updatedAt: state.generatedAt, resolvedAt: null });
    else { open.status = component.status; open.reasonCode = component.reasonCode; open.updatedAt = state.generatedAt; }
  } else if (open && state.counters[component.id].good >= 2) { open.updatedAt = state.generatedAt; open.resolvedAt = state.generatedAt; }
}
const cutoff = Date.now() - 90 * 86400000;
for (const date of Object.keys(history.days)) if (Date.parse(`${date}T00:00:00Z`) < cutoff) delete history.days[date];
incidents.incidents = incidents.incidents.filter(i => !i.resolvedAt || time(i.resolvedAt) >= cutoff).slice(0, 300);
await mkdir('data', { recursive: true });
for (const [name, payload] of [['status', state], ['history', history], ['incidents', incidents]]) await writeFile(`data/${name}.json`, JSON.stringify(payload, null, 2) + '\n');
console.log(JSON.stringify({ at: state.generatedAt, components: view.components.length, known: view.components.filter(c => c.status !== 'unknown').length, browserRun }));
console.log(JSON.stringify({ heartbeat: await publishHeartbeat(view, state.generatedAt) }));
