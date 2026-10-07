import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { endpointHistory } from '../scripts/incidents-history.mjs';

const at = '2026-10-07T18:00:00Z';
const probe = { id: 'test-http', type: 'http', url: 'https://example.com/', expiresSeconds: 600 };
test('endpoint history reuses HTTP evidence, retains start time and represents unavailable evidence as unknown', () => {
  const before = endpointHistory(probe, { status: 'operational', reasonCode: 'ok', observedAt: at, httpStatus: 200, responseMs: 100 }, '', Date.parse(at));
  assert.match(before, /^status: up$/m); assert.match(before, /^responseTime: 100$/m);
  const expired = endpointHistory(probe, { status: 'operational', reasonCode: 'ok', observedAt: at }, before, Date.parse(at) + 700000);
  assert.match(expired, /^status: unknown$/m); assert.match(expired, /^startTime: 2026-10-07T18:00:00.000Z$/m);
  const unavailable = endpointHistory(probe, { status: 'unknown', reasonCode: 'automation_blocked', observedAt: at }, '', Date.parse(at)); assert.match(unavailable, /^status: unknown$/m);
  assert.throws(() => endpointHistory({ ...probe, id: '../escape' }, {}, '', Date.parse(at)), /invalid/);
});
test('serialized workflows have one incident writer and always check out latest main after the concurrency lock', async () => {
  const monitor = await readFile(new URL('../.github/workflows/status.yml', import.meta.url), 'utf8');
  const owner = await readFile(new URL('../.github/workflows/incident.yml', import.meta.url), 'utf8');
  for (const workflow of [monitor, owner]) { assert.match(workflow, /group: independent-status/); assert.match(workflow, /cancel-in-progress: false/); assert.match(workflow, /ref: main/); assert(!workflow.includes('--force')); assert.match(workflow, /PLAYWRIGHT_HTML_OPEN: never/); }
  assert(!monitor.includes('upptime/uptime-monitor@')); assert.match(monitor, /node scripts\/incidents-history.mjs/); assert.match(monitor, /node scripts\/incidents-sync.mjs/);
  assert.match(owner, /node scripts\/incidents-owner.mjs/); assert(!owner.includes('${{ inputs.message }}'));
});
