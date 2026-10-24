import { time } from '../public/model.mjs';
import { CODE, appendSample, prune } from '../public/uptime.mjs';

// Seconds a single check may stand for. These equal the evidence expiry the page already
// uses (HTTP 15 min, rendering 35 min, collector 20 min); longer silences are gaps.
export const CAPS = { http: 900, browser: 2100, freshness: 1200 };
export const RETENTION_DAYS = 35;

export function emptyTimeline() { return { schemaVersion: 1, caps: CAPS, retentionDays: RETENTION_DAYS, series: {} }; }

export function seriesKinds(registry) {
  const kinds = {};
  for (const probe of registry.probes) kinds[probe.id] = probe.type === 'browser' ? 'browser' : 'http';
  for (const component of registry.components) if (component.freshness) kinds[component.id] = 'freshness';
  return kinds;
}

function sampleOf(evidence) {
  const at = time(evidence?.observedAt);
  if (at === null || !Object.hasOwn(CODE, evidence.status)) return null;
  return { at: Math.floor(at / 1000), code: CODE[evidence.status], reason: evidence.reasonCode };
}

// Appends every check that is newer than the series' last check. Returns the ids that advanced.
export function recordTimeline(timeline, registry, state, view, now = Date.now()) {
  if (timeline?.schemaVersion !== 1 || !timeline.series || typeof timeline.series !== 'object') timeline = emptyTimeline();
  timeline.caps = CAPS; timeline.retentionDays = RETENTION_DAYS;
  const kinds = seriesKinds(registry), advanced = [];
  const nowSec = Math.floor(now / 1000);
  for (const [id, kind] of Object.entries(kinds)) {
    const evidence = kind === 'freshness' ? view.components.find(c => c.id === id)?.samples?.[0] : state.probes?.[id];
    const sample = sampleOf(evidence);
    // Evidence dated in the future is invalid and never enters the record.
    if (!sample || sample.at > nowSec + 60) continue;
    if (appendSample(timeline.series[id] ||= [], sample, CAPS[kind])) advanced.push(id);
  }
  const cutoff = nowSec - RETENTION_DAYS * 86400;
  for (const [id, series] of Object.entries(timeline.series)) {
    if (!kinds[id]) { delete timeline.series[id]; continue; }
    prune(series, cutoff, CAPS[kinds[id]]);
  }
  return { timeline, advanced };
}

// One series per line keeps the committed history readable and the diff per run small.
export function serializeTimeline(timeline) {
  const ids = Object.keys(timeline.series).sort();
  const body = ids.map(id => `    ${JSON.stringify(id)}: ${JSON.stringify(timeline.series[id])}`).join(',\n');
  return `{\n  "schemaVersion": 1,\n  "caps": ${JSON.stringify(timeline.caps)},\n  "retentionDays": ${timeline.retentionDays},\n  "series": {\n${body}\n  }\n}\n`;
}
