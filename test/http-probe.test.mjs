import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assistantHealthEvidence, httpProbe } from '../scripts/http-probe.mjs';
import { componentState } from '../public/model.mjs';

const now = Date.parse('2026-10-08T04:00:00Z');
const at = new Date(now).toISOString();
const good = { status: 'operational', ready: true, storage: 'operational', domain: 'operational', provider: 'operational', reasonCode: 'ok', checkedAt: at, cacheSeconds: 60 };
const probe = { id: 'assistant-health', type: 'http', url: 'https://easychamp.com/ec-chat-api/assistant/v1/health', semanticHealth: true, maxResponseMs: 5000, expiresSeconds: 900 };
const options = body => ({ now: () => now, fetcher: async () => Response.json(body), token: 'never-send-this-secret' });

test('assistant readiness requires semantic values, not HTTP 200 or field types', async () => {
  assert.equal((await httpProbe(probe, options(good))).status, 'operational');
  for (const change of [{ ready: false }, { storage: 'unavailable' }, { provider: 'unavailable' }, { domain: 'unavailable' }, { domain: 'unknown' }, { domain: undefined }, { reasonCode: 'provider_funding_exhausted' }]) {
    const sample = await httpProbe(probe, options({ ...good, ...change }));
    assert.equal(sample.status, 'unknown');
    assert.equal(sample.reasonCode, 'invalid_evidence');
  }
});

test('provider low capacity degrades and exhausted funding reports outage despite HTTP 200', async () => {
  const degraded = await httpProbe(probe, options({ ...good, status: 'degraded', ready: false, provider: 'degraded', reasonCode: 'provider_capacity_low' }));
  assert.equal(degraded.status, 'degraded');
  assert.equal(degraded.reasonCode, 'provider_capacity_low');
  const failed = await httpProbe(probe, options({ ...good, status: 'unavailable', ready: false, provider: 'unavailable', reasonCode: 'provider_funding_exhausted' }));
  assert.equal(failed.status, 'major_outage');
  assert.equal(failed.httpStatus, 200);
  assert.equal(failed.reasonCode, 'provider_funding_exhausted');
  const storage = await httpProbe(probe, options({ ...good, status: 'unavailable', ready: false, storage: 'unavailable', provider: 'unavailable', reasonCode: 'assistant_storage_unavailable' }));
  assert.equal(storage.status, 'major_outage');
  assert.equal(storage.reasonCode, 'assistant_storage_unavailable');
  const domain = await httpProbe(probe, options({ ...good, status: 'unavailable', ready: false, domain: 'unavailable', reasonCode: 'domain_unavailable' }));
  assert.equal(domain.status, 'major_outage');
  assert.equal(domain.reasonCode, 'domain_unavailable');
});

test('contradictory degradation and failure statuses are not accepted', () => {
  for (const change of [
    { status: 'degraded', ready: true, provider: 'degraded', reasonCode: 'provider_capacity_low' },
    { status: 'degraded', ready: false, provider: 'operational', reasonCode: 'provider_capacity_low' },
    { status: 'degraded', ready: false, provider: 'degraded', reasonCode: 'ok' },
    { status: 'degraded', ready: false, domain: 'unknown', provider: 'degraded', reasonCode: 'provider_capacity_low' },
    { status: 'unavailable', ready: false, reasonCode: 'provider_unavailable' },
    { status: 'unavailable', ready: false, provider: 'unavailable', reasonCode: 'ok' },
    { status: 'unknown', ready: true, provider: 'unknown', reasonCode: 'provider_health_unverified' },
    { status: 'unknown', ready: false, reasonCode: 'provider_health_unverified' },
    { status: 'unknown', ready: false, provider: 'unknown', domain: 'unavailable', reasonCode: 'domain_unavailable' },
    { status: 'unknown', ready: false, provider: 'unknown', reasonCode: 'ok' },
  ]) assert.equal(assistantHealthEvidence({ ...good, ...change }, now).status, 'unknown');
});

test('missing balance monitor access is Unknown rather than an inference outage', async () => {
  const sample = await httpProbe(probe, options({ ...good, status: 'unknown', ready: false, provider: 'unknown', reasonCode: 'provider_health_unverified' }));
  assert.equal(sample.status, 'unknown');
  assert.equal(sample.reasonCode, 'provider_health_unverified');
  const domain = await httpProbe(probe, options({ ...good, status: 'unknown', ready: false, domain: 'unknown', reasonCode: 'domain_health_unverified' }));
  assert.equal(domain.status, 'unknown');
  assert.equal(domain.reasonCode, 'domain_health_unverified');
  const timeout = await httpProbe(probe, options({ ...good, status: 'unknown', ready: false, storage: 'unknown', domain: 'unknown', provider: 'unknown', reasonCode: 'assistant_health_unverified' }));
  assert.equal(timeout.status, 'unknown');
  const wrongKey = await httpProbe(probe, options({ ...good, status: 'unavailable', ready: false, provider: 'unavailable', reasonCode: 'provider_inference_key_required' }));
  assert.equal(wrongKey.status, 'major_outage');
  assert.equal(wrongKey.reasonCode, 'provider_inference_key_required');
});

test('dependency states exhaustively enforce healthy, degraded, unavailable and Unknown consistency', () => {
  for (const storage of ['operational', 'unknown', 'unavailable'])
    for (const domain of ['operational', 'unknown', 'unavailable'])
      for (const provider of ['operational', 'degraded', 'unknown', 'unavailable']) {
        const dependencies = [storage, domain, provider];
        const common = { ...good, storage, domain, provider };
        const unavailable = dependencies.includes('unavailable');
        const unknown = dependencies.includes('unknown');
        const healthy = dependencies.every(value => value === 'operational');
        const degraded = storage === 'operational' && domain === 'operational' && provider === 'degraded';
        assert.equal(assistantHealthEvidence(common, now).status === 'operational', healthy);
        assert.equal(assistantHealthEvidence({ ...common, status: 'degraded', ready: false, reasonCode: 'provider_capacity_low' }, now).status === 'degraded', degraded);
        assert.equal(assistantHealthEvidence({ ...common, status: 'unavailable', ready: false, reasonCode: 'provider_unavailable' }, now).status === 'major_outage', unavailable);
        const uncertain = assistantHealthEvidence({ ...common, status: 'unknown', ready: false, reasonCode: 'provider_health_unverified' }, now);
        assert.equal(uncertain.reasonCode === 'provider_health_unverified', unknown && !unavailable);
      }
});

test('stale, future, invalid and malformed assistant evidence fails closed', async () => {
  assert.equal(assistantHealthEvidence({ ...good, checkedAt: new Date(now - 121_000).toISOString() }, now).reasonCode, 'stale');
  for (const change of [
    { checkedAt: new Date(now + 61_000).toISOString() }, { checkedAt: '2026-10-08' },
    { checkedAt: 'not a timestamp' }, { checkedAt: null }, { cacheSeconds: 61 },
    { cacheSeconds: 0 }, { cacheSeconds: 1.5 }, { cacheSeconds: '60' },
    { status: 'healthy' }, { ready: 'true' }, { provider: 'unknown' },
    { storage: null }, { reasonCode: 'future_reason' }, { reasonCode: 'https://private.invalid' },
  ]) assert.equal(assistantHealthEvidence({ ...good, ...change }, now).status, 'unknown');
  for (const body of [null, [], 'operational']) assert.equal((await httpProbe(probe, options(body))).status, 'unknown');
  const malformed = await httpProbe(probe, { now: () => now, fetcher: async () => new Response('{not json}') });
  assert.equal(malformed.status, 'unknown');
  const oversized = await httpProbe(probe, options({ ...good, extra: 'x'.repeat(16_384) }));
  assert.equal(oversized.status, 'unknown');
  let cancelled = false;
  const tooLarge = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(16_385)); },
    cancel() { cancelled = true; },
  });
  assert.equal((await httpProbe(probe, { now: () => now, fetcher: async () => new Response(tooLarge) })).status, 'unknown');
  assert.equal(cancelled, true);
});

test('cached timestamps are preserved and component evidence expires', async () => {
  const cachedAt = new Date(now - 59_000).toISOString();
  const sample = await httpProbe(probe, options({ ...good, checkedAt: cachedAt }));
  assert.equal(sample.observedAt, cachedAt);
  const component = { id: 'assistant', probes: [probe.id] };
  const registry = { probes: [probe] };
  assert.equal(componentState(component, { probes: { [probe.id]: sample } }, registry, now).status, 'operational');
  assert.equal(componentState(component, { probes: { [probe.id]: sample } }, registry, now + 901_000).status, 'unknown');
  for (const status of ['degraded', 'unavailable']) {
    const failure = await httpProbe(probe, options({ ...good, status, ready: false, provider: status === 'degraded' ? 'degraded' : 'unavailable', reasonCode: status === 'degraded' ? 'provider_capacity_low' : 'provider_funding_exhausted' }));
    assert.equal(componentState(component, { probes: { [probe.id]: failure } }, registry, now).status, status === 'degraded' ? 'degraded' : 'major_outage');
  }
});

test('private response details and monitor credentials never enter public evidence', async () => {
  let suppliedToken;
  const sample = await httpProbe(probe, { now: () => now, token: 'monitor-secret', fetcher: async (_url, _request, token) => {
    suppliedToken = token;
    return Response.json({ ...good, balance: 999, actor: 'private-person', secret: 'private-secret', endpoint: 'http://private.internal' });
  } });
  assert.equal(suppliedToken, null);
  assert.equal(sample.status, 'operational');
  assert(!/private|balance|actor|secret|endpoint/.test(JSON.stringify(sample)));
});

test('existing HTTP content, typed JSON and exact values retain their checks', async () => {
  const typed = { url: probe.url, maxResponseMs: 5000, jsonFields: { ready: 'boolean', storage: 'string' }, jsonEquals: { ready: true, storage: 'transactional' } };
  assert.equal((await httpProbe(typed, options({ ready: true, storage: 'transactional' }))).status, 'operational');
  assert.equal((await httpProbe(typed, options({ ready: false, storage: 'transactional' }))).reasonCode, 'schema_mismatch');
  assert.equal((await httpProbe(typed, options({ ready: 'true', storage: 'transactional' }))).reasonCode, 'schema_mismatch');
  assert.equal((await httpProbe({ url: probe.url, maxResponseMs: 5000, bodyIncludes: 'expected' }, { now: () => now, fetcher: async () => new Response('wrong body') })).reasonCode, 'content_mismatch');
});

test('HTTP failures, automation blocking and timeout do not become green or leak errors', async () => {
  const http = await httpProbe(probe, { now: () => now, fetcher: async () => new Response('private stack', { status: 503 }) });
  assert.equal(http.status, 'major_outage');
  assert.equal(http.httpStatus, 503);
  const blocked = await httpProbe(probe, { now: () => now, fetcher: async () => new Response('', { status: 429, headers: { 'x-ec-shed': 'headless' } }) });
  assert.equal(blocked.status, 'unknown');
  const timeout = await httpProbe(probe, { now: () => now, fetcher: async () => { throw new DOMException('private endpoint', 'TimeoutError'); } });
  assert.equal(timeout.reasonCode, 'timeout');
  assert(!JSON.stringify(timeout).includes('private'));
});

test('the assistant registry has an anonymous dependency probe and honest coverage', async () => {
  const registry = JSON.parse(await readFile(new URL('../config/components.json', import.meta.url), 'utf8'));
  const component = registry.components.find(c => c.id === 'assistant');
  assert.deepEqual(component.probes, ['assistant-health']);
  assert.match(component.coverage, /authenticated questions and model generation are not continuously checked/);
  const configured = registry.probes.find(p => p.id === 'assistant-health');
  assert.equal(configured.semanticHealth, true);
  assert.equal(configured.monitorAuth, undefined);
  assert.equal(configured.url, probe.url);
});
