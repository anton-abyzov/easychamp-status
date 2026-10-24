import { time, rollup } from '../public/model.mjs';
export const FAILURE_STATUSES = ['degraded', 'partial_outage', 'major_outage'];
export function evidenceIdentity(component) {
  return Object.fromEntries((component?.samples || []).filter(s => s.sourceId && time(s.observedAt) !== null).map(s => [s.sourceId, { observedAt: s.observedAt, status: s.status }]));
}
export function confirmedStatus(counter = {}) {
  if (FAILURE_STATUSES.includes(counter.confirmedStatus)) return counter.confirmedStatus;
  if (!Object.hasOwn(counter, 'confirmedStatus') && counter.bad >= 2) {
    const status = rollup(Object.values(counter.evidence || {}));
    if (FAILURE_STATUSES.includes(status)) return status;
  }
  return null;
}
// Latest failed attempt behind the current failure, or null when any failing
// sample is not a dated scheduled-run failure (destination stale, HTTP, etc.).
function failedAttemptTime(component) {
  const failing = component.samples.filter(s => FAILURE_STATUSES.includes(s.status));
  if (!failing.length || !failing.every(s => s.reasonCode === 'run_failed' && time(s.lastAttemptAt) !== null)) return null;
  return Math.max(...failing.map(s => time(s.lastAttemptAt)));
}
// A success completed after the failed attempt supersedes it, even when the
// destination cannot be verified. Success times later than the sample itself are ignored.
function supersededBySuccess(component, failedAt) {
  if (failedAt === null) return false;
  // Only a sample whose sole gap is the unverifiable destination may clear it;
  // invalid, inactive or in-progress evidence carries unchecked success times.
  return component.samples.some(s => {
    if (s.status !== 'unknown' || s.reasonCode !== 'verification_unavailable') return false;
    const ceiling = time(s.observedAt) + 60000;
    const completed = time(s.lastCompletedSuccessAt);
    const attempt = s.lastAttemptOutcome === 'succeeded' ? time(s.lastAttemptAt) : null;
    return [completed, attempt].some(t => t !== null && t > failedAt && t <= ceiling);
  });
}
// Intermittent availability. The consecutive-observation rule above needs every probe of a
// component, including the 15-minute render check, to fail twice in a row; alternating
// timeouts never satisfy it. This rule reads only distinct, deduplicated HTTP checks:
// FAILURES failed checks among the latest WINDOW checks within SPAN seconds confirm an
// issue. It stays confirmed until CLEAR consecutive known checks pass after the last
// failure; unknown checks neither confirm nor clear it.
export const AVAILABILITY = Object.freeze({ window: 4, failures: 2, span: 1800, clear: 6 });
const SEVERITY = { partial_outage: 1, major_outage: 2 };
export function availabilityState(checks, previous = null, now = Date.now(), rule = AVAILABILITY) {
  const nowSec = Math.floor(now / 1000);
  const sorted = [...checks].filter(c => Number.isInteger(c.at) && c.at <= nowSec + 60).sort((a, b) => a.at - b.at);
  const recent = sorted.filter(c => c.at >= nowSec - rule.span).slice(-rule.window);
  const failing = recent.filter(c => c.code === 'p' || c.code === 'm');
  const lastFailure = sorted.findLastIndex(c => c.code === 'p' || c.code === 'm');
  const passedSince = sorted.slice(lastFailure + 1).filter(c => c.code === 'o' || c.code === 'd').length;
  if (failing.length >= rule.failures) {
    const status = failing.some(c => c.code === 'm') ? 'major_outage' : 'partial_outage';
    const keep = previous?.confirmed && SEVERITY[previous.confirmed] > SEVERITY[status] ? previous.confirmed : status;
    return { confirmed: keep, reasonCode: failing.at(-1).reason || 'http_error', since: previous?.confirmed ? previous.since : new Date(failing[0].at * 1000).toISOString(), failed: failing.length, checked: recent.length };
  }
  if (previous?.confirmed && passedSince < rule.clear) return { ...previous, failed: failing.length, checked: recent.length };
  return { confirmed: null, reasonCode: null, since: null, failed: failing.length, checked: recent.length };
}
// Highest confirmed severity from either rule; this is what owner alerts count.
export function confirmedSeverity(counter = {}) {
  const statuses = [confirmedStatus(counter), counter.availability?.confirmed].filter(s => FAILURE_STATUSES.includes(s));
  return statuses.length ? rollup(statuses.map(status => ({ status }))) : null;
}
export function recordObservation(component, previous = { bad: 0, good: 0 }) {
  const evidence = evidenceIdentity(component);
  const old = previous.evidence || {};
  const confirmed = confirmedStatus(previous);
  // Every required check must have advanced. A cached render or destination sample
  // cannot be counted again when an unrelated HTTP probe advances.
  const isNew = component.samples.length > 0 && component.samples.every(s => s.sourceId && time(s.observedAt) !== null && (!old[s.sourceId] || time(s.observedAt) > time(old[s.sourceId].observedAt)));
  if (!isNew) return { isNew: false, counter: component.status === 'unknown' ? { ...previous, bad: 0, good: 0, confirmedStatus: confirmed } : previous };
  const failing = FAILURE_STATUSES.includes(component.status);
  const bad = failing ? (previous.bad || 0) + 1 : 0;
  const good = component.status === 'operational' ? (previous.good || 0) + 1 : 0;
  // Keep the highest confirmed severity until actual recovery. A lesser failure
  // must not close an outage alert while its incident is still unresolved.
  let nextConfirmed = bad >= 2 ? rollup([{ status: confirmed || component.status }, { status: component.status }]) : good >= 2 ? null : confirmed;
  const prior = time(previous.failedAttemptAt);
  let failedAt = prior;
  if (failing) {
    const current = failedAttemptTime(component);
    failedAt = current === null ? null : bad >= 2 && !confirmed ? current : prior === null && confirmed ? null : Math.max(prior ?? current, current);
  }
  // A scheduled job whose destination cannot be verified never reports operational,
  // so a run_failed confirmation would otherwise latch forever after the job recovers.
  if (nextConfirmed && component.status === 'unknown' && supersededBySuccess(component, failedAt)) nextConfirmed = null;
  if (!nextConfirmed) failedAt = null;
  return { isNew: true, counter: { evidence, bad, good, confirmedStatus: nextConfirmed, failedAttemptAt: failedAt === null ? null : new Date(failedAt).toISOString() } };
}
