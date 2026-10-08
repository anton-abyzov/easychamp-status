import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const registry = JSON.parse(await readFile('config/components.json', 'utf8'));
assert.deepEqual(registry.groups.map(g => g.id), ['websites', 'accounts', 'interactive', 'media', 'results', 'player-data', 'platform']);
assert.equal(registry.components.length, 43);
const ids = registry.components.map(c => c.id);
assert.equal(new Set(ids).size, ids.length);
for (const c of registry.components) { if (c.freshness) assert(['destination_validation','scheduled_run','cluster_resources'].includes(c.measurementKind)); assert(registry.groups.some(g => g.id === c.group)); for (const id of c.probes || []) assert(registry.probes.some(p => p.id === id)); }
for (const p of registry.probes) {
  assert(p.url.startsWith('https://')); assert(!new URL(p.url).username); assert(p.expiresSeconds > 0);
  if (p.semanticHealth !== undefined) {
    assert.equal(p.semanticHealth, true);
    assert.equal(p.type, 'http');
    assert.equal(p.id, 'assistant-health');
    assert.equal(p.url, 'https://easychamp.com/ec-chat-api/assistant/v1/health');
    assert(!p.monitorAuth);
  }
  if (p.jsonEquals !== undefined) {
    assert(p.jsonEquals && typeof p.jsonEquals === 'object' && !Array.isArray(p.jsonEquals));
    assert(Object.values(p.jsonEquals).every(v => v === null || ['string', 'number', 'boolean'].includes(typeof v)));
  }
}
assert.deepEqual(registry.components.find(c => c.id === 'assistant')?.probes, ['assistant-health']);
const text = JSON.stringify(registry);
assert(!/svc\.cluster\.local|\.internal|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|SG\.[A-Za-z0-9_-]{20,}|"(?:password|credential|Authorization)"\s*:/i.test(text));
console.log('Public registry and projection validated.');
