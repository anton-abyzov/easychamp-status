// Sampled request evidence shared by the collector, the page and the tests.
// A run is one collection pass: { at, n: checked HTTP probes, f: hard-failed probe ids, s: slow probe ids }.
// Hard failure = timeout, connection failure, HTTP error or missing content. Unknown never counts as failure.
export const HARD_FAILURES = ['major_outage', 'partial_outage'];
export const WINDOW_MS = 45 * 60000;
export const WINDOW_RUNS = 6;
export const RUN_RETENTION_MS = 8 * 86400000;
// A sample interval longer than this is a monitoring gap, not evidence of service state.
export const MAX_SAMPLE_GAP_MS = 15 * 60000;

const iso = t => new Date(t).toISOString();
const at = run => Date.parse(run?.at);
const validRun = r => r && Number.isFinite(at(r)) && Number.isInteger(r.n) && r.n > 0 && Array.isArray(r.f) && r.f.every(id => typeof id === 'string') && r.f.length <= r.n && (!r.s || Array.isArray(r.s));

// Only HTTP probes observed during this pass count; replayed earlier samples are excluded.
export function runFromProbes(probes, httpIds, startedAt) {
  const fresh = httpIds.map(id => [id, probes?.[id]]).filter(([, s]) => s && Date.parse(s.observedAt) >= startedAt && s.status !== 'unknown');
  if (!fresh.length) return null;
  return { at: iso(Math.min(...fresh.map(([, s]) => Date.parse(s.observedAt)))), n: fresh.length, f: fresh.filter(([, s]) => HARD_FAILURES.includes(s.status)).map(([id]) => id).sort(), s: fresh.filter(([, s]) => s.status === 'degraded').map(([id]) => id).sort() };
}

export function advanceRuns(runs, run, now = Date.now()) {
  const list = (Array.isArray(runs) ? runs : []).filter(validRun);
  if (validRun(run) && !list.some(r => r.at === run.at)) list.push(run);
  return list.filter(r => at(r) >= now - RUN_RETENTION_MS && at(r) <= now + 60000).sort((a, b) => at(a) - at(b));
}

// Rolling evidence: a single failed request is not an outage, but repeated failures within
// 45 minutes are, even when each service recovers on the next sample.
export function windowEvidence(runs, now = Date.now()) {
  const recent = (runs || []).filter(validRun).filter(r => at(r) <= now + 60000 && now - at(r) <= WINDOW_MS).slice(-WINDOW_RUNS);
  const latest = recent.at(-1);
  if (!latest || now - at(latest) > MAX_SAMPLE_GAP_MS) return { status: 'unknown', reasonCode: 'stale', observedAt: latest?.at || null };
  const failedRuns = recent.filter(r => r.f.length).length;
  const failedChecks = recent.reduce((sum, r) => sum + r.f.length, 0);
  const totalChecks = recent.reduce((sum, r) => sum + r.n, 0);
  const affected = [...new Set(recent.flatMap(r => r.f))].sort();
  const base = { observedAt: latest.at, failedRuns, windowRuns: recent.length, failedChecks, totalChecks, affected };
  if (latest.f.length * 2 >= latest.n && latest.n >= 2) return { ...base, status: 'major_outage', reasonCode: 'widespread_failure' };
  if (failedRuns >= 2 && failedChecks >= 3) return { ...base, status: 'partial_outage', reasonCode: 'intermittent_failures' };
  return { ...base, status: 'operational', reasonCode: 'ok' };
}

function mergeIntervals(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]), out = [];
  for (const [a, b] of sorted) { const last = out.at(-1); if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]); }
  return out;
}
const total = intervals => intervals.reduce((sum, [a, b]) => sum + (b - a), 0);
function subtract(intervals, holes) {
  let out = intervals;
  for (const [ha, hb] of holes) out = out.flatMap(([a, b]) => b <= ha || a >= hb ? [[a, b]] : [[a, Math.min(b, ha)], [Math.max(a, hb), b]].filter(([x, y]) => y > x));
  return out;
}
const clip = (intervals, from, to) => intervals.map(([a, b]) => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a);

// Bounds for "time with at least one failing service" from sampled runs.
// Lower: span between consecutive failed samples of one service (one isolated failed sample counts 0).
// Upper: from the last passing sample before to the first passing sample after; each side capped at the gap limit.
// Unmonitored: time between runs that exceeds the gap limit, plus time before the first run in range.
// Unmonitored time is excluded from the upper bound, so the three numbers never overlap.
export function availabilityStats(runs, from, to, ids = null) {
  const list = (runs || []).filter(validRun).filter(r => at(r) <= to).sort((a, b) => at(a) - at(b));
  const keep = id => !ids || ids.includes(id);
  const inRange = list.filter(r => at(r) >= from);
  const gaps = [];
  let cursor = from;
  for (const r of inRange) { if (at(r) - cursor > MAX_SAMPLE_GAP_MS) gaps.push([cursor, at(r)]); cursor = at(r); }
  if (to - cursor > MAX_SAMPLE_GAP_MS) gaps.push([cursor, to]);
  const probes = [...new Set(list.flatMap(r => r.f.filter(keep)))];
  const lower = [], upper = [], episodes = [];
  for (const id of probes) {
    const seen = list;
    for (let i = 0; i < seen.length; i++) {
      if (!seen[i].f.includes(id)) continue;
      let j = i; while (j + 1 < seen.length && seen[j + 1].f.includes(id) && at(seen[j + 1]) - at(seen[j]) <= MAX_SAMPLE_GAP_MS) j++;
      const first = at(seen[i]), last = at(seen[j]);
      const before = i > 0 ? Math.max(at(seen[i - 1]), first - MAX_SAMPLE_GAP_MS) : first;
      const after = j + 1 < seen.length ? Math.min(at(seen[j + 1]), last + MAX_SAMPLE_GAP_MS) : Math.min(to, last + MAX_SAMPLE_GAP_MS);
      lower.push([first, last]); upper.push([before, after]); episodes.push({ id, first, last, samples: j - i + 1 });
      i = j;
    }
  }
  const scoped = inRange.map(r => ({ f: r.f.filter(keep) }));
  const checks = inRange.reduce((sum, r) => sum + (ids ? Math.min(r.n, ids.length) : r.n), 0), failed = scoped.reduce((sum, r) => sum + r.f.length, 0);
  const gapIntervals = mergeIntervals(gaps);
  const lowerMs = total(clip(mergeIntervals(lower), from, to));
  const upperMs = total(subtract(clip(mergeIntervals(upper), from, to), gapIntervals));
  const gapMs = total(gapIntervals);
  const windowMs = Math.max(0, to - from);
  const minutes = ms => Math.round(ms / 60000);
  const pct = ms => windowMs ? Math.round(10000 * ms / windowMs) / 100 : null;
  return {
    from: iso(from), to: iso(to), runs: inRange.length, failedRuns: scoped.filter(r => r.f.length).length,
    checks, failedChecks: failed, failureRatePct: checks ? Math.round(10000 * failed / checks) / 100 : null,
    failingMinutesLower: minutes(lowerMs), failingMinutesUpper: minutes(upperMs), unmonitoredMinutes: minutes(gapMs),
    monitoredPct: pct(windowMs - gapMs), availabilityLowerPct: pct(windowMs - upperMs - gapMs), availabilityUpperPct: pct(windowMs - lowerMs),
    episodes: episodes.filter(e => e.last >= from).length,
  };
}
