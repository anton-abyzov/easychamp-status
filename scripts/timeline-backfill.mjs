// Rebuilds data/timeline.json from the status snapshots already committed to this
// repository. Every check comes from a recorded observation; nothing is inferred.
// Usage: node scripts/timeline-backfill.mjs [--since 2026-10-07T00:00:00Z]
import { execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { viewState, time } from '../public/model.mjs';
import { emptyTimeline, recordTimeline, serializeTimeline } from './timeline.mjs';

const sinceArg = process.argv.indexOf('--since');
const since = sinceArg > 0 ? process.argv[sinceArg + 1] : null;
const registry = JSON.parse(await readFile('config/components.json', 'utf8'));
const commits = execFileSync('git', ['log', '--reverse', '--format=%H', ...(since ? [`--since=${since}`] : []), 'HEAD', '--', 'data/status.json'], { encoding: 'utf8', maxBuffer: 64 << 20 }).trim().split('\n').filter(Boolean);

async function* snapshots() {
  const cat = spawn('git', ['cat-file', '--batch'], { stdio: ['pipe', 'pipe', 'inherit'] });
  let buffer = Buffer.alloc(0);
  const chunks = cat.stdout[Symbol.asyncIterator]();
  const need = async n => { while (buffer.length < n) { const { value, done } = await chunks.next(); if (done) throw new Error('git cat-file ended early'); buffer = Buffer.concat([buffer, value]); } };
  for (const commit of commits) {
    cat.stdin.write(`${commit}:data/status.json\n`);
    let newline;
    while ((newline = buffer.indexOf(10)) < 0) await need(buffer.length + 1);
    const header = buffer.subarray(0, newline).toString();
    buffer = buffer.subarray(newline + 1);
    const [, type, size] = header.split(' ');
    if (type !== 'blob') continue;
    await need(Number(size) + 1);
    const text = buffer.subarray(0, Number(size)).toString();
    buffer = buffer.subarray(Number(size) + 1);
    try { yield JSON.parse(text); } catch { /* A malformed historical snapshot contributes no checks. */ }
  }
  cat.stdin.end();
}

let timeline = emptyTimeline(), count = 0, last = null;
for await (const state of snapshots()) {
  const at = time(state.generatedAt);
  if (at === null || state.schemaVersion !== 1) continue;
  const view = viewState(registry, { probes: {}, freshness: {}, ...state }, at);
  ({ timeline } = recordTimeline(timeline, registry, state, view, at));
  count++; last = state.generatedAt;
}
await writeFile('data/timeline.json', serializeTimeline(timeline));
console.log(JSON.stringify({ snapshots: count, commits: commits.length, last, series: Object.keys(timeline.series).length, segments: Object.values(timeline.series).reduce((n, s) => n + s.length, 0) }));
