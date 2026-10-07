const HOSTS = new Set(['watch.easychamp.com', 'dcfc.at.easychamp.com', 'dcfc.easychamp.com', 'ps23-soccer-league.easychamp.com', 'soccer-nationals.easychamp.com']);
const PAGES = new Set(['/', '/main', '/schedule', '/competitions']);
export function allowMonitorHeader(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && HOSTS.has(url.hostname) && !url.port && !url.username && !url.password && ((PAGES.has(url.pathname) && !url.search) || /^\/_next\/(static\/|data\/)/.test(url.pathname) || ['/_next/image', '/_next/img.webp'].includes(url.pathname)); } catch { return false; }
}
export function monitorHeaders(url, token, headers = {}) {
  const clean = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'x-ec-status-monitor'));
  if (token && allowMonitorHeader(url)) clean['x-ec-status-monitor'] = token;
  return clean;
}
export async function safeFetch(url, options, token) {
  let current = url;
  for (let i = 0; i < 6; i++) {
    const response = await fetch(current, { ...options, redirect: 'manual', headers: monitorHeaders(current, token, options.headers) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location'); await response.body?.cancel();
    if (!location) return response;
    current = new URL(location, current).href;
    if (new URL(current).protocol !== 'https:') throw new Error('unsafe_redirect');
  }
  throw new Error('redirect_limit');
}
