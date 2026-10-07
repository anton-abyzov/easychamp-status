import test from 'node:test';
import assert from 'node:assert/strict';
import { publishHeartbeat } from '../scripts/heartbeat.mjs';
const view = { components: [{ status: 'operational' }, { status: 'degraded' }, { status: 'major_outage' }, { status: 'unknown' }] };
const env = { NEW_RELIC_STATUS_LICENSE_KEY: 'test-secret', NEW_RELIC_STATUS_ACCOUNT_ID: '123' };
test('missing configuration stays optional and never blocks status publication', async () => { assert.deepEqual(await publishHeartbeat(view, new Date().toISOString(), {}), { status: 'not_configured' }); });
test('heartbeat contains aggregate counts only and does not include its credential', async () => {
  let body;
  const result = await publishHeartbeat(view, '2026-10-07T18:00:00Z', env, async (url, options) => { body = JSON.parse(options.body); assert.equal(options.headers['Api-Key'], 'test-secret'); return new Response('', { status: 200 }); });
  assert.equal(result.status, 'accepted'); assert.equal(body[0].outageComponents, 1); assert.equal(body[0].unknownComponents, 1); assert(!JSON.stringify(body).includes('test-secret'));
});
test('failure returns sanitized status without response bodies or exception text', async () => {
  assert.deepEqual(await publishHeartbeat(view, new Date().toISOString(), env, async () => new Response('sensitive body', { status: 403 })), { status: 'rejected', httpStatus: 403 });
  assert.deepEqual(await publishHeartbeat(view, new Date().toISOString(), env, async () => { throw new Error('sensitive exception'); }), { status: 'unavailable' });
});
