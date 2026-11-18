// Entry point. Only the default export lives here: the Workers runtime rejects extra named exports.
// Probing and publishing logic is in core.mjs (also imported by the tests).
import { collect, KEY } from './core.mjs';
const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };

export default {
  async scheduled(_event, env) { try { await collect(env); } catch (error) { console.error("vantage_collect_failed", String(error)); throw error; } },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/v1/latest') return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: JSON_HEADERS });
    if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405, headers: { ...JSON_HEADERS, allow: 'GET' } });
    const body = await env.VANTAGE.get(KEY);
    if (!body) return new Response(JSON.stringify({ error: 'no_result' }), { status: 503, headers: JSON_HEADERS });
    return new Response(body, { headers: JSON_HEADERS });
  },
};
