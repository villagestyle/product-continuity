// Synthetic inputs for independent host acceptance. No real product decisions.
export const ACCEPTANCE_TARGET = 'claim:acceptance-composite';
export const ACCEPTANCE_NODE = 'commitment:acceptance-content';
export const ACCEPTANCE_SCOPE = '本地合成工具验收中的新增记录';

export function makeAcceptanceState() {
  const time = '2026-11-11T00:00:00.000Z';
  return {
    schemaVersion: '0.2', stateVersion: 1,
    project: { id: 'project:tool-acceptance', name: '意图评审工具验收（合成数据）', roots: ['.'], scopeDescription: 'Synthetic tool verification only; no real product is authorized.' },
    activeBaselineId: 'baseline:acceptance',
    baselines: [{ id: 'baseline:acceptance', revision: { worktree: 'unknown', label: 'Synthetic acceptance fixture' }, scope: { description: 'Local tool behavior only', includedPaths: [], excludedPaths: [], coverageNote: 'No real repository was inspected or executed.' }, createdAt: time }],
    nodes: [
      { id: 'goal:acceptance', kind: 'product_goal', label: '管理合成记录', status: 'candidate', evidenceIds: [] },
      { id: 'task:acceptance', kind: 'user_task', label: '新增合成记录', status: 'candidate', evidenceIds: [] },
      { id: ACCEPTANCE_NODE, kind: 'behavior_commitment', label: '新增记录的内容限制', status: 'candidate', evidenceIds: ['evidence:acceptance-definition'] },
      { id: 'impl:acceptance', kind: 'implementation', label: '只读实现线索（合成）', status: 'observed', evidenceIds: ['evidence:acceptance-implementation'] },
      { id: 'verify:acceptance', kind: 'verification', label: '测试定义，未运行（合成）', status: 'observed', evidenceIds: ['evidence:acceptance-definition'] },
    ],
    edges: [
      { id: 'edge:acceptance-goal-task', from: 'goal:acceptance', kind: 'contains', to: 'task:acceptance' },
      { id: 'edge:acceptance-task-content', from: 'task:acceptance', kind: 'contains', to: ACCEPTANCE_NODE },
      { id: 'edge:acceptance-implementation', from: ACCEPTANCE_NODE, kind: 'implemented_by', to: 'impl:acceptance' },
      { id: 'edge:acceptance-definition', from: ACCEPTANCE_NODE, kind: 'verified_by', to: 'verify:acceptance' },
    ],
    evidence: [
      { id: 'evidence:acceptance-implementation', kind: 'implementation', claim: 'Synthetic location only; no implementation was inspected.', path: 'fixtures/record.mjs', validation: 'not_applicable' },
      { id: 'evidence:acceptance-definition', kind: 'test_definition', claim: 'Synthetic test reference; no product test was run.', path: 'fixtures/record.test.mjs', validation: 'defined_only' },
    ],
    decisions: [],
    intentClaims: [{
      id: ACCEPTANCE_TARGET, nodeId: ACCEPTANCE_NODE,
      statement: '新增记录内容不能为空且最多 500 字', scope: [], conditions: [], exceptions: [],
      status: 'candidate', origin: 'onboarding', createdAt: time, createdByReviewId: null,
      assessment: { disposition: 'unreviewed', contentDigest: null, reviewedLegacyContext: false, reviewId: null },
      governingDecisionId: null, retiredByDecisionId: null, supersedesClaimIds: [], supersededByClaimIds: [],
    }],
    proposals: [], reviews: [], checks: [],
  };
}

export function makeSplitItems() {
  return ['新增记录内容不能为空', '新增记录内容最多 500 字'].map((statement) => ({
    content: { statement, scope: [ACCEPTANCE_SCOPE], conditions: [], exceptions: [] },
    assessment: { disposition: 'single', reviewedLegacyContext: false },
  }));
}

export function assertEvidenceUnchanged(assert, before, after) {
  for (const evidence of before.evidence) assert.deepEqual(after.evidence.find((item) => item.id === evidence.id), evidence);
  const additions = after.evidence.filter((item) => !before.evidence.some((old) => old.id === item.id));
  assert.ok(additions.every((item) => item.kind === 'decision_record' && item.validation === 'not_applicable'));
  assert.equal(after.evidence.filter((item) => item.kind === 'test_execution').length, 0);
  assert.equal(after.evidence.filter((item) => item.kind === 'runtime_observation').length, 0);
  for (const field of ['edges', 'checks', 'baselines']) assert.deepEqual(after[field], before[field]);
  for (const node of before.nodes.filter((item) => item.id !== ACCEPTANCE_NODE)) assert.deepEqual(after.nodes.find((item) => item.id === node.id), node);
}
