import { currentEvidence, unknown, time, validTime, rollup, REASONS } from './model.mjs';

const RESOURCE_FIELDS = ['cpuUtilizationPct', 'memoryUtilizationPct', 'diskUtilizationPct'];
const RESOURCE_COVERAGE = ['node_readiness', 'cpu', 'memory', 'disk'];
const finite = (v, max = 300000) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
const dated = (sample, field, now) => validTime(sample?.[field], now) && time(sample[field]) <= time(sample.observedAt) + 60000;

export function runningEvidence(sample, now = Date.now()) {
  if (!dated(sample, 'lastAttemptAt', now)) return unknown('invalid_evidence', sample?.observedAt);
  const start = time(sample.lastAttemptStartedAt), deadline = sample.lastAttemptDeadlineSeconds;
  if (sample.lastAttemptStartedAt != null && (!dated(sample, 'lastAttemptStartedAt', now) || start < time(sample.lastAttemptAt))
      || deadline != null && (!Number.isInteger(deadline) || deadline < 1 || deadline > 86400)) return unknown('invalid_evidence', sample.observedAt);
  const overdue = start !== null && deadline != null && time(sample.observedAt) - start > (deadline + 120) * 1000;
  // Preserve a collector-proven overrun; the reader clock never invents one.
  return sample.status === 'degraded' && sample.reasonCode === 'schedule_missed' && overdue
    ? sample : { ...sample, ...unknown('in_progress', sample.observedAt) };
}

export function verifyScheduledRun(sample, now = Date.now(), limits = {}) {
  const base = currentEvidence(sample, 1200, now);
  if (base.status === 'unknown' && !['verification_unavailable', 'in_progress'].includes(base.reasonCode)) return { ...sample, ...base };
  if (!sample || sample.measurementKind !== 'scheduled_run') return unknown('invalid_evidence', base.observedAt);
  if (sample.suspended === true) return { ...sample, ...unknown('inactive', base.observedAt) };
  if (!['succeeded', 'failed', 'running', 'unknown'].includes(sample.lastAttemptOutcome)) return unknown('invalid_evidence', base.observedAt);
  if (sample.lastAttemptOutcome !== 'unknown' && !dated(sample, 'lastAttemptAt', now)) return unknown('invalid_evidence', base.observedAt);
  if (sample.lastAttemptOutcome === 'running') return { ...sample, ...runningEvidence(sample, now) };
  if (sample.lastAttemptOutcome === 'failed') return { ...sample, status: 'degraded', reasonCode: 'run_failed' };
  if (base.status !== 'operational') return { ...sample, ...base };
  if (!sample.schedule || !['UTC', 'Etc/UTC', 'America/New_York'].includes(sample.timeZone) || sample.suspended !== false
      || limits.schedule && sample.schedule !== limits.schedule || limits.timeZone && sample.timeZone !== limits.timeZone) return unknown('invalid_evidence', base.observedAt);
  const maxSuccess = (limits.maxSuccessHours || 192) * 3600000;
  if (sample.lastAttemptOutcome !== 'succeeded' || sample.reasonCode !== 'verified' || !dated(sample, 'lastCompletedSuccessAt', now)
      || time(sample.lastCompletedSuccessAt) < time(sample.lastAttemptAt) || time(sample.nextDueAt) === null
      || time(sample.nextDueAt) < time(sample.lastCompletedSuccessAt) || !Number.isInteger(sample.graceSeconds)
      || sample.graceSeconds < 0 || sample.graceSeconds > (limits.maxGraceSeconds || 43200)
      || time(sample.nextDueAt) - time(sample.lastCompletedSuccessAt) > maxSuccess + sample.graceSeconds * 1000) return unknown('invalid_evidence', base.observedAt);
  if (now - time(sample.lastCompletedSuccessAt) > maxSuccess || now > time(sample.nextDueAt) + sample.graceSeconds * 1000) return { ...sample, status: 'degraded', reasonCode: 'schedule_missed' };
  return sample;
}

export function verifyResources(sample, now = Date.now()) {
  const base = currentEvidence(sample, 1200, now);
  if (base.status === 'unknown') return { ...sample, ...base };
  const m = sample?.metrics;
  if (sample?.measurementKind !== 'cluster_resources' || !m || !validTime(m.sampleAt, now) || time(m.sampleAt) > time(sample.observedAt) + 60000
      || now - time(m.sampleAt) > 1200000 || RESOURCE_FIELDS.some(k => !finite(m[k], 100))
      || !Number.isInteger(m.nodesReady) || !Number.isInteger(m.nodesTotal) || m.nodesTotal <= 0 || m.nodesTotal > 1000
      || m.nodesReady < 0 || m.nodesReady > m.nodesTotal || !Array.isArray(m.coverage)
      || m.coverage.length !== RESOURCE_COVERAGE.length || !RESOURCE_COVERAGE.every(k => m.coverage.includes(k))) return unknown('invalid_evidence', base.observedAt);
  if (base.status === 'operational' && (base.reasonCode !== 'verified' || m.nodesReady !== m.nodesTotal)) return unknown('invalid_evidence', base.observedAt);
  // Point utilization is information. Sustained alert/node-pressure evidence comes
  // from the fixed collector; a single busy sample does not manufacture an outage.
  return sample;
}

function row(id, label, sample, scope, extra = {}) {
  return { id, dimension: id.includes('availability') ? 'availability' : id.includes('latency') ? 'latency' : id === 'scheduled-run' ? 'scheduled-runs' : id === 'destination' ? 'freshness' : ['resources','cpu','memory','disk'].includes(id) ? 'resources' : 'functional', label, status: sample.status, reasonCode: sample.reasonCode, observedAt: sample.observedAt || null,
    scope, summary: REASONS[sample.reasonCode] || 'Evidence unavailable', ...extra };
}
function endpoint(probe, sample) {
  if (sample.status === 'degraded' && sample.reasonCode === 'slow' && sample.httpStatus === 200) return { ...sample, status: 'operational', reasonCode: 'ok' };
  if (sample.status === 'operational' && sample.httpStatus !== 200) return unknown('invalid_evidence', sample.observedAt);
  return sample;
}
function latency(probe, sample) {
  const value = probe.type === 'browser' ? sample.lcpMs : sample.responseMs;
  const target = probe.type === 'browser' ? probe.maxLcpMs : probe.maxResponseMs;
  if (!['operational', 'degraded'].includes(sample.status) || !finite(value) || probe.type === 'browser' && value === 0 || !finite(target)) return unknown(sample.status === 'unknown' ? sample.reasonCode : 'invalid_evidence', sample.observedAt);
  if (!['ok', 'slow', 'rendering_slow', 'rendering_incomplete'].includes(sample.reasonCode)) return unknown('invalid_evidence', sample.observedAt);
  if (value > target) return { ...sample, status: 'degraded', reasonCode: probe.type === 'browser' ? 'rendering_slow' : 'slow' };
  return sample;
}
function destination(component, sample, now) {
  if (sample.status === 'unknown' && ['stale', 'collector_stale', 'invalid_evidence', 'collector_unavailable'].includes(sample.reasonCode)) return sample;
  if (!dated(sample, 'lastDestinationVerifiedAt', now)) return unknown('verification_unavailable', sample.observedAt);
  if (now - time(sample.lastDestinationVerifiedAt) > (component.maxDestinationHours || 28) * 3600000) return { ...sample, status: 'degraded', reasonCode: 'destination_stale' };
  if (sample.destinationVerification === 'stale') return { ...sample, status: 'degraded', reasonCode: 'destination_stale' };
  if (sample.destinationVerification === 'unavailable') return unknown('verification_unavailable', sample.observedAt);
  if (!dated(sample, 'lastCompletedSuccessAt', now) || time(sample.lastDestinationVerifiedAt) < time(sample.lastCompletedSuccessAt)) return unknown('verification_unavailable', sample.observedAt);
  return { ...sample, status: 'operational', reasonCode: 'verified' };
}
function execution(component, sample, now) {
  if (component.measurementKind === 'scheduled_run') return sample;
  if (['stale', 'collector_stale', 'invalid_evidence', 'collector_unavailable'].includes(sample.reasonCode)) return unknown(sample.reasonCode, sample.observedAt);
  if (sample.suspended === true) return unknown('inactive', sample.observedAt);
  if (sample.lastAttemptOutcome === 'running') return runningEvidence(sample, now);
  if (sample.lastAttemptOutcome === 'failed') return dated(sample, 'lastAttemptAt', now) ? { ...sample, status: 'degraded', reasonCode: 'run_failed' } : unknown('invalid_evidence', sample.observedAt);
  if (sample.lastAttemptOutcome !== 'succeeded' || !dated(sample, 'lastAttemptAt', now) || !dated(sample, 'lastCompletedSuccessAt', now)
      || time(sample.lastAttemptAt) > time(sample.lastCompletedSuccessAt) || time(sample.nextDueAt) === null
      || time(sample.nextDueAt) < time(sample.lastCompletedSuccessAt) || !Number.isInteger(sample.graceSeconds)
      || sample.graceSeconds < 0 || sample.graceSeconds > (component.maxGraceSeconds || 86400)) return unknown('verification_unavailable', sample.observedAt);
  if (now > time(sample.nextDueAt) + sample.graceSeconds * 1000 || now - time(sample.lastCompletedSuccessAt) > (component.maxSuccessHours || 192) * 3600000) return { ...sample, status: 'degraded', reasonCode: 'schedule_missed' };
  return { ...sample, status: 'operational', reasonCode: 'verified' };
}
function scheduleSummary(sample) {
  const parts = [];
  if (sample.lastAttemptOutcome === 'running') parts.push(`Running since ${sample.lastAttemptAt}`);
  else if (sample.lastAttemptAt) parts.push(`Latest attempt ${sample.lastAttemptOutcome}: ${sample.lastAttemptAt}`);
  if (sample.lastCompletedSuccessAt) parts.push(`Last completed success ${sample.lastCompletedSuccessAt}`);
  if (sample.nextDueAt) parts.push(`Next due ${sample.nextDueAt}; grace ${sample.graceSeconds / 60} minutes`);
  if (sample.schedule && sample.timeZone) parts.push(`Schedule ${sample.schedule} (${sample.timeZone})`);
  return parts.join('. ');
}

export function componentMeasurements(component, current, registry, now = Date.now()) {
  if (!component.freshness) {
    const result = [];
    for (const sample of current.samples) {
      const probe = registry.probes.find(p => p.id === sample.sourceId);
      if (!probe) { result.push(row('functional', 'Functional coverage', sample, component.coverage)); continue; }
      if (probe.type === 'http') result.push(row(`${probe.id}-availability`, 'Endpoint availability', endpoint(probe, sample), 'HTTP 200 and the configured response content/schema. Credential login and other workflows are not inferred.'));
      const timing = latency(probe, sample), value = probe.type === 'browser' ? timing.lcpMs : timing.responseMs;
      result.push(row(`${probe.id}-latency`, probe.type === 'browser' ? 'Page rendering (LCP)' : 'HTTP response time', timing,
        probe.type === 'browser' ? 'Synthetic cold desktop browser; LCP after a six-second observation. Not real-user percentiles or a complete journey.' : 'Synthetic external request including the bounded response body; not server-only processing time.',
        { ...(finite(value) ? { value, target: probe.type === 'browser' ? probe.maxLcpMs : probe.maxResponseMs, unit: 'ms' } : {}) }));
    }
    return result;
  }
  const sample = current.samples[0];
  if (component.measurementKind === 'cluster_resources') {
    const result = [row('resources', 'Node readiness & monitoring', sample, component.coverage)];
    if (sample.metrics && sample.status !== 'unknown') {
      const m = sample.metrics;
      result[0].value = m.nodesReady; result[0].target = m.nodesTotal; result[0].unit = 'nodes';
      for (const [id, label, field, scope] of [['cpu', 'CPU usage', 'cpuUtilizationPct', 'Highest node CPU utilization over five minutes.'], ['memory', 'Memory usage', 'memoryUtilizationPct', 'Highest node utilization from available memory.'], ['disk', 'Disk usage', 'diskUtilizationPct', 'Highest writable ext4/xfs filesystem utilization.']]) {
        if (finite(m[field], 100)) result.push(row(id, label, sample, scope + ' Point utilization is informational; sustained alerts and node pressure determine resource attention.', { value: m[field], unit: '%' }));
      }
    }
    return result;
  }
  const result = [row('scheduled-run', 'Scheduled execution', execution(component, sample, now), 'Latest owned scheduled-job attempt and completion against its schedule. Successful execution alone does not verify persisted output.', { summary: scheduleSummary(sample) || REASONS[sample.reasonCode] })];
  result.push(row('destination', 'Destination verification', component.measurementKind === 'scheduled_run' ? unknown('verification_unavailable', sample.observedAt) : destination(component, sample, now),
    component.measurementKind === 'scheduled_run' ? 'Execution-only coverage. Persisted destination data is not independently verified for this job.' : 'Independent successful import plus authoritative destination verification, within the configured age limits.',
    { summary: sample.lastDestinationVerifiedAt ? `Last verified ${sample.lastDestinationVerifiedAt}` : 'Destination evidence is not connected' }));
  return result;
}

function aggregate(id, label, rows, scope) {
  const status = rollup(rows);
  const counts = { passing: rows.filter(r => r.status === 'operational').length, total: rows.length, unknown: rows.filter(r => r.status === 'unknown').length };
  const knownTimes = rows.map(r => time(r.observedAt)).filter(t => t !== null);
  const dominant = rows.find(r => r.status === status);
  return { id, label, status, reasonCode: dominant?.reasonCode || 'not_monitored', observedAt: knownTimes.length ? new Date(Math.min(...knownTimes)).toISOString() : null,
    ...counts, summary: rows.length ? `${counts.passing}/${counts.total} passing${counts.unknown ? `; ${counts.unknown} unavailable or paused` : ''}` : 'No measurements connected', scope, rows };
}
export function measurementOverview(registry, state, components, now = Date.now()) {
  const endpoints = [], timings = [], destinations = [], executions = [], resources = [];
  for (const probe of registry.probes) {
    const sample = currentEvidence(state.probes?.[probe.id], probe.expiresSeconds, now);
    const component = components.find(c => c.probes?.includes(probe.id));
    const extra = { componentId: component?.id };
    if (probe.type === 'http') endpoints.push(row(probe.id, component?.name || probe.id, endpoint(probe, sample), 'HTTP status and expected content/schema.', extra));
    const timing = latency(probe, sample);
    const value = probe.type === 'browser' ? timing.lcpMs : timing.responseMs;
    timings.push(row(probe.id, `${component?.name || probe.id} · ${probe.type === 'browser' ? 'rendering' : 'HTTP'}`, timing, probe.type === 'browser' ? 'Synthetic desktop LCP' : 'External HTTP response time', { ...extra, ...(finite(value) ? { value, target: probe.type === 'browser' ? probe.maxLcpMs : probe.maxResponseMs, unit: 'ms' } : {}) }));
  }
  for (const component of components.filter(c => c.freshness)) {
    const sample = component.samples[0];
    if (component.measurementKind === 'cluster_resources') { resources.push(row(component.id, component.name, sample, component.coverage)); continue; }
    executions.push(row(component.id, component.name, execution(component, sample, now), 'Scheduled execution only', { summary: scheduleSummary(sample) || REASONS[sample.reasonCode] }));
    if (component.measurementKind !== 'scheduled_run') destinations.push(row(component.id, component.name, destination(component, sample, now), 'Independent destination verification'));
  }
  return [
    aggregate('availability', 'Public endpoints', endpoints, 'Configured HTTP endpoints must return HTTP 200 and expected content/schema. This does not prove credential login, playback, purchases or other authenticated workflows.'),
    aggregate('latency', 'Page performance', timings, 'External whole-response timing and synthetic cold-desktop rendering/LCP. Each service lists its targets and timestamps. These are samples, not real-user percentiles or an uptime SLA.'),
    aggregate('freshness', 'Data destinations', destinations, 'Independent import completion and authoritative destination verification. Job execution and response speed cannot replace persisted-data evidence.'),
    aggregate('scheduled-runs', 'Scheduled jobs', executions, 'Latest owned job attempts, completions, next due and grace. Running, paused and unobserved jobs remain explicit. Green job execution does not prove destination freshness.'),
    aggregate('resources', 'Kubernetes', resources, 'Node readiness, fixed sustained resource alerts and fresh CPU/memory/disk coverage from existing Prometheus. Point utilization does not manufacture an outage; product functionality is measured separately.')
  ];
}
export function overviewSummary(view) {
  if (view.collector.status === 'unknown') return { status: 'unknown', title: 'Monitoring updates are unavailable', badge: 'Unknown', description: 'Current publication could not be verified. Open each measurement for its timestamp and scope.' };
  const failed = view.measurements.filter(m => ['major_outage', 'partial_outage', 'degraded'].includes(m.status));
  if (failed.length) {
    const priority = ['availability', 'latency', 'resources', 'scheduled-runs', 'freshness'];
    const lead = failed.sort((a, b) => priority.indexOf(a.id) - priority.indexOf(b.id))[0];
    const titles = { availability: 'Some endpoint checks are failing', latency: 'Some page checks need attention', resources: 'Cluster monitoring reports an issue', 'scheduled-runs': 'Some scheduled jobs need attention', freshness: 'Some destination updates are overdue' };
    return { status: view.status, title: titles[lead.id], badge: lead.id === 'scheduled-runs' ? 'Scheduled job issue' : lead.id === 'freshness' ? 'Data freshness issue' : 'Needs attention', description: failed.map(m => `${m.label}: ${m.summary}`).join(' · ') };
  }
  const endpoints = view.measurements.find(m => m.id === 'availability');
  const partial = view.components.some(c => c.status === 'unknown');
  return { status: view.status, title: endpoints?.status === 'operational' ? 'Public endpoint checks are passing' : 'Some checks are unavailable',
    badge: partial ? 'Partial monitoring' : 'Configured checks passing', description: partial ? 'Passing results apply to the stated checks. Missing, running and paused evidence stays visible; open a measurement for its coverage.' : 'Current configured checks passed. Open a service to see its exact coverage.' };
}
