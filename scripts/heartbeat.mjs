export async function publishHeartbeat(view, observedAt, env = process.env, send = fetch, published = false) {
  if (!env.NEW_RELIC_STATUS_LICENSE_KEY || !/^\d+$/.test(env.NEW_RELIC_STATUS_ACCOUNT_ID || '')) return { status: 'not_configured' };
  const counts = Object.fromEntries(['operational', 'degraded', 'partial_outage', 'major_outage', 'maintenance', 'unknown'].map(status => [status, view.components.filter(c => c.status === status).length]));
  const confirmed = status => view.components.filter(c => status.includes(c.status) && (view.counters?.[c.id]?.bad || 0) >= 2).length;
  const emittedAt = Date.now();
  const payload = [{ schemaVersion: 1, eventType: published ? 'EasyChampPublicStatusPublishedHeartbeat' : 'EasyChampPublicStatusHeartbeat', timestamp: emittedAt, observedAt, ...(published ? { publishedOperational: 1, stateGeneratedAt: observedAt, publishedAt: new Date(emittedAt).toISOString() } : { collectorOperational: 1 }), totalComponents: view.components.length, operationalComponents: counts.operational, degradedComponents: counts.degraded, outageComponents: counts.partial_outage + counts.major_outage, confirmedOutageComponents: confirmed(['partial_outage', 'major_outage']), confirmedDegradedComponents: confirmed(['degraded']), unknownComponents: counts.unknown, maintenanceComponents: counts.maintenance }];
  try {
    const response = await send(`https://insights-collector.newrelic.com/v1/accounts/${env.NEW_RELIC_STATUS_ACCOUNT_ID}/events`, { method: 'POST', signal: AbortSignal.timeout(8000), headers: { 'Api-Key': env.NEW_RELIC_STATUS_LICENSE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    await response.body?.cancel();
    return { status: response.ok ? 'accepted' : 'rejected', httpStatus: response.status };
  } catch { return { status: 'unavailable' }; }
}
