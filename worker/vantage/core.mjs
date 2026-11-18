// Second vantage for the status page's HTTP checks: a Cloudflare Worker cron that probes the
// same URLs as scripts/http-probe.mjs (it reuses that code) from Cloudflare's network instead of
// a GitHub runner, and publishes the latest result for the collector to read. See
// ../../scripts/vantage.mjs for how the collector uses it (fail closed: a missing, late or
// erroring Worker never hides a failure).
import registry from '../../config/components.json' with { type: 'json' };
import { safeFetch } from '../../scripts/auth.mjs';
import { httpProbe } from '../../scripts/http-probe.mjs';

export const CYCLE_SECONDS = 120;
// Free tier allows 50 subrequests per invocation; redirects count, so stop well short of it.
export const SUBREQUEST_BUDGET = 45;
export const KEY = 'latest';

export const probesToRun = (reg = registry) => reg.probes.filter(p => p.type === 'http');

// A guarded host that answers 429 to the tokenless Worker says nothing about availability.
function publicResult(evidence, probe) {
  // The URL lets the collector reject a result measured against a stale probe definition.
  const base = { observedAt: evidence.observedAt, url: probe.url };
  if (evidence.httpStatus === 429) return { status: 'unknown', reasonCode: 'automation_blocked', ...base };
  return { status: evidence.status, reasonCode: evidence.reasonCode, ...base, ...(evidence.responseMs !== undefined ? { responseMs: evidence.responseMs } : {}), ...(evidence.httpStatus ? { httpStatus: evidence.httpStatus } : {}) };
}

export async function probeAll(probes = probesToRun(), { fetcher, fetchImpl = fetch, now = Date.now, concurrency = 4 } = {}) {
  const results = {};
  let used = 0;
  // Every network call, including each redirect hop inside safeFetch, spends the budget.
  const counted = (...args) => { if (++used > SUBREQUEST_BUDGET) throw new Error('subrequest_budget'); return fetchImpl(...args); };
  const budgeted = fetcher ? (...args) => { if (++used > SUBREQUEST_BUDGET) throw new Error('subrequest_budget'); return fetcher(...args); } : (url, init, token) => safeFetch(url, init, token, counted);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(probes.length, concurrency) }, async () => {
    while (next < probes.length) {
      const probe = probes[next++];
      // No monitor token: the Worker has none and never needs one.
      results[probe.id] = publicResult(await httpProbe(probe, { fetcher: budgeted, now, token: null }), probe);
    }
  }));
  return results;
}

export async function collect(env, deps = {}) {
  const now = deps.now || Date.now;
  const document = { schemaVersion: 1, generatedAt: new Date(now()).toISOString(), cycleSeconds: CYCLE_SECONDS, results: await probeAll(probesToRun(deps.registry), deps) };
  await env.VANTAGE.put(KEY, JSON.stringify(document));
  return document;
}
