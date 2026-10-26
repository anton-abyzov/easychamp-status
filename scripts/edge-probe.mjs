// Regional access from real visitor traffic. Cloudflare reports, per edge location, how many
// requests it could not complete because the origin did not answer. The runners that drive the
// HTTP checks reach one location, so this is the only evidence for visitors served elsewhere.
import { time } from '../public/model.mjs';

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
export const ROW_LIMIT = 5000;
// Errors Cloudflare generates when it gets no usable answer from the origin.
export const ORIGIN_ERRORS = new Set([520, 521, 522, 523, 524, 525, 526, 530]);
const QUERY = `query($zone:String!,$since:Time!,$until:Time!,$colos:[String!],$hosts:[String!]){viewer{zones(filter:{zoneTag:$zone}){httpRequestsAdaptiveGroups(limit:${ROW_LIMIT},filter:{datetime_geq:$since,datetime_lt:$until,coloCode_in:$colos,clientRequestHTTPHost_in:$hosts,requestSource:"eyeball"}){count dimensions{datetimeMinute coloCode edgeResponseStatus originResponseStatus}}}}}`;

// Other 5xx without an origin response (rate limits, Workers, maintenance pages) show at every
// location alike, so the checks from Los Angeles already see them; they are not counted here.
export function originError(edgeStatus) {
  return ORIGIN_ERRORS.has(edgeStatus);
}

// Windows chain on `measuredUntil`, so no minute is judged twice. A window is at least
// `windowSeconds` long; while traffic is too thin it keeps growing up to `maxWindowSeconds`.
// Returns null when the next window is not complete yet.
export function edgeWindow(probe, previous, now) {
  const end = Math.floor((now - probe.lagSeconds * 1000) / 60000) * 60000;
  const prior = time(previous?.measuredUntil);
  if (prior === null) return { start: end - probe.windowSeconds * 1000, end };
  if (end - prior < probe.windowSeconds * 1000) return null;
  return { start: Math.max(prior, end - probe.maxWindowSeconds * 1000), end };
}

export function classifyEdge(probe, rows, window) {
  const mine = rows.filter(row => row?.dimensions?.coloCode === probe.colo && Number.isFinite(row.count) && row.count >= 0);
  const failed = mine.filter(row => originError(row.dimensions.edgeResponseStatus));
  const requests = mine.reduce((sum, row) => sum + row.count, 0);
  const errors = failed.reduce((sum, row) => sum + row.count, 0);
  const errorMinutes = new Set(failed.filter(row => row.count > 0).map(row => row.dimensions.datetimeMinute)).size;
  const evidence = { observedAt: new Date(window.end).toISOString(), windowStart: new Date(window.start).toISOString(), windowEnd: new Date(window.end).toISOString(), requests, originErrors: errors, errorMinutes };
  if (requests < probe.minRequests) {
    // Thin traffic is never judged down. A full window of thin traffic without a single failure
    // still shows the location reaches EasyChamp, so a quiet night can clear an outage.
    const full = window.end - window.start >= probe.maxWindowSeconds * 1000;
    if (full && errors === 0 && requests >= probe.minThinRequests) return { status: 'operational', reasonCode: 'ok', ...evidence, errorShare: 0, measuredUntil: evidence.windowEnd };
    // Otherwise keep collecting this stretch until it has enough traffic, or reaches the cap.
    return { status: 'unknown', reasonCode: 'low_traffic', ...evidence, measuredUntil: new Date(full ? window.end : window.start).toISOString() };
  }
  const share = errors / requests;
  const result = { ...evidence, errorShare: Math.round(share * 10000) / 10000, measuredUntil: evidence.windowEnd };
  // A short burst inside one minute is not enough evidence, whatever its share.
  if (errors < probe.minErrors || errorMinutes < probe.minErrorMinutes) return { status: 'operational', reasonCode: 'ok', ...result };
  if (share >= probe.majorShare) return { status: 'major_outage', reasonCode: 'origin_unreachable', ...result };
  if (share >= probe.partialShare) return { status: 'partial_outage', reasonCode: 'origin_unreachable', ...result };
  if (share >= probe.degradedShare) return { status: 'degraded', reasonCode: 'origin_unreachable', ...result };
  return { status: 'operational', reasonCode: 'ok', ...result };
}

// One query per zone covers every location. Missing token, API errors, truncated and malformed
// answers are unknown: they never count as up or down, and the unmeasured minutes stay queued.
export async function edgeProbes(probes, previous, env = process.env, now = Date.now(), send = fetch) {
  const result = {};
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN;
  const unknownAt = (reasonCode, probe, window) => ({ status: 'unknown', reasonCode, observedAt: new Date(window.end).toISOString(),
    ...(previous?.[probe.id]?.measuredUntil ? { measuredUntil: previous[probe.id].measuredUntil } : {}) });
  const groups = new Map();
  for (const probe of probes) {
    const window = edgeWindow(probe, previous?.[probe.id], now);
    if (!window) { result[probe.id] = previous[probe.id]; continue; }
    if (!token) { result[probe.id] = unknownAt('edge_not_configured', probe, window); continue; }
    const key = JSON.stringify([probe.zoneTag, probe.hosts, window.start, window.end]);
    if (!groups.has(key)) groups.set(key, { probe, window, members: [] });
    groups.get(key).members.push(probe);
  }
  for (const { probe: first, window, members } of groups.values()) {
    let rows = null;
    try {
      const response = await send(ENDPOINT, { method: 'POST', signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { zone: first.zoneTag, since: new Date(window.start).toISOString(), until: new Date(window.end).toISOString(), colos: members.map(p => p.colo), hosts: first.hosts } }) });
      const body = response.ok ? await response.json() : null;
      const answer = body?.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups;
      if (!body?.errors?.length && Array.isArray(answer) && answer.length < ROW_LIMIT) rows = answer;
    } catch { rows = null; }
    for (const probe of members) {
      if (!rows) { result[probe.id] = unknownAt('analytics_unavailable', probe, window); continue; }
      const verdict = classifyEdge(probe, rows, window), prior = previous?.[probe.id];
      // While a quiet stretch is still collecting traffic there is no new check: the last verdict
      // stands (and expires on its own), so recovery is not reset by a placeholder unknown.
      result[probe.id] = verdict.reasonCode === 'low_traffic' && verdict.measuredUntil !== verdict.windowEnd && prior && prior.status !== 'unknown' ? prior : verdict;
    }
  }
  return result;
}
