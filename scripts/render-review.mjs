#!/usr/bin/env node

import { buildGraphLayout } from './graph-layout.mjs';
import { graphStyles, initializeGraph, renderGraphShell } from './graph-view.mjs';
import { deriveNodeIntentSummary, digestValue } from './intent-model.mjs';
import { deriveFeatureProgress, featureContextFingerprintContent, getFeatureProgressBrowserSource } from './feature-progress.mjs';
import { initializeReview, renderDeferQueue, renderDirectory } from './review-ui.mjs';
import { deriveRoadmap } from './roadmap-model.mjs';
import { featureProgressCardLines, featureProgressSummaryMap, renderFeatureProgressDetail, renderRoadmapDetail, renderRoadmapFilters, renderRoadmapIndex, roadmapStyles } from './roadmap-ui.mjs';
import { deriveProgress, deriveTimeline } from './timeline-model.mjs';
import { initializeGraphTime, initializeTimeline, renderGraphTimeShell, renderTimelineOverview, renderTimelineShell, timelineStyles } from './timeline-ui.mjs';

const EDGE_LABELS = {
  contains: '包含', serves: '服务于', enables: '支持', constrains: '约束',
  implemented_by: '由其实现', verified_by: '由其验证', depends_on: '依赖',
  supersedes: '替代', conflicts_with: '与之冲突', derived_from: '来源于', part_of: '属于',
};

const GRAPH_LABELS = {
  title: '产品关系图谱',
  timeline: '时间线',
  readOnly: '只读导航 · 位置不代表新增层级；评审写入只发生在右侧面板',
  navigation: '可缩放图谱画布',
  zoomTools: '画布缩放', zoomIn: '放大', zoomOut: '缩小', zoomLevel: '缩放比例',
  fit: '适应全图', overview: '分层总览', expandAll: '全部展开', expand: '展开分支', collapse: '收起分支',
  fullscreen: '全屏', exitFullscreen: '退出全屏', fullscreenEntered: '画布已全屏，右侧评审面板保留；按 Esc 或退出全屏按钮返回。',
  fullscreenFallback: '系统全屏暂不可用，已铺满当前窗口并保留评审面板；按 Esc 或退出全屏按钮返回。',
  fullscreenLeft: '已退出画布全屏，保留缩放、位置和评审内容。', fullscreenExitFailed: '未能退出系统全屏，请按 Esc 或使用浏览器的退出全屏控件。',
  panTools: '画布平移', pan: ['向左查看', '向上查看', '向下查看', '向右查看'],
  minimap: '图谱缩略图，可点击定位；也可使用平移按钮',
  hierarchy: '层级关系', crossLinks: '显示交叉关系',
  help: '拖动空白或节点平移 · 轻点节点查看 · 滚轮或双指缩放 · 方向键平移，+/− 缩放，0 适应全图 · Tab 选择节点',
  details: '节点详情', selectHint: '点击节点查看关系、条件与证据',
  detailsButton: '详情', closeDetails: '关闭详情', detailsDescription: '说明', detailsProgress: '进度详情',
  detailsRelationships: '关联关系', detailsNoRelationships: '暂无关联关系',
  snapshotNote: '图中“已观察”可能仅指静态证据；测试定义不等于测试通过。此画布不会修改项目状态。',
  layoutWarning: '存在循环、自引用或多个父节点，部分关系未用于排布；全部原始关系仍保留。',
  matches: '项匹配', nodes: '个可见节点', folded: '个节点已收起',
  groupHidden: '个在分组内', focusCount: '个节点',
  arrange: '整理', arrangeDone: '完成整理', arrangeHint: '拖动卡片整理 · Shift+点击多选卡片',
  group: '建组', groupName: '分组名称', groupCreate: '创建', groupCancel: '取消',
  resetLayout: '重置布局', groupRemove: '删除分组', groupToggle: '收起分组', groupExpand: '展开分组',
  focus: '聚焦', focusOff: '退出聚焦',
  search: '搜索', searchPlaceholder: '节点名称、类型、状态……', statusField: '状态', allStatuses: '所有状态',
  nodeType: '类型', allNodeTypes: '所有类型', resetFilters: '重置筛选',
  kinds: {
    product_goal: '产品目标', user_group: '用户群体', user_task: '用户任务', capability: '产品能力',
    behavior_commitment: '行为承诺', business_object: '业务对象', implementation: '实现证据',
    verification: '验证证据', unknown: '待确认事项',
  },
  statuses: { candidate: '候选', confirmed: '已确认', observed: '已观察', unknown: '未知', retired: '已停止' },
  noMatches: '没有匹配节点。', noNodes: '当前状态还没有节点。',
  graphView: '画布', listView: '文本列表', observations: '覆盖与检查',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function shortDigest(value) {
  if (!value) return '未记录';
  const string = String(value);
  if (string.length <= 24) return string;
  return string.slice(0, 14) + '…' + string.slice(-6);
}

function viewStatusText(value) {
  if (!value) return '视图状态未记录';
  if (typeof value === 'string') return value;
  const labels = { current: '最新', pending: '待生成', rendered: '已生成', not_rendered: '待生成', failed: '生成失败', saved_view_pending: '待更新' };
  const status = value.status ? labels[value.status] ?? value.status : '';
  return value.message || status || '视图状态已记录';
}

function readOnlyText(reason) {
  if (!reason) return '未说明原因';
  const labels = {
    invalid_state: '状态文件校验失败', invalid_state_on_disk: '状态文件校验失败',
    state_unverifiable: '状态无法核验', hardlink_state: '状态文件存在硬链接，不能安全写入',
    read_only: '状态存储只读', migration_required: '0.1 状态需要显式迁移',
    schema_0_1_requires_migration: '0.1 状态需要显式迁移',
    state_not_found: '状态文件不存在', state_not_file: '状态路径不是普通文件',
    state_unreadable: '状态文件无法读取', invalid_utf8: '状态文件不是合法 UTF-8',
    external_modification: '检测到外部修改', lock_lost: '写锁丢失',
    write_unverified: '写入后未核验', commit_unknown: '提交结果未知',
    state_validation_failed: '服务生成状态校验失败', replaced_unverified: '替换后未核验',
  };
  return labels[reason] ? `${labels[reason]}（${reason}）` : reason;
}

function safeScriptJson(value) {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

function normalizeStateLocation(value) {
  const location = String(value ?? '.product-continuity/project-state.json').replaceAll('\\', '/');
  if (!location || location.startsWith('/') || /^[a-zA-Z]:\//.test(location) || location.split('/').includes('..')) {
    throw new TypeError('stateLocation must be a project-relative path without ".."');
  }
  return location;
}

function featureProgressData(state) {
  const view = deriveFeatureProgress(state, { includeRetired: true, digest: digestValue });
  const byNode = new Map(view.features.map((feature) => [feature.nodeId, feature]));
  const fingerprints = {};
  for (const node of asArray(state?.nodes)) {
    if (node?.kind !== 'capability') continue;
    const content = featureContextFingerprintContent(state, node.id);
    if (content) fingerprints[node.id] = digestValue(content);
  }
  return { view, byNode, summary: featureProgressSummaryMap(view), fingerprints };
}

function graphData(state, progress = featureProgressData(state)) {
  const claims = asArray(state.intentClaims);
  const roadmapByNode = new Map(asArray(state.roadmapItems)
    .filter((item) => item && typeof item.nodeId === 'string')
    .map((item) => [item.nodeId, item]));
  const horizonLabels = { now: 'Now', next: 'Next', later: 'Later', unplanned: '未排期' };
  const statusLabels = { idea: '想法', ready: '可开始', in_progress: '进行中', paused: '暂停', closed: '已关闭' };
  return {
    labels: GRAPH_LABELS,
    edgeLabels: EDGE_LABELS,
    nodes: asArray(state.nodes).map((node) => {
      const summary = deriveNodeIntentSummary(node, claims);
      const status = summary?.status ?? node.status;
      const roadmap = node.kind === 'capability' ? roadmapByNode.get(node.id) : null;
      const feature = node.kind === 'capability' ? progress.byNode.get(node.id) : null;
      const lines = feature ? featureProgressCardLines(feature) : null;
      return {
        id: node.id,
        label: node.label,
        description: node.description,
        kind: node.kind,
        status,
        anchor: 'node-' + Array.from(new TextEncoder().encode(node.id), (byte) => byte.toString(16).padStart(2, '0')).join(''),
        kindLabel: node.kind,
        statusLabel: status,
        roadmapLabel: roadmap ? `规划 ${horizonLabels[roadmap.horizon] ?? roadmap.horizon} · ${statusLabels[roadmap.status] ?? roadmap.status}` : undefined,
        progressLine: lines?.line1,
        progressNext: lines?.line2,
        progressDetail: lines?.aria,
        delivery: lines?.delivery ?? null,
      };
    }),
    edges: asArray(state.edges).map((edge) => ({
      id: edge.id, from: edge.from, to: edge.to, kind: edge.kind,
      label: EDGE_LABELS[edge.kind] ?? edge.kind,
    })),
  };
}

const KIND_LABELS = {
  product_goal: '产品目标', user_group: '用户群体', user_task: '用户任务', capability: '产品能力',
  behavior_commitment: '行为承诺', business_object: '业务对象', implementation: '实现证据',
  verification: '验证证据', unknown: '待确认事项',
};

function graphNodeForDisplay(node, claims) {
  const summary = deriveNodeIntentSummary(node, claims);
  const status = summary?.status ?? node.status;
  return {
    ...node,
    status,
    kindLabel: KIND_LABELS[node.kind] ?? node.kind,
  };
}

const reviewStyles = `
:root{color-scheme:light;--ink:#1d2928;--muted:#5d6d69;--line:#d8e0dc;--paper:#f3f6f4;--surface:#fff;--green:#246b54;--green-soft:#e5f1ea;--amber:#855c12;--amber-soft:#f7f0dc;--red:#9a4038;--red-soft:#f7e9e6;--blue:#315f86;--blue-soft:#e8f0f7;font:16px/1.55 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
*{box-sizing:border-box}html,body{max-width:100%}body{margin:0;background:var(--paper);color:var(--ink)}h1,h2,h3,h4,h5{font-family:Bahnschrift,"Segoe UI","Microsoft YaHei",sans-serif;font-weight:600;line-height:1.25}h1{font-size:1.7rem;letter-spacing:-.03em;margin:0}h2{font-size:1.12rem;margin:0}h3{font-size:1rem;margin:0}h4{font-size:.95rem;margin:0 0 .45rem}h5{font-size:.86rem;margin:.55rem 0 .25rem}code,.mono{font-family:Consolas,"Cascadia Code",monospace;overflow-wrap:anywhere;word-break:break-word}p{margin:.35rem 0}.shell{max-width:1680px;margin:auto;padding:1rem 1.2rem 2.4rem}a{color:var(--green)}button,input,select,textarea{font:inherit;color:var(--ink)}button{cursor:pointer;min-height:44px;border:1px solid #aebcb6;border-radius:5px;background:var(--surface);padding:.45rem .7rem}button:hover{background:#edf3ef}button:disabled{cursor:not-allowed;opacity:.55}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible,[tabindex]:focus-visible{outline:3px solid #2f6f96;outline-offset:2px}input,select,textarea{min-height:44px;border:1px solid #aebcb6;border-radius:5px;padding:.45rem .55rem;background:var(--surface);max-width:100%}textarea{width:100%;resize:vertical}fieldset{border:1px solid var(--line);border-radius:6px;padding:.7rem;margin:.7rem 0;min-width:0}legend{padding:0 .3rem;font-weight:600}.top{display:block;border-bottom:1px solid var(--line);padding-bottom:.55rem;margin-bottom:.8rem}.top-main{display:flex;justify-content:space-between;align-items:flex-start;gap:.4rem 1rem;flex-wrap:wrap}.top-title{flex:1 1 21rem;min-width:0}.top .eyebrow{margin:0 0 .05rem;font-size:.68rem}.top h1{font-size:1.3rem}.top .summary{flex:0 1 auto;gap:.3rem;justify-content:flex-start}.top .summary .badge{min-height:1.4rem;padding:.02rem .4rem;font-size:.7rem;background:var(--paper)}.top .meta{align-items:center;gap:.25rem .75rem;margin-top:.4rem;font-size:.76rem}.top .meta .btn{min-height:2rem;padding:.1rem .55rem;font-size:.74rem}.header-details{margin-top:.3rem;font-size:.74rem;color:var(--muted)}.header-details>summary{display:inline-flex;align-items:center;gap:.3rem;min-height:1.6rem;padding:.05rem .45rem;border:1px solid var(--line);border-radius:4px;background:var(--surface);cursor:pointer;list-style:none}.header-details>summary::-webkit-details-marker{display:none}.header-details>summary::before{content:'▸';font-size:.62rem}.header-details[open]>summary::before{content:'▾'}.header-details>summary:hover{color:var(--ink);border-color:#b6c6be}.header-details-body{display:flex;flex-wrap:wrap;gap:.3rem .9rem;margin-top:.35rem;padding:.45rem .6rem;border-left:3px solid var(--line);border-radius:0 5px 5px 0;background:#eef3f0}.header-details-body .subtitle{flex:1 1 100%;margin:0;font-size:.75rem}.header-details-body code{color:var(--ink)}.subtitle{color:var(--muted);margin:.25rem 0 0}.eyebrow{font-size:.73rem;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 .15rem}.meta{display:flex;flex-wrap:wrap;gap:.4rem .8rem;margin-top:.7rem;font-size:.8rem;color:var(--muted)}.meta code{color:var(--ink)}.badges{display:flex;gap:.4rem;flex-wrap:wrap;margin:.4rem 0}.badge{display:inline-flex;align-items:center;min-height:1.6rem;padding:.1rem .45rem;border:1px solid var(--line);border-radius:4px;background:var(--surface);font-size:.76rem;line-height:1.35;max-width:100%;overflow-wrap:anywhere}.badge[data-status=candidate]{background:var(--amber-soft);border-color:#dfc98f;color:#6d4a0d}.badge[data-status=confirmed]{background:var(--green-soft);border-color:#b9d8c9;color:#1e5945}.badge[data-status=retired],.badge[data-status=dismissed],.badge[data-status=superseded]{background:var(--red-soft);border-color:#e2bdb6;color:#7c352e}.badge[data-status=open]{background:var(--amber-soft);border-color:#dfc98f}.badge[data-status=accepted]{background:var(--green-soft);border-color:#b9d8c9}.summary{display:flex;gap:.4rem;flex-wrap:wrap;justify-content:flex-end}.review-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(360px,430px);gap:1rem;align-items:start}.review-main{min-width:0;display:grid;gap:1rem}.review-panel{background:var(--surface);border:1px solid var(--line);border-radius:8px;position:sticky;top:1rem;max-height:calc(100vh - 2rem);overflow:auto;min-width:0}.review-panel-head{display:flex;justify-content:space-between;gap:.7rem;align-items:flex-start;padding:.85rem 1rem;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--surface);z-index:1}.review-panel-body{padding:1rem;min-width:0}.directory{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:1rem;min-width:0}.section-head{display:flex;justify-content:space-between;gap:.8rem;align-items:flex-start;margin-bottom:.6rem}.section-head p{color:var(--muted);font-size:.82rem;margin:.2rem 0 0}.defer-section{border:1px solid var(--line);border-radius:6px;padding:.6rem .8rem;margin:.6rem 0 1rem;background:#fbfcfb}.defer-list{list-style:none;margin:.2rem 0;padding:0;display:grid;gap:.5rem}.defer-item{border-left:3px solid var(--amber);padding:.35rem .6rem;background:var(--amber-soft);border-radius:3px}.intent-node{border:1px solid var(--line);border-radius:7px;padding:.8rem;margin:.8rem 0;background:#fbfcfb;min-width:0}.intent-node-head{display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}.node-open{font-weight:600;text-align:left;border:0;background:transparent;padding:.2rem 0;min-height:44px}.node-open:hover{text-decoration:underline;background:transparent}.intent-summary{font-weight:600;margin:.45rem 0 .1rem}.claim-list{display:grid;gap:.6rem;margin:.5rem 0}.intent-item{border:1px solid var(--line);border-left:3px solid var(--green);border-radius:6px;padding:.7rem;background:var(--surface);min-width:0}.intent-item[data-status=superseded],.intent-item[data-status=retired],.intent-item[data-status=dismissed]{border-left-color:var(--red);background:#fdf9f8}.intent-item-head{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap}.intent-statement{margin:.3rem 0;white-space:pre-wrap;overflow-wrap:anywhere;font-weight:600}.intent-fields{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.25rem .7rem;margin:.35rem 0;min-width:0}.intent-fields dt{font-weight:600}.intent-fields dd{margin:0;min-width:0}.intent-list{margin:.2rem 0;padding-left:1.1rem}.intent-list li{overflow-wrap:anywhere}.intent-actions{display:flex;flex-wrap:wrap;gap:.4rem;margin-top:.5rem;align-items:flex-start}.intent-actions details{margin:0}.internal-ids{margin:.4rem 0;font-size:.78rem;color:var(--muted)}.internal-ids summary{cursor:pointer}.internal-ids code{font-size:.75rem}.muted{color:var(--muted)}.notice{background:var(--amber-soft);border:1px solid #dfc98f;border-radius:4px;padding:.45rem .6rem;margin:.5rem 0}.proposal-item{margin:.6rem 0;border-top:1px dashed var(--line);padding-top:.5rem}.panel-section{border-top:1px solid var(--line);padding:.7rem 0;min-width:0}.panel-section:first-of-type{border-top:0}.collapsible summary{cursor:pointer;font-weight:600;font-family:Bahnschrift,"Segoe UI","Microsoft YaHei",sans-serif}.action-zone{border-top:2px solid var(--line);margin-top:.7rem;padding-top:.7rem}.action-form{display:grid;gap:.5rem;min-width:0}.field{display:grid;gap:.2rem;min-width:0}.field-label{font-weight:600;font-size:.86rem}.field-hint{font-size:.78rem;color:var(--muted);margin:.1rem 0 0}.field-error{font-size:.8rem;color:var(--red);margin:.1rem 0 0}.check{display:flex;align-items:flex-start;gap:.5rem;margin:.35rem 0;min-height:44px}.check input{min-height:0;width:20px;height:20px;margin-top:.2rem;flex:none}.array-rows{display:grid;gap:.35rem}.array-row{display:flex;gap:.35rem;align-items:flex-start;min-width:0}.array-field{flex:1;min-width:0}.btn{background:var(--surface)}.btn-primary{background:var(--green);color:#fff;border-color:var(--green)}.btn-primary:hover{background:#1e5945}.btn-secondary{background:#f4f8f6}.btn-small{min-height:44px;padding:.35rem .5rem}.link-button{border:0;background:transparent;color:var(--green);text-decoration:underline;padding:.2rem;min-height:44px;text-align:left}.preview-block{border:1px solid #9dbbd5;background:var(--blue-soft);border-radius:6px;padding:.8rem;margin:.6rem 0;min-width:0}.diff-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:.6rem}.diff-column{background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:.45rem;min-width:0}.diff-list{display:grid;gap:.3rem;margin:.5rem 0}.diff-row{display:flex;gap:.45rem;align-items:flex-start;padding:.3rem .4rem;border-radius:3px;background:var(--surface);border:1px solid var(--line)}.diff-label{font-weight:700;font-size:.78rem;white-space:nowrap}.diff-added .diff-label{color:#1e5945}.diff-removed .diff-label{color:#7c352e}.diff-changed .diff-label{color:#315f86}.impact-list ul{margin:.2rem 0}.attestations{margin:.6rem 0}.save-note{font-size:.82rem;color:var(--muted);background:#f4f8f6;border-left:3px solid var(--green);padding:.4rem .6rem;margin:.3rem 0}.stale-block{border:1px solid #dfc98f;background:var(--amber-soft);border-radius:6px;padding:.7rem;margin:.5rem 0}.pending-banner{border-bottom:1px solid #dfc98f;background:var(--amber-soft);padding:.55rem 1rem;font-size:.84rem}.pending-banner[hidden]{display:none}.alert{border:1px solid #e2bdb6;background:var(--red-soft);color:#6d2d26;padding:.55rem .8rem;margin:.5rem 1rem;border-radius:4px}.status{padding:.45rem 1rem;color:#1e5945;font-size:.84rem;min-height:1.6rem}.status:empty{padding:0;min-height:0}.preview-host{min-width:0}.empty{color:var(--muted)}.save-note{overflow-wrap:anywhere}.review-panel-body .intent-node{margin:.6rem 0}.review-panel-body .intent-node .intent-node-head .node-open{font-size:.95rem}.hidden{display:none!important}.visually-hidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:1100px){.review-layout{grid-template-columns:minmax(0,1fr)}.review-panel{position:static;max-height:none}.review-panel-head{position:static}.graph-viewport{height:480px}}
@media(max-width:620px){.shell{padding:.7rem}.top-main{display:block}.top h1{font-size:1.12rem}.top .summary{margin-top:.35rem}.review-layout{gap:.7rem}.diff-columns{grid-template-columns:minmax(0,1fr)}.intent-fields{grid-template-columns:minmax(0,1fr)}.graph-viewport{height:380px}.summary{justify-content:flex-start}.section-head{flex-direction:column}.meta{font-size:.76rem}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
`;

export function renderReview(snapshot, options = {}) {
  const state = snapshot?.state;
  if (!state || state.schemaVersion !== '0.2') {
    throw new TypeError('renderReview requires a 0.2 state snapshot');
  }
  const nonce = String(options.nonce ?? '');
  if (!nonce || !/^[A-Za-z0-9+/=_-]{8,200}$/.test(nonce)) {
    throw new TypeError('renderReview requires a valid CSP nonce');
  }
  const stateLocation = normalizeStateLocation(options.stateLocation);
  const stateIdentity = String(options.stateIdentity ?? snapshot.stateIdentity ?? state.project?.id ?? 'local');
  const fileDigest = String(snapshot.fileDigest ?? '');
  const writable = snapshot.writable === true;
  const readOnlyReason = String(snapshot.readOnlyReason ?? '');
  const viewStatus = snapshot.viewStatus ?? null;
  const claims = asArray(state.intentClaims);
  const proposals = asArray(state.proposals);
  const openProposals = proposals.filter((proposal) => proposal.status === 'open');
  const displayNodes = asArray(state.nodes).map((node) => graphNodeForDisplay(node, claims));
  const featureProgress = featureProgressData(state);
  const graph = graphData({ ...state, nodes: displayNodes }, featureProgress);
  const roadmap = deriveRoadmap(state);
  const roadmapCounts = `Now ${roadmap.byHorizon.now} · Next ${roadmap.byHorizon.next} · Later ${roadmap.byHorizon.later} · 未排期 ${roadmap.byHorizon.unplanned}`;
  const timeline = renderGraphTimeShell() + renderTimelineShell(state, snapshot.timelineHistory, { deriveProgress, renderTimelineOverview });
  const graphShell = renderGraphShell({ graph: GRAPH_LABELS }, { inspector: false, roadmap:true, timeline: true, timelineContent: timeline, filters: true, arrange: true });
  const directoryProgress = {};
  for (const feature of featureProgress.view.features) directoryProgress[feature.nodeId] = featureProgressCardLines(feature);
  const directory = renderDirectory(state, { writable, readOnlyReason, progress: directoryProgress });
  const deferQueue = renderDeferQueue(state);
  const bootstrap = {
    projectId: state.project?.id,
    projectName: state.project?.name,
    state,
    stateVersion: state.stateVersion,
    fileDigest,
    currentDigest: fileDigest,
    writable,
    readOnlyReason,
    viewStatus,
    stateIdentity,
    stateLocation,
    graph,
    timelineHistory: snapshot.timelineHistory ?? null,
    featureFingerprints: {
      stateVersion: state.stateVersion,
      digest: fileDigest,
      values: featureProgress.fingerprints,
    },
  };
  const script = `(${initializeReview.toString()})(${safeScriptJson(bootstrap)}, {\n` +
    `renderDirectory: ${renderDirectory.toString()},\n` +
    `renderDeferQueue: ${renderDeferQueue.toString()},\n` +
    `renderRoadmapIndex: ${renderRoadmapIndex.toString()},\n` +
    `renderRoadmapFilters: ${renderRoadmapFilters.toString()},\n` +
    `renderRoadmapDetail: ${renderRoadmapDetail.toString()},\n` +
    `renderFeatureProgressDetail: ${renderFeatureProgressDetail.toString()},\n` +
    `featureProgressSummaryMap: ${featureProgressSummaryMap.toString()},\n` +
    `featureProgressCardLines: ${featureProgressCardLines.toString()},\n` +
    `featureProgressApi: (${getFeatureProgressBrowserSource()}),\n` +
    `deriveRoadmap: ${deriveRoadmap.toString()},\n` +
    `deriveProgress: ${deriveProgress.toString()},\n` +
    `deriveTimeline: ${deriveTimeline.toString()},\n` +
    `renderTimelineOverview: ${renderTimelineOverview.toString()},\n` +
    `initializeTimeline: ${initializeTimeline.toString()},\n` +
    `initializeGraphTime: ${initializeGraphTime.toString()},\n` +
    `initializeGraph: ${initializeGraph.toString()},\n` +
    `buildGraphLayout: ${buildGraphLayout.toString()}\n` +
    `});`;
  const safeScript = script.replaceAll('</script', '<\\/script');
  const nonceAttribute = escapeAttribute(nonce);
  const title = `${state.project?.name ?? '项目'} · 实时意图评审`;
  const summaryBadges = [
    `${displayNodes.length} 个节点`,
    `${claims.length} 条意图记录`,
    `${roadmap.total} 项功能规划`,
    `${openProposals.length} 条待处理提案`,
  ].map((label) => `<span class="badge">${escapeHtml(label)}</span>`).join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>
<style>
${graphStyles}
${reviewStyles}
${timelineStyles}
${roadmapStyles}
</style></head><body><main class="shell">
<header class="top" id="review-header" data-testid="review-header" data-state-version="${escapeAttribute(state.stateVersion)}" data-file-digest="${escapeAttribute(fileDigest)}" data-writable="${writable}">
  <div class="top-main">
    <div class="top-title">
      <p class="eyebrow">实时评审 · 会写入项目状态</p>
      <h1>${escapeHtml(state.project?.name ?? '项目')} · 实时意图评审</h1>
    </div>
    <div class="summary" aria-label="评审摘要">${summaryBadges}</div>
  </div>
  <div class="meta">
    <span>当前文件版本：<strong id="review-version">${escapeHtml(state.stateVersion)}</strong></span>
    <span>当前文件摘要：<code id="review-digest">${escapeHtml(shortDigest(fileDigest))}</code></span>
    <span class="badge" id="review-writable" data-writable="${writable}">${writable ? '可写' : `只读：${escapeHtml(readOnlyText(readOnlyReason))}`}</span>
    <span>视图：<span id="review-view-status">${escapeHtml(viewStatusText(viewStatus))}</span></span>
    <button type="button" id="review-render-view" class="btn btn-secondary" data-testid="render-view" ${viewStatusText(viewStatus).match(/pending|待更新|待生成/i) ? '' : 'hidden'}>仅重生成视图</button>
  </div>
  <details class="header-details">
    <summary>状态详情</summary>
    <div class="header-details-body">
      <p class="subtitle">人工决定在此记录。不会修改业务代码、实现证据或测试结果；确认只作用于完整展示的这一条意图。</p>
      <span>状态位置：<code id="review-state-location">${escapeHtml(stateLocation)}</code></span>
      <span>状态身份：<code id="review-state-identity">${escapeHtml(stateIdentity)}</code></span>
    </div>
  </details>
</header>
<div id="review-workspace" class="review-layout" data-graph-fullscreen-host>
  <div class="review-main">
    ${graphShell}
    <section class="roadmap-directory" aria-labelledby="roadmap-title" data-testid="roadmap-directory">
      <header class="roadmap-head"><div>
        <p class="eyebrow">功能规划 · 只读投影</p>
        <h2 id="roadmap-title" tabindex="-1">功能规划</h2>
        <p>按规划位置查看 Now / Next / Later / 未排期，再打开只读详情。规划引用同一 capability 节点，不复制功能；列表同时显示保存的停点与下一步，续接记录不是评审或执行授权。</p>
      </div><div class="roadmap-counts" id="roadmap-counts">${escapeHtml(roadmapCounts)} · 共 ${roadmap.total} 项</div></header>
      ${renderRoadmapFilters()}
      <div id="roadmap-list" aria-live="polite">${renderRoadmapIndex(roadmap, { progress: featureProgress.summary })}</div>
      <p class="muted">规划只说明产品意图与位置，不授予开发权限；Now 不是执行授权。首版只读，编辑通过离线规划命令显式授权。</p>
    </section>
    <section class="directory" aria-labelledby="intent-directory-title" data-testid="intent-directory">
      <header class="section-head"><div><h2 id="intent-directory-title" tabindex="-1">意图目录</h2><p>先选节点查看“现行意图 x/y”，再打开单条意图或提案。图谱只做只读导航；表单只出现在右侧面板。</p></div></header>
      <section class="defer-section" aria-labelledby="defer-title" data-testid="defer-queue">
        <h3 id="defer-title">待处理（暂缓）</h3>
        <div id="defer-queue-host">${deferQueue}</div>
      </section>
      <div id="intent-list">${directory}</div>
    </section>
  </div>
  <aside id="review-panel" class="review-panel" role="region" aria-labelledby="review-panel-title" tabindex="-1" data-testid="review-panel">
    <section id="roadmap-panel" class="roadmap-panel" role="region" aria-labelledby="roadmap-panel-title" tabindex="-1" data-testid="roadmap-panel" hidden>
      <header class="roadmap-panel-head"><div><p class="eyebrow">功能规划 · 只读</p><h2 id="roadmap-panel-title" tabindex="-1">功能规划详情</h2></div><button type="button" id="roadmap-close" data-testid="roadmap-close" aria-label="关闭功能规划详情">关闭规划详情</button></header>
      <div id="roadmap-panel-body" class="roadmap-panel-body"></div>
    </section>
    <div id="review-current">
    <header class="review-panel-head">
      <div><p class="eyebrow">独立评审面板</p><h2 id="review-panel-title" tabindex="-1">选择一条意图</h2></div>
      <button type="button" id="review-close" data-testid="review-close" aria-label="关闭评审面板" hidden>关闭</button>
    </header>
    <div id="pending-banner" class="pending-banner" role="status" hidden></div>
    <div id="review-alert" class="alert" role="alert" tabindex="-1" hidden></div>
    <div id="review-status" class="status" role="status" tabindex="-1" aria-live="polite"></div>
    <div id="review-panel-body" class="review-panel-body">
      <p class="muted">从左侧图谱、意图目录或暂缓队列选择节点/意图/提案，再在这里查看完整内容并执行动作。需要启用脚本才能预览与保存。</p>
    </div>
    </div>
    <section id="history-panel" class="history-panel" aria-label="历史版本只读详情" hidden></section>
  </aside>
</div>
<noscript><p class="notice">此页需要启用本地脚本才能预览与保存；静态地图不提供写入能力。</p></noscript>
</main>
<script nonce="${nonceAttribute}">${safeScript}</script>
</body></html>`;
}

export default renderReview;
