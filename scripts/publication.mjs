import { readFile } from 'node:fs/promises';
import { viewState, time } from '../public/model.mjs';
import { publishHeartbeat } from './heartbeat.mjs';
export function publicationEvidence(state, expectedAt, now = Date.now()) {
  return state?.schemaVersion === 1 && time(state.generatedAt) !== null && state.generatedAt === expectedAt && time(state.generatedAt) <= now + 60000 && now - time(state.generatedAt) <= 900000;
}
export async function verifyPublication(pageUrl, expectedAt, get = fetch) {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== 'https:') return { status: 'unavailable' };
    const response = await get(new URL(`data/status.json?t=${Date.now()}`, url).href, { signal: AbortSignal.timeout(12000), cache: 'no-store' });
    if (!response.ok) { await response.body?.cancel(); return { status: 'unavailable' }; }
    const text = await response.text();
    if (text.length > 1000000) return { status: 'invalid' };
    const state = JSON.parse(text);
    return publicationEvidence(state, expectedAt) ? { status: 'verified', state } : { status: 'stale_or_mismatched' };
  } catch { return { status: 'unavailable' }; }
}
if (process.argv.includes('--published')) {
  const checked = await verifyPublication(process.env.STATUS_PAGE_URL, process.env.STATUS_GENERATED_AT);
  if (checked.status === 'verified') {
    const registry = JSON.parse(await readFile('config/components.json', 'utf8'));
    console.log(JSON.stringify({ publication: 'verified', heartbeat: await publishHeartbeat({ ...viewState(registry, checked.state), counters: checked.state.counters }, checked.state.generatedAt, process.env, fetch, true) }));
  } else { console.log(JSON.stringify({ publication: checked.status, heartbeat: 'not_sent' })); process.exitCode = 1; }
}
