import { STATUSES, REASONS, time, validTime } from '../public/model.mjs';
const DATES = ['observedAt', 'lastCompletedSuccessAt', 'lastDestinationVerifiedAt', 'nextDueAt', 'lastAttemptAt', 'lastAttemptStartedAt'];
const METRIC_FIELDS = ['cpuUtilizationPct', 'memoryUtilizationPct', 'diskUtilizationPct', 'nodesReady', 'nodesTotal'];
const COVERAGE = ['node_readiness', 'cpu', 'memory', 'disk'];
const KIND = ['destination_validation', 'scheduled_run', 'cluster_resources'];
const OUTCOMES = ['succeeded', 'failed', 'running', 'unknown'];
const VERIFICATION = ['verified', 'unavailable', 'stale'];
const ZONES = ['UTC', 'Etc/UTC', 'America/New_York'];
const finite = (value, maximum, integral = false) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum && (!integral || Number.isInteger(value));
export function sanitizeFreshness(raw, component, now = Date.now()) {
  const kind = component.measurementKind || 'destination_validation';
  const invalid = () => ({ id: component.id, status: 'unknown', reasonCode: 'invalid_evidence', observedAt: new Date(now).toISOString(), measurementKind: kind, lastCompletedSuccessAt:null, lastDestinationVerifiedAt:null, nextDueAt:null, graceSeconds:0, lastAttemptAt:null, lastAttemptStartedAt:null, lastAttemptDeadlineSeconds:null, lastAttemptOutcome:'unknown', destinationVerification:'unavailable', suspended:null, schedule:null, timeZone:null, metrics:null });
  if (!raw || raw.id !== component.id || !STATUSES.includes(raw.status) || !Object.hasOwn(REASONS, raw.reasonCode) || !validTime(raw.observedAt, now) || !KIND.includes(kind)) return invalid();
  const safe = { id: component.id, status: raw.status, reasonCode: raw.reasonCode, measurementKind: kind };
  for (const field of DATES) {
    if (raw[field] !== undefined && raw[field] !== null && (typeof raw[field] !== 'string' || time(raw[field]) === null)) return invalid();
    safe[field] = time(raw[field]) === null ? null : new Date(time(raw[field])).toISOString();
    if (field !== 'nextDueAt' && safe[field] && (time(safe[field]) > now + 60000 || time(safe[field]) > time(raw.observedAt) + 60000)) return invalid();
  }
  if (!finite(raw.graceSeconds, component.maxGraceSeconds ?? 86400, true)) return invalid();
  safe.graceSeconds = raw.graceSeconds;
  if (raw.measurementKind !== undefined && raw.measurementKind !== kind) return invalid();
  for (const [field, values, fallback] of [['lastAttemptOutcome', OUTCOMES, 'unknown'], ['destinationVerification', VERIFICATION, 'unavailable']]) {
    if (raw[field] !== undefined && !values.includes(raw[field])) return invalid();
    safe[field] = raw[field] ?? fallback;
  }
  if (safe.lastAttemptOutcome !== 'unknown' && !safe.lastAttemptAt) return invalid();
  if (safe.lastAttemptStartedAt && (!safe.lastAttemptAt || time(safe.lastAttemptStartedAt) < time(safe.lastAttemptAt))) return invalid();
  if (raw.lastAttemptDeadlineSeconds != null && (!finite(raw.lastAttemptDeadlineSeconds, 86400, true) || raw.lastAttemptDeadlineSeconds < 1)) return invalid();
  safe.lastAttemptDeadlineSeconds = raw.lastAttemptDeadlineSeconds ?? null;
  if (raw.suspended !== undefined && raw.suspended !== null && typeof raw.suspended !== 'boolean') return invalid();
  safe.suspended = raw.suspended ?? null;
  if (raw.schedule !== undefined && raw.schedule !== null && (typeof raw.schedule !== 'string' || raw.schedule.length > 80 || !/^[0-9*/,-]+(?: [0-9*/,-]+){4}$/.test(raw.schedule))) return invalid();
  if (raw.timeZone !== undefined && raw.timeZone !== null && !ZONES.includes(raw.timeZone)) return invalid();
  safe.schedule = raw.schedule ?? null; safe.timeZone = raw.timeZone ?? null;
  if (component.schedule && safe.schedule && component.schedule !== safe.schedule || component.timeZone && safe.timeZone && component.timeZone !== safe.timeZone) return invalid();
  safe.metrics = null;
  if (kind === 'cluster_resources' && raw.metrics !== undefined && raw.metrics !== null) {
    const m = raw.metrics;
    if (typeof m !== 'object' || Array.isArray(m)) return invalid();
    const sampleAt = time(m.sampleAt);
    const metrics = { sampleAt: sampleAt === null ? null : new Date(sampleAt).toISOString() };
    for (const field of METRIC_FIELDS) metrics[field] = finite(m[field], field.startsWith('nodes') ? 1000 : 100, field.startsWith('nodes')) ? m[field] : null;
    metrics.coverage = Array.isArray(m.coverage) && m.coverage.length <= 4 ? [...new Set(m.coverage.filter(v => COVERAGE.includes(v)))] : [];
    safe.metrics = metrics;
  }
  return safe;
}
