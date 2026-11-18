#!/usr/bin/env node
// Independent browser acceptance of the live workbench. All clicks that can
// confirm an intent target synthetic fixtures, never a user's product state.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { release, tmpdir } from 'node:os';
import { startReviewService } from '../scripts/review-service.mjs';
import { validateStateSchema } from '../scripts/validate-schema-runner.mjs';
import { validateStateReferences } from '../scripts/validate-state.mjs';
import { deriveNodeIntentSummary } from '../scripts/intent-model.mjs';
import { makeAcceptanceState, makeSplitItems, assertEvidenceUnchanged, ACCEPTANCE_TARGET, ACCEPTANCE_NODE } from './acceptance-fixtures.mjs';
import { launchBrowser } from './browser-harness.mjs';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node tests/browser-review.mjs <chromium> [report-directory]');
const output = resolve(process.argv[3] || join(tmpdir(), 'product-continuity-acceptance'));
await mkdir(output, { recursive: true });
const browser = await launchBrowser(executable, tmpdir());
const sha = (bytes) => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const q = JSON.stringify;
const records = [];
const version = await browser.send('Browser.getVersion');
let serial = 0;

function legacyAcceptanceState(shared = false) {
  const state = makeAcceptanceState();
  const target = state.nodes.find((node) => node.id === ACCEPTANCE_NODE);
  target.legacy = { schemaVersion: '0.1', snapshot: { ...structuredClone(target), status: 'confirmed', decisionId: 'decision:legacy-acceptance', conditions: ['完整合成历史条件'] } };
  state.intentClaims[0].origin = 'migration';
  state.intentClaims[0].statement = target.label;
  state.decisions.push({ id: 'decision:legacy-acceptance', recordVersion: '0.1', statement: '完整合成旧决定', applicability: '工具验收合成范围', status: 'confirmed', createdAt: '2026-01-01T00:00:00Z', confirmedAt: '2026-01-01T00:00:00Z', confirmedBy: 'fixture-author', evidenceIds: [] });
  if (shared) {
    const goal = state.nodes.find((node) => node.id === 'goal:acceptance');
    goal.legacy = { schemaVersion: '0.1', snapshot: { ...structuredClone(goal), status: 'confirmed', decisionId: 'decision:legacy-acceptance' } };
  }
  assert.deepEqual(validateStateSchema(state), []);
  assert.deepEqual(validateStateReferences(state), []);
  return state;
}

async function scenario(scenarioId, run, options = {}) {
  const directory = await mkdtemp(join(output, 'browser-state-'));
  const statePath = join(directory, 'project-state.json');
  const initial = options.state || makeAcceptanceState();
  const originalBytes = Buffer.from(JSON.stringify(initial, null, 2) + '\n');
  await writeFile(statePath, originalBytes);
  let service = await startReviewService(statePath, { port: 0, logger: () => {}, ...options.service });
  const pages = [];
  const earlierSubmissions = [];
  const startIndex = browser.events.length;
  const record = { scenarioId, passed: false, exitCode: 1, beforeDigest: sha(originalBytes), expectedCommitStatus: options.writes ? 'verified' : 'not_committed', actualCommitStatus: null };
  const context = {
    directory, statePath, initial,
    get service() { return service; },
    async newPage() {
      const page = await browser.newPage();
      pages.push(page);
      const navigate = page.navigate;
      page.navigate = async (url) => {
        earlierSubmissions.push(...await page.evaluate('window.__acceptanceResponses || []').catch(() => []));
        return navigate(url);
      };
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{window.__acceptanceResponses=[];const original=window.fetch.bind(window);window.fetch=async function(input,init){const response=await original(input,init);if(input==='/api/reviews'){const data=await response.clone().json();window.__acceptanceResponses.push({httpStatus:response.status,outcome:data.outcome||data.code,commitStatus:data.commitStatus,reviewId:data.reviewId,resultingStateVersion:data.resultingStateVersion,currentDigest:data.currentDigest})}return response}})()` });
      await page.resize(1440, 1000);
      await page.navigate(service.url + '/');
      await page.waitFor('document.querySelector("#review-header") && document.querySelector("#intent-list [data-claim-id]")');
      await page.evaluate('new Promise(resolve=>setTimeout(resolve,100))');
      return page;
    },
    async state() { return JSON.parse(await readFile(statePath, 'utf8')); },
    async restart(replacement) {
      const port = service.port;
      await service.close();
      if (replacement) await writeFile(statePath, JSON.stringify(replacement, null, 2) + '\n');
      service = await startReviewService(statePath, { port, logger: () => {}, ...options.service });
    },
    async committed(page, before, action) {
      await page.waitFor(`Number(document.querySelector('#review-version').textContent) === ${before + 1}`);
      await page.waitFor(`document.querySelector('#review-panel-body')?.getAttribute('aria-busy') !== 'true'`);
      const state = await context.state();
      assert.equal(state.stateVersion, before + 1);
      assert.equal(state.reviews.at(-1).command.action, action);
      assert.deepEqual(validateStateSchema(state), []);
      assert.deepEqual(validateStateReferences(state), []);
      assertEvidenceUnchanged(assert, initial, state);
      assert.equal(await page.evaluate('document.activeElement.id'), 'review-status', 'Success focuses result summary');
      record.actualCommitStatus = 'verified';
      return state;
    },
  };
  try {
    await run(context);
    const runtimeErrors = browser.events.slice(startIndex).filter((event) => event.method === 'Runtime.exceptionThrown');
    assert.deepEqual(runtimeErrors, [], 'No uncaught runtime errors');
    const outside = browser.events.slice(startIndex).filter((event) => event.method === 'Network.requestWillBeSent'
      && /^https?:/.test(event.params.request.url) && !event.params.request.url.startsWith(service.url + '/'));
    assert.deepEqual(outside, [], 'No external HTTP requests');
    record.passed = true;
    record.exitCode = 0;
    record.actualCommitStatus ??= 'not_committed';
    console.log('BROWSER_REVIEW_PASS: ' + scenarioId);
  } catch (error) {
    record.error = error.message;
    if (pages[0]) {
      record.screenshot = join(output, `browser-failure-${++serial}.png`);
      await pages[0].screenshot(record.screenshot).catch(() => {});
      record.visibleError = await pages[0].evaluate('document.querySelector("#review-alert")?.textContent').catch(() => 'unavailable');
    }
    console.error('BROWSER_REVIEW_FAIL: ' + scenarioId + ': ' + error.message);
  } finally {
    record.afterDigest = sha(await readFile(statePath));
    record.submissions = [...earlierSubmissions];
    for (const page of pages) record.submissions.push(...await page.evaluate('window.__acceptanceResponses || []').catch(() => []));
    const commits = record.submissions.filter((item) => item.commitStatus === 'verified');
    if (commits.length) record.actualCommitStatus = 'verified';
    else if (record.submissions.length) record.actualCommitStatus = record.submissions.at(-1).commitStatus;
    record.commitStatusBasis = record.submissions.length ? 'actual_http_responses' : 'no_review_request_and_unchanged_bytes';
    if (record.passed && record.actualCommitStatus !== record.expectedCommitStatus) {
      record.passed = false;
      record.exitCode = 1;
      record.error = 'Expected commitStatus did not match the actual submission response';
    }
    await service.close();
    for (const page of pages) await page.close();
    records.push(record);
  }
}

async function action(page, name, id = ACCEPTANCE_TARGET, proposal = false) {
  const target = proposal ? 'data-proposal-id' : 'data-claim-id';
  await page.click(`#intent-list [data-action="${name}"][${target}=${q(id)}]`);
  await page.waitFor(`document.querySelector('[data-testid="form-${name}"]')`);
}

async function preview(page, name) {
  await page.click(`[data-testid="preview-${name}"]`);
  await page.waitFor('document.querySelector("#preview-block") || !document.querySelector("#review-alert").hidden');
  assert.equal(await page.evaluate('Boolean(document.querySelector("#preview-block"))'), true, await page.evaluate('document.querySelector("#review-alert").textContent'));
  await page.evaluate('document.querySelectorAll("#preview-block input[type=checkbox]").forEach(box=>{box.click()})');
  assert.equal(await page.evaluate(`document.querySelector('[data-testid="submit-${name}"]').disabled`), false);
}

async function fillSplit(page) {
  for (const [index, item] of makeSplitItems().entries()) {
    await page.type(`#split-${index}-statement`, item.content.statement);
    await page.click(`[data-testid="split-item"]:nth-child(${index + 1}) .array-editor button.btn-secondary`);
    await page.type(`#split-${index}-scope-0`, item.content.scope[0]);
    await page.type(`[data-testid="split-item"]:nth-child(${index + 1}) select`, 'single');
  }
}

async function split(context, page) {
  await action(page, 'split_candidate');
  await fillSplit(page);
  await preview(page, 'split_candidate');
  const before = (await context.state()).stateVersion;
  await page.click('[data-testid="submit-split_candidate"]');
  return context.committed(page, before, 'split_candidate');
}

async function tabTo(page, selector, max = 180) {
  for (let count = 0; count < max; count += 1) {
    if (await page.evaluate(`document.querySelector(${q(selector)}) === document.activeElement`)) return;
    await page.key('Tab');
  }
  throw new Error('Keyboard Tab cannot reach ' + selector);
}

try {
  await scenario('A02/A03/U01/nine-action-workflow', async (ctx) => {
    const page = await ctx.newPage();
    const seen = new Set();
    async function captureActions() {
      const values = await page.evaluate('[...document.querySelectorAll("#intent-list [data-action]")].map(e=>e.dataset.action)');
      values.forEach((value) => seen.add(value));
    }
    await captureActions();
    let state = await split(ctx, page);
    assert.equal(state.decisions.length, 0);
    const first = state.intentClaims.find((claim) => claim.status === 'candidate' && claim.statement === makeSplitItems()[0].content.statement);
    const second = state.intentClaims.find((claim) => claim.status === 'candidate' && claim.id !== first.id);
    await action(page, 'confirm_candidate', first.id);
    await preview(page, 'confirm_candidate');
    await page.click('[data-testid="submit-confirm_candidate"]');
    state = await ctx.committed(page, 2, 'confirm_candidate');
    const summary = deriveNodeIntentSummary(state.nodes.find((node) => node.id === ACCEPTANCE_NODE), state.intentClaims);
    assert.equal(summary.x, 1); assert.equal(summary.y, 2);
    assert.equal(state.intentClaims.find((claim) => claim.id === second.id).status, 'candidate');
    assert.match(await page.evaluate('document.querySelector("#intent-list").textContent'), /部分已确认 1\/2/);
    await captureActions();
    const transform = await page.evaluate('document.querySelector(".graph-scene")?.style.transform');
    await action(page, 'propose_edit', first.id);
    await page.type('[data-testid="form-propose_edit"] textarea', '合成记录内容不能为空（修改提案一）');
    await page.type('[data-testid="form-propose_edit"] > .field textarea', '只测试提案，不是实际产品决定');
    await page.click('#review-close');
    await action(page, 'propose_edit', first.id);
    assert.equal(await page.evaluate('document.querySelector("[data-testid=form-propose_edit] textarea").value'), '合成记录内容不能为空（修改提案一）');
    assert.equal(await page.evaluate('document.querySelector("[data-testid=form-propose_edit] > .field textarea").value'), '只测试提案，不是实际产品决定');
    await page.click('[data-testid="submit-propose_edit"]');
    state = await ctx.committed(page, 3, 'propose_edit');
    await captureActions();
    let proposal = state.proposals.find((item) => item.status === 'open');
    await action(page, 'reject_proposal', proposal.id, true);
    await page.type('[data-testid="form-reject_proposal"] textarea', '拒绝合成提案，保留现行意图');
    await page.click('#review-close');
    await action(page, 'reject_proposal', proposal.id, true);
    assert.equal(await page.evaluate('document.querySelector("[data-testid=form-reject_proposal] textarea").value'), '拒绝合成提案，保留现行意图');
    await page.click('[data-testid="submit-reject_proposal"]');
    await ctx.committed(page, 4, 'reject_proposal');
    await action(page, 'propose_edit', first.id);
    await page.type('[data-testid="form-propose_edit"] textarea', '合成记录内容不能为空（修改提案二）');
    await page.type('[data-testid="form-propose_edit"] > .field textarea', '只测试接受提案');
    await page.click('[data-testid="submit-propose_edit"]');
    state = await ctx.committed(page, 5, 'propose_edit');
    proposal = state.proposals.find((item) => item.status === 'open');
    await action(page, 'accept_proposal', proposal.id, true);
    await preview(page, 'accept_proposal');
    await page.click('[data-testid="submit-accept_proposal"]');
    state = await ctx.committed(page, 6, 'accept_proposal');
    const adopted = state.intentClaims.find((claim) => claim.status === 'confirmed');
    await action(page, 'retire_claim', adopted.id);
    await page.type('[data-testid="form-retire_claim"] textarea', '停止合成意图');
    await page.click('#review-close');
    await action(page, 'retire_claim', adopted.id);
    assert.equal(await page.evaluate('document.querySelector("[data-testid=form-retire_claim] textarea").value'), '停止合成意图');
    await preview(page, 'retire_claim');
    await page.click('[data-testid="submit-retire_claim"]');
    await ctx.committed(page, 7, 'retire_claim');
    assert.equal(await page.evaluate('document.querySelector(".graph-scene")?.style.transform'), transform, 'No full-page navigation or graph reset');
    assert.deepEqual([...seen].sort(), ['edit_candidate', 'split_candidate', 'discard_candidate', 'confirm_candidate', 'propose_edit', 'accept_proposal', 'reject_proposal', 'retire_claim', 'defer'].sort());
    const duplicateIds = await page.evaluate('(()=>{const ids=[...document.querySelectorAll("[id]")].map(e=>e.id);return ids.filter((id,i)=>ids.indexOf(id)!==i)})()');
    assert.deepEqual(duplicateIds, []);
    await page.resize(1440, 1000);
    await page.screenshot(join(output, 'review-desktop.png'));
  }, { writes: true });

  await scenario('P02/preview-invalidated-and-full-payload', async (ctx) => {
    const page = await ctx.newPage();
    await action(page, 'split_candidate');
    await fillSplit(page);
    await preview(page, 'split_candidate');
    await page.type('[data-testid="form-split_candidate"] > .field textarea', '预览后的合成备注');
    assert.equal(await page.evaluate('Boolean(document.querySelector("#preview-block"))'), false, 'Editing removes preview and checkboxes');
    await preview(page, 'split_candidate');
    await page.click('[data-testid="submit-split_candidate"]');
    const state = await ctx.committed(page, 1, 'split_candidate');
    assert.equal(state.reviews.at(-1).command.payload.note, '预览后的合成备注', 'Submit preserves complete server-previewed payload');
  }, { writes: true });

  await scenario('U02/defer-refresh-resolve', async (ctx) => {
    const page = await ctx.newPage();
    await action(page, 'defer');
    await page.click('[data-testid="submit-defer"]');
    await ctx.committed(page, 1, 'defer');
    await page.navigate(ctx.service.url + '/');
    await page.waitFor('document.querySelector("[data-testid=defer-item]")');
    await action(page, 'edit_candidate');
    await page.type('[data-testid="form-edit_candidate"] textarea', '整理后的合成候选');
    await page.click('[data-testid="submit-edit_candidate"]');
    const state = await ctx.committed(page, 2, 'edit_candidate');
    assert.equal(state.decisions.length, 0);
    assert.equal(await page.evaluate('document.querySelectorAll("[data-testid=defer-item]").length'), 0);
  }, { writes: true });

  await scenario('U02/drafts-all-text-actions', async (ctx) => {
    const page = await ctx.newPage();
    for (const [name, text] of [['edit_candidate', '本标签整理草稿'], ['discard_candidate', '本标签撤回原因草稿']]) {
      await action(page, name);
      await page.type(`[data-testid="form-${name}"] textarea`, text);
      await page.click('#review-close');
      await action(page, name);
      assert.equal(await page.evaluate(`document.querySelector('[data-testid="form-${name}"] textarea').value`), text, name + ' restores draft');
    }
    assert.equal((await ctx.state()).reviews.length, 0);
    assert.equal(await page.evaluate('localStorage.length'), 0);
    const storage = await page.evaluate('[...Array(sessionStorage.length)].map((_,i)=>sessionStorage.key(i))');
    assert.ok(storage.every((key) => key.includes(encodeURIComponent(ctx.initial.project.id))));
  });

  await scenario('U01/dynamic-array-ids-remain-unique', async (ctx) => {
    const page = await ctx.newPage();
    await action(page, 'edit_candidate');
    const add = '[data-testid="form-edit_candidate"] .array-editor button.btn-secondary';
    await page.click(add); await page.click(add); await page.click(add);
    await page.click('[data-testid="form-edit_candidate"] .array-editor .array-row:nth-child(2) button');
    await page.click(add);
    assert.deepEqual(await page.evaluate('(()=>{const ids=[...document.querySelectorAll("[id]")].map(e=>e.id);return ids.filter((id,i)=>ids.indexOf(id)!==i)})()'), []);
    assert.equal(await page.evaluate('[...document.querySelectorAll("#review-panel label[for]")].every(label=>document.querySelectorAll("[id="+JSON.stringify(label.htmlFor)+"]").length===1)'), true);
  });

  await scenario('A01/browser-discard-with-preview', async (ctx) => {
    const page = await ctx.newPage();
    await action(page, 'discard_candidate');
    await page.type('[data-testid="form-discard_candidate"] textarea', '合成候选提取错误，只撤回候选');
    await preview(page, 'discard_candidate');
    await page.click('[data-testid="submit-discard_candidate"]');
    const state = await ctx.committed(page, 1, 'discard_candidate');
    assert.equal(state.intentClaims.find((claim) => claim.id === ACCEPTANCE_TARGET).status, 'dismissed');
    assert.equal(state.decisions.length, 0);
    assert.equal(state.reviews.at(-1).command.payload.reason, '合成候选提取错误，只撤回候选');
  }, { writes: true });

  await scenario('U01/U03/query-hash-back-keyboard-focus', async (ctx) => {
    const page = await ctx.newPage();
    const selector = `#intent-list [data-open-claim=${q(ACCEPTANCE_TARGET)}]`;
    await page.evaluate(`document.querySelector(${q(selector)}).focus()`);
    await page.key('Enter');
    assert.equal(await page.evaluate('document.activeElement.id'), 'review-panel-title');
    assert.equal(await page.evaluate('new URL(location.href).searchParams.get("claim")'), ACCEPTANCE_TARGET);
    assert.match(await page.evaluate('location.hash'), /^#node-/);
    await page.key('Escape');
    assert.equal(await page.evaluate('document.activeElement.dataset.openClaim'), ACCEPTANCE_TARGET);
    await page.evaluate('history.back()');
    await page.waitFor('new URL(location.href).searchParams.get("claim") !== null');
    assert.equal(await page.evaluate('document.activeElement.id'), 'review-panel-title');
    await page.evaluate('history.back()');
    await page.waitFor('new URL(location.href).searchParams.get("claim") === null');
    assert.equal(await page.evaluate('document.querySelector("#review-panel-body [data-testid=claim-panel]") === null'), true);
    await action(page, 'edit_candidate');
    await page.type('[data-testid="form-edit_candidate"] textarea', '');
    await page.click('[data-testid="submit-edit_candidate"]');
    assert.equal(await page.evaluate('document.activeElement.id'), 'review-alert', 'Failed validation focuses error summary');
    const invalid = await page.evaluate('(()=>{const e=document.querySelector("[aria-invalid=true]");return {invalid:!!e,description:!!document.getElementById(e?.getAttribute("aria-describedby"))}})()');
    assert.deepEqual(invalid, { invalid: true, description: true });
  });

  await scenario('U03/browser-keyboard-edit-confirm-flow', async (ctx) => {
    const page = await ctx.newPage();
    await tabTo(page, '#intent-list [data-action=edit_candidate]');
    await page.key('Enter');
    await page.waitFor('document.querySelector("[data-testid=form-edit_candidate]")');
    await tabTo(page, '[data-testid="form-edit_candidate"] textarea');
    await page.key('a', 'KeyA', 2);
    await page.send('Input.insertText', { text: '键盘输入的合成意图' });
    await tabTo(page, '[data-testid="form-edit_candidate"] .array-editor button.btn-secondary');
    await page.key('Enter');
    await tabTo(page, '[data-testid="form-edit_candidate"] .array-editor input');
    await page.send('Input.insertText', { text: '纯键盘工具验收' });
    await tabTo(page, '[data-testid="form-edit_candidate"] select');
    await page.key('Home'); await page.key('ArrowDown'); await page.key('Tab');
    assert.equal(await page.evaluate('document.querySelector("[data-testid=form-edit_candidate] select").value'), 'single');
    await tabTo(page, '[data-testid="submit-edit_candidate"]');
    await page.key('Enter');
    const preparedState = await ctx.committed(page, 1, 'edit_candidate');
    const prepared = preparedState.intentClaims.find((claim) => claim.status === 'candidate');
    assert.equal(prepared.statement, '键盘输入的合成意图');
    await tabTo(page, `#intent-list [data-action=confirm_candidate][data-claim-id=${q(prepared.id)}]`);
    await page.key('Enter');
    await tabTo(page, '[data-testid="preview-confirm_candidate"]');
    await page.key('Enter');
    await page.waitFor('document.querySelector("#preview-block")');
    assert.equal(await page.evaluate('document.activeElement.id'), 'preview-title');
    await tabTo(page, '[data-attestation="confirmationAttested"]');
    await page.key(' ', 'Space');
    await tabTo(page, '[data-testid="submit-confirm_candidate"]');
    await page.key('Enter');
    const state = await ctx.committed(page, 2, 'confirm_candidate');
    assert.equal(state.decisions.length, 1);
    assert.deepEqual(state.decisions[0].intent.scope, ['纯键盘工具验收']);
  }, { writes: true });

  await scenario('U03/320-375-200-percent-layout', async (ctx) => {
    const page = await ctx.newPage();
    await action(page, 'split_candidate');
    await fillSplit(page);
    await preview(page, 'split_candidate');
    await page.screenshot(join(output, 'review-form-desktop.png'));
    for (const width of [320, 375, 720]) {
      await page.resize(width, 950);
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'No page overflow at ' + width);
      assert.equal(await page.evaluate('[...document.querySelectorAll("#review-panel button")].filter(e=>e.getClientRects().length&&!e.hidden).every(e=>e.getBoundingClientRect().height>=44)'), true, 'Panel controls have 44px minimum height');
      if (width === 375) {
        await page.screenshot(join(output, 'review-375.png'));
        await page.evaluate('document.querySelector("#review-panel").scrollIntoView({block:"start"})');
        await page.screenshot(join(output, 'review-form-375.png'));
      }
    }
    await page.type('#split-0-statement', '长中文合成意图'.repeat(250));
    await page.type('#split-0-scope-0', 'long-scope-without-break-'.repeat(35));
    await preview(page, 'split_candidate');
    await page.resize(320, 950);
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Maximum-length Chinese and unbroken scope text wrap at 320px');
    // Chromium's page-scale command is pinch zoom, not desktop Ctrl++. CSS zoom
    // 2 + a 720px viewport exercises reflow at 360 effective CSS pixels; report
    // this as emulation rather than claiming a manual desktop zoom test.
    await page.resize(720, 950);
    await page.evaluate('document.documentElement.style.zoom="2"');
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, '200% CSS zoom emulation reflows without page overflow');
  });

  await scenario('U02/P02/two-tabs-stale-preserves-draft', async (ctx) => {
    const a = await ctx.newPage(); const b = await ctx.newPage();
    await action(a, 'edit_candidate');
    await a.type('[data-testid="form-edit_candidate"] textarea', '标签A未提交的候选草稿');
    await action(b, 'defer');
    await b.click('[data-testid="submit-defer"]');
    await ctx.committed(b, 1, 'defer');
    await a.click('[data-testid="submit-edit_candidate"]');
    await a.waitFor('document.querySelector("[data-testid=stale-block]")');
    assert.equal((await ctx.state()).reviews.length, 1);
    assert.equal(await a.evaluate('document.querySelector("[data-testid=form-edit_candidate] textarea").value'), '标签A未提交的候选草稿');
    await a.waitFor('document.querySelector("[data-testid=stale-fresh]").textContent.includes("服务端最新状态：版本")');
    assert.match(await a.evaluate('document.querySelector("[data-testid=stale-fresh]").textContent'), /新增记录内容不能为空且最多 500 字/);
    await a.click('[data-testid="reapply-state"]');
    await a.waitFor('document.querySelector("#review-version").textContent === "2" && !document.querySelector("[data-testid=stale-block]")');
    await a.click('[data-testid="submit-edit_candidate"]');
    const state = await ctx.committed(a, 2, 'edit_candidate');
    assert.equal(state.intentClaims.find((claim) => claim.status === 'candidate').statement, '标签A未提交的候选草稿');
  }, { writes: true });

  await scenario('I01/U02/lost-response-original-key', async (ctx) => {
    const page = await ctx.newPage();
    await action(page, 'defer');
    await page.evaluate(`(()=>{const original=window.fetch.bind(window);window.__sent=[];let lose=true;window.fetch=async function(input,init){if(input==='/api/reviews'){window.__sent.push(init.body);const result=await original(input,init);if(lose){lose=false;await result.text();throw new TypeError('Injected response loss after server commit')}return result}return original(input,init)}})()`);
    await page.click('[data-testid="submit-defer"]');
    await page.waitFor('document.querySelector("#pending-banner [data-testid=retry-pending]")');
    assert.equal((await ctx.state()).reviews.length, 1);
    await page.click('[data-testid="retry-pending"]');
    await page.waitFor('document.querySelector("#review-version").textContent === "2" && document.querySelector("#pending-banner").hidden');
    const sent = await page.evaluate('window.__sent');
    assert.equal(sent.length, 2); assert.equal(sent[0], sent[1], 'Exact original request bytes on retry');
    assert.equal((await ctx.state()).reviews.length, 1);
    assert.match(await page.evaluate('document.querySelector("#review-status").textContent'), /重放/);
    const submitted = await ctx.state();
    assert.deepEqual(validateStateSchema(submitted), []);
    assert.deepEqual(validateStateReferences(submitted), []);
    assertEvidenceUnchanged(assert, ctx.initial, submitted);
  }, { writes: true });

  await scenario('I03/known-review-missing-same-version', async (ctx) => {
    const page = await ctx.newPage();
    await page.evaluate(`(()=>{const bootKey='product-continuity:review:pending:'+encodeURIComponent(${q(ctx.initial.project.id)})+':'+encodeURIComponent(document.querySelector('#review-state-identity').textContent)+':claim%3A'+encodeURIComponent(${q(ACCEPTANCE_TARGET)});sessionStorage.setItem(bootKey,JSON.stringify({key:bootKey,projectId:${q(ctx.initial.project.id)},expectedStateVersion:1,knownReviewId:'review:known-then-restored-away',request:{idempotencyKey:'known-original-key'},target:{type:'claim',claimId:${q(ACCEPTANCE_TARGET)}}}))})()`);
    await page.navigate(ctx.service.url + '/');
    await page.waitFor('document.querySelector("#pending-banner") && !document.querySelector("#pending-banner").hidden');
    assert.equal(await page.evaluate('document.querySelector("#pending-banner").dataset.state'), 'history_not_verifiable', 'Known missing review blocks even when current equals request expected version');
    assert.equal(await page.evaluate('document.querySelector("[data-testid=retry-pending]") === null'), true);
  });

  await scenario('M02/browser-one-to-one-legacy-restatement', async (ctx) => {
    const page = await ctx.newPage();
    const oldClaim = ctx.initial.intentClaims.find((claim) => ctx.initial.nodes.find((node) => node.id === claim.nodeId)?.legacy?.snapshot?.decisionId);
    assert.ok(oldClaim);
    await action(page, 'edit_candidate', oldClaim.id);
    await page.click('[data-testid="form-edit_candidate"] .array-editor button.btn-secondary');
    await page.type('[data-testid="form-edit_candidate"] .array-editor input', '完整合成历史决定适用范围');
    await page.type('[data-testid="form-edit_candidate"] select', 'single');
    await page.click('[data-testid="form-edit_candidate"] .assessment-editor input[type=checkbox]');
    const before = ctx.initial.stateVersion;
    await page.click('[data-testid="submit-edit_candidate"]');
    let state = await ctx.committed(page, before, 'edit_candidate');
    const prepared = state.intentClaims.find((claim) => claim.nodeId === oldClaim.nodeId && claim.status === 'candidate');
    await action(page, 'confirm_candidate', prepared.id);
    await preview(page, 'confirm_candidate');
    assert.equal(await page.evaluate('Boolean(document.querySelector("[data-attestation=\\"legacyResolution.fullRestatementAttested\\"]"))'), true);
    assert.match(await page.evaluate('document.querySelector("#review-panel-body").textContent'), new RegExp(ctx.initial.decisions.find((decision) => decision.id === ctx.initial.nodes.find((node) => node.id === oldClaim.nodeId).legacy.snapshot.decisionId).statement.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await page.click('[data-testid="submit-confirm_candidate"]');
    state = await ctx.committed(page, before + 1, 'confirm_candidate');
    assert.equal(state.intentClaims.find((claim) => claim.id === prepared.id).status, 'confirmed');
  }, { writes: true, state: legacyAcceptanceState() });

  await scenario('M02/browser-shared-legacy-blocked', async (ctx) => {
    const page = await ctx.newPage();
    await action(page, 'edit_candidate');
    await page.click('[data-testid="form-edit_candidate"] .array-editor button.btn-secondary');
    await page.type('[data-testid="form-edit_candidate"] .array-editor input', '合成共享旧决定范围');
    await page.type('[data-testid="form-edit_candidate"] select', 'single');
    await page.click('[data-testid="form-edit_candidate"] .assessment-editor input[type=checkbox]');
    await page.click('[data-testid="submit-edit_candidate"]');
    const state = await ctx.committed(page, 1, 'edit_candidate');
    const prepared = state.intentClaims.find((claim) => claim.status === 'candidate');
    await page.click(`#intent-list [data-action="confirm_candidate"][data-claim-id=${q(prepared.id)}]`);
    await page.waitFor('document.querySelector("#review-panel-body").textContent.includes("共享")');
    assert.equal(await page.evaluate('document.querySelector("[data-testid=preview-confirm_candidate]") === null'), true);
    assert.equal((await ctx.state()).decisions.filter((item) => item.recordVersion === '0.2').length, 0);
  }, { writes: true, state: legacyAcceptanceState(true) });

  let failView = true;
  await scenario('V01/browser-saved-view-pending', async (ctx) => {
    const page = await ctx.newPage();
    await action(page, 'defer');
    await page.click('[data-testid="submit-defer"]');
    await ctx.committed(page, 1, 'defer');
    await page.waitFor('document.querySelector("#review-status").textContent.includes("静态地图待更新")');
    const before = await readFile(ctx.statePath);
    failView = false;
    await page.click('#review-render-view');
    await page.waitFor('document.querySelector("#review-status").textContent.includes("视图已重新生成")');
    assert.deepEqual(await readFile(ctx.statePath), before, 'Render retry never appends review');
  }, { writes: true, service: { renderViews: async ({ state }) => { if (failView) throw new Error('Synthetic view failure'); const { renderMap } = await import('../scripts/render-map.mjs'); return renderMap(state); } } });

  const hostile = makeAcceptanceState();
  hostile.project.name = '</script><script>globalThis.__xss=1</script>';
  hostile.intentClaims[0].statement = '<img src="https://example.invalid/attack" onerror="globalThis.__xss=2"> javascript:globalThis.__xss=3';
  await scenario('H03/browser-nonce-xss', async (ctx) => {
    const page = await ctx.newPage();
    await action(page, 'edit_candidate');
    assert.equal(await page.evaluate('globalThis.__xss'), undefined);
    assert.equal(await page.evaluate('document.querySelectorAll("img").length'), 0);
    assert.match(await page.evaluate('document.querySelector("#review-panel-body").textContent'), /<img src=/);
    assert.equal(await page.evaluate('document.querySelectorAll("a[href^=javascript]").length'), 0);
  }, { state: hostile });

  await scenario('U02/session-restart-no-auto-confirmation', async (ctx) => {
    const page = await ctx.newPage();
    await action(page, 'defer');
    await ctx.restart();
    await page.click('[data-testid="submit-defer"]');
    await page.waitFor('document.querySelector("#review-alert").textContent.includes("会话")');
    assert.equal((await ctx.state()).reviews.length, 0);
    assert.equal(await page.evaluate('document.querySelector("[data-testid=submit-defer]").disabled'), true);
  });

  await scenario('W01/browser-unverifiable-source-stops-writing', async (ctx) => {
    const page = await ctx.newPage();
    await action(page, 'defer');
    await page.type('[data-testid="form-defer"] textarea', '损坏前保留的本标签草稿');
    const damaged = '{"syntheticBrokenState":';
    await writeFile(ctx.statePath, damaged);
    await page.click('[data-testid="submit-defer"]');
    await page.waitFor('document.querySelector("#review-alert").dataset.code === "invalid_state" && document.querySelector("#review-panel-body").getAttribute("aria-busy") === "false"');
    assert.equal(await page.evaluate('document.querySelector("[data-testid=submit-defer]").disabled'), true, 'Invalid on-disk state disables further submission');
    assert.match(await page.evaluate('document.querySelector("#review-writable").textContent'), /只读|停写/);
    assert.equal(await page.evaluate('document.querySelector("#intent-list [data-action]:not([disabled])") === null'), true, 'Directory also states read-only');
    assert.equal(await page.evaluate('document.querySelector("[data-testid=form-defer] textarea").value'), '损坏前保留的本标签草稿');
    assert.equal(await readFile(ctx.statePath, 'utf8'), damaged, 'Damaged bytes are preserved, never auto-recovered');
  });
} finally {
  const report = { kind: 'host-browser-review-acceptance', generatedAt: new Date().toISOString(), environment: { node: process.version, os: process.platform, release: release(), filesystem: 'NTFS; C: temporary directories', browser: version.product }, passed: records.every((item) => item.passed), scenarios: records, limitations: ['Synthetic tool actions only; not a human product confirmation.', 'Response-loss check injects a client fetch rejection after a real server response.', '200% reflow is CSS zoom emulation, not a manually verified desktop browser zoom.', 'A real screen-reader run and a real console Ctrl+C have not been performed.'] };
  await writeFile(join(output, 'browser-review-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
const failed = records.filter((item) => !item.passed);
console.log(`BROWSER_REVIEW_RESULT: ${records.length - failed.length}/${records.length} passed; ${failed.length} failed.`);
if (failed.length) process.exitCode = 1;
