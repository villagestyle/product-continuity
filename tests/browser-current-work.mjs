#!/usr/bin/env node
// Acceptance for 本轮在做 (references/current-work-contract.md §13).
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
// history (read-only) → related-work filter.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { renderReview } from '../scripts/render-review.mjs';
import { deriveCurrentWorkIndex, currentWork } from '../scripts/feature-progress.mjs';

const WORK_ID = 'work:browser-synthetic';
const WORK_TITLE = '浏览器合成的本轮工作';
const NODE_ID = 'capability:product-details';
const RECORD_ID = 'checkpoint:00000000-0000-4000-8000-000000000901';
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
      objective: '验证本轮在做面板（合成）',
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
  assert.equal(index.entries.length, 1, 'the synthetic state has exactly one saved work');
  assert.equal(index.entries[0].workId, WORK_ID);
  assert.equal(currentWork(state, WORK_ID).found, true);

  const nonce = 'test-nonce-browser-work';
  const html = renderReview(
    { state, fileDigest: DIGEST('a'), writable: true },
    { nonce, stateIdentity: 'state:synthetic-work' },
  );

  for (const id of ['current-work-panel', 'current-work-panel-title', 'current-work-panel-body', 'current-work-close']) {
    assert.ok(html.includes(`id="${id}"`), `page shell has #${id}`);
  }
  assert.ok(html.includes('data-testid="current-work-panel"'), 'panel carries its testid');

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
  assert.ok(/operationId: workView\.operationId/.test(workRegion), 'save reuses one operationId per click');
  assert.ok(/readWorkStatus/.test(workRegion), 'an unknown outcome always reads status');
  assert.ok(!/'saved'/.test(workRegion.slice(0, workRegion.indexOf('function applySavedReceipt'))), 'saved is not entered before a receipt is applied');

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
    diff: [{ group: 'objective', before: '验证本轮在做面板（合成）', after: '验证保存后的目标（合成）' }],
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
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const original = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input);
      const method = (init && init.method) || 'GET';
      const path = url.replace(/^[a-z]+:\\/\\/[^/]+/i, '').split('#')[0];
      if (path.startsWith('/api/state')) {
        return json({ ok: true, state, currentStateVersion: state.stateVersion, currentDigest: ${q(fileDigest)}, writable: true, readOnlyReason: '', viewStatus: { status: 'current', message: '' } });
      }
      if (path.startsWith('/api/current-work/preview')) {
        requests.push({ path: '/api/current-work/preview', method, body: JSON.parse(init.body) });
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

    // 1. Card badge is a word, not only a colour.
    assert.match(
      await page.evaluate('document.querySelector("#intent-list [data-testid=\'current-work-badge\']").textContent'),
      /本轮在做 · 进行中/,
    );

    // 2. Feature detail exposes the entry.
    await page.click(`#intent-list [data-open-node="${NODE_ID}"]`);
    await page.waitFor('document.querySelector("#review-panel [data-testid=\'current-work-entry\']")');

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
    assert.ok(!(await page.evaluate('Boolean(document.querySelector("[data-testid=\'current-work-detail\'] .delivery-badge"))')), 'the Feature delivery chip is not merged into the work chips');
    assert.match(detailText, /范围建议（未选定）/, 'an agent proposal is never shown as the working scope');
    assert.ok(await page.evaluate('Boolean(document.querySelector("[data-testid=\'current-work-entry\'][data-readonly=\'true\']")) === false'));

    // 5. Editor pre-fills from the saved record and submits a complete snapshot.
    await page.click('[data-work-action="edit"][data-work-operation="adjust"]');
    await page.waitFor('document.querySelector("[data-testid=\'current-work-form\']")');
    assert.equal(await page.evaluate('document.querySelector("#work-objective-input").value'), '验证本轮在做面板（合成）');
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
