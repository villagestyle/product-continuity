#!/usr/bin/env node
// Native-pointer regression checks: synthetic static/live graphs only. No real
// project state, review submission or product confirmation is used by this run.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { renderMap } from '../scripts/render-map.mjs';
import { startReviewService } from '../scripts/review-service.mjs';
import { makeAcceptanceState, ACCEPTANCE_NODE, ACCEPTANCE_TARGET } from './acceptance-fixtures.mjs';
import { launchBrowser } from './browser-harness.mjs';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node tests/browser-graph-drag.mjs <chromium-executable> [report-directory]');
const output = resolve(process.argv[3] || join(tmpdir(), 'continuity-drag-checks'));
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, 'graph-drag-'));
const state = makeAcceptanceState();
const statePath = join(directory, 'project-state.json');
const stateBytes = JSON.stringify(state, null, 2) + '\n';
await writeFile(statePath, stateBytes, { flag: 'wx' });
const staticPath = join(directory, 'static-map.html');
await writeFile(staticPath, renderMap(state), { flag: 'wx' });
const service = await startReviewService(statePath, { port: 0, projectRoot: directory, logger: () => {} });
const browser = await launchBrowser(executable, tmpdir());
const records = [];
const api = 'document.querySelector("#graph-view").__continuityGraph';
const root = '[data-node-id="goal:acceptance"] .graph-node-select';
const task = '[data-node-id="task:acceptance"] .graph-node-select';
const blank = '#graph-viewport';
let page;
let mode;

async function settle() {
  await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function view() { return page.evaluate(api + '.getViewState()'); }
async function point(selector, fx = .5, fy = .5) {
  return page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.left+r.width*${fx},y:r.top+r.height*${fy}};})()`);
}
async function mouse(type, position, options = {}) {
  await page.send('Input.dispatchMouseEvent', { type, ...position, ...options });
}
async function press(position) { await mouse('mousePressed', position, { button: 'left', buttons: 1, clickCount: 1 }); }
async function move(position, buttons = 1) { await mouse('mouseMoved', position, { button: buttons ? 'left' : 'none', buttons }); await settle(); }
async function release(position) { await mouse('mouseReleased', position, { button: 'left', buttons: 0, clickCount: 1 }); await settle(); }
async function click(position) { await press(position); await release(position); }
async function drag(from, to) { await press(from); await move(to); await release(to); }
async function check(name, run) {
  try {
    await page.evaluate(`window.getSelection().removeAllRanges();${api}.selectNode('goal:acceptance',true)`);
    await settle();
    await run();
    records.push({ mode, name, passed: true });
    console.log('DRAG_PASS ' + mode + ': ' + name);
  } catch (error) {
    records.push({ mode, name, passed: false, error: error.message });
    await page.screenshot(join(directory, mode + '-failure-' + records.length + '.png')).catch(() => {});
    console.error('DRAG_FAIL ' + mode + ': ' + name + ': ' + error.message);
  } finally {
    await mouse('mouseReleased', { x: 10, y: 10 }, { button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
    await page.evaluate('window.dispatchEvent(new Event("blur"))');
  }
}
async function noSelectionOrGesture() {
  assert.deepEqual(await page.evaluate(`({text:window.getSelection().toString(),active:document.documentElement.classList.contains('continuity-graph-gesture'),panning:document.querySelector('#graph-viewport').classList.contains('is-panning')})`), { text: '', active: false, panning: false });
}
async function copyOutside() {
  await page.evaluate(`(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('#outside-copy'));window.getSelection().removeAllRanges();window.getSelection().addRange(range);})()`);
  assert.equal(await page.evaluate('window.getSelection().toString()'), 'Copy outside the canvas normally');
  assert.notEqual(await page.evaluate('getComputedStyle(document.querySelector("#outside-copy")).userSelect'), 'none');
  assert.equal(await page.evaluate(`document.querySelector('#outside-copy').dispatchEvent(new Event('selectstart',{bubbles:true,cancelable:true}))`), true);
}

try {
  for (mode of ['static', 'live']) {
    page = await browser.newPage();
    await page.resize(1440, 1000);
    await page.navigate(mode === 'static' ? pathToFileURL(staticPath).href : service.url + '/?claim=' + encodeURIComponent(ACCEPTANCE_TARGET));
    await page.waitFor(api);
    // Copiable text and a real control sit next to the viewport, outside its
    // selection guard. They never submit a review or persist product state.
    await page.evaluate(`(()=>{const outside=document.createElement('aside');outside.id='outside-test';outside.style='position:fixed;right:10px;top:360px;width:250px;z-index:50;background:white;padding:16px';const text=document.createElement('p');text.id='outside-copy';text.textContent='Copy outside the canvas normally';const input=document.createElement('textarea');input.id='outside-input';input.value='Editable outside the canvas';const button=document.createElement('button');button.id='outside-button';button.textContent='Test control';window.__outsideClicks=0;button.onclick=()=>window.__outsideClicks++;outside.append(text,input,button);document.body.append(outside);window.__selectedNodes=[];document.querySelector('#graph-view').addEventListener('continuity:graph-select',event=>window.__selectedNodes.push(event.detail.nodeId));})()`);

    await check('native node-label drag pans without selecting the node or text', async () => {
      const before = await view();
      const from = await point(task + ' .graph-node-label');
      await drag(from, { x: from.x - 80, y: from.y + 45 });
      const after = await view();
      assert.equal(after.selectedId, before.selectedId);
      assert.equal(after.tx, before.tx - 80);
      assert.equal(after.ty, before.ty + 45);
      await noSelectionOrGesture();
    });
    await check('node click and slight hand movement still select without panning', async () => {
      // Wide gutters can leave the task partly outside the viewport after the
      // previous pan. Center it first so this check measures click-versus-drag,
      // not the intentional bring-partly-offscreen-node-into-view jump.
      await page.evaluate(api + '.selectNode("task:acceptance", true)');
      await settle();
      const before = await view();
      const from = await point(task + ' .graph-node-label');
      await press(from); await move({ x: from.x + 2, y: from.y + 1 }); await release({ x: from.x + 2, y: from.y + 1 });
      const after = await view();
      assert.equal(after.selectedId, 'task:acceptance');
      assert.equal(after.tx, before.tx);
      assert.equal(after.ty, before.ty);
      assert.equal(await page.evaluate(mode === 'static'
        ? 'document.activeElement.classList.contains("graph-node-select")'
        : 'document.activeElement.id === "review-panel-title"'), true,
      'Static maps keep node focus; the live review host intentionally focuses its panel title.');
      await noSelectionOrGesture();
    });
    await check('blank drag crosses the viewport boundary without outside activation', async () => {
      const before = await view();
      const from = await point(blank, .35, .8);
      assert.equal(await page.evaluate(`document.elementFromPoint(${from.x},${from.y})?.id`), 'graph-viewport');
      const to = await point('#outside-button');
      await press(from);
      await move({ x: from.x + 20, y: from.y + 8 });
      assert.equal(await page.evaluate('document.documentElement.classList.contains("continuity-graph-gesture")'), true);
      await move(to); await release(to);
      const after = await view();
      assert.equal(after.selectedId, before.selectedId);
      assert.ok(Math.abs(after.tx - before.tx) > 100);
      assert.equal(await page.evaluate('window.__outsideClicks'), 0);
      await noSelectionOrGesture();
      await click(to);
      assert.equal(await page.evaluate('window.__outsideClicks'), 1, 'Next deliberate outside click must not be swallowed.');
    });
    await check('dragging removes old text selection but outside copy works after release', async () => {
      await copyOutside();
      const from = await point(root + ' .graph-node-label');
      await drag(from, { x: from.x - 45, y: from.y + 35 });
      await noSelectionOrGesture();
      await copyOutside();
      const input = await point('#outside-input');
      await click(input);
      await page.key('a', 'KeyA', 2);
      assert.equal(await page.evaluate(`(()=>{const e=document.querySelector('#outside-input');return e.value.slice(e.selectionStart,e.selectionEnd);})()`), 'Editable outside the canvas');
    });
    await check('toolbar and branch buttons remain controls, not drag handles', async () => {
      const before = await view();
      const from = await point('#graph-zoom-in');
      await press(from); await move({ x: from.x + 14, y: from.y }); await release({ x: from.x + 14, y: from.y });
      const zoomed = await view();
      assert.ok(zoomed.scale > before.scale);
      assert.equal(await page.evaluate('document.documentElement.classList.contains("continuity-graph-gesture")'), false);
      await click(await point('[data-node-id="goal:acceptance"] .graph-branch-toggle'));
      assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'), 1);
      await click(await point('#graph-expand'));
      assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'), state.nodes.length);
    });
    await check('blur cancels capture and restores selection; later gestures work', async () => {
      const from = await point(root + ' .graph-node-label');
      await press(from); await move({ x: from.x + 25, y: from.y + 25 });
      await page.evaluate('window.dispatchEvent(new Event("blur"))');
      await release({ x: from.x + 25, y: from.y + 25 });
      await noSelectionOrGesture();
      await copyOutside();
      const next = await point(root + ' .graph-node-label');
      const before = await view();
      await drag(next, { x: next.x - 40, y: next.y });
      assert.equal((await view()).tx, before.tx - 40);
    });
    await check('pointer cancel and lost capture clean up selection guard', async () => {
      await page.evaluate('window.__lastPointerId=null;document.addEventListener("pointerdown",e=>window.__lastPointerId=e.pointerId,{once:true})');
      const from = await point(root + ' .graph-node-label');
      await press(from); await move({ x: from.x + 20, y: from.y });
      await page.evaluate('document.dispatchEvent(new PointerEvent("pointercancel",{pointerId:window.__lastPointerId,bubbles:true}))');
      await release({ x: from.x + 20, y: from.y });
      await noSelectionOrGesture();
      await page.evaluate('document.addEventListener("pointerdown",e=>window.__lastPointerId=e.pointerId,{once:true})');
      const next = await point(root + ' .graph-node-label');
      await press(next); await move({ x: next.x + 20, y: next.y });
      await page.evaluate('document.querySelector("#graph-viewport").releasePointerCapture(window.__lastPointerId)');
      await move({ x: next.x + 25, y: next.y });
      await release({ x: next.x + 25, y: next.y });
      await noSelectionOrGesture();
      await copyOutside();
    });
    await check('right mouse button does not pan or leave a selection lock', async () => {
      const before = await view();
      const from = await point(root + ' .graph-node-label');
      await mouse('mousePressed', from, { button: 'right', buttons: 2, clickCount: 1 });
      await mouse('mouseMoved', { x: from.x - 25, y: from.y + 20 }, { button: 'right', buttons: 2 });
      await mouse('mouseReleased', { x: from.x - 25, y: from.y + 20 }, { button: 'right', buttons: 0, clickCount: 1 });
      await page.key('Escape');
      assert.deepEqual(await view(), before);
      await noSelectionOrGesture();
    });
    await check('keyboard node selection, pan buttons and wheel zoom stay available', async () => {
      await page.evaluate(`document.querySelector(${JSON.stringify(task)}).focus({preventScroll:true})`);
      await page.key('Enter');
      assert.equal((await view()).selectedId, 'task:acceptance');
      const before = await view();
      await page.evaluate('document.querySelector("#graph-viewport").focus({preventScroll:true})');
      await page.key('ArrowRight');
      assert.equal((await view()).tx, before.tx - 80);
      await click(await point('[data-pan="left"]'));
      assert.equal((await view()).tx, before.tx + 20);
      const scale = (await view()).scale;
      await mouse('mouseWheel', await point(blank, .45, .7), { deltaY: -80, deltaX: 0 });
      await settle();
      assert.ok((await view()).scale > scale);
      await noSelectionOrGesture();
    });
    await check('minimap stays clickable and native drag/select defaults are scoped', async () => {
      const before = await view();
      await click(await point('#graph-minimap', .8, .8));
      assert.notEqual((await view()).tx, before.tx);
      assert.equal(await page.evaluate('document.querySelector("#graph-world").dispatchEvent(new Event("dragstart",{bubbles:true,cancelable:true}))'), false);
      assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(task + ' .graph-node-label')}).dispatchEvent(new Event('selectstart',{bubbles:true,cancelable:true}))`), false);
      await noSelectionOrGesture();
      await copyOutside();
    });
    if (mode === 'live') {
      await check('review editor remains editable and selectable without saving state', async () => {
        await page.click(`[data-action="edit_candidate"][data-claim-id="${ACCEPTANCE_TARGET}"]`);
        const selector = '#review-panel-body textarea';
        await page.waitFor(`document.querySelector(${JSON.stringify(selector)})`);
        await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.select();})()`);
        const selected = await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e.value.slice(e.selectionStart,e.selectionEnd);})()`);
        assert.equal(selected, state.intentClaims[0].statement);
        assert.notEqual(await page.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).userSelect`), 'none');
        assert.equal(await readFile(statePath, 'utf8'), stateBytes);
      });
    }
    await page.close();
  }
  assert.equal(await readFile(statePath, 'utf8'), stateBytes);
  const errors = browser.events.filter((event) => event.method === 'Runtime.exceptionThrown');
  assert.deepEqual(errors, []);
  const writes = browser.events.filter((event) => event.method === 'Network.requestWillBeSent' && event.params.request.method !== 'GET');
  assert.deepEqual(writes, [], 'No state write or preview request is needed to test dragging.');
} finally {
  if (page) await page.close().catch(() => {});
  await service.close();
  await browser.close();
}
const report = { checkedAt: new Date().toISOString(), executable, directory,
  passed: records.filter((record) => record.passed).length, failed: records.filter((record) => !record.passed).length,
  syntheticStateOnly: true, stateUnchanged: (await readFile(statePath, 'utf8')) === stateBytes,
  records };
await writeFile(join(directory, 'graph-drag-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: join(directory, 'graph-drag-report.json'), passed: report.passed, failed: report.failed }, null, 2));
if (report.failed) process.exitCode = 1;
