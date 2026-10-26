// Regional access from real visitor traffic. Cloudflare reports, per edge location, how many
// requests it could not complete because the origin did not answer. The runners that drive the
// HTTP checks reach one location, so this is the only evidence for visitors served elsewhere.
import { time } from '../public/model.mjs';

const ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
// Errors Cloudflare generates when it gets no usable answer from the origin.
export const ORIGIN_ERRORS = new Set([520, 521, 522, 523, 524, 525, 526, 530]);
const QUERY = 'query($zone:String!,$since:Time!,$until:Time!,$colos:[String!]){viewer{zones(filter:{zoneTag:$zone}){httpRequestsAdaptiveGroups(limit:1000,filter:{datetime_geq:$since,datetime_lt:$until,coloCode_in:$colos,requestSource:"eyeball"}){count dimensions{coloCode edgeResponseStatus originResponseStatus}}}}}';

export function originError(edgeStatus, originStatus) {
  return ORIGIN_ERRORS.has(edgeStatus) || edgeStatus >= 500 && originStatus === 0;
}

// Each run measures the minutes since the previous run's window, so two failing observations
// always mean two separate stretches of traffic. Returns null when no new minute is complete.
export function edgeWindow(probe, previous, now) {
  const end = Math.floor((now - probe.lagSeconds * 1000) / 60000) * 60000;
  const prior = time(previous?.windowEnd);
  const fallback = end - probe.windowSeconds * 1000;
  const start = prior !== null && prior < end && end - prior <= probe.maxWindowSeconds * 1000 ? prior : fallback;
  if (prior !== null && prior >= end) return null;
  return { start, end };
}

export function classifyEdge(probe, rows, window) {
  const mine = rows.filter(row => row?.dimensions?.coloCode === probe.colo && Number.isFinite(row.count) && row.count >= 0);
  const requests = mine.reduce((sum, row) => sum + row.count, 0);
  const errors = mine.filter(row => originError(row.dimensions.edgeResponseStatus, row.dimensions.originResponseStatus)).reduce((sum, row) => sum + row.count, 0);
  const evidence = { observedAt: new Date(window.end).toISOString(), windowStart: new Date(window.start).toISOString(), windowEnd: new Date(window.end).toISOString(), requests, originErrors: errors };
  if (requests < probe.minRequests) return { status: 'unknown', reasonCode: 'low_traffic', ...evidence };
  const share = errors / requests;
  evidence.errorShare = Math.round(share * 10000) / 10000;
  if (errors < probe.minErrors) return { status: 'operational', reasonCode: 'ok', ...evidence };
  if (share >= probe.majorShare) return { status: 'major_outage', reasonCode: 'origin_unreachable', ...evidence };
  if (share >= probe.partialShare) return { status: 'partial_outage', reasonCode: 'origin_unreachable', ...evidence };
  if (share >= probe.degradedShare) return { status: 'degraded', reasonCode: 'origin_unreachable', ...evidence };
  return { status: 'operational', reasonCode: 'ok', ...evidence };
}

// One query per zone covers every location. Missing token, API errors and malformed answers
// are unknown: they never count as up or down.
export async function edgeProbes(probes, previous, env = process.env, now = Date.now(), send = fetch) {
  const result = {};
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN;
  const unknownAt = (reasonCode, window) => ({ status: 'unknown', reasonCode, observedAt: new Date(window.end).toISOString() });
  const zones = new Map();
  for (const probe of probes) {
    const window = edgeWindow(probe, previous?.[probe.id], now);
    if (!window) { result[probe.id] = previous[probe.id]; continue; }
    if (!token) { result[probe.id] = unknownAt('edge_not_configured', window); continue; }
    const key = `${probe.zoneTag}|${window.start}|${window.end}`;
    if (!zones.has(key)) zones.set(key, { zoneTag: probe.zoneTag, window, probes: [] });
    zones.get(key).probes.push(probe);
  }
  for (const { zoneTag, window, probes: members } of zones.values()) {
    let rows = null;
    try {
      const response = await send(ENDPOINT, { method: 'POST', signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: QUERY, variables: { zone: zoneTag, since: new Date(window.start).toISOString(), until: new Date(window.end).toISOString(), colos: members.map(p => p.colo) } }) });
      const body = response.ok ? await response.json() : null;
      const groups = body?.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups;
      if (!body?.errors?.length && Array.isArray(groups)) rows = groups;
    } catch { rows = null; }
    for (const probe of members) result[probe.id] = rows ? classifyEdge(probe, rows, window) : unknownAt('analytics_unavailable', window);
  }
  return result;
}
