const RESOURCE_TYPES = new Set(['document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'xhr', 'fetch', 'eventsource', 'websocket', 'manifest', 'other']);

export function blockedRequestEvidence({ resourceType, headers = {}, url }) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const explicitPrefetch = normalized['next-router-prefetch'] === '1' ||
    ['purpose', 'sec-purpose'].some(key => typeof normalized[key] === 'string' && normalized[key].trim().toLowerCase() === 'prefetch');
  let isNextAsset = false;
  try {
    const path = new URL(url).pathname;
    isNextAsset = path.startsWith('/_next/static/') || path.startsWith('/_next/data/') || ['/_next/image', '/_next/img.webp'].includes(path);
  } catch { /* Missing paths cannot establish asset coverage. */ }
  return { resourceType: RESOURCE_TYPES.has(resourceType) ? resourceType : 'other', explicitPrefetch, isNextAsset };
}

export function initialRenderBlocked(requests) {
  return requests.some(request => !request.explicitPrefetch);
}

export function blockedRequestCounts(requests) {
  const groups = new Map();
  for (const request of requests) {
    const key = JSON.stringify(request);
    const group = groups.get(key) || { ...request, count: 0 };
    group.count++;
    groups.set(key, group);
  }
  return [...groups.values()];
}
