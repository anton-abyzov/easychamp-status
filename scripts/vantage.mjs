// Second vantage point (a Cloudflare Worker cron, worker/vantage) for the HTTP checks.
//
// The collector's checks run from one GitHub runner. On November 18, 2026 unrelated services
// (landing, console, sim, arena, snap) timed out in the same minute while the origin never saw
// the probe or answered in 0.26 s: the runner-to-cluster path, not the services. A failure of
// the runner alone is therefore recorded as `probe_path_suspect` (an `unknown` check: visible in
// the evidence and the timeline, but it neither confirms nor clears an incident, so it never
// counts toward the 2-of-4 rule). A failure counts only when the Worker fails it too.
//
// FAIL CLOSED. The runner's result counts exactly as before whenever the second vantage is
// missing, late (older than one cycle), erroring, unreadable, blocked, or did not measure that
// probe. Only a fresh, readable, passing Worker result for the same URL can hold a failure back.
import { time, STATUSES } from '../public/model.mjs';
import { boundedBody } from './http-probe.mjs';

export const VANTAGE = Object.freeze({
  // One status cycle: the pacer starts a run at most every 330 s (pacer-decision MIN_GAP_SECONDS).
  docMaxAgeSeconds: 330,
  // The Worker cron runs every 2 minutes; a result further from the runner's check than this
  // (cron period plus jitter) is not a contemporaneous second opinion.
  resultSkewSeconds: 180,
  clusterWindowSeconds: 120,
  clusterMinComponents: 4,
  // Safety valve: a probe the Worker keeps passing while the runner keeps failing it counts again
  // after this many consecutive runs, so a runner-visible path problem is never hidden for long.
  persistentRuns: 3,
  eventRetentionDays: 14,
  maxEvents: 2000,
  fetchTimeoutMs: 8000,
});
const FAILING = new Set(['degraded', 'partial_outage', 'major_outage']);

export function parseWorkerDocument(doc, now = Date.now()) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.schemaVersion !== 1) return null;
  const generated = time(doc.generatedAt);
  if (generated === null || generated > now + 60000 || now - generated > VANTAGE.docMaxAgeSeconds * 1000) return null;
  if (!doc.results || typeof doc.results !== 'object' || Array.isArray(doc.results)) return null;
  const results = {};
  for (const [id, result] of Object.entries(doc.results)) {
    const observed = time(result?.observedAt);
    if (!result || typeof result !== 'object' || !STATUSES.includes(result.status) || typeof result.reasonCode !== 'string'
        || observed === null || observed > now + 60000) continue;
    results[id] = { status: result.status, reasonCode: result.reasonCode, observedAt: new Date(observed).toISOString() };
  }
  return { generatedAt: new Date(generated).toISOString(), results };
}

/** The Worker's latest document, or null for anything that is not a fresh, valid one. */
export async function fetchWorkerDocument(url, { fetcher = fetch, now = Date.now } = {}) {
  if (!url) return null;
  try {
    if (new URL(url).protocol !== 'https:') return null;
    const response = await fetcher(url, { signal: AbortSignal.timeout(VANTAGE.fetchTimeoutMs), headers: { Accept: 'application/json' }, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); return null; }
    return parseWorkerDocument(JSON.parse(await boundedBody(response, 64_000)), now());
  } catch { return null; }
}

function clusterMembers(failing) {
  const sorted = [...failing].sort((a, b) => a.at - b.at);
  const members = new Set();
  for (let i = 0; i < sorted.length; i++) {
    const window = [];
    for (let k = i; k < sorted.length && sorted[k].at - sorted[i].at <= VANTAGE.clusterWindowSeconds * 1000; k++) window.push(sorted[k]);
    if (new Set(window.map(f => f.component)).size >= VANTAGE.clusterMinComponents) for (const f of window) members.add(f.id);
  }
  return members;
}

// What the Worker saw for this URL: 'pass' (reached it, healthy), 'fail', or 'unavailable'.
function classify(worker, id, at) {
  const result = id ? worker?.results?.[id] : null;
  if (!result) return { kind: 'unavailable' };
  const observed = time(result.observedAt);
  if (observed === null || Math.abs(at - observed) > VANTAGE.resultSkewSeconds * 1000) return { kind: 'unavailable', result };
  if (result.status === 'operational') return { kind: 'pass', result };
  if (FAILING.has(result.status)) return { kind: 'fail', result };
  return { kind: 'unavailable', result };
}

/**
 * Applies the second vantage to this run's HTTP and rendering evidence. Pure: returns the
 * replacement evidence (only for held-back probes), the events to record and the suspect state.
 * `probedIds` are the probes measured in THIS run (cached rendering evidence is never re-judged).
 */
export function reconcileVantages({ registry, probes, probedIds, worker, previous = {} }) {
  const defs = new Map(registry.probes.map(p => [p.id, p]));
  const componentOf = id => registry.components.find(c => c.probes?.includes(id))?.id ?? id;
  const httpFor = def => def.type === 'http' ? def.id : registry.probes.find(p => p.type === 'http' && p.url === def.url)?.id;
  const failing = [];
  for (const id of probedIds) {
    const def = defs.get(id), evidence = probes[id], at = time(evidence?.observedAt);
    if (!def || !['http', 'browser'].includes(def.type) || !FAILING.has(evidence?.status) || at === null) continue;
    failing.push({ id, def, evidence, at, component: componentOf(id) });
  }
  const cluster = clusterMembers(failing);
  const replaced = {}, events = [], suspects = {};
  for (const f of failing) {
    const inCluster = cluster.has(f.id);
    // The Worker cannot measure rendering; a slow or failed render is only held back inside a
    // cluster of simultaneous failures, and only when the Worker reached the same URL.
    if (f.def.type === 'browser' && !inCluster) continue;
    const seen = classify(worker, httpFor(f.def), f.at);
    if (seen.kind !== 'pass') continue;
    const runs = (previous.suspects?.[f.id]?.runs || 0) + 1;
    const since = previous.suspects?.[f.id]?.since || f.evidence.observedAt;
    suspects[f.id] = { runs, since };
    const event = { at: f.evidence.observedAt, probe: f.id, component: f.component, runner: { status: f.evidence.status, reasonCode: f.evidence.reasonCode },
      worker: { status: seen.result.status, reasonCode: seen.result.reasonCode, observedAt: seen.result.observedAt }, cluster: inCluster, runs };
    if (runs >= VANTAGE.persistentRuns) { events.push({ ...event, outcome: 'counted_persistent' }); continue; }
    events.push({ ...event, outcome: 'suspect' });
    replaced[f.id] = { status: 'unknown', reasonCode: 'probe_path_suspect', observedAt: f.evidence.observedAt, ...(f.evidence.edge ? { edge: f.evidence.edge } : {}),
      suspectOf: { status: f.evidence.status, reasonCode: f.evidence.reasonCode }, worker: event.worker, cluster: inCluster };
  }
  // A probe that was not measured this run keeps its streak; one that was and is not suspect resets.
  for (const [id, entry] of Object.entries(previous.suspects || {})) if (!probedIds.has(id) && !suspects[id]) suspects[id] = entry;
  return { probes: replaced, events, suspects, summary: { failing: failing.length, held: Object.keys(replaced).length, cluster: cluster.size, workerAvailable: Boolean(worker) } };
}

export function nextVantageDocument(previous, verdict, now = Date.now()) {
  const cutoff = now - VANTAGE.eventRetentionDays * 86400000;
  const events = [...(previous?.events || []), ...verdict.events].filter(e => (time(e.at) ?? 0) >= cutoff).slice(-VANTAGE.maxEvents);
  return { schemaVersion: 1, suspects: verdict.suspects, events };
}
