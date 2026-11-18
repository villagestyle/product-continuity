#!/usr/bin/env node
// Synthetic temporary states only. Browser checks issue no review/write request.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { applyReview, previewReview } from '../scripts/review-actions.mjs';
import { startReviewService } from '../scripts/review-service.mjs';
import { applyMapMaintenance } from '../scripts/maintain-map.mjs';
import { sha256Bytes, validateFullState } from '../scripts/state-store.mjs';
import { makeAcceptanceState, ACCEPTANCE_NODE, ACCEPTANCE_TARGET } from './acceptance-fixtures.mjs';
import { launchBrowser } from './browser-harness.mjs';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node tests/browser-timeline.mjs <chromium-executable> [report-directory]');
const output = resolve(process.argv[3] || join(tmpdir(), 'continuity-timeline-checks'));
await mkdir(output,{recursive:true});
const directory = await mkdtemp(join(output,'timeline-browser-'));
const statePath = join(directory,'project-state.json');
const bytesOf = (state) => Buffer.from(JSON.stringify(state,null,2)+'\n');
let state = makeAcceptanceState(), index = 0, serial = 0;
async function advance(action, targetId, payload) {
  const before = bytesOf(state), digest = sha256Bytes(before);
  await writeFile(`${statePath}.bak.${state.stateVersion}.${digest.slice(7,15)}.${String(++index).padStart(8,'0')}`,before);
  const request = {projectId:state.project.id,action,targetClaimId:targetId,payload,expectedStateVersion:state.stateVersion,expectedDigest:digest};
  const previewRequest = structuredClone(request);
  for (const key of ['confirmationAttested','coverageAttested','singleIntentAttested','changeScopeAttested','stopAttested']) delete previewRequest.payload[key];
  const plan = previewReview(state,previewRequest,{fileDigest:digest});
  if (plan.requiresPreview) request.payload.previewDigest = plan.previewDigest;
  const result = applyReview(state,{...request,idempotencyKey:randomUUID()},{fileDigest:digest,clock:`2026-11-11T0${index}:00:00.000Z`,idFactory:(kind)=>`${kind}:timeline-${++serial}`});
  state = result.state;
  // Explicit synthetic maintenance between versions, not invented user history.
  if (index === 1) {
    state.nodes.push({id:'unknown:historical-only',kind:'unknown',label:'仅存在于 v2 的合成分支',status:'unknown',evidenceIds:[]});
    state.edges.push({id:'edge:historical-only',from:'task:acceptance',to:'unknown:historical-only',kind:'contains'});
    state.nodes.find((node)=>node.id==='task:acceptance').label='v2 的任务名称（合成）';
  }
  if (index === 2) {
    state.nodes = state.nodes.filter((node)=>node.id!=='unknown:historical-only');
    state.edges = state.edges.filter((edge)=>edge.id!=='edge:historical-only');
    state.nodes.find((node)=>node.id==='task:acceptance').label='当前任务名称（合成）';
  }
  assert.deepEqual(validateFullState(state),[]);
  return result;
}
await advance('edit_candidate',ACCEPTANCE_TARGET,{content:{statement:'合成意图：可以新增一条记录',scope:['Synthetic browser checks'],conditions:[],exceptions:[]},assessment:{disposition:'single',reviewedLegacyContext:false}});
const preparedClaim = state.intentClaims.find((claim)=>claim.status==='candidate').id;
await advance('confirm_candidate',preparedClaim,{confirmationAttested:true});
await advance('propose_edit',preparedClaim,{replacement:{statement:'合成修改：新增记录展示来源',scope:['Synthetic browser checks'],conditions:[],exceptions:[]},rationale:'Synthetic timeline proposal'});
await advance('defer',preparedClaim,{reason:'needs_evidence'});
await advance('defer',preparedClaim,{reason:'needs_decision'});
// Enough events to exercise pagination; undated evidence remains undated.
for (let count=0;count<40;count++) state.evidence.push({id:`evidence:timeline-extra-${count}`,kind:'inference',claim:`Synthetic provenance ${count}`,validation:'not_applicable',observedAt:`2026-11-10T${String(count%24).padStart(2,'0')}:00:00.000Z`});
state.evidence.push({id:'evidence:unsafe-label',kind:'inference',claim:'<img src=x onerror="window.__timelineUnsafe=true">',validation:'not_applicable'});
assert.deepEqual(validateFullState(state),[]);
// These synthetic material additions represent a non-review maintenance version.
// No fake review is added, and the current sample must use its read time.
state.stateVersion++;
const stateBytes = bytesOf(state);
await writeFile(statePath,stateBytes,{flag:'wx'});
let service = await startReviewService(statePath,{port:0,logger:()=>{},projectRoot:directory});
let browser, page;
const records = [];
const graphApi = 'window.__productContinuityGraph';
const q = JSON.stringify;
async function settle() {await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');}
async function open() {
  await page.navigate(service.url+'/?claim='+encodeURIComponent(preparedClaim));
  await page.waitFor(graphApi+' && document.querySelector("#timeline-event-list button")');
  if (state.intentClaims.some((claim)=>claim.id===preparedClaim)) await page.waitFor('document.querySelector("#review-close").hidden===false');
  await nativeClick('#graph-timeline');
  await page.waitFor('document.querySelector("#product-timeline").open');
  await settle();
}
async function selectEvent(collection, id) {
  await page.type('#timeline-search',id);
  const eventId = collection+':'+id+':'+(collection==='evidence'?'observedAt':collection==='decisions'?'confirmedAt':'createdAt');
  await page.click(`[data-timeline-event=${q(eventId)}]`);
}
async function check(name,run) {
  try {
    await open(); await run(); records.push({name,passed:true}); console.log('TIMELINE_PASS '+name);
  } catch(error) {
    records.push({name,passed:false,error:error.message,stack:error.stack});
    await page.screenshot(join(directory,'failure-'+records.length+'.png')).catch(()=>{});
    console.error('TIMELINE_FAIL '+name+': '+error.stack);
  }
}
async function nativeClick(selector) {
  await page.evaluate(`document.querySelector(${q(selector)}).scrollIntoView({block:'center'})`);
  const point=await page.evaluate(`(()=>{const r=document.querySelector(${q(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for (const type of ['mousePressed','mouseReleased']) await page.send('Input.dispatchMouseEvent',{type,...point,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});
  await settle();
}
async function goVersion(version) {
  await page.evaluate(`(()=>{const slider=document.querySelector('#graph-time-range');slider.value=${q(String(version))};slider.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await page.waitFor('document.querySelector("#graph-time").getAttribute("aria-busy")==="false"');
}
try {
  browser = await launchBrowser(executable,tmpdir());
  page = await browser.newPage(); await page.resize(1440,1000);
  await check('native slider dragging replaces the full historical tree and restores the exact current draft and view',async()=>{
    await page.evaluate('document.querySelector("#product-timeline").open=false');
    assert.equal(await page.evaluate('document.querySelector("#timeline-category option[value=checkpoint]").textContent'),'续接记录（非评审）');
    await page.click(`#intent-list [data-action="defer"][data-claim-id=${q(preparedClaim)}]`);
    await page.type('#review-panel-body textarea','Unsaved current draft across historical trees');
    await page.evaluate('window.__travelEditor=document.querySelector("#review-panel-body textarea")');
    await page.click('#graph-zoom-in');
    await page.click(`.graph-node[data-node-id=${q(ACCEPTANCE_NODE)}] .graph-branch-toggle`);
    const before = await page.evaluate(graphApi+'.getViewState()'), route = await page.evaluate('location.href');
    await page.evaluate('document.querySelector("#graph-time-range").scrollIntoView({block:"center"})');
    const r = await page.evaluate('(()=>{const r=document.querySelector("#graph-time-range").getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()');
    const y=r.y+r.h/2, right=r.x+r.w-8, left=r.x+8, target=left+(right-left)/5;
    await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:right,y,button:'left',buttons:1,clickCount:1});
    for(let step=1;step<=8;step++)await page.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:right+(target-right)*step/8,y,button:'left',buttons:1});
    await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:target,y,button:'left',buttons:0,clickCount:1});
    await page.waitFor('document.querySelector("#graph-time").dataset.version==="2"&&document.querySelector("#graph-time").getAttribute("aria-busy")==="false"');
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'),6);
    assert.equal(await page.evaluate('Boolean(document.querySelector(\'.graph-node[data-node-id="unknown:historical-only"]\'))'),true);
    assert.match(await page.evaluate('document.querySelector("#graph-world").textContent'),/v2 的任务名称/);
    assert.match(await page.evaluate('document.querySelector("#graph-time-label").textContent'),/历史 · 只读 · v2/);
    await page.click(`.graph-node[data-node-id=${q(ACCEPTANCE_NODE)}] .graph-node-select`);
    assert.match(await page.evaluate('document.querySelector("#history-panel").textContent'),/合成意图：可以新增一条记录/);
    assert.equal(await page.evaluate('document.querySelector("#review-current").hidden'),true);
    assert.equal(await page.evaluate('document.querySelector("#product-timeline").hidden'),true);
    assert.equal(await page.evaluate('document.querySelector("#review-workspace .directory").hidden'),true);
    assert.equal(await page.evaluate('document.querySelectorAll("#history-panel [data-action],#history-panel form,#history-panel [data-submit]").length'),0);
    assert.equal(await page.evaluate('document.querySelector("#review-writable").textContent'),'历史浏览 · 只读');
    await page.click('#graph-cross');
    await page.click(`#intent-list [data-action="defer"][data-claim-id=${q(preparedClaim)}]`);
    assert.equal(await page.evaluate('document.querySelector("#review-panel-body textarea")===window.__travelEditor'),true);
    assert.equal(await page.evaluate('location.href'),route);
    await page.screenshot(join(directory,'historical-tree-v2.png'));
    await page.click('#graph-time-next');await page.waitFor('document.querySelector("#graph-time").getAttribute("aria-busy")==="false"');
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'),5);
    assert.match(await page.evaluate(`document.querySelector('.graph-node[data-node-id=${q(ACCEPTANCE_NODE)}] .graph-node-status').textContent`),/已确认/);
    await page.click('#history-panel .history-panel-head button');await settle();
    assert.deepEqual(await page.evaluate(graphApi+'.getViewState()'),before);
    assert.equal(await page.evaluate('document.querySelector("#review-panel-body textarea")===window.__travelEditor'),true);
    assert.equal(await page.evaluate('window.__travelEditor.value'),'Unsaved current draft across historical trees');
    assert.equal(await page.evaluate('location.href'),route);
    assert.equal(await page.evaluate('document.activeElement.id'),'graph-time-range');
    assert.equal(await page.evaluate('document.querySelector("#product-timeline").hidden'),false);
    assert.equal(await page.evaluate('document.querySelector("#review-workspace .directory").hidden'),false);
    assert.equal(await page.evaluate('document.querySelector("#graph-cross").checked'),true);
  });
  await check('keyboard version axis handles unknown times, missing versions and endpoint bounds',async()=>{
    await page.evaluate('document.querySelector("#graph-time-range").focus()');await page.key('Home');
    await page.waitFor('document.querySelector("#graph-time").dataset.version==="1"&&document.querySelector("#graph-time").getAttribute("aria-busy")==="false"');
    assert.match(await page.evaluate('document.querySelector("#graph-time-label").textContent'),/保存时间未知/);
    await page.key('ArrowRight');await page.waitFor('document.querySelector("#graph-time").dataset.version==="2"&&document.querySelector("#graph-time").getAttribute("aria-busy")==="false"');
    assert.equal(await page.evaluate('document.activeElement.id'),'graph-time-range');
    await page.key('End');await settle();
    assert.match(await page.evaluate('document.querySelector("#graph-time-label").textContent'),/现在 · v7 · 本次读取，非保存时间/);
    assert.match(await page.evaluate('document.querySelector("#graph-time-note").textContent'),/缺口/);
    assert.equal(await page.evaluate('document.querySelector("#graph-time-next").disabled'),true);
    assert.equal(await page.evaluate('document.querySelector("#graph-time-now").disabled'),true);
  });
  await check('out-of-order snapshot responses and returning now never replace a newer selection',async()=>{
    await page.evaluate(`window.__travelFetch=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).startsWith('/api/snapshot?')&&new URL(args[0],location.href).searchParams.get('version')==='1'){const r=await window.__travelFetch(args[0]);window.__travelDelayed=true;await new Promise(resolve=>window.__releaseTravel=resolve);return r;}return window.__travelFetch(...args)}`);
    await page.evaluate('document.querySelector("#graph-time-range").value="0";document.querySelector("#graph-time-range").dispatchEvent(new Event("input"))');
    await page.waitFor('window.__travelDelayed===true');
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'),0,'old current tree must not pretend to be the loading version');
    await goVersion(1);
    await page.evaluate('window.__releaseTravel()');await settle();
    assert.equal(await page.evaluate('document.querySelector("#graph-time").dataset.version'),'2');
    assert.match(await page.evaluate('document.querySelector("#graph-world").textContent'),/仅存在于 v2/);
    await page.evaluate('window.__travelDelayed=false;document.querySelector("#graph-time-range").value="0";document.querySelector("#graph-time-range").dispatchEvent(new Event("input"))');
    await page.waitFor('window.__travelDelayed===true');
    await page.click('#graph-time-now');await page.evaluate('window.__releaseTravel()');await settle();
    assert.equal(await page.evaluate('document.querySelector("#graph-time").dataset.mode'),'current');
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'),5);
    await page.evaluate('window.fetch=window.__travelFetch');
  });
  await check('deleted advertised snapshot blanks the tree rather than substituting another version',async()=>{
    const name=(await readdir(directory)).find((name)=>name.startsWith('project-state.json.bak.2.'));
    await rename(join(directory,name),join(directory,name+'.failed'));
    try {
      await goVersion(1);
      assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'),0);
      assert.match(await page.evaluate('document.querySelector("#graph-time-note").textContent'),/缺失或无法核验/);
      await page.evaluate('window.dispatchEvent(new Event("focus"))');await page.waitFor('document.querySelector("#graph-time-note").textContent.includes("不在可核验列表")');
      assert.equal(await page.evaluate('document.querySelector("#graph-time").dataset.mode'),'history');
      assert.equal(await page.evaluate('document.querySelector("#graph-time").dataset.version'),'2');
      assert.match(await page.evaluate('document.querySelector("#graph-time-note").textContent'),/不在可核验列表/);
      await page.click('#graph-time-now');
      assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'),5);
    } finally {await rename(join(directory,name+'.failed'),join(directory,name));}
  });
  await check('current refresh stays isolated from the selected history and returns to the new current tree without losing its editor',async()=>{
    await page.click(`#intent-list [data-action="defer"][data-claim-id=${q(preparedClaim)}]`);
    await page.type('#review-panel-body textarea','Draft during current refresh');
    await page.evaluate('window.__travelEditor=document.querySelector("#review-panel-body textarea")');
    const before=await page.evaluate(graphApi+'.getViewState()');
    await goVersion(1);
    await page.evaluate(`window.__travelFetch=window.fetch;window.fetch=async(...args)=>{const response=await window.__travelFetch(...args);if(String(args[0])!=='/api/state')return response;const body=await response.json();body.state.stateVersion=8;body.currentStateVersion=8;body.currentDigest=body.fileDigest='sha256:'+'e'.repeat(64);body.state.nodes[1].label='刷新后的当前任务（合成响应）';const current=body.timelineHistory.samples.find(s=>s.source==='current');current.stateVersion=8;current.digest=body.fileDigest;return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}})}`);
    await page.evaluate('window.dispatchEvent(new Event("focus"))');await page.waitFor('document.querySelector("#review-version").textContent==="8"&&document.querySelector("#graph-time").getAttribute("aria-busy")==="false"');
    assert.equal(await page.evaluate('document.querySelector("#graph-time").dataset.version'),'2');
    assert.match(await page.evaluate('document.querySelector("#graph-world").textContent'),/仅存在于 v2/);
    await page.click('#graph-time-now');await settle();
    assert.match(await page.evaluate('document.querySelector("#graph-world").textContent'),/刷新后的当前任务/);
    assert.deepEqual(await page.evaluate(graphApi+'.getViewState()'),before);
    assert.equal(await page.evaluate('document.querySelector("#review-panel-body textarea")===window.__travelEditor'),true);
    assert.equal(await page.evaluate('window.__travelEditor.value'),'Draft during current refresh');
    await page.evaluate('window.fetch=window.__travelFetch');
  });
  await check('snapshot session refusal preserves the current draft and keeps writes stopped after returning now',async()=>{
    await page.click(`#intent-list [data-action="defer"][data-claim-id=${q(preparedClaim)}]`);
    await page.type('#review-panel-body textarea','Draft on historical session refusal');
    await page.evaluate(`window.__travelEditor=document.querySelector('#review-panel-body textarea');window.__travelFetch=window.fetch;window.fetch=async(...args)=>String(args[0]).startsWith('/api/snapshot?')?new Response(JSON.stringify({ok:false,error:{code:'no_session',message:'Synthetic session refusal'}}),{status:403,headers:{'Content-Type':'application/json'}}):window.__travelFetch(...args)`);
    await goVersion(1);await page.click('#graph-time-now');
    assert.equal(await page.evaluate('document.querySelector("#review-panel-body textarea")===window.__travelEditor'),true);
    assert.equal(await page.evaluate('document.querySelector("[data-submit]").disabled'),true);
    assert.match(await page.evaluate('document.querySelector("#review-alert").textContent'),/已停写/);
    await page.evaluate('window.fetch=window.__travelFetch');
  });
  for (const fallback of [false,true]) await check((fallback?'window-fill':'native fullscreen')+' supports historical tree inspection, pan, zoom, folding and keyboard return',async()=>{
    await page.resize(1280,720);
    await page.evaluate('document.querySelector("#product-timeline").open=false');
    if (fallback) await page.evaluate('document.querySelector("#review-workspace").requestFullscreen=undefined');
    const before=await page.evaluate(graphApi+'.getViewState()');
    await nativeClick('#graph-fullscreen');
    await page.waitFor('document.querySelector("#graph-fullscreen").getAttribute("aria-pressed")==="true"&&!document.querySelector("#graph-fullscreen").disabled');
    await goVersion(1);
    assert.equal(await page.evaluate('document.querySelector("#graph-time").dataset.version'),'2');
    const bounds=await page.evaluate('(()=>{const c=document.querySelector("#graph-viewport").getBoundingClientRect();const t=document.querySelector("#graph-time").getBoundingClientRect();return {canvas:c.height,axis:t.bottom<=innerHeight,noOverlap:c.bottom<=t.top+.5}})()');
    assert.ok(bounds.canvas>=300);assert.equal(bounds.axis,true);assert.equal(bounds.noOverlap,true);
    const view=await page.evaluate(graphApi+'.getViewState()');
    await nativeClick('#graph-zoom-in');await nativeClick('[data-pan="left"]');
    const panned=await page.evaluate(graphApi+'.getViewState()');assert.ok(panned.scale>view.scale);assert.notEqual(panned.tx,view.tx);
    await page.click('.graph-node[data-node-id="task:acceptance"] .graph-branch-toggle');
    assert.ok((await page.evaluate(graphApi+'.getViewState()')).collapsed.includes('task:acceptance'));
    await page.click('#graph-expand');
    await page.click('.graph-node[data-node-id="unknown:historical-only"] .graph-node-select');
    assert.match(await page.evaluate('document.querySelector("#history-panel").textContent'),/仅存在于 v2/);
    await page.screenshot(join(directory,fallback?'historical-tree-window.png':'historical-tree-fullscreen.png'));
    await page.key('Escape');await page.waitFor('!document.querySelector(".continuity-fullscreen-host")');
    assert.equal(await page.evaluate('document.querySelector("#graph-time").dataset.mode'),'history');
    await page.evaluate('document.querySelector("#graph-time-range").focus()');await page.key('End');await settle();
    assert.deepEqual(await page.evaluate(graphApi+'.getViewState()'),before);
    await page.resize(1440,1000);
  });
  await check('summary and history keep active denominators and non-review gaps honest',async()=>{
    await nativeClick('#timeline-progress-tab');
    assert.match(await page.evaluate('document.querySelector("#timeline-summary").textContent'),/意图 1\/1/);
    assert.match(await page.evaluate('document.querySelector("#timeline-overview").textContent'),/本次读取，非保存时间/);
    assert.match(await page.evaluate('document.querySelector("#timeline-overview").textContent'),/前有缺口/);
    assert.equal(await page.evaluate('document.querySelectorAll("#timeline-overview tbody tr").length'),6);
    assert.equal(await page.evaluate('document.querySelectorAll("#timeline-overview svg").length'),1,'Four historical review times qualify; current non-review read time is excluded.');
    assert.equal(await page.evaluate('document.querySelectorAll("#timeline-overview svg circle").length'),12);
    assert.equal(await page.evaluate('document.querySelector("#timeline-overview svg").getAttribute("role")'),'img');
    assert.equal(await page.evaluate('document.querySelectorAll("#timeline-overview svg path[stroke-dasharray]").length'),3);
    await page.screenshot(join(directory,'timeline-desktop.png'));
  });
  await check('graph-header entry is visible, focuses the timeline and reflects disclosure changes',async()=>{
    assert.equal(await page.evaluate('document.querySelector("#graph-timeline").hidden'),false);
    assert.equal(await page.evaluate('document.querySelector("#graph-timeline").getAttribute("aria-expanded")'),'true');
    assert.equal(await page.evaluate('document.activeElement.id'),'timeline-toggle');
    assert.equal(await page.evaluate('(()=>{const r=document.querySelector("#timeline-toggle").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()'),true);
    await nativeClick('#timeline-toggle'); await settle();
    assert.equal(await page.evaluate('document.querySelector("#graph-timeline").getAttribute("aria-expanded")'),'false');
    await nativeClick('#graph-timeline');
    assert.equal(await page.evaluate('document.querySelector("#graph-timeline").getAttribute("aria-expanded")'),'true');
    await nativeClick('#graph-timeline');
    assert.equal(await page.evaluate('document.querySelector("#product-timeline").open'),false);
  });
  await check('timeline stays within the bounded graph stage without page jump or view reset',async()=>{
    await page.navigate(service.url);
    await page.waitFor(graphApi+' && !document.querySelector("#graph-timeline").hidden');
    const before=await page.evaluate(`(()=>{const r=document.querySelector('.graph-stage').getBoundingClientRect();return {top:r.top,height:r.height,scrollY,view:${graphApi}.getViewState()}})()`);
    await nativeClick('#graph-timeline');
    const after=await page.evaluate(`(()=>{const stage=document.querySelector('.graph-stage').getBoundingClientRect();const canvas=document.querySelector('#graph-viewport').getBoundingClientRect();const dock=document.querySelector('#product-timeline').getBoundingClientRect();return {top:stage.top,height:stage.height,scrollY,view:${graphApi}.getViewState(),inside:document.querySelector('.graph-stage').contains(document.querySelector('#product-timeline')),noOverlap:canvas.bottom<=dock.top+.5,bounded:dock.bottom<=stage.bottom+.5,canvasHeight:canvas.height,internalScroll:getComputedStyle(document.querySelector('#product-timeline')).overflowY}})()`);
    assert.equal(after.inside,true);assert.equal(after.noOverlap,true);assert.equal(after.bounded,true);
    assert.equal(after.height,before.height);assert.equal(after.top,before.top);assert.equal(after.scrollY,before.scrollY);
    assert.deepEqual(after.view,before.view);assert.ok(after.canvasHeight>=160);assert.equal(after.internalScroll,'auto');
    await nativeClick('#graph-timeline');
    assert.deepEqual(await page.evaluate(graphApi+'.getViewState()'),before.view);
    await nativeClick('#graph-timeline');
    await page.screenshot(join(directory,'timeline-in-graph.png'));
  });
  await check('tabs preserve filters, selection, exact editor and canvas view with keyboard navigation',async()=>{
    await selectEvent('intentClaims',ACCEPTANCE_TARGET);
    const before=await page.evaluate(graphApi+'.getViewState()');
    await page.evaluate('window.__dockEditor=document.querySelector("#review-panel-body");document.querySelector("#timeline-events-tab").focus()');
    await page.key('ArrowRight');
    assert.equal(await page.evaluate('document.activeElement.id'),'timeline-progress-tab');
    assert.equal(await page.evaluate('document.querySelector("#timeline-progress").hidden'),false);
    assert.equal(await page.evaluate('document.querySelector("#timeline-events").hidden'),true);
    await page.key('Home');
    assert.equal(await page.evaluate('document.activeElement.id'),'timeline-events-tab');
    assert.equal(await page.evaluate('document.querySelector("#timeline-search").value'),ACCEPTANCE_TARGET);
    assert.equal(await page.evaluate('document.querySelectorAll("#timeline-event-list button[aria-pressed=true]").length'),1);
    assert.equal(await page.evaluate('window.__dockEditor===document.querySelector("#review-panel-body")'),true);
    assert.deepEqual(await page.evaluate(graphApi+'.getViewState()'),before);
    await page.key('End');await page.key('ArrowLeft');
    assert.equal(await page.evaluate('document.activeElement.id'),'timeline-events-tab');
    assert.equal(await page.evaluate(`document.querySelectorAll('.timeline-tabs [tabindex="0"]').length`),1);
  });
  await check('native dock scrolling, text selection and filters never become canvas gestures',async()=>{
    const before=await page.evaluate(graphApi+'.getViewState()');
    await nativeClick('#timeline-search');
    await page.send('Input.insertText',{text:'review:timeline'});await settle();
    assert.equal(await page.evaluate('document.querySelector("#timeline-search").value'),'review:timeline');
    await nativeClick('#timeline-filter-toggle');
    assert.equal(await page.evaluate('document.querySelector("#timeline-filters").hidden'),false);
    assert.equal(await page.evaluate('document.querySelector("#timeline-filter-toggle").getAttribute("aria-expanded")'),'true');
    await page.click('#timeline-reset');await nativeClick('#timeline-filter-toggle');
    await nativeClick('#timeline-event-list button');
    assert.equal(await page.evaluate('document.querySelectorAll("#timeline-event-list button[aria-pressed=true]").length'),1);
    const point=await page.evaluate('(()=>{const r=document.querySelector("#product-timeline").getBoundingClientRect();return {x:r.right-40,y:r.bottom-35}})()');
    await page.send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:300});
    await page.waitFor('document.querySelector("#product-timeline").scrollTop>0');
    assert.equal(await page.evaluate('document.querySelector(".graph-stage").contains(document.querySelector("#timeline-detail"))'),true);
    assert.deepEqual(await page.evaluate(graphApi+'.getViewState()'),before);
    await page.evaluate('(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector("#timeline-detail"));const selection=getSelection();selection.removeAllRanges();selection.addRange(range)})()');
    assert.ok(await page.evaluate('getSelection().toString().length')>0);
    assert.equal(await page.evaluate('document.documentElement.classList.contains("continuity-graph-gesture")'),false);
    await page.evaluate('getSelection().removeAllRanges()');
  });
  await check('UTC date and category filters exclude undated evidence and validate reversed range',async()=>{
    await nativeClick('#timeline-filter-toggle');
    await page.type('#timeline-category','validation');
    assert.match(await page.evaluate('document.querySelector("#timeline-event-list").textContent'),/测试定义/);
    await page.type('#timeline-start','2026-11-11');
    assert.match(await page.evaluate('document.querySelector("#timeline-event-list").textContent'),/没有符合条件/);
    await page.type('#timeline-end','2026-11-10');
    assert.match(await page.evaluate('document.querySelector("#timeline-filter-status").textContent'),/开始日期不能晚于/);
    await page.click('#timeline-reset');
    assert.equal(await page.evaluate('document.querySelector("#timeline-category").value'),'');
  });
  await check('search, node scope, chronological ordering and pagination stay independent of progress',async()=>{
    await nativeClick('#timeline-filter-toggle');
    const overview=await page.evaluate('document.querySelector("#timeline-summary").textContent');
    await page.type('#timeline-node',ACCEPTANCE_NODE);
    assert.ok(await page.evaluate('document.querySelectorAll("#timeline-event-list button").length')>0);
    await page.type('#timeline-search','not-a-record');
    assert.match(await page.evaluate('document.querySelector("#timeline-event-list").textContent'),/没有符合条件/);
    await page.click('#timeline-reset');
    assert.equal(await page.evaluate('document.querySelector("#timeline-page").textContent'),'1 / 2');
    await page.click('#timeline-next');
    assert.equal(await page.evaluate('document.querySelector("#timeline-page").textContent'),'2 / 2');
    assert.match(await page.evaluate('document.querySelector("#timeline-event-list").textContent'),/时间未知/);
    await page.click('#timeline-previous'); await page.click('#timeline-order');
    assert.equal(await page.evaluate('document.querySelector("#timeline-order").getAttribute("aria-pressed")'),'true');
    assert.equal(await page.evaluate('document.querySelector("#timeline-summary").textContent'),overview);
  });
  await check('event detail is read-only and raw untrusted evidence is never inserted as markup',async()=>{
    await selectEvent('evidence','evidence:unsafe-label');
    await page.click('#timeline-detail summary');
    assert.equal(await page.evaluate('Boolean(document.querySelector("#product-timeline img"))'),false);
    assert.equal(await page.evaluate('Boolean(window.__timelineUnsafe)'),false);
    assert.match(await page.evaluate('document.querySelector("#timeline-detail pre").textContent'),/<img/);
    assert.match(await page.evaluate('document.querySelector("#timeline-detail").textContent'),/时间未记录/);
  });
  await check('selecting and refreshing timeline keeps exact editor DOM, draft, view and filters',async()=>{
    // A defer note is editable even when a proposal is already open. No submit.
    await page.click(`#intent-list [data-action="defer"][data-claim-id=${q(preparedClaim)}]`);
    await page.waitFor('document.querySelector("#review-panel-body textarea")');
    await page.type('#review-panel-body textarea','Synthetic unsaved timeline draft');
    await page.evaluate('window.__timelineEditor=document.querySelector("#review-panel-body textarea")');
    const before=await page.evaluate(graphApi+'.getViewState()');
    await selectEvent('intentClaims',ACCEPTANCE_TARGET);
    await page.click('#timeline-refresh');
    await page.waitFor('!document.querySelector("#timeline-refresh").disabled');
    assert.equal(await page.evaluate('document.querySelector("#review-panel-body textarea")===window.__timelineEditor'),true);
    assert.equal(await page.evaluate('window.__timelineEditor.value'),'Synthetic unsaved timeline draft');
    assert.equal(await page.evaluate('document.querySelector("#timeline-search").value'),ACCEPTANCE_TARGET);
    assert.deepEqual(await page.evaluate(graphApi+'.getViewState()'),before);
  });
  await check('a refused timeline refresh stops writes and preserves the exact editor draft',async()=>{
    await page.click(`#intent-list [data-action="defer"][data-claim-id=${q(preparedClaim)}]`);
    await page.type('#review-panel-body textarea','Synthetic draft before session refusal');
    await page.evaluate(`window.__timelineEditor=document.querySelector('#review-panel-body textarea');window.__timelineFetch=window.fetch;window.fetch=async(...args)=>String(args[0])==='/api/state'?new Response(JSON.stringify({ok:false,error:{code:'no_session',message:'Synthetic session refusal'}}),{status:403,headers:{'Content-Type':'application/json'}}):window.__timelineFetch(...args)`);
    await page.click('#timeline-refresh');
    await page.waitFor('!document.querySelector("#timeline-refresh").disabled');
    assert.equal(await page.evaluate('document.querySelector("#review-panel-body textarea")===window.__timelineEditor'),true);
    assert.equal(await page.evaluate('window.__timelineEditor.value'),'Synthetic draft before session refusal');
    assert.equal(await page.evaluate('document.querySelector("[data-submit]").disabled'),true);
    assert.match(await page.evaluate('document.querySelector("#timeline-filter-status").textContent'),/读取失败/);
    assert.match(await page.evaluate('document.querySelector("#review-alert").textContent'),/已停写/);
    await page.evaluate('window.fetch=window.__timelineFetch');
  });
  await check('record links center the graph and navigate existing history without writes',async()=>{
    await selectEvent('intentClaims',ACCEPTANCE_TARGET);
    await page.click('#timeline-detail [data-timeline-node-link]');
    await settle();
    assert.equal((await page.evaluate(graphApi+'.getViewState()')).selectedId,ACCEPTANCE_NODE);
    await page.click('#timeline-detail .action-row button');
    assert.match(await page.evaluate('document.querySelector("#review-panel-title").textContent'),/已被替代/);
    assert.equal(await page.evaluate('new URLSearchParams(location.search).get("claim")'),ACCEPTANCE_TARGET);
    assert.equal(await page.evaluate('document.activeElement.id'),'review-panel-title');
  });
  for (const fallback of [false,true]) await check((fallback?'window-fill':'native fullscreen')+' keeps timeline, graph and non-modal panel usable',async()=>{
    await page.evaluate('document.querySelector("#product-timeline").open=false');
    if(fallback) await page.evaluate('document.querySelector("#review-workspace").requestFullscreen=undefined');
    const before=await page.evaluate(graphApi+'.getViewState()');
    await nativeClick('#graph-fullscreen');
    await page.waitFor('document.querySelector("#graph-fullscreen").getAttribute("aria-pressed")==="true"&&!document.querySelector("#graph-fullscreen").disabled');
    assert.equal(await page.evaluate('Boolean(document.fullscreenElement)'),!fallback);
    await nativeClick('#graph-timeline'); await settle();
    assert.equal(await page.evaluate('document.querySelector("#graph-timeline").getAttribute("aria-expanded")'),'true');
    assert.equal(await page.evaluate('document.activeElement.id'),'timeline-toggle');
    assert.equal(await page.evaluate('document.querySelector("#review-workspace").contains(document.querySelector("#product-timeline"))'),true);
    assert.equal(await page.evaluate('document.querySelector(".graph-stage").contains(document.querySelector("#product-timeline"))'),true);
    assert.equal(await page.evaluate('document.querySelector("#review-panel").getAttribute("role")'),'region');
    assert.equal(await page.evaluate('(()=>{const r=document.querySelector("#timeline-toggle").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()'),true);
    assert.ok(await page.evaluate('document.querySelector("#graph-viewport").getBoundingClientRect().height')>=160);
    assert.equal(await page.evaluate('(()=>{const r=document.querySelector("#product-timeline").getBoundingClientRect();const v=document.querySelector("#graph-viewport").getBoundingClientRect();return r.bottom<=innerHeight&&v.bottom<=r.top+.5})()'),true);
    await page.screenshot(join(directory,fallback?'timeline-docked-window.png':'timeline-docked-fullscreen.png'));
    await page.key('Escape');
    await page.waitFor('document.querySelector("#graph-fullscreen").getAttribute("aria-pressed")==="false"');
    assert.deepEqual(await page.evaluate(graphApi+'.getViewState()'),before);
    assert.equal(await page.evaluate('document.querySelector("#product-timeline").open'),true);
  });
  await check('keyboard disclosure, event selection and form controls remain keyboard-operable',async()=>{
    await page.evaluate('document.querySelector("#product-timeline").open=false;document.querySelector("#timeline-toggle").focus()');
    await page.key('Enter'); assert.equal(await page.evaluate('document.querySelector("#product-timeline").open'),true);
    await page.click('#timeline-filter-toggle');
    await page.evaluate('document.querySelector("#timeline-category").focus()');
    await page.key('v','KeyV');
    await page.type('#timeline-search','evidence:acceptance-definition');
    await page.evaluate('document.querySelector("#timeline-event-list button").focus()'); await page.key('Enter');
    assert.match(await page.evaluate('document.querySelector("#timeline-detail").textContent'),/observedAt/);
  });
  await check('compact desktop width keeps page width and wide tables scroll internally',async()=>{
    await page.resize(1100,850); await settle();
    assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".timeline-table-wrap")).overflowX'),'auto');
    assert.equal(await page.evaluate('(()=>{const r=document.querySelector("#product-timeline").getBoundingClientRect();const stage=document.querySelector(".graph-stage").getBoundingClientRect();return r.bottom<=stage.bottom+.5&&r.left>=stage.left&&r.right<=stage.right})()'),true);
    await page.screenshot(join(directory,'timeline-compact-desktop.png'));
    await page.resize(1440,1000);
  });
  await check('720px-high desktop fullscreen retains visible canvas, dock and panel',async()=>{
    await page.resize(1280,720);await settle();
    await nativeClick('#graph-fullscreen');
    await page.waitFor('document.fullscreenElement?.id==="review-workspace"&&!document.querySelector("#graph-fullscreen").disabled');
    const bounds=await page.evaluate('(()=>{const stage=document.querySelector(".graph-stage").getBoundingClientRect();const dock=document.querySelector("#product-timeline").getBoundingClientRect();const canvas=document.querySelector("#graph-viewport").getBoundingClientRect();return {inside:dock.bottom<=stage.bottom+.5&&dock.bottom<=innerHeight,canvasHeight:canvas.height,noOverlap:canvas.bottom<=dock.top+.5,dockHeight:dock.height}})()');
    assert.equal(bounds.inside,true);assert.equal(bounds.noOverlap,true);assert.ok(bounds.canvasHeight>=160);assert.ok(bounds.dockHeight>=150);
    await nativeClick('#timeline-progress-tab');
    assert.equal(await page.evaluate('document.querySelector("#timeline-progress").hidden'),false);
    await page.screenshot(join(directory,'timeline-720-fullscreen.png'));
    await page.key('Escape');await page.waitFor('!document.querySelector(".continuity-fullscreen-host")');
    await page.resize(1440,1000);
  });
  assert.deepEqual(await readFile(statePath),stateBytes);
  const errors=browser.events.filter((event)=>event.method==='Runtime.exceptionThrown');
  const writes=browser.events.filter((event)=>event.method==='Network.requestWillBeSent'&&event.params.request.method!=='GET');
  assert.deepEqual(errors,[]); assert.deepEqual(writes,[]);
  // Restart only our synthetic service with empty-history input.
  await service.close();
  const empty=makeAcceptanceState();
  state=empty;
  await writeFile(statePath,bytesOf(empty));
  service=await startReviewService(statePath,{port:0,logger:()=>{},projectRoot:directory});
  await check('current-only input shows a true starting point and excludes unrelated old backups',async()=>{
    assert.match(await page.evaluate('document.querySelector("#timeline-overview").textContent'),/目前只有当前快照/);
    assert.equal(await page.evaluate('document.querySelectorAll("#timeline-overview tbody tr").length'),1);
    assert.match(await page.evaluate('document.querySelector("#timeline-overview").textContent'),/不能由当前评审／维护摘要锚定/);
    assert.equal(await page.evaluate('document.querySelector("#graph-time-range").disabled'),true);
    assert.match(await page.evaluate('document.querySelector("#graph-time-note").textContent'),/暂无可回溯的历史树/);
  });
  await service.close();
  const maintenanceDirectory = await mkdtemp(join(directory,'maintenance-only-'));
  const maintenancePath = join(maintenanceDirectory,'project-state.json'), original = bytesOf(empty);
  await writeFile(maintenancePath,original,{flag:'wx'});
  await applyMapMaintenance(maintenancePath,{
    projectId:empty.project.id,operationId:'browser-maintenance-only',expectedStateVersion:1,expectedDigest:sha256Bytes(original),
    summary:'Synthetic implementation-only v2 branch',authorizationRef:'Synthetic browser test authorization',
    changes:{nodes:[{id:'impl:maintenance-only',kind:'implementation',label:'维护加入的 v2 分支（合成）',status:'observed',evidenceIds:[]}],edges:[{id:'edge:maintenance-only',from:'task:acceptance',kind:'implemented_by',to:'impl:maintenance-only'}],evidence:[],checks:[]},
  },{authorized:true,clock:'2026-11-12T02:00:00.000Z'});
  const maintenanceBytes=await readFile(maintenancePath);
  state=JSON.parse(maintenanceBytes);
  service=await startReviewService(maintenancePath,{port:0,logger:()=>{},projectRoot:maintenanceDirectory});
  await check('maintenance-only v1 to v2 switches real complete backups without manufacturing a review and restores drafts',async()=>{
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'),6);
    assert.match(await page.evaluate('document.querySelector("#graph-time-label").textContent'),/维护记录，非评审/);
    await page.click(`#intent-list [data-action="defer"][data-claim-id=${q(ACCEPTANCE_TARGET)}]`);
    await page.type('#review-panel-body textarea','Synthetic unsaved maintenance draft');
    await page.evaluate('window.__maintenanceEditor=document.querySelector("#review-panel-body textarea")');
    const view=await page.evaluate(graphApi+'.getViewState()');
    await goVersion(0);
    assert.match(await page.evaluate('document.querySelector("#graph-time-label").textContent'),/历史 · 只读 · v1 · 保存时间未知/);
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'),5);
    assert.equal(await page.evaluate('Boolean(document.querySelector(\'.graph-node[data-node-id="impl:maintenance-only"]\'))'),false);
    assert.equal(await page.evaluate('document.querySelector("#review-current").hidden'),true);
    await page.click('#graph-time-now'); await settle();
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'),6);
    assert.equal(await page.evaluate('document.querySelector("#review-panel-body textarea")===window.__maintenanceEditor'),true);
    assert.equal(await page.evaluate('window.__maintenanceEditor.value'),'Synthetic unsaved maintenance draft');
    assert.deepEqual(await page.evaluate(graphApi+'.getViewState()'),view);
    await page.type('#timeline-search','browser-maintenance-only');
    await page.click('#timeline-event-list button');
    assert.match(await page.evaluate('document.querySelector("#timeline-detail").textContent'),/授权维护（非人工评审）产生状态版本 v2/);
    const saved=JSON.parse(await readFile(maintenancePath,'utf8'));
    assert.equal(saved.reviews.length,0);assert.equal(saved.decisions.length,0);assert.equal(saved.mapUpdates.length,1);
    assert.deepEqual(await readFile(maintenancePath),maintenanceBytes);
  });
  await check('returning now from a focused historical node preserves an off-centre view and the exact editor',async()=>{
    await page.click(`#intent-list [data-action="defer"][data-claim-id=${q(ACCEPTANCE_TARGET)}]`);
    await page.type('#review-panel-body textarea','Synthetic draft across focused historical nodes');
    await page.evaluate(`window.__focusEditor=document.querySelector('#review-panel-body textarea');${graphApi}.restoreView({...${graphApi}.getViewState(),scale:.8,tx:-1500,ty:-1200})`);
    const view=await page.evaluate(graphApi+'.getViewState()'), route=await page.evaluate('location.href');
    await goVersion(0);
    await page.click('.graph-node[data-node-id="impl:acceptance"] .graph-node-select');
    assert.equal(await page.evaluate('document.activeElement.closest(".graph-node")?.dataset.nodeId'),'impl:acceptance');
    // Programmatic activation intentionally leaves keyboard focus on the old
    // node. Native keyboard return can do the same; restoring it must not pan.
    await page.click('#graph-time-now'); await settle();
    assert.deepEqual(await page.evaluate(graphApi+'.getViewState()'),view);
    assert.equal(await page.evaluate('document.activeElement.id'),'graph-time-range');
    assert.equal(await page.evaluate('document.querySelector("#review-panel-body textarea")===window.__focusEditor'),true);
    assert.equal(await page.evaluate('window.__focusEditor.value'),'Synthetic draft across focused historical nodes');
    assert.equal(await page.evaluate('location.href'),route);
    assert.deepEqual(await readFile(maintenancePath),maintenanceBytes);
  });
  assert.deepEqual(browser.events.filter((event)=>event.method==='Runtime.exceptionThrown'),[]);
  assert.deepEqual(browser.events.filter((event)=>event.method==='Network.requestWillBeSent'&&event.params.request.method!=='GET'),[]);
} finally {
  if(page)await page.close().catch(()=>{});
  await service.close(); if(browser)await browser.close();
}
const report={checkedAt:new Date().toISOString(),executable,directory,syntheticOnly:true,browserWriteRequests:0,records,passed:records.filter((record)=>record.passed).length,failed:records.filter((record)=>!record.passed).length};
await writeFile(join(directory,'timeline-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({report:join(directory,'timeline-report.json'),passed:report.passed,failed:report.failed},null,2));
if(report.failed)process.exitCode=1;
