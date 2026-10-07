import { time } from '../public/model.mjs';
export function evidenceIdentity(component) {
  return Object.fromEntries(component.samples.filter(s => s.sourceId && time(s.observedAt) !== null).map(s => [s.sourceId, { observedAt: s.observedAt, status: s.status }]));
}
export function recordObservation(component, previous = { bad: 0, good: 0 }) {
  const evidence = evidenceIdentity(component);
  const old = previous.evidence || {};
  // Every required check must have advanced. A cached render or destination sample
  // cannot be counted again when an unrelated HTTP probe advances.
  const isNew = component.samples.length > 0 && component.samples.every(s => s.sourceId && time(s.observedAt) !== null && (!old[s.sourceId] || time(s.observedAt) > time(old[s.sourceId].observedAt)));
  if (!isNew) return { isNew: false, counter: component.status === 'unknown' ? { ...previous, bad: 0, good: 0 } : previous };
  const bad = ['degraded', 'partial_outage', 'major_outage'].includes(component.status);
  return { isNew: true, counter: { evidence, bad: bad ? previous.bad + 1 : 0, good: component.status === 'operational' ? previous.good + 1 : 0 } };
}
