import { mkdir, cp, copyFile, writeFile, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await cp('public', 'dist', { recursive: true });
await mkdir('dist/data', { recursive: true });
await copyFile('config/components.json', 'dist/data/components.json');
for (const name of ['status', 'history', 'incidents']) {
  try { await copyFile(`data/${name}.json`, `dist/data/${name}.json`); }
  catch { await writeFile(`dist/data/${name}.json`, JSON.stringify(name === 'status' ? { schemaVersion: 1, generatedAt: null, probes: {}, freshness: {} } : name === 'history' ? { schemaVersion: 1, days: {} } : { schemaVersion: 1, incidents: [] })); }
}
await writeFile('dist/.nojekyll', '');
console.log('Built independent static status site with local brand assets.');
