#!/usr/bin/env node
// Real Chromium/Edge, synthetic states only. Planning writes are offline fixture
// setup; all browser interactions are read-only and must issue zero write calls.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { applyRoadmapPlan } from '../scripts/plan-roadmap.mjs';
import { renderMap } from '../scripts/render-map.mjs';
import { startReviewService } from '../scripts/review-service.mjs';
import { sha256Bytes } from '../scripts/state-store.mjs';
import { ACCEPTANCE_TARGET } from './acceptance-fixtures.mjs';
import { CAPABILITY, ROADMAP, encode, makeItem, makeMcpState, makePlan, stored, writeFixture } from './mcp-fixtures.mjs';
import { launchBrowser } from './browser-harness.mjs';

const executable=process.argv[2];
if(!executable)throw new Error('Usage: node tests/browser-roadmap.mjs <chromium-executable> [report-directory]');
const output=resolve(process.argv[3]||join(tmpdir(),'roadmap-browser'));await mkdir(output,{recursive:true});
const directory=await mkdtemp(join(output,'roadmap-')),statePath=join(directory,'state.json');
let state=makeMcpState({roadmap:false});
state.nodes.push({id:'capability:later',kind:'capability',label:'合成稍后功能',status:'candidate',evidenceIds:[]});
await writeFixture(statePath,state);
const oldItem=makeItem({objective:'当时 v2 的规划目标',horizon:'next',status:'idea'});
await applyRoadmapPlan(statePath,makePlan(state,encode(state),[oldItem]),{authorized:true,clock:'2026-11-12T04:00:00.000Z'});
let loaded=await stored(statePath);
const currentItem=makeItem({objective:'现在 v3 的规划目标 <img src=x onerror="window.__roadmapXss=1">',scope:['合成范围'],exclusions:['不是产品授权'],acceptanceCriteria:['只是一项目标，不是通过结果'],dependsOn:['roadmap:later']});
const later=makeItem({id:'roadmap:later',nodeId:'capability:later',objective:'合成稍后目标',horizon:'later',status:'paused',blockers:['等待用户确认']});
await applyRoadmapPlan(statePath,makePlan(loaded.state,loaded.bytes,[currentItem,later]),{authorized:true,clock:'2026-11-12T04:10:00.000Z'});
loaded=await stored(statePath);
const staticPath=join(directory,'static.html');await writeFile(staticPath,renderMap(loaded.state),{flag:'wx'});
const service=await startReviewService(statePath,{port:0,logger:()=>{},projectRoot:directory});
const before=await readFile(statePath),names=await readdir(directory);
let browser,page;const records=[],q=JSON.stringify,api='window.__productContinuityGraph';
async function settle(){await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');}
async function open(){await page.navigate(service.url+'/?claim='+encodeURIComponent(ACCEPTANCE_TARGET));await page.waitFor(api+'&&document.querySelector("#review-close").hidden===false');await settle();}
async function clickNative(selector){
  await page.evaluate(`document.querySelector(${q(selector)}).scrollIntoView({block:'center'})`);
  const point=await page.evaluate(`(()=>{const r=document.querySelector(${q(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for(const type of ['mousePressed','mouseReleased'])await page.send('Input.dispatchMouseEvent',{type,...point,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});await settle();
}
async function version(index){await page.evaluate(`document.querySelector('#graph-time-range').value=${q(String(index))};document.querySelector('#graph-time-range').dispatchEvent(new Event('input'))`);await page.waitFor('document.querySelector("#graph-time").getAttribute("aria-busy")==="false"');await settle();}
async function check(name,run){
  try{await open();await run();records.push({name,passed:true});console.log('ROADMAP_PASS '+name);}
  catch(error){records.push({name,passed:false,error:error.message,stack:error.stack});await page.screenshot(join(directory,'failure-'+records.length+'.png')).catch(()=>{});console.error('ROADMAP_FAIL '+name+': '+error.stack);}
}
try{
  browser=await launchBrowser(executable,tmpdir());page=await browser.newPage();await page.resize(1440,1000);
  await check('planning entry opens same-page non-modal index and full details with no write controls or XSS',async()=>{
    const cardProgress=await page.evaluate(`(()=>{const node=document.querySelector('.graph-node[data-node-id=${q(CAPABILITY)}]');return {lines:[...node.querySelectorAll('.graph-node-progress')].map((line)=>line.textContent),aria:node.querySelector('.graph-node-select').getAttribute('aria-label'),height:node.getBoundingClientRect().height}})()`);
    assert.deepEqual(cardProgress.lines,['尚无续接记录','下一步未记录']);assert.match(cardProgress.aria,/尚无续接记录/);assert.equal(cardProgress.height,128);
    await page.click('#graph-roadmap');assert.equal(await page.evaluate('document.activeElement.id'),'roadmap-panel-title');
    assert.equal(await page.evaluate('document.querySelector("#roadmap-panel").getAttribute("role")'),'region');
    const rowProgress=await page.evaluate(`document.querySelector('#roadmap-list [data-roadmap-item=${q(ROADMAP)}] [data-testid=roadmap-item-progress]').textContent`);
    assert.match(rowProgress,/尚无续接记录/);assert.match(rowProgress,/下一步未记录/);assert.doesNotMatch(rowProgress,/%|已交付|全部完成/);
    await page.click(`#roadmap-panel [data-roadmap-item=${q(ROADMAP)}]`);
    const text=await page.evaluate('document.querySelector("#roadmap-panel-body").textContent');
    for(const term of ['现在 v3','不是开发、评审或验证授权','规划目标','范围','排除','验收目标','依赖','阻塞','关闭原因','定义、执行、运行时分开','定义不等于测试通过','defined_only'])assert.ok(text.includes(term),term);
    const close = await page.evaluate(`(()=>{const button=document.querySelector('#roadmap-close'),r=button.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(button);const lines=Array.from(range.getClientRects());return {whiteSpace:getComputedStyle(button).whiteSpace,lines:lines.length,inside:r.right<=document.querySelector('#review-panel').getBoundingClientRect().right}})()`);
    assert.equal(close.whiteSpace,'nowrap');assert.equal(close.lines,1);assert.equal(close.inside,true);
    assert.equal(await page.evaluate('Boolean(window.__roadmapXss)'),false);assert.equal(await page.evaluate('document.querySelectorAll("#roadmap-panel img,#roadmap-panel script,#roadmap-panel form,#roadmap-panel textarea,#roadmap-panel [data-action]").length'),0);
    await page.screenshot(join(directory,'current-roadmap-detail.png'));
  });
  await check('opening, filtering and closing planning preserves exact editor DOM, draft, URL and canvas view',async()=>{
    await page.click(`#intent-list [data-action="defer"][data-claim-id=${q(ACCEPTANCE_TARGET)}]`);
    await page.type('#review-panel-body textarea','Unsaved draft across planning');
    await page.evaluate('window.__roadmapEditor=document.querySelector("#review-panel-body textarea")');
    await page.click('#graph-zoom-in');const view=await page.evaluate(api+'.getViewState()'),route=await page.evaluate('location.href');
    await page.click('#graph-roadmap');await page.click('#roadmap-panel [data-roadmap-filter="now"]');
    assert.equal(await page.evaluate('document.querySelectorAll("#roadmap-panel .roadmap-item").length'),1);
    await page.click(`#roadmap-panel [data-roadmap-item=${q(ROADMAP)}]`);await page.click('#roadmap-close');
    assert.equal(await page.evaluate('document.activeElement.dataset.roadmapItem'),ROADMAP);
    assert.equal(await page.evaluate('document.querySelector("#review-panel-body textarea")===window.__roadmapEditor'),true);
    assert.equal(await page.evaluate('window.__roadmapEditor.value'),'Unsaved draft across planning');assert.deepEqual(await page.evaluate(api+'.getViewState()'),view);assert.equal(await page.evaluate('location.href'),route);
  });
  await check('roadmap filters and dependency navigation are explicit and keyboard accessible',async()=>{
    await page.click('.roadmap-directory [data-roadmap-filter="later"]');assert.equal(await page.evaluate('document.querySelectorAll("#roadmap-list .roadmap-item").length'),1);
    await page.click('.roadmap-directory [data-roadmap-filter="all"]');
    await page.evaluate(`document.querySelector('#roadmap-list [data-roadmap-item=${q(ROADMAP)}]').focus()`);await page.key('Enter');
    await page.click('#roadmap-panel [data-testid="roadmap-dependency"]');assert.match(await page.evaluate('document.querySelector("#roadmap-panel-body").textContent'),/合成稍后目标/);
    await page.key('Escape');assert.equal(await page.evaluate('document.querySelector("#roadmap-panel").hidden'),true);
  });
  await check('locate selects the stable capability, not a duplicate feature or a review action',async()=>{
    await page.click(`#roadmap-list [data-roadmap-item=${q(ROADMAP)}]`);await page.click('#roadmap-panel [data-roadmap-locate]');
    assert.equal((await page.evaluate(api+'.getViewState()')).selectedId,CAPABILITY);
    assert.equal(await page.evaluate(`document.querySelectorAll('.graph-node[data-node-id=${q(CAPABILITY)}]').length`),1);
    assert.equal(await page.evaluate('document.querySelector("#roadmap-panel").hidden'),false);
  });
  await check('an explicit current review action exits the planning index and exposes its editor, without submitting',async()=>{
    await page.click('#graph-roadmap');
    await page.click(`#intent-list [data-action="defer"][data-claim-id=${q(ACCEPTANCE_TARGET)}]`);
    assert.equal(await page.evaluate('document.querySelector("#roadmap-panel").hidden'),true);
    assert.equal(await page.evaluate('document.querySelector("#review-current").hidden'),false);
    assert.equal(await page.evaluate('document.querySelector("#review-panel-body textarea").getClientRects().length>0'),true);
  });
  await check('historical v1 has no roadmap and never leaks current item, counts, detail or editor',async()=>{
    await page.click(`#roadmap-list [data-roadmap-item=${q(ROADMAP)}]`);await version(0);
    assert.match(await page.evaluate('document.querySelector("#roadmap-list").textContent'),/当时没有规划记录/);
    assert.doesNotMatch(await page.evaluate('document.querySelector("#roadmap-list").textContent'),/现在 v3/);
    assert.match(await page.evaluate('document.querySelector("#roadmap-counts").textContent'),/共 0 项/);
    assert.equal(await page.evaluate('document.querySelector("#roadmap-panel").hidden'),true);
    assert.equal(await page.evaluate('document.querySelector("#review-current").hidden'),true);
    await page.click('#graph-roadmap');assert.doesNotMatch(await page.evaluate('document.querySelector("#history-panel").textContent'),/现在 v3/);
  });
  await check('historical v2 has its original planning and returns to exact current draft, view and filter',async()=>{
    await page.click(`#intent-list [data-action="defer"][data-claim-id=${q(ACCEPTANCE_TARGET)}]`);await page.type('#review-panel-body textarea','Current draft across roadmap history');
    await page.evaluate('window.__roadmapEditor=document.querySelector("#review-panel-body textarea")');await page.click('#graph-zoom-in');
    const view=await page.evaluate(api+'.getViewState()'),route=await page.evaluate('location.href');
    await page.click('.roadmap-directory [data-roadmap-filter="next"]');await version(1);
    assert.match(await page.evaluate('document.querySelector("#roadmap-list").textContent'),/当时 v2/);assert.match(await page.evaluate('document.querySelector("#graph-time-label").textContent'),/规划记录，非评审/);
    await page.click(`#roadmap-list [data-roadmap-item=${q(ROADMAP)}]`);assert.match(await page.evaluate('document.querySelector("#history-panel").textContent'),/当时 v2/);
    assert.doesNotMatch(await page.evaluate('document.querySelector("#history-panel").textContent'),/现在 v3|data-action/);
    await page.click('#graph-time-now');await settle();
    assert.deepEqual(await page.evaluate(api+'.getViewState()'),view);assert.equal(await page.evaluate('document.querySelector("#review-panel-body textarea")===window.__roadmapEditor'),true);
    assert.equal(await page.evaluate('window.__roadmapEditor.value'),'Current draft across roadmap history');assert.equal(await page.evaluate('location.href'),route);
    assert.equal(await page.evaluate('document.querySelector(".roadmap-directory [data-roadmap-filter=next]").getAttribute("aria-pressed")'),'true');
    assert.match(await page.evaluate('document.querySelector("#roadmap-list").textContent'),/没有规划项/);
    await page.click('.roadmap-directory [data-roadmap-filter="all"]');
  });
  await check('missing historical snapshot blanks planning rather than borrowing current data',async()=>{
    const backup=(await readdir(directory)).find(n=>n.startsWith('state.json.bak.2.'));
    await rename(join(directory,backup),join(directory,backup+'.failed'));
    try{await version(1);assert.match(await page.evaluate('document.querySelector("#roadmap-list").textContent'),/无法核验/);assert.doesNotMatch(await page.evaluate('document.querySelector("#roadmap-counts").textContent'),/Now 1/);}
    finally{await rename(join(directory,backup+'.failed'),join(directory,backup));}
  });
  for(const fallback of [false,true])await check((fallback?'window-fill':'native fullscreen')+' retains planning entry, draft and Esc priority',async()=>{
    await page.resize(1280,800);await page.click(`#intent-list [data-action="defer"][data-claim-id=${q(ACCEPTANCE_TARGET)}]`);await page.type('#review-panel-body textarea','Draft under fullscreen planning');
    await page.evaluate('window.__roadmapEditor=document.querySelector("#review-panel-body textarea")');
    if(fallback)await page.evaluate('document.querySelector("#review-workspace").requestFullscreen=undefined');
    await clickNative('#graph-fullscreen');await page.waitFor('document.querySelector("#graph-fullscreen").getAttribute("aria-pressed")==="true"');
    await clickNative('#graph-roadmap');await page.click(`#roadmap-panel [data-roadmap-item=${q(ROADMAP)}]`);
    assert.equal(await page.evaluate('document.querySelector("#roadmap-panel").hidden'),false);
    await page.click('#roadmap-close');assert.equal(await page.evaluate('document.activeElement.id'),'graph-roadmap');
    await page.click('#graph-roadmap');await page.click(`#roadmap-panel [data-roadmap-item=${q(ROADMAP)}]`);
    await page.screenshot(join(directory,fallback?'roadmap-window.png':'roadmap-fullscreen.png'));
    await page.key('Escape');await page.waitFor('!document.querySelector(".continuity-fullscreen-host")');
    assert.equal(await page.evaluate('document.querySelector("#roadmap-panel").hidden'),false,'first Esc exits fullscreen only');
    await page.key('Escape');assert.equal(await page.evaluate('document.querySelector("#roadmap-panel").hidden'),true);
    assert.equal(await page.evaluate('document.querySelector("#review-panel-body textarea")===window.__roadmapEditor'),true);assert.equal(await page.evaluate('window.__roadmapEditor.value'),'Draft under fullscreen planning');await page.resize(1440,1000);
  });
  await check('static map planning uses existing inspector with no review controls or requests',async()=>{
    await page.navigate(pathToFileURL(staticPath).href);await page.waitFor(api+'&&document.querySelector("#graph-roadmap")');
    await page.click('#graph-roadmap');await page.click(`#graph-inspector-content [data-roadmap-item=${q(ROADMAP)}]`);
    assert.match(await page.evaluate('document.querySelector("#graph-inspector-content").textContent'),/现在 v3/);
    assert.equal(await page.evaluate('document.querySelectorAll("#graph-inspector-content [data-action],#graph-inspector-content [data-open-claim],#graph-inspector-content img").length'),0);
    await page.click('#graph-inspector-content [data-roadmap-locate]');assert.equal((await page.evaluate(api+'.getViewState()')).selectedId,CAPABILITY);
  });
  const writes=browser.events.filter(e=>e.method==='Network.requestWillBeSent'&&['POST','PUT','PATCH','DELETE'].includes(e.params.request.method));
  const errors=browser.events.filter(e=>e.method==='Runtime.exceptionThrown');
  records.push({name:'zero browser writes, zero exceptions and unchanged saved state/artifacts',passed:writes.length===0&&errors.length===0});
  assert.deepEqual(await readFile(statePath),before);assert.deepEqual((await readdir(directory)).filter(n=>!n.endsWith('.png')).sort(),names.sort());
  const report={browser:executable,syntheticOnly:true,directory,checks:records,passed:records.filter(r=>r.passed).length,failed:records.filter(r=>!r.passed).length,writeRequests:writes.length,runtimeErrors:errors,stateDigest:sha256Bytes(before)};
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({passed:report.passed,failed:report.failed,report:join(output,'report.json')}));
  assert.equal(report.failed,0);
}finally{await page?.close().catch(()=>{});await browser?.close();await service.close();}
