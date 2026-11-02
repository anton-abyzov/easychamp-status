import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd();
const registry = JSON.parse(await readFile(resolve(root,'dist/data/components.json'),'utf8'));
process.env.PWDEBUG='0'; process.env.PLAYWRIGHT_HTML_OPEN='never';
const evidence=resolve(process.env.STATUS_UI_EVIDENCE_DIR || 'test-results/ui');
await mkdir(evidence,{recursive:true});
// Fixture lifecycle screenshots are test evidence, not production write-ups.
const server=createServer(async(req,res)=>{try{const path=new URL(req.url,'http://local').pathname;const file=path==='/'?'/index.html':path;const disk=resolve(root,'dist','.'+file); if(!disk.startsWith(resolve(root,'dist')+sep)) throw new Error('path'); const body=await readFile(disk);res.setHeader('Content-Type',file.endsWith('.mjs')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':file.endsWith('.svg')?'image/svg+xml':file.endsWith('.webp')?'image/webp':file.endsWith('.woff2')?'font/woff2':'text/html');res.end(body);}catch{res.statusCode=404;res.end('Not found');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.STATUS_BROWSER_CHANNEL==='chrome'?{channel:'chrome'}:{})});
const checks=[],errors=[];
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100},colorScheme:'light',reducedMotion:'reduce'});
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base,{waitUntil:'networkidle'});
 await page.locator('.group').first().waitFor();
 assert.equal(await page.locator('.group').count(),registry.groups.length);assert.equal(await page.locator('#groups .component-link').count(),registry.components.length);assert.equal(await page.locator('.group-details[open]').count(),0);
 await page.screenshot({path:evidence+'/desktop-light.png',fullPage:true});checks.push(`${registry.groups.length} collapsed groups; ${registry.components.length} nested components`);
 const pulse=await page.evaluate(()=>({title:document.querySelector('#overview-title').getBoundingClientRect().bottom,stats:document.querySelector('#stats-table').getBoundingClientRect().bottom,rows:document.querySelectorAll('#stats-table tbody tr').length,text:document.querySelector('.overview').innerText}));
 assert.equal(pulse.rows,2);assert.ok(pulse.stats<1100&&pulse.title<1100,'state and downtime statistics are above the fold');assert.ok(!/undefined|NaN/.test(pulse.text));
 assert.equal(await page.locator('#measurement-summary[open]').count(),0);assert.equal(await page.locator('.history-section[open]').count(),0);
 checks.push('current state and 24-hour/7-day downtime statistics above the fold; secondary details collapsed');
 await page.locator('#measurement-summary > summary').click();
 if(await page.locator('.measurement-card').count()) {
  const dimensions=await page.locator('.measurement-card').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('href')));
  for(const href of dimensions) {
   await page.locator(`a[href="${href}"]`).click();await page.locator('dialog[open]').waitFor();
   assert.ok(await page.locator('#detail-content .component-link').count()>0,`missing service rollups for ${href}`);
   assert.ok(!/undefined|NaN/.test(await page.locator('#detail-content').innerText()));
   await page.locator('.measurement-evidence summary').click();assert.ok(await page.locator('.measurement-evidence li').count()>0);
   await page.keyboard.press('Escape');await page.locator('dialog').waitFor({state:'hidden'});
  }
  checks.push('measurement dimensions link to services and expose detailed evidence without invalid values');
 }

 await page.locator('.group-details summary').first().click();
 await page.locator('#groups a[href="#component/home"]').click();await page.locator('dialog[open]').waitFor();
 assert.match(await page.locator('#detail-title').innerText(),/EasyChamp home/);assert.match(page.url(),/#component\/home/);
 assert.equal(await page.locator('.day-button').count(),90);
 await page.locator('.day-button[tabindex="0"]').focus();await page.keyboard.press('ArrowLeft');assert.match(page.url(),new RegExp(new Date(Date.now()-86400000).toISOString().slice(0,10)));
 await page.screenshot({path:evidence+'/component-history.png',fullPage:true});
 await page.keyboard.press('Escape');await page.locator('dialog').waitFor({state:'hidden'});assert.equal(await page.locator('.group-details[open]').count(),1);checks.push('component hash, daily keyboard history, Escape and group expansion preserved');
 await page.locator('.group-history').first().click();await page.locator('dialog[open]').waitFor();assert.equal(await page.locator('.day-button').count(),90);await page.goBack();await page.locator('dialog').waitFor({state:'hidden'});checks.push('group observed history and browser Back');
 await page.goto(base+'/#component/media-playback',{waitUntil:'networkidle'});await page.locator('dialog[open]').waitFor();assert.match(await page.locator('#detail-content').innerText(),/Unknown/);await page.keyboard.press('Escape');await page.locator('dialog').waitFor({state:'hidden'});checks.push('direct component route with unknown unconnected monitoring');
 const incident={id:'fixture-incident',componentId:'scraper-pesmaster',title:'Player data import delayed',status:'degraded',reasonCode:'run_failed',openedAt:new Date(Date.now()-3600000).toISOString(),updatedAt:new Date().toISOString(),resolvedAt:null,stage:'monitoring',updates:[{id:'one',stage:'investigating',at:new Date(Date.now()-3600000).toISOString(),message:'The scheduled import check reported a failure. Cause is unconfirmed.',source:'monitor'},{id:'two',stage:'identified',at:new Date(Date.now()-1800000).toISOString(),message:'The affected import has been identified.',source:'owner'},{id:'three',stage:'monitoring',at:new Date().toISOString(),message:'A mitigation has been applied. Recovery checks are in progress.',source:'owner'}],postmortem:{state:'draft',summary:'Private draft must not render'},issue:{number:1,url:'https://github.com/anton-abyzov/easychamp-status/issues/1'}};
 let data={schemaVersion:1,incidents:[incident]};
 await page.route('**/data/incidents.json?*',r=>r.fulfill({json:data}));
 await page.goto(base,{waitUntil:'networkidle'});await page.locator('#active-list a').click();await page.locator('dialog[open]').waitFor();assert.equal(await page.locator('.timeline li').count(),3);assert.equal(await page.getByText('Private draft must not render').count(),0);await page.screenshot({path:evidence+'/incident-monitoring.png',fullPage:true});checks.push('investigating, identified and monitoring timeline; draft postmortem hidden');
 await page.goto(base+'/#incident/fixture-incident',{waitUntil:'networkidle'}); await page.locator('dialog[open]').waitFor(); await page.locator('.affected-links a').click(); await page.getByRole('button',{name:'Close details'}).click(); await page.locator('dialog').waitFor({state:'hidden'}); assert.equal(new URL(page.url()).hash,''); checks.push('direct detail followed by nested detail closes completely');
 await page.clock.install({time:new Date()}); await page.goto(base,{waitUntil:'networkidle'}); const incidentHref=await page.locator('#active-list a').getAttribute('href'); await page.locator('#active-list a').focus(); await page.clock.fastForward(31000); assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('href')),incidentHref); checks.push('incident card retains keyboard focus during background repaint');
 await page.goto(base+'/#incident/fixture-incident',{waitUntil:'networkidle'}); await page.locator('dialog[open]').waitFor(); await page.locator('.affected-links a').focus(); const affectedHref=await page.locator('.affected-links a').getAttribute('href'); await page.clock.fastForward(31000); assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('href')),affectedHref); checks.push('affected-service link retains modal keyboard focus during background repaint');
 incident.resolvedAt=new Date().toISOString();incident.stage='writeup_published';incident.postmortem={state:'published',summary:'The scheduled import recovered after the source connector was repaired.',url:'https://github.com/anton-abyzov/easychamp-status/issues/1',generatedAt:incident.resolvedAt,publishedAt:incident.resolvedAt};incident.updates.push({id:'four',stage:'resolved',at:new Date().toISOString(),message:'Recovery checks passed.',source:'monitor'},{id:'five',stage:'writeup_published',at:new Date().toISOString(),message:'The postmortem has been published.',source:'owner'});
 await page.reload({waitUntil:'networkidle'});await page.locator('dialog[open]').waitFor();assert.equal(await page.locator('.timeline li').count(),5);assert.equal(await page.getByRole('link',{name:'Read the postmortem'}).count(),1);await page.screenshot({path:evidence+'/incident-resolved-postmortem.png',fullPage:true});checks.push('resolved and published writeup timeline with public postmortem link');
 await page.goto(base,{waitUntil:'networkidle'});await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:evidence+'/desktop-dark.png',fullPage:true});
 for(const width of [820,390,320]){await page.setViewportSize({width,height:844});await page.emulateMedia({colorScheme:'light'});await page.goto(base,{waitUntil:'networkidle'});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:evidence+`/mobile-${width}-light.png`,fullPage:true});await page.emulateMedia({colorScheme:'dark'});await page.screenshot({path:evidence+`/mobile-${width}-dark.png`,fullPage:true});await page.locator('.history-section').evaluate(n=>{n.open=true});await page.locator('#incident-history .incident-card').click();await page.locator('dialog[open]').waitFor();assert.ok(await page.locator('dialog').evaluate(n=>n.scrollWidth<=n.clientWidth));await page.screenshot({path:evidence+`/mobile-${width}-incident.png`,fullPage:false});}
 checks.push('320/390/820 mobile/tablet light/dark and incident dialog without overflow');
 await page.goto(base,{waitUntil:'networkidle'});await page.route('**/data/status.json?*',r=>r.fulfill({status:503,body:'unavailable'}));await page.locator('#refresh').click();await page.getByText('Refresh failed · current evidence unavailable').waitFor();assert.equal(await page.locator('#overall-badge').innerText(),'Unknown');checks.push('failed refresh invalidates current evidence to Unknown');

 const fresh=await browser.newPage({viewport:{width:390,height:844}});fresh.on('pageerror',e=>errors.push(e.message));const at=new Date().toISOString();
 await fresh.route('**/data/status.json?*',r=>r.fulfill({json:{schemaVersion:1,generatedAt:at,probes:{'home-http':{status:'operational',reasonCode:'ok',observedAt:at,httpStatus:200,responseMs:150},'home-render':{status:'operational',reasonCode:'ok',observedAt:at,lcpMs:700}},freshness:{}}}));
 await fresh.clock.install({time:new Date()});await fresh.goto(base+'/#component/home',{waitUntil:'networkidle'});await fresh.locator('dialog[open]').waitFor();assert.equal(await fresh.locator('#detail-content > div > .badge').innerText(),'Operational');
 await fresh.clock.fastForward(16*60000);await fresh.waitForFunction(()=>document.querySelector('#detail-content > div > .badge')?.textContent==='Unknown');checks.push('open Operational detail expires to Unknown after check TTL');
 await fresh.close();
 const flaky=await browser.newPage({viewport:{width:1440,height:900}});flaky.on('pageerror',e=>errors.push(e.message));const now=new Date().toISOString();
 const probes=Object.fromEntries(registry.probes.filter(p=>p.type==='http').map(p=>[p.id,{status:'operational',reasonCode:'ok',observedAt:now,httpStatus:200,responseMs:120}]));
 probes['request-window']={status:'partial_outage',reasonCode:'intermittent_failures',observedAt:now,failedRuns:2,windowRuns:6,failedChecks:4,totalChecks:60,affected:['console-http','watch-http']};
 await flaky.route('**/data/status.json?*',r=>r.fulfill({json:{schemaVersion:1,generatedAt:now,probes,freshness:{}}}));
 const t=Date.now(),iso=m=>new Date(t-m*60000).toISOString();
 await flaky.route('**/data/runs.json?*',r=>r.fulfill({json:{schemaVersion:1,runs:[{at:iso(30),n:10,f:[],s:[]},{at:iso(25),n:10,f:['console-http','watch-http','home-http'],s:[]},{at:iso(20),n:10,f:[],s:[]},{at:iso(15),n:10,f:['console-http'],s:[]},{at:iso(10),n:10,f:[],s:[]},{at:iso(5),n:10,f:[],s:[]},{at:iso(0),n:10,f:[],s:[]}]}}));
 await flaky.goto(base,{waitUntil:'networkidle'});await flaky.locator('#stats-table tbody th').first().waitFor();
 assert.equal(await flaky.locator('#overview-title').innerText(),'Intermittent failures');assert.match(await flaky.locator('#overview-description').innerText(),/4 of 60 site checks failed/);
 assert.match(await flaky.locator('#stats-table tbody tr').first().innerText(),/4 of 70/);await flaky.screenshot({path:evidence+'/intermittent.png'});
 checks.push('intermittent multi-site failures headline and sampled downtime statistics render from fixtures');await flaky.close();
 const failedPage=await browser.newPage();failedPage.on('pageerror',e=>errors.push(e.message));await failedPage.route('**/data/components.json?*',r=>r.fulfill({json:{groups:[null],components:[null],probes:[]}}));await failedPage.goto(base,{waitUntil:'networkidle'});await failedPage.getByText('Service status unavailable',{exact:true}).waitFor();assert.equal(await failedPage.locator('#overall-badge').innerText(),'Unknown');await failedPage.close();checks.push('invalid initial registry fails closed without uncaught error');

 const readable=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});readable.on('pageerror',e=>errors.push(e.message));await readable.goto(base,{waitUntil:'networkidle'});await readable.evaluate(()=>document.fonts.ready);assert.ok(await readable.evaluate(()=>document.fonts.check('500 16px "Inter Variable"')&&document.fonts.check('600 28px "Inter Tight Variable"')));assert.ok(await readable.locator('img').evaluateAll(nodes=>nodes.every(n=>n.complete&&n.naturalWidth>0)));assert.equal(await readable.locator('.brand-mark').count(),0);checks.push('real SVG brand and theme-aware product images load; both self-hosted variable fonts render');
 for(const width of [1440,820,390,320])for(const theme of ['light','dark']){await readable.setViewportSize({width,height:1000});await readable.emulateMedia({colorScheme:theme});await readable.goto(base,{waitUntil:'networkidle'});await readable.evaluate(()=>document.documentElement.style.fontSize='200%');if (!(await readable.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))) { await readable.screenshot({path:evidence+`/failure-text-200-${width}-${theme}.png`,fullPage:true}); console.log(await readable.evaluate(()=>[...document.querySelectorAll('body *')].filter(n=>n.getBoundingClientRect().right>innerWidth+1).map(n=>({tag:n.tagName,class:n.className,width:n.getBoundingClientRect().width,right:n.getBoundingClientRect().right})).slice(0,20))); } assert.ok(await readable.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`200% text overflow ${width} ${theme}`);await readable.screenshot({path:evidence+`/text-200-${width}-${theme}.png`,fullPage:true});await readable.screenshot({path:evidence+`/text-200-${width}-${theme}-viewport.png`,fullPage:false});await readable.locator('.group-history').first().click();await readable.locator('dialog[open]').waitFor();assert.ok(await readable.locator('dialog').evaluate(n=>n.scrollWidth<=n.clientWidth),`200% dialog overflow ${width} ${theme}`);await readable.getByRole('button',{name:'Previous day',exact:true}).click();await readable.getByRole('button',{name:'Next day',exact:true}).click();await readable.getByRole('button',{name:'Close details'}).click();await readable.locator('dialog').waitFor({state:'hidden'});}
 checks.push('200% text at 1440/820/390/320 in both themes; no overflow and touch-sized previous/next date controls work');await readable.close();
 assert.deepEqual(errors,[]);checks.push('no uncaught browser errors');
 await writeFile(evidence+'/report.json',JSON.stringify({headless:true,checks,errors,browser:browser.version(),at:new Date().toISOString()},null,2));console.log(JSON.stringify({checks,errors}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
