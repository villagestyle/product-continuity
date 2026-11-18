#!/usr/bin/env node
// Real Fullscreen API + window-fill fallback on synthetic static/live graphs.
// No real project state, review writes, product confirmation or browser F11.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { renderMap } from '../scripts/render-map.mjs';
import { startReviewService } from '../scripts/review-service.mjs';
import { makeAcceptanceState, ACCEPTANCE_TARGET } from './acceptance-fixtures.mjs';
import { launchBrowser } from './browser-harness.mjs';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node tests/browser-graph-fullscreen.mjs <chromium-executable> [report-directory]');
const output = resolve(process.argv[3] || join(tmpdir(), 'continuity-fullscreen-checks'));
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, 'graph-fullscreen-'));
const state = makeAcceptanceState();
const statePath = join(directory, 'project-state.json');
const stateBytes = JSON.stringify(state, null, 2) + '\n';
await writeFile(statePath, stateBytes, { flag: 'wx' });
const staticUrls = {};
for (const language of ['zh-CN', 'en']) {
  const path = join(directory, 'map-' + language + '.html');
  await writeFile(path, renderMap(state, language), { flag: 'wx' });
  staticUrls[language] = pathToFileURL(path).href;
}
const service = await startReviewService(statePath, { port: 0, projectRoot: directory, logger: () => {} });
let browser;
let page;
const records = [];
const graphApi = 'document.querySelector("#graph-view").__continuityGraph';
const root = '[data-node-id="goal:acceptance"] .graph-node-select';
const task = '[data-node-id="task:acceptance"] .graph-node-select';
let mode;
const isLive = () => mode === 'live';
const host = () => isLive() ? '#review-workspace' : '#graph-view';
const active = 'document.querySelector("#graph-fullscreen").getAttribute("aria-pressed")==="true"';

async function settle() {
  await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function view() { return page.evaluate(graphApi + '.getViewState()'); }
async function point(selector) {
  return page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
}
async function click(selector) {
  await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);
  const position = await point(selector);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, ...position, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  }
  await settle();
}
async function enter() {
  await click('#graph-fullscreen');
  await page.waitFor(active + ' && !document.querySelector("#graph-fullscreen").disabled && document.querySelector("#graph-fullscreen-status").textContent.length>0');
  await settle();
}
async function exit(method = 'button') {
  if (method === 'escape') await page.key('Escape');
  else if (method === 'browser') await page.evaluate('document.exitFullscreen()');
  else await click('#graph-fullscreen');
  await page.waitFor('!(' + active + ')');
  await settle();
}
async function clean() {
  assert.deepEqual(await page.evaluate(`({fullscreen:Boolean(document.fullscreenElement),host:document.querySelector(${JSON.stringify(host())}).classList.contains('continuity-fullscreen-host'),scrollLock:document.documentElement.classList.contains('continuity-graph-fullscreen'),selectionLock:document.documentElement.classList.contains('continuity-graph-gesture')})`), { fullscreen: false, host: false, scrollLock: false, selectionLock: false });
}
async function bounds() {
  return page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(host())}).getBoundingClientRect();const v=document.querySelector('#graph-viewport').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,innerWidth,innerHeight,canvasHeight:v.height}})()`);
}
async function coversWindow() {
  const box = await bounds();
  assert.equal(box.x, 0); assert.equal(box.y, 0);
  assert.equal(box.width, box.innerWidth); assert.equal(box.height, box.innerHeight);
  assert.ok(box.canvasHeight >= 300, 'Canvas must grow rather than keep its embedded fixed height.');
  for (const selector of ['#graph-fullscreen', '#graph-zoom-in', '#graph-fit']) {
    assert.equal(await page.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return r.top>=0&&r.left>=0&&r.bottom<=innerHeight&&r.right<=innerWidth})()`), true, selector + ' visible in fullscreen');
  }
}
async function check(name, run, options = {}) {
  try {
    await page.navigate(isLive() ? service.url + '/?claim=' + encodeURIComponent(ACCEPTANCE_TARGET) : staticUrls[mode]);
    await page.waitFor(graphApi);
    if (isLive()) await page.waitFor('document.querySelector("#review-close").hidden===false');
    if (options.fallback === 'denied') {
      await page.evaluate(`document.querySelector(${JSON.stringify(host())}).requestFullscreen=()=>Promise.reject(new DOMException('Synthetic denial','NotAllowedError'))`);
    } else if (options.fallback === 'missing') {
      await page.evaluate(`document.querySelector(${JSON.stringify(host())}).requestFullscreen=undefined`);
    } else if (options.fallback === 'pending') {
      await page.evaluate(`document.querySelector(${JSON.stringify(host())}).requestFullscreen=()=>new Promise(()=>{})`);
    }
    await run();
    records.push({ mode, name, passed: true });
    console.log('FULLSCREEN_PASS ' + mode + ': ' + name);
  } catch (error) {
    records.push({ mode, name, passed: false, error: error.message });
    await page.screenshot(join(directory, mode + '-failure-' + records.length + '.png')).catch(() => {});
    console.error('FULLSCREEN_FAIL ' + mode + ': ' + name + ': ' + error.message);
  } finally {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10, button: 'left', buttons: 0, clickCount: 1 }).catch(() => {});
    await page.evaluate('window.dispatchEvent(new Event("blur"));if(document.fullscreenElement)document.exitFullscreen()').catch(() => {});
  }
}

try {
  browser = await launchBrowser(executable, tmpdir());
  for (mode of ['zh-CN', 'en', 'live']) {
    page = await browser.newPage();
    await page.resize(1440, 1000);
    await check('native fullscreen enter/exit preserves automatic-fit zoom and offset', async () => {
      const before = await view();
      const embedded = await bounds();
      assert.equal(await page.evaluate('document.querySelector("#graph-fullscreen").textContent.trim()'), mode === 'en' ? 'Fullscreen' : '全屏');
      await enter();
      assert.equal(await page.evaluate(`document.fullscreenElement?.id`), host().slice(1), 'Must use the real Fullscreen API, not only CSS.');
      assert.equal(await page.evaluate('document.querySelector("#graph-fullscreen").textContent.trim()'), mode === 'en' ? 'Exit fullscreen' : '退出全屏');
      await coversWindow();
      assert.ok((await bounds()).canvasHeight > embedded.canvasHeight);
      assert.deepEqual(await view(), before);
      await page.screenshot(join(directory, mode + '-native-fullscreen.png'));
      await exit();
      assert.deepEqual(await view(), before);
      await clean();
      assert.equal(await page.evaluate('document.activeElement.id'), 'graph-fullscreen');
      if (!isLive()) assert.equal(await page.evaluate('document.querySelector("#search").inert'), false);
    });
    for (const fallback of [undefined, 'missing']) {
      await check('card detail dialog keeps fullscreen, view and editor on Escape (' + (fallback || 'native') + ')', async () => {
        await enter();
        await page.evaluate(graphApi + '.selectNode("goal:acceptance",true)');
        await settle();
        const before = await view();
        if (isLive()) await page.evaluate('window.__detailEditor=document.querySelector("#review-panel-body").firstElementChild');
        await click('[data-node-id="goal:acceptance"] .graph-node-details');
        assert.equal(await page.evaluate('document.querySelector("#graph-node-dialog").matches(":modal")'), true);
        assert.equal(await page.evaluate('document.activeElement.id'), 'graph-node-dialog-close');
        assert.equal(await page.evaluate('document.querySelector("#graph-node-dialog-title").textContent'), state.nodes.find((node) => node.id === 'goal:acceptance').label);
        assert.deepEqual(await view(), before, 'Opening read-only details must not change the graph view.');
        await page.key('Tab');
        assert.equal(await page.evaluate('document.querySelector("#graph-node-dialog").contains(document.activeElement)'), true, 'Focus stays within the modal.');
        await page.key('Escape');
        await page.waitFor('!document.querySelector("#graph-node-dialog").open');
        assert.equal(await page.evaluate(active), true, 'The first Escape closes only the detail dialog.');
        assert.equal(await page.evaluate('document.activeElement.matches(".graph-node-details")'), true);
        if (isLive()) assert.equal(await page.evaluate('document.querySelector("#review-panel-body").firstElementChild===window.__detailEditor'), true);
        assert.deepEqual(await view(), before);
        await exit();
        await clean();
      }, { fallback });
    }
    await check('drag, node click, zoom, minimap and folding work in fullscreen', async () => {
      await enter();
      await page.evaluate(graphApi + '.selectNode("goal:acceptance",true)');
      await settle();
      const before = await view();
      const from = await point(root + ' .graph-node-label');
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', buttons: 1, clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x - 65, y: from.y + 30, button: 'left', buttons: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: from.x - 65, y: from.y + 30, button: 'left', buttons: 0, clickCount: 1 });
      await settle();
      assert.ok(Math.abs((await view()).tx - (before.tx - 65)) < .01, 'Native pointer subpixel rounding must stay below .01 CSS px.');
      assert.equal((await view()).selectedId, before.selectedId);
      assert.equal(await page.evaluate('window.getSelection().toString()'), '');
      await page.evaluate(graphApi + '.selectNode("task:acceptance",true)');
      await settle();
      await click(task);
      assert.equal((await view()).selectedId, 'task:acceptance');
      if (isLive()) {
        assert.equal(await page.evaluate('document.activeElement.id'), 'review-panel-title');
        assert.equal(await page.evaluate(`document.fullscreenElement.contains(document.activeElement)`), true);
      }
      const scale = (await view()).scale;
      await click('#graph-zoom-in'); assert.ok((await view()).scale > scale);
      const beforeMini = await view();
      await click('#graph-minimap'); assert.notEqual((await view()).tx, beforeMini.tx);
      await page.evaluate(graphApi + '.selectNode("goal:acceptance",true)');
      await settle();
      await click('[data-node-id="goal:acceptance"] .graph-branch-toggle');
      assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'), 1);
      await click('#graph-expand');
      assert.equal(await page.evaluate('document.querySelectorAll(".graph-node").length'), state.nodes.length);
      const latest = await view();
      await exit(); assert.deepEqual(await view(), latest);
      await clean();
    });
    await check('browser fullscreen exit event cleans up without refitting', async () => {
      await enter();
      await click('#graph-zoom-in');
      await click('[data-pan="right"]');
      const before = await view();
      await exit('browser');
      assert.deepEqual(await view(), before);
      await clean();
    });
    await check('rejected native exit leaves a retryable control and browser exit still cleans up', async () => {
      await enter();
      await page.evaluate(`window.__nativeExitFullscreen=document.exitFullscreen.bind(document);document.exitFullscreen=()=>Promise.reject(new DOMException('Synthetic exit failure','NotAllowedError'))`);
      await click('#graph-fullscreen');
      await page.waitFor('!document.querySelector("#graph-fullscreen").disabled');
      assert.equal(await page.evaluate(active), true);
      assert.equal(await page.evaluate('document.fullscreenElement?.id'), host().slice(1));
      assert.equal(await page.evaluate(`document.querySelector('#graph-fullscreen-status').textContent.includes(${JSON.stringify(mode === 'en' ? 'Could not leave' : '未能退出')})`), true);
      await page.evaluate('document.exitFullscreen=window.__nativeExitFullscreen');
      await exit('browser'); await clean();
    });
    await check('keyboard Enter/Space toggles fullscreen and Escape returns focus', async () => {
      await page.evaluate('document.querySelector("#graph-fullscreen").focus()');
      await page.key('Enter');
      await page.waitFor(active);
      await settle();
      assert.equal(await page.evaluate('document.fullscreenElement?.id'), host().slice(1));
      await exit('escape');
      assert.equal(await page.evaluate('document.activeElement.id'), 'graph-fullscreen');
      await page.key(' ', 'Space');
      await page.waitFor(active); await settle();
      assert.equal(await page.evaluate('document.fullscreenElement?.id'), host().slice(1));
      await exit(); await clean();
    });
    await check('permission denial falls back to a focus-safe window-fill view', async () => {
      await page.evaluate(`(()=>{const e=document.createElement('button');e.id='outside-inert';e.textContent='Outside';e.inert=true;document.body.append(e)})()`);
      const before = await view();
      await enter();
      assert.equal(await page.evaluate('document.fullscreenElement'), null);
      await coversWindow();
      assert.equal(await page.evaluate(`document.querySelector('#graph-fullscreen-status').textContent.includes(${JSON.stringify(mode === 'en' ? 'fills this window' : '铺满当前窗口')})`), true);
      assert.deepEqual(await view(), before);
      const focus = [];
      for (let i = 0; i < 18; i++) {
        await page.key('Tab');
        focus.push(await page.evaluate(`document.activeElement===document.body||document.querySelector(${JSON.stringify(host())}).contains(document.activeElement)`));
      }
      assert.ok(focus.every(Boolean), 'Tab must not reach page content behind the enlarged canvas.');
      // Tabbing to an offscreen node intentionally recenters it for visibility.
      // Fullscreen itself must not change that latest keyboard-navigation view.
      const afterTab = await view();
      await exit('escape');
      assert.deepEqual(await view(), afterTab);
      assert.equal(await page.evaluate('document.querySelector("#outside-inert").inert'), true, 'Pre-existing inert state must survive.');
      await clean();
    }, { fallback: 'denied' });
    await check('missing Fullscreen API still supports repeated enter/exit and resizing', async () => {
      const before = await view();
      for (let i = 0; i < 2; i++) {
        await enter();
        assert.equal(await page.evaluate('document.fullscreenElement'), null);
        await coversWindow();
        await exit(); await clean();
      }
      assert.deepEqual(await view(), before);
      await enter();
      await page.resize(1280, 800);
      await coversWindow();
      assert.deepEqual(await view(), before);
      await exit();
      await page.resize(1440, 1000);
      assert.deepEqual(await view(), before);
      await clean();
    }, { fallback: 'missing' });
    await check('scroll position and outside controls restore after window-fill exit', async () => {
      await page.evaluate(`(()=>{const element=document.createElement('div');element.style.height='1800px';document.body.append(element);window.scrollTo(0,110)})()`);
      const beforeScroll = await page.evaluate('window.scrollY');
      await enter();
      await exit();
      assert.equal(await page.evaluate('window.scrollY'), beforeScroll);
      await clean();
      assert.equal(await page.evaluate('getComputedStyle(document.documentElement).overflow'), 'visible');
      assert.equal(await page.evaluate('document.querySelector("#graph-fullscreen").inert'), false);
    }, { fallback: 'missing' });
    await check('unsettled embedded fullscreen promise falls back and exit remains usable', async () => {
      const before = await view();
      await enter();
      assert.equal(await page.evaluate('document.fullscreenElement'), null);
      assert.equal(await page.evaluate('document.querySelector("#graph-fullscreen").disabled'), false);
      await coversWindow();
      await exit();
      assert.deepEqual(await view(), before);
      await clean();
    }, { fallback: 'pending' });
    if (isLive()) {
      await check('closing review panel in fullscreen keeps keyboard focus in the canvas', async () => {
        await enter();
        await click('#review-close');
        assert.equal(await page.evaluate('document.activeElement.id'), 'graph-viewport');
        assert.equal(await page.evaluate(active), true);
        await exit(); await clean();
      });
      for (const fallback of [null, 'denied']) {
        await check((fallback ? 'fallback' : 'native') + ' keeps review draft and Escape does not close panel', async () => {
          await page.click(`[data-action="edit_candidate"][data-claim-id="${ACCEPTANCE_TARGET}"]`);
          const editor = '#review-panel-body textarea';
          await page.waitFor(`document.querySelector(${JSON.stringify(editor)})`);
          await page.type(editor, 'Unsaved synthetic draft - fullscreen must not rebuild this editor.');
          await page.evaluate(`window.__draftEditor=document.querySelector(${JSON.stringify(editor)})`);
          const before = await view();
          await enter();
          assert.equal(await page.evaluate('document.querySelector("#review-panel").getAttribute("role")'), 'region');
          assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".directory")).display'), 'none');
          const panel = await page.evaluate(`(()=>{const r=document.querySelector('#review-panel').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,window:innerWidth,height:innerHeight}})()`);
          assert.ok(panel.left > 0 && panel.right <= panel.window && panel.top >= 0 && panel.bottom <= panel.height);
          await page.evaluate(`window.__draftEditor.focus();window.__draftEditor.select()`);
          assert.equal(await page.evaluate('window.__draftEditor.value.slice(window.__draftEditor.selectionStart,window.__draftEditor.selectionEnd)'), 'Unsaved synthetic draft - fullscreen must not rebuild this editor.');
          await exit('escape');
          assert.equal(await page.evaluate(`document.querySelector(${JSON.stringify(editor)})===window.__draftEditor`), true);
          assert.equal(await page.evaluate('window.__draftEditor.value'), 'Unsaved synthetic draft - fullscreen must not rebuild this editor.');
          assert.equal(await page.evaluate('document.querySelector("#review-close").hidden'), false);
          assert.notEqual(await page.evaluate('getComputedStyle(document.querySelector(".directory")).display'), 'none');
          assert.deepEqual(await view(), before);
          assert.equal(await readFile(statePath, 'utf8'), stateBytes);
          await clean();
        }, { fallback });
      }
    } else {
      await check('text-list view switch exits fullscreen and keeps the fallback reachable', async () => {
        await enter();
        await page.click('[data-view="list"]');
        await page.waitFor('!(' + active + ')');
        assert.equal(await page.evaluate('document.querySelector("#graph-view").hidden'), true);
        assert.equal(await page.evaluate('document.querySelector("#list-view").hidden'), false);
        await clean();
      });
    }
    await page.close(); page = null;
  }
  assert.equal(await readFile(statePath, 'utf8'), stateBytes);
  assert.deepEqual(browser.events.filter((event) => event.method === 'Runtime.exceptionThrown'), []);
  assert.deepEqual(browser.events.filter((event) => event.method === 'Network.requestWillBeSent' && event.params.request.method !== 'GET'), []);
} finally {
  if (page) await page.close().catch(() => {});
  await service.close();
  if (browser) await browser.close();
}
const report = { checkedAt: new Date().toISOString(), executable, directory,
  passed: records.filter((record) => record.passed).length, failed: records.filter((record) => !record.passed).length,
  syntheticStateOnly: true, stateUnchanged: (await readFile(statePath, 'utf8')) === stateBytes, records };
await writeFile(join(directory, 'fullscreen-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ report: join(directory, 'fullscreen-report.json'), passed: report.passed, failed: report.failed }, null, 2));
if (report.failed) process.exitCode = 1;
