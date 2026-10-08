import { performance } from 'node:perf_hooks';
import { safeFetch } from './auth.mjs';

const HEALTH_REASONS = new Set(['ok', 'assistant_disabled', 'assistant_storage_unavailable',
  'assistant_health_unverified', 'assistant_budget_unverified', 'assistant_budget_exhausted',
  'provider_health_unsupported', 'provider_not_configured', 'provider_authentication_failed',
  'provider_unavailable', 'provider_funding_exhausted', 'provider_capacity_low', 'provider_health_unverified']);

export async function boundedBody(response, max = 2_000_000) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > max) { await reader.cancel(); throw new Error('body_limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

/** Dependency checks do not prove an authenticated question or model generation. */
export function assistantHealthEvidence(data, now = Date.now()) {
  const invalid = { status: 'unknown', reasonCode: 'invalid_evidence' };
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || !['operational', 'degraded', 'unavailable'].includes(data.status)
      || typeof data.ready !== 'boolean'
      || !['operational', 'unavailable'].includes(data.storage)
      || !['operational', 'degraded', 'unavailable'].includes(data.provider)
      || !HEALTH_REASONS.has(data.reasonCode)
      || typeof data.checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(data.checkedAt)
      || !Number.isInteger(data.cacheSeconds) || data.cacheSeconds < 1 || data.cacheSeconds > 60) return invalid;
  const checked = Date.parse(data.checkedAt);
  if (!Number.isFinite(checked) || checked > now + 60_000) return invalid;
  if (now - checked > (data.cacheSeconds + 60) * 1000) return { status: 'unknown', reasonCode: 'stale', observedAt: new Date(checked).toISOString() };
  const observedAt = new Date(checked).toISOString();
  if (data.status === 'operational') {
    if (!data.ready || data.storage !== 'operational' || data.provider !== 'operational' || data.reasonCode !== 'ok') return invalid;
    return { status: 'operational', reasonCode: 'ok', observedAt };
  }
  if (data.ready) return invalid;
  if (data.status === 'degraded') {
    if (data.storage !== 'operational' || data.provider !== 'degraded' || data.reasonCode !== 'provider_capacity_low') return invalid;
    return { status: 'degraded', reasonCode: data.reasonCode, observedAt };
  }
  if ((data.storage !== 'unavailable' && data.provider !== 'unavailable') || ['ok', 'provider_capacity_low'].includes(data.reasonCode)) return invalid;
  return { status: 'major_outage', reasonCode: data.reasonCode, observedAt };
}

export async function httpProbe(probe, { fetcher = safeFetch, now = Date.now, token = process.env.STATUS_MONITOR_TOKEN } = {}) {
  const evidence = (status, reasonCode, extra = {}) => ({ status, reasonCode, observedAt: new Date(now()).toISOString(), ...extra });
  const start = performance.now();
  try {
    const response = await fetcher(probe.url, {
      signal: AbortSignal.timeout(18_000),
      headers: { 'User-Agent': 'EasyChamp-Status-Monitor/1.0 (+https://status.easychamp.com)', Accept: probe.jsonFields || probe.semanticHealth ? 'application/json' : 'text/html' },
    }, probe.monitorAuth ? token : null);
    if (response.status === 429 && (response.headers.get('x-ec-shed') === 'headless'
        || (probe.monitorAuth && token && response.headers.get('x-ec-shed') === 'ratelimit'))) {
      await response.body?.cancel();
      return evidence('unknown', 'automation_blocked');
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return evidence('major_outage', 'http_error', { httpStatus: response.status });
    }
    let body;
    try { body = await boundedBody(response, probe.semanticHealth ? 16_384 : 2_000_000); }
    catch (error) {
      if (probe.semanticHealth && error.message === 'body_limit') return evidence('unknown', 'invalid_evidence');
      throw error;
    }
    const responseMs = Math.round(performance.now() - start);
    if (probe.bodyIncludes && !body.includes(probe.bodyIncludes)) return evidence('partial_outage', 'content_mismatch', { responseMs });
    let data;
    if (probe.jsonFields || probe.jsonEquals || probe.semanticHealth) {
      try { data = JSON.parse(body); } catch { return evidence(probe.semanticHealth ? 'unknown' : 'partial_outage', probe.semanticHealth ? 'invalid_evidence' : 'schema_mismatch', { responseMs }); }
      if (!data || typeof data !== 'object' || Array.isArray(data)
          || Object.entries(probe.jsonFields || {}).some(([key, type]) => typeof data[key] !== type)
          || Object.entries(probe.jsonEquals || {}).some(([key, value]) => data[key] !== value)) {
        return evidence(probe.semanticHealth ? 'unknown' : 'partial_outage', probe.semanticHealth ? 'invalid_evidence' : 'schema_mismatch', { responseMs });
      }
    }
    if (probe.semanticHealth) {
      const sample = assistantHealthEvidence(data, now());
      if (sample.status !== 'operational') return { ...evidence(sample.status, sample.reasonCode, { responseMs, httpStatus: 200 }), ...sample };
      if (responseMs > probe.maxResponseMs) return evidence('degraded', 'slow', { responseMs, httpStatus: 200, observedAt: sample.observedAt });
      return { ...sample, responseMs, httpStatus: 200 };
    }
    return evidence(responseMs > probe.maxResponseMs ? 'degraded' : 'operational', responseMs > probe.maxResponseMs ? 'slow' : 'ok', { responseMs, httpStatus: 200 });
  } catch (error) {
    return evidence('major_outage', error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'network_error');
  }
}
