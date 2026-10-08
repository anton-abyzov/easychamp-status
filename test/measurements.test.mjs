import test from 'node:test';
import assert from 'node:assert/strict';
import { viewState, verifyFreshness } from '../public/model.mjs';
import { verifyScheduledRun, verifyResources } from '../public/measurements.mjs';
import { sanitizeFreshness } from '../scripts/freshness-contract.mjs';
const now = Date.parse('2026-10-08T00:05:00Z');
const at = minutes => new Date(now + minutes * 60000).toISOString();
const job = { id:'feed-england', freshness:true, measurementKind:'scheduled_run', schedule:'2,17,32,47 * * * *',timeZone:'Etc/UTC',maxSuccessHours:192,maxGraceSeconds:43200 };
const good = { id:job.id,status:'operational',reasonCode:'verified',observedAt:at(-1),measurementKind:'scheduled_run',lastAttemptAt:at(-15),lastAttemptStartedAt:at(-15),lastAttemptDeadlineSeconds:900,lastAttemptOutcome:'succeeded',lastCompletedSuccessAt:at(-10),lastDestinationVerifiedAt:null,nextDueAt:at(12),graceSeconds:900,schedule:job.schedule,timeZone:job.timeZone,suspended:false,destinationVerification:'unavailable',metrics:null };
const resources = {id:'cluster-resources',measurementKind:'cluster_resources',status:'operational',reasonCode:'verified',observedAt:at(-1),metrics:{sampleAt:at(-1),cpuUtilizationPct:97,memoryUtilizationPct:40,diskUtilizationPct:79,nodesReady:3,nodesTotal:3,coverage:['node_readiness','cpu','memory','disk']}};
const registry = {groups:[{id:'web'},{id:'data'},{id:'platform'}],probes:[{id:'home-http',type:'http',maxResponseMs:4000,expiresSeconds:900},{id:'home-render',type:'browser',maxLcpMs:4000,expiresSeconds:2100}],components:[{id:'home',name:'Home',group:'web',probes:['home-http','home-render']},{...job,name:'England results',group:'data'},{id:'cluster-resources',name:'Kubernetes',group:'platform',freshness:true,measurementKind:'cluster_resources'}]};
const state = (sample=good) => ({generatedAt:at(-1),probes:{'home-http':{status:'operational',reasonCode:'ok',observedAt:at(-1),httpStatus:200,responseMs:100},'home-render':{status:'operational',reasonCode:'ok',observedAt:at(-1),lcpMs:700}},freshness:{[job.id]:sample,'cluster-resources':resources}});
test('successful scheduled execution explicitly leaves destination unverified', () => {
  const v=viewState(registry,state(),now),c=v.components.find(c=>c.id===job.id);
  assert.equal(c.status,'operational');
  assert.equal(c.measurements.find(r=>r.dimension==='scheduled-runs').status,'operational');
  assert.equal(c.measurements.find(r=>r.dimension==='freshness').status,'unknown');
  assert.match(c.measurements.find(r=>r.dimension==='freshness').scope,/not independently verified/);
  assert.equal(verifyFreshness(good,now).status,'unknown');
});
test('job failures do not claim page performance degradation', () => {
  const v=viewState(registry,state({...good,status:'degraded',reasonCode:'run_failed',lastAttemptOutcome:'failed'}),now);
  assert.equal(v.measurements.find(m=>m.id==='latency').status,'operational');
  assert.equal(v.measurements.find(m=>m.id==='availability').status,'operational');
  assert.equal(v.summary.title,'Some scheduled jobs need attention');
});
test('slow HTTP remains available; performance owns its latency failure', () => {
  const s=state();s.probes['home-http']={...s.probes['home-http'],status:'degraded',reasonCode:'slow',responseMs:4500};
  const v=viewState(registry,s,now);
  assert.equal(v.measurements.find(m=>m.id==='availability').status,'operational');
  assert.equal(v.measurements.find(m=>m.id==='latency').status,'degraded');
});
test('failed response schema cannot manufacture a page latency failure', () => {
  const s=state();s.probes['home-http']={status:'partial_outage',reasonCode:'schema_mismatch',observedAt:at(-1),responseMs:10};
  const v=viewState(registry,s,now);
  assert.equal(v.measurements.find(m=>m.id==='availability').status,'partial_outage');
  assert.equal(v.measurements.find(m=>m.id==='latency').status,'unknown');
  assert.equal(v.summary.title,'Some endpoint checks are failing');
});
test('new running attempt replaces the prior failed current signal, not proof of recovery', () => {
  const running={...good,status:'degraded',reasonCode:'run_failed',lastAttemptOutcome:'running'};
  assert.equal(verifyScheduledRun(running,now,job).reasonCode,'in_progress');
  assert.equal(verifyFreshness({...running,measurementKind:'destination_validation'},now).reasonCode,'in_progress');
});
test('overdue running requires collector-observation deadline proof', () => {
  const overdue={...good,status:'degraded',reasonCode:'schedule_missed',lastAttemptOutcome:'running',lastAttemptAt:at(-30),lastAttemptStartedAt:at(-29)};
  assert.equal(verifyScheduledRun(overdue,now,job).status,'degraded');
  assert.equal(verifyFreshness({...overdue,measurementKind:'destination_validation'},now).status,'degraded');
  assert.equal(verifyScheduledRun({...overdue,lastAttemptStartedAt:null},now,job).reasonCode,'in_progress');
  assert.equal(verifyScheduledRun({...overdue,lastAttemptStartedAt:at(-10)},now,job).reasonCode,'in_progress');
  assert.equal(verifyScheduledRun({...overdue,status:'unknown',reasonCode:'in_progress'},now+5*60000,job).status,'unknown');
  assert.equal(verifyScheduledRun({...overdue,observedAt:at(-21)},now,job).status,'unknown');
});
test('paused, stale and absent execution metadata stay explicit', () => {
  for(const change of [{suspended:true},{observedAt:at(-21)},{lastAttemptAt:null},{lastAttemptOutcome:'unknown'},{schedule:null},{timeZone:null},{schedule:'*/5 * * * *'}]) assert.equal(verifyScheduledRun({...good,...change},now,job).status,'unknown');
  assert.equal(verifyScheduledRun({...good,nextDueAt:at(-20)},now,job).status,'unknown');
  assert.equal(verifyScheduledRun({...good,nextDueAt:at(-6),graceSeconds:300},now,job).status,'degraded');
});
test('resource point spike is information; missing or stale node coverage is unknown', () => {
  assert.equal(verifyResources(resources,now).status,'operational');
  for(const metric of [{sampleAt:at(-21)},{sampleAt:at(2)},{cpuUtilizationPct:null},{nodesReady:2},{nodesTotal:0},{coverage:['node_readiness','cpu','memory']}]) assert.equal(verifyResources({...resources,metrics:{...resources.metrics,...metric}},now).status,'unknown');
  assert.equal(verifyResources({...resources,status:'degraded',reasonCode:'resource_pressure'},now).status,'degraded');
});
test('privacy projection strips arbitrary raw fields and pins expected metadata', () => {
  const projected=sanitizeFreshness({...good,privateJobName:'must-not-publish',clusterIp:'private',credential:'hidden'},job,now);
  assert.deepEqual(projected,good);
  for(const change of [{measurementKind:'destination_validation'},{lastAttemptAt:at(2)},{lastAttemptStartedAt:at(-16)},{lastAttemptDeadlineSeconds:86401},{schedule:'*/5 * * * *'},{timeZone:'Europe/London'},{graceSeconds:43201}]) assert.equal(sanitizeFreshness({...good,...change},job,now).reasonCode,'invalid_evidence');
});
test('expired publication is explicit even with fresh individual samples', () => {
  const s=state();s.generatedAt=at(-16);
  assert.equal(viewState(registry,s,now).summary.title,'Monitoring updates are unavailable');
});

test('legacy import incident labels describe their recorded failure without changing history', async () => {
  const {displayIncidentTitle}=await import('../public/incident-model.mjs');
  const incident={title:'PES Master: degraded performance',reasonCode:'run_failed'};
  assert.equal(displayIncidentTitle(incident,{freshness:true,name:'PES Master'}),'PES Master: scheduled import issue');
  assert.equal(incident.title,'PES Master: degraded performance');
  assert.equal(displayIncidentTitle({...incident,reasonCode:'rendering_slow'},{freshness:false,name:'Home'}),incident.title);
});
