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
