import { viewState, LABELS, REASONS, rollup, time } from './model.mjs';
import { normalizeIncidents, STAGE_LABELS, safePublicUrl, displayIncidentTitle } from './incident-model.mjs';
import { availabilityStats } from './availability.mjs';

let registry, state, history, incidents, runs = [], currentView, loading = false, failed = false;
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
    // One failed sample in a day is an issue, not an outage; an outage needs the two observations that confirm one.
    const outageSamples = (daily.major_outage || 0) + (daily.partial_outage || 0);
    const dayStatus = rollup(samples.map(([status]) => ({ status })));
    statuses.push({ status: ['major_outage', 'partial_outage'].includes(dayStatus) && outageSamples < 2 ? 'degraded' : dayStatus });
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
  const top = el('div', 'incident-title-row'); top.append(el('h3', '', displayIncidentTitle(i, currentView?.components.find(c=>c.id===i.componentId))), el('span', 'row-arrow', '›'));
  const meta = el('div', 'incident-meta');
  meta.append(el('span', `incident-stage ${i.resolvedAt ? 'resolved' : 'active'}`, STAGE_LABELS[i.stage] || (i.resolvedAt ? 'Resolved' : 'Investigating')), el('time', '', stamp(i.updatedAt || i.openedAt)));
  if (i.postmortem?.state === 'published') meta.append(el('span', '', 'Postmortem published'));
  card.append(top, meta); return card;
}
const SEVERITY = ['major_outage', 'partial_outage', 'degraded', 'unknown', 'maintenance', 'operational'];
const OUTAGES = ['major_outage', 'partial_outage'];
const number = n => n.toLocaleString(undefined);
function names(ids) { return ids.map(id => currentView.components.find(c => c.probes?.includes(id))?.name || id); }
function outageMinutes(list, from, to) {
  const spans = list.filter(i => OUTAGES.includes(i.status)).map(i => [Math.max(from, time(i.openedAt) || to), Math.min(to, time(i.resolvedAt) || to)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let total = 0, end = -Infinity; for (const [a, b] of spans) { total += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); } return Math.round(total / 60000);
}
function renderPulse(all) {
  const critical = currentView.components.filter(c => !c.freshness && c.probes?.length);
  const reliability = critical.find(c => c.id === 'request-reliability');
  const sites = critical.filter(c => c !== reliability);
  const http = c => c.samples.find(x => registry.probes.find(p => p.id === x.sourceId)?.type === 'http') || c.samples[0] || { status: 'unknown' };
  const down = sites.filter(c => OUTAGES.includes(http(c).status)), slow = sites.filter(c => http(c).status === 'degraded' || (c.status === 'degraded' && !OUTAGES.includes(http(c).status)));
  const blind = sites.filter(c => http(c).status === 'unknown');
  const unknownChecks = currentView.components.filter(c => c.status === 'unknown' && !sites.includes(c)).length;
  const jobs = currentView.components.filter(c => c.freshness && ['degraded', 'partial_outage', 'major_outage'].includes(c.status)).length;
  const sample = reliability?.samples?.[0] || {};
  const intermittent = OUTAGES.includes(reliability?.status);
  let title, lead, status;
  if (currentView.collector.status === 'unknown') { status = 'unknown'; title = 'Monitoring updates are unavailable'; lead = 'The latest checks are older than 15 minutes, so current availability is unknown.'; }
  else if (down.length) { status = rollup(down.map(http)); title = `Outage: ${down.map(c => c.name).join(', ')}`; lead = down.map(c => `${c.name}: ${REASONS[http(c).reasonCode] || 'check failed'}`).join(' · ') + '.'; }
  else if (intermittent) { status = 'partial_outage'; title = 'Intermittent failures'; lead = `${sample.failedChecks} of ${sample.totalChecks} site checks failed in the last 45 minutes: ${names(sample.affected || []).join(', ')}. Sites pass between failures.`; }
  else if (blind.length) { status = 'unknown'; title = 'Some sites are not being checked'; lead = `No current check for ${blind.map(c => c.name).join(', ')}.`; }
  else if (slow.length) { status = 'degraded'; title = 'All sites up · some slow'; lead = `Slower than target: ${slow.map(c => c.name).join(', ')}.`; }
  else { status = 'operational'; title = 'All sites are up'; lead = `${sites.length} sites and apps passed their latest checks.`; }
  const extras = [jobs ? `${jobs} data job${jobs === 1 ? '' : 's'} need attention` : '', unknownChecks ? `${unknownChecks} data and job checks unverified` : ''].filter(Boolean);
  $('#overview-title').textContent = title;
  $('#overview-description').replaceChildren(document.createTextNode(lead), ...(extras.length ? [el('span', 'overview-extras', ` ${extras.join(' · ')}.`)] : []));
  const overviewBadge = badge(status); overviewBadge.id = 'overall-badge'; $('#overall-badge').replaceWith(overviewBadge);
  $('#overall-icon').className = `status-symbol ${status}`; $('#overall-icon').textContent = status === 'operational' ? '✓' : status === 'unknown' ? '?' : '!';
  const affected = [...sites.filter(c => ['major_outage', 'partial_outage', 'degraded'].includes(c.status) || OUTAGES.includes(http(c).status))].sort((a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status));
  const chips = affected.map(c => { const li = el('li'), a = link('', route('component', c.id), `pulse-chip ${c.status}`); a.append(el('span', 'chip-name', c.name), el('span', 'chip-reason', REASONS[c.reasonCode] || LABELS[c.status])); li.append(a); return li; });
  $('#pulse-affected').replaceChildren(...chips); $('#pulse-affected').hidden = !chips.length;
  const open = all.filter(i => !i.resolvedAt), active = open.filter(i => critical.some(c => c.id === i.componentId)), pin = $('#pulse-incident');
  pin.hidden = !open.length; pin.className = `pulse-incident ${active.length ? 'site' : 'job'}`;
  if (open.length) { const i = active[0] || open[0], more = open.length - 1; pin.href = route('incident', i.id); pin.textContent = `${active.length ? 'Active incident' : 'Data job incident'}: ${displayIncidentTitle(i, currentView.components.find(c => c.id === i.componentId))} · ${age(i.openedAt)}${more ? ` · +${more} more` : ''} →`; }
  const now = Date.now(), siteIncidents = all.filter(i => critical.some(c => c.id === i.componentId));
  const rowsOut = [['Last 24 hours', 86400000], ['Last 7 days', 7 * 86400000]].map(([label, span]) => {
    const st = availabilityStats(runs, now - span, now), tr = el('tr');
    const inRange = siteIncidents.filter(i => OUTAGES.includes(i.status) && (time(i.resolvedAt) || now) >= now - span);
    const minutes = st.failingMinutesUpper === 0 ? '0 min' : `${st.failingMinutesLower}–${number(st.failingMinutesUpper)} min`;
    const cells = [st.checks ? `${st.failureRatePct}%` : 'No data', st.checks ? minutes : '—', st.runs ? `${number(st.unmonitoredMinutes)} min` : '—', inRange.length ? `${inRange.length} outage${inRange.length === 1 ? '' : 's'}` : 'None'];
    const sub = [st.checks ? `${number(st.failedChecks)} of ${number(st.checks)}` : '', st.checks ? 'proven – possible' : '', st.runs ? `${st.monitoredPct}% checked` : '', inRange.length ? `${number(outageMinutes(inRange, now - span, now))} min confirmed` : 'confirmed'];
    const th = el('th', '', label); th.scope = 'row'; tr.append(th);
    cells.forEach((text, k) => { const td = el('td'); td.append(el('strong', '', text)); if (sub[k]) td.append(el('small', '', sub[k])); tr.append(td); });
    return tr;
  });
  $('#stats-table tbody').replaceChildren(...rowsOut);
}
function render() {
  if (!registry) return;
  const activeElement = document.activeElement;
  const focusedMeasurement = activeElement?.classList.contains('measurement-card') ? activeElement.getAttribute('href') : null;
  currentView = viewState(registry, state);
  $('#collector-age').textContent = failed ? 'Refresh failed · current evidence unavailable' : `Updated ${age(state.generatedAt)}${currentView.collector.status === 'unknown' ? ' · collection stale' : ''}`;
  $('#service-count').textContent = currentView.components.length;
  const measurements = currentView.measurements || [];
  $('#measurement-summary').hidden = !measurements.length;
  $('#measurement-grid').replaceChildren(...measurements.map(m => { const card = link('', route('measurement', m.id), 'measurement-card'); card.append(el('h3', '', m.label), badge(m.status)); if (Number.isFinite(m.passing) && Number.isFinite(m.total)) card.append(el('p', '', `${m.passing}/${m.total} passing${m.unknown ? ` · ${m.unknown} unknown` : ''}`)); return card; }));
  const groups = $('#groups'); const open = new Set([...groups.querySelectorAll('details[open]')].map(n => n.dataset.group));
  if (focusedMeasurement) [...document.querySelectorAll('.measurement-card')].find(a => a.getAttribute('href') === focusedMeasurement)?.focus({ preventScroll: true });
  const focusedGroup = activeElement?.closest('.group-details')?.dataset.group;
  const focusedHref = activeElement?.getAttribute('href');
  const focusedIncidentHref = activeElement?.closest('.incident-list') ? focusedHref : null;
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
  $('#history-count').textContent = `${past.length} most recent resolved`;
  renderPulse(all);
  if (focusedIncidentHref) [...document.querySelectorAll('.incident-list a')].find(a => a.getAttribute('href') === focusedIncidentHref)?.focus({ preventScroll: true });
  $('#legend').replaceChildren(...Object.keys(LABELS).map(badge));
  // Re-evaluate open details too: a passing check must expire while it is being read.
  const dialog = $('#detail-dialog'), scroll = dialog.scrollTop;
  const expandedEvidence = dialog.querySelector('.measurement-evidence')?.open;
  const focusId = dialog.contains(document.activeElement) ? document.activeElement.id : '';
  const focusedDay = dialog.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : '';
  const focusedDetailHref = dialog.contains(document.activeElement) ? document.activeElement.getAttribute('href') : '';
  if (dialog.open) renderedRoute = '';
  showRoute();
  if (dialog.open) { const evidence = dialog.querySelector('.measurement-evidence'); if (evidence && expandedEvidence) evidence.open = true; dialog.scrollTop = scroll; if (focusId) document.getElementById(focusId)?.focus({ preventScroll: true }); else if (focusedDay) [...dialog.querySelectorAll('[aria-label]')].find(n => n.getAttribute('aria-label') === focusedDay)?.focus({ preventScroll: true }); else if (focusedDetailHref) [...dialog.querySelectorAll('a[href]')].find(n => n.getAttribute('href') === focusedDetailHref)?.focus({ preventScroll: true }); }
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
  const control = el('div', 'date-control'), label = el('label', '', 'View day'); label.htmlFor = 'history-date'; const input = el('input'); input.type = 'date'; input.id = 'history-date'; input.min = dates[0]; input.max = dates.at(-1); input.value = day; input.addEventListener('change', () => { if (dates.includes(input.value)) goDay(input.value); }); const previous = el('button', 'date-step', '←'), next = el('button', 'date-step', '→'); previous.type = next.type = 'button'; previous.id = 'previous-day'; next.id = 'next-day'; previous.setAttribute('aria-label', 'Previous day'); next.setAttribute('aria-label', 'Next day'); const selectedIndex = dates.indexOf(day); previous.disabled = selectedIndex === 0; next.disabled = selectedIndex === dates.length - 1; previous.addEventListener('click', () => { goDay(dates[selectedIndex - 1]); $('#previous-day')?.focus({ preventScroll: true }); }); next.addEventListener('click', () => { goDay(dates[selectedIndex + 1]); $('#next-day')?.focus({ preventScroll: true }); }); control.append(label, input, previous, next); sec.append(control);
  const data = observation(ids, day), detail = el('div', 'observation-detail'); detail.setAttribute('role', 'status'); detail.append(el('strong', '', `${dateLabel(day)} · UTC`), el('p', '', data.total ? `${data.total} recorded observations${data.missing ? ` · ${data.missing} service${data.missing === 1 ? '' : 's'} without observations` : ''}` : 'No observations recorded for this day.'));
  const counts = el('div', 'observation-counts'); for (const [status, count] of Object.entries(data.counts)) counts.append(el('span', status, `${LABELS[status]}: ${count}`)); detail.append(counts); sec.append(detail); parent.append(sec);
}
function metric(value, unit) { if (unit === 'ms') return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`; if (unit === '%') return `${Number(value.toFixed(1))}%`; return `${value}${unit ? ` ${unit}` : ''}`; }
function componentDetail(c, selectedDay) {
  const body = el('div'); body.append(el('h2', 'detail-title', c.name), badge(c.status)); body.querySelector('h2').id = 'detail-title';
  const scope = section('What is checked'); scope.append(el('p', '', c.checkScope || c.coverage), el('div', 'detail-meta', `Last observation: ${stamp(c.observedAt)} · ${age(c.observedAt)}`)); body.append(scope);
  const checks = section('Current checks'), list = el('ul', 'check-list');
  c.samples.forEach(sample => { const probe = registry.probes.find(p => p.id === sample.sourceId); const item = el('li'), text = el('div'); const name = c.freshness ? (c.measurements?.[0]?.label || 'Data freshness check') : probe?.type === 'browser' ? 'Page rendering' : probe?.type === 'http' ? 'HTTP content check' : 'Functional monitoring';
    text.append(el('div', 'check-name', name), el('div', 'check-reason', REASONS[sample.reasonCode] || 'Evidence unavailable'));
    const metrics = [sample.lcpMs ? `LCP ${(sample.lcpMs/1000).toFixed(1)}s` : '', sample.responseMs ? `Response ${(sample.responseMs/1000).toFixed(1)}s` : ''].filter(Boolean);
    if (metrics.length) text.append(el('div', 'check-reason', metrics.join(' · '))); item.append(text, badge(sample.status)); list.append(item);
  }); checks.append(list); body.append(checks);
  if (c.measurements?.length) { const measured = section('Measured signals'), rows = el('ul', 'check-list'); c.measurements.forEach(m => { const row = el('li'), copy = el('div'); copy.append(el('div', 'check-name', m.label), el('div', 'check-reason', m.scope || REASONS[m.reasonCode] || 'No current evidence')); if (m.value !== undefined && m.value !== null) copy.append(el('div', 'metric-value', metric(m.value, m.unit))); if (m.target !== undefined && m.target !== null) copy.append(el('div', 'check-reason', `${m.unit === 'nodes' ? 'Total' : 'Target'}: ${metric(m.target, m.unit)}`)); if (m.summary) copy.append(el('p', 'signal-summary', m.summary)); copy.append(el('div', 'check-reason', `Checked ${stamp(m.observedAt)}`)); row.append(copy, badge(m.status)); rows.append(row); }); measured.append(rows); body.append(measured); }
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
  const body = el('div'), title = el('h2', 'detail-title', displayIncidentTitle(i, currentView?.components.find(c=>c.id===i.componentId))); title.id = 'detail-title'; body.append(title, el('span', `incident-stage ${i.resolvedAt ? 'resolved' : 'active'}`, STAGE_LABELS[i.stage] || 'Investigating'), el('p', 'detail-meta', `Opened ${stamp(i.openedAt)}${i.resolvedAt ? ` · Resolved ${stamp(i.resolvedAt)}` : ''}`));
  const affected = section('Affected services'), links = el('div', 'affected-links'); const ids = new Set([i.componentId, ...(i.componentIds || [])].filter(Boolean));
  for (const id of ids) { const c = currentView.components.find(c => c.id === id); if (c) links.append(link(c.name, route('component', id))); } affected.append(links); if (links.children.length) body.append(affected);
  const sec = section('Updates'), timeline = el('ol', 'timeline');
  [...(i.updates || [])].reverse().sort((a,b) => (time(b.at)||0)-(time(a.at)||0)).forEach(update => { const item = el('li', update.stage); item.append(el('h3', '', STAGE_LABELS[update.stage] || 'Update'), el('p', '', update.message), el('time', '', `${stamp(update.at)}${update.source === 'monitor' ? ' · Automated check' : ''}`)); timeline.append(item); });
  sec.append(timeline); body.append(sec);
  if (i.postmortem?.state === 'published') { const post = el('section', 'postmortem'); post.append(el('h3', '', 'Postmortem')); if (i.postmortem.summary) post.append(el('p', '', i.postmortem.summary)); const a = external('Read the postmortem', i.postmortem.url); if (a) post.append(a); body.append(post); }
  const issue = external('Follow updates on GitHub', i.issue?.url); if (issue) body.append(issue); return body;
}
function measurementDetail(m) {
  const body = el('div'), title = el('h2', 'detail-title', m.label); title.id = 'detail-title';
  body.append(title, badge(m.status));
  if (m.summary) body.append(el('p', 'detail-lead', m.summary));
  const scope = section('What this signal covers'); scope.append(el('p', '', m.scope || 'Coverage is limited to the configured checks.'), el('div', 'detail-meta', `Last observation: ${stamp(m.observedAt)}`)); body.append(scope);
  const services = currentView.components.filter(c => c.measurements?.some(signal => signal.dimension === m.id));
  if (services.length) { const measured = section('Services'); for (const c of services) { const a = link('', route('component', c.id), 'component-link'); a.append(el('span', 'component-name', c.name), badge(rollup(c.measurements.filter(signal => signal.dimension === m.id)))); measured.append(a); } body.append(measured); }
  if (m.rows?.length) {
    const details = el('details', 'measurement-evidence'), toggle = el('summary', '', `Detailed observations (${m.rows.length})`); toggle.id = 'measurement-evidence-toggle'; details.append(toggle);
    const rows = el('ul', 'check-list');
    for (const r of m.rows) {
      const row = el('li'), copy = el('div'), probe = registry.probes.find(p => p.id === r.id), component = currentView.components.find(c => c.id === r.componentId || c.id === r.id || c.probes?.includes(r.id));
      const label = probe && component ? `${component.name} · ${probe.type === 'browser' ? 'Page rendering' : 'HTTP check'}` : r.label || component?.name || 'Configured observation';
      copy.append(el('div', 'check-name', label));
      if (Number.isFinite(r.value)) copy.append(el('div', 'metric-value', metric(r.value, r.unit)));
      if (Number.isFinite(r.target)) copy.append(el('div', 'check-reason', `${r.unit === 'nodes' ? 'Total' : 'Target'}: ${metric(r.target, r.unit)}`));
      if (r.summary) copy.append(el('p', 'signal-summary', r.summary));
      if (r.scope) copy.append(el('div', 'check-reason', r.scope));
      copy.append(el('div', 'check-reason', `Checked ${stamp(r.observedAt)}`));
      if (component) copy.append(link('Service details →', route('component', component.id), 'detail-link'));
      row.append(copy, badge(r.status)); rows.append(row);
    }
    details.append(rows); body.append(details);
  }
  return body;
}
function showRoute() {
  if (!currentView) return;
  const match = location.hash.match(/^#(component|group|incident|measurement)\/([^/]+)(?:\/(\d{4}-\d{2}-\d{2}))?$/), dialog = $('#detail-dialog');
  if (!match) { if (dialog.open) { dialog.close(); const origin = detailOrigin?.isConnected ? detailOrigin : [...document.querySelectorAll('a[href]')].find(a => a.getAttribute('href') === detailOrigin?.getAttribute('href')); (origin || $('#services-title')).focus({ preventScroll: true }); } renderedRoute = ''; return; }
  if (renderedRoute === location.hash && dialog.open) return;
  let id; try { id = decodeURIComponent(match[2]); } catch { id = ''; }
  const [, kind, , day] = match; let body;
  const item = kind === 'measurement' ? currentView.measurements?.find(m => m.id === id) : kind === 'component' ? currentView.components.find(c => c.id === id) : kind === 'group' ? currentView.groups.find(g => g.id === id) : normalizeIncidents(incidents).find(i => i.id === id);
  if (item) body = kind === 'measurement' ? measurementDetail(item) : kind === 'component' ? componentDetail(item, day) : kind === 'group' ? groupDetail(item, day) : incidentDetail(item);
  else { body = el('div'); const title = el('h2', 'detail-title', 'Details unavailable'); title.id = 'detail-title'; body.append(title, el('p', '', 'This service or incident is not present in the current monitoring data.')); }
  $('#detail-kind').textContent = kind === 'measurement' ? 'SIGNAL DETAILS' : kind === 'incident' ? 'INCIDENT DETAILS' : kind === 'group' ? 'GROUP HISTORY' : 'SERVICE DETAILS';
  $('#detail-content').replaceChildren(body); renderedRoute = location.hash;
  if (!dialog.open) { detailOrigin = document.activeElement; dialog.showModal(); $('#close-detail').focus(); }
  dialog.scrollTop = 0;
}
function closeDetail() {
  // Close dismisses the entire detail layer. Browser Back remains available for
  // navigating between detail entries, including links opened directly.
  window.history.replaceState(null, '', `${location.pathname}${location.search}${previousHash}`); showRoute();
}
document.addEventListener('click', event => { const a = event.target.closest('a[href^="#"]'); if (!a || !/^#(component|group|incident|measurement)\//.test(a.getAttribute('href')) || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); if (!$('#detail-dialog').open) previousHash = location.hash; window.history.pushState(null, '', a.getAttribute('href')); renderedRoute = ''; showRoute(); });
for (const a of document.querySelectorAll('a[href="#method"], a[href="#stats-method"]')) a.addEventListener('click', () => { $('#method').open = true; });
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
    runs = await fetch(`./data/runs.json?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(15000) }).then(r => r.ok ? r.json() : null).then(d => Array.isArray(d?.runs) ? d.runs : []).catch(() => []);
    [registry, state, history, incidents] = values; failed = false; render();
  } catch {
    failed = true;
    if (registry) { state = { ...state, generatedAt: null, probes: {}, freshness: {} }; renderedRoute = ''; render(); }
    else { $('#overview-title').textContent = 'Service status unavailable'; $('#overview-description').textContent = 'Monitoring data could not load. Current availability is Unknown.'; $('#collector-age').textContent = 'Refresh failed'; $('#groups').setAttribute('aria-busy', 'false'); $('#groups').replaceChildren(el('p', 'empty', 'Service checks unavailable. Try Refresh or view the timestamped data below.')); $('#incident-history').replaceChildren(el('p', 'empty', 'Incident data is unavailable.')); }
  } finally { loading = false; $('#refresh').disabled = false; }
}
$('#refresh').addEventListener('click', () => { renderedRoute = ''; load(); });
await load(); setInterval(render, 30000); setInterval(load, 60000);
