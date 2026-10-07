import { time, LABELS, REASONS } from '../public/model.mjs';
import { normalizeIncidents, safeText, safePublicUrl } from '../public/incident-model.mjs';
import { FAILURE_STATUSES } from './observations.mjs';

export function incidentDocument(payload) {
  if (payload?.schemaVersion !== 1 || !Array.isArray(payload.incidents)) throw new Error('invalid_incident_document');
  const incidents = normalizeIncidents(payload);
  if (incidents.length !== payload.incidents.length || new Set(incidents.map(row => row.id)).size !== incidents.length) throw new Error('invalid_incident_records');
  const open = incidents.filter(row => !row.resolvedAt);
  if (new Set(open.map(row => row.componentId)).size !== open.length) throw new Error('duplicate_open_incidents');
  return { schemaVersion: 1, incidents };
}
export function seedConfirmedIncidents(counters, payload) {
  for (const incident of normalizeIncidents(payload).filter(row => !row.resolvedAt)) {
    const counter = counters[incident.componentId] ||= { bad: 0, good: 0 };
    if (!Object.hasOwn(counter, 'confirmedStatus')) counter.confirmedStatus = incident.status;
  }
}
export function postmortemDraft(incident, at = incident.resolvedAt) {
  const durationMinutes = Math.max(0, Math.round((time(incident.resolvedAt) - time(incident.openedAt)) / 60000));
  return { state: 'draft', generatedAt: at, summary: `Automated evidence-only draft. ${incident.title}. First confirmed issue: ${incident.openedAt}. Recovery confirmed by two fresh successful observations: ${incident.resolvedAt}. Confirmed incident duration: ${durationMinutes} minutes. Root cause, user impact, remediation and prevention require owner review; the monitor has not established them.` };
}
export function appendIncidentUpdate(incident, { stage, at, message, source = 'monitor', author, evidence, id }) {
  const updateId = id || `${incident.id}-${source}-${at}-${stage}`;
  if (incident.updates.some(update => update.id === updateId)) return false;
  incident.updates.push({ id: updateId, stage, at, message, source, ...(author ? { author } : {}), ...(evidence ? { evidence } : {}) });
  incident.updates.sort((a, b) => time(a.at) - time(b.at));
  incident.stage = stage;
  incident.updatedAt = at;
  return true;
}
export function advanceIncidents(payload, component, observation, at) {
  payload.schemaVersion = 1;
  payload.incidents = incidentDocument(payload).incidents;
  if (!observation.isNew) return;
  const open = payload.incidents.find(incident => incident.componentId === component.id && !incident.resolvedAt);
  const evidence = { status: component.status, reasonCode: component.reasonCode, observedAt: component.observedAt };
  if (FAILURE_STATUSES.includes(component.status) && observation.counter.bad >= 2) {
    if (!open) {
      const latency = ['slow', 'rendering_slow'].includes(component.reasonCode);
      const incident = { id: `${component.id}-${time(at)}`, componentId: component.id, title: `${component.name}: ${component.status === 'degraded' ? (latency ? 'degraded performance' : 'degraded service') : 'availability issue'}`, status: component.status, reasonCode: component.reasonCode, openedAt: at, updatedAt: at, resolvedAt: null, stage: 'investigating', updates: [] };
      const deadline = component.samples.find(sample => time(sample.nextDueAt) !== null)?.nextDueAt;
      if (deadline) incident.deadlineAt = new Date(time(deadline)).toISOString();
      appendIncidentUpdate(incident, { stage: 'investigating', at, message: `Two fresh observations confirmed ${LABELS[component.status].toLowerCase()}: ${REASONS[component.reasonCode] || REASONS.invalid_evidence}.`, evidence });
      payload.incidents.unshift(incident);
    } else {
      const changed = open.status !== component.status || open.reasonCode !== component.reasonCode;
      open.status = component.status;
      open.reasonCode = component.reasonCode;
      if (changed || open.stage === 'monitoring') appendIncidentUpdate(open, { stage: open.stage === 'monitoring' ? 'investigating' : open.stage, at, message: `Fresh observations continue to confirm ${LABELS[component.status].toLowerCase()}: ${REASONS[component.reasonCode] || REASONS.invalid_evidence}.`, evidence });
      else open.updatedAt = at;
    }
  } else if (open && component.status === 'operational') {
    if (observation.counter.good >= 2) {
      open.resolvedAt = at;
      appendIncidentUpdate(open, { stage: 'resolved', at, message: 'Two fresh successful observations confirmed recovery.', evidence });
      open.postmortem = postmortemDraft(open, at);
    } else appendIncidentUpdate(open, { stage: 'monitoring', at, message: 'One fresh successful observation received. The incident remains open pending a second fresh successful observation.', evidence });
  } else if (open && ['unknown', 'maintenance'].includes(component.status)) {
    const last = open.updates.at(-1);
    if (last?.evidence?.status !== component.status || last?.evidence?.reasonCode !== component.reasonCode) appendIncidentUpdate(open, { stage: open.stage, at, message: `Latest evidence is ${LABELS[component.status].toLowerCase()}: ${REASONS[component.reasonCode] || REASONS.invalid_evidence}. The incident remains open; recovery is unconfirmed.`, evidence });
  }
}
export function applyOwnerUpdate(payload, input, context) {
  const incidents = incidentDocument(payload).incidents;
  const incident = incidents.find(row => row.id === input.incidentId);
  if (!incident) throw new Error('incident_not_found');
  if (!['identified', 'monitoring', 'writeup_published'].includes(input.stage) || !safeText(input.message)) throw new Error('invalid_owner_update');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(context.login || '') || time(context.at) === null || time(context.at) < time(incident.updatedAt)) throw new Error('invalid_owner_context');
  if (incident.resolvedAt && input.stage !== 'writeup_published') throw new Error('resolved_incident_immutable');
  const url = input.stage === 'writeup_published' ? safePublicUrl(input.url) : null;
  if (input.stage === 'writeup_published' && (!incident.resolvedAt || !url)) throw new Error('published_writeup_requires_resolved_incident_and_safe_url');
  if (input.stage !== 'writeup_published' && input.url) throw new Error('unexpected_writeup_url');
  if (incident.updates.some(update => update.id === context.updateId)) return { schemaVersion: 1, incidents };
  const last = incident.updates.at(-1);
  if (last?.id === context.updateId || (last?.source === 'owner' && last.stage === input.stage && last.message === input.message.trim() && (input.stage !== 'writeup_published' || incident.postmortem?.url === url))) return { schemaVersion: 1, incidents };
  appendIncidentUpdate(incident, { stage: input.stage, at: context.at, message: input.message.trim(), source: 'owner', author: { login: context.login }, id: context.updateId });
  if (input.stage === 'writeup_published') incident.postmortem = { ...(incident.postmortem || postmortemDraft(incident)), state: 'published', summary: input.message.trim(), url, publishedAt: context.at };
  return { schemaVersion: 1, incidents };
}
