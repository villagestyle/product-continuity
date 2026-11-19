export const timelineStyles = `
.timeline{min-width:0;border:1px solid var(--line);border-radius:8px;background:var(--surface);overflow:hidden}
.timeline>summary{display:flex;flex-wrap:wrap;align-items:center;gap:.35rem .8rem;min-height:52px;padding:.65rem 1rem;cursor:pointer;list-style:none}
.timeline>summary::-webkit-details-marker{display:none}.timeline>summary::before{content:'＋';font-weight:600}.timeline[open]>summary::before{content:'−'}
.timeline-summary{font-size:.8rem;color:var(--muted);margin-left:auto}.timeline-content{padding:.5rem .85rem .85rem;min-width:0}.timeline-note{font-size:.8rem;color:var(--muted);margin:.5rem 0}
.timeline-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.6rem;margin:.6rem 0}.timeline-metric{padding:.65rem .75rem;background:var(--paper);border-radius:5px;min-width:0}
.timeline-metric h3{font-size:.8rem;color:var(--muted);margin:0}.timeline-value{font:600 1.35rem/1.5 Consolas,"Cascadia Code",monospace;color:var(--ink)}.timeline-metric p{font-size:.75rem;color:var(--muted);margin:.1rem 0}
.timeline-history{margin:.75rem 0}.timeline-history h3{font-size:.9rem;margin:.6rem 0}.timeline-chart{display:block;width:100%;height:180px;color:var(--muted)}.timeline-chart text{font-size:12px;fill:currentColor}.timeline-chart .timeline-grid{stroke:var(--line);stroke-width:1}
.timeline-legend{display:flex;flex-wrap:wrap;gap:.4rem 1rem;font-size:.8rem}.timeline-key{display:inline-block;width:20px;margin-right:.35rem;border-top:2px solid var(--green);vertical-align:middle}.timeline-key[data-series=implemented]{border-color:var(--blue);border-top-style:dashed}.timeline-key[data-series=recorded]{border-color:var(--amber);border-top-style:dotted}
.timeline-table-wrap{overflow-x:auto;max-width:100%}.timeline table{width:100%;border-collapse:collapse;font-size:.78rem;white-space:nowrap}.timeline caption{text-align:left;color:var(--muted);padding:.4rem 0}.timeline th,.timeline td{text-align:left;padding:.4rem .55rem;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
.timeline-controls{display:flex;flex-wrap:wrap;gap:.5rem .65rem;align-items:end;margin:.8rem 0}.timeline-controls label{display:flex;flex-direction:column;gap:.2rem;font-size:.78rem;min-width:0}.timeline-controls input,.timeline-controls select{max-width:220px;width:100%;min-height:44px}.timeline-controls .timeline-search input{max-width:none}.timeline-controls button{font-size:.8rem}
.timeline-tabs{display:flex;gap:.3rem;flex:none}.timeline-tabs button{min-height:44px;padding:.35rem .75rem;border-color:transparent;background:transparent;font-size:.84rem}.timeline-tabs button[aria-selected=true]{background:var(--blue-soft);color:var(--blue);border-color:var(--line);font-weight:600}.timeline-tabs button:focus-visible{outline-offset:-3px}
.timeline-toolbar{display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;margin:0 0 .35rem}.timeline-toolbar .timeline-controls{margin:0;flex:1;justify-content:flex-end;gap:.35rem}.timeline-toolbar .timeline-search{flex:1 1 110px}.timeline-toolbar .timeline-search input{min-width:100px}
.timeline-filters{margin:.3rem 0}.timeline-filters .timeline-controls{margin:.2rem 0 .5rem}.timeline-filter-status{margin:.25rem 0;font-size:.75rem;min-height:1.5em;color:var(--muted)}.timeline [role=tabpanel]{min-width:0}
.timeline-event-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(230px,.85fr);gap:.8rem;align-items:start}.timeline-event-list{margin:.4rem 0;padding:0;list-style:none}.timeline-event-list li{border-left:2px solid var(--line);margin-left:.3rem;padding:0 0 .45rem .8rem}
.timeline-event-list button{display:block;width:100%;text-align:left;padding:.45rem .65rem;min-height:58px;background:var(--paper);border-color:transparent}.timeline-event-list button[aria-pressed=true]{border-color:var(--blue);background:var(--blue-soft)}.timeline-event-title{display:block;font-size:.84rem;overflow-wrap:anywhere}.timeline-event-meta{display:flex;flex-wrap:wrap;gap:.3rem .6rem;font:.72rem/1.5 Consolas,"Microsoft YaHei",monospace;color:var(--muted)}
.timeline-detail{min-width:0;padding:.6rem .75rem;background:var(--paper);border-radius:5px}.timeline-detail h4{font-size:.86rem;margin:.2rem 0}.timeline-detail p{font-size:.8rem;overflow-wrap:anywhere}.timeline-detail pre{font:.72rem/1.5 Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:.5rem 0}.timeline-detail .action-row{gap:.4rem}.timeline-detail button{font-size:.78rem}
.timeline-pagination{display:flex;gap:.5rem;align-items:center;font-size:.8rem;margin-top:.4rem}.timeline-warning{color:var(--amber);background:var(--amber-soft);padding:.4rem .6rem;font-size:.78rem;border-radius:4px}.graph-heading-actions{flex-wrap:wrap;justify-content:flex-end}
/* One bounded dock scrollbar; the canvas controls stay in the remaining canvas. */
.graph-stage{position:relative;display:flex;flex-direction:column;height:var(--graph-stage-h,clamp(600px,calc(100vh - 4.5rem),1360px));height:var(--graph-stage-h,clamp(600px,calc(100dvh - 4.5rem),1360px));min-height:320px;min-width:0;overflow:hidden}.graph-stage>.graph-viewport{flex:1;min-height:160px;height:auto}
.graph-stage>.timeline{flex:0 1 auto;max-height:36%;min-height:52px;overflow:auto;overscroll-behavior:contain;scroll-padding-top:60px;border:0;border-top:1px solid var(--line);border-radius:0}
.graph-stage>.timeline>summary{position:sticky;top:0;z-index:2;background:var(--surface);border-bottom:1px solid transparent}.graph-stage>.timeline[open]>summary{border-bottom-color:var(--line)}
.continuity-fullscreen-host .review-main{display:flex;flex-direction:column}.continuity-fullscreen-host #graph-view{flex:1;min-height:280px;height:auto}.continuity-fullscreen-host .graph-board--timeline .graph-stage{flex:1;min-height:240px;height:auto}
.continuity-fullscreen-host .graph-stage>.timeline{min-height:44px}.continuity-fullscreen-host .timeline>summary{min-height:44px;padding:.4rem .65rem}
.graph-time{flex:none;padding:.45rem .85rem;background:var(--surface);border-top:1px solid var(--line);min-width:0}
.graph-time-head,.graph-time-controls{display:flex;align-items:center;gap:.4rem;min-width:0}.graph-time-head{justify-content:space-between;font-size:.78rem}.graph-time-head label{font-weight:600}.graph-time-head output{color:var(--blue);font-variant-numeric:tabular-nums;text-align:right}
.graph-time-controls input[type=range]{flex:1;min-width:60px;min-height:44px;padding:0;border:0;accent-color:var(--blue)}.graph-time-controls button{font-size:.76rem;min-height:44px;padding:.3rem .5rem;white-space:nowrap}
.graph-time-note{font-size:.72rem;color:var(--muted);margin:0;line-height:1.5}.graph-time[data-mode=history]{background:var(--blue-soft)}
.history-panel{padding:1rem;overflow-wrap:anywhere}.history-panel h3{font-size:1rem;margin:.6rem 0}.history-panel h4{margin:.7rem 0 .3rem}.history-panel pre{white-space:pre-wrap;font-size:.75rem;overflow-wrap:anywhere}.history-panel .intent-list{padding-left:1.2rem}
.history-panel-head{display:flex;align-items:center;justify-content:space-between;gap:.5rem}.history-panel .badge{color:var(--blue);background:var(--blue-soft)}
.version-diff-bar{display:flex;align-items:center;gap:.35rem;flex-wrap:wrap;border-top:1px solid var(--line);padding:.25rem .65rem;font-size:.74rem;background:var(--surface)}.version-diff-bar label{display:flex;align-items:center;gap:.25rem;min-height:44px;white-space:nowrap}.version-diff-bar input{min-height:0;width:16px;height:16px;accent-color:var(--green)}.version-diff-bar button{font-size:.74rem;padding:.25rem .4rem;min-height:44px}#version-diff-summary{flex:1;text-align:left;min-width:160px;color:var(--blue)}
.version-diff-panel{padding:.8rem;overflow-wrap:anywhere}.version-diff-panel h2{font-size:1rem}.version-diff-panel h3{font-size:.9rem;margin:.8rem 0}.version-diff-controls{display:flex;gap:.5rem;flex-wrap:wrap;margin:.65rem 0}.version-diff-controls label{display:grid;gap:.2rem;font-size:.78rem;min-width:0;flex:1}.version-diff-controls input,.version-diff-controls select{width:100%}.version-diff-list{max-height:250px;overflow:auto;overscroll-behavior:contain}.version-diff-list p{font-size:.75rem}.version-diff-item{display:block;width:100%;text-align:left;font-size:.78rem;margin:.25rem 0;overflow-wrap:anywhere}.version-diff-item[aria-pressed=true]{background:var(--blue-soft);border-color:var(--blue)}.version-diff-item[data-kind=added]{border-left:3px solid var(--green)}.version-diff-item[data-kind=removed]{border-left:3px dashed var(--red)}.version-diff-field{margin:.65rem 0}.version-diff-field h4{font-size:.8rem}.version-diff-values{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:.4rem}.version-diff-values>div{min-width:0;background:var(--paper);padding:.45rem;border-radius:4px;font-size:.74rem}.version-diff-after{background:var(--green-soft)!important}.version-diff-values pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:.2rem 0;font-size:.74rem}@media(max-width:760px){.version-diff-values{grid-template-columns:minmax(0,1fr)}}
.version-diff-controls input,.version-diff-controls select,.version-diff-panel button{min-height:44px}.version-diff-bar{gap:.35rem .5rem}.graph-node[data-diff]{content-visibility:visible}.graph-diff-key{white-space:pre-line}.graph-diff-ghost[data-diff=added] .graph-node-select{border-color:var(--green);background:var(--green-soft)}
@media(max-width:1100px){.graph-stage{height:var(--graph-stage-h,clamp(560px,calc(100vh - 3.5rem),1160px));height:var(--graph-stage-h,clamp(560px,calc(100dvh - 3.5rem),1160px))}}
@media(max-width:760px){.graph-stage{height:var(--graph-stage-h,clamp(480px,calc(100vh - 3rem),960px));height:var(--graph-stage-h,clamp(480px,calc(100dvh - 3rem),960px))}.timeline-event-layout{grid-template-columns:minmax(0,1fr)}.timeline-metrics{grid-template-columns:minmax(0,1fr)}.timeline-summary{margin-left:0}.timeline-content{padding:.5rem .65rem .65rem}}
`;

export function renderGraphTimeShell() {
  return `<section id="graph-time" class="graph-time" aria-label="图谱时间回溯" data-mode="current">
    <div class="graph-time-head"><label for="graph-time-range">图谱时间轴</label><output id="graph-time-label" for="graph-time-range">现在</output></div>
    <div class="graph-time-controls"><button type="button" id="graph-time-previous" aria-label="上一个可核验版本" disabled>上一版</button><input id="graph-time-range" type="range" min="0" max="0" value="0" step="1" aria-describedby="graph-time-note" disabled><button type="button" id="graph-time-next" aria-label="下一个可核验版本" disabled>下一版</button><button type="button" id="graph-time-now" disabled>回到现在</button></div>
    <p id="graph-time-note" class="graph-time-note" role="status" aria-live="polite">正在读取可核验版本；拖动只切换查看，不恢复主状态。</p>
    <div id="version-diff-bar" class="version-diff-bar" aria-label="版本差异" hidden></div>
  </section>`;
}

// Discrete complete snapshots, in state-version order. Unknown times and clock
// regression must not turn the axis into a fictitious continuous date scale.
export function initializeGraphTime(bootstrap, hooks = {}) {
  const host = document.querySelector('#graph-time');
  if (!host) return;
  const query = (name) => document.querySelector('#graph-time-' + name);
  const range = query('range');
  let samples = [], selected = null, sequence = 0, controller = null, loading = false, warning = '';
  const key = (sample) => sample.source === 'current' ? 'now' : sample.stateVersion + ':' + sample.digest;
  const timeText = (sample) => ['review','maintenance','planning','checkpoint','conversation'].includes(sample.timeBasis) && sample.at ? sample.at.replace('T',' ').replace('Z',' UTC') + (sample.timeBasis === 'maintenance' ? '（维护记录，非评审）' : sample.timeBasis === 'planning' ? '（规划记录，非评审）' : sample.timeBasis === 'checkpoint' ? '（续接记录，非评审）' : sample.timeBasis === 'conversation' ? '（会话采集，非人工评审）' : '') : sample.timeBasis === 'read' ? '本次读取，非保存时间' : '保存时间未知';
  function render(message = '') {
    const index = Math.max(0,samples.findIndex((item) => key(item) === selected));
    const sample = samples[index];
    range.max = String(Math.max(0,samples.length - 1)); range.value = String(index); range.disabled = samples.length < 2;
    const isNow = !sample || key(sample) === 'now';
    host.dataset.mode = isNow ? 'current' : 'history'; host.dataset.version = sample ? String(sample.stateVersion) : '';
    host.setAttribute('aria-busy',String(loading));
    query('label').textContent = sample ? `${isNow ? '现在' : '历史 · 只读'} · v${sample.stateVersion} · ${timeText(sample)}${loading ? ' · 读取中' : ''}` : '现在';
    range.setAttribute('aria-valuetext',query('label').textContent);
    query('previous').disabled = index === 0 || samples.length < 2;
    query('next').disabled = index >= samples.length - 1;
    query('now').disabled = isNow;
    query('note').textContent = message || (samples.length < 2 ? '目前只有当前快照，暂无可回溯的历史树；不从当前状态倒推历史。' : `按版本顺序逐点回溯，刻度不代表等长时间；拖动、点按或方向键切换。${sample?.gapBefore ? '此版本前有缺口，中间的树未保存；' : ''}${warning}历史只读，不回滚主状态。`);
  }
  async function choose(index) {
    const sample = samples[index];
    if (!sample) return;
    const next = key(sample);
    if (next === selected) return;
    if (hooks.canNavigate?.() === false) { render('当前请求尚未结束，请稍后再回溯。'); return; }
    const token = ++sequence;
    controller?.abort(); controller = null;
    selected = next; loading = false;
    if (next === 'now') { hooks.showCurrent?.(); render(); hooks.compare?.(sample,samples[index-1] || samples[index+1],null); return; }
    // Hide the previous tree while loading, so its nodes can never be mistaken
    // for the requested version. Invalidate async work even when returning now.
    loading = true; controller = new AbortController();
    hooks.showLoading?.(sample); render();
    try {
      const result = await hooks.loadSnapshot(sample,controller.signal);
      if (token !== sequence) return;
      if (result?.sample?.stateVersion !== sample.stateVersion || result?.fileDigest !== sample.digest || result?.state?.stateVersion !== sample.stateVersion || result?.state?.project?.id !== bootstrap.state?.project?.id || result?.stateIdentity !== bootstrap.stateIdentity || result?.writable !== false) throw new Error('历史快照身份不匹配');
      loading = false; hooks.showSnapshot?.(result); render();
      hooks.compare?.(sample,samples[index-1] || samples[index+1],result);
    } catch (error) {
      if (token !== sequence) return;
      loading = false; hooks.showUnavailable?.(sample);
      render('该版本缺失或无法核验，画布不显示其它版本冒充；请刷新版本或回到现在。');
    }
  }
  range.addEventListener('input',() => { void choose(Number(range.value)); });
  query('previous').addEventListener('click',() => { void choose(Number(range.value) - 1); });
  query('next').addEventListener('click',() => { void choose(Number(range.value) + 1); });
  query('now').addEventListener('click',() => { void choose(samples.findIndex((sample) => key(sample) === 'now')); });
  function update(state, history) {
    const wasHistorical = selected && selected !== 'now';
    const previousSample = samples.find((sample) => key(sample) === selected);
    samples = (history?.samples || []).filter((sample) => Number.isSafeInteger(sample.stateVersion) && /^sha256:[0-9a-f]{64}$/.test(sample.digest || '')).slice().sort((a,b) => a.stateVersion - b.stateVersion);
    if (!samples.some((sample) => sample.source === 'current')) samples.push({stateVersion:state.stateVersion,digest:'',source:'current',timeBasis:'unknown'});
    warning = (history?.warnings || []).some((code) => ['entry_limit','backup_limit','byte_limit','history_unavailable','invalid_backup','unanchored_backup','unexplained_roadmap_change','unexplained_checkpoint_change'].includes(code)) ? '部分历史缺失、已排除或超出读取上限；' : '';
    if ((history?.warnings || []).includes('clock_regression')) warning += '时间倒退，以版本号为序；';
    if (wasHistorical) {
      // A refresh revalidates the exact displayed snapshot, even if its entry
      // remains advertised. It may have been removed/tampered with since read.
      const wanted = selected;
      selected = null;
      const index = samples.findIndex((sample) => key(sample) === wanted);
      if (index >= 0) { void choose(index); return; }
      if (previousSample) {
        samples.push({...previousSample,source:'missing'});
        samples.sort((a,b) => a.stateVersion - b.stateVersion);
      }
      // Keep the requested point visibly historical even when it disappeared.
      sequence++; controller?.abort(); loading = false; selected = wanted;
      hooks.showUnavailable?.(previousSample || null);
      render('所选历史版本已不在可核验列表中；请重新选点或回到现在。');
      return;
    }
    selected = 'now'; render();
    const index = samples.findIndex((sample) => key(sample) === 'now');
    hooks.compare?.(samples[index],samples[index-1] || samples[index+1],null);
  }
  update(bootstrap.state, bootstrap.timelineHistory);
  return {update, showCurrent() { const index=samples.findIndex((sample) => key(sample)==='now'); return choose(index); }};
}

// Self-contained: both server rendering and the nonce-bearing browser script
// use exactly the same escaping and progress semantics.
export function renderTimelineOverview(state, history, helpers) {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'})[character]);
  const metrics = helpers.deriveProgress(state);
  const samples = Array.isArray(history?.samples) ? history.samples : [];
  const ratio = (value, total) => total ? `${value}/${total}` : '—（暂无分母）';
  const cards = [
    ['现行意图确认', ratio(metrics.confirmedClaims, metrics.activeClaims), `候选 ${metrics.candidateClaims} · 已停止 ${metrics.retiredClaims} · 历史替代 ${metrics.supersededClaims}`],
    ['任务实现关联', ratio(metrics.implementedTasks, metrics.tasks), '沿 contains / enables 查找 implemented_by；有关联不等于已完成'],
    ['任务有通过／观察记录', ratio(metrics.passingTasks, metrics.tasks), `关联验证 ${metrics.validationLinkedTasks}/${metrics.tasks} · 含失败记录的任务 ${metrics.failedTasks}`],
  ].map(([label, value, note]) => `<div class="timeline-metric"><h3>${esc(label)}</h3><div class="timeline-value">${esc(value)}</div><p>${esc(note)}</p></div>`).join('');
  const warnings = {
    unexplained_roadmap_change:'快照之间存在规划记录无法解释的变化，相关历史端点已排除；当前状态未被回滚。',
    history_unavailable:'版本备份暂不可读，仍显示当前快照。', entry_limit:'目录读取达到 4096 项上限，历史可能不完整。', backup_limit:'仅检查最近 64 个备份，早期历史可能未显示。', byte_limit:'备份读取达到 32 MiB 上限，未读取部分不会补算。', unanchored_backup:'存在不能由当前评审／维护摘要锚定的备份，已排除。', invalid_backup:'存在校验不通过或不安全的备份，已排除。', version_gap:'版本有缺口，曲线不跨缺口连线。', unknown_snapshot_time:'部分历史版本没有可信保存时间，仅在表格列出。', clock_regression:'记录时间发生倒退；版本顺序仍以 stateVersion 为准。',
  };
  const warningHtml = (history?.warnings || []).map((code) => `<p class="timeline-warning">${esc(warnings[code] || '部分历史不可核验。')}</p>`).join('');
  const timed = samples.filter((sample) => sample.at && ['review','maintenance','planning','checkpoint','conversation'].includes(sample.timeBasis) && Number.isFinite(Date.parse(sample.at)));
  const clockRegression = timed.some((sample, index) => index > 0 && Date.parse(sample.at) < Date.parse(timed[index - 1].at));
  let chart = '';
  if (new Set(timed.map((sample) => Date.parse(sample.at))).size >= 4 && !clockRegression && !(history?.warnings || []).includes('clock_regression')) {
    const min = Math.min(...timed.map((sample) => Date.parse(sample.at))), max = Math.max(...timed.map((sample) => Date.parse(sample.at)));
    const x = (sample) => 42 + (Date.parse(sample.at) - min) / (max - min || 1) * 610;
    const series = [
      {value:'confirmedClaims', total:'activeClaims', color:'var(--green)', dash:'', label:'意图确认'},
      {value:'implementedTasks', total:'tasks', color:'var(--blue)', dash:'6 4', label:'实现关联'},
      {value:'passingTasks', total:'tasks', color:'var(--amber)', dash:'2 4', label:'有通过／观察记录'},
    ];
    const paths = series.map((item) => {
      let path = '', previous = null;
      const points = [];
      for (const sample of samples) {
        if (!sample.at || !['review','maintenance','planning','checkpoint','conversation'].includes(sample.timeBasis) || !sample.metrics[item.total]) { previous = null; continue; }
        const percent = sample.metrics[item.value] / sample.metrics[item.total] * 100;
        const px = x(sample), py = 134 - percent * 1.05;
        path += `${previous && !sample.gapBefore && sample.stateVersion === previous.stateVersion + 1 ? 'L' : 'M'}${px.toFixed(2)},${py.toFixed(2)} `;
        points.push(`<circle cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" r="3" fill="${item.color}"><title>${esc(item.label)} · v${sample.stateVersion} · ${esc(sample.at)} · ${sample.metrics[item.value]}/${sample.metrics[item.total]}</title></circle>`);
        previous = sample;
      }
      return `<path d="${path}" fill="none" stroke="${item.color}" stroke-width="2" stroke-dasharray="${item.dash}"/>${points.join('')}`;
    }).join('');
    chart = `<svg class="timeline-chart" viewBox="0 0 700 180" role="img" aria-label="随记录时间推进的三条进度比例；详细数值见下表。缺失版本不连线。"><path class="timeline-grid" d="M42 29H652M42 81H652M42 134H652"/><text x="0" y="33">100%</text><text x="8" y="85">50%</text><text x="16" y="138">0%</text>${paths}<text x="42" y="163">${esc(new Date(min).toISOString().slice(0, 16).replace('T', ' '))} UTC</text><text x="652" y="163" text-anchor="end">${esc(new Date(max).toISOString().slice(0, 16).replace('T', ' '))} UTC</text></svg>`;
   } else chart = `<p class="timeline-note">${samples.length < 2 ? '目前只有当前快照。后续评审或授权维护保存产生可核验的版本备份后，这里会展示变化；不从当前状态倒推历史。' : '可信时间点不足 4 个或时间倒退，暂不画趋势线；请用下表逐版本比较。'}</p>`;
  const rows = samples.map((sample) => {
    const metric = sample.metrics;
    const time = sample.at ? `${sample.at.replace('T',' ').replace('.000Z',' UTC').replace('Z',' UTC')}${sample.timeBasis === 'read' ? '（本次读取，非保存时间）' : sample.timeBasis === 'maintenance' ? '（维护记录，非评审）' : sample.timeBasis === 'planning' ? '（规划记录，非评审）' : sample.timeBasis === 'checkpoint' ? '（续接记录，非评审）' : sample.timeBasis === 'conversation' ? '（会话采集，非人工评审）' : ''}` : '保存时间未知';
    return `<tr><th scope="row">v${esc(sample.stateVersion)}${sample.source === 'current' ? ' · 当前' : ''}${sample.gapBefore ? ' · 前有缺口' : ''}</th><td>${esc(time)}</td><td>${esc(ratio(metric.confirmedClaims,metric.activeClaims))}</td><td>${esc(ratio(metric.implementedTasks,metric.tasks))}</td><td>${esc(ratio(metric.passingTasks,metric.tasks))}</td><td>${metric.failedExecutions}</td></tr>`;
  }).join('');
  return `<div class="timeline-metrics">${cards}</div><p class="timeline-note">验证记录是已关联材料的清单，不承诺适用于当前代码版本；通过与失败可以同时存在。测试定义 ${metrics.testDefinitions} · 通过执行 ${metrics.passedExecutions} · 失败执行 ${metrics.failedExecutions} · 运行观察 ${metrics.runtimeObservations} · 待确认事项 ${metrics.unknownNodes}。分母会随范围变化，不是固定交付百分比。</p><section class="timeline-history" aria-label="整体进度历史"><h3>整体进度 · 可核验版本</h3>${warningHtml}${chart}<div class="timeline-legend"><span><i class="timeline-key"></i>意图确认</span><span><i class="timeline-key" data-series="implemented"></i>实现关联</span><span><i class="timeline-key" data-series="recorded"></i>有通过／观察记录</span></div><div class="timeline-table-wrap"><table><caption>只比较完整快照，不把事件累计数当作完成度。历史版本按版本号排列；未知时间不使用文件修改时间代替。</caption><thead><tr><th scope="col">版本</th><th scope="col">记录时间（UTC）</th><th scope="col">意图确认</th><th scope="col">实现关联</th><th scope="col">有通过／观察记录</th><th scope="col">失败执行记录</th></tr></thead><tbody>${rows || '<tr><td colspan="6">尚未读取版本历史，当前统计仍可查看。</td></tr>'}</tbody></table></div></section>`;
}

export function renderTimelineShell(state, history, helpers) {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'})[character]);
  const metrics = helpers.deriveProgress(state);
  const categories = {baseline:'基线／迁移', claim:'意图版本', review:'评审动作', maintenance:'图谱维护（非评审）', planning:'规划记录（非评审）', checkpoint:'续接记录（非评审）', conversation:'会话采集（非人工评审）', decision:'产品决定', proposal:'修改提案', implementation:'实现材料', validation:'验证材料', check:'变更检查', evidence:'其他来源'};
  return `<details id="product-timeline" class="timeline">
    <summary id="timeline-toggle"><strong>时间线与整体进度</strong><span id="timeline-summary" class="timeline-summary">意图 ${metrics.confirmedClaims}/${metrics.activeClaims} · 实现关联 ${metrics.implementedTasks}/${metrics.tasks} · 有验证记录 ${metrics.passingTasks}/${metrics.tasks}</span></summary>
    <div class="timeline-content">
      <div class="timeline-toolbar"><div class="timeline-tabs" role="tablist" aria-label="时间线内容">
        <button type="button" id="timeline-events-tab" role="tab" aria-controls="timeline-events" aria-selected="true" tabindex="0">记录排查</button>
        <button type="button" id="timeline-progress-tab" role="tab" aria-controls="timeline-progress" aria-selected="false" tabindex="-1">整体进度</button>
      </div><div id="timeline-event-tools" class="timeline-controls"><label class="timeline-search"><span class="visually-hidden">查找记录</span><input id="timeline-search" type="search" placeholder="查找文字或记录 ID" maxlength="200"></label><button type="button" id="timeline-filter-toggle" aria-controls="timeline-filters" aria-expanded="false">筛选</button><button type="button" id="timeline-order" aria-pressed="false">最新在前</button><button type="button" id="timeline-refresh">刷新记录</button></div></div>
      <section id="timeline-events" class="timeline-events" role="tabpanel" aria-labelledby="timeline-events-tab" aria-describedby="timeline-events-note" tabindex="0">
        <div id="timeline-filters" class="timeline-filters" hidden><div class="timeline-controls"><label>开始日期（UTC）<input type="date" id="timeline-start"></label><label>结束日期（UTC）<input type="date" id="timeline-end"></label><label>记录类型<select id="timeline-category"><option value="">全部类型</option>${Object.entries(categories).map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select></label><label>关联节点<select id="timeline-node"><option value="">全部节点</option>${(state.nodes || []).map((node) => `<option value="${esc(node.id)}">${esc(node.label)}</option>`).join('')}</select></label><button type="button" id="timeline-reset">清除筛选</button></div><p class="timeline-note">UTC 日期筛选不纳入无时间记录；筛选不改变整体进度分母。</p></div>
        <p id="timeline-events-note" class="visually-hidden">按记录时间排序，非代码提交时间；无时间记录列在最后。历史只读，右侧评审始终操作当前状态。筛选不改变整体进度分母。</p>
        <p id="timeline-filter-status" class="timeline-filter-status" role="status" aria-live="polite"></p>
        <div class="timeline-event-layout"><div><ol id="timeline-event-list" class="timeline-event-list" aria-label="时间线事件"></ol><div class="timeline-pagination"><button type="button" id="timeline-previous">上一页</button><span id="timeline-page"></span><button type="button" id="timeline-next">下一页</button></div></div><section id="timeline-detail" class="timeline-detail" aria-label="只读历史记录"><p>选择一条事件查看时间来源、原始记录和关联位置。不会提交评审或替换右侧草稿。</p></section></div>
      </section>
      <section id="timeline-progress" role="tabpanel" aria-labelledby="timeline-progress-tab" tabindex="0" hidden><div id="timeline-overview">${helpers.renderTimelineOverview(state, history, helpers)}</div></section>
    </div>
  </details>`;
}

export function initializeTimeline(bootstrap, helpers, hooks = {}) {
  const host = document.querySelector('#product-timeline');
  if (!host) return;
  const entry = document.querySelector('#graph-timeline');
  const docked = Boolean(host.closest('.graph-stage'));
  if (entry) {
    entry.hidden = false;
    entry.addEventListener('click', () => {
      host.open = !host.open;
      entry.setAttribute('aria-expanded', String(host.open));
      if (host.open) {
        const summary = host.querySelector('summary');
        summary.scrollIntoView({block:'nearest'});
        summary.focus({preventScroll:true});
      }
    });
    host.addEventListener('toggle', () => entry.setAttribute('aria-expanded', String(host.open)));
  }
  const query = (id) => host.querySelector('#timeline-' + id);
  const tabs = [...host.querySelectorAll('[role=tab]')];
  function activateTab(tab, focus = false) {
    for (const item of tabs) {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
    }
    query('event-tools').hidden = tab.id !== 'timeline-events-tab';
    host.scrollTop = 0;
    if (focus) tab.focus({preventScroll:true});
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => activateTab(tab));
    tab.addEventListener('keydown', (event) => {
      const index = tabs.indexOf(tab);
      const target = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : null;
      if (!target) return;
      event.preventDefault(); activateTab(target, true);
    });
  }
  query('filter-toggle').addEventListener('click', () => {
    const filters = query('filters');
    filters.hidden = !filters.hidden;
    query('filter-toggle').setAttribute('aria-expanded',String(!filters.hidden));
  });
  let state = bootstrap.state, history = bootstrap.timelineHistory;
  let events = [], selectedId = null, page = 0, oldest = false, refreshing = false;
  const size = 30;
  const categoryLabels = {baseline:'基线／迁移', claim:'意图版本', review:'评审动作', maintenance:'图谱维护（非评审）', planning:'规划记录（非评审）', checkpoint:'续接记录（非评审）', conversation:'会话采集（非人工评审）', decision:'产品决定', proposal:'修改提案', implementation:'实现材料', validation:'验证材料', check:'变更检查', evidence:'其他来源'};
  function element(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  }
  function showDetail(event) {
    const detail = query('detail');
    detail.replaceChildren(element('h4', event.title), element('p', `来源：${event.collection}[id=${event.recordId}].${event.timeField}`), element('p', event.at ? `${event.at} · UTC` : '时间未记录或不可解析；未使用文件修改时间或当前时间代填。'), element('p', event.stateVersion ? `${event.category === 'maintenance' ? '授权维护（非人工评审）' : event.category === 'planning' ? '授权规划（非人工评审）' : event.category === 'checkpoint' ? '授权续接记录（非评审）' : event.category === 'conversation' ? '会话采集（非人工评审）' : '评审'}产生状态版本 v${event.stateVersion}；时钟倒退时以版本号确定保存顺序。` : '此记录没有单独的状态版本号，不能据此推定当时的完整图谱。'));
    if (event.collection === 'intentClaims') detail.append(element('p', `当前保存状态：${event.record.status}；这是该意图版本的创建事件，不是当时已确认的证明。`));
    const links = element('div', undefined, 'action-row');
    for (const ref of event.refs) {
      const button = element('button', ref.type === 'proposal' ? '打开当前提案记录' : '打开关联意图（含历史）');
      button.type = 'button';
      button.addEventListener('click', () => hooks.openTarget?.(ref, button));
      links.append(button);
    }
    for (const id of event.nodeIds) {
      const node = (state.nodes || []).find((node) => node.id === id);
      const button = element('button', `定位节点 · ${node?.label || id}`);
      button.type = 'button'; button.dataset.timelineNodeLink = id;
      button.addEventListener('click', () => hooks.openTarget?.({type:'node', id}, button));
      links.append(button);
    }
    detail.append(links);
    const raw = element('details'); raw.append(element('summary', '查看原始记录（当前保存内容，非历史全图快照）'), element('pre', JSON.stringify(event.record, null, 2)));
    detail.append(raw);
  }
  function renderEvents() {
    const start = query('start').value, end = query('end').value;
    const category = query('category').value, nodeId = query('node').value, text = query('search').value.trim().toLocaleLowerCase();
    const invalid = Boolean(start && end && start > end);
    let filtered = invalid ? [] : events.filter((event) => (!category || event.category === category) && (!nodeId || event.nodeIds.includes(nodeId)) && (!(start || end) || (event.at && (!start || event.at.slice(0,10) >= start) && (!end || event.at.slice(0,10) <= end))) && (!text || `${event.title} ${event.recordId} ${JSON.stringify(event.record)}`.toLocaleLowerCase().includes(text)));
    const dated = filtered.filter((event) => event.at);
    filtered = [...(oldest ? dated : dated.reverse()), ...filtered.filter((event) => !event.at)];
    const pages = Math.max(1, Math.ceil(filtered.length / size)); page = Math.min(page, pages - 1);
    const list = query('event-list'); list.replaceChildren();
    for (const event of filtered.slice(page * size, (page + 1) * size)) {
      const item = element('li'), button = element('button'); button.type = 'button'; button.dataset.timelineEvent = event.id;
      button.setAttribute('aria-pressed', String(event.id === selectedId));
      button.append(element('span', event.title, 'timeline-event-title'), element('span', `${event.at ? event.at.replace('T',' ').replace('Z',' UTC') : '时间未知'} · ${categoryLabels[event.category]}${event.stateVersion ? ` · v${event.stateVersion}` : ''}`, 'timeline-event-meta'));
      button.addEventListener('click', () => {
        selectedId = event.id;
        for (const other of list.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button));
        showDetail(event);
      });
      item.append(button); list.append(item);
    }
    if (!filtered.length) list.append(element('li', '没有符合条件的记录。清除筛选可回到全部历史。'));
    const totalUndated = events.filter((event) => !event.at).length;
    query('filter-status').textContent = invalid ? '开始日期不能晚于结束日期。' : `${filtered.length} / ${events.length} 条记录 · ${oldest ? '最早在前' : '最新在前'} · ${totalUndated} 条无时间${start || end ? '（已排除）' : ''}${helpers.deriveTimeline(state).clockRegression ? ' · 时间倒退，请结合版本号排查' : ''} · 历史只读`;
    query('previous').disabled = page === 0; query('next').disabled = page >= pages - 1;
    query('page').textContent = `${page + 1} / ${pages}`;
    if (selectedId && !filtered.some((event) => event.id === selectedId)) {
      selectedId = null; query('detail').replaceChildren(element('p', '原选择不在筛选结果中；请选择事件。'));
    }
  }
  function update(nextState, nextHistory) {
    state = nextState;
    history = nextHistory || null;
    events = helpers.deriveTimeline(state).events;
    const metrics = helpers.deriveProgress(state);
    query('summary').textContent = `意图 ${metrics.confirmedClaims}/${metrics.activeClaims} · 实现关联 ${metrics.implementedTasks}/${metrics.tasks} · 有验证记录 ${metrics.passingTasks}/${metrics.tasks}`;
    query('overview').innerHTML = helpers.renderTimelineOverview(state, history, helpers);
    const nodeSelect = query('node'), selectedNode = nodeSelect.value;
    nodeSelect.replaceChildren(element('option', '全部节点')); nodeSelect.firstElementChild.value = '';
    for (const node of state.nodes || []) { const option = element('option', node.label); option.value = node.id; nodeSelect.append(option); }
    nodeSelect.value = (state.nodes || []).some((node) => node.id === selectedNode) ? selectedNode : '';
    renderEvents();
    const selected = events.find((event) => event.id === selectedId);
    if (selected) showDetail(selected);
  }
  for (const name of ['start','end','category','node','search']) query(name).addEventListener(name === 'search' ? 'input' : 'change', () => {page = 0; renderEvents();});
  query('order').addEventListener('click', () => {oldest = !oldest; page = 0; query('order').textContent = oldest ? '最早在前' : '最新在前'; query('order').setAttribute('aria-pressed',String(oldest)); renderEvents();});
  query('reset').addEventListener('click', () => {for (const name of ['start','end','category','node','search']) query(name).value = ''; page = 0; renderEvents();});
  query('previous').addEventListener('click', () => {page--; renderEvents();});
  query('next').addEventListener('click', () => {page++; renderEvents();});
  query('refresh').addEventListener('click', async () => {
    if (refreshing) return;
    refreshing = true; query('refresh').disabled = true;
    query('filter-status').textContent = '正在读取记录；不会提交评审或重建右侧草稿。';
    try { await hooks.refresh?.(); renderEvents(); }
    catch { query('filter-status').textContent = '读取失败，仍保留上次记录和右侧草稿。请重新打开服务页面核对。'; }
    finally {refreshing = false; query('refresh').disabled = false;}
  });
  update(state, history);
  return {update};
}
