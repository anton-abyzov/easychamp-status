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
export function recordObservation(component, previous = { bad: 0, good: 0 }) {
  const evidence = evidenceIdentity(component);
  const old = previous.evidence || {};
  const confirmed = confirmedStatus(previous);
  // Every required check must have advanced. A cached render or destination sample
  // cannot be counted again when an unrelated HTTP probe advances.
  const isNew = component.samples.length > 0 && component.samples.every(s => s.sourceId && time(s.observedAt) !== null && (!old[s.sourceId] || time(s.observedAt) > time(old[s.sourceId].observedAt)));
  if (!isNew) return { isNew: false, counter: component.status === 'unknown' ? { ...previous, bad: 0, good: 0, confirmedStatus: confirmed } : previous };
  const bad = FAILURE_STATUSES.includes(component.status) ? (previous.bad || 0) + 1 : 0;
  const good = component.status === 'operational' ? (previous.good || 0) + 1 : 0;
  // Keep the highest confirmed severity until actual recovery. A lesser failure
  // must not close an outage alert while its incident is still unresolved.
  const nextConfirmed = bad >= 2 ? rollup([{ status: confirmed || component.status }, { status: component.status }]) : good >= 2 ? null : confirmed;
  return { isNew: true, counter: { evidence, bad, good, confirmedStatus: nextConfirmed } };
}
