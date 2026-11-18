#!/usr/bin/env node
// Synthetic 60/300/1000-node graphs, static and ephemeral live pages.
// Exercises progressive disclosure, path navigation, offscreen painting and
// existing read-only details without touching real project state.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { renderMap } from '../scripts/render-map.mjs';
import { startReviewService } from '../scripts/review-service.mjs';
import { makeAcceptanceState } from './acceptance-fixtures.mjs';
import { launchBrowser } from './browser-harness.mjs';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node tests/browser-graph-density.mjs <chromium-executable> [report-directory]');
const output = resolve(process.argv[3] || join(tmpdir(), 'continuity-density-checks'));
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, 'graph-density-'));
const api = 'document.querySelector("#graph-view").__continuityGraph';
const records = [];
const measurements = [];
const browser = await launchBrowser(executable, tmpdir());
let page;
let service;

function makeState(count) {
  const state = makeAcceptanceState();
  state.project.id = 'project:density-' + count;
  state.project.name = count + ' 张卡片 · 合成图谱';
  state.nodes = [];
  state.edges = [];
  state.intentClaims = [];
  state.evidence = [];
  function add(id, kind, label, parent, relation = 'contains') {
    state.nodes.push({ id, kind, label, description: '完整说明：' + label, status: 'candidate', evidenceIds: [] });
    if (parent) state.edges.push({ id: 'e:' + id, from: parent, to: id, kind: relation });
  }
  add('root', 'product_goal', '持续掌握产品方向');
  for (let i = 0; i < 8; i++) add('task:' + i, 'user_task', '任务 ' + i + ' · 浏览相关功能', 'root');
  for (let i = 0; i < 16; i++) add('cap:' + i, 'capability', '功能 ' + i + ' · 核对实现和验证', 'task:' + i % 8);
  for (let i = 25; i < count; i++) add('leaf:' + i, i % 2 ? 'implementation' : 'verification',
    i === count - 1 ? '唯一定位目标 ' + count : '材料 ' + i + ' · 可阅读的节点名称', 'cap:' + i % 16,
    i % 2 ? 'implemented_by' : 'verified_by');
  state.edges.push({ id: 'cross:dependency', from: 'cap:0', to: 'cap:1', kind: 'depends_on' });
  return state;
}
async function settle() {
  await page.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
}
async function view() { return page.evaluate(api + '.getViewState()'); }
async function stats() { return page.evaluate(api + '.getRenderStats()'); }
async function check(count, mode, name, run) {
  try {
    await run();
    records.push({ count, mode, name, passed: true });
    console.log('DENSITY_PASS ' + count + '/' + mode + ': ' + name);
  } catch (error) {
    records.push({ count, mode, name, passed: false, error: error.stack });
    await page.screenshot(join(directory, `${count}-${mode}-failure-${records.length}.png`)).catch(() => {});
    throw error;
  }
}
async function scaleTo(scale) {
  await page.evaluate(`(()=>{const api=${api};const v=api.getViewState();api.restoreView({...v,scale:${scale}})})()`);
  await settle();
}

try {
  for (const count of [60, 300, 1000]) {
    const state = makeState(count);
    const bytes = JSON.stringify(state, null, 2) + '\n';
    const statePath = join(directory, 'state-' + count + '.json');
    const staticPath = join(directory, 'map-' + count + '.html');
    await writeFile(statePath, bytes, { flag: 'wx' });
    await writeFile(staticPath, renderMap(state), { flag: 'wx' });
    service = await startReviewService(statePath, { port: 0, projectRoot: directory, logger: () => {} });
    for (const mode of ['static', 'live']) {
      page = await browser.newPage();
      await page.resize(1440, 1000);
      const started = performance.now();
      await page.navigate(mode === 'static' ? pathToFileURL(staticPath).href : service.url);
      await page.waitFor(api);
      await settle();
      const measurement = { count, mode, readyMs: Math.round(performance.now() - started) };
      measurements.push(measurement);

      await check(count, mode, 'initial outline preserves hidden-node counts and readable targets', async () => {
        const initial = await stats();
        assert.equal(initial.nodes, 9);
        assert.match(await page.evaluate('document.querySelector("#graph-live").textContent'), new RegExp(String(count - 9)));
        assert.equal(await page.evaluate('document.querySelectorAll(".graph-node-folded").length'), 8);
        const title = await page.evaluate('(()=>{const e=document.querySelector(".graph-node-label");return parseFloat(getComputedStyle(e).fontSize)*' + api + '.getViewState().scale})()');
        assert.ok(title >= 10, 'first view should not shrink every card into unreadable text');
        const framing = await page.evaluate(`(()=>{const v=document.querySelector('#graph-viewport').getBoundingClientRect();const tools=document.querySelector('.graph-toolbox').getBoundingClientRect();return [...document.querySelectorAll('.graph-node')].every(e=>{const r=e.getBoundingClientRect();return r.left>=v.left+4&&r.right<=v.right-4&&r.top>=tools.bottom+4&&r.bottom<=v.bottom-100})})()`);
        assert.equal(framing, true, 'every outline card must fit below the toolbar and above navigation controls');
        await page.screenshot(join(directory, `${count}-${mode}-outline.png`));
      });

      await check(count, mode, 'zoom tiers prioritize titles and retain detail dialog access', async () => {
        for (const [scale, tier] of [[.35, 'overview'], [.65, 'compact'], [1, 'full']]) {
          await scaleTo(scale);
          assert.equal((await stats()).detail, tier);
          if (tier === 'compact') {
            const folded = await page.evaluate(`(()=>{const node=document.querySelector('[data-node-id="task:0"]');const label=node.querySelector('.graph-node-label').getBoundingClientRect();const count=node.querySelector('.graph-node-folded').getBoundingClientRect();const progress=node.querySelector('.graph-node-progress');return {progress:progress?getComputedStyle(progress).display:'none',labelBottom:label.bottom,countTop:count.top}})()`);
            assert.equal(folded.progress, 'none', 'folded card hides the progress lines in compact zoom');
            assert.ok(folded.labelBottom <= folded.countTop, 'folded count never overlaps the node title');
          }
        }
        await scaleTo(.35);
        await page.evaluate('document.querySelector(".graph-node-details").focus()');
        assert.equal(await page.evaluate('getComputedStyle(document.activeElement).opacity'), '1');
        const before = await view();
        await page.key('Enter');
        assert.equal(await page.evaluate('document.querySelector("#graph-node-dialog").open'), true);
        assert.match(await page.evaluate('document.querySelector("#graph-node-dialog-content").textContent'), /完整说明/);
        await page.key('Escape');
        assert.equal(await page.evaluate('document.activeElement.matches(".graph-node-details")'), true);
        assert.deepEqual(await view(), before);
      });

      await check(count, mode, 'search reveals only target ancestors and reset restores folded branches', async () => {
        await page.click('#graph-overview');
        await settle();
        const before = await view();
        await page.type('#search', '唯一定位目标 ' + count);
        await settle();
        const current = await stats();
        assert.ok(current.nodes < count / 2, `searching one leaf should not expand the whole graph (visible: ${current.nodes})`);
        const collapsed = new Set((await view()).collapsed);
        const targetPath = new Set(['root', 'task:' + ((count - 1) % 8), 'cap:' + ((count - 1) % 16)]);
        for (let index = 0; index < 8; index++) {
          if (!targetPath.has('task:' + index)) assert.ok(collapsed.has('task:' + index), `unrelated task ${index} remains folded`);
        }
        for (let index = 0; index < 16; index++) {
          if (!targetPath.has('cap:' + index)) assert.ok(collapsed.has('cap:' + index), `unrelated capability ${index} remains folded`);
        }
        const target = await page.evaluate(`(()=>{const e=document.querySelector('[data-node-id="leaf:${count - 1}"]');const r=e.getBoundingClientRect();const v=document.querySelector('#graph-viewport').getBoundingClientRect();return {dim:e.classList.contains('is-dim'),inside:r.left>=v.left&&r.right<=v.right&&r.top>=v.top&&r.bottom<=v.bottom}})()`);
        assert.deepEqual(target, { dim: false, inside: true });
        assert.equal((await view()).selectedId, before.selectedId, 'search should not switch the review editor');
        await page.screenshot(join(directory, `${count}-${mode}-search.png`));
        await page.click('#reset');
        await settle();
        assert.deepEqual((await view()).collapsed, before.collapsed);
      });

      await check(count, mode, 'external navigation reveals only its path and all original relations remain available', async () => {
        await page.evaluate(`${api}.selectNode('leaf:${count - 1}',true)`);
        await settle();
        assert.ok((await stats()).nodes < count / 2);
        await page.click('#graph-expand');
        await settle();
        assert.equal((await stats()).nodes, count);
        assert.equal((await stats()).edges, state.edges.length);
        const full = await stats();
        assert.ok(full.height / full.width < 4, 'expanded graph must not collapse into a narrow vertical strip');
        measurement.expandedWidth = full.width;
        measurement.expandedHeight = full.height;
        await page.screenshot(join(directory, `${count}-${mode}-expanded.png`));
        await page.click('#graph-fit');
        await settle();
        const overview = await stats();
        assert.ok((await view()).scale >= .48, 'Fit must retain readable title scale');
        assert.equal(overview.nodes, 9, 'Fit should return to the declared nine-entry outline, not tiny cards');
        measurement.fitVisibleNodes = overview.nodes;
        await page.screenshot(join(directory, `${count}-${mode}-fit.png`));
      });

      await check(count, mode, 'offscreen relationships are culled and panning reuses minimap node paint', async () => {
        await page.click('#graph-expand');
        await page.evaluate(`${api}.selectNode('leaf:${count - 1}',true)`);
        await page.click('#graph-actual');
        await settle();
        const before = await stats();
        assert.ok(before.culledEdges > 0);
        assert.ok(before.drawnEdges < before.edges);
        const timings = await page.evaluate(`(async()=>{const samples=[];for(let i=0;i<12;i++){const start=performance.now();document.querySelector('[data-pan="right"]').click();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));samples.push(performance.now()-start);}return samples;})()`);
        const after = await stats();
        assert.equal(after.minimapPaints, before.minimapPaints);
        measurement.panMedianMs = Math.round([...timings].sort((a, b) => a - b)[6]);
        measurement.panMaxMs = Math.round(Math.max(...timings));
        measurement.drawnEdges = after.drawnEdges;
        measurement.culledEdges = after.culledEdges;
        assert.ok(measurement.panMaxMs < 1500, 'navigation must not stall for seconds');
      });

      await check(count, mode, 'outline and fullscreen keep selection and narrow-screen controls reachable', async () => {
        const before = await view();
        await page.click('#graph-overview');
        await settle();
        assert.equal((await stats()).nodes, 9);
        assert.equal((await view()).selectedId, before.selectedId);
        await page.evaluate('document.querySelector("[data-graph-fullscreen-host],#graph-view").requestFullscreen=undefined');
        await page.click('#graph-fullscreen');
        await page.waitFor('document.querySelector("#graph-fullscreen").getAttribute("aria-pressed")==="true"&&!document.querySelector("#graph-fullscreen").disabled');
        await page.key('Escape');
        await page.waitFor('document.querySelector("#graph-fullscreen").getAttribute("aria-pressed")==="false"');
        await page.resize(390, 700, true);
        const controls = await page.evaluate('(()=>{const r=document.querySelector("#graph-overview").getBoundingClientRect();return {inside:r.left>=0&&r.right<=innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}})()');
        assert.deepEqual(controls, { inside: true, overflow: false });
      });
      await page.close();
      page = null;
    }
    assert.equal(await readFile(statePath, 'utf8'), bytes, 'browsing must not write project state');
    await service.close();
    service = null;
  }
  const errors = browser.events.filter((event) => event.method === 'Runtime.exceptionThrown');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const writes = browser.events.filter((event) => event.method === 'Network.requestWillBeSent' && event.params.request.method !== 'GET');
  assert.equal(writes.length, 0, 'read-only browsing must not issue write requests');
} finally {
  await page?.close().catch(() => {});
  await service?.close();
  await browser.close();
  const report = { syntheticOnly: true, browser: executable, directory, records, measurements, passed: records.filter((record) => record.passed).length, failed: records.filter((record) => !record.passed).length };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: join(directory, 'report.json'), passed: report.passed, failed: report.failed, measurements }, null, 2));
}
