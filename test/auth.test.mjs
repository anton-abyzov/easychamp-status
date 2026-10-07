import test from 'node:test';
import assert from 'node:assert/strict';
import { allowMonitorHeader, monitorHeaders, safeFetch } from '../scripts/auth.mjs';
test('scoped monitor header only reaches approved hosts and read paths', () => {
  for (const url of ['https://watch.easychamp.com/', 'https://dcfc.at.easychamp.com/main', 'https://soccer-nationals.easychamp.com/_next/static/chunks/a.js', 'https://dcfc.easychamp.com/_next/image?url=image', 'https://dcfc.at.easychamp.com/_next/img.webp?url=image&w=2560&q=75']) assert.equal(allowMonitorHeader(url), true, url);
  for (const url of ['http://watch.easychamp.com/', 'https://watch.easychamp.com.attacker.test/', 'https://watch.easychamp.com/?token=1', 'https://watch.easychamp.com/api/private', 'https://static.cloudflareinsights.com/beacon.js', 'https://coach.easychamp.com/', 'https://watch.easychamp.com/_next/imageevil', 'https://watch.easychamp.com/_next/img.webp/other', 'https://watch.easychamp.com:8443/', 'https://:password@watch.easychamp.com/']) assert.equal(allowMonitorHeader(url), false, url);
});
test('header is stripped on third parties and absent without a configured token', () => {
  assert.deepEqual(monitorHeaders('https://third.party/', 'test-secret', { 'X-Ec-Status-Monitor': 'previous', Accept: 'text/html' }), { Accept: 'text/html' });
  assert.deepEqual(monitorHeaders('https://watch.easychamp.com/', null), {});
});
test('cross-domain redirects cannot forward the scoped secret', async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, headers: options.headers }); return calls.length === 1 ? new Response('', { status: 302, headers: { location: 'https://third.party/' } }) : new Response('ok'); };
  try { await safeFetch('https://watch.easychamp.com/', { headers: {} }, 'test-secret'); assert.equal(calls[0].headers['x-ec-status-monitor'], 'test-secret'); assert.equal(calls[1].headers['x-ec-status-monitor'], undefined); }
  finally { globalThis.fetch = original; }
});
