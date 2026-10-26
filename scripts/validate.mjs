import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const registry = JSON.parse(await readFile('config/components.json', 'utf8'));
assert.deepEqual(registry.groups.map(g => g.id), ['websites', 'regional', 'accounts', 'interactive', 'media', 'results', 'player-data', 'platform']);
assert.equal(registry.components.length, 45);
const ids = registry.components.map(c => c.id);
assert.equal(new Set(ids).size, ids.length);
for (const c of registry.components) { if (c.freshness) assert(['destination_validation','scheduled_run','cluster_resources'].includes(c.measurementKind)); assert(registry.groups.some(g => g.id === c.group)); for (const id of c.probes || []) assert(registry.probes.some(p => p.id === id)); }
for (const p of registry.probes) {
  if (p.type === 'edge') {
    assert.match(p.zoneTag, /^[0-9a-f]{32}$/); assert.match(p.colo, /^[A-Z]{3}$/); assert(p.location && !p.url);
    assert(0 < p.degradedShare && p.degradedShare < p.partialShare && p.partialShare < p.majorShare && p.majorShare <= 1);
    assert(Number.isInteger(p.minErrors) && p.minErrors >= 1 && Number.isInteger(p.minRequests) && p.minRequests >= p.minErrors && Number.isInteger(p.minErrorMinutes) && p.minErrorMinutes >= 2);
    assert(Array.isArray(p.hosts) && p.hosts.length && p.hosts.every(h => /^[a-z0-9.-]+\.easychamp\.com$|^easychamp\.com$/.test(h)));
    // A verdict must outlive the longest window that can follow it, or quiet locations never chain two.
    assert(p.lagSeconds >= 60 && p.windowSeconds >= 60 && p.maxWindowSeconds >= p.windowSeconds && p.expiresSeconds >= p.maxWindowSeconds + p.lagSeconds + 300);
    continue;
  }
  assert(['http', 'browser'].includes(p.type)); assert(p.url.startsWith('https://')); assert(!new URL(p.url).username); assert(p.expiresSeconds > 0);
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
