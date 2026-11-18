// Seven-day check that the second vantage is not hiding real outages:
//   node scripts/vantage-report.mjs [days=7]
// Compares probe_path_suspect events (data/vantage.json) with confirmed incidents (data/incidents.json)
// per component. A suspect held back for a component that then opened an incident within 30 minutes
// is a "late confirm": the hold delayed a real outage, which is the failure this report must surface.
import { readFile } from 'node:fs/promises';

const days = Number(process.argv[2]) || 7;
const now = Date.now(), since = now - days * 86400000;
const vantage = JSON.parse(await readFile('data/vantage.json', 'utf8').catch(() => '{"events":[]}'));
const incidents = JSON.parse(await readFile('data/incidents.json', 'utf8')).incidents;
const events = vantage.events.filter(e => Date.parse(e.at) >= since);
const suspects = events.filter(e => e.outcome === 'suspect');
const persistent = events.filter(e => e.outcome === 'counted_persistent');
const opened = i => Date.parse(i.openedAt || 0);
const confirmed = incidents.filter(i => opened(i) >= since);
const late = suspects.filter(e => confirmed.some(i => i.componentId === e.component && opened(i) >= Date.parse(e.at) && opened(i) - Date.parse(e.at) <= 1800000));
console.log(JSON.stringify({
  windowDays: days, suspectEvents: suspects.length, suspectProbes: new Set(suspects.map(e => e.probe)).size,
  inCluster: suspects.filter(e => e.cluster).length, countedPersistent: persistent.length,
  confirmedIncidents: confirmed.length, suspectsFollowedByIncidentWithin30Min: late.length,
  byComponent: Object.fromEntries([...new Set(suspects.map(e => e.component))].map(c => [c, suspects.filter(e => e.component === c).length])),
}, null, 2));
