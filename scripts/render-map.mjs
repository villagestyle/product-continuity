#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGraphLayout } from './graph-layout.mjs';
import { graphStyles, initializeGraph, renderGraphShell } from './graph-view.mjs';
import { deriveNodeIntentSummary, digestValue, getIntentContent } from './intent-model.mjs';
import { deriveFeatureProgress, featureContextFingerprintContent, getFeatureProgressBrowserSource } from './feature-progress.mjs';
import { deriveRoadmap } from './roadmap-model.mjs';
import { featureProgressCardLines, featureProgressSummaryMap, initializeStaticRoadmap, renderFeatureProgressDetail, renderRoadmapDetail, renderRoadmapFilters, renderRoadmapIndex, roadmapStyles } from './roadmap-ui.mjs';
import { validateStateReferences } from './validate-state.mjs';

const edgeLabels = {
  contains: 'contains',
  serves: 'serves',
  enables: 'enables',
  constrains: 'constrains',
  implemented_by: 'implemented by',
  verified_by: 'verified by',
  depends_on: 'depends on',
  supersedes: 'supersedes',
  conflicts_with: 'conflicts with',
  derived_from: 'derived from',
  part_of: 'part of',
};

const kindLabels = {
  product_goal: 'Goals',
  user_group: 'User groups',
  user_task: 'User tasks',
  capability: 'Capabilities',
  behavior_commitment: 'Behavior commitments',
  business_object: 'Business objects',
  implementation: 'Implementation',
  verification: 'Verification',
  unknown: 'Unknowns',
};

const statusLabels = {
  candidate: 'Candidate',
  confirmed: 'Human-confirmed intent',
  observed: 'Observed evidence',
  unknown: 'Unknown',
  retired: 'Retired',
};

const validationLabels = {
  not_applicable: 'Not applicable',
  not_run: 'Not run',
  defined_only: 'Test defined; execution not recorded',
  passed: 'Passed',
  failed: 'Failed',
  observed: 'Runtime observed',
};

const uiLabels = {
  'zh-CN': {
    lang: 'zh-CN', title: '产品地图', subtitle: '人工意图、实现证据与验证结果分别呈现。',
    scope: '范围', baseline: '基线', stateVersion: '状态版本', nodes: '个节点', relations: '个关系', checks: '次检查',
    search: '搜索地图', searchPlaceholder: '任务、承诺、证据……', statusField: '状态', allStatuses: '所有状态',
    nodeType: '节点类型', allNodeTypes: '所有类型', reset: '重置筛选', tree: '层级关系', treeNote: '仅使用 contains / part_of',
    hierarchyNotes: '层级关系说明', crossLinks: '跨节点关系显示在节点详情中，不会被强行纳入层级树。',
    decisions: '产品决定', noDecisions: '尚无产品决定记录。', conditions: '条件', linkedDecision: '关联决定',
    relationships: '关联关系', evidence: '证据', noEvidence: '未关联证据。', coverage: '任务实现与验证覆盖',
    tasks: '用户任务', implementationCoverage: '关联实现', verificationCoverage: '关联验证',
    confirmedCommitments: '人工确认的行为承诺', candidateCommitments: '候选行为承诺', unrunTests: '未运行的测试定义',
    runtimeObservations: '运行时观察记录', recentCheck: '最近检查', noChecks: '尚无变更检查记录。',
    noFindings: '未记录发现。', findings: '项发现', checkScope: '范围', checkCoverage: '覆盖说明',
    noNodes: '尚无产品地图节点。请在项目状态中添加有证据支持的节点后重新生成。',
    footer: '当前展示的是保存的状态快照。此页面不查询或推断运行时遥测。',
    kind: {
      product_goal: '产品目标', user_group: '用户群体', user_task: '用户任务', capability: '产品能力',
      behavior_commitment: '行为承诺', business_object: '业务对象', implementation: '实现证据',
      verification: '验证证据', unknown: '待确认事项',
    },
    statuses: {
      candidate: '候选理解', confirmed: '人工已确认', observed: '已观察', unknown: '未知', retired: '已废止',
      proposed: '待确认提案', superseded: '已被替代', rejected: '已拒绝', withdrawn: '已撤回',
      defined_only: '仅定义测试', not_run: '未运行', passed: '通过', failed: '失败',
      insufficient_evidence: '证据不足', existing_discrepancy: '现存差异', potential_mismatch: '可能不一致',
      no_supported_behavior_change: '无证据支持行为变化', consistent_with_confirmed_intent: '符合已确认意图',
      proposed_evolution: '建议的产品演进',
    },
    validation: {
      not_applicable: '不适用', not_run: '未运行', defined_only: '仅定义，未记录执行',
      passed: '通过', failed: '失败', observed: '运行时已观察',
    },
    edge: {
      contains: '包含', serves: '服务于', enables: '支持', constrains: '约束', implemented_by: '由其实现',
      verified_by: '由其验证', depends_on: '依赖', supersedes: '替代', conflicts_with: '与之冲突',
      derived_from: '来源于', part_of: '属于',
    },
    relatedBy: '关联类型', evidenceFallback: '未记录',
    intent: {
      heading: '意图', current: '现行意图', history: '历史意图',
      allConfirmed: (x, y) => `本节点已记录的现行意图 ${x}/${y} 已确认；不包括标题、其它节点或未提取内容。`,
      partiallyConfirmed: (x, y) => `部分已确认 ${x}/${y}。`,
      candidatesOnly: (x, y) => `候选 ${x}/${y}。`,
      noActive: '暂无现行意图 / 尚未建立意图。',
      retired: '无现行意图；已记录停止决定，仍展示历史。',
      legacyRetired: '历史已退出（0.1），未生成新的停止决定。',
      historyCounts: (superseded, retired, dismissed) => `历史已替代 ${superseded} · 已停止 ${retired} · 已撤回 ${dismissed}`,
      statement: '声明', scope: '适用范围', conditions: '条件', exceptions: '例外',
      noScope: '未记录适用范围', noConditions: '未记录条件', noExceptions: '未记录例外',
      noConditionsNote: '未记录不等于无条件适用。',
      origin: '来源', created: '创建时间', assessment: '准备判断', governing: '现行决定', retiredBy: '停止决定',
      openProposal: '待处理修改提案', replacement: '拟议完整内容', rationale: '修改理由',
      supersedes: '替代', supersededBy: '被以下意图替代',
      legacyPending: '0.1 已确认，尚未对齐到当前意图', legacyDecision: '旧决定',
      legacyBinding: (count) => `该 0.1 决定绑定 ${count} 个节点`,
      legacyEvidence: '来源证据',
      unclassified: '未归类材料（历史备注）', unclassifiedNote: '这些节点材料未自动升级为意图条件。',
      claimStatuses: { candidate: '候选', confirmed: '已确认', superseded: '已被替代', retired: '已停止', dismissed: '已撤回' },
      proposalStatuses: { open: '待处理', accepted: '已接受', rejected: '已拒绝', expired: '已过期' },
      dispositions: { unreviewed: '未审阅', single: '可独立决定', needs_split: '需要拆分' },
      origins: { onboarding: '首次建图', migration: '迁移', review: '评审', conversation: '会话采集' },
      decisionKinds: { adopt_intent: '采纳意图', stop_intent: '停止意图' },
      coverageTitle: '意图确认与验证覆盖', totalConfirmed: '现行意图确认', partialNodes: '部分确认节点数',
      implementationLinks: '实现证据连接', testDefinitions: '测试定义', testExecutions: '测试执行记录', runtimeObservations: '运行时观察记录',
      noClaims: '尚无意图记录。', decisionHistory: '产品决定（含 0.1 历史）', proposalList: '修改提案',
      legacyPendingCount: (count) => `${count} 条 0.1 旧决定待对齐`,
    },
    selfParenting: (id) => `已忽略自引用层级关系：${id}`,
    multipleParents: (id) => `${id} 存在多个层级父节点；树中仅使用第一条关系。`,
    graph: {
      title: '产品关系图谱', readOnly: '只读快照 · 节点位置不代表新增层级',
      navigation: '可缩放图谱画布', zoomTools: '画布缩放', zoomIn: '放大', zoomOut: '缩小', zoomLevel: '缩放比例',
      fit: '适应全图', overview: '分层总览', expandAll: '全部展开', expand: '展开分支', collapse: '收起分支',
      fullscreen: '全屏', exitFullscreen: '退出全屏', fullscreenEntered: '画布已全屏，按 Esc 或退出全屏按钮返回。',
      fullscreenFallback: '系统全屏暂不可用，已铺满当前窗口；按 Esc 或退出全屏按钮返回。',
      fullscreenLeft: '已退出画布全屏，保留缩放和位置。', fullscreenExitFailed: '未能退出系统全屏，请按 Esc 或使用浏览器的退出全屏控件。',
      panTools: '画布平移', pan: ['向左查看', '向上查看', '向下查看', '向右查看'], minimap: '图谱缩略图，可点击定位；也可使用平移按钮',
      hierarchy: '层级关系', crossLinks: '显示交叉关系',
      help: '拖动空白或节点平移 · 轻点节点查看 · 滚轮或双指缩放 · 方向键平移，+/− 缩放，0 适应全图 · Tab 选择节点 · Alt+Enter 转到详情',
      details: '节点详情', selectHint: '点击节点查看关系、条件与证据',
      detailsButton: '详情', closeDetails: '关闭详情', detailsDescription: '说明', detailsProgress: '进度详情',
      detailsRelationships: '关联关系', detailsNoRelationships: '暂无关联关系',
      snapshotNote: '图中“已观察”可能仅指静态证据；测试定义不等于测试通过。此画布不会修改项目状态。',
      layoutWarning: '存在循环、自引用或多个父节点，部分关系未用于排布；全部原始关系仍保留。',
      matches: '项匹配', nodes: '个可见节点', folded: '个节点已收起', noMatches: '没有匹配节点，请调整或重置筛选。',
      noNodes: '当前状态还没有节点。请添加有证据支持的地图节点后重新生成。',
      graphView: '画布', listView: '文本列表', observations: '覆盖、检查与产品决定',
    },
  },
  en: {
    lang: 'en', title: 'Product map', subtitle: 'Human intent, implementation evidence, and validation remain separate.',
    scope: 'Scope', baseline: 'Baseline', stateVersion: 'State version', nodes: 'nodes', relations: 'relations', checks: 'checks',
    search: 'Search map', searchPlaceholder: 'Task, commitment, evidence...', statusField: 'Status', allStatuses: 'All statuses',
    nodeType: 'Node type', allNodeTypes: 'All node types', reset: 'Reset filters', tree: 'Hierarchy', treeNote: 'contains / part_of only',
    hierarchyNotes: 'Hierarchy notes', crossLinks: 'Cross-cutting relationships are listed on node details, not forced into the hierarchy.',
    decisions: 'Product decisions', noDecisions: 'No product decisions recorded.', conditions: 'Conditions', linkedDecision: 'Linked decision',
    relationships: 'Relationships', evidence: 'Evidence', noEvidence: 'No evidence linked.', coverage: 'Task implementation and validation coverage',
    tasks: 'User tasks', implementationCoverage: 'Linked to implementation', verificationCoverage: 'Linked to verification',
    confirmedCommitments: 'Human-confirmed behavior commitments', candidateCommitments: 'Candidate behavior commitments', unrunTests: 'Unrun test definitions',
    runtimeObservations: 'Runtime observation records', recentCheck: 'Latest check', noChecks: 'No change checks recorded.',
    noFindings: 'No findings recorded.', findings: 'findings', checkScope: 'Scope', checkCoverage: 'Coverage note',
    noNodes: 'No product map nodes recorded. Add evidence-backed nodes to the project state, then render again.',
    footer: 'Showing the saved state snapshot. This page does not query or infer runtime telemetry.',
    kind: kindLabels,
    statuses: {
      ...statusLabels, proposed: 'Proposed', superseded: 'Superseded', rejected: 'Rejected', withdrawn: 'Withdrawn',
      defined_only: 'Test defined only', not_run: 'Not run', passed: 'Passed', failed: 'Failed',
      insufficient_evidence: 'Insufficient evidence', existing_discrepancy: 'Existing discrepancy', potential_mismatch: 'Potential mismatch',
      no_supported_behavior_change: 'No supported behavior change', consistent_with_confirmed_intent: 'Consistent with confirmed intent',
      proposed_evolution: 'Proposed product evolution',
    },
    validation: validationLabels, edge: edgeLabels, relatedBy: 'related by', evidenceFallback: 'Not recorded',
    intent: {
      heading: 'Intent', current: 'Current intent', history: 'Intent history',
      allConfirmed: (x, y) => `Recorded current intent ${x}/${y} confirmed; excludes titles, other nodes, and unextracted material.`,
      partiallyConfirmed: (x, y) => `Partially confirmed ${x}/${y}.`,
      candidatesOnly: (x, y) => `Candidates ${x}/${y}.`,
      noActive: 'No current intent / intent not established.',
      retired: 'No current intent; a stop decision is recorded and history remains visible.',
      legacyRetired: 'Retired in 0.1 history; no new stop decision was generated.',
      historyCounts: (superseded, retired, dismissed) => `History: superseded ${superseded} · retired ${retired} · dismissed ${dismissed}`,
      statement: 'Statement', scope: 'Scope', conditions: 'Conditions', exceptions: 'Exceptions',
      noScope: 'Scope not recorded', noConditions: 'Conditions not recorded', noExceptions: 'Exceptions not recorded',
      noConditionsNote: 'Not recorded does not mean unconditionally applicable.',
      origin: 'Origin', created: 'Created', assessment: 'Preparation', governing: 'Governing decision', retiredBy: 'Stop decision',
      openProposal: 'Open edit proposal', replacement: 'Proposed full content', rationale: 'Rationale',
      supersedes: 'Supersedes', supersededBy: 'Superseded by',
      legacyPending: '0.1 confirmed; not yet aligned to current intent', legacyDecision: 'Legacy decision',
      legacyBinding: (count) => `This 0.1 decision is bound to ${count} node(s)`,
      legacyEvidence: 'Source evidence',
      unclassified: 'Unclassified historical material', unclassifiedNote: 'This node-level material was not promoted to intent conditions.',
      claimStatuses: { candidate: 'Candidate', confirmed: 'Confirmed', superseded: 'Superseded', retired: 'Retired', dismissed: 'Dismissed' },
      proposalStatuses: { open: 'Open', accepted: 'Accepted', rejected: 'Rejected', expired: 'Expired' },
      dispositions: { unreviewed: 'Unreviewed', single: 'Independently decidable', needs_split: 'Needs split' },
      origins: { onboarding: 'Onboarding', migration: 'Migration', review: 'Review', conversation: 'Conversation capture' },
      decisionKinds: { adopt_intent: 'Adopt intent', stop_intent: 'Stop intent' },
      coverageTitle: 'Intent confirmation and validation coverage', totalConfirmed: 'Current intent confirmed', partialNodes: 'Partially confirmed nodes',
      implementationLinks: 'Implementation evidence links', testDefinitions: 'Test definitions', testExecutions: 'Test executions', runtimeObservations: 'Runtime observations',
      noClaims: 'No intent recorded.', decisionHistory: 'Product decisions (including 0.1 history)', proposalList: 'Edit proposals',
      legacyPendingCount: (count) => `${count} legacy 0.1 decision(s) awaiting alignment`,
    },
    selfParenting: (id) => `Self-parenting relation ignored: ${id}`,
    multipleParents: (id) => `Multiple hierarchy parents for ${id}; only the first relation is used in the tree.`,
    graph: {
      title: 'Product relationship graph', readOnly: 'Read-only snapshot · placement does not create hierarchy',
      navigation: 'Zoomable graph canvas', zoomTools: 'Canvas zoom', zoomIn: 'Zoom in', zoomOut: 'Zoom out', zoomLevel: 'Zoom level',
      fit: 'Fit graph', overview: 'Outline', expandAll: 'Expand all', expand: 'Expand branch', collapse: 'Collapse branch',
      fullscreen: 'Fullscreen', exitFullscreen: 'Exit fullscreen', fullscreenEntered: 'Canvas is fullscreen. Press Esc or Exit fullscreen to return.',
      fullscreenFallback: 'Browser fullscreen is unavailable. Canvas fills this window; press Esc or Exit fullscreen to return.',
      fullscreenLeft: 'Left canvas fullscreen. Zoom and position are preserved.', fullscreenExitFailed: 'Could not leave fullscreen. Press Esc or use the browser fullscreen control.',
      panTools: 'Pan canvas', pan: ['Look left', 'Look up', 'Look down', 'Look right'], minimap: 'Graph overview. Click to navigate, or use the pan buttons.',
      hierarchy: 'Hierarchy', crossLinks: 'Show cross-links',
      help: 'Drag background or nodes to pan · Click a node to inspect · Wheel or pinch to zoom · Arrow keys to pan, +/− to zoom, 0 to fit · Tab to select nodes · Alt+Enter for details',
      details: 'Node details', selectHint: 'Select a node to see relationships, conditions, and evidence',
      detailsButton: 'Details', closeDetails: 'Close details', detailsDescription: 'Description', detailsProgress: 'Progress details',
      detailsRelationships: 'Relationships', detailsNoRelationships: 'No related nodes.',
      snapshotNote: 'Observed may refer to static evidence only; a test definition is not a passing test. This canvas does not change project state.',
      layoutWarning: 'Cycles, self-links, or multiple parents were excluded from placement. All original relationships remain available.',
      matches: 'matches', nodes: 'visible nodes', folded: 'nodes folded', noMatches: 'No matching nodes. Adjust or reset the filters.',
      noNodes: 'No nodes recorded. Add evidence-backed map nodes and render again.',
      graphView: 'Canvas', listView: 'Text list', observations: 'Coverage, checks, and product decisions',
    },
  },
};

const hierarchicalKinds = new Set(['contains', 'part_of']);

function nodeAnchor(id) {
  return `node-${Array.from(new TextEncoder().encode(id), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function text(value, fallback = 'Not recorded') {
  return escapeHtml(value || fallback);
}

function buildHierarchy(nodes, edges, labels) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parentByChild = new Map();
  const childrenByParent = new Map();
  const conflicts = [];

  for (const edge of edges) {
    if (!hierarchicalKinds.has(edge.kind)) continue;
    const parentId = edge.kind === 'contains' ? edge.from : edge.to;
    const childId = edge.kind === 'contains' ? edge.to : edge.from;
    if (parentId === childId) {
      conflicts.push(labels.selfParenting(edge.id));
      continue;
    }
    if (parentByChild.has(childId)) {
      conflicts.push(labels.multipleParents(childId));
      continue;
    }
    parentByChild.set(childId, parentId);
    const children = childrenByParent.get(parentId) ?? [];
    children.push(childId);
    childrenByParent.set(parentId, children);
  }

  const roots = nodes
    .filter((node) => !parentByChild.has(node.id))
    .map((node) => node.id);
  const rendered = new Set();

  function renderNode(nodeId, ancestors = new Set()) {
    const node = byId.get(nodeId);
    if (!node || ancestors.has(nodeId) || rendered.has(nodeId)) return '';
    rendered.add(nodeId);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(nodeId);
    const children = (childrenByParent.get(nodeId) ?? [])
      .map((id) => renderNode(id, nextAncestors))
      .filter(Boolean);
    const childList = children.length ? `<ul>${children.join('')}</ul>` : '';
    return `<li>${nodeSummary(node, labels)}${childList}</li>`;
  }

  const rootItems = roots.map((id) => renderNode(id)).filter(Boolean);
  const unplaced = nodes
    .filter((node) => !rendered.has(node.id))
    .map((node) => renderNode(node.id))
    .filter(Boolean);
  if (unplaced.length) rootItems.push(...unplaced);

  return {
    html: rootItems.length ? `<ul class="tree">${rootItems.join('')}</ul>` : `<p class="empty">${escapeHtml(labels.noNodes)}</p>`,
    conflicts,
  };
}

function nodeSummary(node, labels) {
  const status = node.statusLabel ?? labels.statuses[node.status] ?? node.status;
  return `<a class="tree-node" href="#${nodeAnchor(node.id)}"><span>${text(node.label)}</span><span class="badge" data-status="${escapeHtml(node.status)}">${escapeHtml(status)}</span></a>`;
}

function renderNodeCard(node, { evidenceById, nodesById, decisionsById, edgesByNode, labels }) {
  const nodeEvidence = node.evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean);
  const evidence = node.evidenceIds
    .map((id) => evidenceById.get(id))
    .filter(Boolean)
    .map((item) => `<li><strong>${text(item.kind.replaceAll('_', ' '))}:</strong> ${text(item.claim)}<br><span class="muted">${text(item.revision, labels.evidenceFallback)} · ${text(item.path, labels.evidenceFallback)} ${item.locator ? `· ${text(item.locator)}` : ''} · ${escapeHtml(labels.validation[item.validation] ?? item.validation)}</span></li>`)
    .join('');
  const related = edgesByNode.get(node.id) ?? [];
  const relationItems = related.map((edge) => {
    const isFrom = edge.from === node.id;
    const other = nodesById.get(isFrom ? edge.to : edge.from);
    if (!other) return '';
    const direction = isFrom ? labels.edge[edge.kind] ?? edge.kind : `${labels.relatedBy} ${labels.edge[edge.kind] ?? edge.kind}`;
    return `<li><a href="#${nodeAnchor(other.id)}">${text(other.label)}</a> <span class="muted">${escapeHtml(direction)}</span></li>`;
  }).join('');
  const decision = node.decisionId ? decisionsById.get(node.decisionId) : undefined;
  const conditions = (node.conditions ?? []).map((condition) => `<li>${text(condition)}</li>`).join('');
  const status = labels.statuses[node.status] ?? node.status;
  const searchable = [
    node.label,
    node.description,
    node.id,
    ...nodeEvidence.flatMap((item) => [item.claim, item.path, item.locator]),
    decision?.statement,
    ...related.map((edge) => nodesById.get(edge.from === node.id ? edge.to : edge.from)?.label),
  ].filter(Boolean).join(' ').toLocaleLowerCase();

  return `<article class="node" id="${nodeAnchor(node.id)}" data-kind="${escapeHtml(node.kind)}" data-status="${escapeHtml(node.status)}" data-search="${escapeHtml(searchable)}">
    <header><div><div class="eyebrow">${escapeHtml(labels.kind[node.kind] ?? node.kind)}</div><h3>${text(node.label)}</h3></div><span class="badge" data-status="${escapeHtml(node.status)}">${escapeHtml(status)}</span></header>
    <code class="node-id">${text(node.id)}</code>
    ${node.description ? `<p>${text(node.description)}</p>` : ''}
    ${conditions ? `<details><summary>${escapeHtml(labels.conditions)} (${node.conditions.length})</summary><ul>${conditions}</ul></details>` : ''}
    ${decision ? `<p class="decision"><strong>${escapeHtml(labels.linkedDecision)}:</strong> ${text(decision.statement)} <span class="muted">(${escapeHtml(labels.statuses[decision.status] ?? decision.status)})</span></p>` : ''}
    ${relationItems ? `<details><summary>${escapeHtml(labels.relationships)} (${related.length})</summary><ul>${relationItems}</ul></details>` : ''}
    ${evidence ? `<details><summary>${escapeHtml(labels.evidence)} (${node.evidenceIds.length})</summary><ul>${evidence}</ul></details>` : `<p class="muted">${escapeHtml(labels.noEvidence)}</p>`}
  </article>`;
}

export function renderMap(state, language = 'zh-CN') {
  if (state?.schemaVersion === '0.2') return renderMap02(state, language);
  const labels = uiLabels[language] ?? uiLabels['zh-CN'];
  const nodes = state.nodes;
  const edges = state.edges;
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const evidenceById = new Map(state.evidence.map((item) => [item.id, item]));
  const decisionsById = new Map(state.decisions.map((item) => [item.id, item]));
  const edgesByNode = new Map();
  for (const edge of edges) {
    for (const id of [edge.from, edge.to]) {
      const list = edgesByNode.get(id) ?? [];
      list.push(edge);
      edgesByNode.set(id, list);
    }
  }

  const hierarchy = buildHierarchy(nodes, edges, labels);
  const taskNodes = nodes.filter((node) => node.kind === 'user_task');
  const hierarchyChildren = new Map();
  for (const edge of edges) {
    if (!hierarchicalKinds.has(edge.kind)) continue;
    const parentId = edge.kind === 'contains' ? edge.from : edge.to;
    const childId = edge.kind === 'contains' ? edge.to : edge.from;
    const children = hierarchyChildren.get(parentId) ?? [];
    children.push(childId);
    hierarchyChildren.set(parentId, children);
  }
  const taskCoverage = new Map(taskNodes.map((task) => [task.id, { implementation: false, verification: false }]));
  for (const task of taskNodes) {
    const descendants = new Set([task.id]);
    const pending = [task.id];
    while (pending.length) {
      const parentId = pending.pop();
      for (const childId of hierarchyChildren.get(parentId) ?? []) {
        if (descendants.has(childId)) continue;
        descendants.add(childId);
        pending.push(childId);
      }
    }
    for (const edge of edges) {
      if (!descendants.has(edge.from)) continue;
      const relatedNode = nodesById.get(edge.to);
      if (edge.kind === 'implemented_by' && relatedNode?.kind === 'implementation') {
        taskCoverage.get(task.id).implementation = true;
      }
      if (edge.kind === 'verified_by' && relatedNode?.kind === 'verification') {
        taskCoverage.get(task.id).verification = true;
      }
    }
  }
  const tasksWithImplementation = [...taskCoverage.values()].filter((item) => item.implementation).length;
  const tasksWithVerification = [...taskCoverage.values()].filter((item) => item.verification).length;
  const confirmedCommitments = nodes.filter((node) => node.kind === 'behavior_commitment' && node.status === 'confirmed').length;
  const candidateCommitments = nodes.filter((node) => node.kind === 'behavior_commitment' && node.status === 'candidate').length;
  const unrunTests = state.evidence.filter((item) =>
    (item.kind === 'test_definition' && ['defined_only', 'not_run'].includes(item.validation)) ||
    (item.kind === 'test_execution' && item.validation === 'not_run'),
  ).length;
  const runtimeObservations = state.evidence.filter((item) => item.kind === 'runtime_observation').length;

  const groups = Object.entries(labels.kind).map(([kind, label]) => {
    const groupNodes = nodes.filter((node) => node.kind === kind);
    if (!groupNodes.length) return '';
    return `<section class="group" data-group="${escapeHtml(kind)}"><h2>${escapeHtml(label)} <span class="count">${groupNodes.length}</span></h2><div class="node-grid">${groupNodes.map((node) => renderNodeCard(node, { evidenceById, nodesById, decisionsById, edgesByNode, labels })).join('')}</div></section>`;
  }).join('');

  const decisions = state.decisions.length
    ? `<ul>${state.decisions.map((decision) => `<li><strong>${text(decision.statement)}</strong> <span class="badge" data-status="${escapeHtml(decision.status)}">${escapeHtml(labels.statuses[decision.status] ?? decision.status)}</span><span class="muted"> ${text(decision.applicability, labels.evidenceFallback)}</span></li>`).join('')}</ul>`
    : `<p class="muted">${escapeHtml(labels.noDecisions)}</p>`;
  const reviewNotes = hierarchy.conflicts.length
    ? `<aside class="notice"><strong>${escapeHtml(labels.hierarchyNotes)}</strong><ul>${hierarchy.conflicts.map((note) => `<li>${text(note)}</li>`).join('')}</ul>${escapeHtml(labels.crossLinks)}</aside>`
    : `<p class="muted">${escapeHtml(labels.crossLinks)}</p>`;
  const latestCheck = [...state.checks].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const latestCheckSummary = latestCheck
    ? `<p><strong>${text(latestCheck.id)}</strong> · ${text(latestCheck.createdAt)}</p><p>${escapeHtml(labels.checkScope)}: ${text(latestCheck.scope.description)}</p><p>${escapeHtml(labels.checkCoverage)}: ${text(latestCheck.scope.coverageNote)}</p><ul>${latestCheck.findings.map((finding) => `<li><span class="badge" data-status="${escapeHtml(finding.status)}">${escapeHtml(labels.statuses[finding.status] ?? finding.status)}</span> ${text(finding.summary)}</li>`).join('') || `<li>${escapeHtml(labels.noFindings)}</li>`}</ul>`
    : `<p class="muted">${escapeHtml(labels.noChecks)}</p>`;
  const observations = `<section><h2>${escapeHtml(labels.coverage)}</h2><ul><li>${escapeHtml(labels.tasks)}: ${taskNodes.length}</li><li>${escapeHtml(labels.implementationCoverage)}: ${tasksWithImplementation}/${taskNodes.length}</li><li>${escapeHtml(labels.verificationCoverage)}: ${tasksWithVerification}/${taskNodes.length}</li><li>${escapeHtml(labels.confirmedCommitments)}: ${confirmedCommitments}</li><li>${escapeHtml(labels.candidateCommitments)}: ${candidateCommitments}</li><li>${escapeHtml(labels.unrunTests)}: ${unrunTests}</li><li>${escapeHtml(labels.runtimeObservations)}: ${runtimeObservations}</li></ul></section><section><h2>${escapeHtml(labels.recentCheck)}</h2>${latestCheckSummary}<h2>${escapeHtml(labels.decisions)}</h2>${decisions}</section>`;
  const graphObservations = observations;
  const graphJson = JSON.stringify({
    labels: labels.graph,
    nodes: nodes.map((node) => ({
      id: node.id, label: node.label, kind: node.kind, status: node.status,
      description: node.description,
      anchor: nodeAnchor(node.id),
      kindLabel: labels.kind[node.kind] ?? node.kind,
      statusLabel: labels.statuses[node.status] ?? node.status,
    })),
    edges: edges.map((edge) => ({
      id: edge.id, from: edge.from, to: edge.to, kind: edge.kind,
      label: labels.edge[edge.kind] ?? edge.kind,
    })),
  }).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

  return `<!doctype html>
<html lang="${labels.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"><title>${text(state.project.name)} · ${escapeHtml(labels.title)}</title>
<style>
:root{color-scheme:light;--ink:#1d2928;--muted:#5d6d69;--line:#d8e0dc;--paper:#f3f6f4;--surface:#fff;--green:#246b54;--green-soft:#e5f1ea;--amber:#855c12;--amber-soft:#f7f0dc;--red:#9a4038;--red-soft:#f7e9e6;--blue:#315f86;--blue-soft:#e8f0f7;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink)}a{color:var(--green);text-decoration-thickness:1px;text-underline-offset:2px}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #2f6f96;outline-offset:2px}.shell{max-width:1180px;margin:auto;padding:1.25rem}.top{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;border-bottom:1px solid var(--line);padding-bottom:1rem}.top h1{font-size:1.45rem;line-height:1.25;margin:0}.subtitle{color:var(--muted);margin:.25rem 0 0}.meta{display:flex;flex-wrap:wrap;gap:.45rem;margin-top:.75rem}.meta span,.badge{display:inline-flex;align-items:center;min-height:1.55rem;padding:.12rem .45rem;border:1px solid var(--line);border-radius:4px;font-size:.76rem}.toolbar{display:flex;flex-wrap:wrap;gap:.55rem;margin:1rem 0;align-items:end}.field{display:grid;gap:.2rem;font-size:.78rem;color:var(--muted)}input,select,button{font:inherit;color:var(--ink);background:var(--surface);border:1px solid #aebcb6;border-radius:4px;min-height:42px;padding:.45rem .6rem}button{cursor:pointer}button:hover{background:#edf3ef}.summary{display:flex;gap:.45rem;flex-wrap:wrap}.summary .badge{background:var(--surface)}.columns{display:grid;grid-template-columns:minmax(270px,.82fr) minmax(0,1.65fr);gap:1rem;align-items:start}.panel{background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:.9rem;min-width:0}.panel h2{font-size:1rem;margin:0 0 .55rem}.tree,.tree ul{list-style:none;padding-left:1rem;margin:.25rem 0;border-left:1px solid var(--line)}.tree{padding-left:0;border:0}.tree li{margin:.3rem 0}.tree-node{display:flex;justify-content:space-between;align-items:start;gap:.4rem;padding:.36rem .42rem;border-radius:4px;background:#f8faf8;text-decoration:none;color:var(--ink)}.tree-node:hover{background:var(--green-soft)}.tree-node .badge{flex:0 0 auto}.group{margin:0 0 1rem;scroll-margin-top:1rem}.group>h2{font-size:1rem;margin:0 0 .5rem;border-bottom:1px solid var(--line);padding-bottom:.35rem}.count{font-size:.78rem;color:var(--muted);font-weight:400}.node-grid{display:grid;gap:.55rem}.node{border:1px solid var(--line);border-radius:5px;padding:.75rem;scroll-margin-top:1rem;background:var(--surface)}.node[hidden],.group[hidden]{display:none}.node header{display:flex;justify-content:space-between;align-items:flex-start;gap:.6rem}.node h3{font-size:.93rem;margin:0;line-height:1.35}.eyebrow,.muted,.node-id{font-size:.75rem;color:var(--muted)}.eyebrow{text-transform:uppercase}.node-id{display:block;margin-top:.25rem;overflow-wrap:anywhere}.node p{margin:.5rem 0 0;font-size:.87rem}.badge[data-status=confirmed],.badge[data-status=passed],.badge[data-status=observed]{background:var(--green-soft);color:var(--green);border-color:#b8d3c2}.badge[data-status=candidate],.badge[data-status=proposed],.badge[data-status=defined_only],.badge[data-status=not_run]{background:var(--amber-soft);color:var(--amber);border-color:#e7d8a8}.badge[data-status=unknown],.badge[data-status=insufficient_evidence],.badge[data-status=potential_mismatch],.badge[data-status=existing_discrepancy]{background:var(--red-soft);color:var(--red);border-color:#e8c2bd}.badge[data-status=failed],.badge[data-status=rejected],.badge[data-status=retired],.badge[data-status=superseded]{background:#edf0ef;color:#485652}.badge[data-status=not_applicable]{background:var(--blue-soft);color:var(--blue)}details{margin-top:.5rem}summary{cursor:pointer;color:var(--green);font-size:.81rem}details ul,.panel ul{padding-left:1.15rem;margin:.4rem 0 0}details li,.panel li{margin:.38rem 0;font-size:.82rem}.notice{border-left:3px solid var(--amber);background:var(--amber-soft);padding:.65rem;margin-top:.6rem;font-size:.82rem}.empty{color:var(--muted)}.footer{color:var(--muted);font-size:.77rem;margin:1rem 0}.tree-count{font-size:.8rem;color:var(--muted);font-weight:400}@media(max-width:820px){.columns{grid-template-columns:1fr}.tree-panel{position:static}}@media(max-width:520px){.shell{padding:.8rem}.top{display:block}.toolbar>*{flex:1 1 100%}.summary{margin-top:.7rem}}
${graphStyles}
</style></head><body><main class="shell"><header class="top"><div><h1>${text(state.project.name)} · ${escapeHtml(labels.title)}</h1><p class="subtitle">${escapeHtml(labels.subtitle)}</p><div class="meta"><span>${escapeHtml(labels.scope)}: ${text(state.project.scopeDescription, labels.evidenceFallback)}</span><span>${escapeHtml(labels.baseline)}: ${text(state.activeBaselineId)}</span><span>${escapeHtml(labels.stateVersion)} ${escapeHtml(state.stateVersion)}</span></div></div><div class="summary" aria-label="Map counts"><span class="badge">${nodes.length} ${escapeHtml(labels.nodes)}</span><span class="badge">${edges.length} ${escapeHtml(labels.relations)}</span><span class="badge">${state.checks.length} ${escapeHtml(labels.checks)}</span></div></header>
<section class="toolbar" aria-label="Map filters"><label class="field">${escapeHtml(labels.search)}<input id="search" type="search" placeholder="${escapeHtml(labels.searchPlaceholder)}"></label><label class="field">${escapeHtml(labels.statusField)}<select id="status"><option value="">${escapeHtml(labels.allStatuses)}</option>${Object.entries(statusLabels).map(([key]) => `<option value="${escapeHtml(key)}">${escapeHtml(labels.statuses[key] ?? key)}</option>`).join('')}</select></label><label class="field">${escapeHtml(labels.nodeType)}<select id="kind"><option value="">${escapeHtml(labels.allNodeTypes)}</option>${Object.entries(labels.kind).map(([key, label]) => `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`).join('')}</select></label><button id="reset" type="button">${escapeHtml(labels.reset)}</button><div id="view-controls" class="view-controls" hidden aria-label="${escapeHtml(labels.title)}"><button type="button" data-view="graph" aria-pressed="false">${escapeHtml(labels.graph.graphView)}</button><button type="button" data-view="list" aria-pressed="true">${escapeHtml(labels.graph.listView)}</button></div></section>
${renderGraphShell(labels)}
<details id="graph-observations" class="graph-supplement" hidden><summary>${escapeHtml(labels.graph.observations)}</summary><div class="graph-observations">${graphObservations}</div></details>
<div class="columns" id="list-view"><aside class="panel tree-panel"><h2>${escapeHtml(labels.tree)} <span class="tree-count">${escapeHtml(labels.treeNote)}</span></h2>${hierarchy.html}${reviewNotes}<div class="graph-observations">${observations}</div></aside><section aria-label="${escapeHtml(labels.nodes)}">${groups || `<p class="panel empty">${escapeHtml(labels.noNodes)}</p>`}<p class="footer">${escapeHtml(labels.footer)}</p></section></div></main>
<script>window.__productContinuityGraph = (${initializeGraph.toString()})(${graphJson}, ${buildGraphLayout.toString()});</script></body></html>`;
}

function anchorFor(prefix, id) {
  return `${prefix}-${Array.from(new TextEncoder().encode(id), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function claimAnchor(id) {
  return anchorFor('claim', id);
}

function decisionAnchor(id) {
  return anchorFor('decision', id);
}

function proposalAnchor(id) {
  return anchorFor('proposal', id);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function intentSummaryShort(summary, labels) {
  if (!summary.intentCapable) return labels.statuses[summary.status] ?? summary.status;
  const base = labels.statuses[summary.status] ?? summary.status;
  return summary.y > 0 ? `${base} ${summary.x}/${summary.y}` : base;
}

function intentSummaryText(summary, labels) {
  switch (summary.reason) {
    case 'all_active_confirmed':
      return labels.allConfirmed(summary.x, summary.y);
    case 'partially_confirmed':
      return labels.partiallyConfirmed(summary.x, summary.y);
    case 'candidates_only':
      return labels.candidatesOnly(summary.x, summary.y);
    case 'retired_terminal':
      return labels.retired;
    case 'legacy_retired':
      return labels.legacyRetired;
    case 'no_active':
    default:
      return labels.noActive;
  }
}

function renderIntentContent(content, labels, fallback = 'Not recorded') {
  let value;
  try {
    value = getIntentContent(content);
  } catch {
    value = { statement: '', scope: [], conditions: [], exceptions: [] };
  }
  const list = (items, empty) => (items.length
    ? `<ul class="intent-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : `<p class="muted">${escapeHtml(empty)}</p>`);
  return `<div class="intent-content"><p class="intent-statement">${value.statement ? escapeHtml(value.statement) : `<span class="muted">${escapeHtml(fallback)}</span>`}</p><dl class="intent-fields">
    <dt>${escapeHtml(labels.scope)}</dt><dd>${list(value.scope, labels.noScope)}</dd>
    <dt>${escapeHtml(labels.conditions)}</dt><dd>${list(value.conditions, labels.noConditions)}${value.conditions.length === 0 ? `<p class="muted">${escapeHtml(labels.noConditionsNote)}</p>` : ''}</dd>
    <dt>${escapeHtml(labels.exceptions)}</dt><dd>${list(value.exceptions, labels.noExceptions)}</dd>
  </dl></div>`;
}

function renderClaimLinks(ids, claimsById, labels) {
  return ids.map((id) => `<a href="#${claimAnchor(id)}">${escapeHtml(claimsById.get(id)?.statement ?? id)}</a>`).join('、');
}

function renderClaim02(claim, context) {
  const { labels, claimsById, decisionsById, proposalsByTarget } = context;
  const intent = labels.intent;
  const statusLabel = intent.claimStatuses[claim.status] ?? claim.status;
  const assessment = claim.assessment ?? {};
  const disposition = intent.dispositions[assessment.disposition] ?? assessment.disposition ?? '—';
  const origin = intent.origins[claim.origin] ?? claim.origin ?? '—';
  const governing = claim.governingDecisionId ? decisionsById.get(claim.governingDecisionId) : undefined;
  const retiredBy = claim.retiredByDecisionId ? decisionsById.get(claim.retiredByDecisionId) : undefined;
  const proposal = claim.status === 'confirmed' ? proposalsByTarget.get(claim.id) : undefined;
  const predecessors = asArray(claim.supersedesClaimIds);
  const successors = asArray(claim.supersededByClaimIds);
  const capture = context.conversationCaptures.find((c) => c.id === claim.conversationSource?.captureId);
  const item = capture?.items?.[claim.conversationSource?.itemIndex];
  const sourceLabel = item ? ({ user_statement: '用户原话 / User quotation', assistant_suggestion: '助手建议 / Assistant suggestion', assistant_report: '助手报告（未验证） / Unverified assistant report' }[item.basis]) : '';

  return `<article class="claim" id="${claimAnchor(claim.id)}" data-status="${escapeHtml(claim.status)}">
    <header class="claim-head"><span class="badge" data-status="${escapeHtml(claim.status)}">${escapeHtml(statusLabel)}</span><code>${escapeHtml(claim.id)}</code></header>
    ${renderIntentContent(claim, intent)}
    <p class="muted">${escapeHtml(intent.origin)}: ${escapeHtml(origin)} · ${escapeHtml(intent.created)}: ${text(claim.createdAt)} · ${escapeHtml(intent.assessment)}: ${escapeHtml(disposition)}</p>
    ${item ? `<details class="conversation-source"><summary>${escapeHtml(sourceLabel)}</summary><blockquote>${escapeHtml(item.source.quote)}</blockquote><p class="muted">${escapeHtml(item.source.sessionId)} / ${escapeHtml(item.source.messageId)}</p>${item.conflictsWithClaimIds.length ? `<p>${escapeHtml(item.conflictsWithClaimIds.join(', '))}</p>` : ''}</details>` : ''}
    ${governing ? `<p class="claim-link">${escapeHtml(intent.governing)}: <a href="#${decisionAnchor(governing.id)}">${escapeHtml(governing.id)}</a></p>` : ''}
    ${retiredBy ? `<p class="claim-link">${escapeHtml(intent.retiredBy)}: <a href="#${decisionAnchor(retiredBy.id)}">${escapeHtml(retiredBy.id)}</a></p>` : ''}
    ${predecessors.length ? `<p class="muted">${escapeHtml(intent.supersedes)}: ${renderClaimLinks(predecessors, claimsById, labels)}</p>` : ''}
    ${successors.length ? `<p class="muted">${escapeHtml(intent.supersededBy)}: ${renderClaimLinks(successors, claimsById, labels)}</p>` : ''}
    ${proposal ? `<details class="proposal" id="${proposalAnchor(proposal.id)}"><summary>${escapeHtml(intent.openProposal)} (${escapeHtml(proposal.id)})</summary>${renderIntentContent(proposal.replacement, intent)}<p class="muted">${escapeHtml(intent.rationale)}: ${text(proposal.rationale)}</p></details>` : ''}
  </article>`;
}

function renderLegacyDecision02(node, context) {
  const { labels, decisionsById, evidenceById, bindingNodeIdsByDecision } = context;
  const legacyDecisionId = node.legacy?.snapshot?.decisionId;
  if (!legacyDecisionId) return '';
  const decision = decisionsById.get(legacyDecisionId);
  if (!decision) {
    return `<section class="legacy-decision"><h4>${escapeHtml(labels.intent.legacyDecision)}</h4><p class="muted">${escapeHtml(String(legacyDecisionId))}</p></section>`;
  }
  const intent = labels.intent;
  const status = labels.statuses[decision.status] ?? decision.status;
  const bindings = bindingNodeIdsByDecision.get(decision.id) ?? [];
  const evidence = asArray(decision.evidenceIds)
    .map((id) => evidenceById.get(id))
    .filter(Boolean)
    .map((item) => `<li><strong>${escapeHtml(item.kind.replaceAll('_', ' '))}:</strong> ${escapeHtml(item.claim)}</li>`)
    .join('');
  const pending = decision.recordVersion !== '0.2' && decision.status === 'confirmed';
  return `<section class="legacy-decision" data-status="${escapeHtml(decision.status)}">
    <h4>${escapeHtml(intent.legacyDecision)}${pending ? ` · <span class="badge" data-status="candidate">${escapeHtml(intent.legacyPending)}</span>` : ''}</h4>
    <p><strong>${escapeHtml(decision.statement)}</strong> <span class="badge" data-status="${escapeHtml(decision.status)}">${escapeHtml(status)}</span></p>
    <p class="muted">${escapeHtml(decision.applicability)}</p>
    <p class="muted">${text(decision.confirmedAt, labels.evidenceFallback)} · ${text(decision.confirmedBy, labels.evidenceFallback)} · ${escapeHtml(intent.legacyBinding(bindings.length))}</p>
    ${evidence ? `<ul>${evidence}</ul>` : ''}
  </section>`;
}

function renderNodeCard02(node, context) {
  const { labels, evidenceById, nodesById, decisionsById, edgesByNode, summaryByNode, claimsByNode } = context;
  const intent = labels.intent;
  const summary = summaryByNode.get(node.id);
  const nodeClaims = claimsByNode.get(node.id) ?? [];
  const activeClaims = nodeClaims.filter((claim) => claim.status === 'candidate' || claim.status === 'confirmed');
  const historicalClaims = nodeClaims.filter((claim) => ['superseded', 'retired', 'dismissed'].includes(claim.status));
  const nodeEvidence = asArray(node.evidenceIds).map((id) => evidenceById.get(id)).filter(Boolean);
  const conversationNotes = context.conversationCaptures.flatMap((capture) => asArray(capture.items))
    .filter((item) => item.nodeId === node.id && item.kind === 'note')
    .map((item) => `<details class="conversation-source"><summary>${escapeHtml(({user_statement:'用户备注 / User note', assistant_suggestion:'助手建议备注 / Assistant suggestion note', assistant_report:'助手报告（未经执行验证） / Unverified assistant report'})[item.basis])}</summary><p>${escapeHtml(item.statement)}</p><blockquote>${escapeHtml(item.source.quote)}</blockquote><p class="muted">${escapeHtml(item.source.role)} · ${escapeHtml(item.source.sessionId)} / ${escapeHtml(item.source.messageId)}</p>${item.conflictsWithClaimIds.length ? `<p>${escapeHtml(item.conflictsWithClaimIds.join(', '))}</p>` : ''}</details>`).join('');
  const evidence = asArray(node.evidenceIds)
    .map((id) => evidenceById.get(id))
    .filter(Boolean)
    .map((item) => `<li><strong>${text(item.kind.replaceAll('_', ' '))}:</strong> ${text(item.claim)}<br><span class="muted">${text(item.revision, labels.evidenceFallback)} · ${text(item.path, labels.evidenceFallback)} ${item.locator ? `· ${text(item.locator)}` : ''} · ${escapeHtml(labels.validation[item.validation] ?? item.validation)}</span></li>`)
    .join('');
  const related = edgesByNode.get(node.id) ?? [];
  const relationItems = related.map((edge) => {
    const isFrom = edge.from === node.id;
    const other = nodesById.get(isFrom ? edge.to : edge.from);
    if (!other) return '';
    const direction = isFrom ? labels.edge[edge.kind] ?? edge.kind : `${labels.relatedBy} ${labels.edge[edge.kind] ?? edge.kind}`;
    return `<li><a href="#${nodeAnchor(other.id)}">${text(other.label)}</a> <span class="muted">${escapeHtml(direction)}</span></li>`;
  }).join('');
  const conditions = asArray(node.conditions).length
    ? `<details><summary>${escapeHtml(intent.unclassified)} (${node.conditions.length})</summary><p class="muted">${escapeHtml(intent.unclassifiedNote)}</p><ul>${node.conditions.map((condition) => `<li>${text(condition)}</li>`).join('')}</ul></details>`
    : '';
  const legacyDecision = renderLegacyDecision02(node, context);
  const status = labels.statuses[node.status] ?? node.status;
  const summaryText = summary ? intentSummaryText(summary, intent) : '';
  const historyText = summary
    ? intent.historyCounts(summary.counts.superseded, summary.counts.retired, summary.counts.dismissed)
    : '';
  const featureProgress = node.kind === 'capability' ? context.featureProgressByNode?.get(node.id) : null;
  const progressLines = featureProgress ? featureProgressCardLines(featureProgress) : null;
  const searchable = [
    node.label,
    node.description,
    node.id,
    ...nodeEvidence.flatMap((item) => [item.claim, item.path, item.locator]),
    ...nodeClaims.flatMap((claim) => [claim.statement, claim.id, ...asArray(claim.scope), ...asArray(claim.conditions), ...asArray(claim.exceptions)]),
    decisionsById.get(node.legacy?.snapshot?.decisionId)?.statement,
    ...related.map((edge) => nodesById.get(edge.from === node.id ? edge.to : edge.from)?.label),
  ].filter(Boolean).join(' ').toLocaleLowerCase();

  return `<article class="node" id="${nodeAnchor(node.id)}" data-kind="${escapeHtml(node.kind)}" data-status="${escapeHtml(node.status)}" data-search="${escapeHtml(searchable)}">
    <header><div><div class="eyebrow">${escapeHtml(labels.kind[node.kind] ?? node.kind)}</div><h3>${text(node.label)}</h3></div><span class="badge" data-status="${escapeHtml(node.status)}">${escapeHtml(status)}</span></header>
    <code class="node-id">${text(node.id)}</code>
    ${node.description ? `<p>${text(node.description)}</p>` : ''}
    <p class="intent-summary">${escapeHtml(summaryText)}</p>
    ${progressLines ? `<p class="node-progress" data-testid="node-feature-progress" aria-label="${escapeHtml(progressLines.aria)}">${progressLines.delivery ? `<span class="delivery-badge" data-testid="node-feature-delivery" data-delivery="${escapeHtml(progressLines.delivery.status)}" data-needs-review="${progressLines.delivery.needsReview ? 'true' : 'false'}" title="${escapeHtml(progressLines.delivery.title)}">${escapeHtml(progressLines.delivery.text)}</span>` : ''}<span>${escapeHtml(progressLines.line1)}</span><span class="node-progress-next">${escapeHtml(progressLines.line2)}</span></p>` : ''}
    ${summary && (summary.counts.superseded || summary.counts.retired || summary.counts.dismissed) ? `<p class="muted">${escapeHtml(historyText)}</p>` : ''}
    ${activeClaims.length ? `<section class="claim-list" aria-label="${escapeHtml(intent.current)}">${activeClaims.map((claim) => renderClaim02(claim, context)).join('')}</section>` : `<p class="muted">${escapeHtml(intent.noClaims)}</p>`}
    ${historicalClaims.length ? `<details class="claim-history"><summary>${escapeHtml(intent.history)} (${historicalClaims.length})</summary><div class="claim-list">${historicalClaims.map((claim) => renderClaim02(claim, context)).join('')}</div></details>` : ''}
    ${legacyDecision}
    ${conditions}
    ${conversationNotes}
    ${relationItems ? `<details><summary>${escapeHtml(labels.relationships)} (${related.length})</summary><ul>${relationItems}</ul></details>` : ''}
    ${evidence ? `<details><summary>${escapeHtml(labels.evidence)} (${node.evidenceIds.length})</summary><ul>${evidence}</ul></details>` : `<p class="muted">${escapeHtml(labels.noEvidence)}</p>`}
  </article>`;
}

function renderDecision02(decision, context, anchors = true) {
  const { labels, decisionsById, claimsById, reviewsById, evidenceById } = context;
  const intent = labels.intent;
  const idAttribute = anchors ? ` id="${decisionAnchor(decision.id)}"` : '';
  if (decision.recordVersion === '0.2') {
    const kindLabel = intent.decisionKinds[decision.kind] ?? decision.kind;
    const statusLabel = labels.statuses[decision.status] ?? decision.status;
    const supersedes = asArray(decision.supersedesDecisionIds)
      .map((id) => `<a href="#${decisionAnchor(id)}">${escapeHtml(id)}</a>`)
      .join('、');
    return `<li class="decision"${idAttribute} data-kind="${escapeHtml(decision.kind)}">
      <div class="decision-head"><strong>${escapeHtml(kindLabel)}</strong> <span class="badge" data-status="${escapeHtml(decision.status)}">${escapeHtml(statusLabel)}</span> <code>${escapeHtml(decision.id)}</code></div>
      ${renderIntentContent(decision.intent, intent)}
      <p class="muted">${escapeHtml(decision.applicability)}</p>
      <p class="muted">review: ${escapeHtml(decision.reviewId)} · ${escapeHtml(intent.created)}: ${text(decision.createdAt)} · ${text(decision.confirmedAt)} · ${text(decision.confirmedBy)}</p>
      ${supersedes ? `<p class="muted">${escapeHtml(intent.supersedes)}: ${supersedes}</p>` : ''}
    </li>`;
  }
  const statusLabel = labels.statuses[decision.status] ?? decision.status;
  const pending = decision.status === 'confirmed';
  const evidence = asArray(decision.evidenceIds)
    .map((id) => evidenceById.get(id))
    .filter(Boolean)
    .map((item) => `<li>${escapeHtml(item.claim)}</li>`)
    .join('');
  return `<li class="decision legacy-decision"${idAttribute} data-kind="legacy">
    <div class="decision-head"><strong>${text(decision.statement)}</strong> <span class="badge" data-status="${escapeHtml(decision.status)}">${escapeHtml(statusLabel)}</span> <code>${escapeHtml(decision.id)}</code></div>
    <p class="muted">${text(decision.applicability)}</p>
    <p class="muted">recordVersion 0.1 · ${text(decision.confirmedAt)} · ${text(decision.confirmedBy)}</p>
    ${pending ? `<p class="notice">${escapeHtml(intent.legacyPending)}</p>` : ''}
    ${evidence ? `<ul>${evidence}</ul>` : ''}
  </li>`;
}

function renderCoverage02(state, context) {
  const { labels, displayNodes, summaryByNode, decisionsById } = context;
  const intent = labels.intent;
  const intentNodes = displayNodes.filter((node) => summaryByNode.get(node.id)?.intentCapable);
  const totalX = intentNodes.reduce((sum, node) => sum + summaryByNode.get(node.id).x, 0);
  const totalY = intentNodes.reduce((sum, node) => sum + summaryByNode.get(node.id).y, 0);
  const partialNodes = intentNodes.filter((node) => summaryByNode.get(node.id).reason === 'partially_confirmed').length;
  const implementationLinks = asArray(state.edges).filter((edge) => edge.kind === 'implemented_by').length;
  const testDefinitions = asArray(state.evidence).filter((item) => item.kind === 'test_definition').length;
  const testExecutions = asArray(state.evidence).filter((item) => item.kind === 'test_execution').length;
  const runtimeObservations = asArray(state.evidence).filter((item) => item.kind === 'runtime_observation').length;
  const legacyPending = asArray(state.decisions).filter((decision) => decision.recordVersion !== '0.2' && decision.status === 'confirmed').length;
  const coverageValue = totalY > 0 ? `${totalX}/${totalY}` : intent.noActive;
  return `<section><h2>${escapeHtml(intent.coverageTitle)}</h2><ul>
    <li>${escapeHtml(intent.totalConfirmed)}: ${escapeHtml(coverageValue)}</li>
    <li>${escapeHtml(intent.partialNodes)}: ${partialNodes}</li>
    <li>${escapeHtml(intent.implementationLinks)}: ${implementationLinks}</li>
    <li>${escapeHtml(intent.testDefinitions)}: ${testDefinitions}</li>
    <li>${escapeHtml(intent.testExecutions)}: ${testExecutions}</li>
    <li>${escapeHtml(intent.runtimeObservations)}: ${runtimeObservations}</li>
    <li>${escapeHtml(intent.legacyPendingCount(legacyPending))}</li>
  </ul></section>`;
}

const pageStyles02 = `
:root{color-scheme:light;--ink:#1d2928;--muted:#5d6d69;--line:#d8e0dc;--paper:#f3f6f4;--surface:#fff;--green:#246b54;--green-soft:#e5f1ea;--amber:#855c12;--amber-soft:#f7f0dc;--red:#9a4038;--red-soft:#f7e9e6;--blue:#315f86;--blue-soft:#e8f0f7;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink)}a{color:var(--green);text-decoration-thickness:1px;text-underline-offset:2px}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #2f6f96;outline-offset:2px}
.shell{max-width:1180px;margin:auto;padding:1.25rem}.top{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;border-bottom:1px solid var(--line);padding-bottom:1rem}.top h1{font-size:1.45rem;line-height:1.25;margin:0}.subtitle{color:var(--muted);margin:.25rem 0 0}.meta{display:flex;flex-wrap:wrap;gap:.45rem;margin-top:.75rem}.meta span,.badge{display:inline-flex;align-items:center;min-height:1.55rem;padding:.12rem .45rem;border:1px solid var(--line);border-radius:4px;font-size:.76rem}.toolbar{display:flex;flex-wrap:wrap;gap:.55rem;margin:1rem 0;align-items:end}.field{display:grid;gap:.2rem;font-size:.78rem;color:var(--muted)}input,select,button{font:inherit;color:var(--ink);background:var(--surface);border:1px solid #aebcb6;border-radius:4px;min-height:42px;padding:.45rem .6rem}button{cursor:pointer}button:hover{background:#edf3ef}
.summary{display:flex;gap:.45rem;flex-wrap:wrap}.summary .badge{background:var(--surface)}.columns{display:grid;grid-template-columns:minmax(270px,.82fr) minmax(0,1.65fr);gap:1rem;align-items:start}.panel{background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:.9rem;min-width:0}.panel h2{font-size:1rem;margin:0 0 .55rem}
.tree,.tree ul{list-style:none;padding-left:1rem;margin:.25rem 0;border-left:1px solid var(--line)}.tree{padding-left:0;border:0}.tree li{margin:.3rem 0}.tree-node{display:flex;justify-content:space-between;gap:.5rem;align-items:center;padding:.25rem .35rem;border-radius:4px;text-decoration:none;color:var(--ink)}.tree-node:hover{background:var(--green-soft)}.node-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:1rem}.group{margin-bottom:1.15rem}.group h2{font-size:1.05rem;margin:.25rem 0 .55rem}.count{color:var(--muted);font-weight:400}
.node{background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:.9rem;min-width:0}.node header{display:flex;justify-content:space-between;gap:.75rem;align-items:flex-start}.node h3{margin:.05rem 0 .2rem;font-size:1.02rem;line-height:1.35;overflow-wrap:anywhere}.eyebrow{color:var(--muted);font-size:.72rem;text-transform:uppercase;letter-spacing:.05em}.node-id{display:inline-block;max-width:100%;color:var(--muted);font-size:.75rem;overflow-wrap:anywhere}.intent-summary{margin:.5rem 0 .25rem;font-weight:600}.node-progress{margin:.2rem 0 .35rem;padding:.3rem .45rem;border:1px solid #d5e2db;border-radius:4px;background:#f7fbf9;font-size:.82rem;overflow-wrap:anywhere}.node-progress span{display:block}.node-progress .node-progress-next{color:#2f4f43}.claim-list{display:grid;gap:.6rem;margin:.55rem 0}.claim{border:1px solid var(--line);border-radius:5px;padding:.65rem;background:#fbfcfb;min-width:0}.claim-head{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}.claim-head code{overflow-wrap:anywhere}.intent-statement{margin:.35rem 0;white-space:pre-wrap;overflow-wrap:anywhere}.intent-fields{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.25rem .7rem;margin:.35rem 0}.intent-fields dt{font-weight:600}.intent-fields dd{margin:0;min-width:0}.intent-list{margin:0;padding-left:1.1rem}.intent-list li{overflow-wrap:anywhere}.muted{color:var(--muted)}.notice{background:var(--amber-soft);border:1px solid #dfc98f;border-radius:4px;padding:.35rem .5rem}.legacy-decision{margin:.6rem 0;border-left:3px solid var(--amber);padding:.2rem 0 .2rem .65rem}.legacy-decision h4{margin:.15rem 0 .35rem}.proposal{margin-top:.5rem;border-top:1px dashed var(--line);padding-top:.45rem}.decision{padding:.65rem 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.decision:last-child{border-bottom:0}.decision-head{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}.badge[data-status="confirmed"]{background:var(--green-soft);border-color:#b9d8c9}.badge[data-status="candidate"]{background:var(--amber-soft);border-color:#dfc98f}.badge[data-status="retired"],.badge[data-status="dismissed"]{background:var(--red-soft);border-color:#e2bdb6}.badge[data-status="superseded"]{background:var(--blue-soft);border-color:#bfd2e2}
.footer{color:var(--muted);font-size:.8rem}.empty{color:var(--muted)}.graph-supplement{margin:1rem 0}.graph-observations{display:grid;gap:.75rem}.graph-observations ul{margin:.25rem 0;padding-left:1.1rem}.view-controls{display:flex;gap:.35rem}.view-controls button[aria-pressed="true"]{background:var(--green-soft);border-color:#9cc6b2}
@media (max-width:900px){.columns{grid-template-columns:minmax(0,1fr)}.top{flex-direction:column}}@media (max-width:420px){.shell{padding:.7rem}.intent-fields{grid-template-columns:minmax(0,1fr)}.intent-fields dt{margin-top:.25rem}}
`;

export function renderMap02(state, language = 'zh-CN') {
  const labels = uiLabels[language] ?? uiLabels['zh-CN'];
  const intent = labels.intent;
  const nodes = asArray(state.nodes);
  const edges = asArray(state.edges);
  const evidence = asArray(state.evidence);
  const decisions = asArray(state.decisions);
  const claims = asArray(state.intentClaims);
  const proposals = asArray(state.proposals);
  const roadmap = deriveRoadmap(state);
  const roadmapByNode = new Map(roadmap.items.map((item) => [item.nodeId,item]));
  const featureProgress = deriveFeatureProgress(state, { includeRetired: true, digest: digestValue });
  const featureProgressByNode = new Map(featureProgress.features.map((feature) => [feature.nodeId, feature]));
  const featureProgressMap = featureProgressSummaryMap(featureProgress);
  const featureFingerprints = {};
  for (const node of nodes) {
    if (node.kind !== 'capability') continue;
    const content = featureContextFingerprintContent(state, node.id);
    if (content) featureFingerprints[node.id] = digestValue(content);
  }
  const reviews = asArray(state.reviews);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const decisionsById = new Map(decisions.map((item) => [item.id, item]));
  const claimsById = new Map(claims.map((item) => [item.id, item]));
  const reviewsById = new Map(reviews.map((item) => [item.id, item]));
  const proposalsByTarget = new Map(
    proposals.filter((proposal) => proposal.status === 'open').map((proposal) => [proposal.targetClaimId, proposal]),
  );
  const summaryByNode = new Map(nodes.map((node) => [node.id, deriveNodeIntentSummary(node, claims)]));
  const displayNodes = nodes.map((node) => ({
    ...node,
    status: summaryByNode.get(node.id)?.status ?? node.status,
    statusLabel: summaryByNode.get(node.id) ? intentSummaryShort(summaryByNode.get(node.id), labels) : undefined,
  }));
  const displayNodesById = new Map(displayNodes.map((node) => [node.id, node]));
  const claimsByNode = new Map();
  for (const claim of claims) {
    const list = claimsByNode.get(claim.nodeId) ?? [];
    list.push(claim);
    claimsByNode.set(claim.nodeId, list);
  }
  const bindingNodeIdsByDecision = new Map();
  for (const node of nodes) {
    const decisionId = node.legacy?.snapshot?.decisionId;
    if (!decisionId) continue;
    const list = bindingNodeIdsByDecision.get(decisionId) ?? [];
    list.push(node.id);
    bindingNodeIdsByDecision.set(decisionId, list);
  }
  const edgesByNode = new Map();
  for (const edge of edges) {
    for (const id of [edge.from, edge.to]) {
      const list = edgesByNode.get(id) ?? [];
      list.push(edge);
      edgesByNode.set(id, list);
    }
  }

  const hierarchy = buildHierarchy(displayNodes, edges, labels);
  const context = {
    labels, displayNodes, nodesById: displayNodesById, evidenceById, decisionsById, claimsById, reviewsById,
    proposalsByTarget, summaryByNode, claimsByNode, edgesByNode, bindingNodeIdsByDecision,
    featureProgressByNode, featureProgressMap,
    conversationCaptures: asArray(state.conversationCaptures),
  };
  const groups = Object.entries(labels.kind).map(([kind, label]) => {
    const groupNodes = displayNodes.filter((node) => node.kind === kind);
    if (!groupNodes.length) return '';
    return `<section class="group" data-group="${escapeHtml(kind)}"><h2>${escapeHtml(label)} <span class="count">${groupNodes.length}</span></h2><div class="node-grid">${groupNodes.map((node) => renderNodeCard02(node, context)).join('')}</div></section>`;
  }).join('');

  const renderDecisionList = (anchors) => (decisions.length
    ? `<ul>${decisions.map((decision) => renderDecision02(decision, context, anchors)).join('')}</ul>`
    : `<p class="muted">${escapeHtml(labels.noDecisions)}</p>`);
  const decisionsHtml = renderDecisionList(true);
  const decisionsHtmlUnanchored = renderDecisionList(false);
  const reviewNotes = hierarchy.conflicts.length
    ? `<aside class="notice"><strong>${escapeHtml(labels.hierarchyNotes)}</strong><ul>${hierarchy.conflicts.map((note) => `<li>${text(note)}</li>`).join('')}</ul>${escapeHtml(labels.crossLinks)}</aside>`
    : `<p class="muted">${escapeHtml(labels.crossLinks)}</p>`;
  const latestCheck = [...asArray(state.checks)].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
  const latestCheckSummary = latestCheck
    ? `<p><strong>${text(latestCheck.id)}</strong> · ${text(latestCheck.createdAt)}</p><p>${escapeHtml(labels.checkScope)}: ${text(latestCheck.scope.description)}</p><p>${escapeHtml(labels.checkCoverage)}: ${text(latestCheck.scope.coverageNote)}</p><ul>${latestCheck.findings.map((finding) => `<li><span class="badge" data-status="${escapeHtml(finding.status)}">${escapeHtml(labels.statuses[finding.status] ?? finding.status)}</span> ${text(finding.summary)}</li>`).join('') || `<li>${escapeHtml(labels.noFindings)}</li>`}</ul>`
    : `<p class="muted">${escapeHtml(labels.noChecks)}</p>`;
  const observations = `${renderCoverage02(state, context)}<section><h2>${escapeHtml(labels.recentCheck)}</h2>${latestCheckSummary}</section><section><h2>${escapeHtml(intent.decisionHistory)}</h2>${decisionsHtml}</section>`;
  const graphObservations = `${renderCoverage02(state, context)}<section><h2>${escapeHtml(labels.recentCheck)}</h2>${latestCheckSummary}</section><section><h2>${escapeHtml(intent.decisionHistory)}</h2>${decisionsHtmlUnanchored}</section>`;
  const graphJson = JSON.stringify({
    labels: labels.graph,
    nodes: displayNodes.map((node) => ({
      id: node.id, label: node.label, kind: node.kind, status: node.status,
      description: node.description,
      anchor: nodeAnchor(node.id),
      kindLabel: labels.kind[node.kind] ?? node.kind,
      statusLabel: node.statusLabel ?? labels.statuses[node.status] ?? node.status,
      roadmapLabel: roadmapByNode.has(node.id) ? `规划 ${roadmapByNode.get(node.id).horizon} · ${roadmapByNode.get(node.id).status}` : undefined,
      ...(node.kind === 'capability' && featureProgressByNode.has(node.id)
        ? (() => {
          const lines = featureProgressCardLines(featureProgressByNode.get(node.id));
          return { progressLine: lines.line1, progressNext: lines.line2, progressDetail: lines.aria, delivery: lines.delivery };
        })()
        : {}),
    })),
    edges: edges.map((edge) => ({
      id: edge.id, from: edge.from, to: edge.to, kind: edge.kind,
      label: labels.edge[edge.kind] ?? edge.kind,
    })),
  }).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

  return `<!doctype html>
<html lang="${labels.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"><title>${text(state.project.name)} · ${escapeHtml(labels.title)}</title>
<style>
${pageStyles02}
${graphStyles}
${roadmapStyles}
</style></head><body><main class="shell"><header class="top"><div><h1>${text(state.project.name)} · ${escapeHtml(labels.title)}</h1><p class="subtitle">${escapeHtml(labels.subtitle)}</p><div class="meta"><span>${escapeHtml(labels.scope)}: ${text(state.project.scopeDescription, labels.evidenceFallback)}</span><span>${escapeHtml(labels.baseline)}: ${text(state.activeBaselineId)}</span><span>${escapeHtml(labels.stateVersion)} ${escapeHtml(state.stateVersion)}</span><span>schema 0.2</span></div></div><div class="summary" aria-label="Map counts"><span class="badge">${nodes.length} ${escapeHtml(labels.nodes)}</span><span class="badge">${edges.length} ${escapeHtml(labels.relations)}</span><span class="badge">${claims.length} ${escapeHtml(intent.heading)}</span><span class="badge">${decisions.length} ${escapeHtml(labels.decisions)}</span></div></header>
<section class="toolbar" aria-label="Map filters"><label class="field">${escapeHtml(labels.search)}<input id="search" type="search" placeholder="${escapeHtml(labels.searchPlaceholder)}"></label><label class="field">${escapeHtml(labels.statusField)}<select id="status"><option value="">${escapeHtml(labels.allStatuses)}</option>${Object.entries(statusLabels).map(([key]) => `<option value="${escapeHtml(key)}">${escapeHtml(labels.statuses[key] ?? key)}</option>`).join('')}</select></label><label class="field">${escapeHtml(labels.nodeType)}<select id="kind"><option value="">${escapeHtml(labels.allNodeTypes)}</option>${Object.entries(labels.kind).map(([key, label]) => `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`).join('')}</select></label><button id="reset" type="button">${escapeHtml(labels.reset)}</button><div id="view-controls" class="view-controls" hidden aria-label="${escapeHtml(labels.title)}"><button type="button" data-view="graph" aria-pressed="false">${escapeHtml(labels.graph.graphView)}</button><button type="button" data-view="list" aria-pressed="true">${escapeHtml(labels.graph.listView)}</button></div></section>
${renderGraphShell(labels,{roadmap:true})}
<section class="roadmap-directory" aria-labelledby="static-roadmap-heading"><h2 id="static-roadmap-heading">功能规划 · 只读快照</h2><p>规划位置不是开发授权；关闭不是实现或验证通过。编辑须另行授权离线命令。</p>${renderRoadmapFilters()}<div id="static-roadmap-list">${renderRoadmapIndex(roadmap, { progress: featureProgressMap })}</div></section>
<details id="graph-observations" class="graph-supplement" hidden><summary>${escapeHtml(labels.graph.observations)}</summary><div class="graph-observations">${graphObservations}</div></details>
<div class="columns" id="list-view"><aside class="panel tree-panel"><h2>${escapeHtml(labels.tree)} <span class="tree-count">${escapeHtml(labels.treeNote)}</span></h2>${hierarchy.html}${reviewNotes}<div class="graph-observations">${observations}</div></aside><section aria-label="${escapeHtml(labels.nodes)}">${groups || `<p class="panel empty">${escapeHtml(labels.noNodes)}</p>`}<p class="footer">${escapeHtml(labels.footer)}</p></section></div></main>
<script>window.__productContinuityGraph = (${initializeGraph.toString()})(${graphJson}, ${buildGraphLayout.toString()});
(${initializeStaticRoadmap.toString()})(${JSON.stringify(state).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029')}, {deriveRoadmap:${deriveRoadmap.toString()},renderRoadmapIndex:${renderRoadmapIndex.toString()},renderRoadmapFilters:${renderRoadmapFilters.toString()},renderRoadmapDetail:${renderRoadmapDetail.toString()},featureProgressApi:(${getFeatureProgressBrowserSource()}),featureProgressSummaryMap:${featureProgressSummaryMap.toString()},renderFeatureProgressDetail:${renderFeatureProgressDetail.toString()},featureFingerprints:${JSON.stringify(featureFingerprints).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029')}});</script></body></html>`;
}

async function main() {
  const args = process.argv.slice(2);
  const forceIndex = args.indexOf('--force');
  const force = forceIndex >= 0;
  if (force) args.splice(forceIndex, 1);
  const languageIndex = args.indexOf('--language');
  const language = languageIndex >= 0 ? args.splice(languageIndex, 2)[1] : 'zh-CN';
  const [statePath, outputPath] = args;
  if (!statePath || args.length > 2 || (languageIndex >= 0 && !['zh-CN', 'en'].includes(language))) {
    console.error('Usage: node scripts/render-map.mjs <project-state.json> [output.html] [--language zh-CN|en] [--force]');
    process.exitCode = 2;
    return;
  }

  let state;
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch (error) {
    console.error(`Cannot read state JSON: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (state?.schemaVersion !== '0.1' && state?.schemaVersion !== '0.2') {
    console.error(`Unsupported or missing schemaVersion: ${String(state?.schemaVersion)}`);
    process.exitCode = 2;
    return;
  }
  const referenceErrors = validateStateReferences(state);
  if (referenceErrors.length) {
    console.error(referenceErrors.map((error) => `- ${error}`).join('\n'));
    process.exitCode = 1;
    return;
  }

  const output = resolve(outputPath ?? resolve(dirname(resolve(statePath)), 'product-map.html'));
  try {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, renderMap(state, language), force ? 'utf8' : { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    console.error(`Cannot write ${output}: ${error.message}${error.code === 'EEXIST' ? ' (choose another path or pass --force to replace it)' : ''}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Product map written to ${output}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
