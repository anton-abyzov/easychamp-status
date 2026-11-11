import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decide, STALE_ACTIVE_SECONDS } from '../scripts/pacer-decision.mjs';

const now = Date.parse('2026-11-11T21:00:00Z');
const ago = (s) => new Date(now - s * 1000).toISOString();

test('fresh active run suppresses dispatch', () => {
  assert.equal(decide({ createdAt: ago(120), status: 'queued', now }).dispatch, false);
  assert.equal(decide({ createdAt: ago(STALE_ACTIVE_SECONDS), status: 'in_progress', now }).dispatch, false);
});

test('a run stuck queued or in progress past ten minutes no longer suppresses dispatch', () => {
  // 2026-11-11: run queued from 20:20Z blocked the pacer for 49 minutes.
  assert.equal(decide({ createdAt: ago(STALE_ACTIVE_SECONDS + 1), status: 'queued', now }).dispatch, true);
  assert.equal(decide({ createdAt: ago(3000), status: 'in_progress', now }).dispatch, true);
});

test('completed run dispatches only after the minimum gap', () => {
  assert.equal(decide({ createdAt: ago(200), status: 'completed', now }).dispatch, false);
  assert.equal(decide({ createdAt: ago(400), status: 'completed', now }).dispatch, true);
});

test('no previous run dispatches', () => {
  assert.equal(decide({ now }).dispatch, true);
});

const read = (f) => readFileSync(new URL(`../.github/workflows/${f}`, import.meta.url), 'utf8');
const group = (s) => s.match(/concurrency:\s*\n\s+group: (\S+)/)[1];

test('pacer never shares status.yml concurrency group and cannot hold its own for long', () => {
  const pacer = read('pacer.yml');
  const status = read('status.yml');
  assert.notEqual(group(pacer), group(status));
  assert.match(pacer, /cancel-in-progress: true/);
  const minutes = Number(pacer.match(/timeout-minutes: (\d+)/)[1]);
  assert.ok(minutes <= 30, `pacer timeout-minutes ${minutes} must be <= 30`);
  assert.match(status, /cancel-in-progress: false/);
});

test('pacer decides through the tested script', () => {
  assert.match(read('pacer.yml'), /node scripts\/pacer-decision\.mjs/);
});

test('a failing decision script fails open instead of ending the pacer step', () => {
  const pacer = read('pacer.yml');
  assert.doesNotMatch(pacer, /<\(node scripts\/pacer-decision/);
  assert.match(pacer, /if ! decision=\$\(node scripts\/pacer-decision\.mjs/);
  assert.match(pacer, /decision='dispatch unknown script-error'/);
});
