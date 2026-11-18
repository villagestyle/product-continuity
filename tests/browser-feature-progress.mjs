#!/usr/bin/env node
// Synthetic temporary states only. This browser check exercises the Feature
// progress surfaces: cards, planning rows/details, the non-modal panel, the
// historical snapshot boundary and the checkpoint category in the timeline.
// It issues no review/write request.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { applyFeatureCheckpoint } from '../scripts/record-feature-checkpoint.mjs';
import { renderMap } from '../scripts/render-map.mjs';
import { startReviewService } from '../scripts/review-service.mjs';
import { sha256Bytes, validateFullState } from '../scripts/state-store.mjs';
import { launchBrowser } from './browser-harness.mjs';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node tests/browser-feature-progress.mjs <chromium-executable> [report-directory]');
const output = resolve(process.argv[3] || join(tmpdir(), 'feature-progress-browser'));
await mkdir(output, {recursive:true});
const directory = await mkdtemp(join(output, 'feature-progress-'));
const statePath = join(directory, 'project-state.json');
const exampleBytes = await readFile(new URL('../examples/feature-progress-state-0.2.json', import.meta.url));
const examplePlan = JSON.parse(await readFile(new URL('../examples/feature-checkpoint-plan.json', import.meta.url), 'utf8'));
const exampleState = JSON.parse(exampleBytes.toString('utf8'));
const featureNode = 'capability:progress-resume';
const emptyNode = 'capability:search';
const roadmapId = 'roadmap:progress-resume';
const claimId = 'claim:resume:v1';

const currentSummary = '当前续接记录：' + '这是用于验证卡片两行省略与详情完整展示的长中文摘要，'.repeat(3)
  + '<img src=x onerror="window.__featureXssCurrent=1">';
const currentStop = '当前停点：' + '这一步只记录保存时的工作位置，不表示剩余工作已经完成，'.repeat(3)
  + '<svg onload="window.__featureXssStop=1">';
const currentNext = '当前下一步：先复核保存态结构，再决定是否继续；这句话不是执行授权。';

await writeFile(statePath, exampleBytes, {flag:'wx'});
const append = await applyFeatureCheckpoint(statePath, {
  ...examplePlan,
  projectId: exampleState.project.id,
  operationId: 'browser-feature-progress-current-tail',
  expectedStateVersion: exampleState.stateVersion,
  expectedDigest: sha256Bytes(exampleBytes),
  supersedes: exampleState.featureCheckpoints.at(-1).id,
  summary: currentSummary,
  stopPoint: currentStop,
  nextActions: [{...examplePlan.nextActions[0], statement: currentNext}],
}, {authorized:true, clock:'2026-11-13T01:00:00.000Z'});
assert.equal(append.ok, true);
const currentState = JSON.parse(await readFile(statePath, 'utf8'));
assert.equal(currentState.stateVersion, 3);
assert.equal(currentState.featureCheckpoints.length, 2);
// The current tail was recorded against the original label. Renaming the
// capability afterwards makes the saved context stale; the fixture must not
// silently pretend the stored fingerprint still matches.
currentState.nodes.find((node) => node.id === featureNode).label = 'Resume progress (renamed after checkpoint)';
assert.deepEqual(validateFullState(currentState), []);
await writeFile(statePath, Buffer.from(JSON.stringify(currentState, null, 2) + '\n'));
const staticPath = join(output, 'static-feature-progress.html');
await writeFile(staticPath, renderMap(currentState));

const service = await startReviewService(statePath, {port:0, logger:()=>{}, projectRoot:directory});
const before = await readFile(statePath);
const names = await readdir(directory);

// Second synthetic state: a true explicit-completed chain (executed evidence,
// no blocking remaining), kept in its own temporary directory and service so
// the original fixture above stays byte-identical.
const completedDirectory = await mkdtemp(join(output, 'feature-completed-'));
const completedStatePath = join(completedDirectory, 'project-state.json');
const completedBase = structuredClone(exampleState);
completedBase.evidence.push({
  id: 'evidence:delivery-exec', kind: 'test_execution',
  claim: 'Synthetic executed check for the delivery contract; fixture only.',
  validation: 'passed', observedAt: '2026-11-13T00:00:00Z',
});
const completedBaseBytes = Buffer.from(JSON.stringify(completedBase, null, 2) + '\n');
await writeFile(completedStatePath, completedBaseBytes, {flag:'wx'});
const deliverySummaryXss = '交付说明（合成）：<img src=x onerror="window.__deliveryXss=1"> 这是保存的完成说明，不是本次验收。';
const completedAppend = await applyFeatureCheckpoint(completedStatePath, {
  ...examplePlan,
  projectId: exampleState.project.id,
  operationId: 'browser-feature-delivery-completed',
  expectedStateVersion: completedBase.stateVersion,
  expectedDigest: sha256Bytes(completedBaseBytes),
  supersedes: exampleState.featureCheckpoints.at(-1).id,
  summary: '当前完成记录：合成显式 completed 链，含已执行证据，无阻塞剩余事项。',
  stopPoint: '合成停点：已完成链的当前位置。',
  workDone: [{statement:'Synthetic completed work; fixture only.', basisRefs:[{collection:'evidence',id:'evidence:delivery-exec'}]}],
  remaining: [],
  nextActions: [],
  nextActionsStatus: 'none',
  delivery: {
    status: 'completed',
    summary: deliverySummaryXss,
    basisRefs: [{collection:'evidence',id:'evidence:delivery-exec'}],
  },
}, {authorized:true, clock:'2026-11-13T02:00:00.000Z'});
assert.equal(completedAppend.ok, true);
const completedState = JSON.parse(await readFile(completedStatePath, 'utf8'));
assert.equal(completedState.stateVersion, 3);
assert.deepEqual(validateFullState(completedState), []);
const completedBefore = await readFile(completedStatePath);
const staticCompletedPath = join(output, 'static-feature-completed.html');
await writeFile(staticCompletedPath, renderMap(completedState));
// Static map without any roadmap collection: selecting a capability must still
// show the full shared delivery detail (real states may have no planning yet).
// The checkpoints are adjusted as if they had been recorded without planning:
// no roadmap contextIds or basis refs, so validation stays clean and the stale
// reading comes from the renamed label, not from dangling references.
const noRoadmapState = structuredClone(currentState);
delete noRoadmapState.roadmapItems;
for (const record of noRoadmapState.featureCheckpoints) {
  record.basis.contextIds.roadmapItemIds = [];
  record.basis.refs = record.basis.refs.filter((ref) => ref.collection !== 'roadmapItem');
}
assert.deepEqual(validateFullState(noRoadmapState), []);
const staticNoRoadmapPath = join(output, 'static-feature-no-roadmap.html');
await writeFile(staticNoRoadmapPath, renderMap(noRoadmapState));
const completedService = await startReviewService(completedStatePath, {port:0, logger:()=>{}, projectRoot:completedDirectory});
const anchorFor = (id) => 'node-' + Array.from(new TextEncoder().encode(id), (byte) => byte.toString(16).padStart(2, '0')).join('');

const graphApi = 'window.__productContinuityGraph';
const q = JSON.stringify;
let browser, page;
const records = [];
async function settle() {await page.evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');}
async function open() {
  await page.navigate(service.url);
  await page.waitFor(graphApi+' && document.querySelector("#graph-roadmap")');
  await settle();
}
async function version(index) {
  await page.evaluate(`(()=>{const slider=document.querySelector('#graph-time-range');slider.value=${q(String(index))};slider.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await page.waitFor('document.querySelector("#graph-time").getAttribute("aria-busy")==="false"');
  await settle();
}
async function check(name, run) {
  try {
    await open();
    await run();
    records.push({name, passed:true});
    console.log('FEATURE_PROGRESS_PASS '+name);
  } catch (error) {
    records.push({name, passed:false, error:error.message, stack:error.stack});
    await page.screenshot(join(directory, 'failure-'+records.length+'.png')).catch(()=>{});
    console.error('FEATURE_PROGRESS_FAIL '+name+': '+error.stack);
  }
}
const card = `.graph-node[data-node-id=${q(featureNode)}]`;
const emptyCard = `.graph-node[data-node-id=${q(emptyNode)}]`;

try {
  browser = await launchBrowser(executable, tmpdir());
  page = await browser.newPage();
  await page.resize(1440, 1000);

  await check('cards show saved stop and next action with accessible full text and no overflow', async()=>{
    const progress = await page.evaluate(`(()=>{const host=document.querySelector(${q(card)});const lines=[...host.querySelectorAll('.graph-node-progress')];const box=host.querySelector('.graph-node-select');const cardRect=box.getBoundingClientRect();return {text:lines.map((line)=>line.textContent),aria:box.getAttribute('aria-label'),title:box.getAttribute('title'),width:cardRect.width,height:cardRect.height,inside:lines.every((line)=>line.getBoundingClientRect().bottom<=cardRect.bottom+0.5),nowrap:lines.every((line)=>getComputedStyle(line).whiteSpace==='nowrap'),clipped:lines.map((line)=>line.scrollWidth>=line.clientWidth)}})()`);
    assert.equal(progress.text.length, 2);
    assert.match(progress.text[1], /^下一步：当前下一步：先复核保存态结构/);
    assert.equal(progress.text[0], '续接依据有变化，需复核');
    assert.ok(progress.aria.includes('续接依据有变化，需复核'));
    assert.equal(progress.title, null, 'Long progress text must not depend on a hover title.');
    assert.equal(progress.width, 224);
    assert.equal(progress.height, 128);
    assert.equal(progress.inside, true);
    assert.equal(progress.nowrap, true);
    assert.ok(progress.clipped[1], 'long next action must be visually clipped, not allowed to grow the card');
    const empty = await page.evaluate(`(()=>{const host=document.querySelector(${q(emptyCard)});const lines=[...host.querySelectorAll('.graph-node-progress')];const box=host.querySelector('.graph-node-select');return {text:lines.map((line)=>line.textContent),aria:box.getAttribute('aria-label')}})()`);
    assert.deepEqual(empty.text, ['尚无续接记录','下一步未记录']);
    assert.match(empty.aria, /尚无续接记录；这不等于没有剩余工作。/);
    assert.doesNotMatch(empty.aria, /未开发|已完成|已交付/);
    await page.screenshot(join(directory, 'cards-progress.png'));
  });

  await check('delivery chips are scannable on the type row, stay inside the 224x128 card and flag needs-review', async()=>{
    const chip = await page.evaluate(`(()=>{const host=document.querySelector(${q(card)});const box=host.querySelector('.graph-node-select');const cardRect=box.getBoundingClientRect();const el=host.querySelector('[data-testid="graph-node-delivery"]');const rect=el.getBoundingClientRect();return {text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview,title:el.title,parent:el.parentElement.className,inside:rect.left>=cardRect.left-0.5&&rect.right<=cardRect.right+0.5&&rect.top>=cardRect.top-0.5&&rect.bottom<=cardRect.bottom+0.5,width:cardRect.width,height:cardRect.height,lines:host.querySelectorAll('.graph-node-progress').length,aria:box.getAttribute('aria-label')}})()`);
    assert.equal(chip.text, '需复核 · 待验证');
    assert.equal(chip.delivery, 'awaiting_verification');
    assert.equal(chip.needsReview, 'true');
    assert.equal(chip.parent, 'graph-node-type');
    assert.equal(chip.title, '', 'The badge must not duplicate long text into a hover tooltip.');
    assert.equal(chip.inside, true);
    assert.equal(chip.width, 224);
    assert.equal(chip.height, 128);
    assert.equal(chip.lines, 2);
    assert.ok(chip.aria.includes('交付阶段：待验证（按保存的剩余事项）；续接依据有变化，交付状态需复核'));
    const emptyChip = await page.evaluate(`(()=>{const el=document.querySelector(${q(emptyCard)}+' [data-testid="graph-node-delivery"]');return {text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview}})()`);
    assert.deepEqual(emptyChip, {text:'状态待补充', delivery:'unknown', needsReview:'false'});
    assert.doesNotMatch(await page.evaluate(`document.querySelector(${q(emptyCard)}).textContent`), /未开发|已完成|已交付/);
    await page.screenshot(join(directory, 'delivery-chips.png'));
  });

  await check('detail button opens complete progress and relationships in an accessible dialog', async()=>{
    const selectedBefore = await page.evaluate(`document.querySelector('.graph-node-select[aria-pressed="true"]')?.closest('.graph-node')?.dataset.nodeId`);
    const overlap = await page.evaluate(`(()=>{const host=document.querySelector(${q(card)});const trigger=host.querySelector('.graph-node-details').getBoundingClientRect();const label=host.querySelector('.graph-node-label').getBoundingClientRect();return trigger.left<label.right&&trigger.right>label.left&&trigger.top<label.bottom&&trigger.bottom>label.top})()`);
    assert.equal(overlap, false, 'The detail button must not cover the node label.');
    const result = await page.evaluate(`(()=>{const host=document.querySelector(${q(card)});const trigger=host.querySelector('[data-testid="graph-node-details"]');const triggerRect=trigger.getBoundingClientRect();trigger.click();const dialog=document.querySelector('#graph-node-dialog');return {open:dialog.open,selected:document.querySelector('.graph-node-select[aria-pressed="true"]')?.closest('.graph-node')?.dataset.nodeId,focus:document.activeElement.id,title:document.querySelector('#graph-node-dialog-title').textContent,body:document.querySelector('#graph-node-dialog-content').innerText,dialogRect:dialog.getBoundingClientRect().toJSON(),triggerRect:triggerRect.toJSON()}})()`);
    assert.equal(result.open, true);
    assert.equal(result.selected, selectedBefore, 'Reading details must keep the graph selection and current editor.');
    assert.equal(result.focus, 'graph-node-dialog-close');
    assert.ok(result.triggerRect.width >= 44 && result.triggerRect.height >= 44);
    assert.equal(result.title, currentState.nodes.find((node)=>node.id===featureNode).label);
    assert.ok(result.body.includes(currentNext));
    assert.ok(result.body.includes('关联关系'));
    assert.equal(await page.evaluate(`document.querySelectorAll('#graph-node-dialog-content script,#graph-node-dialog-content img,#graph-node-dialog-content svg').length`), 0);
    await page.screenshot(join(directory, 'node-detail-dialog-desktop.png'));
    await page.key('Escape');
    await page.waitFor('!document.querySelector("#graph-node-dialog").open');
    assert.equal(await page.evaluate(`document.activeElement.matches(${q(card)}+' [data-testid="graph-node-details"]')`), true);
    await page.resize(390, 700, true);
    await page.click(`${card} [data-testid="graph-node-details"]`);
    const mobile = await page.evaluate(`(()=>{const dialog=document.querySelector('#graph-node-dialog');const body=document.querySelector('#graph-node-dialog-content');return {width:dialog.getBoundingClientRect().width,viewport:innerWidth,scrollable:body.scrollHeight>body.clientHeight,overflow:getComputedStyle(body).overflowY}})()`);
    assert.ok(mobile.width <= mobile.viewport);
    assert.equal(mobile.overflow, 'auto');
    assert.ok(mobile.scrollable, 'Long dialog content must scroll inside the dialog on a small viewport.');
    await page.screenshot(join(directory, 'node-detail-dialog-mobile.png'));
    await page.evaluate('document.querySelector("#graph-node-dialog-content").focus()');
    await page.key('End');
    await page.waitFor('document.querySelector("#graph-node-dialog-content").scrollTop>0');
    await page.click('#graph-node-dialog-close');
    await page.waitFor('!document.querySelector("#graph-node-dialog").open');
    await page.resize(1440, 1000);
  });

  await check('planning index and detail place the saved stop and next action without write controls', async()=>{
    await page.click('#graph-roadmap');
    await page.waitFor('document.querySelector("#roadmap-list") && !document.querySelector("#roadmap-panel").hidden');
    const row = await page.evaluate(`(()=>{const item=document.querySelector('#roadmap-list [data-roadmap-item=${q(roadmapId)}]');return {text:item.textContent,progress:item.querySelector('[data-testid="roadmap-item-progress"]')?.textContent||''}})()`);
    assert.match(row.progress, /停点：当前停点：/);
    assert.match(row.progress, /下一步：当前下一步：/);
    assert.doesNotMatch(row.text, /已交付|全部完成|测试通过|\d+%/);
    await page.click(`#roadmap-list [data-roadmap-item=${q(roadmapId)}]`);
    const detail = await page.evaluate('document.querySelector("#roadmap-panel-body").textContent');
    const progressDetail = await page.evaluate('document.querySelector("#roadmap-panel-body [data-testid=roadmap-progress]").textContent');
    for (const term of ['停点与下一步','当前停点：','当前下一步：','所需授权：运行测试或命令','历次续接（2 条，旧→新）','链尾（保存顺序最后一条，不代表更可信）','续接依据有变化，需复核','不是执行指令']) assert.ok(detail.includes(term), term);
    assert.doesNotMatch(progressDetail, /已交付|全部完成|测试通过|\d+%/);
    assert.equal(await page.evaluate('document.querySelectorAll("#roadmap-panel-body form,#roadmap-panel-body textarea,#roadmap-panel-body [data-action],#roadmap-panel-body img").length'), 0);
    assert.equal(await page.evaluate('document.querySelectorAll("#roadmap-panel-body [data-testid=feature-progress-detail]").length'), 1);
    await page.screenshot(join(directory, 'planning-progress-detail.png'));
  });

  await check('planning row and detail carry the delivery badge with saved basis, review flag and no completion wording', async()=>{
    await page.click('#graph-roadmap');
    await page.waitFor('document.querySelector("#roadmap-list") && !document.querySelector("#roadmap-panel").hidden');
    const rowBadge = await page.evaluate(`(()=>{const el=document.querySelector('#roadmap-list [data-roadmap-item=${q(roadmapId)}] [data-testid="roadmap-item-delivery"]');return {text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview,title:el.title}})()`);
    assert.equal(rowBadge.text, '需复核 · 待验证');
    assert.equal(rowBadge.delivery, 'awaiting_verification');
    assert.equal(rowBadge.needsReview, 'true');
    assert.match(rowBadge.title, /按保存的剩余事项/);
    await page.click(`#roadmap-list [data-roadmap-item=${q(roadmapId)}]`);
    const delivery = await page.evaluate(`(()=>{const el=document.querySelector('#roadmap-panel-body [data-testid="feature-delivery-status"]');return {text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview,badge:el.querySelector('[data-testid="feature-delivery-badge"]').textContent}})()`);
    assert.equal(delivery.delivery, 'awaiting_verification');
    assert.equal(delivery.needsReview, 'true');
    assert.equal(delivery.badge, '需复核 · 待验证');
    for (const term of ['交付状态','按保存的剩余事项推导：最早未完成阶段为「待验证」','续接依据有变化，交付状态需复核','依据：按保存的剩余事项','保存于 2026-','交付状态是保存记录的读数：不是人工验收，不是意图确认，也不是发布授权。']) assert.ok(delivery.text.includes(term), term);
    assert.doesNotMatch(delivery.text, /已交付|全部完成|测试通过|\d+%/);
    assert.equal(await page.evaluate('document.querySelectorAll("#roadmap-panel-body [data-testid=feature-delivery-status] form,#roadmap-panel-body [data-testid=feature-delivery-status] textarea,#roadmap-panel-body [data-testid=feature-delivery-status] [data-action]").length'), 0);
    await page.screenshot(join(directory, 'delivery-detail.png'));
  });

  await check('empty feature state is verbatim, distinct from stale context and never a completion claim', async()=>{
    await page.click(`.graph-node[data-node-id=${q(emptyNode)}] .graph-node-select`);
    await page.waitFor('document.querySelector("#review-panel-body [data-testid=feature-progress-detail]")');
    const text = await page.evaluate('document.querySelector("#review-panel-body [data-testid=feature-progress-detail]").textContent');
    assert.match(text, /尚无续接记录/);
    assert.match(text, /这不表示没有剩余工作；只是尚未保存过停点与下一步。/);
    assert.match(text, /规划未记录/);
    assert.doesNotMatch(text, /未开发|已完成|已交付|全部完成|测试通过|\d+%/);
    assert.equal(await page.evaluate('document.querySelector("#review-panel-body [data-testid=feature-progress-empty]").textContent.includes("这不等于功能")'), false);
    const emptyDelivery = await page.evaluate(`(()=>{const el=document.querySelector('#review-panel-body [data-testid="feature-delivery-status"]');return {text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview}})()`);
    assert.equal(emptyDelivery.delivery, 'unknown');
    assert.equal(emptyDelivery.needsReview, 'false');
    assert.ok(emptyDelivery.text.includes('状态待补充'));
    assert.ok(emptyDelivery.text.includes('尚无续接记录，交付阶段待补充'));
  });

  await check('untrusted checkpoint text stays text in cards, planning detail and the right panel', async()=>{
    const cardText = await page.evaluate(`document.querySelector(${q(card)}).textContent`);
    assert.match(cardText, /当前下一步：/);
    await page.click(`.graph-node[data-node-id=${q(featureNode)}] .graph-node-select`);
    await page.waitFor('document.querySelector("#review-panel-body [data-testid=feature-progress-detail]")');
    const text = await page.evaluate('document.querySelector("#review-panel-body [data-testid=feature-progress-detail]").textContent');
    assert.ok(text.includes('<img'));
    assert.ok(text.includes('<svg'));
    assert.equal(await page.evaluate('Boolean(window.__featureXssCurrent)||Boolean(window.__featureXssStop)'), false);
    assert.equal(await page.evaluate('document.querySelectorAll("#review-panel-body img,#review-panel-body svg,#review-panel-body script,#review-panel-body iframe").length'), 0);
  });

  await check('historical snapshot shows only its own checkpoint and returning now restores draft, view and route', async()=>{
    await page.click(`#intent-list [data-action="defer"][data-claim-id=${q(claimId)}]`);
    await page.type('#review-panel-body textarea', 'Unsaved draft across feature history');
    await page.evaluate('window.__featureEditor=document.querySelector("#review-panel-body textarea")');
    await page.click('#graph-zoom-in');
    const view = await page.evaluate(graphApi+'.getViewState()');
    const route = await page.evaluate('location.href');
    const draftKey = await page.evaluate('Object.keys(sessionStorage).find((key)=>key.includes("draft"))||""');
    assert.ok(draftKey, 'draft stays in sessionStorage');
    assert.equal(await page.evaluate('Object.keys(localStorage).length'), 0);
    await version(0);
    assert.equal(await page.evaluate('document.querySelector("#graph-time").dataset.version'), '2');
    assert.match(await page.evaluate('document.querySelector("#graph-time-label").textContent'), /历史 · 只读 · v2/);
    assert.equal(await page.evaluate(`document.querySelectorAll('.graph-node[data-node-id=${q(featureNode)}] .graph-node-progress').length`), 2);
    assert.match(await page.evaluate(`document.querySelector('.graph-node[data-node-id=${q(featureNode)}] .graph-node-progress').textContent`), /Synthetic checkpoint for contract tests\./);
    // The snapshot reads its own saved delivery stage: at v2 the context was
    // still unchanged, so no needs-review prefix may leak in from the present.
    const historicalChip = await page.evaluate(`(()=>{const el=document.querySelector('.graph-node[data-node-id=${q(featureNode)}] [data-testid="graph-node-delivery"]');return el?{text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview}:null})()`);
    assert.deepEqual(historicalChip, {text:'待验证', delivery:'awaiting_verification', needsReview:'false'});
    await page.click(`.graph-node[data-node-id=${q(featureNode)}] .graph-node-select`);
    await page.waitFor('document.querySelector("#history-panel [data-testid=feature-progress-detail]")');
    const historical = await page.evaluate('document.querySelector("#history-panel").textContent');
    assert.match(historical, /Synthetic checkpoint for contract tests\./);
    assert.match(historical, /只显示该快照当时保存的续接记录；不显示现在的记录或下一动作。/);
    assert.doesNotMatch(historical, /当前续接记录|当前停点：|当前下一步：/);
    assert.doesNotMatch(historical, /未开发|已完成|已交付|全部完成|测试通过|\d+%/);
    const historicalDelivery = await page.evaluate(`(()=>{const el=document.querySelector('#history-panel [data-testid="feature-delivery-status"]');return {text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview}})()`);
    assert.equal(historicalDelivery.delivery, 'awaiting_verification');
    assert.equal(historicalDelivery.needsReview, 'false');
    assert.ok(historicalDelivery.text.includes('按保存的剩余事项'));
    assert.doesNotMatch(historicalDelivery.text, /需复核/);
    await page.click(`.graph-node[data-node-id=${q(emptyNode)}] .graph-node-select`);
    assert.match(await page.evaluate('document.querySelector("#history-panel").textContent'), /尚无续接记录/);
    assert.doesNotMatch(await page.evaluate('document.querySelector("#history-panel").textContent'), /未开发|已完成/);
    await page.screenshot(join(directory, 'historical-progress-isolation.png'));
    await page.click('#graph-time-now');
    await settle();
    assert.equal(await page.evaluate('document.querySelector("#graph-time").dataset.mode'), 'current');
    assert.deepEqual(await page.evaluate(graphApi+'.getViewState()'), view);
    assert.equal(await page.evaluate('location.href'), route);
    assert.equal(await page.evaluate('document.querySelector("#review-panel-body textarea")===window.__featureEditor'), true);
    assert.equal(await page.evaluate('window.__featureEditor.value'), 'Unsaved draft across feature history');
  });

  await check('a changed file version stops reusing the bootstrap fingerprints and says so', async()=>{
    await page.evaluate(`window.__featureFetch=window.fetch;window.fetch=async(...args)=>{const response=await window.__featureFetch(...args);if(String(args[0])!=='/api/state')return response;const body=await response.json();body.state.stateVersion=body.currentStateVersion=body.state.stateVersion+1;body.fileDigest=body.currentDigest='sha256:'+'c'.repeat(64);return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}})}`);
    await page.evaluate('window.dispatchEvent(new Event("focus"))');
    await page.waitFor('document.querySelector("#review-version").textContent==="4"');
    await page.click(`.graph-node[data-node-id=${q(featureNode)}] .graph-node-select`);
    await page.waitFor('document.querySelector("#review-panel-body [data-testid=feature-progress-detail]")');
    const text = await page.evaluate('document.querySelector("#review-panel-body [data-testid=feature-progress-detail]").textContent');
    assert.match(text, /保存态结构未变；内容指纹未重算/);
    assert.doesNotMatch(text, /保存态相关上下文未变（不代表源码或运行状态已核验）/);
    await page.evaluate('window.fetch=window.__featureFetch');
  });

  await check('checkpoint timeline entry is labelled as a non-review continuation record', async()=>{
    await page.click('#graph-timeline');
    await page.waitFor('document.querySelector("#product-timeline").open');
    await page.click('#timeline-filter-toggle');
    await page.evaluate(`(()=>{const select=document.querySelector('#timeline-category');select.value='checkpoint';select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await settle();
    assert.ok(await page.evaluate('document.querySelectorAll("#timeline-event-list button").length') > 0);
    assert.match(await page.evaluate('document.querySelector("#timeline-event-list").textContent'), /续接记录（非评审）/);
    await page.click('#timeline-event-list button');
    const detail = await page.evaluate('document.querySelector("#timeline-detail").textContent');
    assert.match(detail, /授权续接记录（非评审）产生状态版本/);
    assert.doesNotMatch(detail, /授权评审|评审动作/);
  });

  await check('compact half-width viewport keeps the page and planned progress inside the viewport', async()=>{
    await page.resize(720, 1000);
    await settle();
    assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
    await page.click('#graph-roadmap');
    await page.waitFor('document.querySelector("#roadmap-list") && !document.querySelector("#roadmap-panel").hidden');
    const bounds = await page.evaluate('(()=>{const panel=document.querySelector("#roadmap-panel");const panelRect=panel.getBoundingClientRect();const row=document.querySelector("#roadmap-list [data-testid=roadmap-item-progress]").getBoundingClientRect();const body=document.querySelector("#roadmap-panel-body");return {left:panelRect.left,right:panelRect.right,top:panelRect.top,rowRight:row.right,width:innerWidth,panelScrolls:body.scrollHeight>body.clientHeight,overflowX:getComputedStyle(panel).overflowX}})()');
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 0.5);
    assert.ok(bounds.top >= 0);
    assert.ok(bounds.rowRight <= bounds.width + 0.5);
    assert.equal(bounds.overflowX, 'visible');
    await page.screenshot(join(directory, 'compact-200-progress.png'));
    await page.resize(1440, 1000);
  });

  await check('keyboard opens the planning detail and Escape returns focus to its row', async()=>{
    await page.evaluate(`document.querySelector('#roadmap-list [data-roadmap-item=${q(roadmapId)}]').focus()`);
    await page.key('Enter');
    assert.equal(await page.evaluate('document.activeElement.id'), 'roadmap-panel-title');
    assert.equal(await page.evaluate('document.querySelectorAll("#roadmap-panel-body [data-testid=feature-progress-detail]").length'), 1);
    await page.key('Escape');
    assert.equal(await page.evaluate('document.querySelector("#roadmap-panel").hidden'), true);
    assert.equal(await page.evaluate('document.activeElement.dataset.roadmapItem'), roadmapId);
  });

  await check('static map uses the same progress meaning with no review controls or requests', async()=>{
    await page.navigate(pathToFileURL(staticPath).href);
    await page.waitFor(graphApi+' && document.querySelector("#graph-roadmap")');
    assert.equal(await page.evaluate(`document.querySelectorAll('.graph-node[data-node-id=${q(featureNode)}] .graph-node-progress').length`), 2);
    const staticChip = await page.evaluate(`(()=>{const el=document.querySelector('.graph-node[data-node-id=${q(featureNode)}] [data-testid="graph-node-delivery"]');return {text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview}})()`);
    assert.deepEqual(staticChip, {text:'需复核 · 待验证', delivery:'awaiting_verification', needsReview:'true'});
    await page.click('#graph-roadmap');
    await page.click(`#graph-inspector-content [data-roadmap-item=${q(roadmapId)}]`);
    const text = await page.evaluate('document.querySelector("#graph-inspector-content").textContent');
    assert.match(text, /停点：当前停点：/);
    assert.match(text, /当前下一步：/);
    assert.match(text, /续接依据有变化，需复核/);
    assert.match(text, /交付状态/);
    assert.match(text, /需复核 · 待验证/);
    const progressDetail = await page.evaluate('document.querySelector("#graph-inspector-content [data-testid=roadmap-progress]").textContent');
    assert.doesNotMatch(progressDetail, /已交付|全部完成|测试通过|\d+%/);
    assert.equal(await page.evaluate('document.querySelectorAll("#graph-inspector-content [data-action],#graph-inspector-content form,#graph-inspector-content textarea,#graph-inspector-content img").length'), 0);
    await page.screenshot(join(directory, 'static-delivery.png'));
  });

  await check('live text directory shows the same delivery badge; filter redraw and missing-target fallback keep it', async()=>{
    const badge = await page.evaluate(`(()=>{const host=document.querySelector('#intent-list .intent-node[data-node-id=${q(featureNode)}]');const el=host.querySelector('[data-testid="node-feature-delivery"]');const progress=host.querySelector('[data-testid="node-feature-progress"]');const spans=[...progress.querySelectorAll(':scope > span:not(.delivery-badge)')];return {text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview,title:el.title,lines:spans.map((span)=>span.textContent),aria:progress.getAttribute('aria-label'),controls:progress.querySelectorAll('button,[data-action],form,textarea').length}})()`);
    assert.equal(badge.text,'交付：待验证 · 需复核');
    assert.equal(badge.delivery,'awaiting_verification');
    assert.equal(badge.needsReview,'true');
    assert.match(badge.title,/按保存的剩余事项/);
    assert.deepEqual(badge.lines,['续接依据有变化，需复核','下一步：当前下一步：先复核保存态结构，再决定是否继续；这句话不是执行授权。']);
    assert.ok(badge.aria.includes('交付阶段：待验证（按保存的剩余事项）；续接依据有变化，交付状态需复核'));
    assert.equal(badge.controls,0);
    const emptyBadge = await page.evaluate(`(()=>{const el=document.querySelector('#intent-list .intent-node[data-node-id=${q(emptyNode)}] [data-testid="node-feature-delivery"]');return {text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview}})()`);
    assert.deepEqual(emptyBadge,{text:'交付：状态待补充',delivery:'unknown',needsReview:'false'});
    // Node-panel filtered redraw keeps the badge for the selected node only.
    await page.click(`#intent-list .intent-node[data-node-id=${q(featureNode)}] [data-testid="open-node"]`);
    await page.waitFor('document.querySelector("#review-panel-body .panel-directory [data-testid=node-feature-delivery]")');
    const filtered = await page.evaluate(`(()=>{const el=document.querySelector('#review-panel-body .panel-directory [data-testid="node-feature-delivery"]');return {text:el.textContent,delivery:el.dataset.delivery,nodes:document.querySelectorAll('#review-panel-body .panel-directory [data-testid="intent-node"]').length}})()`);
    assert.equal(filtered.text,'交付：待验证 · 需复核');
    assert.equal(filtered.delivery,'awaiting_verification');
    assert.equal(filtered.nodes,1);
    // Missing-target fallback returns to the full list with badges intact.
    await page.navigate(service.url + '?claim=claim:does-not-exist');
    await page.waitFor('document.querySelector("#review-panel-body [data-testid=node-feature-delivery]")');
    assert.equal(await page.evaluate(`document.querySelector(${q('#review-panel-body [data-testid="node-feature-delivery"]')}).textContent`),'交付：待验证 · 需复核');
    // History hides the present directory; returning now restores the badges.
    await page.navigate(service.url);
    await page.waitFor(graphApi);
    await settle();
    await version(0);
    assert.equal(await page.evaluate('document.querySelector("#review-current").hidden'),true);
    await page.click('#graph-time-now');
    await settle();
    assert.equal(await page.evaluate(`document.querySelector('#intent-list .intent-node[data-node-id=${q(featureNode)}] [data-testid="node-feature-delivery"]').textContent`),'交付：待验证 · 需复核');
    await page.screenshot(join(directory,'live-directory-delivery.png'));
  });

  await check('explicit completed chain reads 已完成 now; old history stays 待验证/无记录; returning restores; delivery summary XSS stays text', async()=>{
    await page.navigate(completedService.url);
    await page.waitFor(graphApi+' && document.querySelector("#graph-roadmap")');
    await settle();
    const chip = await page.evaluate(`(()=>{const el=document.querySelector('.graph-node[data-node-id=${q(featureNode)}] [data-testid="graph-node-delivery"]');return {text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview}})()`);
    assert.deepEqual(chip,{text:'已完成',delivery:'completed',needsReview:'false'});
    // The live text badge agrees with the graph chip.
    const textBadge = await page.evaluate(`(()=>{const el=document.querySelector('#intent-list .intent-node[data-node-id=${q(featureNode)}] [data-testid="node-feature-delivery"]');return {text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview}})()`);
    assert.deepEqual(textBadge,{text:'交付：已完成',delivery:'completed',needsReview:'false'});
    await page.click(`.graph-node[data-node-id=${q(featureNode)}] .graph-node-select`);
    await page.waitFor('document.querySelector("#review-panel-body [data-testid=feature-progress-detail]")');
    const delivery = await page.evaluate(`(()=>{const el=document.querySelector('#review-panel-body [data-testid="feature-delivery-status"]');return {text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview,badge:el.querySelector('[data-testid="feature-delivery-badge"]').textContent}})()`);
    assert.equal(delivery.delivery,'completed');
    assert.equal(delivery.needsReview,'false');
    assert.equal(delivery.badge,'已完成');
    for (const term of ['交付状态','交付说明（合成）：','按保存的交付说明','保存于 2026-11-13T02:00:00.000Z','evidence:delivery-exec','不是本次运行验收','交付状态是保存记录的读数']) assert.ok(delivery.text.includes(term),term);
    assert.doesNotMatch(delivery.text,/需复核/);
    // Untrusted delivery.summary stays text; nothing executes.
    assert.ok(delivery.text.includes('<img'));
    assert.equal(await page.evaluate('Boolean(window.__deliveryXss)'),false);
    assert.equal(await page.evaluate('document.querySelectorAll("#review-panel-body img,#review-panel-body svg,#review-panel-body script,#review-panel-body iframe").length'),0);
    // Old history: the v2 tail still derives 待验证 from its own remaining items.
    await version(0);
    const historicalChip = await page.evaluate(`(()=>{const el=document.querySelector('.graph-node[data-node-id=${q(featureNode)}] [data-testid="graph-node-delivery"]');return {text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview}})()`);
    assert.deepEqual(historicalChip,{text:'待验证',delivery:'awaiting_verification',needsReview:'false'});
    await page.click(`.graph-node[data-node-id=${q(featureNode)}] .graph-node-select`);
    await page.waitFor('document.querySelector("#history-panel [data-testid=feature-progress-detail]")');
    const historicalDelivery = await page.evaluate(`(()=>{const el=document.querySelector('#history-panel [data-testid="feature-delivery-status"]');return {text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview}})()`);
    assert.equal(historicalDelivery.delivery,'awaiting_verification');
    assert.equal(historicalDelivery.needsReview,'false');
    const historicalText = await page.evaluate('document.querySelector("#history-panel").textContent');
    assert.doesNotMatch(historicalText,/已完成|当前完成记录|交付说明（合成）/);
    await page.click(`.graph-node[data-node-id=${q(emptyNode)}] .graph-node-select`);
    const emptyHistory = await page.evaluate('document.querySelector("#history-panel").textContent');
    assert.match(emptyHistory,/尚无续接记录/);
    assert.doesNotMatch(emptyHistory,/已完成/);
    // Back to now: the completed reading returns without history leakage.
    await page.click('#graph-time-now');
    await settle();
    const restored = await page.evaluate(`(()=>{const el=document.querySelector('.graph-node[data-node-id=${q(featureNode)}] [data-testid="graph-node-delivery"]');return {text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview}})()`);
    assert.deepEqual(restored,{text:'已完成',delivery:'completed',needsReview:'false'});
    await page.screenshot(join(directory,'completed-chain.png'));
  });

  await check('static capability selection shows the full shared detail without any roadmap; repeats do not stack, other kinds leave no residue, initial URL works', async()=>{
    await page.navigate(pathToFileURL(staticNoRoadmapPath).href);
    await page.waitFor(graphApi);
    await settle();
    assert.equal(await page.evaluate('document.querySelectorAll("#graph-inspector-content [data-roadmap-item]").length'),0);
    const inspect = async () => page.evaluate(`(()=>{const host=document.querySelector('#graph-inspector-content');return {details:host.querySelectorAll('[data-testid="feature-progress-detail"]').length,statuses:host.querySelectorAll('[data-testid="feature-delivery-status"]').length,text:host.textContent}})()`);
    await page.click(`.graph-node[data-node-id=${q(featureNode)}] .graph-node-select`);
    let view = await inspect();
    assert.equal(view.details,1);
    assert.equal(view.statuses,1);
    for (const term of ['交付状态','需复核 · 待验证','按保存的剩余事项','续接依据有变化，交付状态需复核','保存于 2026-','交付状态是保存记录的读数']) assert.ok(view.text.includes(term),term);
    // Repeated selection never stacks.
    await page.click(`.graph-node[data-node-id=${q(featureNode)}] .graph-node-select`);
    view = await inspect();
    assert.equal(view.details,1);
    assert.equal(view.statuses,1);
    // Another capability without checkpoints: full detail with the empty reading.
    await page.click(`.graph-node[data-node-id=${q(emptyNode)}] .graph-node-select`);
    view = await inspect();
    assert.equal(view.details,1);
    assert.ok(view.text.includes('尚无续接记录'));
    assert.ok(view.text.includes('状态待补充'));
    // Non-capability selection leaves no progress residue.
    await page.click('.graph-node[data-node-id="goal:resume"] .graph-node-select');
    view = await inspect();
    assert.equal(view.details,0);
    assert.equal(view.statuses,0);
    // Back to the capability: the detail returns.
    await page.click(`.graph-node[data-node-id=${q(featureNode)}] .graph-node-select`);
    view = await inspect();
    assert.equal(view.details,1);
    // Initial URL selection renders the detail without any click.
    await page.navigate(pathToFileURL(staticNoRoadmapPath).href + '#' + anchorFor(featureNode));
    await page.waitFor(graphApi);
    await settle();
    view = await inspect();
    assert.equal(view.details,1);
    assert.equal(view.statuses,1);
    assert.ok(view.text.includes('需复核 · 待验证'));
    await page.screenshot(join(directory,'static-no-roadmap-detail.png'));
  });

  await check('static completed detail and planning path agree with the live completed reading', async()=>{
    await page.navigate(pathToFileURL(staticCompletedPath).href);
    await page.waitFor(graphApi+' && document.querySelector("#graph-roadmap")');
    await settle();
    const chip = await page.evaluate(`(()=>{const el=document.querySelector('.graph-node[data-node-id=${q(featureNode)}] [data-testid="graph-node-delivery"]');return {text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview}})()`);
    assert.deepEqual(chip,{text:'已完成',delivery:'completed',needsReview:'false'});
    await page.click(`.graph-node[data-node-id=${q(featureNode)}] .graph-node-select`);
    const view = await page.evaluate(`(()=>{const host=document.querySelector('#graph-inspector-content');const el=host.querySelector('[data-testid="feature-delivery-status"]');return {details:host.querySelectorAll('[data-testid="feature-progress-detail"]').length,text:el.textContent,delivery:el.dataset.delivery,needsReview:el.dataset.needsReview,html:host.innerHTML}})()`);
    assert.equal(view.details,1);
    assert.equal(view.delivery,'completed');
    assert.equal(view.needsReview,'false');
    assert.ok(view.text.includes('已完成'));
    assert.ok(view.text.includes('交付说明（合成）：'));
    assert.ok(view.text.includes('evidence:delivery-exec'));
    assert.ok(view.text.includes('<img'));
    assert.equal(view.html.includes('<img src=x'),false);
    assert.equal(await page.evaluate('Boolean(window.__deliveryXss)'),false);
    assert.equal(await page.evaluate('document.querySelectorAll("#graph-inspector-content img,#graph-inspector-content svg,#graph-inspector-content script").length'),0);
    // The planning detail path still carries the same completed reading.
    await page.click('#graph-roadmap');
    await page.click(`#graph-inspector-content [data-roadmap-item=${q(roadmapId)}]`);
    const planning = await page.evaluate(`(()=>{const el=document.querySelector('#graph-inspector-content [data-testid="feature-delivery-status"]');return {text:el.textContent,delivery:el.dataset.delivery}})()`);
    assert.equal(planning.delivery,'completed');
    assert.ok(planning.text.includes('已完成'));
    assert.equal(await page.evaluate('document.querySelectorAll("#graph-inspector-content [data-testid=feature-progress-detail]").length'),1);
    await page.screenshot(join(directory,'static-completed-detail.png'));
  });

  const writes = browser.events.filter((event)=>event.method==='Network.requestWillBeSent' && event.params.request.method!=='GET');
  const errors = browser.events.filter((event)=>event.method==='Runtime.exceptionThrown');
  assert.deepEqual(writes, [], JSON.stringify(writes.map((event)=>({method:event.params.request.method,url:event.params.request.url}))));
  assert.deepEqual(errors, []);
  assert.deepEqual(await readFile(statePath), before);
  assert.deepEqual(await readFile(completedStatePath), completedBefore);
  assert.deepEqual((await readdir(directory)).filter((name)=>!name.endsWith('.png')).sort(), names.sort());
  const report = {browser:executable, syntheticOnly:true, directory, checks:records, passed:records.filter((record)=>record.passed).length, failed:records.filter((record)=>!record.passed).length, writeRequests:writes.length, writeRequestDetails:writes.map((event)=>({method:event.params.request.method,url:event.params.request.url})), runtimeErrors:errors, stateDigest:sha256Bytes(before), completedStateDigest:sha256Bytes(completedBefore)};
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({passed:report.passed, failed:report.failed, report:join(output, 'report.json')}));
  assert.equal(report.failed, 0);
} finally {
  await page?.close().catch(()=>{});
  await browser?.close();
  await service.close();
  await completedService.close();
}
