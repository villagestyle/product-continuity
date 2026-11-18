// Client-side rendering and interaction helpers for the live review page.
// Every exported function is stringified into the page, so each one must stay
// self-contained: no imports and no references to module-scope values.

export function renderDirectory(state, options = {}) {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const asArray = (value) => (Array.isArray(value) ? value : []);
  const kindLabels = {
    product_goal: '产品目标', user_group: '用户群体', user_task: '用户任务', capability: '产品能力',
    behavior_commitment: '行为承诺', business_object: '业务对象', implementation: '实现证据',
    verification: '验证证据', unknown: '待确认事项',
  };
  const claimStatusLabels = { candidate: '候选', confirmed: '已确认', superseded: '已被替代', retired: '已停止', dismissed: '已撤回' };
  const proposalStatusLabels = { open: '待处理', accepted: '已接受', rejected: '已拒绝', expired: '已过期' };
  const dispositionLabels = { unreviewed: '未审阅', single: '可独立决定', needs_split: '需要拆分' };
  const originLabels = { onboarding: '首次建图', migration: '迁移', review: '评审', conversation: '会话采集' };
  const conversationSource = (claim) => {
    const capture = asArray(state?.conversationCaptures).find((c) => c.id === claim.conversationSource?.captureId);
    const item = capture?.items?.[claim.conversationSource?.itemIndex];
    if (!item) return '';
    const label = { user_statement: '用户原话', assistant_suggestion: '助手建议', assistant_report: '助手报告（未经执行验证）' }[item.basis];
    return `<details class="conversation-source"><summary>会话来源 · ${esc(label)}</summary><blockquote>${esc(item.source.quote)}</blockquote><p class="muted">提取内容仍为候选；来源核验不等于用户确认。${item.conflictsWithClaimIds.length ? ` 与已确认意图有冲突：${item.conflictsWithClaimIds.map(esc).join('、')}` : ''}</p><code>${esc(item.source.sessionId)} / ${esc(item.source.messageId)}</code></details>`;
  };
  const actionLabels = {
    edit_candidate: '整理候选', split_candidate: '拆分候选', discard_candidate: '撤回候选',
    confirm_candidate: '确认这一条', propose_edit: '提出修改', accept_proposal: '接受修改',
    reject_proposal: '拒绝提案', retire_claim: '停止意图', defer: '暂缓',
  };
  const intentKinds = new Set(['product_goal', 'user_group', 'user_task', 'capability', 'behavior_commitment', 'business_object']);
  const writable = options.writable !== false;
  const readOnlyReason = options.readOnlyReason || '当前状态只读';
  // Shared card-lines projection (nodeId -> featureProgressCardLines output),
  // passed explicitly so this stringified helper keeps no module dependency.
  const progressByNode = options.progress && typeof options.progress === 'object' ? options.progress : null;

  const renderContent = (content, emptyNote = true) => {
    const statement = String(content?.statement ?? '');
    const scope = asArray(content?.scope);
    const conditions = asArray(content?.conditions);
    const exceptions = asArray(content?.exceptions);
    const list = (items, empty) => (items.length
      ? `<ul class="intent-list">${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`
      : `<p class="muted">${esc(empty)}</p>`);
    return `<dl class="intent-fields">
      <dt>声明</dt><dd><p class="intent-statement">${statement ? esc(statement) : '<span class="muted">未记录声明</span>'}</p></dd>
      <dt>适用范围</dt><dd>${list(scope, '未记录适用范围')}</dd>
      <dt>条件</dt><dd>${list(conditions, '未记录条件')}${conditions.length === 0 && emptyNote ? '<p class="muted">未记录不等于无条件适用。</p>' : ''}</dd>
      <dt>例外</dt><dd>${list(exceptions, '未记录例外')}</dd>
    </dl>`;
  };
  const actionButton = (action, claimId, proposalId) => {
    const disabled = writable ? '' : ` disabled aria-disabled="true" title="${esc(readOnlyReason)}"`;
    const proposal = proposalId ? ` data-proposal-id="${esc(proposalId)}"` : '';
    return `<button type="button" class="btn btn-action" data-action="${esc(action)}" data-claim-id="${esc(claimId)}"${proposal} data-testid="action-${esc(action)}"${disabled}>${esc(actionLabels[action] ?? action)}</button>`;
  };
  const renderProposal = (proposal, claim) => `<article class="proposal-item" data-proposal-id="${esc(proposal.id)}" data-testid="proposal-item">
    <header class="intent-item-head"><span class="badge" data-status="${esc(proposal.status)}">修改提案 · ${esc(proposalStatusLabels[proposal.status] ?? proposal.status)}</span><span class="muted">目标意图</span></header>
    <p class="intent-statement">${esc(proposal.replacement?.statement ?? '')}</p>
    <dl class="intent-fields">
      <dt>理由</dt><dd>${esc(proposal.rationale ?? '')}</dd>
      <dt>拟议适用范围</dt><dd>${asArray(proposal.replacement?.scope).map((item) => `<div>${esc(item)}</div>`).join('') || '<span class="muted">未记录适用范围</span>'}</dd>
      <dt>拟议条件</dt><dd>${asArray(proposal.replacement?.conditions).map((item) => `<div>${esc(item)}</div>`).join('') || '<span class="muted">未记录条件</span>'}</dd>
      <dt>拟议例外</dt><dd>${asArray(proposal.replacement?.exceptions).map((item) => `<div>${esc(item)}</div>`).join('') || '<span class="muted">未记录例外</span>'}</dd>
    </dl>
    <details class="internal-ids"><summary>内部 ID</summary><code>${esc(proposal.id)}</code></details>
    <div class="intent-actions">
      <button type="button" class="btn btn-secondary" data-open-proposal="${esc(proposal.id)}" data-claim-id="${esc(claim.id)}" data-proposal-id="${esc(proposal.id)}" data-testid="open-proposal">查看提案</button>
      ${actionButton('accept_proposal', claim.id, proposal.id)}
      ${actionButton('reject_proposal', claim.id, proposal.id)}
      ${actionButton('defer', claim.id, proposal.id)}
    </div>
  </article>`;
  const renderClaim = (claim, openProposal) => {
    const isActive = claim.status === 'candidate' || claim.status === 'confirmed';
    const actions = [`<button type="button" class="btn btn-secondary" data-open-claim="${esc(claim.id)}" data-claim-id="${esc(claim.id)}" data-testid="open-claim">查看完整内容</button>`];
    if (isActive) {
      if (claim.status === 'candidate') {
        for (const action of ['edit_candidate', 'confirm_candidate', 'split_candidate', 'discard_candidate', 'defer']) actions.push(actionButton(action, claim.id, null));
      } else {
        if (!openProposal) actions.push(actionButton('propose_edit', claim.id, null));
        actions.push(actionButton('retire_claim', claim.id, null));
        actions.push(actionButton('defer', claim.id, null));
      }
    }
    return `<article class="intent-item" data-claim-id="${esc(claim.id)}" data-status="${esc(claim.status)}" data-testid="claim-item">
      <header class="intent-item-head">
        <span class="badge" data-status="${esc(claim.status)}">${esc(claimStatusLabels[claim.status] ?? claim.status)}</span>
        <span class="badge">准备：${esc(dispositionLabels[claim.assessment?.disposition] ?? claim.assessment?.disposition ?? '未审阅')}</span>
        <span class="muted">来源：${esc(originLabels[claim.origin] ?? claim.origin ?? '未记录')}</span>
      </header>
      ${renderContent(claim)}
      ${conversationSource(claim)}
      <p class="muted">${esc(claim.createdAt ?? '')}${claim.assessment?.reviewedLegacyContext ? ' · 已核对节点旧材料' : ''}</p>
      <details class="internal-ids"><summary>内部 ID 与准备记录</summary><code>${esc(claim.id)}</code><p>内容摘要：${esc(claim.assessment?.contentDigest ?? '未记录')}</p><p>准备 review：${esc(claim.assessment?.reviewId ?? '未记录')}</p><p>现行决定：${esc(claim.governingDecisionId ?? '无')}</p><p>停止决定：${esc(claim.retiredByDecisionId ?? '无')}</p></details>
      ${openProposal ? renderProposal(openProposal, claim) : ''}
      <div class="intent-actions">${actions.join('')}</div>
    </article>`;
  };
  const renderNode = (node) => {
    const nodeClaims = claims.filter((claim) => claim.nodeId === node.id);
    const active = nodeClaims.filter((claim) => claim.status === 'candidate' || claim.status === 'confirmed');
    const historical = nodeClaims.filter((claim) => claim.status === 'superseded' || claim.status === 'retired' || claim.status === 'dismissed');
    const confirmed = active.filter((claim) => claim.status === 'confirmed').length;
    const total = active.length;
    let text;
    if (total > 0) {
      if (confirmed === total) text = `本节点已记录的现行意图 ${confirmed}/${total} 已确认；不包括标题、其它节点或未提取内容。`;
      else if (confirmed > 0) text = `部分已确认 ${confirmed}/${total}。`;
      else text = `候选 ${confirmed}/${total}。`;
    } else if (historical.some((claim) => claim.status === 'retired') || node.status === 'retired') {
      text = node.legacy?.snapshot?.status === 'retired' && !historical.length
        ? '历史已退出（0.1），未生成新的停止决定。'
        : '无现行意图；已记录停止决定，仍展示历史。';
    } else {
      text = '暂无现行意图 / 尚未建立意图。';
    }
    const history = `历史已替代 ${historical.filter((claim) => claim.status === 'superseded').length} · 已停止 ${historical.filter((claim) => claim.status === 'retired').length} · 已撤回 ${historical.filter((claim) => claim.status === 'dismissed').length}`;
    const openByTarget = new Map(proposals.filter((proposal) => proposal.status === 'open').map((proposal) => [proposal.targetClaimId, proposal]));
    const lines = node.kind === 'capability' && progressByNode ? progressByNode[node.id] : null;
    const progressHtml = lines ? `<p class="node-progress" data-testid="node-feature-progress" aria-label="${esc(lines.aria)}">${lines.delivery ? `<span class="delivery-badge" data-testid="node-feature-delivery" data-delivery="${esc(lines.delivery.status)}" data-needs-review="${lines.delivery.needsReview ? 'true' : 'false'}" title="${esc(lines.delivery.title)}">${esc(lines.delivery.text)}</span>` : ''}<span>${esc(lines.line1)}</span><span class="node-progress-next">${esc(lines.line2)}</span></p>` : '';
    const notes = asArray(state?.conversationCaptures).flatMap((capture) => asArray(capture.items))
      .filter((item) => item.nodeId === node.id && item.kind === 'note')
      .map((item) => `<details class="conversation-source"><summary>${esc(({user_statement:'用户备注', assistant_suggestion:'助手建议备注', assistant_report:'助手报告（未经执行验证）'})[item.basis])}</summary><p>${esc(item.statement)}</p><blockquote>${esc(item.source.quote)}</blockquote><p class="muted">来源核验不等于用户确认或执行验证。${item.conflictsWithClaimIds.length ? ` 冲突意图：${item.conflictsWithClaimIds.map(esc).join('、')}` : ''}</p><code>${esc(item.source.role)} · ${esc(item.source.sessionId)} / ${esc(item.source.messageId)}</code></details>`).join('');
    return `<section class="intent-node" data-node-id="${esc(node.id)}" data-testid="intent-node">
      <header class="intent-node-head">
        <button type="button" class="node-open" data-open-node="${esc(node.id)}" data-testid="open-node">${esc(node.label ?? node.id)}</button>
        <span class="badge">${esc(kindLabels[node.kind] ?? node.kind)}</span>
      </header>
      <p class="intent-summary">${esc(text)}</p>
      <p class="muted">${esc(history)}</p>
      ${progressHtml}
      ${notes}
      ${active.length
        ? `<div class="claim-list">${active.map((claim) => renderClaim(claim, openByTarget.get(claim.id))).join('')}</div>`
        : '<p class="muted">尚未建立意图。没有标题自动成为已确认意图。</p>'}
      ${historical.length
        ? `<details class="claim-history"><summary>历史意图 (${historical.length})</summary><div class="claim-list">${historical.map((claim) => renderClaim(claim, undefined)).join('')}</div></details>`
        : ''}
    </section>`;
  };

  const nodes = asArray(state?.nodes);
  const claims = asArray(state?.intentClaims);
  const proposals = asArray(state?.proposals);
  const nodeFilter = options.nodeId || null;
  const intentNodes = nodes.filter((node) => intentKinds.has(node.kind) || claims.some((claim) => claim.nodeId === node.id));
  const filtered = nodeFilter ? intentNodes.filter((node) => node.id === nodeFilter) : intentNodes;
  if (!filtered.length) {
    return `<p class="empty">${nodeFilter ? '该节点没有意图记录。' : '当前状态没有可承载意图的节点。'}</p>`;
  }
  return filtered.map((node) => renderNode(node)).join('');
}

export function renderDeferQueue(state, options = {}) {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const asArray = (value) => (Array.isArray(value) ? value : []);
  const reasons = { needs_split: '需要拆分', needs_evidence: '需要证据', needs_decision: '需要产品决定', other: '其它' };
  const claims = new Map(asArray(state?.intentClaims).map((claim) => [claim.id, claim]));
  const proposals = new Map(asArray(state?.proposals).map((proposal) => [proposal.id, proposal]));
  const reviews = [...asArray(state?.reviews)].sort((left, right) => (right.resultingStateVersion ?? 0) - (left.resultingStateVersion ?? 0));
  const latest = new Map();
  for (const review of reviews) {
    const proposalId = review.command?.targetProposalId;
    const claimId = review.command?.targetClaimId;
    const key = proposalId ? `proposal:${proposalId}` : claimId ? `claim:${claimId}` : null;
    if (!key || latest.has(key)) continue;
    latest.set(key, review);
  }
  const items = [];
  for (const [key, review] of latest) {
    if (review.command?.action !== 'defer') continue;
    if (key.startsWith('claim:')) {
      const claim = claims.get(key.slice(6));
      if (!claim || (claim.status !== 'candidate' && claim.status !== 'confirmed')) continue;
      items.push({ key, review, claim, label: claim.statement });
    } else {
      const proposal = proposals.get(key.slice(9));
      if (!proposal || proposal.status !== 'open') continue;
      const claim = claims.get(proposal.targetClaimId);
      items.push({ key, review, proposal, claim, label: proposal.replacement?.statement ?? proposal.id });
    }
  }
  if (!items.length) return '<p class="empty">暂无暂缓项。</p>';
  return `<ul class="defer-list">${items.map((item) => {
    const payload = item.review.command?.payload ?? {};
    const claimId = item.claim?.id ?? '';
    const proposalId = item.proposal?.id;
    const openAttribute = proposalId
      ? `data-open-proposal="${esc(proposalId)}" data-proposal-id="${esc(proposalId)}"`
      : `data-open-claim="${esc(claimId)}"`;
    return `<li class="defer-item" data-testid="defer-item" data-defer-subject="${esc(item.key)}">
      <div><span class="badge" data-status="candidate">暂缓</span> <strong>${esc(item.label ?? '')}</strong></div>
      <p class="muted">原因：${esc(reasons[payload.reason] ?? payload.reason ?? '未记录')}${payload.note ? ` · ${esc(payload.note)}` : ''}</p>
      <div class="intent-actions"><button type="button" class="btn btn-secondary" ${openAttribute} data-claim-id="${esc(claimId)}" data-testid="open-defer-target">打开处理</button><details class="internal-ids"><summary>记录</summary><code>${esc(item.review.id)}</code></details></div>
    </li>`;
  }).join('')}</ul>`;
}

export function initializeReview(bootstrap, helpers) {
  const doc = document;
  const panel = doc.querySelector('#review-panel');
  const panelTitle = doc.querySelector('#review-panel-title');
  const panelBody = doc.querySelector('#review-panel-body');
  const panelClose = doc.querySelector('#review-close');
  const alertBox = doc.querySelector('#review-alert');
  const statusBox = doc.querySelector('#review-status');
  const pendingBanner = doc.querySelector('#pending-banner');
  const directoryHost = doc.querySelector('#intent-list');
  const deferHost = doc.querySelector('#defer-queue-host');
  const roadmapHost = doc.querySelector('#roadmap-list');
  const roadmapPanel = doc.querySelector('#roadmap-panel');
  const roadmapPanelTitle = doc.querySelector('#roadmap-panel-title');
  const roadmapPanelBody = doc.querySelector('#roadmap-panel-body');
  const roadmapClose = doc.querySelector('#roadmap-close');
  const renderViewButton = doc.querySelector('#review-render-view');
  if (!panel || !panelTitle || !panelBody) return;

  const labels = {
    claimStatus: { candidate: '候选', confirmed: '已确认', superseded: '已被替代', retired: '已停止', dismissed: '已撤回' },
    proposalStatus: { open: '待处理', accepted: '已接受', rejected: '已拒绝', expired: '已过期' },
    disposition: { unreviewed: '未审阅', single: '可独立决定', needs_split: '需要拆分' },
    origin: { onboarding: '首次建图', migration: '迁移', review: '评审', conversation: '会话采集' },
    kind: {
      product_goal: '产品目标', user_group: '用户群体', user_task: '用户任务', capability: '产品能力',
      behavior_commitment: '行为承诺', business_object: '业务对象', implementation: '实现证据',
      verification: '验证证据', unknown: '待确认事项',
    },
    action: {
      edit_candidate: '整理候选', split_candidate: '拆分候选', discard_candidate: '撤回候选',
      confirm_candidate: '确认这一条', propose_edit: '提出修改', accept_proposal: '接受修改',
      reject_proposal: '拒绝提案', retire_claim: '停止意图', defer: '暂缓',
    },
  };
  const projectId = bootstrap.projectId || bootstrap.state?.project?.id || 'project';
  let stateIdentity = bootstrap.stateIdentity || 'local';
  let stateLocation = bootstrap.stateLocation || '';
  let current = {
    state: bootstrap.state,
    stateVersion: bootstrap.stateVersion ?? bootstrap.state?.stateVersion ?? 0,
    fileDigest: bootstrap.currentDigest || bootstrap.fileDigest || '',
    writable: bootstrap.writable === true,
    readOnlyReason: bootstrap.readOnlyReason || '',
    viewStatus: bootstrap.viewStatus ?? null,
    timelineHistory: bootstrap.timelineHistory ?? null,
  };
  const initialParams = new URLSearchParams(location.search);
  const initialRoute = {
    claimId: initialParams.get('claim'),
    proposalId: initialParams.get('proposal'),
    hash: location.hash,
  };
  let panelTarget = null;
  let previewState = null;
  let activeDraftCapture = null;
  let formRevision = 0;
  let busy = false;
  let writeBlocked = false;
  let pending = null;
  let graphReady = false;
  let suppressGraphHook = false;
  let historySelection = null;
  let currentGraphView = null;
  let graphTimeApi = null;
  let currentPanelScroll = 0;
  let currentCrossLinks = true;
  let panelSeq = 0;
  let roadmapFilter = 'all';
  let roadmapIndexOpen = false;
  let currentRoadmapSelection = null;
  let currentRoadmapTrigger = null;
  let historyRoadmapItemId = null;
  const previewActions = new Set(['split_candidate', 'discard_candidate', 'confirm_candidate', 'accept_proposal', 'retire_claim']);

  function make(tag, attributes, ...children) {
    const element = doc.createElement(tag);
    for (const [key, value] of Object.entries(attributes || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') element.className = value;
      else if (key === 'text') element.textContent = String(value);
      else if (key === 'dataset') Object.assign(element.dataset, value);
      else if (key === 'checked') element.checked = Boolean(value);
      else if (key === 'disabled') element.disabled = Boolean(value);
      else if (key === 'value') element.value = value;
      else if (key === 'selected') element.selected = Boolean(value);
      else element.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined) continue;
      element.append(child);
    }
    return element;
  }

  function button(label, attributes, onClick) {
    const element = make('button', { type: 'button', ...(attributes || {}) }, label);
    if (onClick) element.addEventListener('click', onClick);
    return element;
  }

  function badge(label, status) {
    return make('span', { class: 'badge', 'data-status': status || null, text: label });
  }

  function paragraph(className, text) {
    return make('p', { class: className, text });
  }

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function claimById(id) {
    return asArray(current.state?.intentClaims).find((claim) => claim.id === id);
  }

  function proposalById(id) {
    return asArray(current.state?.proposals).find((proposal) => proposal.id === id);
  }

  function nodeById(id) {
    return asArray(current.state?.nodes).find((node) => node.id === id);
  }

  function decisionById(id) {
    return asArray(current.state?.decisions).find((decision) => decision.id === id);
  }

  function nodeForClaim(claim) {
    return claim ? nodeById(claim.nodeId) : undefined;
  }

  function openProposalForClaim(claimId) {
    return asArray(current.state?.proposals).find((proposal) => proposal.status === 'open' && proposal.targetClaimId === claimId);
  }

  function claimSummary(claim) {
    const claims = asArray(current.state?.intentClaims);
    const active = claims.filter((item) => item.nodeId === claim.nodeId && (item.status === 'candidate' || item.status === 'confirmed'));
    return { x: active.filter((item) => item.status === 'confirmed').length, y: active.length };
  }

  function nodeAnchor(id) {
    return 'node-' + Array.from(new TextEncoder().encode(id), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  // Precomputed fingerprints are only valid for the exact state they were
  // calculated from. After any refresh the page says "fingerprint not
  // recalculated" rather than inventing a digest in the browser.
  function featureFingerprintsFor(state) {
    const boot = bootstrap.featureFingerprints;
    if (!boot || !state || state !== current.state) return undefined;
    if (Number(boot.stateVersion) !== Number(current.stateVersion)) return undefined;
    if (boot.digest && current.fileDigest && boot.digest !== current.fileDigest) return undefined;
    return boot.values && typeof boot.values === 'object' ? boot.values : undefined;
  }

  function featureProgressViewFor(state) {
    const api = helpers.featureProgressApi;
    if (!api || !state) return null;
    try {
      return api.deriveFeatureProgress(state, { includeRetired: true, fingerprints: featureFingerprintsFor(state) });
    } catch { return null; }
  }

  function featureProgressSummaryFor(state) {
    const view = featureProgressViewFor(state);
    if (!view || typeof helpers.featureProgressSummaryMap !== 'function') return undefined;
    try { return helpers.featureProgressSummaryMap(view); } catch { return undefined; }
  }

  // nodeId -> shared card-lines projection for the live text directory. The
  // map is plain JSON so renderDirectory stays free of module dependencies.
  function featureProgressCardLinesFor(state) {
    const view = featureProgressViewFor(state);
    if (!view || typeof helpers.featureProgressCardLines !== 'function') return null;
    const map = {};
    try {
      for (const feature of Array.isArray(view.features) ? view.features : []) {
        if (feature && typeof feature.nodeId === 'string') map[feature.nodeId] = helpers.featureProgressCardLines(feature);
      }
    } catch { return null; }
    return map;
  }

  function featureProgressDetailFor(state, nodeId) {
    const api = helpers.featureProgressApi;
    if (!api || !state || typeof nodeId !== 'string') return null;
    try {
      const view = api.selectFeatureContext(state, nodeId, { fingerprints: featureFingerprintsFor(state) });
      return view && view.status === 'ok' ? view : null;
    } catch { return null; }
  }

  function featureProgressElement(state, nodeId, options = {}) {
    if (!state) return null;
    const node = asArray(state.nodes).find((item) => item.id === nodeId);
    if (!node || node.kind !== 'capability') return null;
    const detail = featureProgressDetailFor(state, nodeId);
    if (!detail || typeof helpers.renderFeatureProgressDetail !== 'function') return null;
    const host = make('div', { class: 'feature-progress-host' });
    host.innerHTML = helpers.renderFeatureProgressDetail(detail, { historical: options.historical === true });
    return host.innerHTML ? host : null;
  }

  function graphDataFromState(state) {
    const claims = asArray(state?.intentClaims);
    const roadmapByNode = new Map(asArray(state?.roadmapItems)
      .filter((item) => item && typeof item.nodeId === 'string')
      .map((item) => [item.nodeId, item]));
    const roadmapHorizonLabels = { now: 'Now', next: 'Next', later: 'Later', unplanned: '未排期' };
    const roadmapStatusLabels = { idea: '想法', ready: '可开始', in_progress: '进行中', paused: '暂停', closed: '已关闭' };
    const progressView = featureProgressViewFor(state);
    const progressByNode = new Map(asArray(progressView?.features).map((feature) => [feature.nodeId, feature]));
    const nodes = asArray(state?.nodes).map((node) => {
      const nodeClaims = claims.filter((claim) => claim.nodeId === node.id);
      const active = nodeClaims.filter((claim) => claim.status === 'candidate' || claim.status === 'confirmed');
      const confirmed = active.filter((claim) => claim.status === 'confirmed').length;
      const historical = nodeClaims.filter((claim) => claim.status === 'superseded' || claim.status === 'retired' || claim.status === 'dismissed');
      let status = node.status;
      if (['product_goal', 'user_group', 'user_task', 'capability', 'behavior_commitment', 'business_object'].includes(node.kind)) {
        if (active.length) status = confirmed === active.length ? 'confirmed' : 'candidate';
        else if (historical.some((claim) => claim.status === 'retired') || node.status === 'retired') status = 'retired';
        else status = 'candidate';
      }
      const statusLabels = { candidate: '候选', confirmed: '已确认', observed: '已观察', unknown: '未知', retired: '已停止' };
      const roadmap = node.kind === 'capability' ? roadmapByNode.get(node.id) : null;
      const feature = node.kind === 'capability' ? progressByNode.get(node.id) : null;
      const lines = feature && typeof helpers.featureProgressCardLines === 'function' ? helpers.featureProgressCardLines(feature) : null;
      return {
        id: node.id, label: node.label, kind: node.kind, status, description: node.description,
        anchor: nodeAnchor(node.id),
        kindLabel: labels.kind[node.kind] ?? node.kind,
        statusLabel: statusLabels[status] ?? status,
        roadmapLabel: roadmap ? `规划 ${roadmapHorizonLabels[roadmap.horizon] ?? roadmap.horizon} · ${roadmapStatusLabels[roadmap.status] ?? roadmap.status}` : undefined,
        progressLine: lines?.line1,
        progressNext: lines?.line2,
        progressDetail: lines?.aria,
        delivery: lines?.delivery ?? null,
      };
    });
    return {
      labels: bootstrap.graph?.labels ?? {},
      nodes,
      edges: asArray(state?.edges).map((edge) => ({
        id: edge.id, from: edge.from, to: edge.to, kind: edge.kind,
        label: bootstrap.graph?.edgeLabels?.[edge.kind] ?? edge.kind,
      })),
    };
  }

  const graphApi = helpers.initializeGraph?.(bootstrap.graph, helpers.buildGraphLayout, {
    fitFloor: 1,
    arrange: true,
    storageKey: 'product-continuity:canvas:' + (bootstrap.projectId || 'default'),
    onSelect(nodeId) {
      if (!graphReady || suppressGraphHook) return;
      if (historySelection) { showHistoryNode(nodeId); return; }
      if (currentRoadmapSelection || roadmapIndexOpen) closeRoadmapPanel({focus:false});
      const params = new URLSearchParams(location.search);
      if (params.get('claim') || params.get('proposal')) updateQuery(null, null, 'push');
      openNode(nodeId, { focus: true, fromGraph: true });
    },
  });
  graphReady = true;
  try { window.__productContinuityGraph = graphApi; } catch { /* Optional host handle. */ }
  const timelineApi = helpers.initializeTimeline?.(bootstrap, helpers, {
    openTarget(target, trigger) {
      if (historySelection) return;
      if (busy) {
        setStatus('当前请求尚未结束；请等结果返回后再切换评审位置。', { focus: false });
        return;
      }
      saveDraft();
      if (target.type === 'claim') openClaim(target.id, { trigger });
      else if (target.type === 'proposal') openProposal(target.id, { trigger });
      else {
        syncGraphToNode(target.id);
        updateQuery(null, null, 'push');
        openNode(target.id, { trigger });
      }
    },
    async refresh() {
      // Read/update the timeline without restoring the panel or rebuilding the
      // editor. A changed digest still invalidates any stale preview normally.
      if (busy) throw new Error('当前请求尚未结束');
      try { await fetchState(); }
      catch (error) { handleError(error); throw error; }
    },
  });

  graphTimeApi = helpers.initializeGraphTime?.(bootstrap, {
    canNavigate() { return !busy; },
    async loadSnapshot(sample, signal) {
      const params = new URLSearchParams({version:String(sample.stateVersion),digest:sample.digest});
      try {
        const response = await fetch('/api/snapshot?' + params, {credentials:'same-origin',headers:{Accept:'application/json'},signal});
        const body = await response.json();
        if (!response.ok || body?.ok === false) {
          const error = new Error(body?.error?.message || '无法读取历史版本');
          error.status = response.status; error.code = body?.error?.code; error.body = body;
          throw error;
        }
        return body;
      } catch (error) {
        if (error.name !== 'AbortError' && error.status === 403) handleError(error);
        throw error;
      }
    },
    showLoading(sample) {
      if (!historySelection) {
        saveDraft(); currentGraphView = graphApi?.getViewState();
        currentPanelScroll = panel.scrollTop;
        currentCrossLinks = doc.querySelector('#graph-cross').checked;
      }
      historySelection = {sample,state:null,loading:true};
      setHistoryVisibility(true);
      if (roadmapPanel) roadmapPanel.hidden = true;
      doc.querySelector('#review-current').hidden = true;
      doc.querySelector('#history-panel').hidden = false;
      panel.setAttribute('aria-labelledby','history-panel-title');
      graphApi?.refresh(graphDataFromState(null),{updateUrl:false});
      showHistoryNode(null, '正在读取完整快照；当前草稿已保留，尚未显示历史树。');
      updateHeader(); updateSubmitEnabled();
    },
    showSnapshot(result) {
      historySelection = result;
      historyRoadmapItemId = null;
      graphApi?.refresh(graphDataFromState(result.state),{updateUrl:false,fit:true});
      showHistoryNode(graphApi?.getViewState().selectedId);
    },
    showUnavailable(sample) {
      historySelection = {sample,state:null,loading:false};
      graphApi?.refresh(graphDataFromState(null),{updateUrl:false});
      showHistoryNode(null,'历史版本缺失或无法核验，不显示其它树代替。可以重新选点或回到现在。');
    },
    showCurrent() {
      // A focused historical node will be replaced by refresh(). Its focus
      // restoration can auto-pan the newly restored current tree. Move focus
      // to the persistent time axis first, without recentering or scrolling.
      if (doc.activeElement?.closest?.('#history-panel,#graph-world .graph-node')) doc.querySelector('#graph-time-range')?.focus({preventScroll:true});
      historySelection = null;
      historyRoadmapItemId = null;
      setHistoryVisibility(false);
      const crossLinks = doc.querySelector('#graph-cross');
      crossLinks.checked = currentCrossLinks;
      crossLinks.dispatchEvent(new Event('change'));
      graphApi?.refresh(graphDataFromState(current.state),{updateUrl:true,view:currentGraphView});
      currentGraphView = null;
      doc.querySelector('#history-panel').hidden = true;
      doc.querySelector('#review-current').hidden = false;
      panel.setAttribute('aria-labelledby','review-panel-title');
      panel.scrollTop = currentPanelScroll;
      renderCurrentRoadmapPanel();
      renderRoadmapHosts();
      updateHeader(); updateSubmitEnabled();
      // A panel return button is removed from the focus tree in current mode.
      if (doc.activeElement?.closest?.('#history-panel')) doc.querySelector('#graph-time-range')?.focus({preventScroll:true});
    },
  });

  function setHistoryVisibility(historical) {
    // Keep current directories, counters and their action affordances out of the
    // historical surface. Disclosure/filter state and every editor node survive.
    doc.querySelector('#review-workspace .directory').hidden = historical;
    doc.querySelector('#product-timeline').hidden = historical;
    const entry = doc.querySelector('#graph-timeline');
    if (entry) entry.disabled = historical;
    if (renderViewButton) renderViewButton.disabled = historical;
  }

  function showHistoryNode(nodeId, message = '') {
    const host = doc.querySelector('#history-panel');
    const state = historySelection?.state, sample = historySelection?.sample;
    historyRoadmapItemId = null;
    renderRoadmapHosts();
    const heading = make('div',{class:'history-panel-head'},
      make('h2',{id:'history-panel-title',tabindex:'-1',text:`历史只读${sample ? ' · v' + sample.stateVersion : ''}`}),
      button('回到现在',{},() => { void graphTimeApi?.showCurrent(); doc.querySelector('#graph-time-range')?.focus({preventScroll:true}); }));
    host.replaceChildren(heading,paragraph('muted',message || '节点、意图、关系和证据均来自所选完整快照；不确认、不保存、不恢复主状态。'));
    if (!state) return;
    const node = asArray(state.nodes).find((item) => item.id === nodeId);
    if (!node) return;
    const planningItem = asArray(state.roadmapItems).find((item) => item.nodeId === nodeId);
    if (planningItem) host.append(button('查看当时的功能规划', {'data-roadmap-item':planningItem.id}));
    host.append(make('h3',{text:node.label}),badge(labels.kind[node.kind] || node.kind),paragraph('muted',node.description || node.id));
    const featureProgress = featureProgressElement(state, nodeId, { historical: true });
    if (featureProgress) host.append(featureProgress);
    for (const claim of asArray(state.intentClaims).filter((item) => item.nodeId === nodeId)) {
      host.append(make('h4',{text:labels.claimStatus[claim.status] || claim.status}),paragraph('',claim.statement));
      for (const [key,label] of [['scope','范围'],['conditions','条件'],['exceptions','例外']]) host.append(paragraph('muted',label + '：' + (asArray(claim[key]).join('；') || '未记录')));
    }
    const relations = asArray(state.edges).filter((edge) => edge.from === nodeId || edge.to === nodeId);
    host.append(make('h4',{text:'当时的关系'}),make('ul',{class:'intent-list'},...relations.map((edge) => {
      const otherId = edge.from === nodeId ? edge.to : edge.from;
      const other = asArray(state.nodes).find((item) => item.id === otherId);
      const direction = edge.from === nodeId ? '指向' : '来自';
      return make('li',{},button(`${direction} · ${bootstrap.graph?.edgeLabels?.[edge.kind] || edge.kind} · ${other?.label || otherId}`,{},() => graphApi?.selectNode(otherId,true)));
    })));
    const evidence = asArray(state.evidence).filter((item) => asArray(node.evidenceIds).includes(item.id));
    host.append(make('h4',{text:'当时关联的材料'}),make('ul',{class:'intent-list'},...evidence.map((item) => make('li',{text:`${item.kind} · ${item.validation || '未记录'} · ${item.claim || item.id}`}))));
    host.append(make('details',{},make('summary',{text:'所选快照的原始节点'}),make('pre',{text:JSON.stringify(node,null,2)})));
  }

  function roadmapViewFor(state) {
    if (typeof helpers.deriveRoadmap === 'function') return helpers.deriveRoadmap(state);
    return { schemaVersion: state?.schemaVersion ?? null, projectId: state?.project?.id ?? null, total: 0, byHorizon: { now: 0, next: 0, later: 0, unplanned: 0 }, byStatus: {}, items: [] };
  }

  function renderRoadmapHosts() {
    if (!roadmapHost) return;
    const counts = doc.querySelector('#roadmap-counts');
    const viewState = historySelection ? historySelection.state : current.state;
    const countView = roadmapViewFor(viewState);
    if (counts) counts.textContent = viewState ? `${historySelection ? '所选快照 · ' : ''}Now ${countView.byHorizon.now} · Next ${countView.byHorizon.next} · Later ${countView.byHorizon.later} · 未排期 ${countView.byHorizon.unplanned} · 共 ${countView.total} 项` : '所选快照的规划尚不可核验';
    if (historySelection) {
      const state = historySelection.state;
      if (!state) {
        roadmapHost.innerHTML = helpers.renderRoadmapIndex(null, {
          filter: roadmapFilter,
          mode: historySelection.loading ? 'loading' : 'unavailable',
        });
        return;
      }
      roadmapHost.innerHTML = helpers.renderRoadmapIndex(roadmapViewFor(state), {
        filter: roadmapFilter,
        historical: true,
        selectedId: historyRoadmapItemId,
        progress: featureProgressSummaryFor(state),
      });
      return;
    }
    roadmapHost.innerHTML = helpers.renderRoadmapIndex(roadmapViewFor(current.state), {
      filter: roadmapFilter,
      selectedId: currentRoadmapSelection,
      progress: featureProgressSummaryFor(current.state),
    });
  }

  function renderCurrentRoadmapPanel() {
    if (!roadmapPanel || !roadmapPanelBody) return;
    if (historySelection || (!currentRoadmapSelection && !roadmapIndexOpen)) {
      roadmapPanel.hidden = true;
      roadmapPanelBody.replaceChildren();
      if (!historySelection) doc.querySelector('#review-current').hidden = false;
      return;
    }
    const view = roadmapViewFor(current.state);
    const item = asArray(view.items).find((entry) => entry.id === currentRoadmapSelection);
    roadmapPanel.hidden = false;
    doc.querySelector('#review-current').hidden = true;
    panel.setAttribute('aria-labelledby','roadmap-panel-title');
    if (roadmapPanelTitle) roadmapPanelTitle.textContent = roadmapIndexOpen ? '功能规划 · 只读索引' : item ? `功能规划 · ${item.nodeLabel || item.nodeId}` : '功能规划详情';
    const detail = !roadmapIndexOpen && item ? featureProgressDetailFor(current.state, item.nodeId) : null;
    const progressHtml = detail && typeof helpers.renderFeatureProgressDetail === 'function'
      ? helpers.renderFeatureProgressDetail(detail, { historical: false })
      : '';
    roadmapPanelBody.innerHTML = roadmapIndexOpen
      ? helpers.renderRoadmapFilters() + helpers.renderRoadmapIndex(view, { filter: roadmapFilter, progress: featureProgressSummaryFor(current.state) })
      : helpers.renderRoadmapDetail(current.state, view, currentRoadmapSelection, { progressHtml });
    for (const control of roadmapPanelBody.querySelectorAll('[data-roadmap-filter]')) control.setAttribute('aria-pressed',String(control.dataset.roadmapFilter === roadmapFilter));
  }

  function setRoadmapFilter(value) {
    if (!['all', 'now', 'next', 'later', 'unplanned'].includes(value)) return;
    roadmapFilter = value;
    for (const control of doc.querySelectorAll('[data-roadmap-filter]')) {
      control.setAttribute('aria-pressed', String(control.dataset.roadmapFilter === value));
    }
    renderRoadmapHosts();
    if (roadmapIndexOpen) renderCurrentRoadmapPanel();
  }

  function closeRoadmapPanel(options = {}) {
    const itemId = currentRoadmapSelection;
    currentRoadmapSelection = null;
    roadmapIndexOpen = false;
    currentRoadmapTrigger = null;
    if (roadmapPanel) roadmapPanel.hidden = true;
    if (roadmapPanelBody) roadmapPanelBody.replaceChildren();
    doc.querySelector('#review-current').hidden = false;
    panel.setAttribute('aria-labelledby','review-panel-title');
    renderRoadmapHosts();
    if (options.focus === false) return;
    const itemButton = itemId ? doc.querySelector(`.roadmap-item[data-roadmap-item="${cssEscape(itemId)}"]`) : null;
    const visibleTrigger = panel.closest('.continuity-fullscreen-host') ? doc.querySelector('#graph-roadmap') : itemButton;
    (visibleTrigger || doc.querySelector('#graph-roadmap') || doc.querySelector('#roadmap-title'))?.focus({ preventScroll: true });
  }

  function openRoadmapItem(itemId, options = {}) {
    if (historySelection) { showHistoryRoadmapItem(itemId, options); return; }
    const view = roadmapViewFor(current.state);
    if (!asArray(view.items).some((entry) => entry.id === itemId)) {
      setStatus(`规划项 ${itemId} 不在当前状态中（可能已被离线规划替换）。`, { error: true, focus: true });
      return;
    }
    saveDraft();
    roadmapIndexOpen = false;
    currentRoadmapSelection = itemId;
    currentRoadmapTrigger = options.trigger ?? currentRoadmapTrigger;
    renderCurrentRoadmapPanel();
    renderRoadmapHosts();
    roadmapPanelTitle?.focus({ preventScroll: true });
  }

  function showHistoryRoadmapItem(itemId) {
    const host = doc.querySelector('#history-panel');
    const state = historySelection?.state, sample = historySelection?.sample;
    historyRoadmapItemId = itemId;
    renderRoadmapHosts();
    const heading = make('div',{class:'history-panel-head'},
      make('h2',{id:'history-panel-title',tabindex:'-1',text:`历史规划 · 只读${sample ? ' · v' + sample.stateVersion : ''}`}),
      button('回到现在',{},() => { void graphTimeApi?.showCurrent(); doc.querySelector('#graph-time-range')?.focus({preventScroll:true}); }));
    host.replaceChildren(heading,paragraph('muted','规划来自所选完整快照；只读查看，不显示现在的规划，不确认、不保存、不恢复主状态。'));
    const detailHost = make('div', { 'data-testid': 'history-roadmap-detail' });
    if (state) {
      const view = roadmapViewFor(state);
      const item = asArray(view.items).find((entry) => entry.id === itemId);
      const detail = item ? featureProgressDetailFor(state, item.nodeId) : null;
      const progressHtml = detail && typeof helpers.renderFeatureProgressDetail === 'function'
        ? helpers.renderFeatureProgressDetail(detail, { historical: true })
        : '';
      detailHost.innerHTML = helpers.renderRoadmapDetail(state, view, itemId, { historical: true, progressHtml });
    } else detailHost.append(paragraph('muted', '该历史版本不可核验，不能显示规划详情。'));
    host.append(detailHost);
    doc.querySelector('#history-panel-title')?.focus({ preventScroll: true });
  }

  function updateHeader() {
    const version = doc.querySelector('#review-version');
    const digest = doc.querySelector('#review-digest');
    const writable = doc.querySelector('#review-writable');
    const view = doc.querySelector('#review-view-status');
    const locationNode = doc.querySelector('#review-state-location');
    const identityNode = doc.querySelector('#review-state-identity');
    if (version) version.textContent = String(current.stateVersion ?? '');
    if (digest) digest.textContent = shortDigest(current.fileDigest);
    if (writable) {
      writable.textContent = historySelection ? '历史浏览 · 只读' : current.writable ? '可写' : `只读：${readOnlyText(current.readOnlyReason)}`;
      writable.dataset.writable = String(!historySelection && current.writable);
    }
    if (view) view.textContent = viewStatusText(current.viewStatus);
    if (locationNode) locationNode.textContent = stateLocation || '未记录';
    if (identityNode) identityNode.textContent = stateIdentity;
    const header = doc.querySelector('#review-header');
    if (header) {
      header.dataset.stateVersion = String(current.stateVersion);
      header.dataset.fileDigest = current.fileDigest;
      header.dataset.writable = String(!historySelection && current.writable);
    }
    if (renderViewButton) {
      const pendingView = viewStatusIsPending(current.viewStatus);
      renderViewButton.hidden = !pendingView;
    }
  }

  function markReadOnly(reason) {
    writeBlocked = true;
    current.writable = false;
    current.readOnlyReason = reason || current.readOnlyReason || 'read_only';
    updateHeader();
    renderDirectoryHosts();
    updateSubmitEnabled();
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

  function viewStatusIsPending(value) {
    if (!value) return false;
    const text = typeof value === 'string' ? value : `${value.status ?? ''} ${value.message ?? ''}`;
    return /pending|待更新|待生成/i.test(text);
  }

  function readOnlyText(reason) {
    if (!reason) return '未说明原因';
    const labels = {
      invalid_state: '状态文件校验失败',
      invalid_state_on_disk: '状态文件校验失败',
      state_unverifiable: '状态无法核验',
      hardlink_state: '状态文件存在硬链接，不能安全写入',
      read_only: '状态存储只读',
      migration_required: '0.1 状态需要显式迁移',
      schema_0_1_requires_migration: '0.1 状态需要显式迁移',
      state_not_found: '状态文件不存在',
      state_not_file: '状态路径不是普通文件',
      state_unreadable: '状态文件无法读取',
      invalid_utf8: '状态文件不是合法 UTF-8',
      external_modification: '检测到外部修改',
      lock_lost: '写锁丢失',
      write_unverified: '写入后未核验',
      commit_unknown: '提交结果未知',
      state_validation_failed: '服务生成状态校验失败',
      replaced_unverified: '替换后未核验',
      no_session: '会话失效',
      bad_origin: '来源校验失败',
      bad_host: 'Host 校验失败',
      history_not_verifiable: '历史不可核验',
    };
    return labels[reason] ? `${labels[reason]}（${reason}）` : reason;
  }

  function setStatus(message, options = {}) {
    if (options.error) {
      if (statusBox) statusBox.textContent = '';
      if (alertBox) {
        alertBox.hidden = false;
        alertBox.textContent = message;
        alertBox.dataset.code = options.code || '';
        if (options.focus) alertBox.focus({ preventScroll: true });
      }
      updateSubmitEnabled();
      return;
    }
    if (alertBox) { alertBox.hidden = true; alertBox.textContent = ''; }
    if (statusBox) {
      statusBox.textContent = message;
      statusBox.dataset.code = options.code || '';
      if (options.focus) statusBox.focus({ preventScroll: true });
    }
    updateSubmitEnabled();
  }

  function clearStatus() {
    if (statusBox) statusBox.textContent = '';
    if (alertBox) { alertBox.hidden = true; alertBox.textContent = ''; }
  }

  function focusPanelTitle() {
    if (window.matchMedia && window.matchMedia('(max-width: 1100px)').matches) panelTitle.focus();
    else panelTitle.focus({ preventScroll: true });
  }

  function setBusy(value) {
    busy = value;
    panelBody.setAttribute('aria-busy', String(value));
    updateSubmitEnabled();
  }

  function targetKey(target, includeMode = false) {
    if (!target) return '';
    if (target.type === 'proposal') return `proposal:${target.proposalId}${includeMode ? `:${target.mode || 'view'}` : ''}`;
    return `claim:${target.claimId}${includeMode ? `:${target.mode || 'view'}` : ''}`;
  }

  function storageBase(kind) {
    return 'product-continuity:review:' + kind + ':' + encodeURIComponent(projectId) + ':' + encodeURIComponent(stateIdentity) + ':';
  }

  function draftKey(target) {
    return storageBase('draft') + encodeURIComponent(targetKey(target, true));
  }

  function lastModeKey(target) {
    const key = target.type === 'proposal' ? `proposal:${target.proposalId}` : `claim:${target.claimId}`;
    return storageBase('mode') + encodeURIComponent(key);
  }

  function rememberMode(target, mode) {
    if (!target || !mode || mode === 'view') return;
    try { sessionStorage.setItem(lastModeKey(target), mode); } catch { /* ignore */ }
  }

  function rememberedMode(target) {
    try { return sessionStorage.getItem(lastModeKey(target)); } catch { return null; }
  }

  function clearRememberedMode(target) {
    try { sessionStorage.removeItem(lastModeKey(target)); } catch { /* ignore */ }
  }

  function loadDraft(target) {
    try {
      const raw = sessionStorage.getItem(draftKey(target));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed?.mode !== target.mode) return null;
      return parsed.fields ?? null;
    } catch {
      return null;
    }
  }

  function saveDraft() {
    if (!activeDraftCapture || !panelTarget || panelTarget.type === 'node') return;
    try {
      sessionStorage.setItem(draftKey(panelTarget), JSON.stringify({
        mode: panelTarget.mode,
        fields: activeDraftCapture(),
        savedAt: new Date().toISOString(),
      }));
    } catch { /* Session storage can be unavailable; the form still works. */ }
  }

  function clearDraft(target) {
    try { sessionStorage.removeItem(draftKey(target)); } catch { /* ignore */ }
    clearRememberedMode(target);
  }

  function findPending() {
    try {
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const key = sessionStorage.key(index);
        if (!key || !key.startsWith(storageBase('pending'))) continue;
        const parsed = JSON.parse(sessionStorage.getItem(key));
        if (parsed?.projectId === projectId) return { key, ...parsed };
      }
    } catch { /* ignore */ }
    return null;
  }

  function savePending(value) {
    try { sessionStorage.setItem(value.key, JSON.stringify(value)); } catch { /* ignore */ }
  }

  function clearPending() {
    if (!pending) return;
    try { sessionStorage.removeItem(pending.key); } catch { /* ignore */ }
    pending = null;
    if (pendingBanner) { pendingBanner.hidden = true; pendingBanner.replaceChildren(); }
  }

  function pendingKey(target) {
    return storageBase('pending') + encodeURIComponent(targetKey(target));
  }

  function showPendingBanner() {
    if (!pendingBanner) return;
    if (!pending) {
      pendingBanner.hidden = true;
      pendingBanner.replaceChildren();
      return;
    }
    pendingBanner.hidden = false;
    pendingBanner.replaceChildren();
    pendingBanner.dataset.state = '';
    pendingBanner.append(make('strong', { text: '未决提交（仅本标签保存）' }));
    const review = asArray(current.state?.reviews).find((item) => item.idempotencyKey === pending.request?.idempotencyKey);
    if (review) {
      pending.knownReviewId = review.id;
      pending.lastObservedVersion = current.stateVersion;
      savePending(pending);
      pendingBanner.append(make('p', { class: 'muted', text: `状态文件中已有原提交记录（${review.id}，版本 ${review.resultingStateVersion}）。` }));
      if (writeBlocked) {
        pendingBanner.append(make('p', { class: 'muted', text: '当前已停写；即使能查到原记录，也不会执行写重试。请人工核对后再刷新页面。' }));
      } else {
        pendingBanner.append(make('p', { class: 'muted', text: '可显示重放结果，不会新增记录。' }));
        pendingBanner.append(button('查看重放结果', { class: 'btn btn-secondary', 'data-testid': 'retry-pending' }, retryPending));
      }
    } else if (pending.knownReviewId) {
      writeBlocked = true;
      pendingBanner.append(make('p', { class: 'muted', text: `已知原提交 ${pending.knownReviewId} 在当前状态中找不到；历史不可核验，已停写。请人工核对状态、备份与 review，不要一键重放。` }));
      pendingBanner.dataset.state = 'history_not_verifiable';
    } else if (writeBlocked) {
      pendingBanner.append(make('p', { class: 'muted', text: '当前会话已停写；未决请求只能保留供人工核对，不提供自动重放。请刷新页面或按终端记录核对。' }));
      pendingBanner.dataset.state = 'write_blocked';
    } else if (current.stateVersion < pending.expectedStateVersion) {
      writeBlocked = true;
      pendingBanner.append(make('p', { class: 'muted', text: `当前状态版本 ${current.stateVersion} 低于提交前记录 ${pending.expectedStateVersion}；历史不可核验，已停写。请人工核对状态、备份与 review，不要一键重放。` }));
      pendingBanner.dataset.state = 'history_not_verifiable';
    } else if (current.stateVersion > pending.expectedStateVersion) {
      writeBlocked = true;
      pendingBanner.append(make('p', { class: 'muted', text: `状态版本已从 ${pending.expectedStateVersion} 变为 ${current.stateVersion}，但找不到原提交记录；历史不可核验，已停写。请人工核对，不要一键重放。` }));
      pendingBanner.dataset.state = 'history_not_verifiable';
    } else {
      pendingBanner.append(make('p', { class: 'muted', text: '上次提交没有已知结果。只能重试原请求（同一把 key、同一份内容）；不要生成新 key。' }));
      pendingBanner.append(button('重试原请求', { class: 'btn btn-primary', 'data-testid': 'retry-pending' }, retryPending));
    }
    updateSubmitEnabled();
  }

  function inspectPending() {
    pending = findPending();
    if (!pending) { showPendingBanner(); return; }
    showPendingBanner();
  }

  function updateSubmitEnabled() {
    const checkboxes = [...panelBody.querySelectorAll('[data-attestation], [data-local-attestation]')];
    const unchecked = checkboxes.some((box) => !box.checked);
    for (const submit of panelBody.querySelectorAll('[data-submit]')) {
      const needsPreview = submit.dataset.preview === '1';
      submit.disabled = Boolean(historySelection) || busy || writeBlocked || (needsPreview && !previewState) || (needsPreview && unchecked);
    }
    for (const trigger of panelBody.querySelectorAll('[data-preview-generate]')) trigger.disabled = Boolean(historySelection) || busy || writeBlocked;
  }

  function invalidatePreview(message) {
    if (!previewState) return;
    previewState = null;
    panelBody.querySelector('#preview-block')?.remove();
    updateSubmitEnabled();
    if (message) setStatus(message, { focus: false });
  }

  function onFormActivity(event) {
    if (event?.target?.closest?.('[data-attestation], [data-local-attestation]')) {
      updateSubmitEnabled();
      return;
    }
    formRevision += 1;
    if (previewState) invalidatePreview('内容已修改，预览已失效并清空勾选；请重新生成预览。');
    saveDraft();
    updateSubmitEnabled();
  }

  panelBody.addEventListener('input', onFormActivity);
  panelBody.addEventListener('change', onFormActivity);

  function field(labelText, control, hint) {
    panelSeq += 1;
    const id = control.id || `review-field-${panelSeq}`;
    control.id = id;
    const wrapper = make('div', { class: 'field' }, make('label', { for: id, text: labelText }), control);
    if (hint) wrapper.append(make('p', { class: 'field-hint', text: hint }));
    return wrapper;
  }

  function clearFieldErrors() {
    for (const control of panelBody.querySelectorAll('[aria-invalid="true"]')) {
      control.removeAttribute('aria-invalid');
      control.removeAttribute('aria-describedby');
    }
    for (const error of panelBody.querySelectorAll('.field-error')) {
      error.hidden = true;
      error.textContent = '';
    }
  }

  function setFieldError(control, message) {
    const wrapper = control.closest('.field') || control.parentElement;
    if (!wrapper) return;
    let error = wrapper.querySelector('.field-error');
    if (!error) {
      error = make('p', { class: 'field-error' });
      error.id = (control.id || `control-${++panelSeq}`) + '-error';
      wrapper.append(error);
    }
    error.textContent = message;
    error.hidden = false;
    control.setAttribute('aria-invalid', 'true');
    control.setAttribute('aria-describedby', error.id);
  }

  function applyValidation(errors) {
    clearFieldErrors();
    if (!errors.length) return false;
    for (const item of errors) setFieldError(item.control, item.message);
    setStatus(`请先修正表单：${errors[0].message}`, { error: true, focus: true });
    if (alertBox) {
      const firstInvalid = errors[0].control;
      alertBox.append(' ', button('转到第一个错误字段', { class: 'link-button', 'data-testid': 'field-error-link' }, () => firstInvalid.focus({ preventScroll: true })));
    }
    return true;
  }

  function arrayEditor(labelText, values, options = {}) {
    panelSeq += 1;
    const prefix = options.idPrefix || `array-${panelSeq}`;
    const list = make('div', { class: 'array-rows' });
    const fieldset = make('fieldset', { class: 'array-editor' }, make('legend', { text: labelText }), list);
    const inputs = [];
    let nextIndex = 0;
    const max = options.max ?? 20;
    function addRow(value) {
      if (inputs.length >= max) return null;
      const index = nextIndex++;
      const input = make('input', { type: 'text', id: `${prefix}-${index}`, maxlength: '1000' });
      input.value = value ?? '';
      const inputField = make('div', { class: 'field array-field' }, make('label', { for: input.id, class: 'visually-hidden', text: `${labelText}第 ${index + 1} 项` }), input);
      const remove = button('删除', { class: 'btn btn-small', 'aria-label': `删除${labelText}第 ${index + 1} 项` }, () => {
        const at = inputs.indexOf(input);
        if (at >= 0) inputs.splice(at, 1);
        row.remove();
        onFormActivity();
      });
      const row = make('div', { class: 'array-row' }, inputField, remove);
      inputs.push(input);
      list.append(row);
      return input;
    }
    for (const value of asArray(values)) addRow(value);
    const add = button('添加一项', { class: 'btn btn-secondary' }, () => {
      const input = addRow('');
      if (input) { input.focus(); onFormActivity(); }
    });
    fieldset.append(add, make('p', { class: 'field-hint', text: '每项最多 1000 字符；按原文本保存，不会自动 trim。' }));
    return {
      element: fieldset,
      inputs,
      read() { return inputs.map((input) => input.value); },
      ensureRow() { if (!inputs.length) addRow(''); return inputs[0]; },
      validate() {
        const errors = [];
        if (inputs.length > max) errors.push({ control: inputs[max] ?? add, message: `${labelText}最多 ${max} 项。` });
        for (const input of inputs) {
          if (!input.value.trim()) errors.push({ control: input, message: `${labelText}不能有空项。` });
          else if (input.value.length > 1000) errors.push({ control: input, message: `${labelText}每项最多 1000 字符。` });
        }
        return errors;
      },
    };
  }

  function contentEditor(initial = {}, options = {}) {
    panelSeq += 1;
    const prefix = options.idPrefix || `content-${panelSeq}`;
    const statement = make('textarea', { id: `${prefix}-statement`, rows: '4', maxlength: '2000' });
    statement.value = initial.statement ?? '';
    const scope = arrayEditor('适用范围', initial.scope, { idPrefix: `${prefix}-scope` });
    const conditions = arrayEditor('条件', initial.conditions, { idPrefix: `${prefix}-conditions` });
    const exceptions = arrayEditor('例外', initial.exceptions, { idPrefix: `${prefix}-exceptions` });
    const element = make('div', { class: 'content-editor' },
      field('声明', statement, '1–2000 字符；空行和前后空白会按原样提交并在服务端校验。'),
      scope.element, conditions.element, exceptions.element,
    );
    if (options.requireScope) element.append(make('p', { class: 'field-hint', text: '这条动作至少需要一项适用范围。' }));
    return {
      element, statement, scope, conditions, exceptions,
      read() {
        return { statement: statement.value, scope: scope.read(), conditions: conditions.read(), exceptions: exceptions.read() };
      },
      validate() {
        const errors = [];
        if (!statement.value.trim()) errors.push({ control: statement, message: '声明不能为空。' });
        else if (statement.value.length > 2000) errors.push({ control: statement, message: '声明最多 2000 字符。' });
        errors.push(...scope.validate(), ...conditions.validate(), ...exceptions.validate());
        if (options.requireScope && scope.read().length === 0) {
          const input = scope.ensureRow();
          errors.push({ control: input, message: '至少需要一项适用范围。' });
        }
        return errors;
      },
      focusFirst() { statement.focus({ preventScroll: true }); },
    };
  }

  function assessmentEditor(initial = {}, options = {}) {
    panelSeq += 1;
    const select = make('select', { id: `assessment-${panelSeq}` },
      make('option', { value: 'unreviewed', text: '未审阅（unreviewed）' }),
      make('option', { value: 'single', text: '可独立决定（single）' }),
      make('option', { value: 'needs_split', text: '需要拆分（needs_split）' }),
    );
    select.value = initial.disposition || 'unreviewed';
    const elements = [field('准备判断', select, '这只是准备判断，不等于确认。')];
    let legacy = null;
    if (options.hasLegacy) {
      legacy = make('input', { type: 'checkbox', id: `assessment-legacy-${panelSeq}` });
      legacy.checked = initial.reviewedLegacyContext === true;
      elements.push(make('label', { class: 'check' }, legacy, make('span', { text: '已核对该节点的 0.1 历史材料（reviewedLegacyContext）' })));
    }
    return {
      element: make('div', { class: 'assessment-editor' }, ...elements),
      read() {
        return { disposition: select.value, reviewedLegacyContext: legacy ? legacy.checked : initial.reviewedLegacyContext === true };
      },
    };
  }

  function legacyInfo(node) {
    const snapshot = node?.legacy?.snapshot;
    const decisionId = typeof snapshot?.decisionId === 'string' && snapshot.decisionId ? snapshot.decisionId : null;
    const legacyConditions = asArray(snapshot?.conditions);
    const hasMaterial = Boolean(snapshot) && Boolean(decisionId || legacyConditions.length);
    if (!hasMaterial) return { material: null, decision: null, bindings: [], activeClaimIds: [], shared: false };
    const decision = decisionId ? decisionById(decisionId) : undefined;
    const bindingNodeIds = decisionId ? asArray(current.state?.nodes).filter((item) => item?.legacy?.snapshot?.decisionId === decisionId).map((item) => item.id) : [];
    const activeClaimIds = asArray(current.state?.intentClaims).filter((claim) => bindingNodeIds.includes(claim.nodeId) && (claim.status === 'candidate' || claim.status === 'confirmed')).map((claim) => claim.id);
    return {
      material: snapshot,
      decision: decision && decision.recordVersion !== '0.2' && decision.status === 'confirmed' ? decision : null,
      bindings: bindingNodeIds,
      activeClaimIds,
      shared: bindingNodeIds.length > 1 || activeClaimIds.length > 1,
    };
  }

  function evidenceForNode(node) {
    const evidence = new Map(asArray(current.state?.evidence).map((item) => [item.id, item]));
    return asArray(node?.evidenceIds).map((id) => evidence.get(id)).filter(Boolean);
  }

  function listOrEmpty(items, empty, emptyNote) {
    if (!items.length) return [make('p', { class: 'muted', text: empty }), emptyNote ? make('p', { class: 'muted', text: emptyNote }) : null].filter(Boolean);
    return [make('ul', { class: 'intent-list' }, ...items.map((item) => make('li', { text: item })))];
  }

  function fullContentElement(content, title) {
    const wrapper = make('div', { class: 'intent-content' });
    if (title) wrapper.append(make('h5', { text: title }));
    wrapper.append(make('dl', { class: 'intent-fields' },
      make('dt', { text: '声明' }), make('dd', {}, make('p', { class: 'intent-statement', text: content?.statement ?? '未记录声明' })),
      make('dt', { text: '适用范围' }), make('dd', {}, ...listOrEmpty(asArray(content?.scope), '未记录适用范围')),
      make('dt', { text: '条件' }), make('dd', {}, ...listOrEmpty(asArray(content?.conditions), '未记录条件', '未记录不等于无条件适用。')),
      make('dt', { text: '例外' }), make('dd', {}, ...listOrEmpty(asArray(content?.exceptions), '未记录例外')),
    ));
    return wrapper;
  }

  function contentDiffElement(beforeContent, afterContent, title) {
    const wrapper = make('div', { class: 'content-diff' });
    wrapper.append(make('h4', { text: title || '完整四字段对照' }));
    const columns = make('div', { class: 'diff-columns' },
      make('div', { class: 'diff-column' }, fullContentElement(beforeContent, '原文')),
      make('div', { class: 'diff-column' }, fullContentElement(afterContent, '拟议')),
    );
    wrapper.append(columns);
    const changes = [];
    if ((beforeContent?.statement ?? '') !== (afterContent?.statement ?? '')) {
      changes.push({ kind: 'changed', label: '修改', field: '声明', before: beforeContent?.statement ?? '', after: afterContent?.statement ?? '' });
    }
    for (const field of ['scope', 'conditions', 'exceptions']) {
      const before = asArray(beforeContent?.[field]);
      const after = asArray(afterContent?.[field]);
      for (const item of after) if (!before.includes(item)) changes.push({ kind: 'added', label: '新增', field, text: item });
      for (const item of before) if (!after.includes(item)) changes.push({ kind: 'removed', label: '删除', field, text: item });
    }
    const list = make('div', { class: 'diff-list', 'data-testid': 'preview-field-diff' });
    if (!changes.length) list.append(make('p', { class: 'muted', text: '四字段文本无变化。' }));
    else {
      const fieldNames = { scope: '适用范围', conditions: '条件', exceptions: '例外' };
      for (const change of changes) {
        const text = change.kind === 'changed'
          ? `声明：原文「${change.before}」→ 拟议「${change.after}」`
          : `${fieldNames[change.field] ?? change.field}：${change.text}`;
        list.append(make('div', { class: `diff-row diff-${change.kind}` },
          make('span', { class: 'diff-label', text: change.label }),
          make('span', { text }),
        ));
      }
    }
    wrapper.append(list);
    return wrapper;
  }

  function impactElement(plan) {
    const before = plan?.before?.state ?? {};
    const after = plan?.after?.state ?? {};
    const beforeClaims = new Map(asArray(before.intentClaims).map((claim) => [claim.id, claim]));
    const beforeDecisions = new Set(asArray(before.decisions).map((decision) => decision.id));
    const beforeEvidence = new Set(asArray(before.evidence).map((item) => item.id));
    const beforeProposals = new Map(asArray(before.proposals).map((proposal) => [proposal.id, proposal]));
    const newClaims = asArray(after.intentClaims).filter((claim) => !beforeClaims.has(claim.id));
    const changedClaims = asArray(after.intentClaims).filter((claim) => {
      const old = beforeClaims.get(claim.id);
      return old && (old.status !== claim.status || old.governingDecisionId !== claim.governingDecisionId || old.retiredByDecisionId !== claim.retiredByDecisionId);
    });
    const newDecisions = asArray(after.decisions).filter((decision) => !beforeDecisions.has(decision.id));
    const newEvidence = asArray(after.evidence).filter((item) => !beforeEvidence.has(item.id));
    const changedProposals = asArray(after.proposals).filter((proposal) => {
      const old = beforeProposals.get(proposal.id);
      return old && old.status !== proposal.status;
    });
    const changedNodes = asArray(after.nodes).filter((node) => {
      const old = asArray(before.nodes).find((item) => item.id === node.id);
      return old && old.status !== node.status;
    });
    const items = [];
    if (newClaims.length) items.push(`新增意图记录 ${newClaims.length} 条（新动作产生的 candidate/confirmed 记录按动作本身决定）。`);
    if (changedClaims.length) items.push(`改变意图状态 ${changedClaims.length} 条：${changedClaims.map((claim) => `${claim.id} → ${claim.status}`).join('、')}。`);
    if (newDecisions.length) items.push(`新增产品决定 ${newDecisions.length} 条。`);
    if (newEvidence.length) items.push(`新增 decision_record 来源证据 ${newEvidence.length} 条。`);
    if (changedProposals.length) items.push(`改变修改提案状态 ${changedProposals.length} 条。`);
    if (changedNodes.length) items.push(`重算节点状态 ${changedNodes.length} 个。`);
    if (!items.length) items.push('没有新增或改变 claim、决定或提案记录。');
    items.push('不改实现证据、测试定义/执行、运行时观察、其它节点或意图。');
    const wrapper = make('div', { class: 'impact-list', 'data-testid': 'preview-impact' });
    wrapper.append(make('h4', { text: '影响清单' }));
    wrapper.append(make('ul', { class: 'intent-list' }, ...items.map((item) => make('li', { text: item }))));
    if (asArray(plan?.unchanged).length) {
      wrapper.append(make('details', { class: 'internal-ids' },
        make('summary', { text: '服务端未改变项（技术清单）' }),
        make('ul', { class: 'intent-list' }, ...asArray(plan.unchanged).map((item) => make('li', { text: item }))),
      ));
    }
    return wrapper;
  }

  const attestationLabels = {
    coverageAttested: '这些候选共同覆盖原意图，没有悄悄删掉部分含义。',
    confirmationAttested: '我只确认当前完整展示的这条意图。',
    singleIntentAttested: '我把 replacement 视为一条可独立决定的意图。',
    changeScopeAttested: '我接受预览中展示的范围、条件与例外变化。',
    stopAttested: '我确认停止要求这项行为。',
    'legacyResolution.fullRestatementAttested': '我完整重申并替代这条 0.1 旧决定。',
  };

  function attestationsElement(attestations) {
    const wrapper = make('fieldset', { class: 'attestations', 'data-testid': 'preview-attestations' });
    wrapper.append(make('legend', { text: '提交前精确勾选' }));
    if (!attestations.length) wrapper.append(make('p', { class: 'muted', text: '这个动作没有额外确认勾选；保存按钮会说明后果。' }));
    for (const name of attestations) {
      const id = 'attestation-' + name.replaceAll('.', '-');
      const checkbox = make('input', { type: 'checkbox', id, 'data-attestation': name });
      const label = make('label', { class: 'check', for: id }, checkbox, make('span', { text: attestationLabels[name] ?? name }));
      wrapper.append(label);
    }
    return wrapper;
  }

  function chosenAttestations() {
    const result = {};
    for (const checkbox of panelBody.querySelectorAll('[data-attestation]')) {
      if (!checkbox.checked) continue;
      const name = checkbox.dataset.attestation;
      if (name.startsWith('legacyResolution.')) {
        result.legacyResolution = result.legacyResolution || {};
        result.legacyResolution[name.slice('legacyResolution.'.length)] = true;
      } else {
        result[name] = true;
      }
    }
    return result;
  }

  function previewElement(preview, context) {
    const wrapper = make('div', { class: 'preview-block', id: 'preview-block', 'data-testid': 'preview-block' });
    wrapper.append(make('h4', { id: 'preview-title', tabindex: '-1', text: '预览 · 提交前核对' }));
    wrapper.append(make('p', { class: 'muted', text: '以下计划由服务端生成；任何编辑或状态版本变化都会使预览与勾选失效。' }));
    const beforeClaim = context.claim;
    const afterContent = preview.plan?.confirmation?.intent;
    if (context.action === 'confirm_candidate' || context.action === 'accept_proposal') {
      wrapper.append(contentDiffElement(beforeClaim, afterContent, context.action === 'accept_proposal' ? '接受修改：原文与拟议' : '确认：原文与拟议'));
    } else if (context.action === 'split_candidate') {
      wrapper.append(contentDiffElement(beforeClaim, beforeClaim, '原候选（拆分后标记为历史）'));
      const items = asArray(context.items);
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        wrapper.append(contentDiffElement(beforeClaim, item.content, `拆分候选 ${index + 1}：原候选与拟议`));
        wrapper.append(make('p', { class: 'muted', text: `候选 ${index + 1} 准备判断：${labels.disposition[item.assessment?.disposition] ?? item.assessment?.disposition}` }));
      }
    } else {
      wrapper.append(contentDiffElement(beforeClaim, beforeClaim, context.action === 'retire_claim' ? '停止：原意图文本保持不变' : '撤回：候选文本保持不变'));
      wrapper.append(make('p', { class: 'notice', text: context.action === 'retire_claim' ? '停止要求这项行为；不会删除实现或改变业务代码。' : '撤回候选提取，不是停止产品行为，也不改变任何决定。' }));
    }
    wrapper.append(impactElement(preview.plan));
    wrapper.append(attestationsElement(asArray(preview.attestations)));
    const localCheckbox = make('input', { type: 'checkbox', id: 'local-confirm', 'data-local-attestation': 'reviewed' });
    if (context.action === 'discard_candidate') {
      wrapper.append(make('label', { class: 'check', for: 'local-confirm' }, localCheckbox, make('span', { text: '我确认这是撤回候选提取，不是停止产品行为。' })));
    } else {
      localCheckbox.remove();
    }
    const submitLabel = {
      split_candidate: '保存拆分候选（仍待确认）',
      discard_candidate: '撤回这条候选',
      confirm_candidate: '只确认这一条完整意图',
      accept_proposal: '接受这次修改',
      retire_claim: '停止这项行为',
    }[context.action] ?? '保存';
    const submit = button(submitLabel, { class: 'btn btn-primary', 'data-submit': '1', 'data-preview': '1', 'data-testid': `submit-${context.action}` }, () => submitPreviewAction(context));
    wrapper.append(make('div', { class: 'action-row' }, submit));
    wrapper.append(make('details', { class: 'internal-ids' }, make('summary', { text: '预览摘要' }), make('code', { text: preview.digest })));
    previewState = { ...preview, action: context.action, context };
    updateSubmitEnabled();
    return wrapper;
  }

  function actionNote(text) {
    return make('p', { class: 'save-note', text });
  }

  function draftNote() {
    return make('p', { class: 'field-hint', text: '草稿仅保存在本标签的 sessionStorage；成功保存后清除。' });
  }

  function panelHeaderForClaim(claim, node) {
    const summary = claimSummary(claim);
    const capture = asArray(state.conversationCaptures).find((c) => c.id === claim.conversationSource?.captureId);
    const item = capture?.items?.[claim.conversationSource?.itemIndex];
    const source = item ? make('details', { class: 'panel-section conversation-source' },
      make('summary', { text: `会话来源 · ${{ user_statement: '用户原话', assistant_suggestion: '助手建议', assistant_report: '助手报告（未经执行验证）' }[item.basis]}` }),
      make('blockquote', { text: item.source.quote }),
      make('p', { class: 'muted', text: '提取内容仍为候选；来源核验不等于用户确认。' }),
      make('p', { text: item.conflictsWithClaimIds.length ? `与已确认意图有冲突：${item.conflictsWithClaimIds.join('、')}` : '未显式标注冲突；不代表自动检测过所有冲突。' }),
      make('code', { text: `${item.source.sessionId} / ${item.source.messageId}` }),
    ) : make('span');
    return make('header', { class: 'panel-intent-head' },
      make('p', { class: 'eyebrow', text: `${labels.kind[node?.kind] ?? node?.kind ?? '节点'} · ${node?.label ?? claim.nodeId}` }),
      make('div', { class: 'badges' },
        badge(labels.claimStatus[claim.status] ?? claim.status, claim.status),
        badge(`准备：${labels.disposition[claim.assessment?.disposition] ?? '未审阅'}`),
        badge(`来源：${labels.origin[claim.origin] ?? claim.origin ?? '未记录'}`),
        badge(`本节点现行意图 ${summary.x}/${summary.y}`),
      ),
      make('p', { class: 'muted', text: `内部 ID 默认折叠。记录创建于 ${claim.createdAt ?? '未记录'}。` }),
      source,
    );
  }

  function panelHeaderForProposal(proposal, claim, node) {
    return make('header', { class: 'panel-intent-head' },
      make('p', { class: 'eyebrow', text: `修改提案 · ${node?.label ?? claim?.nodeId ?? ''}` }),
      make('div', { class: 'badges' },
        badge(labels.proposalStatus[proposal.status] ?? proposal.status, proposal.status),
        badge(`目标意图：${claim?.statement ? claim.statement.slice(0, 80) : '未记录'}`),
      ),
      make('p', { class: 'muted', text: '接受提案会创建新 claim 与 adopt 决定；拒绝只关闭提案，不停止现行行为。' }),
    );
  }

  function evidenceSection(node) {
    const evidence = evidenceForNode(node).filter((item) => !['test_definition', 'test_execution', 'runtime_observation'].includes(item.kind));
    const details = make('details', { class: 'panel-section collapsible', 'data-testid': 'node-evidence' });
    details.append(make('summary', { text: `实现证据（节点级非验证材料，${evidence.length}）` }));
    details.append(make('p', { class: 'muted', text: '节点级相关证据不等于本条意图的独立证明；确认只新增 decision_record。' }));
    if (!evidence.length) details.append(make('p', { class: 'muted', text: '未记录节点级证据。' }));
    else {
      const ul = make('ul', { class: 'intent-list' });
      for (const item of evidence) {
        ul.append(make('li', {},
          make('strong', { text: `${item.kind.replaceAll('_', ' ')}：` }),
          make('span', { text: item.claim ?? '' }),
          make('span', { class: 'muted', text: ` · ${item.path ?? '未记录路径'}${item.locator ? ` · ${item.locator}` : ''} · ${item.validation ?? ''}` }),
        ));
      }
      details.append(ul);
    }
    return details;
  }

  function verificationSection(node) {
    const evidence = evidenceForNode(node);
    const groups = [
      ['test_definition', '测试定义'],
      ['test_execution', '测试执行'],
      ['runtime_observation', '运行时观察'],
    ];
    const details = make('details', { class: 'panel-section collapsible', 'data-testid': 'node-verification' });
    details.append(make('summary', { text: '验证情况（定义 / 执行 / 运行时分开）' }));
    for (const [kind, label] of groups) {
      const items = evidence.filter((item) => item.kind === kind);
      details.append(make('h5', { text: label }));
      if (!items.length) details.append(make('p', { class: 'muted', text: '未记录。' }));
      else details.append(make('ul', { class: 'intent-list' }, ...items.map((item) => make('li', { text: `${item.claim ?? ''}${item.path ? ` · ${item.path}` : ''}${item.validation ? ` · ${item.validation}` : ''}` }))));
    }
    return details;
  }

  function historySection(claim, node) {
    const details = make('details', { class: 'panel-section collapsible', 'data-testid': 'node-history' });
    details.append(make('summary', { text: '未决与历史材料' }));
    const info = legacyInfo(node);
    if (info.decision) {
      details.append(make('h5', { text: '旧决定（0.1，尚未对齐）' }));
      details.append(make('p', {}, make('strong', { text: info.decision.statement ?? '' }), make('span', { class: 'muted', text: ` · ${info.decision.status ?? ''}` })));
      details.append(make('p', { class: 'muted', text: info.decision.applicability ?? '适用范围未记录' }));
      details.append(make('p', { class: 'muted', text: `确认：${info.decision.confirmedAt ?? '未记录'} · ${info.decision.confirmedBy ?? '未记录'} · 绑定节点 ${info.bindings.length} 个 · 当前 active claim ${info.activeClaimIds.length} 条` }));
      details.append(make('p', { class: 'notice', text: info.shared ? '该旧决定覆盖多个节点或意图。首版不能只确认其中一条来局部替代；请暂缓并人工核对，或保留为待对齐历史。' : '该旧决定只覆盖当前节点的一条 active claim；确认时可显式选择完整重申并替代。' }));
    } else if (node?.legacy?.snapshot) {
      details.append(make('p', { class: 'muted', text: '该节点保留了 0.1 历史快照；没有待对齐的 confirmed 旧决定。' }));
    }
    const unclassified = [...new Set([
      ...asArray(node?.conditions),
      ...asArray(node?.legacy?.snapshot?.conditions),
    ])];
    if (unclassified.length) {
      details.append(make('h5', { text: '未归类材料（历史备注）' }));
      details.append(make('p', { class: 'muted', text: '这些节点材料未自动升级为意图条件。' }));
      details.append(make('ul', { class: 'intent-list' }, ...unclassified.map((item) => make('li', { text: item }))));
    }
    const predecessors = asArray(claim.supersedesClaimIds);
    const successors = asArray(claim.supersededByClaimIds);
    if (predecessors.length || successors.length) {
      details.append(make('h5', { text: '意图替代链' }));
      if (predecessors.length) details.append(make('p', { class: 'muted', text: `替代了：${predecessors.join('、')}` }));
      if (successors.length) details.append(make('p', { class: 'muted', text: `被以下意图替代：${successors.join('、')}` }));
    }
    if (claim.governingDecisionId) details.append(make('p', { class: 'muted', text: `现行决定：${claim.governingDecisionId}` }));
    if (claim.retiredByDecisionId) details.append(make('p', { class: 'muted', text: `停止决定：${claim.retiredByDecisionId}` }));
    const relatedDecisions = asArray(current.state?.decisions).filter((decision) =>
      decision.id === claim.governingDecisionId
      || decision.id === claim.retiredByDecisionId
      || asArray(decision.claimIds).includes(claim.id));
    if (relatedDecisions.length) {
      details.append(make('h5', { text: '相关产品决定（含历史）' }));
      const list = make('ul', { class: 'intent-list' });
      for (const decision of relatedDecisions) {
        list.append(make('li', {},
          make('strong', { text: `${decision.kind ?? decision.recordVersion ?? '决定'} · ${decision.status ?? ''}` }),
          make('span', { text: `：${decision.statement ?? decision.intent?.statement ?? ''}` }),
          make('span', { class: 'muted', text: ` · ${decision.applicability ?? ''}${decision.confirmedAt ? ` · ${decision.confirmedAt}` : ''}` }),
        ));
      }
      details.append(list);
    }
    const open = openProposalForClaim(claim.id);
    if (open) details.append(make('p', { class: 'notice', text: `存在待处理修改提案 ${open.id}；同一 claim 不能同时提出第二条。` }));
    return details;
  }

  function openNode(nodeId, options = {}) {
    if (historySelection) return;
    const node = nodeById(nodeId);
    if (!node) { showMissingTarget('节点', nodeId); return; }
    formRevision += 1;
    panelTarget = { type: 'node', nodeId, trigger: options.trigger ?? panelTarget?.trigger };
    activeDraftCapture = null;
    previewState = null;
    panelTitle.textContent = node.label ?? node.id;
    panelBody.replaceChildren();
    const wrapper = make('article', { class: 'panel-node', 'data-testid': 'node-panel' });
    wrapper.append(make('p', { class: 'eyebrow', text: labels.kind[node.kind] ?? node.kind }));
    if (node.description) wrapper.append(paragraph('', node.description));
    const featureProgress = featureProgressElement(current.state, nodeId, { historical: false });
    if (featureProgress) wrapper.append(featureProgress);
    wrapper.append(make('p', { class: 'muted', text: '先查看本节点的意图列表与确认比例，再打开单条面板。' }));
    const host = make('div', { class: 'panel-directory' });
    host.innerHTML = helpers.renderDirectory(current.state, {
      writable: current.writable && !writeBlocked,
      readOnlyReason: current.readOnlyReason || (writeBlocked ? '保存结果待核对，已停写' : ''),
      nodeId,
      progress: featureProgressCardLinesFor(current.state),
    });
    wrapper.append(host);
    wrapper.append(evidenceSection(node));
    panelBody.append(wrapper);
    panelClose.hidden = false;
    if (options.focus !== false) focusPanelTitle();
  }

  function successorNotice(claim) {
    const successors = asArray(claim.supersededByClaimIds);
    if (!successors.length) return null;
    const wrapper = make('div', { class: 'notice' });
    wrapper.append(make('p', { text: '这条意图已是历史态。后继意图：' }));
    for (const id of successors) {
      const next = claimById(id);
      if (!next) continue;
      wrapper.append(button(next.statement || id, { class: 'link-button', 'data-open-claim': id, 'data-claim-id': id }, () => openClaim(id, { trigger: null })));
    }
    return wrapper;
  }

  function claimActionZone(claim, node, mode, options) {
    const zone = make('section', { class: 'action-zone', 'aria-labelledby': 'action-zone-title', 'data-testid': 'claim-action-zone' });
    zone.append(make('h4', { id: 'action-zone-title', text: '评审动作' }));
    activeDraftCapture = null;
    previewState = null;
    if (claim.status !== 'candidate' && claim.status !== 'confirmed') {
      zone.append(make('p', { class: 'muted', text: `这条意图当前是 ${labels.claimStatus[claim.status] ?? claim.status}，不能继续执行生命周期动作。` }));
      const notice = successorNotice(claim);
      if (notice) zone.append(notice);
      return zone;
    }
    if (!current.writable || writeBlocked) {
      zone.append(make('p', { class: 'notice', text: writeBlocked ? '保存结果待核对，已停写；请先人工核对，不要重复确认。' : `当前只读：${current.readOnlyReason || '未说明原因'}` }));
      return zone;
    }
    const info = legacyInfo(node);
    if (mode === 'edit' && claim.status === 'candidate') return buildEditAction(zone, claim, node, options);
    if (mode === 'split' && claim.status === 'candidate') return buildSplitAction(zone, claim, node, options);
    if (mode === 'discard' && claim.status === 'candidate') return buildDiscardAction(zone, claim, node, options);
    if (mode === 'confirm' && claim.status === 'candidate') return buildConfirmAction(zone, claim, node, options, info);
    if (mode === 'propose' && claim.status === 'confirmed') return buildProposeAction(zone, claim, node, options);
    if (mode === 'retire' && claim.status === 'confirmed') return buildRetireAction(zone, claim, node, options);
    if (mode === 'defer') return buildDeferAction(zone, { type: 'claim', claimId: claim.id }, options);
    const actions = make('div', { class: 'intent-actions' });
    if (claim.status === 'candidate') {
      for (const action of ['edit_candidate', 'confirm_candidate', 'split_candidate', 'discard_candidate', 'defer']) {
        actions.append(button(labels.action[action], { class: 'btn', 'data-panel-nav': action }, () => openClaim(claim.id, { mode: action, trigger: options.trigger ?? null })));
      }
    } else {
      if (!openProposalForClaim(claim.id)) actions.append(button(labels.action.propose_edit, { class: 'btn', 'data-panel-nav': 'propose_edit' }, () => openClaim(claim.id, { mode: 'propose_edit', trigger: options.trigger ?? null })));
      actions.append(button(labels.action.retire_claim, { class: 'btn', 'data-panel-nav': 'retire_claim' }, () => openClaim(claim.id, { mode: 'retire_claim', trigger: options.trigger ?? null })));
      actions.append(button(labels.action.defer, { class: 'btn', 'data-panel-nav': 'defer' }, () => openClaim(claim.id, { mode: 'defer', trigger: options.trigger ?? null })));
    }
    zone.append(actions);
    return zone;
  }

  function buildEditAction(zone, claim, node, options) {
    const draft = loadDraft({ type: 'claim', claimId: claim.id, mode: 'edit' });
    const editor = contentEditor(draft?.content ?? claim);
    const assessment = assessmentEditor(draft?.assessment ?? claim.assessment ?? {}, { hasLegacy: Boolean(legacyInfo(node).material) });
    const note = make('textarea', { rows: '2', maxlength: '2000' });
    note.value = draft?.note ?? '';
    const noteField = field('备注（可选）', note);
    const form = make('div', { class: 'action-form', 'data-testid': 'form-edit_candidate' }, editor.element, assessment.element, noteField, draftNote());
    const save = button('保存候选，仍待确认', { class: 'btn btn-primary', 'data-submit': '1', 'data-testid': 'submit-edit_candidate' }, () => {
      if (applyValidation(editor.validate())) return;
      const payload = { content: editor.read(), assessment: assessment.read() };
      if (note.value) payload.note = note.value;
      sendSubmission({ action: 'edit_candidate', targetClaimId: claim.id, payload });
    });
    form.append(actionNote('旧候选保留为历史并标记 superseded；新候选仍是 candidate，不创建决定或证据。'), make('div', { class: 'action-row' }, save));
    zone.append(form);
    activeDraftCapture = () => ({ content: editor.read(), assessment: assessment.read(), note: note.value });
    return zone;
  }

  function splitItemEditor(index, initial, hasLegacy) {
    const editor = contentEditor(initial, { idPrefix: `split-${index}` });
    const assessment = assessmentEditor({ disposition: 'unreviewed', reviewedLegacyContext: false }, { hasLegacy });
    const fieldset = make('fieldset', { class: 'split-item', 'data-testid': 'split-item' },
      make('legend', { text: `候选 ${index + 1}` }),
      editor.element, assessment.element,
    );
    fieldset.editor = editor;
    fieldset.assessment = assessment;
    return fieldset;
  }

  function buildSplitAction(zone, claim, node, options) {
    const draft = loadDraft({ type: 'claim', claimId: claim.id, mode: 'split' });
    const initialItems = draft?.items?.length ? draft.items : [
      { content: { statement: claim.statement, scope: claim.scope, conditions: claim.conditions, exceptions: claim.exceptions }, assessment: { disposition: 'unreviewed', reviewedLegacyContext: false } },
      { content: { statement: '', scope: [], conditions: [], exceptions: [] }, assessment: { disposition: 'unreviewed', reviewedLegacyContext: false } },
    ];
    const hasLegacy = Boolean(legacyInfo(node).material);
    const itemsHost = make('div', { class: 'split-items' });
    const items = [];
    function addItem(initial) {
      if (items.length >= 5) return;
      const item = splitItemEditor(items.length, initial?.content ?? { statement: '', scope: [], conditions: [], exceptions: [] }, hasLegacy);
      if (initial?.assessment) {
        const select = item.querySelector('select'); if (select) select.value = initial.assessment.disposition ?? 'unreviewed';
        const legacy = item.querySelector('input[type="checkbox"]'); if (legacy) legacy.checked = initial.assessment.reviewedLegacyContext === true;
      }
      items.push(item);
      itemsHost.append(item);
    }
    for (const item of initialItems) addItem(item);
    const add = button('增加候选', { class: 'btn btn-secondary' }, () => {
      if (items.length >= 5) { setStatus('拆分最多 5 项。', { error: true }); return; }
      addItem(null); onFormActivity();
    });
    const remove = button('删除最后一项', { class: 'btn btn-secondary' }, () => {
      if (items.length <= 2) { setStatus('拆分至少保留 2 项。', { error: true }); return; }
      const item = items.pop(); item.remove(); onFormActivity();
    });
    const note = make('textarea', { rows: '2', maxlength: '2000' });
    note.value = draft?.note ?? '';
    const form = make('div', { class: 'action-form', 'data-testid': 'form-split_candidate' }, itemsHost, make('div', { class: 'action-row' }, add, remove), field('备注（可选）', note), draftNote());
    const previewHost = make('div', { class: 'preview-host' });
    const previewButton = button('生成预览', { class: 'btn btn-primary', 'data-preview-generate': '1', 'data-testid': 'preview-split_candidate' }, () => {
      const errors = items.flatMap((item) => item.editor.validate());
      if (items.length < 2 || items.length > 5) errors.push({ control: items[0]?.editor.statement ?? add, message: '拆分需要 2–5 个候选。' });
      if (applyValidation(errors)) return;
      generatePreview('split_candidate', () => ({ items: readSplitItems(), ...(note.value ? { note: note.value } : {}) }), { claim, items: readSplitItems() });
    });
    form.append(actionNote('拆分保存后原候选标记 superseded，所有新候选仍是 candidate；不会确认任何子项。'), make('div', { class: 'action-row' }, previewButton), previewHost);
    zone.append(form);
    function readSplitItems() {
      return items.map((item) => ({ content: item.editor.read(), assessment: item.assessment.read() }));
    }
    activeDraftCapture = () => ({ items: readSplitItems(), note: note.value });
    return zone;
  }

  function buildConfirmAction(zone, claim, node, options, info) {
    const summary = claimSummary(claim);
    zone.append(fullContentElement(claim, '待确认的完整意图'));
    zone.append(actionNote('只确认这一条完整意图；不改实现、测试、其它意图或节点。'));
    if (claim.assessment?.disposition !== 'single') {
      zone.append(make('p', { class: 'notice', text: '准备判断不是 single（可独立决定），不能确认。请先在“整理候选”中保存完整内容与准备判断。' }));
      zone.append(make('div', { class: 'action-row' }, button('先整理候选', { class: 'btn' }, () => openClaim(claim.id, { mode: 'edit', trigger: options.trigger ?? null }))));
      return zone;
    }
    if (!asArray(claim.scope).length) {
      zone.append(make('p', { class: 'notice', text: '确认至少需要一项适用范围；请先整理候选补全。' }));
      return zone;
    }
    if (info.decision && info.shared) {
      zone.append(make('p', { class: 'notice', text: '该节点有共享或复合的 0.1 旧决定；首版不能只确认其中一条来局部替代。请暂缓并人工核对。' }));
      zone.append(make('div', { class: 'action-row' }, button('记录暂缓', { class: 'btn' }, () => openClaim(claim.id, { mode: 'defer', trigger: options.trigger ?? null }))));
      return zone;
    }
    if (info.material && claim.assessment?.reviewedLegacyContext !== true) {
      zone.append(make('p', { class: 'notice', text: '该节点保留了 0.1 旧材料，而这条意图的准备记录没有标记“已核对旧材料”。请先在整理候选中核对并勾选，再确认。' }));
      zone.append(make('div', { class: 'action-row' }, button('先整理候选', { class: 'btn' }, () => openClaim(claim.id, { mode: 'edit', trigger: options.trigger ?? null }))));
      return zone;
    }
    if (info.decision) {
      zone.append(make('div', { class: 'legacy-decision' },
        make('h5', { text: '显式完整重申旧决定' }),
        make('p', {}, make('strong', { text: info.decision.statement ?? '' })),
        make('p', { class: 'muted', text: info.decision.applicability ?? '适用范围未记录' }),
        make('p', { class: 'muted', text: '确认后新 adopt 决定会替代这条旧决定；这是完整重申，不是局部勾选。' }),
      ));
    }
    const previewHost = make('div', { class: 'preview-host' });
    const previewButton = button('生成确认预览', { class: 'btn btn-primary', 'data-preview-generate': '1', 'data-testid': 'preview-confirm_candidate' }, async () => {
      const payload = {};
      if (info.decision) {
        try {
          payload.legacyResolution = { decisionId: info.decision.id, decisionDigest: await digestValue(info.decision) };
        } catch (error) {
          setStatus(`无法计算旧决定摘要：${error.message}`, { error: true, focus: true });
          return;
        }
      }
      generatePreview('confirm_candidate', () => payload, { claim });
    });
    const form = make('div', { class: 'action-form', 'data-testid': 'form-confirm_candidate' }, actionNote(`本节点现行意图 ${summary.x}/${summary.y}；确认只作用于这一条。`), previewButton, previewHost);
    zone.append(form);
    return zone;
  }

  function buildDiscardAction(zone, claim, node, options) {
    zone.append(fullContentElement(claim, '待撤回的候选'));
    const draft = loadDraft({ type: 'claim', claimId: claim.id, mode: 'discard' });
    const reason = make('textarea', { rows: '3', maxlength: '2000' });
    reason.value = draft?.reason ?? '';
    const reasonField = field('撤回原因（必填）', reason);
    const previewHost = make('div', { class: 'preview-host' });
    const previewButton = button('生成撤回预览', { class: 'btn btn-primary', 'data-preview-generate': '1', 'data-testid': 'preview-discard_candidate' }, () => {
      if (applyValidation(reason.value.trim() ? [] : [{ control: reason, message: '撤回原因不能为空。' }])) return;
      generatePreview('discard_candidate', () => ({ reason: reason.value }), { claim });
    });
    const form = make('div', { class: 'action-form', 'data-testid': 'form-discard_candidate' }, reasonField, actionNote('撤回候选提取，不是停止产品行为，也不改变任何决定。'), make('div', { class: 'action-row' }, previewButton), previewHost);
    zone.append(form);
    activeDraftCapture = () => ({ reason: reason.value });
    return zone;
  }

  function buildProposeAction(zone, claim, node, options) {
    const open = openProposalForClaim(claim.id);
    if (open) {
      zone.append(make('p', { class: 'notice', text: `同一 claim 已有待处理修改提案 ${open.id}；请先接受或拒绝它，再提出新提案。` }));
      zone.append(make('div', { class: 'action-row' }, button('查看提案', { class: 'btn' }, () => openProposal(open.id, { trigger: options.trigger ?? null }))));
      return zone;
    }
    const draft = loadDraft({ type: 'claim', claimId: claim.id, mode: 'propose' });
    const editor = contentEditor(draft?.replacement ?? claim, { requireScope: true });
    const rationale = make('textarea', { rows: '3', maxlength: '2000' });
    rationale.value = draft?.rationale ?? '';
    const rationaleField = field('修改理由（必填）', rationale);
    const save = button('提出修改，现行意图不变', { class: 'btn btn-primary', 'data-submit': '1', 'data-testid': 'submit-propose_edit' }, () => {
      const errors = editor.validate();
      if (!rationale.value.trim()) errors.push({ control: rationale, message: '修改理由不能为空。' });
      if (applyValidation(errors)) return;
      sendSubmission({ action: 'propose_edit', targetClaimId: claim.id, payload: { replacement: editor.read(), rationale: rationale.value } });
    });
    const form = make('div', { class: 'action-form', 'data-testid': 'form-propose_edit' }, editor.element, rationaleField, actionNote('创建 open proposal；目标 claim 与现行决定保持不变。'), draftNote(), make('div', { class: 'action-row' }, save));
    zone.append(form);
    activeDraftCapture = () => ({ replacement: editor.read(), rationale: rationale.value });
    return zone;
  }

  function buildRetireAction(zone, claim, node, options) {
    zone.append(fullContentElement(claim, '要停止的完整意图'));
    zone.append(make('p', { class: 'notice', text: '停止要求这项行为；不会删除实现或改变业务代码。' }));
    const draft = loadDraft({ type: 'claim', claimId: claim.id, mode: 'retire' });
    const reason = make('textarea', { rows: '3', maxlength: '2000' });
    reason.value = draft?.reason ?? '';
    const reasonField = field('停止原因（必填）', reason);
    const previewHost = make('div', { class: 'preview-host' });
    const previewButton = button('生成停止预览', { class: 'btn btn-primary', 'data-preview-generate': '1', 'data-testid': 'preview-retire_claim' }, () => {
      if (applyValidation(reason.value.trim() ? [] : [{ control: reason, message: '停止原因不能为空。' }])) return;
      generatePreview('retire_claim', () => ({ reason: reason.value }), { claim });
    });
    const form = make('div', { class: 'action-form', 'data-testid': 'form-retire_claim' }, reasonField, make('div', { class: 'action-row' }, previewButton), previewHost);
    zone.append(form);
    activeDraftCapture = () => ({ reason: reason.value });
    return zone;
  }

  function buildDeferAction(zone, target, options) {
    const draft = loadDraft(target.type === 'claim'
      ? { type: 'claim', claimId: target.claimId, mode: 'defer' }
      : { type: 'proposal', proposalId: target.proposalId, claimId: target.claimId, mode: 'defer' });
    const select = make('select', { id: 'defer-reason' },
      make('option', { value: 'needs_split', text: '需要拆分' }),
      make('option', { value: 'needs_evidence', text: '需要证据' }),
      make('option', { value: 'needs_decision', text: '需要产品决定' }),
      make('option', { value: 'other', text: '其它（备注必填）' }),
    );
    select.value = draft?.reason ?? 'needs_decision';
    const note = make('textarea', { rows: '3', maxlength: '2000' });
    note.value = draft?.note ?? '';
    const noteField = field('备注（reason=other 时必填）', note);
    const save = button('记录暂缓，不改变生命周期', { class: 'btn btn-primary', 'data-submit': '1', 'data-testid': 'submit-defer' }, () => {
      const errors = [];
      if (select.value === 'other' && !note.value.trim()) errors.push({ control: note, message: '选择“其它”时必须填写备注。' });
      if (applyValidation(errors)) return;
      const payload = { reason: select.value };
      if (note.value) payload.note = note.value;
      if (target.type === 'claim') sendSubmission({ action: 'defer', targetClaimId: target.claimId, payload });
      else sendSubmission({ action: 'defer', targetProposalId: target.proposalId, payload });
    });
    const form = make('div', { class: 'action-form', 'data-testid': 'form-defer' }, field('暂缓原因', select), noteField, actionNote('只保存暂缓原因；claim/proposal 生命周期与现行决定不变。刷新后队列仍从 reviews 派生。'), draftNote(), make('div', { class: 'action-row' }, save));
    zone.append(form);
    activeDraftCapture = () => ({ reason: select.value, note: note.value });
    return zone;
  }

  function buildAcceptAction(zone, proposal, claim, node, options) {
    const info = legacyInfo(node);
    zone.append(contentDiffElement(claim, proposal.replacement, '接受修改：现行意图与拟议内容'));
    zone.append(make('p', { class: 'muted', text: `修改理由：${proposal.rationale ?? '未记录'}` }));
    if (info.material && claim.assessment?.reviewedLegacyContext !== true) {
      zone.append(make('p', { class: 'notice', text: '目标节点保留了 0.1 旧材料，而现行意图的准备记录没有标记“已核对旧材料”；接受修改不能绕过这一步。' }));
      return zone;
    }
    if (info.decision) {
      zone.append(make('p', { class: 'notice', text: '目标节点仍有未对齐的 0.1 旧决定；接受提案不能在首版替代它。请先人工核对或暂缓。' }));
      return zone;
    }
    const previewHost = make('div', { class: 'preview-host' });
    const previewButton = button('生成接受预览', { class: 'btn btn-primary', 'data-preview-generate': '1', 'data-testid': 'preview-accept_proposal' }, () => generatePreview('accept_proposal', () => ({}), { proposal, claim }));
    const form = make('div', { class: 'action-form', 'data-testid': 'form-accept_proposal' }, actionNote('新 claim 完全采用 replacement；旧 claim 与原决定保留为历史并标记 superseded。'), make('div', { class: 'action-row' }, previewButton), previewHost);
    zone.append(form);
    return zone;
  }

  function buildRejectAction(zone, proposal, claim, options) {
    zone.append(make('p', { class: 'muted', text: `现行意图：${claim?.statement ?? proposal.targetClaimId}` }));
    const draft = loadDraft({ type: 'proposal', proposalId: proposal.id, claimId: claim?.id, mode: 'reject' });
    const reason = make('textarea', { rows: '3', maxlength: '2000' });
    reason.value = draft?.reason ?? '';
    const reasonField = field('拒绝原因（必填）', reason);
    const save = button('拒绝提案，保留现行意图', { class: 'btn btn-primary', 'data-submit': '1', 'data-testid': 'submit-reject_proposal' }, () => {
      if (applyValidation(reason.value.trim() ? [] : [{ control: reason, message: '拒绝原因不能为空。' }])) return;
      sendSubmission({ action: 'reject_proposal', targetProposalId: proposal.id, payload: { reason: reason.value } });
    });
    const form = make('div', { class: 'action-form', 'data-testid': 'form-reject_proposal' }, reasonField, actionNote('仅关闭提案；目标 claim 与现行决定不变。'), draftNote(), make('div', { class: 'action-row' }, save));
    zone.append(form);
    activeDraftCapture = () => ({ reason: reason.value });
    return zone;
  }

  function buildProposalActionZone(proposal, claim, node, mode, options) {
    const zone = make('section', { class: 'action-zone', 'aria-labelledby': 'action-zone-title', 'data-testid': 'proposal-action-zone' });
    zone.append(make('h4', { id: 'action-zone-title', text: '提案动作' }));
    activeDraftCapture = null;
    previewState = null;
    if (proposal.status !== 'open') {
      zone.append(make('p', { class: 'muted', text: `这个提案已是 ${labels.proposalStatus[proposal.status] ?? proposal.status}，不能再操作。` }));
      return zone;
    }
    if (!current.writable || writeBlocked) {
      zone.append(make('p', { class: 'notice', text: writeBlocked ? '保存结果待核对，已停写。' : `当前只读：${current.readOnlyReason || '未说明原因'}` }));
      return zone;
    }
    if (mode === 'accept') return buildAcceptAction(zone, proposal, claim, node, options);
    if (mode === 'reject') return buildRejectAction(zone, proposal, claim, options);
    if (mode === 'defer') return buildDeferAction(zone, { type: 'proposal', proposalId: proposal.id, claimId: claim?.id }, options);
    const actions = make('div', { class: 'intent-actions' });
    actions.append(button(labels.action.accept_proposal, { class: 'btn' }, () => openProposal(proposal.id, { mode: 'accept' })));
    actions.append(button(labels.action.reject_proposal, { class: 'btn' }, () => openProposal(proposal.id, { mode: 'reject' })));
    actions.append(button(labels.action.defer, { class: 'btn' }, () => openProposal(proposal.id, { mode: 'defer' })));
    zone.append(actions);
    return zone;
  }

  function buildClaimPanel(claim, node, mode, options) {
    const wrapper = make('article', { class: 'panel-claim', 'data-testid': 'claim-panel' });
    wrapper.append(panelHeaderForClaim(claim, node));
    const content = make('section', { class: 'panel-section' }, make('h4', { text: '期望内容（完整四字段）' }), fullContentElement(claim), paragraph('muted', '未记录的条件/例外不等于不存在，也不等于无条件适用。'));
    wrapper.append(content);
    wrapper.append(make('section', { class: 'panel-section' }, make('h4', { text: '准备判断' }), paragraph('muted', `准备判断：${labels.disposition[claim.assessment?.disposition] ?? '未审阅'}；只有 single 才能确认。内容摘要与 review 引用见折叠的内部 ID。`)));
    wrapper.append(evidenceSection(node));
    wrapper.append(verificationSection(node));
    wrapper.append(historySection(claim, node));
    wrapper.append(claimActionZone(claim, node, mode, options));
    return wrapper;
  }

  function buildProposalPanel(proposal, claim, node, mode, options) {
    const wrapper = make('article', { class: 'panel-proposal', 'data-testid': 'proposal-panel' });
    wrapper.append(panelHeaderForProposal(proposal, claim, node));
    wrapper.append(make('section', { class: 'panel-section' }, make('h4', { text: '现行意图' }), fullContentElement(claim)));
    wrapper.append(make('section', { class: 'panel-section' }, make('h4', { text: '拟议完整内容' }), fullContentElement(proposal.replacement), paragraph('muted', `理由：${proposal.rationale ?? '未记录'}`)));
    wrapper.append(make('section', { class: 'panel-section' }, make('h4', { text: '四字段对照' }), contentDiffElement(claim, proposal.replacement, '原文 / 拟议')));
    wrapper.append(evidenceSection(node));
    wrapper.append(verificationSection(node));
    wrapper.append(historySection(claim, node));
    wrapper.append(buildProposalActionZone(proposal, claim, node, mode, options));
    return wrapper;
  }

  function showMissingTarget(kind, id) {
    panelTarget = null;
    updateQuery(null, null, 'replace');
    panelBody.replaceChildren();
    panelTitle.textContent = '选择一条意图';
    panelClose.hidden = true;
    const list = make('div', {});
    list.innerHTML = helpers.renderDirectory(current.state, { writable: current.writable && !writeBlocked, readOnlyReason: current.readOnlyReason, progress: featureProgressCardLinesFor(current.state) });
    panelBody.append(make('p', { class: 'muted', text: `${kind} ${id} 不在当前状态中（可能已被替代或关闭）。已回到意图列表。` }), list);
    setStatus(`${kind} ${id} 不在当前状态；已回到列表。`, { error: true, focus: true });
  }

  function normalizeMode(mode) {
    return ({
      edit_candidate: 'edit', split_candidate: 'split', discard_candidate: 'discard',
      confirm_candidate: 'confirm', propose_edit: 'propose', accept_proposal: 'accept',
      reject_proposal: 'reject', retire_claim: 'retire', defer: 'defer',
    })[mode] || mode || 'view';
  }

  function syncGraphToNode(nodeId) {
    if (!graphApi?.selectNode) return;
    if (location.hash.slice(1) === nodeAnchor(nodeId)) return;
    suppressGraphHook = true;
    try { graphApi.selectNode(nodeId, true); } finally { suppressGraphHook = false; }
  }

  function openClaim(claimId, options = {}) {
    if (historySelection) return;
    const claim = claimById(claimId);
    if (!claim) { showMissingTarget('意图', claimId); return; }
    const node = nodeForClaim(claim);
    const mode = normalizeMode(options.mode);
    formRevision += 1;
    panelTarget = { type: 'claim', claimId, mode, proposalId: options.proposalId ?? null, trigger: options.trigger ?? null };
    if (!options.fromUrl) rememberMode(panelTarget, mode);
    syncGraphToNode(claim.nodeId);
    panelTitle.textContent = `意图评审 · ${labels.claimStatus[claim.status] ?? claim.status}`;
    panelBody.replaceChildren(buildClaimPanel(claim, node, mode, options));
    panelClose.hidden = false;
    if (!options.fromUrl) updateQuery(claim.id, null, 'push');
    if (options.focus !== false) focusPanelTitle();
  }

  function openProposal(proposalId, options = {}) {
    if (historySelection) return;
    const proposal = proposalById(proposalId);
    if (!proposal) {
      if (options.claimId) { openClaim(options.claimId, { fromUrl: true, focus: options.focus }); setStatus(`提案 ${proposalId} 不在当前状态中（可能已关闭）。`, { error: true, focus: true }); }
      else showMissingTarget('提案', proposalId);
      return;
    }
    const claim = claimById(proposal.targetClaimId);
    if (!claim) {
      panelTarget = null;
      updateQuery(null, null, 'replace');
      panelBody.replaceChildren(paragraph('muted', `提案的目标意图 ${proposal.targetClaimId} 不在当前状态中；已回到意图列表。`));
      panelTitle.textContent = '修改提案';
      panelClose.hidden = true;
      setStatus('提案目标意图缺失，已回到列表。', { error: true, focus: true });
      return;
    }
    const node = nodeForClaim(claim);
    const mode = normalizeMode(options.mode);
    formRevision += 1;
    panelTarget = { type: 'proposal', proposalId, claimId: claim.id, mode, trigger: options.trigger ?? null };
    if (!options.fromUrl) rememberMode(panelTarget, mode);
    syncGraphToNode(claim.nodeId);
    panelTitle.textContent = `修改提案 · ${labels.proposalStatus[proposal.status] ?? proposal.status}`;
    panelBody.replaceChildren(buildProposalPanel(proposal, claim, node, mode, options));
    panelClose.hidden = false;
    if (!options.fromUrl) updateQuery(claim.id, proposal.id, 'push');
    if (options.focus !== false) focusPanelTitle();
  }

  function updateQuery(claimId, proposalId, mode = 'push') {
    try {
      const url = new URL(location.href);
      if (claimId) url.searchParams.set('claim', claimId); else url.searchParams.delete('claim');
      if (proposalId) url.searchParams.set('proposal', proposalId); else url.searchParams.delete('proposal');
      const next = url.pathname + url.search + url.hash;
      if (next === location.pathname + location.search + location.hash) return;
      history[mode + 'State'](null, '', next);
    } catch { /* Embedded viewers can restrict history. */ }
  }

  function closePanel(options = {}) {
    if (historySelection) return;
    const trigger = panelTarget?.trigger;
    const target = panelTarget;
    formRevision += 1;
    panelTarget = null;
    activeDraftCapture = null;
    previewState = null;
    panelTitle.textContent = '选择一条意图';
    panelBody.replaceChildren(paragraph('muted', '从左侧图谱、意图目录或暂缓队列选择节点/意图/提案，再在这里查看完整内容并执行动作。'));
    panelClose.hidden = true;
    clearStatus();
    updateQuery(null, null, 'push');
    if (options.focus === false) return;
    const fullscreenWorkspace = panel.closest('.continuity-fullscreen-host');
    if (fullscreenWorkspace) {
      // The ordinary directory is hidden in fullscreen; return to the actual
      // visible graph instead of trying to focus an offscreen directory button.
      fullscreenWorkspace.querySelector('#graph-viewport')?.focus({ preventScroll: true });
      return;
    }
    let focusTarget = trigger && trigger.isConnected ? trigger : null;
    let targetStillCurrent = true;
    if (target?.type === 'claim') {
      const claim = claimById(target.claimId);
      targetStillCurrent = Boolean(claim && (claim.status === 'candidate' || claim.status === 'confirmed'));
      if (!targetStillCurrent) {
        const nodeId = claim?.nodeId;
        focusTarget = nodeId ? doc.querySelector(`[data-open-node="${cssEscape(nodeId)}"]`) : null;
      }
    }
    if (target?.type === 'proposal') {
      const proposal = proposalById(target.proposalId);
      targetStillCurrent = Boolean(proposal && proposal.status === 'open');
      if (!targetStillCurrent) {
        const claim = proposal ? claimById(proposal.targetClaimId) : null;
        focusTarget = claim ? doc.querySelector(`[data-open-node="${cssEscape(claim.nodeId)}"]`) : null;
      }
    }
    if (targetStillCurrent && !focusTarget && target?.type === 'claim') focusTarget = doc.querySelector(`[data-open-claim="${cssEscape(target.claimId)}"]`);
    if (targetStillCurrent && !focusTarget && target?.type === 'proposal') focusTarget = doc.querySelector(`[data-open-proposal="${cssEscape(target.proposalId)}"]`);
    if (targetStillCurrent && !focusTarget && target?.type === 'node') focusTarget = doc.querySelector(`[data-open-node="${cssEscape(target.nodeId)}"]`);
    (focusTarget || doc.querySelector('#intent-directory-title'))?.focus({ preventScroll: true });
  }

  function cssEscape(value) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function routeFromUrl(options = {}) {
    if (historySelection) return;
    const params = new URLSearchParams(location.search);
    const claimId = options.claimId !== undefined ? options.claimId : params.get('claim');
    const proposalId = options.proposalId !== undefined ? options.proposalId : params.get('proposal');
    const hash = options.hash !== undefined ? String(options.hash).replace(/^#/, '') : location.hash.slice(1);
    if (proposalId) {
      const proposal = proposalById(proposalId);
      let mode = 'view';
      if (proposal && proposal.status === 'open') {
        const remembered = normalizeMode(rememberedMode({ type: 'proposal', proposalId }));
        if (remembered !== 'view' && loadDraft({ type: 'proposal', proposalId, mode: remembered })) mode = remembered;
      }
      openProposal(proposalId, { fromUrl: true, focus: options.focus !== false, claimId, mode });
      return;
    }
    if (claimId) {
      const claim = claimById(claimId);
      let mode = 'view';
      if (claim && (claim.status === 'candidate' || claim.status === 'confirmed')) {
        const remembered = normalizeMode(rememberedMode({ type: 'claim', claimId }));
        if (remembered !== 'view' && loadDraft({ type: 'claim', claimId, mode: remembered })) mode = remembered;
      }
      openClaim(claimId, { fromUrl: true, focus: options.focus !== false, mode });
      return;
    }
    if (hash) {
      const node = asArray(current.state?.nodes).find((item) => nodeAnchor(item.id) === hash);
      if (node) {
        if (graphApi?.selectNode) {
          suppressGraphHook = true;
          graphApi.selectNode(node.id, true);
          suppressGraphHook = false;
        }
        openNode(node.id, { focus: options.focus !== false });
        return;
      }
    }
    if (panelTarget) closePanel({ focus: options.focus !== false });
  }

  function renderDirectoryHosts() {
    if (directoryHost) {
      directoryHost.innerHTML = helpers.renderDirectory(current.state, {
        writable: current.writable && !writeBlocked,
        readOnlyReason: current.readOnlyReason || (writeBlocked ? '保存结果待核对，已停写' : ''),
        progress: featureProgressCardLinesFor(current.state),
      });
    }
    if (deferHost) deferHost.innerHTML = helpers.renderDeferQueue(current.state);
    renderRoadmapHosts();
    renderCurrentRoadmapPanel();
  }

  function updateGraph() {
    if (historySelection) return;
    if (graphApi?.refresh) graphApi.refresh(graphDataFromState(current.state));
  }

  async function readServerState() {
    const response = await fetch('/api/state', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok || body?.ok === false) {
      const error = new Error(body?.error?.message || `读取状态失败（HTTP ${response.status}）`);
      error.code = body?.error?.code || body?.code || `http_${response.status}`;
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  }

  function applyServerState(body) {
    const nextVersion = body.currentStateVersion ?? body.state?.stateVersion ?? current.stateVersion;
    const nextDigest = body.currentDigest || body.fileDigest || current.fileDigest;
    const changed = nextVersion !== current.stateVersion || (nextDigest && current.fileDigest && nextDigest !== current.fileDigest);
    current = {
      ...current,
      state: body.state ?? current.state,
      stateVersion: nextVersion,
      fileDigest: nextDigest,
      writable: body.writable === true,
      readOnlyReason: body.readOnlyReason || '',
      viewStatus: body.viewStatus ?? current.viewStatus,
      timelineHistory: body.timelineHistory ?? null,
    };
    stateIdentity = body.stateIdentity || stateIdentity;
    stateLocation = body.stateLocation || stateLocation;
    if (changed && previewState) invalidatePreview('状态版本/摘要已变化，预览与勾选已失效；请重新生成预览。');
    updateHeader();
    renderDirectoryHosts();
    updateGraph();
    timelineApi?.update(current.state, current.timelineHistory);
    graphTimeApi?.update(current.state, current.timelineHistory);
    if (pending) inspectPending();
    return changed;
  }

  async function fetchState() {
    return applyServerState(await readServerState());
  }

  async function refreshState(options = {}) {
    try {
      const changed = await fetchState();
      if (options.restore !== false && panelTarget && (changed || options.forceRestore)) restorePanel();
      if (options.route) routeFromUrl({ focus: options.focus !== false });
      return changed;
    } catch (error) {
      handleError(error, { quiet: options.quiet });
      return false;
    }
  }

  function restorePanel() {
    const target = panelTarget;
    if (!target) return;
    if (target.type === 'node') openNode(target.nodeId, { focus: false, trigger: target.trigger });
    else if (target.type === 'claim') openClaim(target.claimId, { fromUrl: true, focus: false, mode: target.mode, trigger: target.trigger });
    else if (target.type === 'proposal') openProposal(target.proposalId, { fromUrl: true, focus: false, mode: target.mode, trigger: target.trigger, claimId: target.claimId });
  }

  async function generatePreview(action, collectPayload, context) {
    if (historySelection) return;
    if (busy) return;
    if (previewState) invalidatePreview();
    let payload;
    try { payload = collectPayload(); } catch (error) { setStatus(error.message, { error: true, focus: true }); return; }
    const target = panelTarget;
    if (!target) return;
    const request = {
      projectId,
      action,
      payload,
      expectedStateVersion: current.stateVersion,
      expectedDigest: current.fileDigest,
    };
    if (target.type === 'proposal') request.targetProposalId = target.proposalId;
    else request.targetClaimId = target.claimId;
    const revisionAtRequest = formRevision;
    setStatus('正在生成预览…', { focus: false });
    setBusy(true);
    try {
      const response = await postJson('/api/preview', request);
      if (revisionAtRequest !== formRevision || panelTarget !== target) {
        setStatus('预览响应返回前表单或目标已变化；这次预览未应用。请重新生成预览。', { error: true, focus: true, code: 'preview_discarded' });
        return;
      }
      if (response.currentStateVersion !== undefined && response.currentStateVersion !== current.stateVersion) {
        setStatus('预览返回时状态版本已变化；这次预览未应用。请先刷新并重新生成预览。', { error: true, focus: true, code: 'stale_state' });
        return;
      }
      const payload = response.preview ?? response;
      const plan = payload.plan ?? response.plan;
      const preview = {
        digest: response.previewDigest ?? payload.previewDigest,
        plan,
        attestations: response.attestations ?? payload.attestations ?? plan?.attestations ?? [],
        request,
      };
      const host = panelBody.querySelector('.preview-host');
      if (host) {
        host.replaceChildren(previewElement(preview, {
          action,
          claim: context.claim ?? claimById(target.claimId),
          proposal: context.proposal,
          items: context.items,
          target,
        }));
        host.querySelector('#preview-title')?.focus({ preventScroll: true });
      }
      setStatus('预览已生成；请核对四字段差异、影响清单并完成勾选。', { focus: false });
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  function cloneJson(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function submitPreviewAction(context) {
    if (!previewState) { setStatus('预览不存在或已失效，请重新生成预览。', { error: true, focus: true }); return; }
    if (!previewState.digest) { setStatus('预览摘要缺失，请重新生成。', { error: true, focus: true }); return; }
    const target = previewState.context?.target ?? panelTarget;
    if (!target || panelTarget !== target) {
      setStatus('提交目标已在预览后变化；这次预览未应用，请重新生成预览。', { error: true, focus: true });
      return;
    }
    const payload = cloneJson(previewState.request?.payload ?? {});
    payload.previewDigest = previewState.digest;
    const attestations = chosenAttestations();
    for (const [key, value] of Object.entries(attestations)) {
      if (key === 'legacyResolution') {
        const existing = payload.legacyResolution ?? {};
        const decision = previewState.plan?.legacy?.decisions?.[0];
        const decisionId = existing.decisionId ?? decision?.id;
        const decisionDigest = existing.decisionDigest ?? previewState.request?.payload?.legacyResolution?.decisionDigest;
        if (!decisionId || !decisionDigest || value.fullRestatementAttested !== true) {
          setStatus('旧决定摘要缺失或未勾选完整重申，请重新生成预览并完成勾选。', { error: true, focus: true });
          return;
        }
        payload.legacyResolution = { decisionId, decisionDigest, fullRestatementAttested: true };
      } else {
        payload[key] = value;
      }
    }
    if (target.type === 'proposal') sendSubmission({ action: context.action, targetProposalId: target.proposalId, payload });
    else if (target.type === 'claim') sendSubmission({ action: context.action, targetClaimId: target.claimId, payload });
  }

  async function postJson(path, body) {
    if (historySelection) throw new Error('历史模式只读，请回到现在后再操作。');
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Review-Action': '1' },
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok || data?.ok === false) {
      const info = data?.error ?? {};
      const error = new Error(info.message || data?.message || `请求失败（HTTP ${response.status}）`);
      error.code = info.code || data?.code || data?.outcome || `http_${response.status}`;
      error.status = response.status;
      error.body = data;
      throw error;
    }
    return data;
  }

  async function sendSubmission(command) {
    if (historySelection) return;
    if (busy) return;
    if (writeBlocked) { setStatus('保存结果待核对或历史不可核验，已停写；不要重复确认。', { error: true, focus: true }); return; }
    if (pending) { setStatus('已有未决提交；只能重试原请求，不能生成新 key。请先处理顶部未决提交提示。', { error: true, focus: true }); showPendingBanner(); return; }
    if (previewActions.has(command.action) && !previewState) { setStatus('这个动作必须先由服务端生成预览。', { error: true, focus: true }); return; }
    const target = panelTarget;
    if (!target) return;
    const request = {
      projectId,
      action: command.action,
      payload: command.payload,
      expectedStateVersion: current.stateVersion,
      expectedDigest: current.fileDigest,
    };
    if (command.targetProposalId) request.targetProposalId = command.targetProposalId;
    else request.targetClaimId = command.targetClaimId;
    request.idempotencyKey = crypto.randomUUID();
    const record = {
      key: pendingKey(target),
      projectId,
      identity: stateIdentity,
      target: { type: target.type, claimId: target.claimId, proposalId: target.proposalId, mode: target.mode },
      request,
      expectedStateVersion: current.stateVersion,
      expectedDigest: current.fileDigest,
      lastObservedVersion: current.stateVersion,
      sentAt: new Date().toISOString(),
    };
    pending = record;
    savePending(record);
    setStatus('正在保存…', { focus: false });
    setBusy(true);
    try {
      const response = await postJson('/api/reviews', request);
      await handleSuccess(response, command.action, target);
    } catch (error) {
      if (error instanceof TypeError || !error.status) {
        setStatus('没有拿到提交结果（网络或页面中断）。已保留原请求；只能重试同一请求，禁止另生成 key。', { error: true, focus: true });
        showPendingBanner();
      } else {
        handleError(error);
      }
    } finally {
      setBusy(false);
    }
  }

  async function retryPending() {
    if (historySelection) return;
    if (!pending || busy) return;
    if (pendingBanner?.dataset.state === 'history_not_verifiable' || writeBlocked) {
      setStatus('历史不可核验，已停写；请人工核对，不提供一键重放。', { error: true, focus: true });
      return;
    }
    setStatus('正在重试原请求…', { focus: false });
    setBusy(true);
    try {
      const response = await postJson('/api/reviews', pending.request);
      const target = pending.target;
      await handleSuccess(response, pending.request.action, target, true);
    } catch (error) {
      if (error instanceof TypeError || !error.status) setStatus('重试仍未拿到结果；继续保留原请求，只能再次重试。', { error: true, focus: true });
      else handleError(error);
    } finally {
      setBusy(false);
    }
  }

  async function handleSuccess(response, action, target, wasReplay = false) {
    const outcome = response.outcome ?? 'saved';
    const reviewId = response.reviewId ?? '';
    const commitStatus = response.commitStatus ?? 'verified';
    clearPending();
    if (target) clearDraft({ type: target.type, claimId: target.claimId, proposalId: target.proposalId, mode: target.mode });
    previewState = null;
    if (panelTarget) panelTarget.mode = 'view';
    const outcomeText = outcome === 'replayed' ? '已重放原提交（没有新增 review）' : outcome === 'saved_view_pending' ? '决定已保存，静态地图待更新' : '已保存并核验';
    setStatus(`${outcomeText}。review：${reviewId || '未记录'}；状态版本：${response.resultingStateVersion ?? '未记录'}；commitStatus：${commitStatus}。`, { focus: true, code: outcome });
    if (response.currentDigest || response.currentStateVersion) {
      if (response.currentStateVersion !== undefined) current.stateVersion = response.currentStateVersion;
      if (response.currentDigest) current.fileDigest = response.currentDigest;
      if (response.viewStatus !== undefined) current.viewStatus = response.viewStatus;
      updateHeader();
    }
    if (commitStatus !== 'verified') {
      writeBlocked = true;
      setStatus('保存结果未核验或未知，已停写。不要重复确认；请按终端/备份记录人工核对。', { error: true, focus: true, code: commitStatus });
      return;
    }
    if (outcome === 'saved_view_pending') {
      const renderButton = button('仅重生成视图', { class: 'btn btn-secondary', 'data-testid': 'render-view' }, renderView);
      statusBox?.append(renderButton);
    }
    await refreshState({ restore: true, route: false, forceRestore: true });
    if (outcome === 'saved_view_pending') {
      setStatus('决定已保存，静态地图待更新。可仅重生成视图，不会新增 review。', { focus: true });
      statusBox?.append(button('仅重生成视图', { class: 'btn btn-secondary', 'data-testid': 'render-view' }, renderView));
    } else if (wasReplay || outcome === 'replayed') setStatus(`已重放原提交（没有新增 review）。review：${reviewId}；当前版本：${current.stateVersion}。`, { focus: true });
    else setStatus(`保存成功并已核验。review：${reviewId}；状态版本：${current.stateVersion}。`, { focus: true });
  }

  function handleError(error, options = {}) {
    const body = error.body ?? {};
    const code = error.code || body.code || body.outcome || 'request_failed';
    const commitStatus = body.commitStatus;
    const stopCodes = new Set([
      'invalid_state', 'invalid_state_on_disk', 'state_unverifiable', 'hardlink_state',
      'read_only', 'migration_required', 'schema_0_1_requires_migration',
      'state_not_found', 'state_not_file', 'state_unreadable', 'invalid_utf8',
      'external_modification', 'lock_lost', 'write_unverified', 'commit_unknown',
      'state_validation_failed', 'replaced_unverified',
    ]);
    const commitStopped = commitStatus === 'unverified' || commitStatus === 'unknown' || commitStatus === 'replaced_unverified';
    const definiteNotCommitted = body.commitStatus === 'not_committed'
      || ['invalid_request', 'claim_not_ready', 'preview_mismatch', 'idempotency_conflict', 'attestation_required',
        'legacy_resolution_required', 'legacy_resolution_invalid', 'legacy_requires_manual_reconciliation',
        'proposal_conflict', 'proposal_stale', 'target_not_found', 'unknown_action'].includes(code);
    if (definiteNotCommitted && code !== 'no_session' && !stopCodes.has(code)) clearPending();
    if (code === 'stale_state') {
      clearPending();
      showPendingBanner();
      showStale(body, error);
      return;
    }
    if (code === 'no_session' || code === 'bad_origin' || code === 'bad_host' || error.status === 403) {
      markReadOnly(code === 'no_session' ? 'no_session' : code);
      setStatus('会话或来源校验失败；已停写。请刷新页面重新打开评审服务，不会自动重新确认。', { error: true, focus: true, code });
      showPendingBanner();
      return;
    }
    if (stopCodes.has(code) || commitStopped) {
      markReadOnly(stopCodes.has(code) ? code : (commitStatus || code));
      setStatus(`写入已停止：${readOnlyText(current.readOnlyReason)}。本页面没有继续写事实源，草稿仍保留；请按终端、备份与状态文件人工核对后再刷新页面。`, { error: true, focus: true, code });
      showPendingBanner();
      return;
    }
    if (code === 'preview_mismatch') {
      previewState = null;
      panelBody.querySelector('#preview-block')?.remove();
      updateSubmitEnabled();
      setStatus('预览与服务端当前计划不匹配；已清除预览与勾选。请重新生成预览。', { error: true, focus: true, code });
      showPendingBanner();
      return;
    }
    if (code === 'history_not_verifiable') {
      markReadOnly('history_not_verifiable');
      setStatus(body.error?.message || '已知历史不可核验，已停写；请人工核对，禁止一键重放。', { error: true, focus: true, code });
      showPendingBanner();
      return;
    }
    if (!options.quiet) setStatus(`${error.message || '请求失败'}${code ? `（${code}）` : ''}`, { error: true, focus: true, code });
    showPendingBanner();
  }

  async function showStale(body, error) {
    const reportedVersion = body.currentStateVersion ?? body.details?.currentStateVersion ?? '未知';
    const reportedDigest = body.currentDigest ?? body.details?.currentDigest ?? '未记录';
    previewState = null;
    panelBody.querySelector('#preview-block')?.remove();
    updateSubmitEnabled();
    const target = panelTarget;
    const localClaim = target?.claimId ? claimById(target.claimId) : null;
    const draftFields = activeDraftCapture?.();
    const contentOf = (claim) => claim ? {
      statement: claim.statement ?? '',
      scope: asArray(claim.scope),
      conditions: asArray(claim.conditions),
      exceptions: asArray(claim.exceptions),
    } : null;
    const localContents = [];
    if (draftFields?.content) localContents.push({ label: '本地草稿', content: draftFields.content });
    else if (asArray(draftFields?.items).length) {
      asArray(draftFields.items).forEach((item, index) => localContents.push({ label: `本地草稿候选 ${index + 1}`, content: item.content }));
    } else if (localClaim) localContents.push({ label: '本标签看到的意图（未提交）', content: contentOf(localClaim) });

    const block = make('div', { class: 'stale-block', 'data-testid': 'stale-block' });
    block.append(make('h4', { text: '服务端状态已更新；你尚未提交' }));
    block.append(make('p', { text: `拒绝时服务端报告：版本 ${reportedVersion}（摘要 ${shortDigest(reportedDigest)}）；本标签基于版本 ${current.stateVersion}（摘要 ${shortDigest(current.fileDigest)}）。` }));
    block.append(make('p', { class: 'muted', text: '草稿已保留。下面先显示本标签草稿；服务端最新四字段会在读取后显示，但不会自动套用、不会更换 key。只有点击“重新应用到最新状态”才重建表单。' }));
    if (localContents.length) {
      block.append(make('h5', { text: '本地草稿（仅本标签）' }));
      for (const local of localContents) block.append(fullContentElement(local.content, local.label));
    }
    if (draftFields?.reason) block.append(make('p', { class: 'notice', text: `本地草稿原因：${draftFields.reason}` }));
    if (draftFields?.rationale) block.append(make('p', { class: 'notice', text: `本地草稿理由：${draftFields.rationale}` }));
    if (draftFields?.note) block.append(make('p', { class: 'notice', text: `本地草稿备注：${draftFields.note}` }));
    const freshHost = make('div', { class: 'stale-fresh', 'data-testid': 'stale-fresh' });
    freshHost.append(make('p', { class: 'muted', text: '正在读取服务端最新状态…' }));
    block.append(freshHost);
    const actionRow = make('div', { class: 'action-row' });
    const reapply = button('重新应用到最新状态', { class: 'btn btn-primary', 'data-testid': 'reapply-state' });
    actionRow.append(reapply);
    block.append(actionRow);
    panelBody.prepend(block);
    setStatus(error.message || '状态版本已过期，保存被拒绝且未提交。', { error: true, focus: true, code: 'stale_state' });

    let freshBody = null;
    let reading = false;
    let applyRequested = false;
    function applyFreshState() {
      if (!freshBody || !panelTarget || panelTarget !== target) return;
      applyServerState(freshBody);
      restorePanel();
      setStatus('已应用服务端最新状态；本标签草稿仍在，请重新生成预览后再提交。', { focus: true });
    }
    reapply.onclick = () => {
      if (freshBody) { applyFreshState(); return; }
      applyRequested = true;
      setStatus('正在读取服务端最新状态；读取完成后会应用，草稿保留。', { focus: false });
      if (!reading) readFresh();
    };
    async function readFresh() {
      if (reading) return;
      reading = true;
      freshHost.replaceChildren(make('p', { class: 'muted', text: '正在读取服务端最新状态…' }));
      try {
        freshBody = await readServerState();
        const freshVersion = freshBody.currentStateVersion ?? freshBody.state?.stateVersion ?? '未知';
        const freshDigest = freshBody.currentDigest || freshBody.fileDigest || '未记录';
        freshHost.replaceChildren();
        freshHost.append(make('p', { text: `服务端最新状态：版本 ${freshVersion}（摘要 ${shortDigest(freshDigest)}）。尚未应用。` }));
        const freshClaim = target?.claimId ? asArray(freshBody.state?.intentClaims).find((claim) => claim.id === target.claimId) : null;
        const freshContent = freshClaim ? contentOf(freshClaim) : null;
        if (freshClaim) {
          if (localContents.length) {
            for (const local of localContents) freshHost.append(contentDiffElement(local.content, freshContent, `${local.label} / 服务端现行四字段`));
          } else {
            freshHost.append(contentDiffElement(freshContent, freshContent, '服务端现行四字段（本地无可对照草稿）'));
          }
        } else if (target?.claimId) {
          freshHost.append(make('p', { class: 'notice', text: '目标意图在服务端最新状态中不存在（可能已被替代或撤回）；应用后会回到意图列表/历史。' }));
        }
        reading = false;
        if (applyRequested) applyFreshState();
      } catch (readError) {
        reading = false;
        freshBody = null;
        freshHost.replaceChildren();
        freshHost.append(make('p', { class: 'notice', text: `无法读取服务端最新状态：${readError.message || readError.code || '未知错误'}。草稿仍保留，未应用任何新状态。` }));
        handleError(readError);
      }
    }
    readFresh();
  }

  async function renderView() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await postJson('/api/render', {});
      current.viewStatus = response.viewStatus ?? current.viewStatus;
      updateHeader();
      setStatus('视图已重新生成；没有新增 review，状态未改变。', { focus: true });
    } catch (error) {
      handleError(error);
    } finally {
      setBusy(false);
    }
  }

  function digestValue(value) {
    const canonical = canonicalStringify(value);
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)).then((buffer) => {
      const bytes = Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0'));
      return 'sha256:' + bytes.join('');
    });
  }

  function canonicalStringify(value) {
    const seen = new Set();
    function walk(item) {
      if (item === null) return 'null';
      if (typeof item === 'boolean') return item ? 'true' : 'false';
      if (typeof item === 'number') {
        if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) throw new Error('数字不是安全的 JSON 值');
        return JSON.stringify(item);
      }
      if (typeof item === 'string') return JSON.stringify(item);
      if (typeof item !== 'object') throw new Error('值不是 JSON');
      if (seen.has(item)) throw new Error('存在循环引用');
      seen.add(item);
      try {
        if (Array.isArray(item)) return '[' + item.map((child) => walk(child)).join(',') + ']';
        return '{' + Object.keys(item).sort().map((key) => JSON.stringify(key) + ':' + walk(item[key])).join(',') + '}';
      } finally {
        seen.delete(item);
      }
    }
    return walk(value);
  }

  doc.addEventListener('click', (event) => {
    if (historySelection && event.target.closest('[data-action],[data-open-claim],[data-open-proposal],[data-open-node]')) { event.preventDefault(); return; }
    if (event.target.closest('#graph-roadmap')) {
      event.preventDefault();
      if (historySelection) {
        const host = doc.querySelector('#history-panel');
        host.replaceChildren(make('h2',{id:'history-panel-title',tabindex:'-1',text:'所选快照 · 功能规划'}),button('回到现在',{},() => {void graphTimeApi?.showCurrent();}));
        const list = make('div');
        list.innerHTML = helpers.renderRoadmapIndex(roadmapViewFor(historySelection.state),{historical:true,mode:historySelection.state ? 'current' : historySelection.loading ? 'loading' : 'unavailable'});
        host.append(list); doc.querySelector('#history-panel-title')?.focus({preventScroll:true});
      } else {
        saveDraft(); currentRoadmapSelection = null; roadmapIndexOpen = true;
        renderCurrentRoadmapPanel(); roadmapPanelTitle?.focus({preventScroll:true});
      }
      return;
    }
    const roadmapFilterButton = event.target.closest('[data-roadmap-filter]');
    if (roadmapFilterButton) {
      event.preventDefault();
      setRoadmapFilter(roadmapFilterButton.dataset.roadmapFilter);
      return;
    }
    const roadmapLocateButton = event.target.closest('[data-roadmap-locate]');
    if (roadmapLocateButton) {
      event.preventDefault();
      const nodeId = roadmapLocateButton.dataset.roadmapLocate;
      suppressGraphHook = true;
      try { graphApi?.selectNode(nodeId, true); } finally { suppressGraphHook = false; }
      doc.querySelector('#graph-viewport')?.focus({ preventScroll: true });
      return;
    }
    const roadmapItemButton = event.target.closest('[data-roadmap-item]');
    if (roadmapItemButton) {
      event.preventDefault();
      openRoadmapItem(roadmapItemButton.dataset.roadmapItem, { trigger: roadmapItemButton });
      return;
    }
    if (event.target.closest('[data-action],[data-open-claim],[data-open-proposal],[data-open-node]') && (currentRoadmapSelection || roadmapIndexOpen)) closeRoadmapPanel({focus:false});
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      event.preventDefault();
      if (!current.writable || writeBlocked) { setStatus('当前只读或已停写，不能执行动作。', { error: true, focus: true }); return; }
      const proposalId = actionButton.dataset.proposalId;
      if (proposalId) openProposal(proposalId, { mode: actionButton.dataset.action, trigger: actionButton });
      else openClaim(actionButton.dataset.claimId, { mode: actionButton.dataset.action, trigger: actionButton });
      return;
    }
    const openProposalButton = event.target.closest('[data-open-proposal]');
    if (openProposalButton) {
      event.preventDefault();
      openProposal(openProposalButton.dataset.openProposal, { trigger: openProposalButton });
      return;
    }
    const openClaimButton = event.target.closest('[data-open-claim]');
    if (openClaimButton) {
      event.preventDefault();
      openClaim(openClaimButton.dataset.openClaim, { trigger: openClaimButton });
      return;
    }
    const openNodeButton = event.target.closest('[data-open-node]');
    if (openNodeButton) {
      event.preventDefault();
      const nodeId = openNodeButton.dataset.openNode;
      if (graphApi?.selectNode) graphApi.selectNode(nodeId, true);
      else openNode(nodeId, { trigger: openNodeButton });
    }
  });

  doc.addEventListener('keydown', (event) => {
    if (historySelection) return;
    if (event.key !== 'Escape' || busy) return;
    if (roadmapPanel && !roadmapPanel.hidden) {
      event.preventDefault();
      closeRoadmapPanel();
      return;
    }
    if (!panelTarget) return;
    event.preventDefault();
    closePanel();
  });
  window.addEventListener('popstate', () => routeFromUrl({ focus: true }));
  window.addEventListener('focus', () => { if (!busy && !pending) refreshState({ quiet: true }); });
  doc.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !busy && !pending) refreshState({ quiet: true });
  });

  panelClose?.addEventListener('click', () => closePanel());
  roadmapClose?.addEventListener('click', () => closeRoadmapPanel());
  renderViewButton?.addEventListener('click', renderView);

  function initialize() {
    updateHeader();
    if (initialRoute.claimId || initialRoute.proposalId) {
      updateQuery(initialRoute.claimId, initialRoute.proposalId, 'replace');
    }
    updateGraph();
    inspectPending();
    refreshState({ restore: false }).then(() => {
      if (!panelTarget) {
        routeFromUrl({
          focus: false,
          claimId: initialRoute.claimId,
          proposalId: initialRoute.proposalId,
          hash: initialRoute.hash,
        });
      }
      inspectPending();
    });
  }

  initialize();
}
