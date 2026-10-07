import test from 'node:test';
import assert from 'node:assert/strict';
import { blockedRequestEvidence, initialRenderBlocked, blockedRequestCounts } from '../scripts/render-coverage.mjs';

const required = (resourceType, url = 'https://watch.easychamp.com/_next/static/chunks/app.js', headers = {}) => blockedRequestEvidence({ resourceType, url, headers });
test('only explicit Next Router, Purpose or Sec-Purpose prefetch can be excluded from initial rendering', () => {
  const prefetches = [
    required('fetch', 'https://watch.easychamp.com/competition/example', { 'Next-Router-Prefetch': '1' }),
    required('fetch', undefined, { Purpose: 'prefetch' }),
    required('fetch', undefined, { 'Sec-Purpose': 'prefetch' }),
  ];
  assert.equal(initialRenderBlocked(prefetches), false);
  for (const headers of [{}, { 'next-router-prefetch': '0' }, { purpose: 'prerender' }, { purpose: 'prefetch-other' }, { 'x-prefetch': '1' }]) assert.equal(initialRenderBlocked([required('fetch', undefined, headers)]), true);
});
test('blocked required script, stylesheet, font, visible image and non-prefetch XHR still invalidate rendering', () => {
  const prefetched = required('fetch', undefined, { 'next-router-prefetch': '1' });
  for (const type of ['script', 'stylesheet', 'font', 'image', 'xhr', 'fetch', 'document']) assert.equal(initialRenderBlocked([prefetched, required(type)]), true, type);
});
test('diagnostics contain bounded aggregate metadata and never URL, query, headers or credentials', () => {
  const request = required('image', 'https://watch.easychamp.com/_next/image?url=private-value&w=384&q=75', { 'x-ec-status-monitor': 'test-secret' });
  assert.deepEqual(blockedRequestCounts([request, request]), [{ resourceType: 'image', explicitPrefetch: false, isNextAsset: true, count: 2 }]);
  assert.equal(JSON.stringify(blockedRequestCounts([request])).includes('test-secret'), false);
  assert.equal(JSON.stringify(blockedRequestCounts([request])).includes('private-value'), false);
  assert.equal(required('xhr', 'https://watch.easychamp.com/api/private').isNextAsset, false);
});
