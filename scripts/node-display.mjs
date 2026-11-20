// Shared, pure display projection for one node's own text, for the capabilities
// that own it, and for the saved work records of one capability. Three surfaces
// render from this one projection: the review sidebar (`review-ui.mjs`), the
// graph dialog (`graph-view.mjs`, through the projection embedded in the graph
// data) and the static map (`render-map.mjs`).
//
// A node's `description` is the node's ORIGINAL text. There is no separate
// "purpose" field in the schema, so the projection says so instead of renaming
// the original text into a purpose: it is not a confirmed product requirement,
// not a delivery stage and not an actual round of work.
//
// Every function here is stringified into a page (review helpers or the static
// map), so each one is self-contained: labels, edge kinds and escaping live
// inside the function, never in module scope, and no function calls another by
// bare identifier.

/**
 * Plain JSON projection of one node.
 * `state` is only read for `nodes`/`edges`/`evidence`; ownership comes from saved
 * `implemented_by` (implementation nodes) or `verified_by` (verification nodes)
 * edges pointing AT this node, and only product-capability owners count as the
 * owning Feature. Nothing is inferred from a label, a title or recency.
 */
export function nodeDisplayProjection(node, state) {
  const value = node && typeof node === 'object' ? node : {};
  const kind = typeof value.kind === 'string' ? value.kind : 'unknown';
  const kindLabels = {
    product_goal: '产品目标', user_group: '用户群体', user_task: '用户任务', capability: '产品能力',
    behavior_commitment: '行为承诺', business_object: '业务对象', implementation: '实现证据',
    verification: '验证证据', unknown: '待确认事项',
  };
  const nodes = Array.isArray(state?.nodes) ? state.nodes : [];
  const edges = Array.isArray(state?.edges) ? state.edges : [];
  const evidenceRecords = Array.isArray(state?.evidence) ? state.evidence : [];
  const byId = new Map(nodes
    .filter((entry) => entry && typeof entry.id === 'string')
    .map((entry) => [entry.id, entry]));
  const relationKind = kind === 'implementation' ? 'implemented_by' : kind === 'verification' ? 'verified_by' : null;
  const relatedCapabilities = [];
  const otherOwners = [];
  const seen = new Set();
  if (relationKind && typeof value.id === 'string') {
    for (const edge of edges) {
      if (!edge || typeof edge !== 'object' || edge.kind !== relationKind || edge.to !== value.id) continue;
      const ownerId = typeof edge.from === 'string' ? edge.from : '';
      if (!ownerId || seen.has(ownerId)) continue;
      seen.add(ownerId);
      const owner = byId.get(ownerId);
      if (!owner) {
        otherOwners.push({ id: ownerId, label: ownerId, kind: 'missing' });
        continue;
      }
      const entry = {
        id: owner.id,
        label: typeof owner.label === 'string' && owner.label ? owner.label : owner.id,
        kind: typeof owner.kind === 'string' ? owner.kind : 'unknown',
        relationKind,
      };
      if (entry.kind === 'capability') relatedCapabilities.push(entry);
      else otherOwners.push(entry);
    }
  }
  // Recorded evidence is listed, never summarised into a claim: a material being
  // recorded is not a test that ran in this session.
  const evidence = [];
  for (const rawId of Array.isArray(value.evidenceIds) ? value.evidenceIds : []) {
    if (typeof rawId !== 'string' || !rawId) continue;
    const record = evidenceRecords.find((item) => item && item.id === rawId) ?? null;
    if (!record) {
      evidence.push({ id: rawId, missing: true, kind: null, path: '', locator: '', validation: '' });
      continue;
    }
    evidence.push({
      id: rawId,
      missing: false,
      kind: typeof record.kind === 'string' ? record.kind : null,
      path: typeof record.path === 'string' ? record.path : '',
      locator: typeof record.locator === 'string' ? record.locator : '',
      validation: typeof record.validation === 'string' ? record.validation : '',
    });
  }
  const hasDescription = typeof value.description === 'string' && value.description.trim().length > 0;
  return {
    id: typeof value.id === 'string' ? value.id : '',
    kind,
    kindLabel: kindLabels[kind] ?? kind,
    // The only text this node actually records.
    sourceLabel: '原始节点说明',
    description: hasDescription ? value.description : '',
    descriptionMissing: '节点没有记录说明。',
    // The schema has no separate purpose field, so its absence is stated, not
    // filled in from the original text.
    purposeRecorded: false,
    purposeLabel: '用途说明',
    purposeText: '未单独记录用途说明',
    purposeNote: '这里引用的是节点原始说明；没有从原文里推断用途、需求或完成状态。',
    boundary: kind === 'implementation'
      ? '这是实现材料，不是已确认的产品需求，也不是某一轮实际工作的记录。'
      : kind === 'verification'
        ? '这是验证材料覆盖范围，不代表测试已经通过。'
        : null,
    relationKind,
    relatedLabel: relationKind === 'implemented_by'
      ? '关联功能（implemented_by）'
      : relationKind === 'verified_by' ? '所属功能（verified_by）' : null,
    relatedCapabilities,
    otherOwners,
    missingRelatedText: relationKind && relatedCapabilities.length === 0
      ? `未记录 ${relationKind} 关联的产品能力；不按标题或最近更新时间推断归属。`
      : null,
    ownerNote: relationKind
      ? '归属只按已保存的 implemented_by／verified_by 关系；没有按名称、标题或时间推断。'
      : null,
    evidence,
    evidenceSummary: evidence.length ? `已有证据 ${evidence.length} 条` : '未记录证据',
    evidenceNote: '证据列表只说明这些材料被记录过；是否在当前版本通过检查需要另行执行，这里不下结论。',
  };
}

/** Renders a projection as escaped original text plus its owner and evidence blocks. */
export function nodeDisplayHtml(projection) {
  if (!projection || typeof projection !== 'object') return '';
  const esc = (input) => String(input ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const asArray = (input) => (Array.isArray(input) ? input : []);
  const related = asArray(projection.relatedCapabilities);
  const others = asArray(projection.otherOwners);
  const evidence = asArray(projection.evidence);
  const parts = [];
  parts.push(`<p class="node-display-type" data-testid="node-display-type"><span class="node-display-kind">${esc(projection.sourceLabel ?? '原始节点说明')}</span> <span class="node-display-kind-meta">${esc(projection.kindLabel ?? projection.kind)}</span></p>`);
  parts.push(projection.description
    ? `<blockquote class="node-display-description">${esc(projection.description)}</blockquote>`
    : `<p class="node-display-missing">${esc(projection.descriptionMissing ?? '节点没有记录说明。')}</p>`);
  // The missing purpose is a plain line, not folded away: a reader must be able
  // to see that the original text is all this node records.
  parts.push(`<p class="node-display-purpose" data-testid="node-display-purpose" data-purpose-recorded="${projection.purposeRecorded === true ? 'true' : 'false'}"><strong>${esc(projection.purposeLabel ?? '用途说明')}</strong>：${esc(projection.purposeText ?? '未单独记录用途说明')}。${esc(projection.purposeNote ?? '')}</p>`);
  if (projection.boundary) parts.push(`<p class="node-display-note">${esc(projection.boundary)}</p>`);
  if (projection.relatedLabel) {
    if (related.length) {
      parts.push(`<p class="node-display-related" data-testid="node-display-related">${esc(projection.relatedLabel)}：${related
        .map((entry) => `<strong>${esc(entry.label)}</strong> <code>${esc(entry.id)}</code>`)
        .join('、')}</p>`);
    }
    if (others.length) {
      parts.push(`<p class="node-display-related" data-non-capability="true">另有 ${others.length} 个非产品能力节点引用这份材料：${others
        .map((entry) => `${esc(entry.label)}（${esc(entry.kind)}）`)
        .join('、')}（不计入功能工作记录）</p>`);
    }
    if (!related.length && projection.missingRelatedText) {
      parts.push(`<p class="node-display-missing">${esc(projection.missingRelatedText)}</p>`);
    }
    if (projection.ownerNote) parts.push(`<p class="node-display-note">${esc(projection.ownerNote)}</p>`);
  }
  if (evidence.length) {
    // Technical material is subordinate: collapsed by default, and stated to be
    // a record of what exists rather than a result.
    parts.push(`<details class="node-display-evidence" data-testid="node-display-evidence"><summary>${esc(projection.evidenceSummary ?? `已有证据 ${evidence.length} 条`)}</summary>
      <ul>${evidence.map((entry) => `<li><code>${esc(entry.id)}</code>${entry.missing
        ? '：状态里找不到这条证据记录（读取缺口，不是通过）'
        : `${entry.path ? ` · ${esc(entry.path)}` : ''}${entry.locator ? ` · ${esc(entry.locator)}` : ''}${entry.validation ? ` · 记录状态：${esc(entry.validation)}（不是本次执行结果）` : ''}`}</li>`).join('')}</ul>
      <p class="node-display-note">${esc(projection.evidenceNote ?? '')}</p>
    </details>`);
  } else if (projection.evidenceSummary) {
    parts.push(`<p class="node-display-meta">${esc(projection.evidenceSummary)}</p>`);
  }
  return `<div class="node-display" data-testid="node-display" data-node-kind="${esc(projection.kind)}" data-display-source="original-node-text">${parts.join('')}</div>`;
}

/** active / paused / ended counts of saved work entries; anything else is ended. */
export function nodeWorkCounts(entries) {
  const counts = { active: 0, paused: 0, ended: 0, total: 0 };
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const lifecycle = entry.lifecycle === 'active' || entry.lifecycle === 'paused' ? entry.lifecycle : 'ended';
    counts[lifecycle] += 1;
    counts.total += 1;
  }
  return counts;
}

/**
 * nodeId -> {nodeId, entries, counts} from a derived work index: every saved
 * work of a capability, never one "best" work, in the index's own order so the
 * first paint and every refresh list the same rows. Both the first
 * paint (`render-review.mjs`) and every later refresh (`review-ui.mjs`) call this
 * one function over `deriveCurrentWorkIndex(...)`, so the badge and the list can
 * never disagree about which works exist.
 */
export function nodeWorkIndexByNode(index) {
  const entries = Array.isArray(index?.entries) ? index.entries : null;
  if (!entries) return null;
  const rowsByNode = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.nodeId !== 'string') continue;
    if (!rowsByNode.has(entry.nodeId)) rowsByNode.set(entry.nodeId, []);
    rowsByNode.get(entry.nodeId).push(entry);
  }
  const map = {};
  for (const [nodeId, rows] of rowsByNode) {
    const group = { entries: [], counts: { active: 0, paused: 0, ended: 0, total: 0 } };
    for (const entry of rows) {
      if (typeof entry.workId !== 'string' || !entry.workId) continue;
      const lifecycle = entry.lifecycle === 'active' || entry.lifecycle === 'paused' ? entry.lifecycle : 'ended';
      group.entries.push({
        workId: entry.workId,
        workTitle: typeof entry.workTitle === 'string' ? entry.workTitle : '',
        lifecycle,
        updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
        basisReview: typeof entry.basisReview === 'string' ? entry.basisReview : null,
        endsReason: typeof entry.endsReason === 'string' ? entry.endsReason : null,
      });
      group.counts[lifecycle] += 1;
      group.counts.total += 1;
    }
    map[nodeId] = { nodeId, entries: group.entries, counts: group.counts };
  }
  return map;
}

/** "2 项进行中、1 项已暂停、1 项已结束" — every count is shown, none is picked. */
export function nodeWorkSummaryText(counts) {
  const value = counts && typeof counts === 'object' ? counts : {};
  const active = Number(value.active ?? 0) || 0;
  const paused = Number(value.paused ?? 0) || 0;
  const ended = Number(value.ended ?? 0) || 0;
  const parts = [];
  if (active) parts.push(`${active} 项进行中`);
  if (paused) parts.push(`${paused} 项已暂停`);
  if (ended) parts.push(`${ended} 项已结束`);
  return parts.length ? parts.join('、') : '没有已保存的工作记录';
}

/** Ended-only work reads as history, never as work currently in progress. */
export function nodeWorkListLabel(counts) {
  const value = counts && typeof counts === 'object' ? counts : {};
  const running = (Number(value.active ?? 0) || 0) + (Number(value.paused ?? 0) || 0);
  return running === 0 ? '历史工作' : '工作记录';
}

/** The exact empty state for a Feature with no saved work. */
export function nodeWorkEmptyText() {
  return '本功能尚无已保存的工作记录';
}

/**
 * What a list may claim about one Feature's saved work:
 * `{state, text}` with state 'unavailable' | 'saved' | 'truncated' | 'empty'.
 * A truncated or unreadable index can never be reported as the empty state.
 */
export function nodeWorkCoverage(counts, options) {
  const value = counts && typeof counts === 'object' ? counts : {};
  const total = Number(value.total ?? 0) || 0;
  const active = Number(value.active ?? 0) || 0;
  const paused = Number(value.paused ?? 0) || 0;
  const ended = Number(value.ended ?? 0) || 0;
  const truncated = options?.truncated === true;
  const omitted = Number(options?.omitted ?? 0) || 0;
  if (options?.supported === false) {
    return { state: 'unavailable', text: '本页未能派生工作索引；这是读取能力缺口，不表示没有保存过工作。' };
  }
  if (total > 0) {
    const parts = [];
    if (active) parts.push(`${active} 项进行中`);
    if (paused) parts.push(`${paused} 项已暂停`);
    if (ended) parts.push(`${ended} 项已结束`);
    return {
      state: 'saved',
      text: `已保存 ${total} 条${truncated ? '（已加载部分）' : ''}：${parts.join('、') || '没有已保存的工作记录'}`,
    };
  }
  if (truncated) {
    return {
      state: 'truncated',
      text: `索引已截断（还有 ${omitted} 条未显示）：已加载部分没有这条功能的工作记录，不能据此判定没有保存过工作。`,
    };
  }
  return { state: 'empty', text: '本功能尚无已保存的工作记录' };
}

/** Plain-text form of the projection, for places that render text, not HTML. */
export function nodeDisplayText(projection) {
  if (!projection || typeof projection !== 'object') return '';
  const asArray = (input) => (Array.isArray(input) ? input : []);
  const related = asArray(projection.relatedCapabilities);
  const others = asArray(projection.otherOwners);
  const evidence = asArray(projection.evidence);
  const lines = [
    `${projection.sourceLabel ?? '原始节点说明'}（${projection.kindLabel ?? projection.kind ?? '未分类'}）`,
    projection.description ? `「${projection.description}」` : (projection.descriptionMissing ?? '节点没有记录说明。'),
    `${projection.purposeLabel ?? '用途说明'}：${projection.purposeText ?? '未单独记录用途说明'}。${projection.purposeNote ?? ''}`,
  ];
  if (projection.boundary) lines.push(projection.boundary);
  if (projection.relatedLabel) {
    if (related.length) lines.push(`${projection.relatedLabel}：${related.map((entry) => `${entry.label}（${entry.id}）`).join('、')}`);
    else if (projection.missingRelatedText) lines.push(projection.missingRelatedText);
    if (others.length) lines.push(`另有 ${others.length} 个非产品能力节点引用这份材料（不计入功能工作记录）。`);
    if (projection.ownerNote) lines.push(projection.ownerNote);
  }
  if (evidence.length) {
    lines.push(`${projection.evidenceSummary ?? `已有证据 ${evidence.length} 条`}：${evidence
      .map((entry) => (entry.missing ? `${entry.id}（状态里找不到）` : `${entry.id}${entry.path ? ` · ${entry.path}` : ''}`))
      .join('；')}`);
    lines.push(projection.evidenceNote ?? '');
  } else if (projection.evidenceSummary) {
    lines.push(projection.evidenceSummary);
  }
  return lines.filter((line) => typeof line === 'string' && line).join('\n');
}