#!/usr/bin/env node
// Acceptance for 工作记录 (references/current-work-contract.md §13 and the
// batch-1 layering rules in references/current-work-clarity-batch1.md).
//
// Two modes, because the browser part cannot run everywhere:
//
//   node tests/browser-current-work.mjs --source-only
//     DOM-free preflight: renders the real review page for a synthetic state and
//     checks the shell, the injected helpers and the wiring invariants in the
//     shipped source. No browser, no port, no process, no state file.
//
//   node tests/browser-current-work.mjs <chromium> [report-directory]
//     The preflight, then one headless-browser scenario. The page is rendered
//     from a SYNTHETIC state, written to a temp file, and every /api request is
//     answered by a page-level fetch shim, so no live service, no user state and
//     no real project file is touched. Nothing here opens the user's browser.
//
// The scenario asserts, in order: card badge → panel entry → detail reading order
// and separate chips → review DOM/URL untouched → editor → preview → save →
// history (read-only) → a new unsaved draft that writes nothing.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { renderReview } from '../scripts/render-review.mjs';
import { deriveCurrentWorkIndex, currentWork } from '../scripts/feature-progress.mjs';

const WORK_ID = 'work:browser-synthetic';
const WORK_TITLE = '浏览器合成的工作记录';
const ENDED_WORK_ID = 'work:browser-synthetic-ended';
const NODE_ID = 'capability:product-details';
const RECORD_ID = 'checkpoint:00000000-0000-4000-8000-000000000901';
const ENDED_RECORD_ID = 'checkpoint:00000000-0000-4000-8000-000000000902';
const DIGEST = (hex) => 'sha256:' + hex.repeat(64);

// ---------------------------------------------------------------------------
// Synthetic fixture: the demo state plus one saved work record. It is a literal
// here, never read from a project file at run time except as the render input.
// ---------------------------------------------------------------------------
async function syntheticState() {
  const demo = JSON.parse(await readFile(new URL('../examples/demo-project-state-0.2.json', import.meta.url), 'utf8'));
  const state = structuredClone(demo);
  state.stateVersion = 12;
  state.featureCheckpoints = [{
    id: RECORD_ID,
    nodeId: NODE_ID,
    createdAt: '2026-11-18T09:00:00.000Z',
    basis: {
      observedStateVersion: 11,
      observedDigest: DIGEST('b'),
      contextFingerprintVersion: 1,
      contextFingerprint: DIGEST('c'),
      contextIds: { nodeIds: [], edgeIds: [], evidenceIds: [], claimIds: [], decisionIds: [], proposalIds: [], reviewIds: [], roadmapItemIds: [] },
    },
    workContext: {
      version: 1,
      workId: WORK_ID,
      workTitle: WORK_TITLE,
      operation: 'open',
      objective: '验证工作记录面板（合成）',
      scope: [{ statement: '列出面板' }],
      exclusions: [{ statement: '不做真实写入' }],
      acceptanceCriteria: [{ statement: '关键区块都有 testid' }],
      selection: { kind: 'agent_proposed_unselected', sourceRefs: ['synthetic fixture'] },
      upper: {
        productGoal: { state: 'gap', reason: 'no_relation' },
        stage: null,
        openUserPaths: [],
      },
      lifecycle: { status: 'active', endedReason: null, endedNote: null },
      resume: { stopPoint: '合成停点', nextStep: '下一步', responsibility: 'agent', authorizationRequired: ['none'] },
    },
    adoptedBasis: [],
    sourceRefs: [],
  }, {
    // A second, already-ended work of the SAME Feature: the card counts both and
    // the panel lists both by workId, so no single work is picked as "the" one.
    id: ENDED_RECORD_ID,
    nodeId: NODE_ID,
    createdAt: '2026-11-17T09:00:00.000Z',
    basis: {
      observedStateVersion: 10,
      observedDigest: DIGEST('b'),
      contextFingerprintVersion: 1,
      contextFingerprint: DIGEST('c'),
      contextIds: { nodeIds: [], edgeIds: [], evidenceIds: [], claimIds: [], decisionIds: [], proposalIds: [], reviewIds: [], roadmapItemIds: [] },
    },
    workContext: {
      version: 1,
      workId: ENDED_WORK_ID,
      workTitle: '浏览器合成的历史工作',
      operation: 'open',
      objective: '一条已经结束的工作（合成）',
      scope: [{ statement: '列出面板' }],
      exclusions: [{ statement: '不做真实写入' }],
      acceptanceCriteria: [{ statement: '历史只读' }],
      selection: { kind: 'agent_proposed_unselected', sourceRefs: ['synthetic fixture'] },
      upper: { productGoal: { state: 'gap', reason: 'no_relation' }, stage: null, openUserPaths: [] },
      lifecycle: { status: 'ended', endedReason: 'handoff', endedNote: '合成结束说明' },
      resume: { stopPoint: '已结束', nextStep: '下一步', responsibility: 'agent', authorizationRequired: ['none'] },
    },
    adoptedBasis: [],
    sourceRefs: [],
  }];
  return state;
}

const q = JSON.stringify;
const sha = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------
// Preflight (always runs): the page the service actually serves.
// ---------------------------------------------------------------------------
async function preflight() {
  const state = await syntheticState();
  const index = deriveCurrentWorkIndex(state);
  assert.equal(index.entries.length, 2, 'the synthetic state has two saved works of one Feature');
  assert.deepEqual(index.entries.map((entry) => entry.workId).sort(), [ENDED_WORK_ID, WORK_ID].sort());
  assert.equal(currentWork(state, WORK_ID).found, true);
  assert.equal(currentWork(state, ENDED_WORK_ID).found, true);

  const nonce = 'test-nonce-browser-work';
  const html = renderReview(
    { state, fileDigest: DIGEST('a'), writable: true },
    { nonce, stateIdentity: 'state:synthetic-work' },
  );

  for (const id of ['current-work-panel', 'current-work-panel-title', 'current-work-panel-body', 'current-work-close']) {
    assert.ok(html.includes(`id="${id}"`), `page shell has #${id}`);
  }
  assert.ok(html.includes('data-testid="current-work-panel"'), 'panel carries its testid');

  // The first paint already aggregates every saved work: both ids and both
  // counts, before any refresh.
  assert.match(html, /data-work-total="2"/);
  assert.match(html, new RegExp(`data-work-ids="${WORK_ID} ${ENDED_WORK_ID}"`));
  assert.match(html, /工作记录 · 1 项进行中、1 项已结束/);

  const scripts = [...html.matchAll(/<script\b/g)];
  assert.equal(scripts.length, 1, 'still exactly one page script');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids.filter((value, at) => ids.indexOf(value) !== at), [], 'no duplicated element ids');

  const source = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  for (const name of [
    'renderCurrentWorkEntry', 'renderCurrentWorkBadge', 'renderCurrentWorkDetail',
    'renderCurrentWorkEditor', 'renderCurrentWorkPreview', 'renderCurrentWorkHistory',
  ]) {
    assert.ok(source.includes(`${name}: function`), `page script receives ${name}`);
  }

  // Wiring invariants, checked on the shipped function source rather than guessed.
  const reviewSource = (await import('../scripts/review-ui.mjs')).initializeReview.toString();
  const workRegion = reviewSource.slice(reviewSource.indexOf('function clientOperationId'), reviewSource.indexOf('function featureProgressDetailFor'));
  assert.ok(workRegion.length > 2000, 'the work region is present');
  assert.ok(!/formRevision\s*(\+=|\+\+)/.test(workRegion), 'work actions never bump formRevision');
  assert.ok(!/url\.searchParams\.set\(['"](claim|proposal)['"]/.test(workRegion), 'work actions never rewrite review params');
  assert.ok(/searchParams\.set\('work'/.test(workRegion), 'work view is linkable through ?work=');
  assert.ok(/previewContentDigest: preview\.previewContentDigest/.test(workRegion), 'save echoes the preview digest verbatim');
  assert.ok(!/createHash|digestValue|sha256:/.test(workRegion), 'the client never computes a digest');
  assert.ok(/operationId: view\.operationId/.test(workRegion), 'save reuses one operationId per click');
  assert.ok(/workRequestToken|workRequestCurrent/.test(workRegion), 'async work requests are bound to their work view');
  assert.ok(/refreshState\(\{ quiet: true, restore: false, workPanel: false \}\)/.test(workRegion), 'a work save does not rebuild the review panel or the work panel');
  assert.ok(/renderDirectoryHosts\(\{ workPanel: options\.workPanel !== false \}\)/.test(reviewSource), 'a state read can skip the work panel repaint');
  assert.ok(/function renderDirectoryHosts\(options = \{\}\)/.test(reviewSource), 'a directory repaint takes the opt-out');
  assert.ok(/renderWorkPanel\(\)/.test(reviewSource.slice(reviewSource.indexOf('function renderDirectoryHosts'))), 'the default still repaints the work panel');
  const graphSource = (await import('../scripts/graph-view.mjs')).initializeGraph.toString();
  assert.ok(/graphHoldsFocus/.test(graphSource), 'the graph only restores node focus while it holds the focus');
  assert.ok(/'#graph-world \.\[data-node-id\]'|'#graph-world'/.test(graphSource), 'the graph takes a node focus only from inside the graph (the work form also has data-node-id)');
  assert.ok(/readWorkStatus/.test(workRegion), 'an unknown outcome always reads status');
  const saveOnly = workRegion.slice(workRegion.indexOf('function saveWork'), workRegion.indexOf('function applySavedReceipt'));
  assert.ok(saveOnly.length > 0, 'saveWork is present');
  assert.ok(!/'saved'/.test(saveOnly), 'the request path never enters saved before a receipt is applied');
  const statusRead = workRegion.slice(workRegion.indexOf('function readWorkStatus'), workRegion.indexOf('function openWorkHistory'));
  assert.ok(/body\?\.found === true[\s\S]*setWorkPhase\('saved'/.test(statusRead), 'the status read only enters saved after finding the receipt');

  const directorySource = (await import('../scripts/review-ui.mjs')).renderDirectory.toString();
  assert.ok(/options\.currentWork/.test(directorySource), 'renderDirectory takes the work badge map');
  assert.ok(/current-work-badge/.test(directorySource), 'cards render the work badge word');

  return { state, html, nonce };
}

// A page-level fetch shim: answers the four routes the page can call with
// synthetic values and records every request body for assertions.
function shimSource(state, fileDigest) {
  const preview = {
    ok: true,
    previewId: 'preview:00000000-0000-4000-8000-0000000009a1',
    previewContentDigest: DIGEST('d'),
    workId: WORK_ID,
    operation: 'adjust',
    expiresAt: '2026-11-19T10:00:00.000Z',
    diff: [{ group: 'objective', before: '验证工作记录面板（合成）', after: '验证保存后的目标（合成）' }],
    sidecarPlan: [],
    notes: [],
  };
  const receipt = {
    ok: true,
    replayed: false,
    commitStatus: 'committed',
    receiptId: 'map-update:00000000-0000-4000-8000-0000000009b1',
    recordId: 'checkpoint:00000000-0000-4000-8000-0000000009b2',
    workId: WORK_ID,
    operationId: null,
    observedStateVersion: 12,
    resultingStateVersion: 13,
    observedDigest: fileDigest,
    resultingDigest: DIGEST('e'),
    digestSource: 'readback',
    previewContentDigest: preview.previewContentDigest,
    payloadDigest: DIGEST('f'),
    readback: { verified: true, recordPresent: true, receiptPresent: true },
  };
  return `(() => {
    const state = ${JSON.stringify(state)};
    const requests = [];
    window.__workRequests = requests;
    // Held /api/state reads (see the /api/state branch below): the pending promise
    // is dropped and the parked response is returned to the scenario, which
    // resolves it by hand when it wants that read to land.
    const heldReads = [];
    window.__heldStateReads = heldReads;
    window.__heldResolvers = [];
    window.__releaseHeldStateRead = (index = 0) => {
      const resolver = window.__heldResolvers.splice(index, 1)[0];
      const response = heldReads.splice(index, 1)[0];
      if (!resolver) return false;
      resolver(response);
      return true;
    };
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const original = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input);
      const method = (init && init.method) || 'GET';
      const path = url.replace(/^[a-z]+:\\/\\/[^/]+/i, '').split('#')[0];
      if (path.startsWith('/api/state')) {
        const body = { ok: true, state, currentStateVersion: state.stateVersion, currentDigest: ${q(fileDigest)}, writable: true, readOnlyReason: '', viewStatus: { status: 'current', message: '' } };
        // A held read-back: one /api/state response is parked until the scenario
        // releases it, so a save's delayed re-read can be tested against a panel
        // the human has already moved on from.
        if (window.__holdNextStateRead) {
          window.__holdNextStateRead = false;
          const body = { ok: true, state, currentStateVersion: state.stateVersion, currentDigest: ${q(fileDigest)}, writable: true, readOnlyReason: '', viewStatus: { status: 'current', message: '' } };
          return new Promise((resolution) => {
            const resolve = () => resolution(json(body));
            window.__heldStateReads.push(resolve);
            window.__heldResolvers.push(resolve);
          });
        }
        return json(body);
      }
      if (path.startsWith('/api/current-work/preview')) {
        requests.push({ path: '/api/current-work/preview', method, body: JSON.parse(init.body) });
        if (window.__failNextPreview) { window.__failNextPreview = false; return new Response('', { status: 500 }); }
        return json(${JSON.stringify(preview)});
      }
      if (path.startsWith('/api/current-work/save')) {
        requests.push({ path: '/api/current-work/save', method, body: JSON.parse(init.body) });
        return json(${JSON.stringify(receipt)});
      }
      if (path.startsWith('/api/current-work/status')) {
        requests.push({ path: '/api/current-work/status', method, url: path });
        return json({ ok: true, found: true, workId: ${q(WORK_ID)}, recordId: ${q(receipt.recordId)}, receiptId: ${q(receipt.receiptId)}, resultingStateVersion: 13, resultingDigest: ${q(DIGEST('e'))}, integrity: 'ok', readback: { recordPresent: true, receiptPresent: true } });
      }
      if (path.startsWith('/api/render')) return json({ ok: true });
      return original(input, init);
    };
  })();`;
}

// ---------------------------------------------------------------------------
// Browser scenario. Only runs when a chromium executable is given.
// ---------------------------------------------------------------------------
async function browserScenario(executable, outputDirectory) {
  const { launchBrowser } = await import('./browser-harness.mjs');
  const { state } = await preflight();
  const output = resolve(outputDirectory || join(tmpdir(), 'product-continuity-current-work'));
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, 'page-'));
  const fileDigest = DIGEST('a');
  const pagePath = join(directory, 'review.html');
  const html = renderReview({ state, fileDigest, writable: true }, { nonce: 'test-nonce-browser-work', stateIdentity: 'state:synthetic-work' });
  await writeFile(pagePath, html);
  const pageUrl = 'file:///' + pagePath.replace(/\\/g, '/');
  assert.equal(sha(await readFile(pagePath)) !== '', true);

  const browser = await launchBrowser(executable, tmpdir());
  const page = await browser.newPage();
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: shimSource(state, fileDigest) });
  await page.resize(1440, 1000);
  const runtimeErrors = [];
  try {
    await page.navigate(pageUrl + '?claim=' + encodeURIComponent(state.intentClaims[0].id));
    await page.waitFor('document.querySelector("#intent-list [data-testid=\'current-work-badge\']")');

    // 1. Card badge is a word, not only a colour; a saved work is a work record,
    //    not "what this round is doing". Both saved works are counted at once.
    const badgeText = await page.evaluate('document.querySelector("#intent-list [data-testid=\'current-work-badge\']").textContent');
    assert.match(badgeText, /工作记录 · 1 项进行中、1 项已结束/);
    assert.equal(await page.evaluate('document.querySelector("#intent-list [data-testid=\'current-work-badge\']").closest("[data-testid=\'node-current-work\']").dataset.workTotal'), '2');
    assert.equal(await page.evaluate('document.querySelector("#intent-list [data-testid=\'current-work-badge\']").closest("[data-testid=\'node-current-work\']").dataset.workIds'), `${WORK_ID} ${ENDED_WORK_ID}`);

    // 2. Feature detail exposes the entry.
    await page.click(`#intent-list [data-open-node="${NODE_ID}"]`);
    await page.waitFor('document.querySelector("#review-panel [data-testid=\'current-work-entry\']")');
    // Both works of this Feature are listed by workId; none is picked as "the" one.
    assert.equal(await page.evaluate('document.querySelectorAll("#review-panel [data-testid=\'current-work-entry\']").length'), 2);
    assert.match(await page.evaluate('document.querySelector("#review-panel [data-testid=\'current-work-panel-directory\']").textContent'), /已保存 2 条/);

    // 3. Opening the detail keeps the review URL and the review form.
    const reviewBefore = await page.evaluate(`(()=>{
      const host = document.querySelector('#review-panel-body').cloneNode(true);
      for (const entry of host.querySelectorAll('[data-testid="current-work-entry"]')) entry.removeAttribute('aria-pressed');
      return host.innerHTML;
    })()`);
    await page.click('#review-panel [data-testid="current-work-entry"]');
    await page.waitFor('document.querySelector("#current-work-panel") && !document.querySelector("#current-work-panel").hidden');
    assert.equal(await page.evaluate('document.activeElement.id'), 'current-work-panel-title', 'focus moves to the panel heading');
    const search = await page.evaluate('location.search');
    assert.match(search, /work=work%3Abrowser-synthetic/);
    assert.match(search, new RegExp('claim=' + encodeURIComponent(state.intentClaims[0].id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(await page.evaluate(`(()=>{
      const host = document.querySelector('#review-panel-body').cloneNode(true);
      for (const entry of host.querySelectorAll('[data-testid="current-work-entry"]')) entry.removeAttribute('aria-pressed');
      return host.innerHTML;
    })()`), reviewBefore, 'opening current work does not rewrite the review body apart from its selected-state attribute');
    // The only part of `#review-current` a work action may touch is the directory
    // entry's own selected state (`aria-pressed`); snapshot it without that flag.
    const reviewShell = await page.evaluate(`(()=>{
      const host = document.querySelector('#review-current').cloneNode(true);
      for (const entry of host.querySelectorAll('[data-testid="current-work-entry"]')) entry.removeAttribute('aria-pressed');
      return host.innerHTML;
    })()`);

    // 4. The frozen reading order and three separate chips.
    const order = ['上层目标', '工程阶段', '依据需求', '本轮做', '本轮不做', '验收目标', '整体交付及已记录未闭环路径', '本轮停点／下一步', '范围建议（未选定）', '依据复核'];
    const detailText = await page.evaluate('document.querySelector("[data-testid=\'current-work-detail\']").textContent');
    let cursor = 0;
    for (const heading of order) {
      const at = detailText.indexOf(heading, cursor);
      assert.ok(at >= cursor, `reading order keeps ${heading}`);
      cursor = at;
    }
    assert.ok(await page.evaluate('Boolean(document.querySelector("[data-testid=\'current-work-lifecycle\']"))'));
    assert.ok(await page.evaluate('Boolean(document.querySelector("[data-testid=\'current-work-basis-review\']"))'));
    // The overview answers "why / how far" first and never borrows the Feature's
    // overall progress.
    assert.equal(await page.evaluate('document.querySelector("[data-testid=\'current-work-objective\']").textContent'), '验证工作记录面板（合成）');
    assert.match(await page.evaluate('document.querySelector("[data-testid=\'current-work-progress\']").textContent'), /本轮进展未记录/);
    assert.ok(!(await page.evaluate('Boolean(document.querySelector("[data-testid=\'current-work-detail\'] .delivery-badge"))')), 'the Feature delivery chip is not merged into the work chips');
    assert.match(detailText, /范围建议（未选定）/, 'an agent proposal is never shown as the working scope');
    assert.ok(await page.evaluate('Boolean(document.querySelector("[data-testid=\'current-work-entry\'][data-readonly=\'true\']")) === false'));

    // 5. Editor pre-fills from the saved record and submits a complete snapshot.
    await page.click('[data-work-action="edit"][data-work-operation="adjust"]');
    await page.waitFor('document.querySelector("[data-testid=\'current-work-form\']")');
    assert.equal(await page.evaluate('document.querySelector("#work-objective-input").value'), '验证工作记录面板（合成）');
    await page.type('#work-objective-input', '验证保存后的目标（合成）');
    await page.click('[data-work-action="preview"]');
    await page.waitFor('document.querySelector("[data-testid=\'current-work-diff\']")');
    const previewRequest = await page.evaluate('window.__workRequests.find((item) => item.path.endsWith("/preview"))');
    assert.deepEqual(Object.keys(previewRequest.body).sort(), ['content', 'expectedDigest', 'expectedStateVersion', 'projectId'].sort(), 'preview body keeps its exact keys');
    assert.equal(previewRequest.body.content.objective, '验证保存后的目标（合成）');
    assert.equal(previewRequest.body.content.nodeId, NODE_ID);
    assert.match(await page.evaluate('document.querySelector("[data-testid=\'current-work-diff\']").textContent'), new RegExp(DIGEST('d').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the preview digest is echoed verbatim');

    // 6. Save: journal fields only, the digest verbatim, one operationId, and the
    //    result announced in the existing status region.
    await page.click('[data-work-action="save"]');
    await page.waitFor('document.querySelector("#review-status").textContent.includes("已保存")');
    const saveRequests = await page.evaluate('window.__workRequests.filter((item) => item.path.endsWith("/save"))');
    assert.equal(saveRequests.length, 1, 'a save click makes one request');
    assert.deepEqual(Object.keys(saveRequests[0].body).sort(), ['authorizationRef', 'expectedDigest', 'expectedStateVersion', 'operationId', 'previewContentDigest', 'previewId', 'projectId'].sort(), 'save body keeps its exact keys');
    assert.equal(saveRequests[0].body.previewContentDigest, DIGEST('d'), 'the client echoes the server digest verbatim');
    assert.equal(saveRequests[0].body.previewId, 'preview:00000000-0000-4000-8000-0000000009a1');
    assert.match(await page.evaluate('document.querySelector("#review-status").textContent'), /已保存/);
    assert.equal(await page.evaluate(`(()=>{
      const host = document.querySelector('#review-panel-body').cloneNode(true);
      for (const entry of host.querySelectorAll('[data-testid="current-work-entry"]')) entry.removeAttribute('aria-pressed');
      return host.innerHTML;
    })()`), reviewBefore, 'a save does not rewrite the review body apart from the selected-state attribute');
    assert.equal(await page.evaluate(`(()=>{
      const host = document.querySelector('#review-current').cloneNode(true);
      for (const entry of host.querySelectorAll('[data-testid="current-work-entry"]')) entry.removeAttribute('aria-pressed');
      return host.innerHTML;
    })()`), reviewShell, 'a save only changes the directory entry selection');

    // 6b. End-reason inputs survive a phase re-render: what the human typed is
    //     what the submit would use, so the form never shows A while sending B.
    await page.click('[data-work-action="edit"][data-work-operation="end"]');
    await page.waitFor('document.querySelector("[data-testid=\'current-work-form\']")');
    await page.type('#work-ended-reason-select', 'cancelled');
    await page.type('#work-ended-note-input', '合成取消说明');
    assert.equal(await page.evaluate('document.querySelector("#work-ended-reason-select").value'), 'cancelled');
    assert.equal(await page.evaluate('document.querySelector("#work-ended-note-input").value'), '合成取消说明');
    // Force the next preview to fail so the editor is re-rendered in place.
    await page.evaluate('window.__failNextPreview = true');
    await page.click('[data-work-action="preview"]');
    await page.waitFor('document.querySelector("[data-field=\'endedReason\']") && document.querySelector("[data-work-testid=\'work-phase\']").dataset.phase === "failed"');
    assert.equal(await page.evaluate('document.querySelector("#work-ended-reason-select").value'), 'cancelled', 'the typed end reason survives the re-render');
    assert.equal(await page.evaluate('document.querySelector("#work-ended-note-input").value'), '合成取消说明', 'the typed end note survives the re-render');
    await page.click('#current-work-close');
    await page.waitFor('document.querySelector("#current-work-panel").hidden === true');
    // Reopen the active work's detail for the later steps.
    await page.click('#review-panel [data-testid="current-work-entry"]');
    await page.waitFor("document.querySelector('[data-testid=\"current-work-detail\"]')");

    // 7. History is read-only and offers no preview/save control.
    await page.click(`#review-panel [data-work-action="history"]`);
    await page.waitFor('document.querySelector("[data-testid=\'current-work-history\'][data-readonly=\'true\']")');
    assert.equal(await page.evaluate('Boolean(document.querySelector("[data-testid=\'current-work-history\'] [data-work-action=\'save\']"))'), false);

    // 8. History's "back" returns to the current detail; the panel close control
    //    then closes it and drops only the work query.
    await page.click('[data-work-action="back"]');
    await page.waitFor("document.querySelector('[data-testid=\"current-work-detail\"]')");
    await page.click('#current-work-close');
    await page.waitFor('document.querySelector("#current-work-panel").hidden === true');
    assert.ok(await page.evaluate('Boolean(document.querySelector("#review-panel-title"))'));
    assert.equal(await page.evaluate('location.search.includes("work=")'), false, 'closing drops only ?work=');

    // 9. A page loaded with ?work= and no review params opens the work panel and
    //    leaves the review form unchanged.
    await page.navigate(pageUrl + '?work=' + encodeURIComponent(WORK_ID));
    await page.waitFor('document.querySelector("#current-work-panel") && !document.querySelector("#current-work-panel").hidden');
    assert.match(await page.evaluate('document.querySelector("#review-panel-body").textContent'), /从左侧图谱/);
    assert.equal(await page.evaluate('document.querySelector("#review-version").textContent'), '12');

    // 10. 新建工作记录 only opens an unsaved draft: the URL is untouched, no
    //     request is made, nothing looks saved, and cancelling leaves the panel.
    await page.click('#current-work-close');
    await page.waitFor('document.querySelector("#current-work-panel").hidden === true');
    await page.click(`#intent-list [data-open-node="${NODE_ID}"]`);
    await page.waitFor('document.querySelector("#review-panel [data-work-action=\'new\']")');
    const requestsBeforeDraft = await page.evaluate('window.__workRequests.length');
    await page.click('#review-panel [data-work-action="new"]');
    await page.waitFor('document.querySelector("[data-testid=\'current-work-form\']")');
    assert.equal(await page.evaluate('document.querySelector("[data-testid=\'current-work-form\']").dataset.draft'), 'true');
    assert.match(await page.evaluate('document.querySelector("[data-testid=\'current-work-draft-note\']").textContent'), /未保存草稿/);
    assert.equal(await page.evaluate('location.search.includes("work=")'), false, 'a draft is not linkable and does not rewrite the URL');
    assert.equal(await page.evaluate('window.__workRequests.length'), requestsBeforeDraft, 'opening a draft makes no request');
    assert.equal(await page.evaluate('document.querySelector("#current-work-panel-title").textContent.includes("未保存草稿")'), true);
    await page.click('[data-work-action="back"]');
    await page.waitFor('document.querySelector("#current-work-panel").hidden === true');
    assert.equal(await page.evaluate('window.__workRequests.length'), requestsBeforeDraft, 'cancelling a draft makes no request');

    // 11. A save read-back that lands late never touches a later view: work A
    //     saves, its /api/state read is held, the panel moves on to a new draft B
    //     whose fields are being filled with the caret mid-text, and only then is
    //     A's read released. B is a different view with no workId yet, so A's
    //     read-back must not rewrite it — not its data and not its DOM: the form
    //     element, the focus and the caret must all survive (a rebuilt panel
    //     would blank the editor and drop the caret).
    await page.click(`#intent-list [data-open-node="${NODE_ID}"]`);
    await page.waitFor('document.querySelector("#review-panel [data-testid=\'current-work-entry\']")');
    await page.click('#review-panel [data-testid="current-work-entry"]');
    await page.waitFor("document.querySelector('[data-testid=\"current-work-detail\"]')");
    await page.click('[data-work-action="edit"][data-work-operation="adjust"]');
    await page.waitFor('document.querySelector("[data-testid=\'current-work-form\']")');
    await page.evaluate('window.__holdNextStateRead = true');
    await page.click('[data-work-action="preview"]');
    await page.waitFor('document.querySelector("[data-testid=\'current-work-diff\']")');
    await page.click('[data-work-action="save"]');
    // The save is committed and its own re-read is now parked: the phase is idle
    // again, so the panel can be left while that read is still outstanding.
    await page.waitFor('document.querySelector("[data-testid=\'current-work-phase\']").dataset.phase === "idle"');
    assert.equal(await page.evaluate('window.__heldStateReads.length'), 1, 'exactly one /api/state read is parked');
    // The phase is idle, so the panel can be left while that read is outstanding.
    await page.click('#current-work-close');
    await page.waitFor('document.querySelector("#current-work-panel").hidden === true');
    await page.click('#review-panel [data-work-action="new"]');
    await page.waitFor('document.querySelector("[data-testid=\'current-work-form\']").dataset.draft === "true"');
    await page.type('#work-title-input', '草稿 B 的标题');
    // A half-typed objective with the caret in the middle of it, plus the page-side
    // identity of this draft (a returned DOM node would be serialized away).
    await page.type('#work-objective-input', '草稿 B 的目');
    await page.evaluate(`(()=>{
      const form = document.querySelector('[data-testid="current-work-form"]');
      const objective = document.querySelector('#work-objective-input');
      objective.focus();
      objective.setSelectionRange(5, 5);
      window.__hostDraftB = { form, objective };
    })()`);
    assert.equal(await page.evaluate('document.activeElement === window.__hostDraftB.objective'), true, 'the draft objective holds the focus before the release');
    // Release A's read. The parked response is resolved by hand, so the wait below
    // is for the page to have applied it — not merely for the slot to be empty.
    assert.equal(await page.evaluate('window.__releaseHeldStateRead()'), true, 'the parked read is released');
    await page.waitFor('window.__heldStateReads.length === 0');
    await page.waitFor('document.querySelector("#review-version").textContent === String(12)');
    await new Promise((done) => setTimeout(done, 500));
    // Same element (identity, not a serialized copy), still connected, still the
    // unsaved draft, with the typed values, the focus and the caret untouched.
    const draftIdentity = await page.evaluate(`(() => {
      const b = window.__hostDraftB;
      const form = document.querySelector('[data-testid="current-work-form"]');
      const objective = document.querySelector('#work-objective-input');
      return {
        sameForm: form === b.form && form.isConnected,
        sameObjective: objective === b.objective && objective.isConnected,
        draftFlag: form ? form.dataset.draft : null,
        titleValue: document.querySelector('#work-title-input').value,
        objectiveValue: objective.value,
        focused: document.activeElement === b.objective,
        caret: objective.selectionStart === 5 && objective.selectionEnd === 5,
      };
    })()`);
    assert.deepEqual(draftIdentity, {
      sameForm: true,
      sameObjective: true,
      draftFlag: 'true',
      titleValue: '草稿 B 的标题',
      objectiveValue: '草稿 B 的目',
      focused: true,
      caret: true,
    }, 'a late save read-back keeps the new draft form, its values, its focus and its caret');
    assert.equal(await page.evaluate('location.search.includes("work=")'), false, 'the draft still has no work query');
  } finally {
    runtimeErrors.push(...browser.events.filter((event) => event.method === 'Runtime.exceptionThrown'));
    await browser.close();
  }
  assert.deepEqual(runtimeErrors, [], 'no uncaught runtime errors');
  console.log('BROWSER_CURRENT_WORK_PASS');
}

const argument = process.argv[2];
try {
  const { html } = await preflight();
  console.log('CURRENT_WORK_PREFLIGHT_PASS (' + html.length + ' bytes)');
  if (argument && argument !== '--source-only') await browserScenario(argument, process.argv[3]);
  else console.log('CURRENT_WORK_BROWSER_SKIPPED (pass a chromium executable to run the scenario)');
} catch (error) {
  console.error('CURRENT_WORK_FAIL: ' + (error && error.message ? error.message : error));
  if (error && error.stack) console.error(error.stack);
  process.exitCode = 1;
}
