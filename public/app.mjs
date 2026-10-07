import { viewState, LABELS, REASONS, rollup, time } from './model.mjs';
let registry, state, history, incidents;
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const badge = status => el('span', `badge ${status}`, LABELS[status]);
function age(at) { if (!time(at)) return 'not yet verified'; const minutes = Math.max(0, Math.floor((Date.now() - time(at)) / 60000)); return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)} hr ago` : `${Math.floor(minutes / 1440)} days ago`; }
function stamp(at) { return time(at) ? new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'unavailable'; }
function chart(id) {
  const wrap = el('div'); const bars = el('div', 'bars'); bars.setAttribute('aria-label', 'Daily observed status over the last 90 days');
  for (let i = 89; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); const counts = history.days?.[date]?.[id] || {};
    const samples = Object.keys(counts).filter(s => counts[s] > 0).map(status => ({ status }));
    const status = rollup(samples); const node = el('span', `bar ${status}`);
    const known = Object.entries(counts).filter(([s]) => s !== 'unknown' && s !== 'maintenance').reduce((sum, [,n]) => sum + n, 0);
    node.title = `${date}: ${LABELS[status]}; ${known} known observations${known ? `, ${Math.round((counts.operational || 0) / known * 100)}% passed` : ''}`;
    bars.append(node);
  }
  wrap.append(bars); const labels = el('div', 'bar-labels'); labels.append(el('span', '', '90 days ago'), el('span', '', 'Today')); wrap.append(labels); return wrap;
}
function incidentCard(incident, active) {
  const card = el('article', `incident-card${active ? ' active' : ''}`);
  card.append(el('h3', '', incident.title), el('p', '', `${active ? 'Investigating' : 'Resolved'} · ${REASONS[incident.reasonCode] || 'Monitoring detected an issue'}`));
  card.append(el('time', '', `${stamp(incident.openedAt)}${incident.resolvedAt ? ` → ${stamp(incident.resolvedAt)}` : ''}`));
  return card;
}
function render() {
  if (!registry) return;
  const view = viewState(registry, state); const overall = rollup([{ status: view.status }, view.collector]);
  const count = view.components.filter(c => c.samples.every(s => s.status !== 'unknown')).length;
  const titles = { operational: 'All monitored services operational', degraded: 'Some services are slower than expected', partial_outage: 'Some services are experiencing issues', major_outage: 'A service is experiencing an outage', unknown: 'Some services await verified checks', maintenance: 'Scheduled maintenance in progress' };
  document.querySelector('#overview-title').textContent = titles[overall];
  document.querySelector('#overview-description').textContent = `${count} of ${view.components.length} components have complete current checks. Partial checks can still expose issues; expand a group for coverage.`;
  document.querySelector('#overall-badge').replaceWith(Object.assign(badge(overall), { id: 'overall-badge' }));
  document.querySelector('#collector-age').textContent = `Latest collection: ${age(state.generatedAt)}${view.collector.status === 'unknown' ? ' · monitoring evidence expired' : ''}`;
  document.querySelector('#coverage-count').textContent = `${view.groups.length} groups · ${count}/${view.components.length} checked`;
  const groups = document.querySelector('#groups'); const open = new Set([...groups.querySelectorAll('details[open]')].map(n => n.dataset.group)); const first = !groups.children.length; groups.replaceChildren();
  for (const group of view.groups) {
    const details = el('details', 'group'); details.dataset.group = group.id; details.open = first || open.has(group.id);
    const summary = el('summary'); const heading = el('div'); heading.append(el('div', 'group-title', group.name), el('div', 'group-description', group.description)); summary.append(heading, badge(group.status)); details.append(summary);
    for (const c of group.components) {
      const row = el('div', 'component'); const top = el('div', 'component-top'); top.append(el('span', 'component-name', c.name), badge(c.status)); row.append(top);
      row.append(el('div', 'component-reason', REASONS[c.reasonCode] || 'Evidence unavailable'), el('div', 'component-coverage', c.coverage));
      const missing = c.samples.find(s => s.status === 'unknown');
      if (missing && c.status !== 'unknown') row.append(el('div', 'component-coverage', `Coverage limit: ${REASONS[missing.reasonCode] || 'Evidence unavailable'}.`));
      const latency = c.samples.map(s => s.lcpMs ? `LCP ${(s.lcpMs / 1000).toFixed(1)}s` : s.responseMs ? `HTTP ${(s.responseMs / 1000).toFixed(1)}s` : '').filter(Boolean).join(' · ');
      const checked = el('div', 'component-time', `Checked ${age(c.observedAt)}${latency ? ` · ${latency}` : ''}`); checked.title = stamp(c.observedAt); row.append(checked, chart(c.id)); details.append(row);
    }
    groups.append(details);
  }
  const all = incidents.incidents || []; const active = all.filter(i => !i.resolvedAt);
  document.querySelector('#active-incidents').hidden = !active.length; document.querySelector('#active-list').replaceChildren(...active.map(i => incidentCard(i, true)));
  const past = all.filter(i => i.resolvedAt).slice(0, 30);
  document.querySelector('#incident-history').replaceChildren(...(past.length ? past.map(i => incidentCard(i, false)) : [el('p', 'empty', 'No resolved incidents in the collected history. Monitoring coverage is shown above.')]));
  document.querySelector('#legend').replaceChildren(...Object.keys(LABELS).map(badge));
}
async function load() {
  try {
    const files = ['components', 'status', 'history', 'incidents'];
    const values = await Promise.all(files.map(async name => { const r = await fetch(`./data/${name}.json?t=${Date.now()}`, { cache: 'no-store' }); if (!r.ok) throw new Error('unavailable'); return r.json(); }));
    [registry, state, history, incidents] = values;
    render();
  } catch { if (registry) { state = { ...state, generatedAt: null, probes: {}, freshness: {} }; render(); } else document.querySelector('#overview-description').textContent = 'Monitoring data unavailable. Current availability is Unknown; consult incident updates.'; }
}
document.querySelector('#refresh').addEventListener('click', load);
await load(); setInterval(render, 30000); setInterval(load, 60000);
