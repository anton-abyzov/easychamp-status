// Decides whether the pacer should dispatch status.yml. A run that is merely
// "queued" or "in_progress" only counts as healthy while it is fresh: on
// 2026-11-11 a status run stuck in `queued` from 20:20Z made the pacer wait
// forever and publication stayed down for 49 minutes.
export const MIN_GAP_SECONDS = 330;
export const STALE_ACTIVE_SECONDS = 600;
const ACTIVE = new Set(['queued', 'in_progress', 'pending', 'waiting', 'requested']);

export function decide({ createdAt = '', status = '', now = Date.now() } = {}) {
  const created = createdAt ? Date.parse(createdAt) : NaN;
  const age = Number.isFinite(created) ? Math.max(0, Math.floor((now - created) / 1000)) : Infinity;
  const active = ACTIVE.has(status);
  if (active && age <= STALE_ACTIVE_SECONDS) return { dispatch: false, age, reason: 'fresh active run' };
  if (!active && age <= MIN_GAP_SECONDS) return { dispatch: false, age, reason: 'recent run' };
  return { dispatch: true, age, reason: active ? 'stale active run' : 'no recent run' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [createdAt = '', status = ''] = process.argv.slice(2);
  const r = decide({ createdAt, status });
  console.log(`${r.dispatch ? 'dispatch' : 'wait'} ${r.age} ${r.reason}`);
}
