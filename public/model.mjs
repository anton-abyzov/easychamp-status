import { verifyScheduledRun, verifyResources, componentMeasurements, measurementOverview, overviewSummary, runningEvidence } from './measurements.mjs';
export const STATUSES = ['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance', 'unknown'];
export const LABELS = { operational: 'Operational', degraded: 'Needs attention', partial_outage: 'Partial outage', major_outage: 'Major outage', maintenance: 'Maintenance', unknown: 'Unknown' };
export const REASONS = { assistant_disabled: 'AI assistant is disabled', assistant_storage_unavailable: 'AI conversation storage unavailable', assistant_health_unverified: 'AI dependency health unverified', assistant_budget_unverified: 'AI service budget unverified', assistant_budget_exhausted: 'AI service budget exhausted', provider_health_unsupported: 'AI provider health check unsupported', provider_not_configured: 'AI provider is not configured', provider_authentication_failed: 'AI provider authentication failed', provider_unavailable: 'AI provider account unavailable', provider_funding_exhausted: 'AI provider allowance exhausted', provider_capacity_low: 'AI provider balance is low', provider_health_unverified: 'AI provider account health unverified', ok: 'Checks passed', verified: 'Configured evidence verified', in_progress: 'Latest scheduled run is in progress', resource_pressure: 'Node readiness or sustained resource alert needs attention', rendering_incomplete: 'Visible images did not finish loading', not_configured: 'Destination monitor not connected', collector_stale: 'Collector evidence expired', verification_unavailable: 'Destination freshness unverified', run_failed: 'Scheduled import failed', destination_stale: 'Persisted destination data is stale', schedule_missed: 'Scheduled update overdue', dependency_unavailable: 'Required data source unavailable', slow: 'Response slower than target', rendering_slow: 'Page rendering slower than target', http_error: 'Unexpected HTTP response', content_mismatch: 'Expected content missing', schema_mismatch: 'Unexpected response format', timeout: 'Check timed out', network_error: 'Connection failed', automation_blocked: 'Automation protected; customer availability unverified', not_monitored: 'Functional monitor not connected', stale: 'Latest evidence expired', invalid_evidence: 'Evidence could not be verified', no_destination_evidence: 'Destination freshness unverified', freshness_late: 'Scheduled update overdue', source_blocked: 'Data source unavailable', unexpected_empty: 'Unexpected empty import', import_failed: 'Import failed', inactive: 'Scheduled feed inactive', collector_unavailable: 'Freshness collector unavailable', browser_unavailable: 'Rendering check unavailable' };

export function time(value) { const t = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(t) ? t : null; }
export function validTime(value, now = Date.now()) { const t = time(value); return t !== null && t <= now + 60000; }
export function unknown(reasonCode = 'invalid_evidence', observedAt = null) { return { status: 'unknown', reasonCode, observedAt }; }

export function currentEvidence(sample, expiresSeconds, now = Date.now()) {
  if (!sample || !STATUSES.includes(sample.status) || !Object.hasOwn(REASONS, sample.reasonCode) || !validTime(sample.observedAt, now)) return unknown(sample ? 'invalid_evidence' : 'not_monitored');
  if (now - time(sample.observedAt) > expiresSeconds * 1000) return unknown('stale', sample.observedAt);
  return sample;
}

export function rollup(samples) {
  if (!samples.length) return 'unknown';
  for (const status of ['major_outage', 'partial_outage', 'degraded', 'unknown', 'maintenance']) if (samples.some(s => s.status === status)) return status;
  return 'operational';
}

export function verifyFreshness(sample, now = Date.now(), limits = {}) {
  const base = currentEvidence(sample, 1200, now);
  if (base.status === 'unknown') return { ...sample, ...base };
  if (sample.measurementKind && sample.measurementKind !== 'destination_validation') return unknown('invalid_evidence', base.observedAt);
  if (sample.lastAttemptOutcome === 'running') return { ...sample, ...runningEvidence(sample, now) };
  if (sample.suspended === true) return { ...sample, ...unknown('inactive', base.observedAt) };
  if (sample.lastAttemptOutcome === 'failed' && base.status === 'operational') return { ...sample, status: 'degraded', reasonCode: 'run_failed' };
  if (base.status === 'maintenance' && base.reasonCode === 'inactive') return base;
  if (!['operational', 'degraded', 'partial_outage', 'major_outage'].includes(base.status)) return unknown();
  if (base.status !== 'operational') return base;
  if (base.reasonCode !== 'verified') return unknown('invalid_evidence', base.observedAt);
  const fields = ['lastCompletedSuccessAt', 'lastDestinationVerifiedAt', 'nextDueAt'];
  if (fields.some(f => time(sample[f]) === null) || !validTime(sample.lastCompletedSuccessAt, now) || !validTime(sample.lastDestinationVerifiedAt, now)) return unknown('no_destination_evidence', base.observedAt);
  if (time(sample.lastCompletedSuccessAt) > time(sample.observedAt) + 60000 || time(sample.lastDestinationVerifiedAt) > time(sample.observedAt) + 60000 || time(sample.lastDestinationVerifiedAt) < time(sample.lastCompletedSuccessAt)) return unknown('invalid_evidence', base.observedAt);
  const maxSuccess = (limits.maxSuccessHours || 360) * 3600000;
  const maxDestination = (limits.maxDestinationHours || 28) * 3600000;
  if (now - time(sample.lastCompletedSuccessAt) > maxSuccess || now - time(sample.lastDestinationVerifiedAt) > maxDestination) return { ...base, status: 'degraded', reasonCode: 'freshness_late' };
  const maxGrace = limits.maxGraceSeconds || 86400;
  if (!Number.isInteger(sample.graceSeconds) || sample.graceSeconds < 0 || sample.graceSeconds > maxGrace || time(sample.nextDueAt) < time(sample.lastCompletedSuccessAt) || time(sample.nextDueAt) - time(sample.lastCompletedSuccessAt) > maxSuccess + maxGrace * 1000) return unknown('invalid_evidence', base.observedAt);
  if (now > time(sample.nextDueAt) + sample.graceSeconds * 1000) return { ...base, status: 'degraded', reasonCode: 'freshness_late' };
  return base;
}

export function componentState(component, state, registry, now = Date.now()) {
  let samples;
  if (component.freshness) {
    const sample = state.freshness?.[component.id];
    const verify = component.measurementKind === 'scheduled_run' ? verifyScheduledRun : component.measurementKind === 'cluster_resources' ? verifyResources : verifyFreshness;
    samples = [{ ...verify(sample, now, component), sourceId: component.id }];
  }
  else samples = (component.probes || []).map(id => ({ ...currentEvidence(state.probes?.[id], registry.probes.find(p => p.id === id)?.expiresSeconds || 0, now), sourceId: id }));
  if (!samples.length) samples = [unknown('not_monitored')];
  const status = rollup(samples);
  const dominant = samples.find(s => s.status === status) || samples[0];
  const checked = samples.filter(s => validTime(s.observedAt, now)).map(s => time(s.observedAt));
  const result = { id: component.id, status, reasonCode: dominant.reasonCode, observedAt: checked.length ? new Date(Math.min(...checked)).toISOString() : null, samples };
  return { ...result, checkScope: component.coverage || 'Functional coverage is not connected', measurements: componentMeasurements(component, result, registry, now) };
}

export function viewState(registry, state, now = Date.now()) {
  const components = registry.components.map(c => ({ ...c, ...componentState(c, state, registry, now) }));
  const groups = registry.groups.map(g => ({ ...g, components: components.filter(c => c.group === g.id), status: rollup(components.filter(c => c.group === g.id)) }));
  const view = { components, groups, status: rollup(components), collector: currentEvidence({ status: 'operational', reasonCode: 'ok', observedAt: state.generatedAt }, 900, now) };
  view.measurements = measurementOverview(registry, state, components, now);
  view.summary = overviewSummary(view);
  return view;
}
