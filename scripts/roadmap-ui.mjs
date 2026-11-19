// Read-only roadmap projection for the live review page and the static map.
// Every function that is stringified into the page is self-contained: label
// maps and escaping live inside the function, never in module scope.
//
// Roadmap items reference stable capability nodes. They describe planning
// position and working state; they do not grant development or test authority.

export const roadmapStyles = `
.roadmap-directory{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:1rem;min-width:0}
.roadmap-head{display:flex;justify-content:space-between;gap:.8rem;align-items:flex-start;margin-bottom:.55rem}
.roadmap-head h2{margin:0}.roadmap-head p{color:var(--muted);font-size:.82rem;margin:.2rem 0 0;max-width:70ch}
.roadmap-counts{display:flex;flex-wrap:wrap;gap:.35rem;font-size:.76rem;color:var(--muted)}
.roadmap-filters{display:flex;flex-wrap:wrap;gap:.35rem;margin:.55rem 0 .7rem}
.roadmap-filters button{min-height:44px;padding:.35rem .7rem;font-size:.8rem}
.roadmap-filters button[aria-pressed=true]{background:var(--green-soft);border-color:#9cc6b2;color:#1e5945;font-weight:600}
.roadmap-groups{display:grid;gap:.75rem}
.roadmap-group h3{display:flex;flex-wrap:wrap;gap:.4rem;align-items:baseline;font-size:.92rem;margin:0 0 .3rem;color:var(--ink)}
.roadmap-group h3 .count{color:var(--muted);font-weight:400;font-size:.78rem}
.roadmap-list{list-style:none;margin:0;padding:0;display:grid;gap:.35rem}
.roadmap-item{display:block;width:100%;min-height:56px;text-align:left;padding:.5rem .65rem;border:1px solid var(--line);border-left:4px solid var(--line);border-radius:5px;background:var(--paper)}
.roadmap-item:hover{background:#edf3ef}.roadmap-item[aria-pressed=true]{border-color:var(--blue);background:var(--blue-soft)}
.roadmap-item[data-horizon=now]{border-left-color:var(--green)}
.roadmap-item[data-horizon=next]{border-left-color:var(--blue)}
.roadmap-item[data-horizon=later]{border-left-color:var(--amber)}
.roadmap-item[data-horizon=unplanned]{border-left-color:#8a9691}
.roadmap-item-top{display:flex;flex-wrap:wrap;gap:.35rem .55rem;align-items:baseline}
.roadmap-capability{font-weight:600;overflow-wrap:anywhere}
.roadmap-objective{display:block;color:var(--ink);font-size:.84rem;margin:.18rem 0;overflow-wrap:anywhere}
.roadmap-meta{display:flex;flex-wrap:wrap;gap:.3rem .55rem;font-size:.73rem;color:var(--muted)}
.roadmap-empty{border:1px dashed #aebcb6;border-radius:5px;padding:.65rem .75rem;color:var(--muted);font-size:.84rem;background:var(--paper)}
.roadmap-empty strong{color:var(--ink)}
.roadmap-panel{padding:1rem;border-bottom:1px solid var(--line);background:var(--surface);min-width:0}
.roadmap-panel-head{display:flex;justify-content:space-between;gap:.6rem;align-items:flex-start;margin-bottom:.4rem}
.roadmap-panel-head h2{font-size:1.02rem;margin:0;overflow-wrap:anywhere}
.roadmap-panel-head>div{min-width:0;flex:1}.roadmap-panel-head>button{flex:0 0 auto;white-space:nowrap}
.roadmap-panel-body{min-width:0}
.roadmap-detail{min-width:0}.roadmap-detail h3{font-size:.95rem;margin:.65rem 0 .35rem}
.roadmap-detail h4{font-size:.86rem;margin:.65rem 0 .25rem}
.roadmap-detail .intent-fields{grid-template-columns:max-content minmax(0,1fr)}
.continuity-fullscreen-host .review-main>.roadmap-directory{display:none}
.roadmap-panel button,.roadmap-detail button{min-height:44px}.roadmap-detail .link-button{white-space:normal}
.roadmap-detail .roadmap-note{background:var(--blue-soft);border:1px solid #bcd2e4;border-radius:4px;padding:.4rem .55rem;margin:.4rem 0;font-size:.8rem;color:var(--ink)}
.roadmap-detail .roadmap-status{display:flex;flex-wrap:wrap;gap:.35rem;margin:.4rem 0}
.roadmap-association{margin:.4rem 0 .25rem;font-size:.82rem;overflow-wrap:anywhere}
.roadmap-association strong{font-weight:600}
.roadmap-item-progress{display:block;margin:.22rem 0 0;font-size:.76rem;line-height:1.4;color:#3d5750}
.roadmap-item-progress span{display:block;overflow-wrap:anywhere}
.roadmap-item-progress .roadmap-progress-next{color:#2f4f43}
.roadmap-item-progress .roadmap-item-stale{color:#7a4b12;font-weight:600}
.feature-progress{border:1px solid #bfd0c8;border-radius:6px;background:#f7fbf9;padding:.6rem .7rem;margin:.55rem 0;min-width:0;overflow-wrap:anywhere}
.feature-progress-head p{margin:.18rem 0}
.feature-progress h3{font-size:.98rem;margin:0}
.feature-progress h4{font-size:.88rem;margin:.6rem 0 .25rem}
.feature-progress .feature-progress-state{display:flex;flex-wrap:wrap;gap:.3rem;margin:.4rem 0}
.feature-progress .feature-progress-state .badge{max-width:100%;white-space:normal;overflow-wrap:anywhere}
.feature-progress .intent-fields{grid-template-columns:max-content minmax(0,1fr)}
.feature-progress .intent-fields dd{min-width:0;overflow-wrap:anywhere}
.feature-progress .progress-list{margin:.2rem 0;padding-left:1.1rem}
.feature-progress .progress-list li{margin:.25rem 0;overflow-wrap:anywhere}
.feature-progress .progress-empty{border:1px dashed #aebcb6;border-radius:5px;padding:.5rem .6rem;background:#fff;color:#445853;font-size:.84rem}
.feature-progress .progress-boundary{background:#fff;border:1px solid #d5e2db;border-radius:4px;padding:.35rem .5rem;font-size:.8rem;color:#3d5750}
.feature-progress .progress-warning{border:1px solid #e3cfa4;background:#fbf5e6;border-radius:4px;padding:.35rem .5rem;font-size:.8rem;color:#6d4a10}
.feature-progress details{margin:.5rem 0 .2rem}
.feature-progress summary{cursor:pointer}
.feature-progress .progress-meta{color:var(--muted);font-size:.78rem}
.delivery-badge{display:inline-flex;align-items:center;gap:.25rem;border-radius:999px;padding:.06rem .5rem;font-size:.72rem;font-weight:600;line-height:1.5;border:1px solid transparent;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.delivery-badge[data-delivery=not_started],.delivery-badge[data-delivery=paused],.delivery-badge[data-delivery=unknown]{background:#eef1f0;color:#445853;border-color:#c3cdc9}
.delivery-badge[data-delivery=in_development],.delivery-badge[data-delivery=awaiting_release]{background:var(--blue-soft);color:#1d4d7a;border-color:#bcd2e4}
.delivery-badge[data-delivery=awaiting_verification],.delivery-badge[data-delivery=awaiting_acceptance]{background:#fbf5e6;color:#6d4a10;border-color:#e3cfa4}
.delivery-badge[data-delivery=completed]{background:var(--green-soft);color:#1e5945;border-color:#9cc6b2}
.delivery-badge[data-needs-review=true]{background:#fbf5e6;color:#6d4a10;border-color:#d9b96a;box-shadow:0 0 0 1px #d9b96a inset}
.feature-delivery{border:1px solid #d5e2db;border-radius:5px;background:#fff;padding:.45rem .55rem;margin:.4rem 0;font-size:.82rem}
.feature-delivery[data-needs-review=true]{border-color:#d9b96a;background:#fbf5e6}
.feature-delivery .feature-delivery-head{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center;margin-bottom:.2rem}
.feature-delivery .feature-delivery-reason{margin:.15rem 0;color:var(--ink)}
.feature-delivery .feature-delivery-review{margin:.15rem 0;color:#6d4a10;font-weight:600}
.feature-delivery .progress-meta{display:block;margin:.1rem 0}
.roadmap-progress-delivery{display:inline-flex;margin:.15rem .3rem 0 0}
.node-progress{margin:.2rem 0 .35rem;padding:.3rem .45rem;border:1px solid #d5e2db;border-radius:4px;background:#f7fbf9;font-size:.82rem;overflow-wrap:anywhere}
.node-progress span{display:block}
.node-progress .node-progress-next{color:#2f4f43}
.node-progress .delivery-badge{display:inline-flex;margin:0 0 .25rem}
`;

export function renderRoadmapFilters() {
  const labels = [['all', '全部'], ['now', 'Now · 现在'], ['next', 'Next · 接下来'], ['later', 'Later · 以后'], ['unplanned', '未排期']];
  return `<div class="roadmap-filters" role="group" aria-label="按规划位置筛选功能规划">${labels.map(([value, label]) => `<button type="button" data-roadmap-filter="${value}" aria-pressed="${value === 'all'}" data-testid="roadmap-filter-${value}">${label}</button>`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// 本轮在做 (current work): entry, detail, editor, preview
// ---------------------------------------------------------------------------
//
// Contract: references/current-work-contract.md §13. A saved work is a saved
// round of work, never a review, a Feature delivery stage, a completion metric
// or an execution authorization. The three chips (§13.2: work lifecycle, Feature
// delivery, saved delivery reading) are rendered by three different surfaces and
// are never merged into one.
//
// Every function below is stringified into the page, so it must be
// self-contained: labels, escaping and defaults live inside the function.
export const currentWorkStyles = `
.current-work-panel{padding:1rem;border-bottom:1px solid var(--line);background:var(--surface);min-width:0}
.current-work-panel-head{display:flex;justify-content:space-between;gap:.6rem;align-items:flex-start;margin-bottom:.4rem}
.current-work-panel-head h2{font-size:1.02rem;margin:0;overflow-wrap:anywhere}
.current-work-panel-head>div{min-width:0;flex:1}.current-work-panel-head>button{flex:0 0 auto;white-space:nowrap}
.current-work-list{list-style:none;margin:.35rem 0;padding:0;display:grid;gap:.3rem}
.current-work-row{display:flex;gap:.35rem;align-items:stretch}
.current-work-entry{flex:1 1 auto;min-width:0;text-align:left;padding:.4rem .55rem;border:1px solid var(--line);border-left:4px solid #8a9691;border-radius:5px;background:var(--paper)}
.current-work-entry:hover{background:#edf3ef}
.current-work-entry[aria-pressed=true]{border-color:var(--blue);background:var(--blue-soft)}
.current-work-entry[data-lifecycle=active]{border-left-color:var(--green)}
.current-work-entry[data-lifecycle=paused]{border-left-color:var(--amber)}
.current-work-entry[data-lifecycle=ended]{border-left-color:#8a9691}
.current-work-entry-title{display:block;font-weight:600;overflow-wrap:anywhere}
.current-work-entry-meta{display:block;color:var(--muted);font-size:.74rem;margin-top:.15rem;overflow-wrap:anywhere}
.current-work-locate{flex:0 0 auto;font-size:.76rem;padding:.2rem .5rem}
.current-work-empty{border:1px dashed #aebcb6;border-radius:5px;padding:.5rem .6rem;color:var(--muted);font-size:.82rem;background:var(--paper)}
.current-work-chip{display:inline-flex;align-items:center;border-radius:999px;padding:.04rem .45rem;font-size:.7rem;font-weight:600;line-height:1.5;border:1px solid #c3cdc9;background:#eef1f0;color:#445853;white-space:nowrap}
.current-work-chip[data-lifecycle=active]{background:var(--green-soft);color:#1e5945;border-color:#9cc6b2}
.current-work-chip[data-lifecycle=paused]{background:var(--amber-soft);color:#6d4a10;border-color:#e3cfa4}
.current-work-chip[data-confirmation=confirmed]{background:var(--green-soft);color:#1e5945;border-color:#9cc6b2}
.current-work-chip[data-confirmation=candidate]{background:var(--blue-soft);color:#1d4d7a;border-color:#bcd2e4}
.current-work-chip[data-confirmation=unconfirmed]{background:#fbf5e6;color:#6d4a10;border-color:#e3cfa4}
.current-work-badge{display:inline-flex;align-items:center;gap:.2rem;border-radius:999px;padding:.04rem .4rem;font-size:.7rem;font-weight:600;border:1px solid #9cc6b2;background:var(--green-soft);color:#1e5945;white-space:nowrap}
.current-work-detail{min-width:0;overflow-wrap:anywhere}
.current-work-detail h3{font-size:.98rem;margin:0 0 .2rem}
.current-work-detail h4{font-size:.86rem;margin:.7rem 0 .2rem}
.current-work-detail ul{margin:.2rem 0;padding-left:1.1rem}
.current-work-detail li{margin:.15rem 0}
.current-work-state{display:flex;flex-wrap:wrap;gap:.3rem;margin:.4rem 0}
.current-work-muted{color:var(--muted);font-size:.82rem;margin:.15rem 0}
.current-work-meta{color:var(--muted);font-size:.76rem;margin:.12rem 0}
.current-work-layer{background:#f7fbf9;border:1px solid #d5e2db;border-radius:4px;padding:.35rem .5rem;margin:.3rem 0}
.current-work-boundary{background:#fff;border:1px solid #d5e2db;border-radius:4px;padding:.35rem .5rem;font-size:.8rem;color:#3d5750;margin:.4rem 0}
.current-work-warning{border:1px solid #e3cfa4;background:#fbf5e6;border-radius:4px;padding:.35rem .5rem;font-size:.8rem;color:#6d4a10;margin:.4rem 0}
.current-work-actions{display:flex;flex-wrap:wrap;gap:.4rem;margin:.6rem 0 .2rem}
.current-work-form{display:grid;gap:.55rem;min-width:0}
.current-work-form fieldset{border:1px solid var(--line);border-radius:6px;padding:.6rem;margin:0;min-width:0}
.current-work-form label{display:block;font-size:.8rem;font-weight:600;margin:.35rem 0 .1rem}
.current-work-form input[type=text],.current-work-form textarea,.current-work-form select{width:100%}
.current-work-form textarea{min-height:4.2rem}
.current-work-form[data-readonly=true] .current-work-business{background:var(--paper)}
.current-work-diff table{width:100%;border-collapse:collapse;font-size:.76rem}
.current-work-diff th,.current-work-diff td{border:1px solid var(--line);padding:.25rem .35rem;vertical-align:top;text-align:left}
.current-work-diff pre{margin:0;max-height:9rem;overflow:auto;font-size:.72rem;white-space:pre-wrap;overflow-wrap:anywhere}
.current-work-history{list-style:none;margin:.3rem 0;padding:0;display:grid;gap:.3rem}
.current-work-history li{border:1px solid var(--line);border-radius:4px;padding:.3rem .45rem;background:var(--paper)}
`;

/**
 * One entry in a Feature detail's 本轮在做 list.
 * `entry`: {workId, nodeId, workTitle, featureLabel, lifecycle, updatedAt,
 *           basisReview, endsReason}
 */
export function renderCurrentWorkEntry(entry, options = {}) {
  if (!entry || typeof entry !== 'object') return '';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const lifecycleLabels = { active: '进行中', paused: '已暂停', ended: '已结束' };
  const endedLabels = { handoff: '已交接', cancelled: '已取消', scope_completed: '范围完成', other: '其它原因' };
  const basisLabels = {
    unchanged: '依据未变', changed: '依据有变化', unverified_no_digest: '依据内容未比较',
    unavailable: '依据无法比较', no_checkpoint: '尚无续接记录',
  };
  const historical = options.historical === true;
  const selected = options.selected === true;
  const lifecycle = typeof entry.lifecycle === 'string' ? entry.lifecycle : 'ended';
  const lifecycleText = lifecycle === 'ended' && endedLabels[entry.endsReason]
    ? `已结束 · ${endedLabels[entry.endsReason]}`
    : (lifecycleLabels[lifecycle] ?? lifecycle);
  const basisText = basisLabels[entry.basisReview] ?? (entry.basisReview ? String(entry.basisReview) : '依据未比较');
  const title = typeof entry.workTitle === 'string' && entry.workTitle ? entry.workTitle : '（未命名本轮工作）';
  const meta = `<span class="current-work-entry-meta">${esc(lifecycleText)} · ${esc(basisText)}${entry.updatedAt ? ` · ${esc(String(entry.updatedAt).slice(0, 16).replace('T', ' '))}` : ''}</span>`;
  if (historical) {
    return `<li class="current-work-row" data-readonly="true">
      <div class="current-work-entry" data-testid="current-work-entry" data-work-id="${esc(entry.workId)}" data-lifecycle="${esc(lifecycle)}">
        <span class="current-work-entry-title">${esc(title)}</span>${meta}
      </div>
    </li>`;
  }
  return `<li class="current-work-row">
    <button type="button" class="current-work-entry" data-testid="current-work-entry" data-work-id="${esc(entry.workId)}" data-work-node-id="${esc(entry.nodeId ?? '')}" data-lifecycle="${esc(lifecycle)}" aria-pressed="${selected ? 'true' : 'false'}">
      <span class="current-work-entry-title">${esc(title)}</span>${meta}
    </button>
    ${entry.nodeId ? `<button type="button" class="current-work-locate" data-work-focus-node="${esc(entry.nodeId)}" data-testid="current-work-locate" aria-label="在画布中定位 ${esc(title)} 所属能力">定位</button>` : ''}
  </li>`;
}

/** Card badge: a word, never only a colour (§13.2). */
export function renderCurrentWorkBadge(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const lifecycleLabels = { active: '进行中', paused: '已暂停', ended: '已结束' };
  const lifecycle = typeof entry.lifecycle === 'string' ? entry.lifecycle : 'ended';
  const title = typeof entry.workTitle === 'string' && entry.workTitle ? entry.workTitle : '本轮工作';
  const label = `本轮在做 · ${lifecycleLabels[lifecycle] ?? lifecycle}`;
  return `<span class="current-work-badge" data-testid="current-work-badge" data-lifecycle="${esc(lifecycle)}" data-work-id="${esc(entry.workId)}" title="${esc(title)}">${esc(label)}</span>`;
}

/**
 * One complete work reading, in the frozen §13.2 order:
 * 上层目标 / 工程阶段 → 依据需求 → 本轮做／不做 → 验收目标 →
 * 整体交付及已记录未闭环路径 → 本轮停点／下一步 → 范围建议（未选定） → 依据复核.
 */
export function renderCurrentWorkDetail(work, options = {}) {
  if (!work || typeof work !== 'object') return '';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const asArray = (value) => (Array.isArray(value) ? value : []);
  const historical = options.historical === true;
  const lifecycleLabels = { active: '进行中', paused: '已暂停', ended: '已结束' };
  const endedLabels = { handoff: '已交接', cancelled: '已取消', scope_completed: '范围完成', other: '其它原因' };
  const confirmationLabels = { confirmed: '已确认', candidate: '候选', unconfirmed: '未确认', not_applicable: '不适用' };
  const gapLabels = { no_relation: '已查找，没有合格的上层关系', kind_only: '只有类型相近，未确认关系', candidate_only: '只有候选，未确认' };
  const selectionLabels = { user_selected: '用户选定', within_task_authorization: '任务授权范围内', agent_proposed_unselected: '代理建议（未选定）' };
  const statusLabels = {
    unchanged: '依据未变', changed: '依据有变化', unverified_no_digest: '注入了摘要但未比较内容',
    unavailable: '依据无法比较', no_checkpoint: '尚无续接记录',
  };
  const changeLabels = {
    requirement_content_changed: '需求内容变化', requirement_unavailable: '需求内容无法比较',
    confirmation_changed: '确认状态变化', bookkeeping_changed: '记录字段变化',
  };
  const responsibilityLabels = { agent: '代理', user: '用户', device_operator: '设备操作者', unknown: '未指定' };
  const authorizationLabels = {
    none: '无需额外授权', source_write: '修改源码或配置', test_execution: '运行测试或命令',
    state_write: '写项目状态', service_restart: '停启本地服务', distribution: '构建或发布正式包',
  };
  const workId = typeof work.workId === 'string' ? work.workId : '';
  const lifecycle = work.lifecycle && typeof work.lifecycle === 'object' ? work.lifecycle : { status: 'ended', endedReason: null, endedNote: null };
  const lifecycleText = lifecycle.status === 'ended' && endedLabels[lifecycle.endedReason]
    ? `已结束 · ${endedLabels[lifecycle.endedReason]}`
    : (lifecycleLabels[lifecycle.status] ?? String(lifecycle.status ?? '未记录'));
  const upper = work.upper && typeof work.upper === 'object' ? work.upper : {};
  const itemList = (items, emptyText) => (asArray(items).length
    ? `<ul>${asArray(items).map((item) => `<li>${esc(item && typeof item === 'object' ? item.statement : item)}</li>`).join('')}</ul>`
    : `<p class="current-work-muted">${esc(emptyText)}</p>`);
  // Missing layers say so in place; they are never a blank (§13.2).
  const layer = (title, value, testId) => {
    const head = `<h4>${esc(title)}</h4>`;
    if (!value || typeof value !== 'object' || value.state === 'not_recorded') {
      return `<div class="current-work-layer" data-testid="${esc(testId)}" data-layer-state="not_recorded">${head}<p class="current-work-muted">未记录</p></div>`;
    }
    if (value.state === 'gap') {
      return `<div class="current-work-layer" data-testid="${esc(testId)}" data-layer-state="gap">${head}<p class="current-work-muted">上下文缺口：${esc(title)}</p><p class="current-work-meta">${esc(gapLabels[value.reason] ?? '已查找，没有合格记录')}</p></div>`;
    }
    if (value.state === 'unavailable') {
      return `<div class="current-work-layer" data-testid="${esc(testId)}" data-layer-state="unavailable">${head}<p class="current-work-muted">上下文缺口：${esc(title)}（保存时无法读取）</p></div>`;
    }
    const observed = value.observed && typeof value.observed === 'object' ? value.observed : {};
    const confirmation = observed.confirmation && typeof observed.confirmation === 'object' ? observed.confirmation : {};
    const label = typeof observed.label === 'string' && observed.label ? observed.label : (value.ref?.id ?? '未记录标签');
    const chip = `<span class="current-work-chip" data-confirmation="${esc(confirmation.status ?? 'unconfirmed')}">${esc(confirmationLabels[confirmation.status] ?? '未确认')}</span>`;
    const snapshotNote = observed.snapshotAvailable === true ? '' : '<p class="current-work-meta">按摘要保存；正文快照未写入</p>';
    return `<div class="current-work-layer" data-testid="${esc(testId)}" data-layer-state="found">${head}
      <p>${esc(label)} ${chip}</p>
      <p class="current-work-meta">引用：<code>${esc(value.ref?.id ?? '未记录')}</code>（${esc(value.ref?.collection ?? '未记录')}）</p>
      ${snapshotNote}
    </div>`;
  };
  const openPaths = asArray(upper.openUserPaths);
  const adopted = asArray(work.adopted);
  const changes = asArray(work.changes);
  const supportDigestNote = work.supportDigestSource === 'missing'
    ? '本条旧记录未保存实现／验证材料摘要，同 ID 内容无法比较；这不表示材料未变化。'
    : work.supportDigestSource === 'partial'
      ? `实现／验证材料摘要不完整，${asArray(work.supportDigestMissing).length} 项无法比较；不视为未变化。`
      : work.supportDigestSource === 'unverified'
        ? '本条记录已保存实现／验证摘要，但当前页面无法重新计算摘要，不能据此判断内容未变化。'
        : null;
  const selection = work.selection && typeof work.selection === 'object' ? work.selection : null;
  const resume = work.resume && typeof work.resume === 'object' ? work.resume : null;
  const resumeHtml = resume
    ? `<dl class="intent-fields">
        <dt>本轮停点</dt><dd>${esc(resume.stopPoint ?? '未记录')}</dd>
        <dt>下一步</dt><dd>${esc(resume.nextStep ?? '未记录')}</dd>
        <dt>责任方</dt><dd>${esc(responsibilityLabels[resume.responsibility] ?? resume.responsibility ?? '未记录')}</dd>
        <dt>所需授权</dt><dd>${esc(asArray(resume.authorizationRequired).length ? asArray(resume.authorizationRequired).map((value) => authorizationLabels[value] ?? value).join('、') : '未记录')}</dd>
      </dl>`
    : '<p class="current-work-muted">停点与下一步未记录</p>';
  const rangeHtml = selection
    ? `<p class="current-work-muted">范围建议：${esc(selectionLabels[selection.kind] ?? selection.kind ?? '未记录')}${selection.kind === 'agent_proposed_unselected' ? '（未选定，不会自动成为工作范围）' : ''}</p>
       <p class="current-work-meta">来源：${esc(asArray(selection.sourceRefs).length ? asArray(selection.sourceRefs).join('；') : '未记录')}</p>`
    : '<p class="current-work-muted">范围建议（未选定）</p>';
  const changesHtml = changes.length
    ? `<ul>${changes.map((change) => `<li><strong>${esc(changeLabels[change.class] ?? change.class)}</strong> · ${esc(change.layer ?? '')} · <code>${esc(change.id ?? '')}</code>${asArray(change.fields).length ? ` · 字段：${esc(asArray(change.fields).join('、'))}` : ''}${change.hasBothContents === false ? ' · 只有一份内容可对照' : ''}</li>`).join('')}</ul>`
    : '<p class="current-work-muted">没有记录到变化类别。</p>';
  const adoptedHtml = adopted.length
    ? `<ul>${adopted.map((entry) => `<li><code>${esc(entry.claimId)}</code> · ${esc(entry.state === 'unavailable' ? '依据内容不可得' : entry.matches === true ? '与保存摘要一致' : entry.matches === false ? '与保存摘要不同' : '未比较摘要')}</li>`).join('')}</ul>`
    : '<p class="current-work-muted">没有显式采用的依据需求。</p>';
  const controlsHtml = historical
    ? '<p class="current-work-boundary" data-readonly="true">历史快照只读：不显示保存或预览控制，不写入当前状态。</p>'
    : `<div class="current-work-actions">
        ${lifecycle.status === 'ended' ? '' : '<button type="button" data-work-action="edit" data-work-operation="adjust" data-work-id="' + esc(workId) + '">编辑本轮工作</button>'}
        ${lifecycle.status === 'active' ? '<button type="button" data-work-action="edit" data-work-operation="pause" data-work-id="' + esc(workId) + '">暂停</button>' : ''}
        ${lifecycle.status === 'paused' ? '<button type="button" data-work-action="edit" data-work-operation="resume" data-work-id="' + esc(workId) + '">继续</button>' : ''}
        ${lifecycle.status === 'ended' ? '' : '<button type="button" data-work-action="edit" data-work-operation="end" data-work-id="' + esc(workId) + '">结束本轮</button>'}
        <button type="button" data-work-action="history" data-work-id="${esc(workId)}">历次修订</button>
        <button type="button" data-work-action="back">回到现在</button>
      </div>`;
  return `<article class="current-work-detail" data-testid="current-work-detail" data-work-id="${esc(workId)}" data-lifecycle="${esc(lifecycle.status ?? 'ended')}"${historical ? ' data-readonly="true"' : ''}>
    <header>
      <p class="eyebrow">本轮在做 · 保存记录（非评审、非授权）</p>
      <h3>${esc(work.workTitle || '（未命名本轮工作）')}</h3>
      <div class="current-work-state">
        <span class="current-work-chip" data-testid="current-work-lifecycle" data-lifecycle="${esc(lifecycle.status ?? 'ended')}">${esc(lifecycleText)}</span>
        <span class="current-work-chip" data-testid="current-work-basis-review">依据复核：${esc(statusLabels[work.contextStatus] ?? '未比较')}</span>
        <span class="current-work-chip">修订 ${esc(work.revisionCount ?? 0)} 次</span>
      </div>
      <p class="current-work-meta">所属能力：<code>${esc(work.nodeId ?? '未记录')}</code>${work.featureLabel ? ` · ${esc(work.featureLabel)}` : ''} · 工作 ID：<code>${esc(workId)}</code></p>
      ${work.updatedAt ? `<p class="current-work-meta">最近保存：${esc(String(work.updatedAt).slice(0, 19).replace('T', ' '))}</p>` : ''}
    </header>
    ${layer('上层目标', upper.productGoal, 'work-layer-product-goal')}
    ${layer('工程阶段', upper.stage, 'work-layer-stage')}
    <h4>依据需求</h4>
    ${adoptedHtml}
    <p class="current-work-meta">依据复核：${esc(statusLabels[work.contextStatus] ?? '未比较')}${work.contentComparable === false ? '（本页未注入内容摘要，因此不比较正文差异）' : ''}</p>
    <h4>本轮做</h4>
    ${itemList(work.scope, '本轮做未记录（空数组只表示这一版没有记录，不表示范围无限）')}
    <h4>本轮不做</h4>
    ${itemList(work.exclusions, '本轮不做未记录')}
    <h4>验收目标</h4>
    ${itemList(work.acceptanceCriteria, '验收目标未记录')}
    <h4>整体交付及已记录未闭环路径</h4>
    <p class="current-work-muted">整体交付读数在 Feature 交付状态里单独显示（独立通道，不并进本轮工作，也不代表验收或发布）。</p>
    ${openPaths.length
      ? `<ul>${openPaths.map((entry, index) => `<li>${esc(entry && entry.observed && entry.observed.label ? entry.observed.label : '未记录标签')} <span class="current-work-meta">（path ${index + 1}${entry && entry.state === 'gap' ? ' · 上下文缺口' : ''}）</span></li>`).join('')}</ul>`
      : '<p class="current-work-muted">未记录未闭环的用户路径。</p>'}
    <h4>本轮停点／下一步</h4>
    ${resumeHtml}
    <h4>范围建议（未选定）</h4>
    ${rangeHtml}
    <h4>依据复核</h4>
    ${supportDigestNote ? `<p class="current-work-warning" data-testid="current-work-support-comparison" data-comparable="false">${esc(supportDigestNote)}</p>` : work.supportContentComparable === true ? '<p class="current-work-meta" data-testid="current-work-support-comparison" data-comparable="true">实现／验证支持材料有保存摘要，可逐项比较。</p>' : ''}
    ${changesHtml}
    ${work.changesTruncated === true ? '<p class="current-work-warning">变化类别过多，只显示前一部分；完整记录在状态文件里。</p>' : ''}
    <p class="current-work-boundary">本轮在做是保存的工作说明：不是人工评审，不是 Feature 交付阶段，不是完成度，也不授予执行或写入权限。</p>
    ${controlsHtml}
  </article>`;
}

/**
 * The separate work editor (§13.2). It always submits a COMPLETE business
 * snapshot; for pause/resume/end the business fields are read-only so the only
 * thing a human can change is the lifecycle and its reason.
 *
 * `work` is the same projection renderCurrentWorkDetail takes; `options.phase`
 * is 'editing' | 'previewing' | 'previewReady' | 'saving' | 'saved' | 'conflict'
 * | 'failed' | 'unknown'.
 */
export function renderCurrentWorkEditor(work, options = {}) {
  if (!work || typeof work !== 'object') return '';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const escAttr = (value) => esc(value).replaceAll('`', '&#96;');
  const asArray = (value) => (Array.isArray(value) ? value : []);
  const operation = ['open', 'adjust', 'pause', 'resume', 'end'].includes(options.operation)
    ? options.operation
    : 'adjust';
  const operationLabels = { open: '开始本轮', adjust: '编辑本轮', pause: '暂停本轮', resume: '继续本轮', end: '结束本轮' };
  const lifecycleLabels = { active: '进行中', paused: '已暂停', ended: '已结束' };
  const responsibilityLabels = { agent: '代理', user: '用户', device_operator: '设备操作者', unknown: '未指定' };
  const authorizationLabels = {
    none: '无需额外授权', source_write: '修改源码或配置', test_execution: '运行测试或命令',
    state_write: '写项目状态', service_restart: '停启本地服务', distribution: '构建或发布正式包',
  };
  const endedLabels = { handoff: '已交接', cancelled: '已取消', scope_completed: '范围完成', other: '其它原因' };
  const busy = options.phase === 'previewing' || options.phase === 'saving';
  const businessReadOnly = operation === 'pause' || operation === 'resume' || operation === 'end';
  const lifecycle = work.lifecycle && typeof work.lifecycle === 'object' ? work.lifecycle : { status: 'active', endedReason: null, endedNote: null };
  const scope = asArray(work.scope).map((item) => (item && typeof item === 'object' ? item.statement : item)).filter((value) => typeof value === 'string');
  const exclusions = asArray(work.exclusions).map((item) => (item && typeof item === 'object' ? item.statement : item)).filter((value) => typeof value === 'string');
  const acceptance = asArray(work.acceptanceCriteria).map((item) => (item && typeof item === 'object' ? item.statement : item)).filter((value) => typeof value === 'string');
  const resume = work.resume && typeof work.resume === 'object' ? work.resume : null;
  const readOnlyAttr = businessReadOnly ? ' readonly aria-readonly="true"' : '';
  const disabledAttr = busy ? ' disabled' : '';
  const authorizationOptions = Object.keys(authorizationLabels).map((value) => {
    const checked = asArray(resume?.authorizationRequired).includes(value) ? ' checked' : '';
    return `<label class="current-work-check"><input type="checkbox" data-field="authorizationRequired" value="${escAttr(value)}"${checked}${businessReadOnly || busy ? ' disabled' : ''}> ${esc(authorizationLabels[value])}</label>`;
  }).join('');
  return `<form class="current-work-form" data-testid="current-work-form" data-form="current-work" data-work-id="${escAttr(work.workId ?? '')}" data-operation="${escAttr(operation)}" data-node-id="${escAttr(work.nodeId ?? '')}" data-predecessor-id="${escAttr(work.currentRecordId ?? '')}" data-readonly="${businessReadOnly ? 'true' : 'false'}" aria-label="${escAttr(operationLabels[operation])}" novalidate>
    <p class="eyebrow">${esc(operationLabels[operation])} · 提交完整快照</p>
    <p class="current-work-meta">表单每次都提交完整工作快照，不会让服务端合并旧值。${businessReadOnly ? '暂停／继续／结束只改生命周期：业务字段按保存值只读带入，改动会被服务端拒绝。' : ''}</p>
    <fieldset class="current-work-business">
      <legend>本轮工作</legend>
      <label for="work-title-input">标题</label>
      <input type="text" id="work-title-input" data-field="workTitle" value="${escAttr(work.workTitle ?? '')}" maxlength="200"${readOnlyAttr}${disabledAttr}>
      <label for="work-objective-input">目标</label>
      <textarea id="work-objective-input" data-field="objective" maxlength="2000"${readOnlyAttr}${disabledAttr}>${esc(work.objective ?? '')}</textarea>
      <label for="work-scope-input">本轮做（每行一条）</label>
      <textarea id="work-scope-input" data-field="scope"${readOnlyAttr}${disabledAttr}>${esc(scope.join('\n'))}</textarea>
      <label for="work-exclusions-input">本轮不做（每行一条）</label>
      <textarea id="work-exclusions-input" data-field="exclusions"${readOnlyAttr}${disabledAttr}>${esc(exclusions.join('\n'))}</textarea>
      <label for="work-acceptance-input">验收目标（每行一条）</label>
      <textarea id="work-acceptance-input" data-field="acceptanceCriteria"${readOnlyAttr}${disabledAttr}>${esc(acceptance.join('\n'))}</textarea>
      <label for="work-source-refs-input">来源引用（每行一条）</label>
      <textarea id="work-source-refs-input" data-field="sourceRefs"${readOnlyAttr}${disabledAttr}>${esc(asArray(work.sourceRefs).join('\n'))}</textarea>
    </fieldset>
    <fieldset>
      <legend>停点与下一步</legend>
      <label for="work-stop-point-input">本轮停点</label>
      <input type="text" id="work-stop-point-input" data-field="stopPoint" value="${escAttr(resume?.stopPoint ?? '')}" maxlength="2000"${readOnlyAttr}${disabledAttr}>
      <label for="work-next-step-input">下一步</label>
      <input type="text" id="work-next-step-input" data-field="nextStep" value="${escAttr(resume?.nextStep ?? '')}" maxlength="2000"${readOnlyAttr}${disabledAttr}>
      <label for="work-responsibility-select">责任方</label>
      <select id="work-responsibility-select" data-field="responsibility"${businessReadOnly || busy ? ' disabled' : ''}>
        ${Object.keys(responsibilityLabels).map((value) => `<option value="${escAttr(value)}"${(resume?.responsibility ?? 'agent') === value ? ' selected' : ''}>${esc(responsibilityLabels[value])}</option>`).join('')}
      </select>
      <p class="current-work-meta">所需授权（记录建议，不会自动执行）</p>
      ${authorizationOptions}
    </fieldset>
    ${operation === 'end' ? `<fieldset>
      <legend>结束原因</legend>
      <label for="work-ended-reason-select">原因</label>
      <select id="work-ended-reason-select" data-field="endedReason"${busy ? ' disabled' : ''}>
        ${Object.keys(endedLabels).map((value) => `<option value="${escAttr(value)}"${(lifecycle.endedReason ?? 'scope_completed') === value ? ' selected' : ''}>${esc(endedLabels[value])}</option>`).join('')}
      </select>
      <label for="work-ended-note-input">说明（可选）</label>
      <input type="text" id="work-ended-note-input" data-field="endedNote" value="${escAttr(lifecycle.endedNote ?? '')}" maxlength="2000"${busy ? ' disabled' : ''}>
    </fieldset>` : ''}
    <p class="current-work-meta">生命周期会按操作变为：${esc(operation === 'pause' ? lifecycleLabels.paused : operation === 'end' ? lifecycleLabels.ended : lifecycleLabels.active)}。上层目标、工程阶段、范围建议由服务端按当前状态重新解析，表单不会让它们变成自由 JSON。</p>
    <div class="current-work-actions">
      <button type="button" data-work-action="preview"${busy ? ' disabled' : ''}>生成预览</button>
      <button type="button" data-work-action="save"${options.phase === 'previewReady' ? '' : ' hidden'}>保存（写入后回读）</button>
      <button type="button" data-work-action="cancel"${busy ? ' disabled' : ''}>取消</button>
    </div>
    <p class="current-work-meta" data-work-testid="work-phase" data-phase="${escAttr(options.phase ?? 'editing')}">${esc({
      editing: '编辑中：还没有生成预览。', previewing: '正在生成预览（不写任何文件）…', previewReady: '预览已生成：确认差异后再保存。',
      saving: '正在保存…', saved: '已保存并回读。', conflict: '保存冲突：请重新读取后重试。',
      failed: '保存失败：草稿仍保留。', unknown: '保存结果未知：正在独立读取状态。',
    }[options.phase ?? 'editing'] ?? '编辑中。')}</p>
  </form>`;
}

/** The human-facing diff of a preview (§10.2). Nothing here writes anything. */
export function renderCurrentWorkPreview(preview) {
  if (!preview || typeof preview !== 'object') return '';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const asArray = (value) => (Array.isArray(value) ? value : []);
  const groupLabels = {
    lifecycle: '生命周期', workTitle: '标题', objective: '目标', scope: '本轮做', exclusions: '本轮不做',
    acceptanceCriteria: '验收目标', selection: '范围选择', upper: '上层依据', resume: '停点／下一步',
    source: '来源', sourceRefs: '来源引用', basisRefs: '依据引用', adoptedBasis: '采用的依据需求', recordShell: '整体记录外壳',
  };
  const valueHtml = (value) => {
    let text;
    try { text = JSON.stringify(value ?? null, null, 1); } catch { text = String(value); }
    if (text === undefined) text = 'null';
    return `<pre>${esc(text)}</pre>`;
  };
  const rows = asArray(preview.diff).map((group) => `<tr>
      <th scope="row">${esc(groupLabels[group.group] ?? group.group)}</th>
      <td>${valueHtml(group.before)}</td>
      <td>${valueHtml(group.after)}</td>
    </tr>`).join('');
  const sidecars = asArray(preview.sidecarPlan);
  return `<section class="current-work-diff" data-testid="current-work-diff" data-phase="previewReady">
    <h4>预览：将要写入的记录</h4>
    <p class="current-work-meta">预览不写任何文件：没有状态、没有备份、没有 sidecar、没有预览文件。</p>
    <dl class="intent-fields">
      <dt>操作</dt><dd>${esc(preview.operation ?? '未记录')}</dd>
      <dt>工作 ID</dt><dd><code>${esc(preview.workId ?? '未记录')}</code></dd>
      <dt>预览内容摘要</dt><dd><code>${esc(preview.previewContentDigest ?? '未记录')}</code></dd>
      <dt>预览有效期</dt><dd>${esc(preview.expiresAt ?? '未记录')}</dd>
    </dl>
    <div style="overflow-x:auto">
      <table>
        <caption class="current-work-meta">两侧都是完整值，不是缩写；没有变化的组也列出。</caption>
        <thead><tr><th scope="col">分组</th><th scope="col">当前保存值</th><th scope="col">将写入值</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <h4>将要创建的 sidecar</h4>
    ${sidecars.length
      ? `<ul>${sidecars.map((entry) => `<li><code>${esc(entry.path)}</code> · ${esc(entry.collection ?? '')} ${esc(entry.claimId ?? '')}</li>`).join('')}</ul>`
      : '<p class="current-work-muted">本次预览不创建 sidecar。</p>'}
    ${asArray(preview.notes).length ? `<ul>${asArray(preview.notes).map((note) => `<li>${esc(note)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

/** Read-only list of one work's revisions, newest first (§13.2 history). */
export function renderCurrentWorkHistory(work) {
  if (!work || typeof work !== 'object') return '';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const records = Array.isArray(work.historyRecords) ? work.historyRecords : [];
  const operationLabels = { open: '开始', adjust: '编辑', pause: '暂停', resume: '继续', end: '结束' };
  return `<section class="current-work-detail" data-testid="current-work-history" data-readonly="true">
    <h4>历次修订（新→旧，只读）</h4>
    <p class="current-work-meta">历史快照只读：没有保存或预览控制，不写入当前状态。</p>
    ${records.length
      ? `<ol class="current-work-history">${records.map((record) => `<li>
          <strong>${esc(operationLabels[record.operation] ?? record.operation ?? '记录')}</strong> · ${esc(String(record.createdAt ?? '').slice(0, 19).replace('T', ' '))}
          <div class="current-work-meta"><code>${esc(record.id ?? '未记录')}</code> · ${esc(record.workTitle ?? '')}</div>
        </li>`).join('')}</ol>`
      : '<p class="current-work-muted">没有可显示的历史修订。</p>'}
  </section>`;
}

// Plain JSON projection of deriveFeatureProgress() for card and list summaries.
// The words are deliberately those of contract §11.1: a saved record is not a
// review, not a completion rate and not an execution authorization.
export function featureProgressSummaryMap(progressView) {
  const map = {};
  const asArray = (value) => (Array.isArray(value) ? value : []);
  const horizonLabels = { now: 'Now · 现在', next: 'Next · 接下来', later: 'Later · 以后', unplanned: '未排期' };
  const statusLabels = { idea: '想法', ready: '可开始', in_progress: '进行中', paused: '暂停', closed: '已关闭' };
  const nextText = (latest) => {
    if (!latest) return '下一步未记录';
    if (latest.nextActionsStatus === 'recorded') {
      const action = latest.firstNextAction;
      return action?.statement ? `下一步：${action.statement}` : '下一步：记录异常，详情核对';
    }
    if (latest.nextActionsStatus === 'none') return '下一步：已明确无后续动作';
    if (latest.nextActionsStatus === 'not_prepared') return '下一步：下一步尚未整理';
    return '下一步：下一步状态未记录';
  };
  const contextText = (status) => {
    if (status === 'changed') return '续接依据有变化，需复核';
    if (status === 'unchanged') return '保存态相关上下文未变（不代表源码或运行状态已核验）';
    if (status === 'unverified_no_digest') return '保存态结构未变；内容指纹未重算';
    if (status === 'unavailable') return '续接依据无法比较';
    return '尚无续接记录';
  };
  for (const feature of asArray(progressView?.features)) {
    if (!feature || typeof feature.nodeId !== 'string') continue;
    const latest = feature.latest ?? null;
    const contextStatus = latest ? feature.context?.status ?? 'unavailable' : 'no_checkpoint';
    const snapshotCount = Number(feature.source?.snapshotCount ?? 0);
    const roadmap = feature.roadmap?.item ?? null;
    map[feature.nodeId] = {
      hasCheckpoint: Boolean(latest),
      checkpointCount: Number(feature.checkpoints?.count ?? 0),
      summary: latest?.summary ?? '',
      stopText: latest ? (latest.stopPoint ? `停点：${latest.stopPoint}` : '停点未记录') : '尚无续接记录',
      nextText: nextText(latest),
      contextStatus,
      contextText: contextText(contextStatus),
      sourceText: latest ? (snapshotCount > 0 ? `按保存记录（含 ${snapshotCount} 个源码摘要）；本次未核对源码` : '按保存记录；源码未核对') : '',
      planningText: roadmap
        ? (roadmap.status === 'closed' ? '规划项已关闭（不等于交付）' : `规划位置：${horizonLabels[roadmap.horizon] ?? roadmap.horizon} · ${statusLabels[roadmap.status] ?? roadmap.status}`)
        : '规划未记录',
      nextActionsStatus: latest?.nextActionsStatus ?? null,
      delivery: feature.delivery ?? null,
    };
  }
  return map;
}

// Two short card lines plus the full text for aria-label/title. Long text is
// clipped visually by CSS only; the element keeps the complete string.
// `delivery` is the saved delivery-stage projection: a scannable badge shape
// shared by graph cards, text cards and planning rows. It never adds a line to
// the 224x128 graph card; the full name and basis stay in aria/title.
export function featureProgressCardLines(feature) {
  // Self-contained: this function is stringified into the page, so the badge
  // shape lives inside it, never in module scope.
  const deliveryBadgeShape = (entry) => {
    const delivery = entry?.delivery ?? null;
    if (!delivery || typeof delivery.status !== 'string') {
      return { status: 'unknown', needsReview: false, label: '状态待补充', badgeText: '状态待补充', text: '交付：状态待补充', title: '交付阶段待补充：无保存依据；不据此推断开发或交付进度。', aria: '交付阶段：状态待补充（无保存依据，不据此推断开发或交付进度）' };
    }
    const label = typeof delivery.label === 'string' && delivery.label ? delivery.label : '状态待补充';
    const reviewText = delivery.needsReview ? `；${delivery.reviewReason || '需复核'}` : '';
    const basisText = delivery.basisText || '无保存依据';
    const gapText = Array.isArray(delivery.gaps) && delivery.gaps.length
      ? `；其它缺口：${delivery.gaps.map((gap) => gap?.label ?? gap?.category ?? '').filter(Boolean).join('、')}`
      : '';
    return {
      status: delivery.status,
      needsReview: delivery.needsReview === true,
      label,
      badgeText: delivery.needsReview ? `需复核 · ${label}` : label,
      text: delivery.needsReview ? `交付：${label} · 需复核` : `交付：${label}`,
      title: `交付阶段：${label}（${basisText}）${reviewText}${gapText}`,
      aria: `交付阶段：${label}（${basisText}）${reviewText}${gapText}`,
    };
  };
  const delivery = deliveryBadgeShape(feature);
  if (!feature || !feature.latest) {
    return {
      line1: '尚无续接记录', line2: '下一步未记录', status: 'empty', delivery,
      aria: `尚无续接记录；这不等于没有剩余工作。${delivery.aria}`,
    };
  }
  const latest = feature.latest;
  const context = feature.context ?? {};
  const status = context.status ?? 'unavailable';
  const line1 = status === 'changed' ? '续接依据有变化，需复核' : (latest.summary || '已保存续接记录');
  let line2;
  if (latest.nextActionsStatus === 'recorded') {
    const action = latest.firstNextAction;
    line2 = action?.statement ? `下一步：${action.statement}` : '下一步：记录异常，详情核对';
  } else if (latest.nextActionsStatus === 'none') {
    line2 = '下一步：已明确无后续动作';
  } else if (latest.nextActionsStatus === 'not_prepared') {
    line2 = '下一步：下一步尚未整理';
  } else {
    line2 = '下一步：下一步状态未记录';
  }
  const contextText = status === 'changed' ? '续接依据有变化，需复核'
    : status === 'unchanged' ? '保存态相关上下文未变（不代表源码或运行状态已核验）'
      : status === 'unverified_no_digest' ? '保存态结构未变；内容指纹未重算'
        : '续接依据无法比较';
  const snapshotCount = Number(feature.source?.snapshotCount ?? 0);
  const sourceText = snapshotCount > 0 ? `按保存记录（含 ${snapshotCount} 个源码摘要）；本次未核对源码` : '按保存记录；源码未核对';
  return {
    line1, line2, status,
    aria: [line1, line2 || '', contextText, sourceText, delivery.aria].filter(Boolean).join('。'),
    delivery,
  };
}

// Full, progressive detail for the right-hand non-modal panel and the roadmap
// inspector. `detail` is the JSON view from selectFeatureContext(). Checkpoint
// text is untrusted input: every value below is escaped.
export function renderFeatureProgressDetail(detail, options = {}) {
  if (!detail || detail.status !== 'ok') return '';
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const asArray = (value) => (Array.isArray(value) ? value : []);
  // Self-contained badge renderer: this function is stringified into the page.
  // needsReview always wins the tone so a stale positive stage cannot quietly
  // read as settled.
  const deliveryBadgeHtml = (entry, testId) => {
    if (!entry || typeof entry !== 'object') return '';
    const needsReview = entry.needsReview === true;
    const label = needsReview ? `需复核 · ${entry.label ?? '状态待补充'}` : (entry.label ?? '状态待补充');
    const title = [entry.basisText, entry.reason, entry.reviewReason].filter(Boolean).join(' · ');
    return `<span class="delivery-badge" data-testid="${esc(testId)}" data-delivery="${esc(entry.status ?? 'unknown')}" data-tone="${esc(entry.tone ?? 'muted')}" data-needs-review="${needsReview ? 'true' : 'false'}" title="${esc(title)}">${esc(label)}</span>`;
  };
  const historical = options.historical === true;
  const latest = detail.latest ?? null;
  const ordered = asArray(detail.checkpoints?.ordered);
  const context = detail.context ?? {};
  const source = detail.source ?? {};
  const roadmap = detail.roadmap?.item ?? null;
  const horizonLabels = { now: 'Now · 现在', next: 'Next · 接下来', later: 'Later · 以后', unplanned: '未排期' };
  const statusLabels = { idea: '想法', ready: '可开始', in_progress: '进行中', paused: '暂停', closed: '已关闭' };
  const actorLabels = { agent: '代理', user: '用户', device_operator: '设备操作者', unknown: '未指定' };
  const categoryLabels = {
    implementation: '实现', verification: '验证', manual_experience: '人工体验', product_decision: '产品取舍',
    record_maintenance: '记录维护', release: '发布', other: '其他',
  };
  const actionCategoryLabels = {
    implement: '实现', verify: '验证', inspect: '检查', review: '审阅', decide: '决定', record: '记录', operate: '设备操作', other: '其他',
  };
  const authorizationLabels = {
    none: '无需额外授权', source_write: '修改源码或配置', test_execution: '运行测试或命令',
    state_write: '写项目状态', service_restart: '停启本地服务', distribution: '构建或发布正式包',
  };
  const sourceLabels = { agent_organized: '代理整理（非评审）', user_note: '用户备注（非评审）' };
  const contextText = context.status === 'changed' ? '续接依据有变化，需复核'
    : context.status === 'unchanged' ? '保存态相关上下文未变（不代表源码或运行状态已核验）'
      : context.status === 'unverified_no_digest' ? '保存态结构未变；内容指纹未重算'
        : context.status === 'unavailable' ? '续接依据无法比较' : '尚无续接记录';
  const snapshotCount = Number(source.snapshotCount ?? 0);
  const sourceText = latest ? (snapshotCount > 0 ? `按保存记录（含 ${snapshotCount} 个源码摘要）；本次未核对源码` : '按保存记录；源码未核对') : '';
  const basisRefs = (refs, emptyText) => (asArray(refs).length
    ? `<span class="progress-meta">依据：${asArray(refs).map((ref) => ref && typeof ref === 'object'
      ? `<code>${esc(ref.id)}</code>（${esc(ref.collection)}）`
      : esc(ref)).join('、')}</span>`
    : `<span class="progress-meta">${esc(emptyText)}</span>`);
  const nextActions = asArray(latest?.nextActions);
  const nextActionsHtml = latest
    ? (latest.nextActionsStatus === 'recorded'
      ? (nextActions.length
        ? `<ul class="progress-list">${nextActions.map((action) => {
          const authorizations = asArray(action.authorizationRequired);
          const authorizationText = authorizations.length === 0
            ? '未记录所需授权'
            : authorizations.includes('none')
              ? `${authorizationLabels.none}（该动作仍不会自动执行）`
              : authorizations.map((value) => authorizationLabels[value] ?? value).join('、');
          return `<li><strong>${esc(action.statement)}</strong>
            <div class="progress-meta">责任方：${esc(actorLabels[action.actor] ?? action.actor)} · 动作类别：${esc(actionCategoryLabels[action.category] ?? action.category)} · 所需授权：${esc(authorizationText)}</div>
            <div class="progress-meta">前置条件：${asArray(action.preconditions).length ? esc(asArray(action.preconditions).join('；')) : '未记录前置条件'}</div>
          </li>`;
        }).join('')}</ul>`
        : '<p class="progress-warning">已记录“有下一步”，但动作列表为空（状态异常，需人工核对）。</p>')
      : latest.nextActionsStatus === 'none'
        ? '<p><strong>已明确无后续动作</strong></p>'
        : latest.nextActionsStatus === 'not_prepared'
          ? '<p><strong>下一步尚未整理</strong></p>'
          : '<p class="progress-warning">下一步状态未记录。</p>')
    : '';
  const workDoneHtml = asArray(latest?.workDone).length
    ? `<ul class="progress-list">${latest.workDone.map((item) => `<li>${esc(item.statement)} ${basisRefs(item.basisRefs, '未记录依据')}</li>`).join('')}</ul>`
    : '<p class="progress-meta">未记录已做工作。</p>';
  const remainingHtml = asArray(latest?.remaining).length
    ? `<ul class="progress-list">${latest.remaining.map((item) => `<li><span class="badge">${esc(categoryLabels[item.category] ?? item.category)}</span> ${esc(item.statement)}
      <div class="progress-meta">责任方：${esc(actorLabels[item.responsibility] ?? item.responsibility)} · ${basisRefs(item.basisRefs, '未记录依据')}</div></li>`).join('')}</ul>`
    : '<p><strong>剩余事项未记录</strong></p>';
  const historySource = ordered.length ? ordered : (latest ? [latest] : []);
  const historyHtml = historySource.length
    ? `<details class="feature-progress-history"><summary>历次续接（${historySource.length} 条，旧→新）</summary>
      <ol class="progress-list">${historySource.map((record, index) => `<li>
        <strong>${esc(record.summary)}</strong>
        <div class="progress-meta">${esc(record.createdAt)} · ${esc(sourceLabels[record.source] ?? record.source)} · ${esc(record.stopPoint ? `停点：${record.stopPoint}` : '停点未记录')}${index === historySource.length - 1 ? ' · 链尾（保存顺序最后一条，不代表更可信）' : ''}</div>
      </li>`).join('')}</ol>
      <p class="progress-meta">记录按 supersedes 链排列；较新的记录不自动压过旧证据，修正以追加记录表达。</p>
    </details>`
    : '';
  const validation = detail.checkpoints?.validation;
  const validationHtml = validation && validation.ok === false
    ? `<div class="progress-warning">记录校验存在错误，需人工核对；以下内容按原始保存记录展示，不补齐、不猜测。
      <ul class="progress-list">${asArray(validation.errors).slice(0, 5).map((error) => `<li>${esc(error)}</li>`).join('')}</ul></div>`
    : '';
  const planningText = roadmap
    ? (roadmap.status === 'closed' ? '规划项已关闭（不等于交付）' : `规划位置：${horizonLabels[roadmap.horizon] ?? roadmap.horizon} · ${statusLabels[roadmap.status] ?? roadmap.status}`)
    : '规划未记录';
  const delivery = detail.delivery ?? null;
  const deliveryGaps = asArray(delivery?.gaps);
  const deliveryHtml = delivery
    ? `<div class="feature-delivery" data-testid="feature-delivery-status" data-delivery="${esc(delivery.status ?? 'unknown')}" data-needs-review="${delivery.needsReview === true ? 'true' : 'false'}">
        <div class="feature-delivery-head"><strong>交付状态</strong>${deliveryBadgeHtml(delivery, 'feature-delivery-badge')}</div>
        <p class="feature-delivery-reason">${esc(delivery.reason ?? '')}</p>
        ${delivery.needsReview === true ? `<p class="feature-delivery-review">${esc(delivery.reviewReason ?? '需复核')}</p>` : ''}
        ${delivery.summary ? `<p>交付说明：${esc(delivery.summary)}</p>` : ''}
        ${deliveryGaps.length ? `<p>其它缺口：${deliveryGaps.map((gap) => esc(gap?.label ?? gap?.category ?? '')).join('、')}</p>` : ''}
        <p class="progress-meta">依据：${esc(delivery.basisText ?? '无保存依据')}${delivery.savedAt ? ` · 保存于 ${esc(delivery.savedAt)}` : ''}${asArray(delivery.basisRefs).length ? ` · ${asArray(delivery.basisRefs).map((ref) => `${esc(ref?.id)}（${esc(ref?.collection)}）`).join('、')}` : ''}</p>
        <p class="progress-meta">交付状态是保存记录的读数：不是人工验收，不是意图确认，也不是发布授权。</p>
      </div>`
    : '';
  const stateBadge = latest ? `有续接记录 · ${Number(detail.checkpoints?.count ?? 0)} 条` : '尚无续接记录';
  const summaryLine = latest
    ? `<dl class="intent-fields">
        <dt>最近停点</dt><dd>${esc(latest.stopPoint ?? '未记录停点')}</dd>
        <dt>下一步</dt><dd>${nextActionsHtml || '<span class="progress-meta">下一步未记录。</span>'}</dd>
        <dt>记录依据</dt><dd>保存于状态版本 v${esc(latest.basis?.observedStateVersion)} · ${esc(latest.createdAt)} · ${esc(sourceLabels[latest.source] ?? latest.source)}</dd>
        <dt>适用性</dt><dd><strong>${esc(contextText)}</strong>${sourceText ? `；${esc(sourceText)}` : ''}</dd>
      </dl>`
    : `<p class="progress-empty" data-testid="feature-progress-empty"><strong>尚无续接记录</strong>。这不表示没有剩余工作；只是尚未保存过停点与下一步。</p>`;
  return `<section class="feature-progress" data-testid="feature-progress-detail" aria-label="Feature 进度与续接记录">
    <header class="feature-progress-head">
      <p class="eyebrow">Feature 进度 · 非评审</p>
      <h3>${historical ? '所选快照的停点与续接' : '停点与下一步'}</h3>
      <p class="progress-meta">${historical ? '只显示该快照当时保存的续接记录；不显示现在的记录或下一动作。' : '续接记录是保存的工作说明，不是人工评审或执行授权。'}</p>
    </header>
    <div class="feature-progress-state">
      <span class="badge">${esc(stateBadge)}</span>
      <span class="badge">${esc(contextText)}</span>
      ${sourceText ? `<span class="badge">${esc(sourceText)}</span>` : ''}
      <span class="badge">${esc(planningText)}</span>
    </div>
    ${latest && !roadmap ? '<p class="progress-meta">Feature 有记录但规划尚未记录；规划项不会自动创建。</p>' : ''}
    ${deliveryHtml}
    ${validationHtml}
    ${summaryLine}
    ${latest ? '<p class="progress-boundary">下一步是记录中的建议，不是执行指令；按钮、卡片与计划页面都不会据此写入、运行测试或重启服务。</p>' : ''}
    ${latest ? `<h4>已做工作与依据</h4>${workDoneHtml}` : ''}
    ${latest ? `<h4>剩余事项与责任</h4>${remainingHtml}` : ''}
    ${latest ? `<h4>验证与实现边界</h4><p class="progress-meta">续接记录不把测试定义变成执行结果，也不把规划关闭变成交付。实现、验证与人工体验仍以原节点、证据和检查为准。</p>` : ''}
    ${historyHtml}
  </section>`;
}

// view is the pure JSON projection produced by deriveRoadmap(state). It keeps
// this function free of module-scope closures so it can be embedded in the page.
export function renderRoadmapIndex(view, options = {}) {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const asArray = (value) => (Array.isArray(value) ? value : []);
  // Self-contained badge renderer: this function is stringified into the page.
  // Same meaning as the detail badge and the card delivery shape; needsReview
  // always wins so a stale positive stage cannot quietly read as settled.
  const deliveryBadgeHtml = (entry, testId) => {
    if (!entry || typeof entry !== 'object') return '';
    const needsReview = entry.needsReview === true;
    const label = needsReview ? `需复核 · ${entry.label ?? '状态待补充'}` : (entry.label ?? '状态待补充');
    const title = [entry.basisText, entry.reason, entry.reviewReason].filter(Boolean).join(' · ');
    return `<span class="delivery-badge" data-testid="${esc(testId)}" data-delivery="${esc(entry.status ?? 'unknown')}" data-tone="${esc(entry.tone ?? 'muted')}" data-needs-review="${needsReview ? 'true' : 'false'}" title="${esc(title)}">${esc(label)}</span>`;
  };
  const horizons = [
    ['now', 'Now · 现在'],
    ['next', 'Next · 接下来'],
    ['later', 'Later · 以后'],
    ['unplanned', '未排期'],
  ];
  const statusLabels = { idea: '想法', ready: '可开始', in_progress: '进行中', paused: '暂停', closed: '已关闭' };
  const items = asArray(view?.items);
  const filter = options.filter || 'all';
  const mode = options.mode || 'current';
  if (mode === 'loading') {
    return '<p class="roadmap-empty" role="status">正在读取所选快照的规划记录；不显示当前或其它版本的规划。</p>';
  }
  if (mode === 'unavailable') {
    return '<p class="roadmap-empty" role="status">该历史版本缺失或无法核验，未显示任何规划。请重新选点或回到现在。</p>';
  }
  if (!items.length) {
    if (options.historical) {
      return '<p class="roadmap-empty" data-testid="roadmap-empty-history"><strong>该快照当时没有规划记录</strong>（没有 roadmapItems 字段或记录为空）。这里不显示现在的规划。</p>';
    }
    return '<p class="roadmap-empty" data-testid="roadmap-empty"><strong>当前状态还没有功能规划记录。</strong>首版规划只读；请在离线规划命令 <code>scripts/plan-roadmap.mjs</code> 中生成预览并显式 <code>--apply</code> 保存。Now 不是执行授权。</p>';
  }
  const visible = filter === 'all' ? items : items.filter((item) => item.horizon === filter);
  if (!visible.length) {
    const label = horizons.find(([value]) => value === filter)?.[1] || filter;
    return `<p class="roadmap-empty" role="status">“${esc(label)}”下没有规划项。可切换筛选或查看全部。</p>`;
  }
  return `<div class="roadmap-groups" data-testid="roadmap-groups">${horizons.map(([horizon, label]) => {
    const group = visible.filter((item) => item.horizon === horizon);
    if (!group.length) return '';
    return `<section class="roadmap-group" data-horizon="${horizon}"><h3>${esc(label)} <span class="count">${group.length} 项</span></h3><ul class="roadmap-list">${group.map((item) => {
      const capability = item.nodeLabel || item.nodeId;
      const status = statusLabels[item.status] ?? item.status;
      const selected = options.selectedId === item.id ? 'true' : 'false';
      const blockers = asArray(item.blockers).length ? ` · 阻塞 ${asArray(item.blockers).length}` : '';
      const closed = item.status === 'closed' && item.closedReason ? ` · 关闭原因：${item.closedReason}` : '';
      const progress = options.progress && typeof options.progress === 'object' ? options.progress[item.nodeId] : null;
      const deliveryTitle = progress?.delivery
        ? `交付：${progress.delivery.needsReview ? '需复核 · ' : ''}${progress.delivery.label ?? '状态待补充'}（${progress.delivery.basisText ?? '无保存依据'}）`
        : '';
      const progressHtml = progress
        ? `<span class="roadmap-item-progress" data-testid="roadmap-item-progress" data-context="${esc(progress.contextStatus || '')}" title="${esc([progress.stopText, progress.nextText, progress.contextText, deliveryTitle].filter(Boolean).join(' · '))}">
            <span class="roadmap-progress-stop">${esc(progress.stopText)}</span>
            <span class="roadmap-progress-next">${esc(progress.nextText)}</span>
            ${progress.delivery ? `<span class="roadmap-progress-delivery">${deliveryBadgeHtml(progress.delivery, 'roadmap-item-delivery')}</span>` : ''}
            ${progress.contextStatus === 'changed' ? '<span class="roadmap-item-stale">续接依据有变化，需复核</span>' : ''}
            ${progress.contextStatus === 'unverified_no_digest' ? '<span class="roadmap-item-stale">保存态结构未变；内容指纹未重算</span>' : ''}
          </span>`
        : '';
      return `<li><button type="button" class="roadmap-item" data-roadmap-item="${esc(item.id)}" data-horizon="${esc(item.horizon)}" aria-pressed="${selected}" data-testid="roadmap-item">
        <span class="roadmap-item-top"><span class="roadmap-capability">${esc(capability)}</span><span class="badge" data-status="${esc(item.status)}">${esc(status)}</span></span>
        <span class="roadmap-objective">${esc(item.objective)}</span>
        ${progressHtml}
        <span class="roadmap-meta"><span>${esc(label)}</span><span>工作状态：${esc(status)}</span><span>依赖 ${asArray(item.dependsOn).length}</span><span>阻塞 ${asArray(item.blockers).length}</span>${closed ? `<span>${esc(closed)}</span>` : ''}${blockers ? `<span>${esc(blockers.replace(/^ · /, ''))}</span>` : ''}</span>
      </button></li>`;
    }).join('')}</ul></section>`;
  }).join('')}</div>`;
}

// Returns the full read-only planning detail. `historical` keeps claim rows as
// plain text and avoids review URLs, so a chosen snapshot cannot emit links
// that act on the current state.
export function renderRoadmapDetail(state, view, itemId, options = {}) {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
  const asArray = (value) => (Array.isArray(value) ? value : []);
  const horizonLabels = { now: 'Now · 现在', next: 'Next · 接下来', later: 'Later · 以后', unplanned: '未排期' };
  const statusLabels = { idea: '想法', ready: '可开始', in_progress: '进行中', paused: '暂停', closed: '已关闭' };
  const claimStatusLabels = { candidate: '候选', confirmed: '已确认', superseded: '已被替代', retired: '已停止', dismissed: '已撤回' };
  const kindLabels = { implementation: '实现证据', test_definition: '测试定义', test_execution: '测试执行', runtime_observation: '运行时观察' };
  const items = asArray(view?.items);
  const item = items.find((entry) => entry.id === itemId);
  const historical = options.historical === true;
  if (!item) {
    return `<p class="roadmap-empty" role="status" data-testid="roadmap-detail-missing">${historical ? '所选快照中没有这个规划项；不显示其它版本的规划。' : '该规划项已不在当前状态（可能已被离线规划替换）；请关闭详情后重新查看。'}</p>`;
  }
  const itemById = new Map(items.map((entry) => [entry.id, entry]));
  const nodes = asArray(state?.nodes);
  const claims = asArray(state?.intentClaims);
  const evidence = asArray(state?.evidence);
  const edges = asArray(state?.edges);
  const node = nodes.find((entry) => entry.id === item.nodeId);
  const nodeClaims = claims.filter((claim) => claim.nodeId === item.nodeId);
  const activeClaims = nodeClaims.filter((claim) => claim.status === 'candidate' || claim.status === 'confirmed');
  const historicalClaims = nodeClaims.filter((claim) => claim.status === 'superseded' || claim.status === 'retired' || claim.status === 'dismissed');
  const evidenceById = new Map(evidence.filter((entry) => typeof entry.id === 'string').map((entry) => [entry.id, entry]));
  const nodeEvidence = asArray(node?.evidenceIds).map((id) => evidenceById.get(id)).filter(Boolean);
  const implementationEvidence = nodeEvidence.filter((entry) => entry.kind === 'implementation');
  const verificationEvidence = nodeEvidence.filter((entry) => ['test_definition', 'test_execution', 'runtime_observation'].includes(entry.kind));
  const implementationNodes = edges.filter((edge) => edge.from === item.nodeId && edge.kind === 'implemented_by')
    .map((edge) => nodes.find((entry) => entry.id === edge.to)).filter(Boolean);
  const verificationNodes = edges.filter((edge) => edge.from === item.nodeId && edge.kind === 'verified_by')
    .map((edge) => nodes.find((entry) => entry.id === edge.to)).filter(Boolean);
  for (const linked of [...implementationNodes,...verificationNodes]) {
    for (const id of asArray(linked.evidenceIds)) {
      const entry = evidenceById.get(id);
      if (entry?.kind === 'implementation' && !implementationEvidence.some((e) => e.id === id)) implementationEvidence.push(entry);
      if (['test_definition','test_execution','runtime_observation'].includes(entry?.kind) && !verificationEvidence.some((e) => e.id === id)) verificationEvidence.push(entry);
    }
  }
  for (const edge of edges.filter((entry) => entry.from === item.nodeId && ['implemented_by','verified_by'].includes(entry.kind))) {
    for (const id of asArray(edge.evidenceIds)) {
      const entry = evidenceById.get(id);
      if (entry?.kind === 'implementation' && !implementationEvidence.some((e) => e.id === id)) implementationEvidence.push(entry);
      if (['test_definition','test_execution','runtime_observation'].includes(entry?.kind) && !verificationEvidence.some((e) => e.id === id)) verificationEvidence.push(entry);
    }
  }
  const status = statusLabels[item.status] ?? item.status;
  const horizon = horizonLabels[item.horizon] ?? item.horizon;
  const list = (values, empty) => (asArray(values).length
    ? `<ul class="intent-list">${asArray(values).map((value) => `<li>${esc(value)}</li>`).join('')}</ul>`
    : `<p class="muted">${esc(empty)}</p>`);
  const dependencyRows = asArray(item.dependsOn).map((id) => {
    const dependency = itemById.get(id);
    if (!dependency) return `<li><span class="badge" data-status="candidate">依赖缺失</span> <code>${esc(id)}</code> · 该规划项不在这一快照中</li>`;
    const dependencyLabel = dependency.nodeLabel || dependency.nodeId;
    return `<li><button type="button" class="link-button" data-roadmap-item="${esc(dependency.id)}" data-testid="roadmap-dependency">${esc(dependencyLabel)} · ${esc(horizonLabels[dependency.horizon] ?? dependency.horizon)} · ${esc(statusLabels[dependency.status] ?? dependency.status)}</button></li>`;
  });
  const claimItem = (claim) => {
    const head = `<span class="badge" data-status="${esc(claim.status)}">${esc(claimStatusLabels[claim.status] ?? claim.status)}</span>`;
    const body = `<p class="intent-statement">${esc(claim.statement ?? '')}</p>
      <dl class="intent-fields">
        <dt>声明</dt><dd>${esc(claim.statement ?? '')}</dd>
        <dt>适用范围</dt><dd>${list(claim.scope, '未记录适用范围')}</dd>
        <dt>条件</dt><dd>${list(claim.conditions, '未记录条件')}</dd>
        <dt>例外</dt><dd>${list(claim.exceptions, '未记录例外')}</dd>
      </dl>`;
    return `<article class="roadmap-claim" data-roadmap-claim="${esc(claim.id)}" data-testid="roadmap-current-claim"><header class="intent-item-head">${head}</header>${body}</article>`;
  };
  const evidenceLine = (entry) => `<li><strong>${esc(kindLabels[entry.kind] ?? String(entry.kind ?? '').replaceAll('_', ' '))}：</strong>${esc(entry.claim ?? '未记录说明')}${entry.path ? ` · <span class="mono">${esc(entry.path)}</span>` : ''}${entry.locator ? ` · ${esc(entry.locator)}` : ''}${entry.validation ? ` · ${esc(entry.validation)}` : ''}</li>`;
  const nodeLines = (entries) => entries.map((entry) => `<li>${esc(entry.label ?? entry.id)} <span class="muted">· ${esc(entry.kind ?? '')} · ${esc(entry.status ?? '')}</span></li>`).join('');
  return `<article class="roadmap-detail" data-testid="roadmap-detail" data-roadmap-id="${esc(item.id)}">
    <p class="roadmap-note" data-testid="roadmap-boundary"><strong>规划只读</strong>：${esc(horizon)} 是规划位置，不是开发、评审或验证授权。验收目标是规划目标，不是测试结果。</p>
    ${typeof options.progressHtml === 'string' && options.progressHtml ? `<div class="roadmap-progress" data-testid="roadmap-progress">${options.progressHtml}</div>` : ''}
    <div class="roadmap-status"><span class="badge" data-status="${esc(item.status)}">工作状态：${esc(status)}</span><span class="badge" data-status="${esc(item.status === 'closed' ? 'retired' : 'candidate')}">规划位置：${esc(horizon)}</span>${node ? `<span class="badge">关联功能：${esc(node.label ?? node.id)}</span>` : `<span class="badge" data-status="retired">关联节点缺失</span>`}</div>
    <h3>规划目标</h3>
    <p class="intent-statement">${esc(item.objective)}</p>
    <h4>范围</h4>${list(item.scope, '未记录范围')}
    <h4>排除</h4>${list(item.exclusions, '未记录排除项')}
    <h4>验收目标（规划目标，不是测试结果）</h4>${list(item.acceptanceCriteria, '未记录验收目标')}
    <h4>依赖</h4>${dependencyRows.length ? `<ul class="intent-list">${dependencyRows.join('')}</ul>` : '<p class="muted">未记录依赖。</p>'}
    <h4>阻塞</h4>${list(item.blockers, '未记录阻塞。')}
    <h4>关闭原因</h4><p class="muted" data-testid="roadmap-closed-reason">${item.status === 'closed' ? (item.closedReason ? esc(item.closedReason) : '已关闭但未记录原因（状态异常，需人工核对）。') : '未关闭，无关闭原因。'}</p>
    <h3>关联功能</h3>
    <p class="roadmap-association">${node ? `<strong>${esc(node.label ?? node.id)}</strong> · <code>${esc(item.nodeId)}</code> · 节点状态：${esc(node.status ?? '未记录')}` : `节点 <code>${esc(item.nodeId)}</code> 不在该状态中。`}</p>
    <button type="button" class="btn btn-secondary" data-roadmap-locate="${esc(item.nodeId)}" data-testid="roadmap-locate">在画布定位这个功能</button>
    <h4>当前意图</h4>
    ${activeClaims.length ? activeClaims.map(claimItem).join('') : '<p class="muted">当前没有候选或已确认意图记录；规划不复制、不代替意图。</p>'}
    ${historicalClaims.length ? `<details class="claim-history"><summary>历史意图 (${historicalClaims.length})</summary>${historicalClaims.map(claimItem).join('')}</details>` : ''}
    <h4>实现关联</h4>
    ${implementationNodes.length ? `<ul class="intent-list">${nodeLines(implementationNodes)}</ul>` : '<p class="muted">未记录 implemented_by 关联节点。</p>'}
    ${implementationEvidence.length ? `<ul class="intent-list">${implementationEvidence.map(evidenceLine).join('')}</ul>` : '<p class="muted">未记录实现证据。</p>'}
    <h4>验证情况（定义、执行、运行时分开）</h4>
    <p class="muted">有关联或测试定义不等于测试通过；这里只展示保存的材料及原验证状态。</p>
    ${verificationNodes.length ? `<ul class="intent-list">${nodeLines(verificationNodes)}</ul>` : '<p class="muted">未记录 verified_by 关联节点。</p>'}
    ${verificationEvidence.length ? `<ul class="intent-list">${verificationEvidence.map(evidenceLine).join('')}</ul>` : '<p class="muted">未记录验证材料。有关联或定义不等于测试通过。</p>'}
    <p class="muted">此详情不会创建评审、决定、实现证据或测试结果，也不授予开发权限。</p>
  </article>`;
}

// Static 0.2 maps only: same right-hand inspector, no review affordances, paths,
// network or writes. Locate uses the existing graph navigation (including its
// normal selected-node URL). Helpers are passed explicitly for embedding.
export function initializeStaticRoadmap(state, helpers) {
  const view = helpers.deriveRoadmap(state);
  const inspector = document.querySelector('#graph-inspector-content');
  if (!inspector) return;
  const entry = document.querySelector('#graph-roadmap');
  entry?.setAttribute('aria-controls','graph-inspector-content');
  const progressApi = helpers.featureProgressApi;
  const progressView = progressApi && typeof helpers.featureProgressSummaryMap === 'function'
    ? progressApi.deriveFeatureProgress(state, { includeRetired: true, fingerprints: helpers.featureFingerprints })
    : null;
  const progress = progressView ? helpers.featureProgressSummaryMap(progressView) : null;
  const progressHtmlForNode = (nodeId) => {
    if (!progressApi || typeof helpers.renderFeatureProgressDetail !== 'function' || typeof nodeId !== 'string') return '';
    try {
      const detail = progressApi.selectFeatureContext(state, nodeId, { fingerprints: helpers.featureFingerprints });
      return detail && detail.status === 'ok' ? helpers.renderFeatureProgressDetail(detail, { historical: false }) : '';
    } catch { return ''; }
  };
  const progressHtmlFor = (item) => progressHtmlForNode(item.nodeId);
  let filter = 'all';
  const showIndex = () => {
    inspector.innerHTML = '<h3 tabindex="-1" id="static-roadmap-title">功能规划 · 只读</h3>' + helpers.renderRoadmapFilters() + helpers.renderRoadmapIndex(view,{filter, progress});
    for (const button of inspector.querySelectorAll('[data-roadmap-filter]')) button.setAttribute('aria-pressed',String(button.dataset.roadmapFilter === filter));
  };
  document.addEventListener('click',(event) => {
    if (event.target.closest('#graph-roadmap')) { showIndex(); document.querySelector('#static-roadmap-title')?.focus({preventScroll:true}); return; }
    const control = event.target.closest('[data-roadmap-filter]');
    if (control) {
      filter = control.dataset.roadmapFilter;
      const list = document.querySelector('#static-roadmap-list');
      if (list) list.innerHTML = helpers.renderRoadmapIndex(view,{filter, progress});
      showIndex(); return;
    }
    const item = event.target.closest('[data-roadmap-item]');
    if (item) {
      const entryItem = (view.items || []).find((row) => row.id === item.dataset.roadmapItem);
      inspector.innerHTML = helpers.renderRoadmapDetail(state,view,item.dataset.roadmapItem,{readOnly:true, progressHtml: entryItem ? progressHtmlFor(entryItem) : ''});
      inspector.tabIndex = -1; inspector.focus({preventScroll:true}); return;
    }
    const locate = event.target.closest('[data-roadmap-locate]');
    if (locate) window.__productContinuityGraph?.selectNode(locate.dataset.roadmapLocate,true);
  });
  // Selecting a capability in the graph shows the same full shared delivery
  // detail as a planning item, without requiring any roadmap. select()
  // replaces the inspector children before dispatching continuity:graph-select,
  // so appending here never stacks; the tracked node is also removed before
  // any re-append and on non-capability picks, leaving no residue.
  const capabilityIds = new Set((Array.isArray(state?.nodes) ? state.nodes : [])
    .filter((node) => node && node.kind === 'capability' && typeof node.id === 'string')
    .map((node) => node.id));
  let appendedProgress = null;
  const appendSelectionProgress = (nodeId) => {
    if (appendedProgress) { appendedProgress.remove(); appendedProgress = null; }
    if (!capabilityIds.has(nodeId)) return;
    const html = progressHtmlForNode(nodeId);
    if (!html) return;
    const template = document.createElement('template');
    template.innerHTML = html;
    appendedProgress = template.content.firstElementChild;
    if (appendedProgress) inspector.append(appendedProgress);
  };
  document.querySelector('#graph-view')?.addEventListener('continuity:graph-select', (event) => {
    appendSelectionProgress(event.detail?.nodeId);
  });
  // initializeGraph runs before this helper, so the initial selection (URL
  // hash or first node) already happened; render its detail once here.
  const pressed = document.querySelector('.graph-node-select[aria-pressed="true"]');
  const initialNodeId = pressed?.closest('.graph-node')?.dataset.nodeId;
  if (initialNodeId) appendSelectionProgress(initialNodeId);
}
