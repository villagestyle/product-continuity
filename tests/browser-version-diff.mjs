#!/usr/bin/env node
// Synthetic saved versions only. Browser actions must issue zero write requests.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startReviewService } from '../scripts/review-service.mjs';
import { sha256Bytes, validateFullState } from '../scripts/state-store.mjs';
import { makeAcceptanceState, ACCEPTANCE_NODE, ACCEPTANCE_TARGET } from './acceptance-fixtures.mjs';
import { launchBrowser } from './browser-harness.mjs';

const executable=process.argv[2];
if(!executable)throw new Error('Usage: node tests/browser-version-diff.mjs <chromium-executable> [report-directory]');
const output=resolve(process.argv[3] || join(tmpdir(),'continuity-version-diff-checks'));
await mkdir(output,{recursive:true});
const directory=await mkdtemp(join(output,'diff-browser-')), statePath=join(directory,'project-state.json');
const encode=state=>Buffer.from(JSON.stringify(state,null,2)+'\n'), q=JSON.stringify;
const added='unknown:diff-added', removed='unknown:diff-removed', untouched='unknown:diff-unrelated';
let state=makeAcceptanceState();
state.nodes.push({id:removed,kind:'unknown',label:'仅旧版卡片',status:'unknown',evidenceIds:[]},
  {id:untouched,kind:'unknown',label:'无变化且无关联',status:'unknown',evidenceIds:[]});
state.edges.push({id:'edge:diff-removed',from:'task:acceptance',to:removed,kind:'contains'});
const versions=[], files=[];
async function advance(mutate) {
  assert.deepEqual(validateFullState(state),[]);
  const before=encode(state), digest=sha256Bytes(before), version=state.stateVersion;
  const path=`${statePath}.bak.${version}.${digest.slice(7,15)}.0000000${version}`;
  await writeFile(path,before);files.push({path,bytes:before});versions.push(structuredClone(state));
  mutate(state);state.stateVersion++;
  (state.mapUpdates ??=[]).push({id:'update:diff-'+version,operationId:'operation:diff-'+version,projectId:state.project.id,
    source:'local_map_maintenance',createdAt:`2026-11-18T0${version}:00:00.000Z`,authorizationRef:'Synthetic fixture only',summary:'Synthetic version comparison fixture',
    observedStateVersion:version,observedDigest:digest,resultingStateVersion:state.stateVersion,payloadDigest:'sha256:'+'a'.repeat(64),
    changedNodeIds:['task:acceptance'],addedEdgeIds:[],addedEvidenceIds:[],addedCheckIds:[]});
}
await advance(s=>{s.nodes[1].description='v2 description';});
await advance(s=>{
  s.nodes=s.nodes.filter(n=>n.id!==removed);s.edges=s.edges.filter(e=>e.id!=='edge:diff-removed');
  s.nodes.push({id:added,kind:'unknown',label:'新版新增卡片',status:'unknown',evidenceIds:[]});
  s.edges.push({id:'edge:diff-added',from:'task:acceptance',to:added,kind:'contains'});
  s.edges.find(e=>e.id==='edge:acceptance-implementation').kind='depends_on';
  s.nodes[1].description='v3 description <img src=x onerror="window.__unsafe=true">';
  s.nodes.find(n=>n.id==='impl:acceptance').status='retired';
  s.intentClaims[0].scope=['Scope changed, still candidate'];
  s.nodes.find(n=>n.id===ACCEPTANCE_NODE).evidenceIds.push('evidence:diff-link');
  for(let i=0;i<25;i++)s.evidence.push({id:i===0?'evidence:diff-link':'evidence:diff-'+i,kind:'inference',claim:'Synthetic evidence '+i,validation:'not_applicable'});
});
assert.deepEqual(validateFullState(state),[]);
const bytes=encode(state);await writeFile(statePath,bytes);files.push({path:statePath,bytes});
const service=await startReviewService(statePath,{port:0,logger:()=>{},projectRoot:directory});
let browser,page;
const records=[], api='window.__productContinuityGraph';
const card=id=>`#graph-world [data-node-id=${q(id)}]`;
const row=key=>`[data-diff-key=${q(key)}]`;
const settle=()=>page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
async function ready(){await page.waitFor('document.querySelector("#version-diff-bar").dataset.status==="ready"');await settle();}
async function open(){await page.navigate(service.url+'/?claim='+encodeURIComponent(ACCEPTANCE_TARGET));await ready();}
async function version(index){await page.type('#graph-time-range',String(index));await page.waitFor('document.querySelector("#graph-time").getAttribute("aria-busy")==="false"');await ready();}
async function check(name,run){
  try{await open();await run();records.push({name,passed:true});console.log('DIFF_PASS '+name);}
  catch(error){records.push({name,passed:false,error:error.message,stack:error.stack});await page.screenshot(join(directory,'failure-'+records.length+'.png')).catch(()=>{});console.error('DIFF_FAIL '+name+': '+error.stack);}
}
async function nativeClick(selector){
  await page.evaluate(`document.querySelector(${q(selector)}).scrollIntoView({block:'nearest'})`);
  const p=await page.evaluate(`(()=>{const r=document.querySelector(${q(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for(const type of ['mousePressed','mouseReleased'])await page.send('Input.dispatchMouseEvent',{type,...p,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});
  await settle();
}
try {
  browser=await launchBrowser(executable,output);page=await browser.newPage();await page.resize(1440,1000);
  await check('chronological summary, true-node counts, graph badges and removed overlay are distinct',async()=>{
    assert.match(await page.evaluate('document.querySelector("#version-diff-summary").textContent'),/v2 → v3：＋1 ~3 −1/);
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'),7);
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-diff-ghost").length'),1);
    assert.equal(await page.evaluate(`document.querySelector(${q(card(removed))}).className`),'graph-diff-ghost');
    assert.match(await page.evaluate(`document.querySelector(${q(card(removed))}).textContent`),/移除.*仅旧版存在/);
    assert.match(await page.evaluate(`document.querySelector(${q(card(added))}).textContent`),/新增/);
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector(${q(card(added))})).contentVisibility`),'visible');
    assert.match(await page.evaluate(`document.querySelector(${q(card('impl:acceptance'))}).textContent`),/状态/);
    assert.match(await page.evaluate('document.querySelector("#graph-live").textContent'),/7.*1个对比叠影/);
  });
  await check('native card click opens field before/after and preserves exact editor and route',async()=>{
    await page.click(`#intent-list [data-action="defer"][data-claim-id=${q(ACCEPTANCE_TARGET)}]`);
    await page.type('#review-panel-body textarea','Exact unsaved diff draft');
    await page.evaluate('window.__editor=document.querySelector("#review-panel-body textarea")');
    const url=await page.evaluate('location.href');
    await page.evaluate(`${api}.locateNodes(['task:acceptance'])`);
    await nativeClick(card('task:acceptance')+' .graph-node-select');
    assert.equal(await page.evaluate('document.querySelector("#version-diff-panel").hidden'),false);
    assert.match(await page.evaluate('document.querySelector(".version-diff-detail").textContent'),/v2 description.*v3 description/s);
    assert.equal(await page.evaluate('document.activeElement.tagName'),'H2');
    assert.equal(await page.evaluate('document.querySelectorAll("#version-diff-panel img").length'),0);
    assert.equal(await page.evaluate('Boolean(window.__unsafe)'),false);
    await page.click('#version-diff-panel .history-panel-head button');
    assert.equal(await page.evaluate('window.__editor===document.querySelector("#review-panel-body textarea")'),true);
    assert.equal(await page.evaluate('window.__editor.value'),'Exact unsaved diff draft');
    assert.equal(await page.evaluate('document.querySelector("#review-current").hidden'),false);
    assert.equal(await page.evaluate('location.href'),url);
  });
  await check('list pagination, category filtering, search, previous/next selection and safe values',async()=>{
    await page.click('#version-diff-summary');
    assert.equal(await page.evaluate('document.querySelectorAll(".version-diff-item").length'),20);
    await page.click('.version-diff-list button:last-child');
    assert.match(await page.evaluate('document.querySelector(".version-diff-list p").textContent'),/2\/2 页/);
    await page.type('#version-diff-filter','evidence');await page.type('#version-diff-search','evidence:diff-24');
    assert.equal(await page.evaluate('document.querySelectorAll(".version-diff-item").length'),1);
    await page.click('#version-diff-next');
    assert.match(await page.evaluate('document.querySelector(".version-diff-detail").textContent'),/Synthetic evidence 24/);
    await page.click('#version-diff-previous');
    assert.equal(await page.evaluate('document.querySelectorAll(".version-diff-item[aria-pressed=true]").length'),1);
    await page.type('#version-diff-search','no-such-record');
    assert.match(await page.evaluate('document.querySelector(".version-diff-list").textContent'),/没有符合/);
  });
  await check('folded branches count changes and locating a removed item reveals its path without a state deletion',async()=>{
    await page.click(card('task:acceptance')+' .graph-branch-toggle');
    assert.match(await page.evaluate(`document.querySelector(${q(card('task:acceptance')+' .graph-node-folded')}).textContent`),/项变化/);
    await page.click('#version-diff-summary');await page.type('#version-diff-filter','removed');
    await page.click(row('nodes:'+removed));await settle();
    assert.equal(await page.evaluate(`${api}.getViewState().collapsed.includes('task:acceptance')`),false);
    assert.equal(await page.evaluate(`document.querySelector(${q(card(removed)+' .graph-node-select')}).getAttribute('aria-pressed')`),'true');
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'),7);
    await page.screenshot(join(directory,'version-diff-desktop.png'));
  });
  await check('relationship changes locate both endpoints and dialog explicitly labels comparison-only relations',async()=>{
    await page.click('#version-diff-summary');await page.type('#version-diff-filter','edges');
    await page.click(row('edges:edge:diff-removed'));await settle();
    assert.match(await page.evaluate('document.querySelector(".version-diff-detail").textContent'),/关系起点.*关系终点/s);
    assert.equal(await page.evaluate(`Boolean(document.querySelector(${q(card(removed))}))`),true);
    await page.click(card('task:acceptance')+' .graph-node-details');
    assert.match(await page.evaluate('document.querySelector("#graph-node-dialog-content").textContent'),/移除.*对比叠影/s);
    await page.key('Escape');
    await page.click(card(ACCEPTANCE_NODE)+' .graph-node-details');
    assert.match(await page.evaluate('document.querySelector("#graph-node-dialog-content").textContent'),/修改.*对端关系/s);
    await page.key('Escape');
    const calls=browser.events.filter(e=>e.method==='Network.requestWillBeSent'&&e.params.request.url.startsWith(service.url));
    assert.ok(calls.some(e=>e.params.request.url.includes('/api/snapshot?')));
  });
  await check('only-changes preserves related context; annotation toggle restores exact snapshot without overlay',async()=>{
    await page.click('#version-diff-only');
    assert.equal(await page.evaluate(`document.querySelector(${q(card(untouched))}).hidden`),true);
    assert.equal(await page.evaluate(`document.querySelector(${q(card('goal:acceptance'))}).hidden`),false);
    await page.click('#version-diff-enabled');
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-diff-ghost,.graph-diff-badge").length'),0);
    assert.equal(await page.evaluate(`document.querySelector(${q(card(untouched))}).hidden`),false);
    await page.click(card('task:acceptance')+' .graph-node-select');
    assert.equal(await page.evaluate('document.querySelector("#version-diff-panel").hidden'),true);
  });
  await check('shared card coordinates remain stable and returning now restores exact current view, editor, URL and focus',async()=>{
    await page.click(`#intent-list [data-action="defer"][data-claim-id=${q(ACCEPTANCE_TARGET)}]`);
    await page.type('#review-panel-body textarea','Across endpoints');await page.evaluate('window.__editor=document.querySelector("#review-panel-body textarea")');
    await page.click('#graph-zoom-in');
    const before=await page.evaluate(api+'.getViewState()'),url=await page.evaluate('location.href');
    const coordinates=await page.evaluate(`[...document.querySelectorAll('.graph-node')].map(n=>[n.dataset.nodeId,n.style.left,n.style.top])`);
    await version(1); // v2 -> v1, not v2 -> v3.
    assert.match(await page.evaluate('document.querySelector("#version-diff-summary").textContent'),/v1 → v2/);
    const old=await page.evaluate(`[...document.querySelectorAll('.graph-node')].map(n=>[n.dataset.nodeId,n.style.left,n.style.top])`);
    for(const entry of coordinates)if(old.some(n=>n[0]===entry[0]))assert.deepEqual(old.find(n=>n[0]===entry[0]),entry);
    await version(0);
    assert.match(await page.evaluate('document.querySelector("#version-diff-summary").textContent'),/v1 → v2/);
    await page.click('#version-diff-next');
    await page.click('#graph-time-now');await ready();
    assert.deepEqual(await page.evaluate(api+'.getViewState()'),before);
    assert.equal(await page.evaluate('window.__editor===document.querySelector("#review-panel-body textarea")'),true);
    assert.equal(await page.evaluate('window.__editor.value'),'Across endpoints');
    assert.equal(await page.evaluate('location.href'),url);
    assert.equal(await page.evaluate('document.activeElement.id'),'graph-time-range');
  });
  await check('late comparison response cannot overwrite the newer endpoint pair',async()=>{
    await page.evaluate(`window.__fetch=fetch;window.fetch=async(...args)=>{const r=await window.__fetch(...args);if(String(args[0]).includes('/api/snapshot?')&&new URL(args[0],location.href).searchParams.get('version')==='1'&&!window.__delayed){window.__delayed=true;await new Promise(resolve=>window.__release=resolve);}return r;}`);
    await page.type('#graph-time-range','1');await page.waitFor('window.__delayed===true');
    await page.click('#graph-time-now');await ready();await page.evaluate('window.__release()');await settle();
    assert.match(await page.evaluate('document.querySelector("#version-diff-summary").textContent'),/v2 → v3/);
    assert.equal(await page.evaluate('document.querySelector("#graph-time").dataset.mode'),'current');
  });
  await check('missing comparator never shows stale changes or a substitute; snapshot remains inspectable',async()=>{
    const backup=files[0].path;await rename(backup,backup+'.failed');
    try{
      await page.type('#graph-time-range','1');await page.waitFor('document.querySelector("#version-diff-bar").dataset.status==="unavailable"&&document.querySelector("#graph-time").getAttribute("aria-busy")==="false"');
      assert.equal(await page.evaluate('document.querySelectorAll(".graph-diff-badge,.graph-diff-ghost").length'),0);
      assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'),7);
      assert.equal(await page.evaluate('document.querySelector("#version-diff-summary").disabled'),true);
    }finally{await rename(backup+'.failed',backup);}
  });
  await check('changing the selected snapshot closes stale comparison before loading and never exposes both panels',async()=>{
    await page.click('#version-diff-next');
    await page.evaluate(`window.__fetch=fetch;window.fetch=async(...args)=>{const r=await window.__fetch(...args);if(String(args[0]).includes('/api/snapshot?')&&!window.__delayed){window.__delayed=true;await new Promise(resolve=>window.__release=resolve);}return r;}`);
    await page.type('#graph-time-range','1');await page.waitFor('window.__delayed===true');
    assert.equal(await page.evaluate('document.querySelector("#version-diff-panel").hidden'),true);
    assert.equal(await page.evaluate('document.querySelector("#history-panel").hidden'),false);
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node,.graph-diff-ghost").length'),0);
    await page.evaluate('window.__release()');await ready();
    await page.click('#version-diff-next');
    assert.equal(await page.evaluate('document.querySelector("#history-panel").hidden'),true);
    assert.equal(await page.evaluate('document.querySelector("#version-diff-panel").hidden'),false);
  });
  await check('a foreign comparator identity fails closed without hiding the selected snapshot',async()=>{
    await page.evaluate(`window.__fetch=fetch;window.fetch=async(...args)=>{const r=await window.__fetch(...args);if(!String(args[0]).includes('/api/snapshot?'))return r;const body=await r.json();if(body.state?.stateVersion===1)body.stateIdentity='foreign';return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}})}`);
    await page.type('#graph-time-range','1');
    await page.waitFor('document.querySelector("#version-diff-bar").dataset.status==="unavailable"&&document.querySelector("#graph-time").getAttribute("aria-busy")==="false"');
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'),7);
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-diff-ghost,.graph-diff-badge").length'),0);
  });
  await check('version gap is explicitly a net diff, not invented intermediate history',async()=>{
    await page.evaluate(`window.__fetch=fetch;window.fetch=async(...args)=>{const r=await window.__fetch(...args);if(String(args[0])!=='/api/state')return r;const body=await r.json();body.timelineHistory.samples=body.timelineHistory.samples.filter(s=>s.stateVersion!==2);return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}})};window.dispatchEvent(new Event('focus'))`);
    await page.waitFor('document.querySelector("#version-diff-summary").textContent.includes("v1 → v3")');
    await page.click('#version-diff-summary');
    assert.match(await page.evaluate('document.querySelector("#version-diff-panel").textContent'),/两端净变化/);
  });
  for(const mode of ['native fullscreen','window fullscreen','narrow layout'])await check(mode+' keeps diff controls and panel usable with keyboard',async()=>{
    const narrow=mode==='narrow layout';
    if(narrow)await page.resize(390,844,true);
    else{await page.resize(1280,720);if(mode==='window fullscreen')await page.evaluate('document.querySelector("#review-workspace").requestFullscreen=undefined');await nativeClick('#graph-fullscreen');await page.waitFor('document.querySelector("#graph-fullscreen").getAttribute("aria-pressed")==="true"');}
    await page.evaluate('document.querySelector("#version-diff-summary").focus()');await page.key('Enter');
    assert.equal(await page.evaluate('document.querySelector("#version-diff-panel").hidden'),false);
    assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),true);
    await page.type('#version-diff-filter','removed');await page.click(row('nodes:'+removed));
    if(narrow){
      await page.screenshot(join(directory,'version-diff-mobile-controls.png'));
      await page.evaluate('document.querySelector("#version-diff-panel").scrollIntoView({block:"start"})');await settle();
      assert.equal(await page.evaluate('(()=>{const r=document.querySelector("#version-diff-panel").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})()'),true);
      assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".version-diff-values")).gridTemplateColumns.split(" ").length'),1);
    }
    await page.screenshot(join(directory,narrow?'version-diff-mobile.png':mode==='window fullscreen'?'version-diff-fullscreen.png':'version-diff-native-fullscreen.png'));
    if(!narrow){await page.key('Escape');await page.waitFor('!document.querySelector(".continuity-fullscreen-host")');}
    await page.resize(1440,1000,false);
  });
  const writes=browser.events.filter(e=>e.method==='Network.requestWillBeSent'&&e.params.request.url.startsWith(service.url)&&!['GET','HEAD'].includes(e.params.request.method));
  assert.deepEqual(writes,[]);
  const errors=browser.events.filter(e=>e.method==='Runtime.exceptionThrown');assert.deepEqual(errors,[]);
  for(const file of files)assert.deepEqual(await readFile(file.path),file.bytes);
  const report={syntheticOnly:true,executable,readOnlyRequests:true,stateAndBackupsUnchanged:true,passed:records.filter(r=>r.passed).length,failed:records.filter(r=>!r.passed).length,records};
  await writeFile(join(directory,'version-diff-report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({report:join(directory,'version-diff-report.json'),passed:report.passed,failed:report.failed},null,2));
  if(report.failed)process.exitCode=1;
} finally {await browser?.close();await service.close();}
