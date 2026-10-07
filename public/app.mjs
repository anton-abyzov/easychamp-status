import { viewState, LABELS, REASONS, rollup, time } from './model.mjs';
import { normalizeIncidents, STAGE_LABELS, safePublicUrl } from './incident-model.mjs';

let registry, state, history, incidents, currentView, loading = false, failed = false;
let detailOrigin = null, previousHash = '', renderedRoute = '';
const $ = selector => document.querySelector(selector);
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const badge = status => el('span', `badge ${status}`, LABELS[status] || LABELS.unknown);
const link = (text, href, className = '') => { const a = el('a', className, text); a.href = href; return a; };
const route = (kind, id, day) => `#${kind}/${encodeURIComponent(id)}${day ? `/${day}` : ''}`;
const complete = c => c.samples.every(s => s.status !== 'unknown');
const dateAt = offset => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
const days = () => Array.from({ length: 90 }, (_, i) => dateAt(89 - i));
function age(at) { if (!time(at)) return 'unavailable'; const m = Math.max(0, Math.floor((Date.now() - time(at)) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} hr ago` : `${Math.floor(m / 1440)} days ago`; }
function stamp(at) { return time(at) ? new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Time unavailable'; }
function dateLabel(date) { return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
function external(text, url, className = 'detail-link') { const safe = safePublicUrl(url); return safe ? link(`${text} ↗`, safe, className) : null; }
function observation(ids, date) {
  const counts = {}, statuses = []; let missing = 0;
  for (const id of ids) {
    const daily = history.days?.[date]?.[id] || {};
    const samples = Object.entries(daily).filter(([s, n]) => Object.hasOwn(LABELS, s) && Number.isFinite(n) && n > 0);
    if (!samples.length) missing++;
    statuses.push({ status: rollup(samples.map(([status]) => ({ status }))) });
    for (const [status, n] of samples) counts[status] = (counts[status] || 0) + n;
  }
  return { status: rollup(statuses), counts, missing, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}
function historyStrip(ids) {
  const bars = el('div', 'bars'); bars.setAttribute('aria-hidden', 'true');
  for (const day of days()) bars.append(el('span', `bar ${observation(ids, day).status}`));
  return bars;
}
function incidentCard(i) {
  const card = link('', route('incident', i.id), 'incident-card');
  const top = el('div', 'incident-title-row'); top.append(el('h3', '', i.title), el('span', 'row-arrow', '›'));
  const meta = el('div', 'incident-meta');
  meta.append(el('span', `incident-stage ${i.resolvedAt ? 'resolved' : 'active'}`, STAGE_LABELS[i.stage] || (i.resolvedAt ? 'Resolved' : 'Investigating')), el('time', '', stamp(i.updatedAt || i.openedAt)));
  if (i.postmortem?.state === 'published') meta.append(el('span', '', 'Postmortem published'));
  card.append(top, meta); return card;
}
function render() {
  if (!registry) return;
  currentView = viewState(registry, state);
  const overall = rollup([{ status: currentView.status }, currentView.collector]);
  const count = currentView.components.filter(complete).length;
  const titles = { operational: 'Configured checks are passing', degraded: 'Some services are degraded', partial_outage: 'Some services have issues', major_outage: 'Service outage detected', unknown: 'Some service status is unknown', maintenance: 'Maintenance in progress' };
  $('#overview-title').textContent = titles[overall];
  $('#overview-description').textContent = `${count} of ${currentView.components.length} services have complete current checks${count < currentView.components.length ? ` · ${currentView.components.length - count} with unknown coverage` : ''}.`;
  $('#overall-badge').replaceWith(Object.assign(badge(overall), { id: 'overall-badge' }));
  $('#overall-icon').className = `status-symbol ${overall}`;
  $('#overall-icon').textContent = overall === 'operational' ? '✓' : overall === 'unknown' ? '?' : '!';
  $('#collector-age').textContent = failed ? 'Refresh failed · current evidence unavailable' : `Updated ${age(state.generatedAt)}${currentView.collector.status === 'unknown' ? ' · collection stale' : ''}`;
  $('#service-count').textContent = currentView.components.length;
  const groups = $('#groups'); const open = new Set([...groups.querySelectorAll('details[open]')].map(n => n.dataset.group));
  const activeElement = document.activeElement;
  const focusedGroup = activeElement?.closest('.group-details')?.dataset.group;
  const focusedHref = activeElement?.getAttribute('href');
  groups.replaceChildren(); groups.setAttribute('aria-busy', 'false');
  for (const group of currentView.groups) {
    const card = el('div', 'group'), details = el('details', 'group-details'); details.dataset.group = group.id; details.open = open.has(group.id);
    const summary = el('summary'); const heading = el('div', 'group-heading');
    const verified = group.components.filter(complete).length, unknown = group.components.length - verified;
    heading.append(el('div', 'group-title', group.name), el('div', 'group-coverage', `${verified}/${group.components.length} current${unknown ? ` · ${unknown} unknown` : ' · all configured checks covered'}`));
    summary.append(el('span', 'chevron'), heading, badge(group.status)); details.append(summary);
    const children = el('div', 'components');
    for (const c of group.components) {
      const row = link('', route('component', c.id), 'component-link'); const status = el('span', 'component-status');
      status.append(badge(c.status), el('span', 'row-arrow', '›')); row.append(el('span', 'component-name', c.name), status); children.append(row);
    }
    details.append(children);
    const chartLink = link('', route('group', group.id), 'group-history'); chartLink.setAttribute('aria-label', `${group.name}: view 90-day observed history`); chartLink.title = 'Open daily observations'; chartLink.append(historyStrip(group.components.map(c => c.id)));
    card.append(details, chartLink); groups.append(card);
  }
  if (focusedGroup) {
    const group = [...groups.querySelectorAll('.group-details')].find(n => n.dataset.group === focusedGroup);
    const target = focusedHref ? [...(group?.querySelectorAll('a') || [])].find(n => n.getAttribute('href') === focusedHref) : group?.querySelector('summary');
    target?.focus({ preventScroll: true });
  } else if (focusedHref && activeElement?.classList.contains('group-history')) [...groups.querySelectorAll('.group-history')].find(n => n.getAttribute('href') === focusedHref)?.focus({ preventScroll: true });
  const all = normalizeIncidents(incidents).sort((a,b) => (time(b.updatedAt || b.openedAt) || 0) - (time(a.updatedAt || a.openedAt) || 0));
  const active = all.filter(i => !i.resolvedAt), past = all.filter(i => i.resolvedAt).slice(0, 30);
  $('#active-incidents').hidden = !active.length; $('#active-count').textContent = active.length === 1 ? '1 ongoing' : `${active.length} ongoing`;
  $('#active-list').replaceChildren(...active.map(incidentCard));
  $('#incident-history').replaceChildren(...(past.length ? past.map(incidentCard) : [el('p', 'empty', 'No resolved incidents in the collected history.')]));
  $('#legend').replaceChildren(...Object.keys(LABELS).map(badge));
  // Re-evaluate open details too: a passing check must expire while it is being read.
  const dialog = $('#detail-dialog'), scroll = dialog.scrollTop;
  const focusId = dialog.contains(document.activeElement) ? document.activeElement.id : '';
  const focusedDay = dialog.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : '';
  if (dialog.open) renderedRoute = '';
  showRoute();
  if (dialog.open) { dialog.scrollTop = scroll; if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true }); else if (focusedDay) [...dialog.querySelectorAll('[aria-label]')].find(n => n.getAttribute('aria-label') === focusedDay)?.focus({ preventScroll: true }); }
}
function section(title) { const node = el('section', 'detail-section'); node.append(el('h3', '', title)); return node; }
function addHistory(parent, ids, kind, id, selectedDay) {
  const dates = days(), day = dates.includes(selectedDay) ? selectedDay : dates.at(-1);
  const sec = section('Observed history'); sec.append(el('p', '', 'Daily checks over 90 days. Unknown includes missing evidence; this is not continuous uptime.'));
  const chart = el('div', 'history-chart'), bars = el('div', 'bars'); bars.setAttribute('role', 'group'); bars.setAttribute('aria-label', 'Daily observations. Use left and right arrows to choose a day.');
  const goDay = next => { window.history.replaceState(window.history.state, '', route(kind, id, next)); renderedRoute = ''; showRoute(); $('#history-date')?.focus({ preventScroll: true }); };
  dates.forEach((date, index) => {
    const data = observation(ids, date), button = el('button', `bar day-button ${data.status}`); button.type = 'button'; button.tabIndex = date === day ? 0 : -1;
    button.setAttribute('aria-label', `${dateLabel(date)} UTC: ${LABELS[data.status]}, ${data.total} observations`); button.setAttribute('aria-pressed', String(date === day)); button.title = button.getAttribute('aria-label');
    button.addEventListener('click', () => goDay(date));
    button.addEventListener('keydown', event => { if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? dates.length-1 : Math.min(dates.length-1, Math.max(0, index + (event.key === 'ArrowRight' ? 1 : -1))); goDay(dates[next]); const buttons = $('#detail-content').querySelectorAll('.day-button'); buttons[next]?.focus(); });
    bars.append(button);
  });
  const labels = el('div', 'bar-labels'); labels.append(el('span', '', dateLabel(dates[0])), el('span', '', 'Today · UTC')); chart.append(bars, labels); sec.append(chart);
  const control = el('div', 'date-control'), label = el('label', '', 'View day'); label.htmlFor = 'history-date'; const input = el('input'); input.type = 'date'; input.id = 'history-date'; input.min = dates[0]; input.max = dates.at(-1); input.value = day; input.addEventListener('change', () => { if (dates.includes(input.value)) goDay(input.value); }); control.append(label, input); sec.append(control);
  const data = observation(ids, day), detail = el('div', 'observation-detail'); detail.append(el('strong', '', `${dateLabel(day)} · UTC`), el('p', '', data.total ? `${data.total} recorded observations${data.missing ? ` · ${data.missing} service${data.missing === 1 ? '' : 's'} without observations` : ''}` : 'No observations recorded for this day.'));
  const counts = el('div', 'observation-counts'); for (const [status, count] of Object.entries(data.counts)) counts.append(el('span', status, `${LABELS[status]}: ${count}`)); detail.append(counts); sec.append(detail); parent.append(sec);
}
function componentDetail(c, selectedDay) {
  const body = el('div'); body.append(el('h2', 'detail-title', c.name), badge(c.status)); body.querySelector('h2').id = 'detail-title';
  const scope = section('What is checked'); scope.append(el('p', '', c.coverage), el('div', 'detail-meta', `Last observation: ${stamp(c.observedAt)} · ${age(c.observedAt)}`)); body.append(scope);
  const checks = section('Current checks'), list = el('ul', 'check-list');
  c.samples.forEach(sample => { const probe = registry.probes.find(p => p.id === sample.sourceId); const item = el('li'), text = el('div'); const name = c.freshness ? 'Scheduled import & destination' : probe?.type === 'browser' ? 'Page rendering' : probe?.type === 'http' ? 'HTTP content check' : 'Functional monitoring';
    text.append(el('div', 'check-name', name), el('div', 'check-reason', REASONS[sample.reasonCode] || 'Evidence unavailable'));
    const metrics = [sample.lcpMs ? `LCP ${(sample.lcpMs/1000).toFixed(1)}s` : '', sample.responseMs ? `Response ${(sample.responseMs/1000).toFixed(1)}s` : ''].filter(Boolean);
    if (metrics.length) text.append(el('div', 'check-reason', metrics.join(' · '))); item.append(text, badge(sample.status)); list.append(item);
  }); checks.append(list); body.append(checks);
  addHistory(body, [c.id], 'component', c.id, selectedDay);
  const related = normalizeIncidents(incidents).filter(i => i.componentId === c.id || i.componentIds?.includes(c.id));
  if (related.length) { const updates = section('Incident updates'); related.slice(0,10).forEach(i => updates.append(incidentCard(i))); body.append(updates); }
  return body;
}
function groupDetail(g, selectedDay) {
  const body = el('div'), title = el('h2', 'detail-title', g.name); title.id = 'detail-title'; body.append(title, badge(g.status), el('p', 'detail-lead', g.description));
  const services = section('Services'); g.components.forEach(c => { const a = link('', route('component', c.id), 'component-link'); a.append(el('span', 'component-name', c.name), badge(c.status)); services.append(a); }); body.append(services);
  addHistory(body, g.components.map(c => c.id), 'group', g.id, selectedDay); return body;
}
function incidentDetail(i) {
  const body = el('div'), title = el('h2', 'detail-title', i.title); title.id = 'detail-title'; body.append(title, el('span', `incident-stage ${i.resolvedAt ? 'resolved' : 'active'}`, STAGE_LABELS[i.stage] || 'Investigating'), el('p', 'detail-meta', `Opened ${stamp(i.openedAt)}${i.resolvedAt ? ` · Resolved ${stamp(i.resolvedAt)}` : ''}`));
  const affected = section('Affected services'), links = el('div', 'affected-links'); const ids = new Set([i.componentId, ...(i.componentIds || [])].filter(Boolean));
  for (const id of ids) { const c = currentView.components.find(c => c.id === id); if (c) links.append(link(c.name, route('component', id))); } affected.append(links); if (links.children.length) body.append(affected);
  const sec = section('Updates'), timeline = el('ol', 'timeline');
  [...(i.updates || [])].reverse().sort((a,b) => (time(b.at)||0)-(time(a.at)||0)).forEach(update => { const item = el('li', update.stage); item.append(el('h3', '', STAGE_LABELS[update.stage] || 'Update'), el('p', '', update.message), el('time', '', `${stamp(update.at)}${update.source === 'monitor' ? ' · Automated check' : ''}`)); timeline.append(item); });
  sec.append(timeline); body.append(sec);
  if (i.postmortem?.state === 'published') { const post = el('section', 'postmortem'); post.append(el('h3', '', 'Postmortem')); if (i.postmortem.summary) post.append(el('p', '', i.postmortem.summary)); const a = external('Read the postmortem', i.postmortem.url); if (a) post.append(a); body.append(post); }
  const issue = external('Follow updates on GitHub', i.issue?.url); if (issue) body.append(issue); return body;
}
function showRoute() {
  if (!currentView) return;
  const match = location.hash.match(/^#(component|group|incident)\/([^/]+)(?:\/(\d{4}-\d{2}-\d{2}))?$/), dialog = $('#detail-dialog');
  if (!match) { if (dialog.open) { dialog.close(); const origin = detailOrigin?.isConnected ? detailOrigin : [...document.querySelectorAll('a[href]')].find(a => a.getAttribute('href') === detailOrigin?.getAttribute('href')); (origin || $('#services-title')).focus({ preventScroll: true }); } renderedRoute = ''; return; }
  if (renderedRoute === location.hash && dialog.open) return;
  let id; try { id = decodeURIComponent(match[2]); } catch { id = ''; }
  const [, kind, , day] = match; let body;
  const item = kind === 'component' ? currentView.components.find(c => c.id === id) : kind === 'group' ? currentView.groups.find(g => g.id === id) : normalizeIncidents(incidents).find(i => i.id === id);
  if (item) body = kind === 'component' ? componentDetail(item, day) : kind === 'group' ? groupDetail(item, day) : incidentDetail(item);
  else { body = el('div'); const title = el('h2', 'detail-title', 'Details unavailable'); title.id = 'detail-title'; body.append(title, el('p', '', 'This service or incident is not present in the current monitoring data.')); }
  $('#detail-kind').textContent = kind === 'incident' ? 'INCIDENT DETAILS' : kind === 'group' ? 'GROUP HISTORY' : 'SERVICE DETAILS';
  $('#detail-content').replaceChildren(body); renderedRoute = location.hash;
  if (!dialog.open) { detailOrigin = document.activeElement; dialog.showModal(); $('#close-detail').focus(); }
  dialog.scrollTop = 0;
}
function closeDetail() {
  // Click-opened routes have a same-page history entry; direct links close in place.
  if (window.history.state?.statusDetail) window.history.go(-window.history.state.statusDetail);
  else { window.history.replaceState(window.history.state, '', `${location.pathname}${location.search}${previousHash}`); showRoute(); }
}
document.addEventListener('click', event => { const a = event.target.closest('a[href^="#"]'); if (!a || !/^#(component|group|incident)\//.test(a.getAttribute('href')) || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); if (!$('#detail-dialog').open) previousHash = location.hash; window.history.pushState({ statusDetail: (window.history.state?.statusDetail || 0) + 1 }, '', a.getAttribute('href')); renderedRoute = ''; showRoute(); });
document.querySelector('a[href="#method"]').addEventListener('click', () => { $('#method').open = true; });
$('#close-detail').addEventListener('click', closeDetail);
$('#detail-dialog').addEventListener('cancel', event => { event.preventDefault(); closeDetail(); });
$('#detail-dialog').addEventListener('click', event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) closeDetail(); } });
window.addEventListener('hashchange', () => { renderedRoute = ''; showRoute(); });
window.addEventListener('popstate', () => { renderedRoute = ''; showRoute(); });
async function load() {
  if (loading) return; loading = true; $('#refresh').disabled = true;
  try {
    const values = await Promise.all(['components','status','history','incidents'].map(async name => { const r = await fetch(`./data/${name}.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error('unavailable'); return r.json(); }));
    const [nextRegistry, nextState, nextHistory, nextIncidents] = values;
    if (!nextRegistry || !['groups', 'components', 'probes'].every(key => Array.isArray(nextRegistry[key])) || !nextState || typeof nextState !== 'object' || !nextHistory || typeof nextHistory !== 'object' || !nextIncidents || typeof nextIncidents !== 'object') throw new Error('invalid data');
    if (!nextRegistry.components.every(c => c && typeof c.id === 'string' && typeof c.name === 'string' && (!c.probes || Array.isArray(c.probes))) || !nextRegistry.groups.every(g => g && typeof g.id === 'string' && typeof g.name === 'string') || !nextRegistry.probes.every(p => p && typeof p.id === 'string')) throw new Error('invalid registry');
    [registry, state, history, incidents] = values; failed = false; render();
  } catch {
    failed = true;
    if (registry) { state = { ...state, generatedAt: null, probes: {}, freshness: {} }; renderedRoute = ''; render(); }
    else { $('#overview-title').textContent = 'Service status unavailable'; $('#overview-description').textContent = 'Monitoring data could not load. Current availability is Unknown.'; $('#collector-age').textContent = 'Refresh failed'; $('#groups').setAttribute('aria-busy', 'false'); $('#groups').replaceChildren(el('p', 'empty', 'Service checks unavailable. Try Refresh or view the timestamped data below.')); $('#incident-history').replaceChildren(el('p', 'empty', 'Incident data is unavailable.')); }
  } finally { loading = false; $('#refresh').disabled = false; }
}
$('#refresh').addEventListener('click', () => { renderedRoute = ''; load(); });
await load(); setInterval(render, 30000); setInterval(load, 60000);
