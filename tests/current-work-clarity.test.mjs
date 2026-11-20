// 工作表达分层与当前工作可读性改造 · 批次 1
// A node's own text is a quoted 用途说明 (not a confirmed capability), a saved
// work record always shows 为什么做 and its own overview, and a new work starts as
// an unsaved draft. Everything below is synthetic: no real project state is read.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  nodeDisplayHtml,
  nodeDisplayProjection,
  nodeDisplayText,
  nodeWorkCounts,
  nodeWorkCoverage,
  nodeWorkEmptyText,
  nodeWorkIndexByNode,
  nodeWorkListLabel,
  nodeWorkSummaryText,
} from '../scripts/node-display.mjs';
import { renderCurrentWorkDetail, renderCurrentWorkEditor } from '../scripts/roadmap-ui.mjs';
import { initializeReview, renderDirectory } from '../scripts/review-ui.mjs';
import { renderReview } from '../scripts/render-review.mjs';
import { renderMap } from '../scripts/render-map.mjs';

const IMPLEMENTATION = 'impl:synthetic-material';
const VERIFICATION = 'verification:synthetic-tests';
const CAPABILITY = 'capability:synthetic-feature';
const OTHER_OWNER = 'commitment:synthetic-promise';

function syntheticState() {
  return {
    schemaVersion: '0.2',
    project: { id: 'synthetic-clarity', name: '合成项目', scopeDescription: '只用于测试' },
    activeBaselineId: 'baseline:synthetic',
    stateVersion: 3,
    nodes: [
      { id: CAPABILITY, kind: 'capability', label: '合成功能', status: 'candidate', description: '功能用途：读与写。', evidenceIds: [] },
      { id: IMPLEMENTATION, kind: 'implementation', label: '合成实现', status: 'observed', description: '这条材料怎么实现该功能。', evidenceIds: [] },
      { id: VERIFICATION, kind: 'verification', label: '合成验证', status: 'observed', description: '这条材料覆盖哪些检查。', evidenceIds: [] },
      { id: OTHER_OWNER, kind: 'behavior_commitment', label: '合成承诺', status: 'candidate', evidenceIds: [] },
    ],
    edges: [
      { id: 'edge:impl', kind: 'implemented_by', from: CAPABILITY, to: IMPLEMENTATION, evidenceIds: [] },
      { id: 'edge:verify', kind: 'verified_by', from: CAPABILITY, to: VERIFICATION, evidenceIds: [] },
      { id: 'edge:impl-other', kind: 'implemented_by', from: OTHER_OWNER, to: IMPLEMENTATION, evidenceIds: [] },
    ],
    intentClaims: [],
    evidence: [],
    decisions: [],
    proposals: [],
    checks: [],
    reviews: [],
    mapUpdates: [],
    conversationCaptures: [],
    roadmapItems: [],
    featureCheckpoints: [],
    workContext: [],
  };
}

function workFor(overrides = {}) {
  return {
    workId: 'work:synthetic-1',
    nodeId: CAPABILITY,
    featureLabel: '合成功能',
    workTitle: '合成工作',
    lifecycle: { status: 'active', endedReason: null, endedNote: null },
    objective: '把合成工作讲清楚（合成目标）',
    scope: [{ statement: '写一条记录' }],
    exclusions: [{ statement: '不改状态' }],
    acceptanceCriteria: [{ statement: '预览与保存一致' }],
    selection: { kind: 'agent_proposed_unselected', sourceRefs: [] },
    upper: {},
    resume: { stopPoint: '停在这里', nextStep: '下一步继续', responsibility: 'agent', authorizationRequired: ['none'] },
    sourceRefs: [],
    contextStatus: 'unchanged',
    revisionCount: 1,
    updatedAt: '2026-11-19T08:00:00.000Z',
    source: 'user_note',
    adopted: [],
    changes: [],
    ...overrides,
  };
}

test('an implementation node keeps its original text and says the purpose is not recorded separately', () => {
  const state = syntheticState();
  const node = state.nodes.find((item) => item.id === IMPLEMENTATION);
  const projection = nodeDisplayProjection(node, state);
  assert.equal(projection.kind, 'implementation');
  // The description is the node's own original text; it is never relabelled as
  // an independent purpose statement.
  assert.equal(node.description, '这条材料怎么实现该功能。');
  assert.equal(projection.sourceLabel, '原始节点说明');
  assert.equal(projection.purposeRecorded, false);
  assert.equal(projection.purposeText, '未单独记录用途说明');
  assert.match(projection.purposeNote, /没有从原文里推断用途/);
  assert.equal(projection.description, node.description);
  assert.match(projection.boundary, /不是已确认的产品需求/);
  assert.match(projection.boundary, /也不是某一轮实际工作的记录/);
  // Owners come only from saved edges pointing at this node, and only a product
  // capability counts as the owning Feature.
  assert.deepEqual(projection.relatedCapabilities.map((entry) => entry.id), [CAPABILITY]);
  assert.deepEqual(projection.otherOwners.map((entry) => entry.id), [OTHER_OWNER]);
  assert.equal(projection.relationKind, 'implemented_by');

  const html = nodeDisplayHtml(projection);
  assert.match(html, /data-testid="node-display"/);
  assert.match(html, /data-display-source="original-node-text"/);
  assert.match(html, /原始节点说明/);
  assert.match(html, /<blockquote class="node-display-description">这条材料怎么实现该功能。<\/blockquote>/);
  assert.match(html, /data-testid="node-display-purpose" data-purpose-recorded="false"/);
  assert.match(html, /未单独记录用途说明/);
  assert.match(html, /data-testid="node-display-related"/);
  assert.match(html, /不计入功能工作记录/);
  // The label is never used to guess an owner; the note says so explicitly.
  assert.match(projection.ownerNote, /没有按名称、标题或时间推断/);
});

test('recorded evidence is listed and collapsed, and never reads as a passing run', () => {
  const state = syntheticState();
  state.evidence = [
    { id: 'evidence:synthetic-model', kind: 'implementation', path: 'scripts/synthetic-model.mjs', locator: 'buildSynthetic', validation: 'not_applicable' },
  ];
  state.nodes.find((item) => item.id === IMPLEMENTATION).evidenceIds = ['evidence:synthetic-model', 'evidence:synthetic-missing'];
  const projection = nodeDisplayProjection(state.nodes.find((item) => item.id === IMPLEMENTATION), state);
  assert.equal(projection.evidence.length, 2);
  assert.equal(projection.evidenceSummary, '已有证据 2 条');
  const html = nodeDisplayHtml(projection);
  assert.match(html, /<details class="node-display-evidence"/);
  assert.match(html, /scripts\/synthetic-model\.mjs/);
  assert.match(html, /记录状态：not_applicable（不是本次执行结果）/);
  assert.match(html, /状态里找不到这条证据记录（读取缺口，不是通过）/);
  assert.match(html, /是否在当前版本通过检查需要另行执行/);
  // The critical boundary warnings stay outside the fold.
  const boundaryAt = html.indexOf('不是已确认的产品需求');
  const detailsAt = html.indexOf('<details class="node-display-evidence"');
  assert.ok(boundaryAt > 0 && detailsAt > boundaryAt, 'the boundary note is not folded into the evidence block');
  assert.ok(nodeDisplayText(projection).includes('已有证据 2 条'));

  // A node without recorded evidence does not invent any.
  const bare = nodeDisplayProjection(syntheticState().nodes.find((item) => item.id === IMPLEMENTATION), syntheticState());
  assert.equal(bare.evidence.length, 0);
  assert.equal(nodeDisplayHtml(bare).includes('node-display-evidence'), false);
});

test('a verification node never claims a test passed and an unowned node says so', () => {
  const state = syntheticState();
  const verification = nodeDisplayProjection(state.nodes.find((item) => item.id === VERIFICATION), state);
  assert.equal(verification.sourceLabel, '原始节点说明');
  assert.equal(verification.kindLabel, '验证证据');
  assert.equal(verification.purposeRecorded, false);
  assert.match(verification.boundary, /不代表测试已经通过/);

  const lonely = nodeDisplayProjection({ id: 'impl:lonely', kind: 'implementation', label: '无主材料', status: 'observed', description: '说明' }, state);
  assert.deepEqual(lonely.relatedCapabilities, []);
  assert.match(lonely.missingRelatedText, /未记录 implemented_by 关联的产品能力/);
  assert.match(lonely.missingRelatedText, /不按标题或最近更新时间推断归属/);
  const html = nodeDisplayHtml(lonely);
  assert.match(html, /未记录 implemented_by 关联的产品能力/);
  assert.equal(html.includes('data-testid="node-display-related"'), false);

  const capability = nodeDisplayProjection(state.nodes.find((item) => item.id === CAPABILITY), state);
  assert.equal(capability.kindLabel, '产品能力');
  assert.equal(capability.purposeRecorded, false);
  assert.equal(capability.relationKind, null);
  assert.equal(nodeDisplayHtml(capability).includes('node-display-related'), false);
});

test('node display escapes its own text and keeps the description verbatim', () => {
  const node = {
    id: IMPLEMENTATION,
    kind: 'implementation',
    label: '带引号与尖括号',
    status: 'observed',
    description: '<img src=x onerror="window.bad=1"> "引号" & 与',
  };
  const projection = nodeDisplayProjection(node, syntheticState());
  assert.equal(projection.description, node.description);
  const html = nodeDisplayHtml(projection);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img src=x onerror=&quot;window\.bad=1&quot;&gt;/);
  assert.match(html, /&amp; 与/);
  const text = nodeDisplayText(projection);
  assert.ok(text.includes('<img src=x onerror="window.bad=1">'), 'the text form keeps the original characters');
});

test('work counts never collapse into one "current" number', () => {
  const entries = [
    { lifecycle: 'active' }, { lifecycle: 'active' }, { lifecycle: 'paused' }, { lifecycle: 'ended' },
    { lifecycle: 'unknown-lifecycle' }, null,
  ];
  const counts = nodeWorkCounts(entries);
  assert.deepEqual(counts, { active: 2, paused: 1, ended: 2, total: 5 });
  assert.equal(nodeWorkSummaryText(counts), '2 项进行中、1 项已暂停、2 项已结束');
  assert.equal(nodeWorkListLabel(counts), '工作记录');
  assert.equal(nodeWorkSummaryText(nodeWorkCounts([])), '没有已保存的工作记录');
  // Ended-only work reads as history; it is never "what we are doing now".
  const endedOnly = nodeWorkCounts([{ lifecycle: 'ended' }]);
  assert.equal(nodeWorkListLabel(endedOnly), '历史工作');
  assert.equal(nodeWorkSummaryText(endedOnly), '1 项已结束');
  assert.equal(nodeWorkEmptyText(), '本功能尚无已保存的工作记录');
});

test('the saved work detail shows 为什么做 and its own progress note, never the Feature progress', () => {
  const html = renderCurrentWorkDetail(workFor({
    // A Feature-level progress string must never leak into the work reading.
    progress: { line1: 'FEATURE_PROGRESS_LINE1', line2: 'FEATURE_PROGRESS_LINE2' },
    workDone: 'OUTER_WORK_DONE',
    remaining: 'OUTER_REMAINING',
  }));
  assert.match(html, /data-testid="current-work-objective">把合成工作讲清楚（合成目标）</);
  assert.match(html, /data-testid="current-work-overview"/);
  assert.match(html, /data-testid="current-work-progress" data-recorded="false"/);
  assert.match(html, /本轮进展未记录/);
  assert.match(html, /也不借用功能整体进度/);
  assert.match(html, /为什么做/);
  assert.match(html, /保存于 2026-11-19 08:00:00 · 用户备注（非评审）/);
  assert.equal(html.includes('FEATURE_PROGRESS_LINE1'), false);
  assert.equal(html.includes('OUTER_WORK_DONE'), false);
  assert.equal(html.includes('OUTER_REMAINING'), false);
  // The original reading chain is still complete and still ordered.
  const order = ['上层目标', '工程阶段', '依据需求', '本轮目标', '本轮做', '本轮不做', '验收目标', '整体交付及已记录未闭环路径', '本轮停点／下一步', '范围建议（未选定）', '依据复核'];
  let cursor = 0;
  for (const heading of order) {
    const at = html.indexOf(heading, cursor);
    assert.ok(at >= cursor, `reading order keeps ${heading}`);
    cursor = at;
  }
});

test('a missing objective says so instead of borrowing another record', () => {
  const html = renderCurrentWorkDetail(workFor({ objective: null, source: null, updatedAt: '' }));
  assert.match(html, /data-testid="current-work-objective">目标未记录</);
  assert.match(html, /来源未记录/);
  assert.match(html, /目标未记录。/);
});

test('historical work is read-only and offers no save control', () => {
  const html = renderCurrentWorkDetail(workFor(), { historical: true });
  assert.match(html, /data-readonly="true"/);
  assert.match(html, /历史快照只读/);
  assert.equal(html.includes('data-work-action="edit"'), false);
  assert.equal(html.includes('data-work-action="save"'), false);
  assert.equal(html.includes('data-work-action="history"'), false);
  assert.match(html, /data-testid="current-work-record-state" data-record-state="history"/);
});

test('a new work opens as an unsaved draft, and only a real selection is user-selected', () => {
  const draft = renderCurrentWorkEditor(
    { workId: null, nodeId: CAPABILITY, workTitle: '', lifecycle: { status: 'active' }, selection: null, scope: [], exclusions: [], acceptanceCriteria: [], sourceRefs: [] },
    { operation: 'open', phase: 'idle' },
  );
  assert.match(draft, /data-draft="true"/);
  assert.match(draft, /data-testid="current-work-draft-note" data-record-state="draft"/);
  assert.match(draft, /未保存草稿/);
  assert.match(draft, /新建工作记录/);
  // The selection starts as "not chosen": inside the 范围选定 select only the
  // empty option is selected, so an agent prefill can never be saved as a human
  // choice.
  const selectionSelect = draft.slice(draft.indexOf('data-field="selectionKind"'), draft.indexOf('</select>', draft.indexOf('data-field="selectionKind"')));
  const selected = [...selectionSelect.matchAll(/<option value="([^"]*)"( selected)?>/g)].filter((match) => match[2]);
  assert.deepEqual(selected.map((match) => match[1]), ['']);
  assert.match(draft, /只有你在这里实际选中「用户选定」/);

  const saved = renderCurrentWorkEditor(workFor(), { operation: 'adjust', phase: 'idle' });
  assert.equal(saved.includes('data-draft="true"'), false);
  assert.equal(saved.includes('current-work-draft-note'), false);

  // A draft overlay keeps what the human typed instead of re-reading saved values.
  const overlaid = renderCurrentWorkEditor(workFor(), {
    operation: 'adjust',
    phase: 'idle',
    draft: { objective: '人写的新目标', selectionKind: 'user_selected', selectionSourceRefs: ['用户会话 2026-11-19'] },
  });
  assert.match(overlaid, /人写的新目标/);
  assert.match(overlaid, /<option value="user_selected" selected>/);
  assert.match(overlaid, /用户会话 2026-11-19/);
});

test('pause/resume/end editors keep the business fields read-only', () => {
  const html = renderCurrentWorkEditor(workFor(), { operation: 'pause', phase: 'idle' });
  assert.match(html, /data-readonly="true"/);
  assert.match(html, /暂停工作记录/);
  assert.match(html, /业务字段按保存值只读带入/);
});

test('the page receives the shared display helpers and the graph carries the same text', () => {
  const state = syntheticState();
  const html = renderReview({ state, fileDigest: 'sha256:' + 'a'.repeat(64), writable: true }, { nonce: 'clarity-test', stateIdentity: 'state:synthetic-clarity' });
  const source = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  for (const name of ['nodeDisplayProjection', 'nodeDisplayHtml', 'nodeDisplayText', 'nodeWorkCounts', 'nodeWorkIndexByNode', 'nodeWorkSummaryText', 'nodeWorkListLabel', 'nodeWorkEmptyText']) {
    assert.ok(source.includes(`${name}: function`), `page script receives ${name}`);
  }
  assert.match(source, /"displayText":"原始节点说明（实现证据）/);
  assert.match(source, /"sourceLabel":"原始节点说明"/);
  // The panel is titled 工作记录, not 本轮在做.
  assert.match(html, /id="current-work-panel-title"[^>]*>工作记录</);
  assert.match(html, /工作记录 · 保存记录（非评审、非交付、非授权）/);
});

test('the static map renders the same display block instead of a bare description', () => {
  const html = renderMap(syntheticState());
  assert.match(html, /data-testid="node-display"/);
  assert.match(html, /原始节点说明/);
  assert.match(html, /未单独记录用途说明/);
  assert.match(html, /未记录 implemented_by 关联的产品能力|关联功能（implemented_by）/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.match(script, /"displayText":"原始节点说明（实现证据）/);
});

test('a static node lists recorded evidence as recorded, and only a real gap as missing', () => {
  const state = syntheticState();
  // One evidence record really exists in the state; the other id is a genuine gap.
  state.evidence = [
    { id: 'evidence:synthetic-model', kind: 'implementation', path: 'scripts/synthetic-model.mjs', locator: 'buildSynthetic', validation: 'not_applicable' },
  ];
  state.nodes.find((item) => item.id === IMPLEMENTATION).evidenceIds = ['evidence:synthetic-model', 'evidence:synthetic-missing'];
  const html = renderMap(state);
  // The record that exists is shown with its own path/validation and is NOT
  // reported as missing (the static card passes the already-read evidence in).
  assert.match(html, /<code>evidence:synthetic-model<\/code> · scripts\/synthetic-model\.mjs/);
  assert.match(html, /记录状态：not_applicable（不是本次执行结果）/);
  assert.equal(html.includes('<code>evidence:synthetic-model</code>：状态里找不到这条证据记录'), false);
  // The id with no record stays a visible gap.
  assert.match(html, /<code>evidence:synthetic-missing<\/code>：状态里找不到这条证据记录（读取缺口，不是通过）/);
});

test('every saved work of a Feature is counted, listed and never replaced by one "best" work', () => {
  // The aggregate is the same pure function the first paint and every refresh use.
  const index = {
    entries: [
      { nodeId: CAPABILITY, workId: 'work:a', workTitle: '一', lifecycle: 'active' },
      { nodeId: CAPABILITY, workId: 'work:b', workTitle: '二', lifecycle: 'ended' },
      { nodeId: CAPABILITY, workId: 'work:c', workTitle: '三', lifecycle: 'paused' },
      { nodeId: 'capability:other', workId: 'work:d', workTitle: '四', lifecycle: 'active' },
    ],
  };
  const map = nodeWorkIndexByNode(index);
  assert.deepEqual(map[CAPABILITY].counts, { active: 1, paused: 1, ended: 1, total: 3 });
  assert.deepEqual(map[CAPABILITY].entries.map((entry) => entry.workId), ['work:a', 'work:b', 'work:c']);
  assert.deepEqual(map['capability:other'].entries.map((entry) => entry.workId), ['work:d']);
  assert.equal(nodeWorkIndexByNode({ entries: undefined }), null);

  const state = syntheticState();
  const html = renderDirectory(state, { currentWork: map });
  // All three works are named by id in the card, and all three counts are shown.
  assert.match(html, /data-work-total="3"/);
  assert.match(html, /data-work-ids="work:a work:b work:c"/);
  assert.match(html, /工作记录 · 1 项进行中、1 项已暂停、1 项已结束/);

  // Ended-only work reads as history with its own count, never as 进行中.
  const endedOnly = nodeWorkIndexByNode({ entries: [{ nodeId: CAPABILITY, workId: 'work:old', lifecycle: 'ended' }] });
  const endedHtml = renderDirectory(state, { currentWork: endedOnly });
  assert.match(endedHtml, /历史工作 · 1 项已结束/);
  assert.equal(endedHtml.includes('进行中'), false);
  assert.equal(endedHtml.includes('本轮在做'), false);

  // An older single-entry input still renders (compatibility), and the count of
  // that one work is still honest.
  const legacy = renderDirectory(state, { currentWork: { [CAPABILITY]: { workId: 'work:legacy', workTitle: '旧的', lifecycle: 'paused' } } });
  assert.match(legacy, /data-work-total="1"/);
  assert.match(legacy, /工作记录 · 1 项已暂停/);
});

test('the first paint and later refreshes build the card from the same aggregation', () => {
  const state = syntheticState();
  state.featureCheckpoints = [
    {
      id: 'checkpoint:work-a', nodeId: CAPABILITY, createdAt: '2026-11-18T08:00:00.000Z',
      workContext: { workId: 'work:one', workTitle: '一', operation: 'open', lifecycle: { status: 'active' } },
      content: {},
    },
    {
      id: 'checkpoint:work-b', nodeId: CAPABILITY, createdAt: '2026-11-17T08:00:00.000Z',
      workContext: { workId: 'work:two', workTitle: '二', operation: 'open', lifecycle: { status: 'ended', endedReason: 'handoff' } },
      content: {},
    },
  ];
  const html = renderReview({ state, fileDigest: 'sha256:' + 'a'.repeat(64), writable: true }, { nonce: 'clarity-test', stateIdentity: 'state:synthetic-clarity' });
  const source = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
  // Both surfaces call the same pure helper over the same index...
  assert.match(source, /nodeWorkIndexByNode: function/);
  const liveFn = initializeReview.toString().slice(
    initializeReview.toString().indexOf('function currentWorkByNode'),
    initializeReview.toString().indexOf('function workProjectionFor'),
  );
  assert.match(liveFn, /nodeWorkIndexByNode/);
  assert.equal(liveFn.includes('rank'), false, 'no lifecycle ranking picks a single work');
  // ...and the server-rendered first paint already lists both works with both
  // counts, exactly as the live refresh will.
  assert.match(html, /data-work-total="2"/);
  assert.match(html, /data-work-ids="work:one work:two"/);
  assert.match(html, /工作记录 · 1 项进行中、1 项已结束/);
});

test('a new draft never persists, never changes the URL and never claims a user selection', () => {
  const source = initializeReview.toString();
  const draft = source.slice(source.indexOf('function openNewWorkDraft'), source.indexOf('function closeWorkPanel'));
  assert.ok(draft.length > 500, 'the draft opener is present');
  assert.equal(draft.includes('postJson'), false);
  assert.equal(draft.includes('fetch('), false);
  assert.match(draft, /function openNewWorkDraft/);
  assert.equal(draft.includes('setWorkQuery'), false, 'opening a draft leaves ?work= alone');
  assert.match(draft, /还没有写入状态/);
  // No previous work is picked by recency to pre-fill the draft's upper layer,
  // selection or resume: the server resolves those, and a gap stays visible.
  assert.equal(draft.includes('previous?.'), false, 'the draft opener does not read a previous work');
  assert.equal(draft.includes('.sort('), false, 'nothing is ordered by "most recent"');
  assert.match(draft, /selection: null,/);
  assert.match(draft, /upper: null,/);
  assert.match(draft, /upperResolved: null,/);
  // A save in flight is never abandoned by opening a new draft.
  assert.match(draft, /refuseWhileSaving\(\)/);
  // Any edit drops a preview made from previous values.
  const activity = source.slice(source.indexOf('function onWorkFormActivity'), source.indexOf('function field('));
  assert.match(activity, /invalidateWorkPreview/);
  assert.ok(source.includes("workPanel?.addEventListener('input', onWorkFormActivity)"));
  // The write content uses only the sources the server accepts.
  const build = source.slice(source.indexOf('function buildWorkContent'), source.indexOf('function setWorkPhase'));
  assert.equal(build.includes("'live_review'"), false);
  assert.match(build, /'agent_organized'/);
  assert.match(build, /'user_note'/);
  assert.match(build, /selectionKind/);
  assert.match(build, /agent_proposed_unselected/);
});

test('a truncated or unreadable work index is never reported as the empty state', () => {
  const empty = nodeWorkCoverage(nodeWorkCounts([]), {});
  assert.equal(empty.state, 'empty');
  assert.equal(empty.text, '本功能尚无已保存的工作记录');

  const saved = nodeWorkCoverage({ active: 1, paused: 1, ended: 1, total: 3 }, {});
  assert.equal(saved.state, 'saved');
  assert.match(saved.text, /已保存 3 条/);
  assert.match(saved.text, /1 项进行中、1 项已暂停、1 项已结束/);

  // A truncated index with nothing loaded for this Feature names the gap, not "无记录".
  const truncated = nodeWorkCoverage(nodeWorkCounts([]), { truncated: true, omitted: 4 });
  assert.equal(truncated.state, 'truncated');
  assert.match(truncated.text, /索引已截断/);
  assert.match(truncated.text, /不能据此判定没有保存过工作/);
  assert.equal(truncated.text.includes('本功能尚无已保存的工作记录'), false);

  // A loaded-but-truncated list is labelled as partial, never as complete.
  const partial = nodeWorkCoverage({ active: 1, paused: 0, ended: 0, total: 1 }, { truncated: true, omitted: 2 });
  assert.equal(partial.state, 'saved');
  assert.match(partial.text, /（已加载部分）/);

  const unavailable = nodeWorkCoverage(nodeWorkCounts([]), { supported: false });
  assert.equal(unavailable.state, 'unavailable');
  assert.match(unavailable.text, /读取能力缺口/);
});

test('typing the end reason and note survives a re-render, and the caret is restored', () => {
  const source = initializeReview.toString();
  const capture = source.slice(source.indexOf('function captureWorkDraft'), source.indexOf('function restoreWorkFocus'));
  // The end fields are typed into the same form, so the draft keeps them; else a
  // phase re-render would show the saved reason while submitting the typed one.
  assert.match(capture, /endedReason: typed\.endedReason/);
  assert.match(capture, /endedNote: typed\.endedNote/);
  // A re-render replaces the field element, so the caret/selection is restored
  // explicitly rather than only re-focusing.
  const restore = source.slice(source.indexOf('function restoreWorkFocus'), source.indexOf('function openWorkDetail'));
  assert.match(restore, /setSelectionRange/);
  assert.match(restore, /focusRange/);
  const activity = source.slice(source.indexOf('function onWorkFormActivity'), source.indexOf('function field('));
  assert.match(activity, /workView\.focusRange/);
  assert.match(activity, /selectionStart/);
});

test('a preview, save or status read only applies to the work view that started it', () => {
  const source = initializeReview.toString();
  const cut = (from, until) => {
    const start = source.indexOf(`function ${from}`);
    const stop = source.indexOf(`function ${until}`, start + 5);
    return start >= 0 && stop > start ? source.slice(start, stop) : '';
  };
  const preview = cut('previewWorkSave', 'saveWork');
  assert.match(preview, /const token = workRequestToken\(view\)/);
  assert.match(preview, /workRequestCurrent\(token\)/);
  const save = cut('saveWork', 'readWorkStatus');
  assert.match(save, /const token = workRequestToken\(view\)/);
  assert.match(save, /workRequestCurrent\(token\)/);
  const status = cut('readWorkStatus', 'openWorkHistory');
  assert.match(status, /const token = workRequestToken\(view\)/);
  assert.match(status, /workRequestCurrent\(token\)/);
  // A save without a body (or a 5xx) does not prove the commit was skipped: the
  // status route is read instead of declaring a plain failure.
  assert.match(save, /保存请求没有拿到可核对的结果/);
  assert.match(save, /await readWorkStatus\(\)/);
});

test('a save in flight blocks closing, switching, and going back so the operationId is kept', () => {
  const source = initializeReview.toString();
  for (const name of ['openWorkUri', 'openNewWorkDraft', 'closeWorkPanel', 'backToNow', 'openWorkHistory']) {
    const start = source.indexOf(`function ${name}`);
    const next = source.indexOf('function ', start + 5);
    const body = start >= 0 ? source.slice(start, next === -1 ? undefined : next) : '';
    assert.ok(body, `${name} is present`);
    assert.match(body, /refuseWhileSaving|workOutcomePending/, `${name} refuses while a save outcome is pending`);
  }
  // The guard blocks both a saving phase and an independent status read.
  const pending = source.slice(source.indexOf('function workOutcomePending'), source.indexOf('function refuseWhileSaving'));
  assert.match(pending, /'saving'/);
  assert.match(pending, /'status'/);
});

test('a delayed save read-back never rewrites a later work view (a new draft stays editable)', () => {
  const source = initializeReview.toString();
  const after = source.slice(source.indexOf('async function afterWorkWrite'), source.indexOf('function refreshNodeWorkSection'));
  const boundary = after.indexOf('await refreshState(');
  assert.ok(boundary > 0, 'afterWorkWrite re-reads the state');
  const head = after.slice(0, boundary);
  const tail = after.slice(boundary);
  // The view this save belongs to is captured before any await ...
  assert.match(head, /const savedView = workView;/);
  // ... and the read-back itself must not repaint the work panel: a state read
  // lands while the human may be typing in a draft, and rebuilding the panel
  // would throw away its form element, focus and caret.
  assert.match(tail, /await refreshState\(\{ quiet: true, restore: false, workPanel: false \}\)/);
  // The same-view update is still guarded, so the data of a later view is never
  // overwritten with the saved work's projection.
  const guarded = tail.slice(0, tail.indexOf('refreshNodeWorkSection'));
  assert.match(guarded, /if \(shown && workView && workView === savedView\) \{/);
  assert.match(guarded, /workView\.records = workHistoryRecords/);
  assert.match(guarded, /workView\.work = workProjectionFor/);
  assert.match(guarded, /renderWorkPanel\(\)/);
  // Nothing after the guard assigns the work view again.
  assert.equal(/workView\.(records|work|draft|mode|phase) =/.test(tail.slice(tail.indexOf('refreshNodeWorkSection'))), false);
  // The global state refresh and the node work block still run for every view,
  // and the review form is still not rebuilt.
  assert.match(tail, /refreshNodeWorkSection\(\)/);
  assert.equal(after.includes('restorePanel('), false, 'the review panel is not rebuilt');
});

test('a directory repaint can skip the work panel, and a state read passes that through', () => {
  const source = initializeReview.toString();
  const cut = (name) => {
    const start = source.indexOf(`function ${name}`);
    const stop = source.indexOf('\n  function ', start + 10);
    return start >= 0 && stop > start ? source.slice(start, stop) : '';
  };
  // renderDirectoryHosts paints the directory hosts and the roadmap, and only
  // repaints the work panel unless the caller opts out.
  const directory = cut('renderDirectoryHosts');
  assert.match(directory, /function renderDirectoryHosts\(options = \{\}\)/);
  assert.match(directory, /if \(options\.workPanel !== false\) renderWorkPanel\(\)/);
  assert.match(directory, /else refreshNodeWorkSection\(\)/);
  assert.match(directory, /renderRoadmapHosts\(\)/);
  assert.match(directory, /renderCurrentRoadmapPanel\(\)/);
  // applyServerState -> fetchState -> refreshState pass the same option through,
  // so a state read can refresh the shared state without touching the work panel.
  const apply = cut('applyServerState');
  assert.match(apply, /function applyServerState\(body, options = \{\}\)/);
  assert.match(apply, /renderDirectoryHosts\(\{ workPanel: options\.workPanel !== false \}\)/);
  const fetch = cut('fetchState');
  assert.match(fetch, /applyServerState\(await readServerState\(\), options\)/);
  const refresh = cut('refreshState');
  assert.match(refresh, /fetchState\(\{ workPanel: options\.workPanel \}\)/);
  // Every other caller keeps the old behaviour: the default repaints the panel.
  assert.equal(/renderDirectoryHosts\(\)/.test(source), true, 'the default call site still repaints the work panel');
});

test('a work save updates state without rebuilding the review form element', () => {
  const source = initializeReview.toString();
  const after = source.slice(source.indexOf('async function afterWorkWrite'), source.indexOf('function refreshNodeWorkSection'));
  // The review panel/form must keep its element identity, values and URL.
  assert.match(after, /refreshState\(\{ quiet: true, restore: false, workPanel: false \}\)/);
  assert.equal(after.includes('restorePanel('), false, 'the review panel is not rebuilt');
  // Only the work block inside an open node panel is replaced in place.
  const refreshNode = source.slice(source.indexOf('function refreshNodeWorkSection'), source.indexOf('function ', source.indexOf('function refreshNodeWorkSection') + 10));
  assert.match(refreshNode, /replaceWith/);
  assert.match(refreshNode, /workSection\(\)/);
});