import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { githubClient, repositoryName } from './incidents-github.mjs';
import { applyOwnerUpdate } from './incidents.mjs';

export async function authorizeOwnerEvent(event, env, request) {
  const repository = env.GITHUB_REPOSITORY;
  const actor = event?.sender?.login;
  const branch = event?.repository?.default_branch;
  if (!repositoryName(repository) || event?.repository?.full_name !== repository || !branch || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== `refs/heads/${branch}` || actor !== env.GITHUB_ACTOR || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(actor || '') || !/^\d+$/.test(env.GITHUB_RUN_ID || '')) throw new Error('untrusted_owner_workflow');
  const checked = await request('GET', `/repos/${repository}/collaborators/${actor}/permission`);
  if (!['admin', 'maintain', 'write'].includes(checked?.permission)) throw new Error('owner_permission_required');
  return { login: actor, at: new Date().toISOString(), updateId: `owner-${env.GITHUB_RUN_ID}` };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const context = await authorizeOwnerEvent(event, process.env, githubClient(process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN));
    const payload = JSON.parse(await readFile('data/incidents.json', 'utf8'));
    const next = applyOwnerUpdate(payload, { incidentId: event.inputs?.incident_id, stage: event.inputs?.stage, message: event.inputs?.message, url: event.inputs?.postmortem_url || '' }, context);
    await writeFile('data/incidents.json', JSON.stringify(next, null, 2) + '\n');
    console.log(JSON.stringify({ incidentUpdate: 'validated', stage: event.inputs.stage }));
  } catch { console.error('Incident update rejected: use an authorized default-branch workflow with a valid incident, public-safe text and reviewed HTTPS write-up URL.'); process.exitCode = 1; }
}
