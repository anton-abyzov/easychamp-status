import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker, { collect, probeAll, probesToRun, CYCLE_SECONDS, SUBREQUEST_BUDGET } from '../worker/vantage/worker.mjs';

const now = Date.parse('2026-11-18T18:00:00Z');
const kv = () => { const m = new Map(); return { put: async (k, v) => m.set(k, v), get: async k => m.get(k) ?? null, m }; };
const html = () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } });

test('worker probes only http checks, tokenless, and publishes one document', async () => {
  const env = { VANTAGE: kv() };
  const seen = [];
  const document = await collect(env, { now: () => now, fetcher: async (url, init, token) => { seen.push({ url, token, headers: init.headers }); return html(); } });
  assert.equal(document.schemaVersion, 1);
  assert.equal(document.cycleSeconds, CYCLE_SECONDS);
  assert.deepEqual(Object.keys(document.results).sort(), probesToRun().map(p => p.id).sort());
  assert.ok(Object.entries(document.results).every(([id, r]) => r.url === probesToRun().find(p => p.id === id).url));
  assert.ok(seen.every(s => !s.token && !JSON.stringify(s.headers).toLowerCase().includes('x-ec-status-monitor')));
  assert.equal(JSON.parse(env.VANTAGE.m.get('latest')).generatedAt, new Date(now).toISOString());
});

test('a 429 from a guarded host is unavailable, not a failure; other errors are failures', async () => {
  const [first, second] = probesToRun();
  const results = await probeAll([first, second], { now: () => now, fetcher: async url => url === first.url ? new Response('', { status: 429 }) : new Response('', { status: 503 }) });
  assert.deepEqual([results[first.id].status, results[first.id].reasonCode], ['unknown', 'automation_blocked']);
  assert.equal(results[second.id].status, 'major_outage');
  assert.ok(!('edge' in results[second.id]));
});

test('a network error is a Worker failure result, never a thrown cron', async () => {
  const [first] = probesToRun();
  const results = await probeAll([first], { now: () => now, fetcher: async () => { throw new Error('boom'); } });
  assert.notEqual(results[first.id].status, 'operational');
});

test('HTTP handler: GET /v1/latest only, 503 before the first run, no-store', async () => {
  const env = { VANTAGE: kv() };
  assert.equal((await worker.fetch(new Request('https://v.example/v1/latest'), env)).status, 503);
  await env.VANTAGE.put('latest', '{"schemaVersion":1}');
  const good = await worker.fetch(new Request('https://v.example/v1/latest'), env);
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('cache-control'), 'no-store');
  assert.equal((await worker.fetch(new Request('https://v.example/other'), env)).status, 404);
  const post = await worker.fetch(new Request('https://v.example/v1/latest', { method: 'POST' }), env);
  assert.equal(post.status, 405);
});

test('free tier: cron writes, invocations and subrequests stay inside the limits', async () => {
  const config = JSON.parse((await readFile(new URL('../worker/vantage/wrangler.jsonc', import.meta.url), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
  const [minute] = config.triggers.crons[0].match(/^\*\/(\d+) \* \* \* \*$/).slice(1).map(Number);
  const perDay = 1440 / minute;
  assert.ok(perDay <= 1000, `KV writes per day ${perDay} must stay under the free 1,000`);
  assert.ok(perDay <= 100000);
  assert.equal(config.triggers.crons.length, 1);
  assert.ok(probesToRun().length <= SUBREQUEST_BUDGET && SUBREQUEST_BUDGET <= 49);
  // Redirect hops inside safeFetch spend the budget too: endless redirects stop at the cap.
  let calls = 0;
  const budget = await probeAll(probesToRun(), { now: () => now, fetchImpl: async url => { calls++; return new Response('', { status: 302, headers: { location: `${url}x` } }); } });
  assert.equal(Object.keys(budget).length, probesToRun().length);
  assert.ok(calls <= SUBREQUEST_BUDGET, `${calls} network calls exceed the budget`);
});
