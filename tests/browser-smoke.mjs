#!/usr/bin/env node
// Optional, dependency-free Chromium smoke checks. The regular Node test suite
// does not need a browser. All temporary browser data is removed on completion.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { renderMap } from '../scripts/render-map.mjs';

const browserPath = process.argv[2];
if (!browserPath) {
  console.error('Usage: node tests/browser-smoke.mjs <chromium-executable> [temporary-directory]');
  process.exit(2);
}
const directory = await mkdtemp(join(resolve(process.argv[3] || tmpdir()), 'product-map-smoke-'));
const browser = spawn(browserPath, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--remote-debugging-port=0',
  '--user-data-dir=' + join(directory, 'browser'), 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let socket;
try {
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chromium did not expose a debugging endpoint')), 20000);
    browser.once('error', (error) => { clearTimeout(timeout); reject(error); });
    browser.once('exit', (code) => { clearTimeout(timeout); reject(new Error('Chromium exited: ' + code)); });
    let stderr = '';
    browser.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolveEndpoint(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener('open', resolveOpen, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  const externalRequests = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url)) externalRequests.push(message.params.request.url);
    if (!message.id) return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timeout);
    if (message.error) call.reject(new Error(JSON.stringify(message.error)));
    else call.resolve(message.result);
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolveCall, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method + (params.expression ? ' ' + params.expression.slice(0, 180) : ''))); }, 15000);
      pending.set(id, { resolve: resolveCall, reject, timeout });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function settle() {
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }
  async function click(selector) {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await settle();
  }
  const state = JSON.parse(await readFile(new URL('../examples/demo-project-state.json', import.meta.url), 'utf8'));
  const featureState = JSON.parse(await readFile(new URL('../examples/feature-progress-state-0.2.json', import.meta.url), 'utf8'));
  async function open(name, snapshot = state, language = 'zh-CN', scriptingEnabled = true) {
    const path = join(directory, name + '.html');
    await writeFile(path, renderMap(snapshot, language), 'utf8');
    await send('Page.navigate', { url: pathToFileURL(path).href }, sessionId);
    await evaluate(`new Promise(resolve => document.readyState === 'complete' ? resolve() : window.addEventListener('load', resolve, {once: true}))`);
    if (scriptingEnabled) await settle();
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await open('desktop');
  assert.equal(await evaluate('document.querySelectorAll(".graph-node").length'), 7);
  assert.equal(await evaluate('document.querySelector("#graph-view").hidden'), false);
  assert.equal(await evaluate('document.querySelector("#list-view").hidden'), true);
  assert.ok(await evaluate('document.querySelector("#graph-world").style.transform.includes("scale(")'));
  assert.ok(await evaluate('parseInt(document.querySelector("#graph-zoom").textContent) < 100'));
  await click('[data-node-id="verify:guest-test"] .graph-node-select');
  assert.equal(await evaluate('document.querySelector("#graph-inspector-content h3").textContent'), 'Guest-access test');
  assert.ok(await evaluate('document.querySelector("#graph-inspector-content").textContent.includes("仅定义，未记录执行")'));
  assert.equal(await evaluate('document.querySelectorAll("[id]").length === new Set([...document.querySelectorAll("[id]")].map(e=>e.id)).size'), true);
  await click('[data-node-id="task:view-public-product"] .graph-branch-toggle');
  assert.equal(await evaluate('document.querySelectorAll(".graph-node").length'), 2);
  await click('#graph-expand');
  assert.equal(await evaluate('document.querySelectorAll(".graph-node").length'), 7);
  const beforeCrossToggle = await evaluate('document.querySelector("#graph-edges").toDataURL()');
  await click('#graph-cross');
  assert.notEqual(await evaluate('document.querySelector("#graph-edges").toDataURL()'), beforeCrossToggle);
  await click('#graph-cross');
  const beforeZoom = await evaluate('document.querySelector("#graph-zoom").textContent');
  await click('#graph-zoom-in');
  assert.notEqual(await evaluate('document.querySelector("#graph-zoom").textContent'), beforeZoom);
  const beforePan = await evaluate('document.querySelector("#graph-world").style.transform');
  await click('[data-pan="right"]');
  assert.notEqual(await evaluate('document.querySelector("#graph-world").style.transform'), beforePan);
  await evaluate('document.querySelector("#search").value="product-detail.test.ts";document.querySelector("#search").dispatchEvent(new Event("input"))');
  assert.equal(await evaluate('document.querySelectorAll(".graph-node:not(.is-dim)").length'), 1);
  await evaluate('document.querySelector("#search").value="no-match-xyz";document.querySelector("#search").dispatchEvent(new Event("input"))');
  assert.equal(await evaluate('document.querySelector("#graph-message").hidden'), false);
  await click('#reset');
  await click('[data-view="list"]');
  assert.equal(await evaluate('document.querySelector("#list-view").hidden'), false);
  await click('[data-view="graph"]');
  await click('#graph-fit');
  const drag = await evaluate('(()=>{const r=document.querySelector("#graph-viewport").getBoundingClientRect();return {x:r.x+450,y:r.y+100}})()');
  const beforeDrag = await evaluate('document.querySelector("#graph-world").style.transform');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drag.x, y: drag.y, button: 'left', clickCount: 1 }, sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.x + 45, y: drag.y + 30, button: 'left', buttons: 1 }, sessionId);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drag.x + 45, y: drag.y + 30, button: 'left', clickCount: 1 }, sessionId);
  await settle();
  assert.notEqual(await evaluate('document.querySelector("#graph-world").style.transform'), beforeDrag);
  const beforeWheel = await evaluate('document.querySelector("#graph-zoom").textContent');
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: drag.x, y: drag.y, deltaY: -80, deltaX: 0 }, sessionId);
  await settle();
  assert.notEqual(await evaluate('document.querySelector("#graph-zoom").textContent'), beforeWheel);
  await evaluate('document.querySelector("#graph-viewport").focus()');
  const beforeKey = await evaluate('document.querySelector("#graph-world").style.transform');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' }, sessionId);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight' }, sessionId);
  await settle();
  assert.notEqual(await evaluate('document.querySelector("#graph-world").style.transform'), beforeKey);
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true }, sessionId);
  await settle();
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  assert.ok(await evaluate('document.querySelector("#graph-viewport").clientWidth > 300'));
  await click('#graph-fit');
  await click('[data-node-id="verify:guest-test"] .graph-node-select');
  assert.equal(await evaluate('document.querySelector("#graph-inspector-content h3").textContent'), 'Guest-access test');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
  await open('feature-progress', featureState);
  const featureCard = await evaluate(`(()=>{const node=document.querySelector('.graph-node[data-node-id="capability:progress-resume"]');const box=node.querySelector('.graph-node-select');const rect=box.getBoundingClientRect();return {lines:[...node.querySelectorAll('.graph-node-progress')].map((line)=>line.textContent),aria:box.getAttribute('aria-label'),width:box.offsetWidth,height:box.offsetHeight,inside:[...node.querySelectorAll('.graph-node-progress')].every((line)=>line.getBoundingClientRect().bottom<=rect.bottom+0.5)}})()`);
  assert.deepEqual(featureCard.lines, ['Synthetic checkpoint for contract tests.','下一步：Synthetic next action; it grants no authorization.']);
  assert.match(featureCard.aria, /Synthetic checkpoint for contract tests/);
  assert.match(featureCard.aria, /Synthetic next action/);
  assert.equal(featureCard.width, 224); assert.equal(featureCard.height, 128); assert.equal(featureCard.inside, true);
  const progressTexts = await evaluate('[...document.querySelectorAll(".graph-node-progress")].map((line)=>line.textContent)');
  assert.equal(progressTexts.some((text)=>text.includes('%')), false);
  await open('empty', { ...state, nodes: [], edges: [], evidence: [], decisions: [], checks: [] });
  assert.equal(await evaluate('document.querySelector("#graph-message").hidden'), false);
  assert.equal(await evaluate('document.querySelectorAll(".graph-node").length'), 0);
  await open('english', state, 'en');
  assert.equal(await evaluate('document.documentElement.lang'), 'en');
  assert.equal(await evaluate('document.querySelector("#graph-fit").textContent'), 'Fit graph');
  await send('Emulation.setScriptExecutionDisabled', { value: true }, sessionId);
  await open('no-script', state, 'zh-CN', false);
  assert.equal(await evaluate('document.querySelector("#list-view").hidden'), false);
  assert.equal(await evaluate('document.querySelectorAll("#list-view .node").length'), 7);
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  console.log('BROWSER_OK: canvas, selection, folding, cross-links, zoom, drag, wheel, pan, keyboard, search, list fallback, 375px, feature-progress cards, empty state, English, no script; 0 runtime errors; 0 HTTP requests.');
  await send('Browser.close');
} finally {
  socket?.close();
  if (browser.exitCode === null) {
    await new Promise((resolveExit) => {
      browser.once('exit', resolveExit);
      browser.kill();
    });
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
