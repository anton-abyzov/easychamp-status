import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist/data', { recursive: true });
for (const name of ['index.html', 'style.css', 'app.mjs', 'model.mjs', 'favicon.svg']) await copyFile(`public/${name}`, `dist/${name}`);
await copyFile('config/components.json', 'dist/data/components.json');
for (const name of ['status', 'history', 'incidents']) {
  try { await copyFile(`data/${name}.json`, `dist/data/${name}.json`); }
  catch { await writeFile(`dist/data/${name}.json`, JSON.stringify(name === 'status' ? { schemaVersion: 1, generatedAt: null, probes: {}, freshness: {} } : name === 'history' ? { schemaVersion: 1, days: {} } : { schemaVersion: 1, incidents: [] })); }
}
await writeFile('dist/.nojekyll', '');
console.log('Built independent static status site.');
