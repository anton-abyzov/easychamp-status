import { incidentDocument } from './incidents.mjs';

export const repositoryName = value => typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) && !value.includes('..');
export function githubClient(repository, token, send = fetch) {
  if (!repositoryName(repository) || !token) throw new Error('github_not_configured');
  let calls = 0;
  return async (method, path, body) => {
    if (++calls > 40 || !path.startsWith(`/repos/${repository}/`)) throw new Error('github_request_bound');
    const response = await send(`https://api.github.com${path}`, { method, signal: AbortSignal.timeout(10000), redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('github_request_failed'); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('github_response_invalid');
    let size = 0; const chunks = [];
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2000000) { await reader.cancel(); throw new Error('github_response_bound'); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('github_response_invalid'); }
  };
}
export const issueMarker = incident => `<!-- easychamp-incident:${incident.id} -->`;
export function issueBody(incident) {
  const timeline = incident.updates.slice(-80).map(update => `- ${update.at} — ${update.stage} (${update.source}${update.author?.login ? `: ${update.author.login}` : ''}): ${update.message}`).join('\n');
  const postmortem = incident.postmortem ? `\n\n## Postmortem ${incident.postmortem.state}\n\n${incident.postmortem.summary}${incident.postmortem.state === 'published' ? `\n\nReviewed write-up: ${incident.postmortem.url}` : '\n\nOwner review required: establish root cause, actual user impact, remediation and prevention. This draft is public evidence only; it is not a published write-up.'}` : '';
  return `${issueMarker(incident)}\n\nConfirmed service incident for **${incident.componentId}**.\n\nStage: ${incident.stage}\nFirst confirmed: ${incident.openedAt}\n${incident.deadlineAt ? `Observed schedule deadline: ${incident.deadlineAt}\n` : ''}${incident.resolvedAt ? `Recovery confirmed: ${incident.resolvedAt}` : 'Recovery: unconfirmed. Two fresh successful observations are required.'}\n\n## Timeline\n\n${timeline}${incident.updates.length > 80 ? '\n\nEarlier updates remain in data/incidents.json.' : ''}${postmortem}\n\nOwner updates use the permission-checked default-branch “Manage incident” workflow; issue comments do not change public status. Do not add private logs or credentials to this public issue.`;
}
export async function syncIncidentIssues(payload, repository, request) {
  if (!repositoryName(repository)) throw new Error('invalid_repository');
  const incidents = incidentDocument(payload).incidents;
  if (!incidents.length) return { payload: { schemaVersion: 1, incidents }, created: 0, updated: 0, pending: 0 };
  const issues = [];
  // Complete this bounded search before any mutation. Missing a marker must not
  // create a duplicate just because pagination or GitHub was unavailable.
  for (let page = 1; page <= 5; page++) {
    const rows = await request('GET', `/repos/${repository}/issues?state=all&per_page=100&page=${page}&sort=created&direction=desc`);
    if (!Array.isArray(rows)) throw new Error('github_response_invalid');
    issues.push(...rows.filter(row => !row.pull_request));
    if (rows.length < 100) break;
    if (page === 5) throw new Error('github_issue_search_bound');
  }
  let created = 0; let updated = 0; let pending = 0; let writes = 0;
  for (const incident of incidents) {
    const marker = issueMarker(incident);
    const matches = issues.filter(issue => typeof issue.body === 'string' && issue.body.includes(marker));
    if (matches.length > 1) throw new Error('duplicate_incident_issue_marker');
    let issue = matches[0];
    if (incident.issue && (!issue || issue.number !== incident.issue.number)) {
      issue = await request('GET', `/repos/${repository}/issues/${incident.issue.number}`);
      if (!issue?.body?.includes(marker) || issue.pull_request || (matches[0] && matches[0].number !== issue.number)) throw new Error('incident_issue_mapping_mismatch');
    }
    if (issue && issue.user?.login !== 'github-actions[bot]') throw new Error('incident_issue_author_mismatch');
    const desired = { title: incident.title, body: issueBody(incident), state: incident.resolvedAt ? 'closed' : 'open' };
    if (issue && issue.title === desired.title && issue.body === desired.body && issue.state === desired.state) {
      incident.issue = { number: issue.number, url: `https://github.com/${repository}/issues/${issue.number}` };
      continue;
    }
    if (writes + (!issue && desired.state === 'closed' ? 2 : 1) > 20) { pending++; continue; }
    const saved = issue ? await request('PATCH', `/repos/${repository}/issues/${issue.number}`, desired) : await request('POST', `/repos/${repository}/issues`, { title: desired.title, body: desired.body });
    writes++;
    if (!Number.isSafeInteger(saved?.number) || saved.number <= 0) throw new Error('github_response_invalid');
    incident.issue = { number: saved.number, url: `https://github.com/${repository}/issues/${saved.number}` };
    // Creating a previously resolved legacy record needs a separate close.
    if (!issue && desired.state === 'closed') { await request('PATCH', `/repos/${repository}/issues/${saved.number}`, { state: 'closed' }); writes++; }
    if (issue) updated++; else created++;
  }
  return { payload: { schemaVersion: 1, incidents }, created, updated, pending };
}
