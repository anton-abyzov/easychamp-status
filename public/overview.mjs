// The above-the-fold summary: what is broken now, since when, and how much downtime
// the core services had. Pure helpers are exported for tests; rendering stays in app.mjs.
import { intervals, summarize, combine, recentChecks, DOWN } from './uptime.mjs';
import { time } from './model.mjs';

export const DAY = 86400;

export function minutes(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}
export function percent(ratio) {
  if (ratio === null || !Number.isFinite(ratio)) return 'No data';
  const p = ratio * 100;
  return p >= 99.995 ? '100%' : `${p >= 99 ? p.toFixed(2) : p.toFixed(1)}%`;
}

export function httpProbeOf(component, registry) {
  return (component.probes || []).find(id => registry.probes.find(p => p.id === id)?.type === 'http') || null;
}

export function serviceUptime(component, registry, uptime, nowSec) {
  const probe = httpProbeOf(component, registry);
  const series = probe ? uptime?.series?.[probe] : null;
  if (!series) return null;
  const list = intervals(series, uptime.caps?.http || 900, nowSec);
  const checks = recentChecks(series, 4);
  return {
    probe, list, checks,
    day: summarize(list, nowSec - DAY, nowSec),
    week: summarize(list, nowSec - 7 * DAY, nowSec),
    recentFailures: recentChecks(series, 12).filter(c => c.at >= nowSec - 1800 && DOWN.has(c.code)).length,
    // Time of the last failed check itself, not the end of the time it stands for.
    lastFailedAt: [...series].reverse().find(segment => DOWN.has(segment[2]))?.[1] ?? null,
  };
}

// Plain-language state of one service right now. Availability comes from the HTTP check;
// a rendering check can only add "slow". An unavailable rendering check does not hide a
// passing HTTP check, and never turns a failure into a pass.
export function serviceNow(component, stats, openIncident) {
  const http = component.samples?.find(s => s.sourceId === stats?.probe) || null;
  const others = (component.samples || []).filter(s => s !== http);
  const availability = http ? http.status : component.status;
  if (availability === 'major_outage' || availability === 'partial_outage' || others.some(s => s.status === 'major_outage' || s.status === 'partial_outage')) return { key: 'down', label: 'Down', status: 'major_outage' };
  if ((openIncident && ['major_outage', 'partial_outage'].includes(openIncident.status)) || stats?.recentFailures) return { key: 'intermittent', label: 'Failing on and off', status: 'partial_outage' };
  const slow = [http, ...others].find(s => s?.status === 'degraded');
  if (availability === 'operational' && slow) return { key: 'slow', label: ['slow', 'rendering_slow'].includes(slow.reasonCode) ? 'Slow' : slow.reasonCode === 'rendering_incomplete' ? 'Images slow' : 'Degraded', status: 'degraded' };
  if (availability === 'degraded') return { key: 'slow', label: ['slow', 'rendering_slow'].includes(http?.reasonCode) ? 'Slow' : 'Degraded', status: 'degraded' };
  if (availability === 'operational') return { key: 'up', label: 'Up', status: 'operational' };
  if (availability === 'maintenance') return { key: 'maintenance', label: 'Maintenance', status: 'maintenance' };
  return { key: 'unknown', label: 'Unknown', status: 'unknown' };
}

const joinNames = names => names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

export function verdict({ rows, collectorStale, apps, generatedAt, incidents, nowMs }) {
  if (collectorStale) return { status: 'unknown', title: 'Status checks are not running', description: `The latest check finished ${ago(generatedAt, nowMs)}. Current availability is unknown until checks resume.` };
  const pick = key => rows.filter(r => r.now.key === key).map(r => r.name);
  const down = pick('down'), flaky = pick('intermittent'), slow = pick('slow').concat(pick('degraded'));
  const open = incidents.filter(i => !i.resolvedAt && rows.some(r => r.id === i.componentId));
  const since = open.length ? Math.min(...open.map(i => time(i.openedAt)).filter(Boolean)) : null;
  const sinceText = since ? ` Issue open since ${clock(since)}, ${minutes((nowMs - since) / 1000)} ago.` : '';
  if (down.length) return { status: 'major_outage', title: `${joinNames(down)} ${down.length === 1 ? 'is' : 'are'} down`, description: `The latest checks failed.${flaky.length ? ` ${joinNames(flaky)} also failing on and off.` : ''}${sinceText}` };
  if (flaky.length) {
    const failed = rows.filter(r => r.now.key === 'intermittent').reduce((n, r) => n + (r.stats?.recentFailures || 0), 0);
    return { status: 'partial_outage', title: `${joinNames(flaky)} ${flaky.length === 1 ? 'is' : 'are'} failing on and off`, description: `${failed ? `${failed} failed ${failed === 1 ? 'check' : 'checks'} in the last 30 minutes; other checks passed.` : 'The latest checks passed. The issue closes after six checks in a row pass.'}${sinceText}` };
  }
  if (slow.length) return { status: 'degraded', title: `${joinNames(slow)} ${slow.length === 1 ? 'is' : 'are'} slow`, description: `Pages answer, but slower than their targets.${sinceText}` };
  const unknown = pick('unknown');
  const appIssues = apps.filter(r => r.now.key !== 'up' && r.now.key !== 'unknown').map(r => `${r.name} ${r.now.label.toLowerCase()}`);
  if (unknown.length === rows.length) return { status: 'unknown', title: 'Core service status is unknown', description: 'No current checks are available for the core services.' };
  // Only claim a clean record for the time the minute history actually covers.
  const last = rows.map(r => r.stats?.lastFailedAt).filter(Boolean);
  const firsts = rows.map(r => r.stats?.list?.[0]?.start).filter(Number.isFinite);
  const lastText = last.length ? ` Last failed check ${ago(new Date(Math.max(...last) * 1000).toISOString(), nowMs)}.`
    : firsts.length < rows.length ? ' Minute history is not available for every service.'
    : ` No failed checks recorded since ${new Date(Math.max(Math.max(...firsts) * 1000, nowMs - 8 * DAY * 1000)).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}.`;
  return { status: 'operational', title: unknown.length ? 'Checked core services are up' : 'All core services are up', description: `${unknown.length ? `${joinNames(unknown)} could not be checked.` : 'The latest checks passed.'}${appIssues.length ? ` ${appIssues.join(', ')}.` : ''}${lastText}` };
}

export function coreTotals(rows, nowSec) {
  const lists = rows.map(r => r.stats?.list).filter(Boolean);
  if (!lists.length) return null;
  const all = combine(lists);
  // Coverage is per service: the least-checked core service, so one unchecked service is
  // never hidden by the others being checked.
  const coverage = rows.map(r => ({ name: r.name, coverage: r.stats?.week.coverage ?? 0, uncheckedSec: r.stats ? r.stats.week.uncoveredSec + r.stats.week.u : 7 * DAY }))
    .sort((a, b) => a.coverage - b.coverage)[0];
  return { day: summarize(all, nowSec - DAY, nowSec), week: summarize(all, nowSec - 7 * DAY, nowSec), coverage };
}

export function clock(ms) { return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); }
export function ago(at, nowMs = Date.now()) {
  const t = time(at); if (t === null) return 'at an unknown time';
  const m = Math.max(0, Math.floor((nowMs - t) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} days ago`;
}
