import { time, STATUSES, REASONS } from './model.mjs';

export const INCIDENT_STAGES = ['investigating', 'identified', 'monitoring', 'resolved', 'writeup_published'];
export const STAGE_LABELS = { investigating: 'Investigating', identified: 'Identified', monitoring: 'Monitoring', resolved: 'Resolved', writeup_published: 'Write-up published' };
export const incidentId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,159}$/.test(value);
export const safeText = (value, max = 1200) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f<>]/.test(value) && !/(?:gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|SG\.[\w-]{20,}|NR(?:AK|AL|II)-[\w-]{16,}|AKIA[A-Z0-9]{16}|AIza[\w-]{30,}|ya29\.[\w-]{20,}|BEGIN (?:[A-Z ]+ )?PRIVATE KEY|BEGIN CERTIFICATE|Bearer\s+\S+|(?:password|api[_-]?key|token|secret)\s*[=:]\s*\S+|svc\.cluster\.local|[a-z][a-z0-9+.-]*:\/\/[^\s/]*@)/i.test(value);
export function safePublicUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (!url.hostname.includes('.') || /(?:^|\.)(?:localhost|internal|local|test|invalid)$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) return null;
    if ([...url.searchParams.keys()].some(key => /token|secret|password|key|auth/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}
const date = value => typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || time(value) === null ? null : new Date(time(value)).toISOString();
const login = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(value);
export function normalizeIncident(input) {
  if (!input || !incidentId(input.id) || !incidentId(input.componentId) || !safeText(input.title, 240) || !date(input.openedAt)) return null;
  const openedAt = date(input.openedAt);
  const resolvedAt = date(input.resolvedAt);
  if (input.resolvedAt != null && !resolvedAt) return null;
  if (resolvedAt && time(resolvedAt) < time(openedAt)) return null;
  const updates = (Array.isArray(input.updates) ? input.updates : []).filter(update => update && typeof update.id === 'string' && update.id.length <= 240 && INCIDENT_STAGES.includes(update.stage) && date(update.at) && time(update.at) >= time(openedAt) && safeText(update.message) && ['monitor', 'owner'].includes(update.source)).map(update => ({ id: update.id, stage: update.stage, at: date(update.at), message: update.message, source: update.source, ...(update.source === 'owner' && login(update.author?.login) ? { author: { login: update.author.login } } : {}), ...(STATUSES.includes(update.evidence?.status) && Object.hasOwn(REASONS, update.evidence?.reasonCode) && date(update.evidence?.observedAt) ? { evidence: { status: update.evidence.status, reasonCode: update.evidence.reasonCode, observedAt: date(update.evidence.observedAt) } } : {}) }));
  if (!updates.some(update => update.stage === 'investigating')) updates.unshift({ id: `${input.id}-legacy-open`, stage: 'investigating', at: openedAt, message: 'The monitor confirmed a service issue. Earlier detailed observations are unavailable.', source: 'monitor' });
  if (resolvedAt && !updates.some(update => update.stage === 'resolved')) updates.push({ id: `${input.id}-legacy-resolved`, stage: 'resolved', at: resolvedAt, message: 'Recovery was recorded by the monitor. Earlier detailed recovery observations are unavailable.', source: 'monitor' });
  updates.sort((a, b) => time(a.at) - time(b.at));
  const postmortem = input.postmortem && ['draft', 'published'].includes(input.postmortem.state) && safeText(input.postmortem.summary, 3000) ? { state: input.postmortem.state, summary: input.postmortem.summary, generatedAt: date(input.postmortem.generatedAt) || resolvedAt, ...(input.postmortem.state === 'published' && safePublicUrl(input.postmortem.url) ? { url: safePublicUrl(input.postmortem.url), publishedAt: date(input.postmortem.publishedAt) } : {}) } : undefined;
  if (postmortem?.state === 'published' && (!postmortem.url || !resolvedAt || !postmortem.publishedAt || time(postmortem.publishedAt) < time(resolvedAt))) { postmortem.state = 'draft'; delete postmortem.url; delete postmortem.publishedAt; }
  const stage = resolvedAt ? (postmortem?.state === 'published' ? 'writeup_published' : 'resolved') : ['investigating', 'identified', 'monitoring'].includes(input.stage) ? input.stage : 'investigating';
  const number = input.issue?.number;
  const issueUrl = safePublicUrl(input.issue?.url);
  const issue = Number.isSafeInteger(number) && number > 0 && issueUrl ? { number, url: issueUrl } : undefined;
  return { id: input.id, componentId: input.componentId, title: input.title, status: ['degraded', 'partial_outage', 'major_outage'].includes(input.status) ? input.status : 'degraded', reasonCode: Object.hasOwn(REASONS, input.reasonCode) ? input.reasonCode : 'invalid_evidence', openedAt, updatedAt: new Date(Math.max(time(openedAt), time(input.updatedAt) || 0, ...updates.map(update => time(update.at)))).toISOString(), resolvedAt, ...(date(input.deadlineAt) ? { deadlineAt: date(input.deadlineAt) } : {}), stage, updates, ...(postmortem ? { postmortem } : {}), ...(issue ? { issue } : {}) };
}
export function normalizeIncidents(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.incidents;
  return (Array.isArray(rows) ? rows : []).map(normalizeIncident).filter(Boolean);
}
