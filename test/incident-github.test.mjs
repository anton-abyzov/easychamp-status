import test from 'node:test';
import assert from 'node:assert/strict';
import { githubClient, syncIncidentIssues, issueBody } from '../scripts/incidents-github.mjs';
import { authorizeOwnerEvent } from '../scripts/incidents-owner.mjs';
import { incidentDocument } from '../scripts/incidents.mjs';

const repository = 'owner/status';
const row = id => incidentDocument({ schemaVersion: 1, incidents: [{ id: id || 'test-feed-123', componentId: id || 'test-feed', title: 'Test feed: degraded service', status: 'degraded', reasonCode: 'run_failed', openedAt: '2026-10-07T18:00:00Z', updatedAt: '2026-10-07T18:00:00Z', resolvedAt: null }] }).incidents[0];
function api(initial = []) {
  const issues = structuredClone(initial); const calls = [];
  return { issues, calls, async request(method, path, body) {
    calls.push({ method, path, body });
    if (method === 'GET' && path.includes('?')) return structuredClone(issues);
    const number = Number(path.split('/').at(-1));
    if (method === 'GET') return structuredClone(issues.find(issue => issue.number === number));
    if (method === 'POST') { const issue = { ...body, number: issues.length + 1, state: 'open', user: { login: 'github-actions[bot]' } }; issues.push(issue); return structuredClone(issue); }
    const issue = issues.find(issue => issue.number === number); Object.assign(issue, body); return structuredClone(issue);
  } };
}
test('deterministic marker reconciles a crash before mapping persistence without duplicate issues', async () => {
  const payload = { schemaVersion: 1, incidents: [row()] }; const server = api();
  const first = await syncIncidentIssues(payload, repository, server.request); assert.equal(first.created, 1); assert.equal(first.payload.incidents[0].issue.number, 1);
  const second = await syncIncidentIssues(payload, repository, server.request); assert.equal(second.created, 0); assert.equal(second.updated, 0); assert.equal(server.issues.length, 1);
  const persisted = await syncIncidentIssues(JSON.parse(JSON.stringify(first.payload)), repository, server.request); assert.equal(persisted.updated, 0); assert.equal(server.calls.filter(call => call.method === 'POST').length, 1);
});
test('confirmed recovery closes the mapped issue and adds an evidence-only draft exactly once', async () => {
  const server = api(); const first = await syncIncidentIssues({ schemaVersion: 1, incidents: [row()] }, repository, server.request);
  const recovered = first.payload.incidents[0]; recovered.resolvedAt = '2026-10-07T18:20:00Z'; recovered.stage = 'resolved'; recovered.postmortem = { state: 'draft', summary: 'Evidence-only draft. Root cause requires owner review.', generatedAt: recovered.resolvedAt };
  const next = await syncIncidentIssues(first.payload, repository, server.request); assert.equal(next.updated, 1); assert.equal(server.issues[0].state, 'closed'); assert.match(server.issues[0].body, /not a published write-up/);
  assert.equal((await syncIncidentIssues(next.payload, repository, server.request)).updated, 0);
});
test('legacy resolved records get one issue then a separate close without claiming a published write-up', async () => {
  const incident = row(); incident.resolvedAt = '2026-10-07T18:20:00Z';
  const server = api(); const result = await syncIncidentIssues({ schemaVersion: 1, incidents: [incident] }, repository, server.request);
  assert.equal(result.created, 1); assert.equal(server.issues[0].state, 'closed'); assert(!server.issues[0].body.includes('Reviewed write-up:'));
});
test('mapping or marker ownership mismatch aborts before any issue write', async () => {
  const incident = row(); incident.issue = { number: 2, url: 'https://github.com/owner/status/issues/2' };
  const wrongMap = api([{ number: 2, body: 'unrelated', user: { login: 'github-actions[bot]' } }]);
  await assert.rejects(syncIncidentIssues({ schemaVersion: 1, incidents: [incident] }, repository, wrongMap.request), /mapping_mismatch/); assert(wrongMap.calls.every(call => call.method === 'GET'));
  const impostor = api([{ number: 1, body: issueBody(row()), user: { login: 'untrusted' } }]);
  await assert.rejects(syncIncidentIssues({ schemaVersion: 1, incidents: [row()] }, repository, impostor.request), /author_mismatch/); assert(impostor.calls.every(call => call.method === 'GET'));
  const duplicate = api([{ number: 1, body: issueBody(row()) }, { number: 2, body: issueBody(row()) }]);
  await assert.rejects(syncIncidentIssues({ schemaVersion: 1, incidents: [row()] }, repository, duplicate.request), /duplicate_incident_issue_marker/); assert(duplicate.calls.every(call => call.method === 'GET'));
});
test('incomplete bounded issue search must never create a duplicate', async () => {
  const calls = [];
  await assert.rejects(syncIncidentIssues({ schemaVersion: 1, incidents: [row()] }, repository, async (method, path) => { calls.push({ method, path }); return Array.from({ length: 100 }, (_value, index) => ({ number: index + 1, body: '' })); }), /search_bound/);
  assert.equal(calls.length, 5); assert(calls.every(call => call.method === 'GET'));
});
test('issue mutations are bounded and excess confirmed incidents remain pending for the next run', async () => {
  const server = api(); const payload = { schemaVersion: 1, incidents: Array.from({ length: 23 }, (_value, index) => row(`test-feed-${index}`)) };
  const result = await syncIncidentIssues(payload, repository, server.request); assert.equal(result.created, 20); assert.equal(result.pending, 3); assert.equal(server.calls.filter(call => call.method !== 'GET').length, 20);
  assert.equal((await syncIncidentIssues(result.payload, repository, server.request)).created, 3);
});
test('GitHub HTTP failures never expose response or credential content', async () => {
  const request = githubClient(repository, 'private-test-token', async (_url, options) => { assert.equal(options.redirect, 'error'); return new Response('private response details', { status: 403 }); });
  await assert.rejects(request('GET', `/repos/${repository}/issues`), error => error.message === 'github_request_failed');
  await assert.rejects(request('GET', '/repos/other/repo/issues'), /request_bound/);
  const oversized = githubClient(repository, 'private-test-token', async () => new Response('x'.repeat(2000001)));
  await assert.rejects(oversized('GET', `/repos/${repository}/issues`), /response_bound/);
});
test('owner workflow requires default branch, matching actor and current collaborator write permission', async () => {
  const event = { sender: { login: 'owner' }, repository: { full_name: repository, default_branch: 'main' } };
  const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: repository, GITHUB_ACTOR: 'owner', GITHUB_RUN_ID: '123' };
  let calls = 0; const authorized = async () => { calls++; return { permission: 'write' }; };
  assert.equal((await authorizeOwnerEvent(event, env, authorized)).updateId, 'owner-123'); assert.equal(calls, 1);
  await assert.rejects(authorizeOwnerEvent(event, { ...env, GITHUB_REF: 'refs/heads/untrusted' }, authorized), /untrusted/); assert.equal(calls, 1);
  await assert.rejects(authorizeOwnerEvent(event, { ...env, GITHUB_ACTOR: 'other' }, authorized), /untrusted/);
  await assert.rejects(authorizeOwnerEvent(event, env, async () => ({ permission: 'read' })), /permission_required/);
});
