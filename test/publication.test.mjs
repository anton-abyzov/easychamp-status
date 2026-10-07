import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationEvidence, verifyPublication } from '../scripts/publication.mjs';
import { publishHeartbeat } from '../scripts/heartbeat.mjs';
test('published heartbeat requires the exact fresh deployed generation, not collection success', () => {
  const now = Date.now(); const at = new Date(now - 60000).toISOString();
  assert.equal(publicationEvidence({ schemaVersion: 1, generatedAt: at }, at, now), true);
  assert.equal(publicationEvidence({ schemaVersion: 1, generatedAt: at }, new Date(now).toISOString(), now), false);
  assert.equal(publicationEvidence({ schemaVersion: 1, generatedAt: at }, at, now + 16 * 60000), false);
  assert.equal(publicationEvidence({ schemaVersion: 1, generatedAt: new Date(now + 2 * 60000).toISOString() }, new Date(now + 2 * 60000).toISOString(), now), false);
});
test('failed publication and old public data cannot produce a healthy published event', async () => {
  const at = new Date().toISOString();
  assert.equal((await verifyPublication('https://status.example/', at, async () => new Response('', { status: 404 }))).status, 'unavailable');
  assert.equal((await verifyPublication('https://status.example/', at, async () => new Response(JSON.stringify({ schemaVersion: 1, generatedAt: '2020-01-01T00:00:00Z' })))).status, 'stale_or_mismatched');
});
test('published event is separate from collector heartbeat and records generation time', async () => {
  let event;
  const at = new Date().toISOString();
  await publishHeartbeat({ components: [] }, at, { NEW_RELIC_STATUS_LICENSE_KEY: 'test-secret', NEW_RELIC_STATUS_ACCOUNT_ID: '123' }, async (_url, options) => { event = JSON.parse(options.body)[0]; return new Response('', { status: 200 }); }, true);
  assert.equal(event.eventType, 'EasyChampPublicStatusPublishedHeartbeat'); assert.equal(event.publishedOperational, 1); assert.equal(event.stateGeneratedAt, at); assert.equal(event.collectorOperational, undefined);
});
