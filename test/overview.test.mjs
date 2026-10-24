import test from 'node:test';
import assert from 'node:assert/strict';
import { minutes, percent, serviceNow, serviceUptime, verdict, coreTotals } from '../public/overview.mjs';

test('durations and percentages read plainly and never claim 100% without evidence', () => {
  assert.equal(minutes(0), '0 min'); assert.equal(minutes(89), '1 min'); assert.equal(minutes(3600), '1 h'); assert.equal(minutes(3720), '1 h 2 min');
  assert.equal(percent(null), 'No data'); assert.equal(percent(NaN), 'No data');
  assert.equal(percent(0.99996), '100%'); assert.equal(percent(0.9995), '99.95%'); assert.equal(percent(0.9), '90.0%');
});

const sample = (sourceId, status, reasonCode = status === 'operational' ? 'ok' : 'timeout') => ({ sourceId, status, reasonCode });
const web = (http, render) => ({ id: 'web', name: 'Web', status: 'unknown', samples: [sample('web-http', ...http), ...(render ? [sample('web-render', ...render)] : [])] });
const stats = (recentFailures = 0) => ({ probe: 'web-http', recentFailures });

test('availability comes from the HTTP check; rendering can only add slowness or a hard failure', () => {
  assert.equal(serviceNow(web(['operational'], ['unknown', 'browser_unavailable']), stats()).key, 'up', 'a missing render check does not hide a passing HTTP check');
  assert.equal(serviceNow(web(['partial_outage']), stats()).key, 'down');
  assert.equal(serviceNow(web(['operational'], ['degraded', 'rendering_slow']), stats()).label, 'Slow');
  assert.equal(serviceNow(web(['operational'], ['degraded', 'rendering_incomplete']), stats()).label, 'Images slow');
  assert.equal(serviceNow(web(['operational']), stats(1)).key, 'intermittent', 'a failed check in the last 30 minutes shows as failing on and off');
  assert.equal(serviceNow(web(['operational']), stats(), { status: 'partial_outage' }).key, 'intermittent', 'an open availability incident stays visible between failures');
  assert.equal(serviceNow(web(['unknown', 'stale']), stats()).key, 'unknown');
  assert.equal(serviceNow(web(['maintenance', 'inactive']), stats()).key, 'maintenance');
});

const NOW = Date.parse('2026-10-23T16:00:00Z'), nowSec = NOW / 1000;
const row = (name, key, extra = {}) => ({ id: name.toLowerCase(), name, now: { key, label: key }, stats: { recentFailures: key === 'intermittent' ? 2 : 0, lastFailedAt: null }, ...extra });

test('the headline names what is broken first, then what is flaky or slow, and never guesses', () => {
  const at = new Date(NOW - 60000).toISOString();
  assert.equal(verdict({ rows: [row('Console', 'up')], apps: [], collectorStale: true, generatedAt: new Date(NOW - 45 * 60000).toISOString(), incidents: [], nowMs: NOW }).title, 'Status checks are not running');
  const down = verdict({ rows: [row('Console', 'down'), row('Watch', 'intermittent'), row('Home', 'up')], apps: [], generatedAt: at, incidents: [], nowMs: NOW });
  assert.equal(down.title, 'Console is down'); assert.equal(down.status, 'major_outage'); assert.match(down.description, /Watch also failing on and off/);
  const flaky = verdict({ rows: [row('Console', 'intermittent'), row('Watch', 'intermittent'), row('Home', 'up')], apps: [], generatedAt: at, incidents: [{ componentId: 'console', openedAt: new Date(NOW - 20 * 60000).toISOString(), resolvedAt: null }], nowMs: NOW });
  assert.equal(flaky.title, 'Console and Watch are failing on and off'); assert.match(flaky.description, /^4 failed checks in the last 30 minutes/); assert.match(flaky.description, /20 min ago/);
  const quiet = verdict({ rows: [row('Console', 'intermittent', { stats: { recentFailures: 0 } })], apps: [], generatedAt: at, incidents: [{ componentId: 'console', openedAt: new Date(NOW - 40 * 60000).toISOString(), resolvedAt: null }], nowMs: NOW });
  assert.equal(quiet.description, `The latest checks passed. The issue closes after six checks in a row pass. Issue open since ${new Date(NOW - 40 * 60000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}, 40 min ago.`, 'never reports 0 failed checks as a failure count');
  assert.equal(verdict({ rows: [row('Console', 'slow'), row('Home', 'up')], apps: [], generatedAt: at, incidents: [], nowMs: NOW }).title, 'Console is slow');
  assert.equal(verdict({ rows: [row('Console', 'unknown')], apps: [], generatedAt: at, incidents: [], nowMs: NOW }).status, 'unknown');
  const partial = verdict({ rows: [row('Console', 'up'), row('Watch', 'unknown')], apps: [row('Coach', 'slow', { now: { key: 'slow', label: 'Slow' } })], generatedAt: at, incidents: [], nowMs: NOW });
  assert.equal(partial.title, 'Checked core services are up'); assert.match(partial.description, /Watch could not be checked\. Coach slow\./);
  const clean = verdict({ rows: [row('Console', 'up')], apps: [], generatedAt: at, incidents: [], nowMs: NOW });
  assert.equal(clean.title, 'All core services are up'); assert.match(clean.description, /Minute history is not available for every service\.$/, 'no clean-record claim without minute history');
  const covered = row('Console', 'up'); covered.stats.list = [{ start: NOW / 1000 - 7200, end: NOW / 1000, code: 'o', n: 24 }];
  assert.match(verdict({ rows: [covered], apps: [], generatedAt: at, incidents: [], nowMs: NOW }).description, /No failed checks recorded since October 23\.$/, 'the claim names the start of the recorded history');
});

test('service and core totals come from the HTTP series only and report gaps as unchecked', () => {
  const registry = { probes: [{ id: 'a-http', type: 'http' }, { id: 'a-render', type: 'browser' }, { id: 'b-http', type: 'http' }] };
  const uptime = { schemaVersion: 1, caps: { http: 900 }, series: {
    'a-http': [[nowSec - 3600, nowSec - 1200, 'o', 9], [nowSec - 900, nowSec - 600, 'p', 2, 'timeout'], [nowSec - 300, nowSec - 300, 'o', 1]],
    'a-render': [[nowSec - 3600, nowSec - 300, 'p', 9, 'rendering_slow']],
    'b-http': [[nowSec - 3600, nowSec - 300, 'o', 12]],
  } };
  const a = serviceUptime({ probes: ['a-render', 'a-http'] }, registry, uptime, nowSec);
  assert.equal(a.probe, 'a-http');
  assert.equal(a.day.downSec, 600); assert.equal(a.day.sustainedDownSec, 600); assert.equal(a.day.failedChecks, 2);
  assert.equal(a.recentFailures, 2); assert.equal(a.lastFailedAt, nowSec - 600, 'the failed check time, not the end of its coverage');
  assert.equal(a.day.uncoveredSec, 86400 - 3600, 'time before the first check is unchecked, not up');
  assert.equal(serviceUptime({ probes: ['missing'] }, registry, uptime, nowSec), null);
  const b = serviceUptime({ probes: ['b-http'] }, registry, uptime, nowSec);
  const totals = coreTotals([{ stats: a }, { stats: b }, { stats: null }], nowSec);
  assert.equal(totals.day.downSec, 600); assert.equal(totals.week.knownSec, 3600);
  assert.equal(coreTotals([{ stats: null }], nowSec), null);
});
