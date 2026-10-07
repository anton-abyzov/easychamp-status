import { readFile, writeFile } from 'node:fs/promises';
import { githubClient, syncIncidentIssues } from './incidents-github.mjs';

try {
  const payload = JSON.parse(await readFile('data/incidents.json', 'utf8'));
  const result = await syncIncidentIssues(payload, process.env.GITHUB_REPOSITORY, githubClient(process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN));
  await writeFile('data/incidents.json', JSON.stringify(result.payload, null, 2) + '\n');
  console.log(JSON.stringify({ incidentIssues: { created: result.created, updated: result.updated, pending: result.pending } }));
} catch { console.error('Incident issue synchronization failed; no private error details were logged. Retry on the next serialized workflow run.'); process.exitCode = 1; }
