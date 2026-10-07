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
test('confirmed alert counts exclude first failures and currently unknown components', async () => {
  let event;
  const checked = { components: [{ id: 'a', status: 'major_outage' }, { id: 'b', status: 'degraded' }, { id: 'c', status: 'unknown' }, { id: 'd', status: 'partial_outage' }], counters: { a: { bad: 2 }, b: { bad: 1 }, c: { bad: 3 }, d: { bad: 2 } } };
  await publishHeartbeat(checked, new Date().toISOString(), env, async (_url, options) => { event = JSON.parse(options.body)[0]; return new Response('', { status: 200 }); });
  assert.equal(event.outageComponents, 2); assert.equal(event.confirmedOutageComponents, 2); assert.equal(event.degradedComponents, 1); assert.equal(event.confirmedDegradedComponents, 0);
});
