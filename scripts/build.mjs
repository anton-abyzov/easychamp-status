import { mkdir, cp, copyFile, writeFile, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await cp('public', 'dist', { recursive: true });
await mkdir('dist/data', { recursive: true });
await copyFile('config/components.json', 'dist/data/components.json');
for (const name of ['status', 'history', 'incidents', 'timeline']) {
  try { await copyFile(`data/${name}.json`, `dist/data/${name}.json`); }
  catch { await writeFile(`dist/data/${name}.json`, JSON.stringify(name === 'status' ? { schemaVersion: 1, generatedAt: null, probes: {}, freshness: {} } : name === 'history' ? { schemaVersion: 1, days: {} } : name === 'timeline' ? { schemaVersion: 1, series: {} } : { schemaVersion: 1, incidents: [] })); }
}
// The page reads only the HTTP availability series of the last eight days; the full record
// stays in data/timeline.json.
try {
  const { readFile } = await import('node:fs/promises');
  const { seriesKinds } = await import('./timeline.mjs');
  const timeline = JSON.parse(await readFile('data/timeline.json', 'utf8'));
  const kinds = seriesKinds(JSON.parse(await readFile('config/components.json', 'utf8')));
  const cutoff = Math.floor(Date.now() / 1000) - 8 * 86400;
  const series = {};
  for (const [id, list] of Object.entries(timeline.series)) if (kinds[id] === 'http') series[id] = list.filter(segment => segment[1] + timeline.caps.http >= cutoff);
  await writeFile('dist/data/uptime.json', JSON.stringify({ schemaVersion: 1, caps: timeline.caps, series }));
} catch { await writeFile('dist/data/uptime.json', JSON.stringify({ schemaVersion: 1, caps: {}, series: {} })); }
await writeFile('dist/.nojekyll', '');
console.log('Built independent static status site with local brand assets.');
