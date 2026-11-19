import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Script } from 'node:vm';
import { renderReview } from '../scripts/render-review.mjs';
import { renderMap } from '../scripts/render-map.mjs';
import { initializeReview, renderDeferQueue, renderDirectory } from '../scripts/review-ui.mjs';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const demo = await readJson('../examples/demo-project-state-0.2.json');
const fileDigest = 'sha256:' + 'a'.repeat(64);
const nonce = 'test-nonce-123';
const snapshot = (overrides = {}) => ({
  state: structuredClone(demo),
  fileDigest,
  writable: true,
  readOnlyReason: '',
  viewStatus: { status: 'current', message: '静态地图已更新' },
  ...overrides,
});
const render = (overrides = {}, options = {}) => renderReview(snapshot(overrides), { nonce, stateIdentity: 'state:demo', ...options });

function pageScript(html) {
  const match = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  assert.ok(match, 'expected one nonce-bearing page script');
  return { nonce: match[1], source: match[2] };
}

test('review page uses only per-response nonce scripts and no static meta CSP', () => {
  const html = render();
  assert.match(html, /lang="zh-CN"/);
  assert.equal([...html.matchAll(/<script/g)].length, 1);
  assert.match(html, /<script nonce="test-nonce-123">/);
  assert.doesNotMatch(html, /http-equiv="Content-Security-Policy"/i);
  assert.doesNotMatch(html, /<script[^>]*(src=|unsafe-inline)/i);
  assert.doesNotMatch(html, /<link[^>]*href=/i);
  assert.match(html, /实时评审 · 会写入项目状态/);
  assert.match(html, /\.product-continuity\/project-state\.json/);
  assert.match(html, /静态地图已更新/);
});

test('review page escapes unsafe text and serializes bootstrap JSON safely', () => {
  const state = structuredClone(demo);
  state.project.name = '</script><img src=x onerror=alert(1)>';
  state.nodes[0].label = '<img src=x onerror=alert(2)>';
  state.intentClaims[1].statement = '</script><img src=x onerror=alert(3)>';
  state.intentClaims[1].conditions = ['line\u2028separator', 'paragraph\u2029separator'];
  const html = renderReview({ state, fileDigest, writable: true, readOnlyReason: '', viewStatus: null }, { nonce, stateIdentity: 'state:demo' });
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
  assert.ok(!html.includes('<img src=x onerror=alert(2)>'));
  assert.ok(!html.includes('<img src=x onerror=alert(3)>'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(2)&gt;'));
  const { source } = pageScript(html);
  assert.ok(!source.includes('</script><img'));
  assert.ok(source.includes('\\u2028'));
  assert.ok(source.includes('\\u2029'));
  assert.doesNotThrow(() => new Script(source));
  assert.equal([...html.matchAll(/<script/g)].length, 1);
});

test('review page has unique document IDs and an independent review panel', () => {
  const html = render();
  const ids = [...html.slice(0, html.indexOf('<script nonce=')).matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('review-panel'));
  assert.ok(ids.includes('review-panel-title'));
  assert.ok(ids.includes('review-panel-body'));
  assert.ok(ids.includes('review-alert'));
  assert.ok(ids.includes('review-status'));
  assert.ok(ids.includes('intent-directory-title'));
  assert.ok(ids.includes('defer-title'));
  const graphStart = html.indexOf('<section id="graph-view"');
  const graphEnd = html.indexOf('<section class="directory"', graphStart);
  assert.ok(graphStart >= 0 && graphEnd > graphStart);
  const graphMarkup = html.slice(graphStart, graphEnd);
  assert.doesNotMatch(graphMarkup, /data-action=|data-claim-id=|data-proposal-id=|<form|<textarea/);
  const viewportMarkup = graphMarkup.slice(graphMarkup.indexOf('<div class="graph-viewport"'),graphMarkup.indexOf('<section id="graph-time"'));
  assert.doesNotMatch(viewportMarkup, /<input|<select|<textarea/,'timeline filters must not join the canvas gesture surface');
  assert.ok(!graphMarkup.includes('review-panel'), 'graph region must not contain the review panel');
  assert.ok(html.indexOf('id="review-panel"') > graphEnd, 'review panel must sit outside the graph region');
  assert.match(html, /id="review-panel"[^>]*role="region"/);
  assert.match(html, /id="review-panel"[^>]*tabindex="-1"/);
});

test('fullscreen host includes graph and the independent non-modal review region', () => {
  const html = render();
  assert.match(html, /id="review-workspace" class="review-layout" data-graph-fullscreen-host/);
  assert.match(html, /id="graph-fullscreen"[^>]*aria-label="全屏"[^>]*aria-pressed="false"/);
  assert.match(html, /右侧评审面板保留/);
  assert.match(html, /\.continuity-fullscreen-host \.review-main>\.directory\{display:none\}/);
  assert.match(html, /fullscreenOrigin = \{ focus: document.activeElement, x: window.scrollX, y: window.scrollY \}/);
  assert.match(html, /for \(const \[element, inert\] of fullscreenInert\) element.inert = inert/);
  assert.match(html, /event\.stopImmediatePropagation\(\)/);
  assert.doesNotMatch(html, /aria-modal="true"/);
  assert.doesNotThrow(() => new Script(pageScript(html).source));
});

test('closing a panel in fullscreen returns focus to its visible graph', () => {
  const { source } = pageScript(render());
  assert.match(source, /const fullscreenWorkspace = panel\.closest\('\.continuity-fullscreen-host'\)/);
  assert.match(source, /fullscreenWorkspace\.querySelector\('#graph-viewport'\)\?\.focus\(\{ preventScroll: true \}\)/);
});

test('timeline is a read-only dock inside the graph stage with independent accessible tabs', () => {
  const html = render();
  const body = html.slice(0,html.indexOf('<script nonce='));
  const start = body.indexOf('<details id="product-timeline"');
  const end = body.indexOf('<section class="directory"',start);
  assert.ok(start>body.indexOf('id="graph-view"') && end>start);
  const timeline = body.slice(start,end);
  const stage = body.indexOf('<div class="graph-stage">');
  assert.ok(stage > body.indexOf('id="graph-view"') && stage < start);
  assert.match(body,/class="graph-board graph-board--timeline"/);
  assert.match(timeline,/时间线与整体进度/); assert.match(timeline,/id="timeline-category"/);
  assert.match(timeline,/id="timeline-start"/); assert.match(timeline,/id="timeline-detail"/);
  assert.match(body,/id="graph-timeline"[^>]*aria-controls="product-timeline"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(timeline,/data-action=|<form|<textarea/);
  assert.match(timeline,/id="timeline-events-tab" role="tab" aria-controls="timeline-events" aria-selected="true" tabindex="0"/);
  assert.match(timeline,/id="timeline-progress-tab" role="tab" aria-controls="timeline-progress" aria-selected="false" tabindex="-1"/);
  assert.match(timeline,/id="timeline-progress" role="tabpanel"[^>]*hidden/);
  assert.match(timeline,/id="timeline-filters"/);
  assert.match(pageScript(html).source,/initializeTimeline: function/);
  assert.match(pageScript(html).source,/timelineApi\?\.update\(current.state, current.timelineHistory\)/);
});

test('graph time axis is always outside disclosure and current editor is retained separately', () => {
  const html = render(), body = html.slice(0,html.indexOf('<script nonce='));
  assert.ok(body.indexOf('id="graph-time"') < body.indexOf('id="product-timeline"'));
  assert.match(body,/id="graph-time-range" type="range"/);
  assert.match(body,/id="graph-time-previous"/); assert.match(body,/id="graph-time-next"/);
  assert.match(body,/id="graph-time-now"/);
  assert.match(body,/id="review-current"/); assert.match(body,/id="history-panel"[^>]*hidden/);
  const source = pageScript(html).source;
  assert.match(source,/initializeGraphTime: function/);
  assert.match(source,/fetch\('\/api\/snapshot\?'/);
  assert.match(source,/if \(historySelection\) throw new Error/);
});

test('version comparison embeds read-only helpers separately from the preserved editor', () => {
  const html=render(),{source}=pageScript(html),body=html.slice(0,html.indexOf('<script nonce='));
  assert.match(body,/id="version-diff-bar"[^>]*hidden/);
  assert.match(body,/id="version-diff-panel"[^>]*aria-label="版本差异只读详情"[^>]*hidden/);
  assert.match(source,/compareSnapshots: function compareSnapshots/);
  assert.match(source,/initializeVersionDiff: function initializeVersionDiff/);
  assert.match(source,/token!==sequence/);
  assert.match(source,/body\.stateIdentity !== stateIdentity/);
  assert.match(source,/asArray\(current\.state\.conversationCaptures\)/);
  assert.doesNotMatch(source,/asArray\(state\.conversationCaptures\)\.find/);
  const compare=source.slice(source.indexOf('initializeVersionDiff: function initializeVersionDiff'));
  assert.doesNotMatch(compare,/method:\s*['"]POST['"]|\/api\/review|\/api\/submit|innerHTML/);
});

test('review page exposes all nine action entry points in the static directory', () => {
  const html = render();
  const body = html.slice(0, html.indexOf('<script nonce='));
  for (const action of ['edit_candidate', 'split_candidate', 'discard_candidate', 'confirm_candidate', 'propose_edit', 'accept_proposal', 'reject_proposal', 'retire_claim', 'defer']) {
    assert.ok(body.includes(`data-action="${action}"`), `missing ${action}`);
    assert.ok(body.includes(`data-testid="action-${action}"`), `missing test id for ${action}`);
  }
  assert.match(body, /data-action="edit_candidate"[^>]*data-claim-id="claim:task:view-public-product:b"/);
  assert.match(body, /data-action="accept_proposal"[^>]*data-proposal-id="proposal:detail-edit"/);
  assert.match(body, /data-testid="open-claim"/);
  assert.match(body, /data-testid="open-proposal"/);
  assert.match(body, /data-testid="defer-queue"/);
});

test('candidate preparation, confirmation and proposal handling are visibly separate', () => {
  const html = render();
  const body = html.slice(0, html.indexOf('<script nonce='));
  assert.match(body, /整理候选/);
  assert.match(body, /确认这一条/);
  assert.match(body, /拆分候选/);
  assert.match(body, /撤回候选/);
  assert.match(body, /提出修改/);
  assert.match(body, /停止意图/);
  assert.match(body, /接受修改/);
  assert.match(body, /拒绝提案/);
  assert.match(body, /暂缓/);
  assert.match(body, /准备：可独立决定/);
  assert.match(body, /未记录条件/);
  assert.match(body, /未记录例外/);
  assert.match(body, /未记录不等于无条件适用/);
  assert.match(body, /A guest can open a public product detail page\./);
  assert.match(body, /Public storefront/);
  assert.match(body, /历史已替代 1 · 已停止 1 · 已撤回 0/);
  assert.match(body, /内部 ID 与准备记录/);
});

test('read-only snapshots disable action controls and state the reason', () => {
  const html = render({ writable: false, readOnlyReason: '文件摘要偏离；已停写' });
  const body = html.slice(0, html.indexOf('<script nonce='));
  assert.match(body, /只读：文件摘要偏离；已停写/);
  for (const action of ['edit_candidate', 'confirm_candidate', 'accept_proposal', 'retire_claim']) {
    const tag = body.match(new RegExp(`<button[^>]*data-action="${action}"[^>]*>`))?.[0];
    assert.ok(tag, `missing ${action}`);
    assert.match(tag, /disabled/);
    assert.match(tag, /aria-disabled="true"/);
  }
});

test('the boot script parses as a standalone classic script and uses no module imports', () => {
  const html = render();
  const { source } = pageScript(html);
  assert.doesNotThrow(() => new Script(source));
  assert.equal(/\bimport\b/.test(source), false);
  assert.equal(source.includes('__dirname'), false);
  for (const fn of [initializeReview, renderDirectory, renderDeferQueue]) {
    const text = fn.toString();
    assert.equal(/\bimport\b/.test(text), false);
    assert.doesNotThrow(() => new Function(`return (${text});`));
  }
  assert.match(source, /renderDirectory: function/);
  assert.match(source, /renderDeferQueue: function/);
  assert.match(source, /initializeGraph: function/);
  assert.match(source, /buildGraphLayout: function/);
});

test('review page writes through the fixed same-origin endpoints only', () => {
  const html = render();
  const { source } = pageScript(html);
  assert.match(source, /fetch\('\/api\/state'/);
  assert.match(source, /postJson\('\/api\/preview'/);
  assert.match(source, /postJson\('\/api\/reviews'/);
  assert.match(source, /postJson\('\/api\/render'/);
  assert.match(source, /credentials: 'same-origin'/);
  assert.match(source, /'X-Review-Action': '1'/);
  assert.match(source, /'Content-Type': 'application\/json'/);
  assert.equal(source.includes('document.cookie'), false);
  assert.equal(source.includes('localStorage'), false);
  assert.doesNotMatch(source, /\bAuthorization\b\s*:/);
});

test('preview invalidation, stale handling and pending retry are wired in the page', () => {
  const { source } = pageScript(render());
  assert.match(source, /invalidatePreview/);
  assert.match(source, /内容已修改，预览已失效并清空勾选/);
  assert.match(source, /stale-block/);
  assert.match(source, /重新应用到最新状态/);
  assert.match(source, /history_not_verifiable/);
  assert.match(source, /重试原请求/);
  assert.match(source, /retry-pending/);
  assert.match(source, /sessionStorage/);
  assert.match(source, /crypto\.randomUUID/);
});

test('static maps stay read-only and contain no review or write controls', () => {
  const html = renderMap(demo);
  assert.doesNotMatch(html, /data-action=/);
  assert.doesNotMatch(html, /data-claim-id=/);
  assert.doesNotMatch(html, /\/api\/reviews/);
  assert.doesNotMatch(html, /X-Review-Action/);
  assert.doesNotMatch(html, /Content-Security-Policy[^>]*connect-src/);
  assert.doesNotMatch(html,/class="graph-stage"|graph-board--timeline|id="product-timeline"/);
});

test('invalid nonce and absolute state locations are rejected', () => {
  assert.throws(() => renderReview(snapshot(), { nonce: 'short', stateIdentity: 'x' }), /nonce/);
  assert.throws(() => renderReview(snapshot(), { nonce, stateLocation: 'C:/private/state.json' }), /stateLocation/);
  assert.throws(() => renderReview(snapshot(), { nonce, stateLocation: '../outside.json' }), /stateLocation/);
});

test('rendering does not mutate the input state', () => {
  const input = snapshot();
  const before = JSON.stringify(input.state);
  renderReview(input, { nonce, stateIdentity: 'state:demo' });
  assert.equal(JSON.stringify(input.state), before);
});

test('preview submission clones the complete server-preview request payload', async () => {
  const source = await readFile(new URL('../scripts/review-ui.mjs', import.meta.url), 'utf8');
  assert.match(source, /const payload = cloneJson\(previewState\.request\?\.payload \?\? \{\}\);/);
  assert.doesNotMatch(source, /payload\.confirmationAttested = true/);
  assert.doesNotMatch(source, /payload\.coverageAttested = true/);
  assert.doesNotMatch(source, /payload\.stopAttested = true/);
  assert.doesNotMatch(source, /payload\.singleIntentAttested = true/);
});

test('text-action drafts load under the same normalized mode they are stored under', async () => {
  const source = await readFile(new URL('../scripts/review-ui.mjs', import.meta.url), 'utf8');
  for (const snippet of [
    "loadDraft({ type: 'claim', claimId: claim.id, mode: 'discard' })",
    "loadDraft({ type: 'claim', claimId: claim.id, mode: 'retire' })",
    "loadDraft({ type: 'proposal', proposalId: proposal.id, claimId: claim?.id, mode: 'reject' })",
    "loadDraft({ type: 'claim', claimId: claim.id, mode: 'propose' })",
  ]) {
    assert.ok(source.includes(snippet), snippet);
  }
  assert.doesNotMatch(source, /loadDraft\(\{[^}]*mode: 'propose_edit'/);
});

test('array editor IDs use a monotonic counter even after removing a middle row', async () => {
  const source = await readFile(new URL('../scripts/review-ui.mjs', import.meta.url), 'utf8');
  assert.match(source, /let nextIndex = 0;/);
  assert.match(source, /const index = nextIndex\+\+;/);
  assert.doesNotMatch(source, /const index = inputs\.length/);
});

test('stale UI reads the server state before claiming what the server currently says', async () => {
  const source = await readFile(new URL('../scripts/review-ui.mjs', import.meta.url), 'utf8');
  assert.match(source, /readServerState\(\)/);
  assert.doesNotMatch(source, /fullContentElement\(claim, '服务端当前目标意图'\)/);
  assert.match(source, /本地草稿/);
  assert.match(source, /服务端现行四字段/);
});

test('stop handling covers store read-only reasons and disables the workbench', async () => {
  const source = await readFile(new URL('../scripts/review-ui.mjs', import.meta.url), 'utf8');
  for (const code of [
    'invalid_state', 'state_unverifiable', 'hardlink_state', 'read_only', 'migration_required',
    'state_not_found', 'state_not_file', 'state_unreadable', 'invalid_utf8',
    'external_modification', 'lock_lost', 'write_unverified', 'commit_unknown', 'state_validation_failed',
  ]) {
    assert.ok(source.includes(`'${code}'`), `missing stop code ${code}`);
  }
  assert.match(source, /function markReadOnly\(reason\)/);
  assert.match(source, /current\.writable = false/);
  assert.match(source, /updateHeader\(\);\s*renderDirectoryHosts\(\);\s*updateSubmitEnabled\(\);/);
  assert.match(source, /本地草稿/);
});

test('a known review is not retried while writing is stopped', async () => {
  const source = await readFile(new URL('../scripts/review-ui.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(writeBlocked\) \{[\s\S]*?不会执行写重试/);
  assert.match(source, /if \(pendingBanner\?\.dataset\.state === 'history_not_verifiable' \|\| writeBlocked\)/);
  assert.match(source, /pendingBanner\.dataset\.state = 'history_not_verifiable'/);
  assert.match(source, /pendingBanner\.dataset\.state = 'write_blocked'/);
});
