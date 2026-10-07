import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { currentEvidence, time } from '../public/model.mjs';
import { incidentId, safePublicUrl } from '../public/incident-model.mjs';

export function endpointHistory(probe, sample, previous = '', now = Date.now()) {
  if (probe.type !== 'http' || !incidentId(probe.id) || !safePublicUrl(probe.url)) throw new Error('invalid_endpoint_history_probe');
  const evidence = currentEvidence(sample, probe.expiresSeconds, now);
  const observedAt = time(evidence.observedAt) === null ? new Date(now).toISOString() : new Date(time(evidence.observedAt)).toISOString();
  const oldStart = previous.match(/^startTime: (.+)$/m)?.[1];
  const startTime = time(oldStart) === null ? observedAt : new Date(time(oldStart)).toISOString();
  const status = { operational: 'up', degraded: 'degraded', partial_outage: 'down', major_outage: 'down', unknown: 'unknown', maintenance: 'unknown' }[evidence.status];
  return `url: ${probe.url}\nstatus: ${status}\ncode: ${Number.isInteger(evidence.httpStatus) ? evidence.httpStatus : 0}\nresponseTime: ${Number.isFinite(evidence.responseMs) ? evidence.responseMs : 0}\nlastUpdated: ${observedAt}\nstartTime: ${startTime}\ngenerator: EasyChamp endpoint observations (independent of confirmed incidents)\n`;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const registry = JSON.parse(await readFile('config/components.json', 'utf8'));
  const state = JSON.parse(await readFile('data/status.json', 'utf8'));
  await mkdir('history', { recursive: true });
  for (const probe of registry.probes.filter(row => row.type === 'http')) {
    const path = `history/${probe.id}.yml`;
    let previous = ''; try { previous = await readFile(path, 'utf8'); } catch { /* First observation. */ }
    await writeFile(path, endpointHistory(probe, state.probes?.[probe.id], previous, time(state.generatedAt) || Date.now()));
  }
  console.log('Persisted raw endpoint history without issuing separate outage notifications.');
}
