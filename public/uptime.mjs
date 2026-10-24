// Minute accounting for sampled checks. Shared by the collector (Node) and the page.
//
// A series is a list of segments [startSec, lastSec, code, samples, reason?]: consecutive
// fresh samples with the same code and reason, each no more than `cap` seconds apart.
// A sample stands for the time until the next sample, but never longer than `cap`;
// anything beyond that is uncovered and is reported as a monitoring gap, never as
// either uptime or downtime.
export const CODE = { operational: 'o', degraded: 'd', partial_outage: 'p', major_outage: 'm', maintenance: 'n', unknown: 'u' };
export const STATUS = Object.fromEntries(Object.entries(CODE).map(([status, code]) => [code, status]));
export const DOWN = new Set(['p', 'm']);
const WORST = ['m', 'p', 'd', 'u', 'n', 'o'];
export const worst = codes => WORST.find(code => codes.includes(code)) || null;

export function appendSample(series, sample, cap) {
  const { at, code } = sample;
  if (!Number.isInteger(at) || !Object.hasOwn(STATUS, code)) return false;
  const last = series.at(-1);
  // Replayed or out-of-order evidence never counts twice.
  if (last && at <= last[1]) return false;
  const reason = code === 'o' ? undefined : (typeof sample.reason === 'string' ? sample.reason : undefined);
  if (last && last[2] === code && last[4] === reason && at - last[1] <= cap) { last[1] = at; last[3] += 1; return true; }
  series.push(reason ? [at, at, code, 1, reason] : [at, at, code, 1]);
  return true;
}

export function prune(series, cutoff, cap) {
  let drop = 0;
  while (drop < series.length && series[drop][1] + cap < cutoff) drop++;
  if (drop) series.splice(0, drop);
  return series;
}

// Covered time per segment. Consecutive down segments form one failure run; a run made
// of two or more consecutive failed checks is "sustained", a single failed check is a blip.
export function intervals(series, cap, now) {
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const [start, last, code, n, reason] = series[i];
    const next = series[i + 1]?.[0];
    let end = next !== undefined && next - last <= cap ? next : last + cap;
    if (next === undefined) end = Math.min(end, Math.max(now, last));
    out.push({ start, end, code, n, reason });
  }
  for (let i = 0; i < out.length;) {
    if (!DOWN.has(out[i].code)) { i++; continue; }
    let j = i, checks = 0;
    while (j < out.length && DOWN.has(out[j].code) && (j === i || out[j - 1].end === out[j].start)) checks += out[j++].n;
    for (let k = i; k < j; k++) out[k].sustained = checks >= 2;
    i = j;
  }
  return out;
}

export function summarize(list, from, to) {
  const s = { from, to, totalSec: Math.max(0, to - from), o: 0, d: 0, p: 0, m: 0, n: 0, u: 0, sustainedDownSec: 0, failedChecks: 0, knownChecks: 0, episodes: 0, longestDownSec: 0 };
  let run = 0, runEnd = null;
  const closeRun = () => { if (run > 0) { s.episodes++; s.longestDownSec = Math.max(s.longestDownSec, run); } run = 0; };
  for (const iv of list) {
    const overlap = Math.max(0, Math.min(iv.end, to) - Math.max(iv.start, from));
    if (!overlap) continue;
    s[iv.code] += overlap;
    if (DOWN.has(iv.code)) {
      if (iv.sustained) s.sustainedDownSec += overlap;
      if (runEnd !== iv.start) closeRun();
      run += overlap; runEnd = iv.end;
    } else { closeRun(); runEnd = null; }
    // Checks are attributed to the window by their covered share.
    const share = iv.end > iv.start ? overlap / (iv.end - iv.start) : 1;
    if (iv.code !== 'u' && iv.code !== 'n') s.knownChecks += iv.n * share;
    if (DOWN.has(iv.code)) s.failedChecks += iv.n * share;
  }
  closeRun();
  s.coveredSec = s.o + s.d + s.p + s.m + s.n + s.u;
  s.uncoveredSec = Math.max(0, s.totalSec - s.coveredSec);
  s.knownSec = s.o + s.d + s.p + s.m;
  s.downSec = s.p + s.m;
  s.slowSec = s.d;
  s.uptime = s.knownSec > 0 ? (s.knownSec - s.downSec) / s.knownSec : null;
  s.coverage = s.totalSec > 0 ? s.knownSec / s.totalSec : null;
  s.failedChecks = Math.round(s.failedChecks);
  s.knownChecks = Math.round(s.knownChecks);
  return s;
}

// Worst status across several services at each moment. A moment where no series has
// coverage stays uncovered; partially covered moments use the services that were checked.
export function combine(lists) {
  const points = [...new Set(lists.flatMap(list => list.flatMap(iv => [iv.start, iv.end])))].sort((a, b) => a - b);
  const out = [];
  const cursor = lists.map(() => 0);
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const codes = [], sustained = [];
    lists.forEach((list, li) => {
      while (cursor[li] < list.length && list[cursor[li]].end <= a) cursor[li]++;
      const iv = list[cursor[li]];
      if (iv && iv.start <= a && iv.end >= b) { codes.push(iv.code); if (iv.sustained) sustained.push(iv.code); }
    });
    if (!codes.length) continue;
    const code = worst(codes);
    const last = out.at(-1);
    const isSustained = DOWN.has(code) && sustained.some(c => DOWN.has(c));
    if (last && last.end === a && last.code === code && last.sustained === isSustained) last.end = b;
    else out.push({ start: a, end: b, code, n: 0, sustained: isSustained });
  }
  return out;
}

// The latest individual checks, oldest first, expanded from the compressed segments.
export function recentChecks(series, limit) {
  const out = [];
  for (let i = series.length - 1; i >= 0 && out.length < limit; i--) {
    const [start, last, code, n, reason] = series[i];
    for (let k = n - 1; k >= 0 && out.length < limit; k--) {
      // Exact times exist only for the first and last check of a segment.
      const at = k === n - 1 ? last : k === 0 ? start : Math.round(start + (last - start) * k / (n - 1));
      out.push({ at, code, reason });
    }
  }
  return out.reverse();
}
