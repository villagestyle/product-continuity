#!/usr/bin/env node
// Canvas arrangement checks: view-only card positions, groups, focus and
// filters on a live review page. No real project state is touched.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startReviewService } from '../scripts/review-service.mjs';
import { makeAcceptanceState } from './acceptance-fixtures.mjs';
import { launchBrowser } from './browser-harness.mjs';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node tests/browser-canvas-organize.mjs <chromium-executable> [report-directory]');
const output = resolve(process.argv[3] || join(tmpdir(), 'continuity-organize-checks'));
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, 'canvas-organize-'));
const state = makeAcceptanceState();
const statePath = join(directory, 'project-state.json');
const stateBytes = JSON.stringify(state, null, 2) + '\n';
await writeFile(statePath, stateBytes, { flag: 'wx' });
const service = await startReviewService(statePath, { port: 0, projectRoot: directory, logger: () => {} });
const browser = await launchBrowser(executable, tmpdir());
const api = 'document.querySelector("#graph-view").__continuityGraph';
const storageKey = 'product-continuity:canvas:' + state.project.id;
const records = [];
const page = await browser.newPage();

async function settle() {
  await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function point(selector, fx = .5, fy = .5) {
  return page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing ${selector}');const r=e.getBoundingClientRect();return {x:r.left+r.width*${fx},y:r.top+r.height*${fy}};})()`);
}
async function mouse(type, position, options = {}) {
  await page.send('Input.dispatchMouseEvent', { type, ...position, ...options });
}
async function clickAt(position, modifiers = 0) {
  await mouse('mousePressed', position, { button: 'left', buttons: 1, clickCount: 1, modifiers });
  await mouse('mouseReleased', position, { button: 'left', buttons: 0, clickCount: 1, modifiers });
  await settle();
}
async function drag(from, to, modifiers = 0) {
  await mouse('mousePressed', from, { button: 'left', buttons: 1, clickCount: 1, modifiers });
  await mouse('mouseMoved', { x: from.x + 8, y: from.y + 8 }, { button: 'left', buttons: 1, modifiers });
  await settle();
  await mouse('mouseMoved', to, { button: 'left', buttons: 1, modifiers });
  await settle();
  await mouse('mouseReleased', to, { button: 'left', buttons: 0, clickCount: 1, modifiers });
  await settle();
}
async function view() { return page.evaluate(api + '.getViewState()'); }
async function stored() {
  return page.evaluate(`JSON.parse(sessionStorage.getItem(${JSON.stringify(storageKey)}) || 'null')`);
}
async function nodePosition(id) {
  return page.evaluate(`(()=>{const e=document.querySelector('[data-node-id="'+${JSON.stringify(id)}+'"]');if(!e)return null;return {left:parseFloat(e.style.left),top:parseFloat(e.style.top)};})()`);
}
async function check(name, run) {
  try {
    await run();
    records.push({ name, passed: true });
    console.log('ORGANIZE_PASS: ' + name);
  } catch (error) {
    records.push({ name, passed: false, error: error.message });
    await page.screenshot(join(directory, 'organize-failure-' + records.length + '.png')).catch(() => {});
    console.error('ORGANIZE_FAIL: ' + name + ': ' + error.message);
    throw error;
  }
}
function graphData(nodes, edges) {
  return {
    nodes: nodes.map((node) => ({
      id: node.id, label: node.label, kind: node.kind,
      kindLabel: node.kind, statusLabel: node.status,
    })),
    edges: edges.map((edge, index) => ({
      id: edge.id || 'edge-' + index, from: edge.from, to: edge.to, kind: edge.kind,
    })),
  };
}

try {
  await page.resize(1440, 1000);
  await page.navigate(service.url);
  await page.waitFor(api);
  await page.waitFor('!document.querySelector("#graph-view").hidden');
  await settle();

  await check('canvas controls stay inside the first screen and outside the gesture surface', async () => {
    const bounds = await page.evaluate(`(()=>{const pan=document.querySelector('.graph-pan').getBoundingClientRect();const mini=document.querySelector('#graph-minimap').getBoundingClientRect();const stage=document.querySelector('.graph-stage').getBoundingClientRect();const canvas=document.querySelector('#graph-viewport').getBoundingClientRect();return {panBottom:pan.bottom,miniBottom:mini.bottom,innerHeight,panButtons:document.querySelectorAll('.graph-pan button').length,embedded:document.querySelectorAll('#graph-viewport input, #graph-viewport select, #graph-viewport textarea').length,stageTop:stage.top,canvasHeight:canvas.height,canvasBottom:canvas.bottom};})()`);
    assert.equal(bounds.panButtons, 4);
    assert.ok(bounds.panBottom <= bounds.innerHeight, 'pan controls must stay above the fold');
    assert.ok(bounds.miniBottom <= bounds.innerHeight, 'minimap must stay above the fold');
    assert.ok(bounds.canvasBottom <= bounds.innerHeight, 'the canvas itself must stay above the fold');
    assert.ok(bounds.canvasHeight >= bounds.innerHeight - bounds.stageTop - 20, 'the dock strip must not shrink the canvas below the first screen');
    assert.equal(bounds.embedded, 0, 'filters and group fields must not join the canvas gesture surface');
  });

  await check('arrange mode reveals its panel without changing the default pan gesture', async () => {
    assert.equal(await page.evaluate('document.querySelector("#graph-arrange-panel").hidden'), true);
    await page.click('#graph-arrange');
    await settle();
    assert.equal(await page.evaluate('document.querySelector("#graph-arrange").getAttribute("aria-pressed")'), 'true');
    assert.equal(await page.evaluate('document.querySelector("#graph-arrange-panel").hidden'), false);
    assert.equal((await view()).arrangeMode, true);
    const bounds = await page.evaluate(`(()=>{const pan=document.querySelector('.graph-pan').getBoundingClientRect();const mini=document.querySelector('#graph-minimap').getBoundingClientRect();return {panBottom:pan.bottom,miniBottom:mini.bottom,innerHeight};})()`);
    assert.ok(bounds.panBottom <= bounds.innerHeight, 'arrange panel must not push pan controls below the fold');
    assert.ok(bounds.miniBottom <= bounds.innerHeight, 'arrange panel must not push the minimap below the fold');
    const before = await view();
    const from = await point('#graph-viewport', .5, .9);
    await drag(from, { x: from.x - 90, y: from.y - 40 });
    const after = await view();
    assert.ok(after.tx !== before.tx || after.ty !== before.ty, 'blank drag must still pan while arranging');
  });

  await check('dragging a card snaps it and only persists a view-only session layout', async () => {
    const before = await nodePosition('goal:acceptance');
    const start = await point('[data-node-id="goal:acceptance"] .graph-node-select');
    await drag(start, { x: start.x + 104, y: start.y + 72 });
    const after = await nodePosition('goal:acceptance');
    assert.notEqual(after.left, before.left);
    assert.equal(after.left % 16, 0);
    assert.equal(after.top % 16, 0);
    assert.equal((await view()).customPositions, 1);
    const saved = await stored();
    assert.equal(saved.version, 1);
    assert.equal(saved.positions['goal:acceptance'].x, after.left);
    assert.equal(saved.positions['goal:acceptance'].y, after.top);
    assert.equal(await page.evaluate('Object.keys(localStorage).length'), 0, 'layout must not use localStorage');
    assert.equal(await readFile(statePath, 'utf8'), stateBytes, 'canvas arrangement must not write project state');
  });

  await check('saved card positions survive a reload and reset restores the layout', async () => {
    const saved = await stored();
    await page.navigate(service.url);
    await page.waitFor(api);
    await page.waitFor('!document.querySelector("#graph-view").hidden');
    await settle();
    assert.equal((await view()).arrangeMode, false);
    assert.equal(await page.evaluate('document.querySelector("#graph-arrange-panel").hidden'), true);
    const restored = await nodePosition('goal:acceptance');
    assert.equal(restored.left, saved.positions['goal:acceptance'].x);
    assert.equal(restored.top, saved.positions['goal:acceptance'].y);
    assert.equal((await view()).customPositions, 1);
    await page.click('#graph-arrange');
    await page.click('#graph-reset-layout');
    await settle();
    assert.deepEqual((await view()).customPositions, 0);
    const reset = await nodePosition('goal:acceptance');
    assert.equal(reset.left, 40);
    assert.equal(reset.top, 156);
    const savedAfter = await stored();
    assert.deepEqual(savedAfter.positions, {});
  });

  await check('Shift+click builds a named group that moves as one unit', async () => {
    if (!(await view()).arrangeMode) await page.click('#graph-arrange');
    await settle();
    const goal = await point('[data-node-id="goal:acceptance"] .graph-node-select');
    const task = await point('[data-node-id="task:acceptance"] .graph-node-select');
    await clickAt(goal, 8);
    await clickAt(task, 8);
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node.is-multi").length'), 2);
    assert.equal(await page.evaluate('document.querySelector("#graph-group").disabled'), false);
    await page.click('#graph-group');
    assert.equal(await page.evaluate('document.querySelector("#graph-group-form").hidden'), false);
    await page.type('#graph-group-name', '验收分组');
    await page.click('#graph-group-create');
    await settle();
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-group").length'), 1);
    assert.equal(await page.evaluate('document.querySelector(".graph-group-label").textContent'), '验收分组');
    assert.equal(await page.evaluate('document.querySelector(".graph-group-count").textContent'), '2');
    const saved = await stored();
    assert.equal(saved.groups.length, 1);
    assert.deepEqual(new Set(saved.groups[0].nodeIds), new Set(['goal:acceptance', 'task:acceptance']));
    const goalBefore = await nodePosition('goal:acceptance');
    const taskBefore = await nodePosition('task:acceptance');
    const head = await point('.graph-group-head');
    const scale = (await view()).scale;
    await drag(head, { x: head.x + 64, y: head.y + 32 });
    const goalAfter = await nodePosition('goal:acceptance');
    const taskAfter = await nodePosition('task:acceptance');
    assert.ok(Math.abs(goalAfter.left - goalBefore.left - 64 / scale) < 1);
    assert.ok(Math.abs(goalAfter.top - goalBefore.top - 32 / scale) < 1);
    assert.ok(Math.abs(taskAfter.left - taskBefore.left - 64 / scale) < 1);
    assert.ok(Math.abs(taskAfter.top - taskBefore.top - 32 / scale) < 1);
    assert.equal((await stored()).groups[0].nodeIds.length, 2);
  });

  await check('a smaller historical snapshot does not erase the current canvas layout', async () => {
    const storedBefore = await stored();
    const before = await view();
    const subset = graphData(
      state.nodes.slice(0, 2),
      state.edges.filter((edge) => edge.from === 'goal:acceptance' && edge.to === 'task:acceptance'),
    );
    await page.evaluate(api + '.refresh(' + JSON.stringify(subset) + ',{updateUrl:false})');
    await settle();
    assert.equal((await view()).customPositions, before.customPositions);
    assert.equal((await view()).groupCount, 1);
    assert.deepEqual((await stored()).positions, storedBefore.positions);
    await page.evaluate(api + '.refresh(' + JSON.stringify(graphData(state.nodes, state.edges)) + ',{updateUrl:true})');
    await settle();
    assert.equal((await view()).customPositions, before.customPositions);
    assert.equal((await view()).groupCount, 1);
    assert.equal(Math.round((await nodePosition('goal:acceptance')).left), storedBefore.positions['goal:acceptance'].x);
    assert.equal(Math.round((await nodePosition('task:acceptance')).left), storedBefore.positions['task:acceptance'].x);
  });

  await check('dragging a member out of a group leaves the frame without hiding the card', async () => {
    const task = await point('[data-node-id="task:acceptance"] .graph-node-select');
    await drag(task, { x: task.x + 260, y: task.y + 180 });
    const saved = await stored();
    assert.equal(saved.groups[0].nodeIds.includes('task:acceptance'), false);
    assert.deepEqual(saved.groups[0].nodeIds, ['goal:acceptance']);
    assert.equal(await page.evaluate('document.querySelector(".graph-group-count").textContent'), '1');
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'), 5);
  });

  await check('a group collapses, expands and deletes without changing product records', async () => {
    await page.click('.graph-group-toggle');
    await settle();
    assert.equal(await page.evaluate('document.querySelector(".graph-group").classList.contains("is-collapsed")'), true);
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'), 0);
    await page.click('.graph-group-toggle');
    await settle();
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'), 5);
    await page.click('.graph-group-remove');
    await settle();
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-group").length'), 0);
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'), 5);
    assert.equal((await stored()).groups.length, 0);
    assert.equal(await readFile(statePath, 'utf8'), stateBytes);
  });

  await check('focus dims nodes beyond two hops and Escape exits focus', async () => {
    await page.click('[data-node-id="impl:acceptance"] .graph-node-select');
    await page.click('#graph-focus');
    await settle();
    assert.equal(await page.evaluate('document.querySelector("#graph-focus").getAttribute("aria-pressed")'), 'true');
    assert.equal(await page.evaluate('document.querySelector("#graph-focus").textContent'), '退出聚焦');
    assert.equal(await page.evaluate('document.querySelector("[data-node-id=\\"goal:acceptance\\"]").classList.contains("is-dim")'), true);
    for (const id of ['impl:acceptance', 'commitment:acceptance-content', 'task:acceptance', 'verify:acceptance']) {
      assert.equal(await page.evaluate(`document.querySelector('[data-node-id="${id}"]').classList.contains('is-dim')`), false, id + ' must stay in focus');
    }
    assert.match(await page.evaluate('document.querySelector("#graph-live").textContent'), /聚焦 4 个节点/);
    await page.evaluate('document.querySelector("#graph-viewport").focus()');
    await page.key('Escape');
    await settle();
    assert.equal(await page.evaluate('document.querySelector("#graph-focus").getAttribute("aria-pressed")'), 'false');
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node.is-dim").length'), 0);
  });

  await check('filters dim non-matches and reset restores the full canvas', async () => {
    await page.type('#search', '测试定义');
    await settle();
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node.is-dim").length'), 4);
    assert.match(await page.evaluate('document.querySelector("#graph-live").textContent'), /1 项匹配/);
    await page.click('#reset');
    await settle();
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node.is-dim").length'), 0);
    assert.match(await page.evaluate('document.querySelector("#graph-live").textContent'), /5 个可见节点/);
    await page.evaluate('(()=>{const s=document.querySelector("#kind");s.value="verification";s.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await settle();
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node.is-dim").length'), 4);
    assert.match(await page.evaluate('document.querySelector("#graph-live").textContent'), /1 项匹配/);
    await page.click('#reset');
    await settle();
    assert.equal(await page.evaluate('document.querySelectorAll(".graph-node.is-dim").length'), 0);
  });

  await check('all canvas work left the project state byte-identical', async () => {
    assert.equal(await readFile(statePath, 'utf8'), stateBytes);
    assert.equal(await page.evaluate('Object.keys(localStorage).length'), 0);
  });
} finally {
  await page.close();
  await browser.close();
  await service.close();
}

const report = { checkedAt: new Date().toISOString(), directory, passed: records.filter((record) => record.passed).length, failed: records.filter((record) => !record.passed).length, syntheticStateOnly: true, records };
const reportPath = join(directory, 'canvas-organize-report.json');
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: reportPath, passed: report.passed, failed: report.failed }, null, 2));
if (report.failed) process.exitCode = 1;
