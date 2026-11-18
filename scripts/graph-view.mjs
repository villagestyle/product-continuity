export const graphStyles = `
.shell{max-width:1600px}.top h1{font-family:Bahnschrift,"Segoe UI","Microsoft YaHei",sans-serif;font-size:1.65rem;font-weight:600;letter-spacing:-.035em}.view-controls{display:flex;gap:.3rem;margin-left:auto;padding:.2rem;background:#e5ebe8;border-radius:6px}.view-controls button{border:0;min-height:38px;background:transparent;font-size:.84rem}.view-controls button[aria-pressed=true]{background:var(--surface);box-shadow:0 1px 4px #1d292818}.view-controls[hidden],[hidden]{display:none!important}
.graph-workspace{display:grid;grid-template-columns:minmax(0,1fr) 304px;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--surface)}.graph-workspace--single{grid-template-columns:minmax(0,1fr)}.graph-board{min-width:0}.graph-heading{display:flex;align-items:center;justify-content:space-between;gap:.8rem;padding:.75rem 1rem;background:#fff;border-bottom:1px solid var(--line)}.graph-heading h2{font-size:.93rem;margin:0}.graph-heading p{font-size:.75rem;color:var(--muted);margin:.12rem 0 0}.graph-live{font:.75rem/1.4 Consolas,"Cascadia Code",monospace;color:var(--muted);text-align:right}
.graph-viewport{position:relative;height:610px;overflow:hidden;background-color:#f1f5f9;background-image:radial-gradient(#bdcbd8 .85px,transparent .85px);background-size:20px 20px;touch-action:none;cursor:grab;isolation:isolate}.graph-viewport:focus-visible{outline:3px solid #2949a7;outline-offset:-3px}.graph-viewport.is-panning{cursor:grabbing}.graph-edges,.graph-world{position:absolute;left:0;top:0}.graph-edges{width:100%;height:100%;pointer-events:none}.graph-world{transform-origin:0 0;width:0;height:0}.graph-node{position:absolute;width:224px;height:128px;overflow:visible}.graph-node-select{position:relative;display:flex;flex-direction:column;align-items:stretch;justify-content:space-between;width:100%;height:100%;padding:13px 15px;border:1px solid #bfccd8;border-left:3px solid var(--node-color,#2949a7);border-radius:7px;text-align:left;box-shadow:0 2px 5px #263d5510;background:#fff;cursor:pointer;transition:box-shadow .16s,border-color .16s;overflow:hidden}.graph-node-select:hover{background:#fff;box-shadow:0 4px 14px #24395424;border-color:#8e9fb0}.graph-node-select[aria-pressed=true]{border-color:#2949a7;outline:2px solid #2949a7;outline-offset:3px;background:#fdfdff}.graph-node-select:focus-visible{outline:3px solid #2949a7;outline-offset:4px}.graph-node.is-dim{opacity:.22}.graph-node-progress{display:block;min-height:0;font-size:10px;line-height:1.2;color:#40566a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.graph-node-progress-next{color:#2f4f43}.graph-node-type{display:flex;align-items:center;gap:6px;min-width:0;font-size:11px;line-height:1.2;font-weight:600;letter-spacing:.035em;color:var(--node-color,#2949a7)}.graph-node-delivery{flex:0 1 auto;min-width:0;max-width:128px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:3px;border:1px solid transparent;padding:1px 5px;font-size:10px;font-weight:600;letter-spacing:0;line-height:1.3}.graph-node-delivery[data-delivery=not_started],.graph-node-delivery[data-delivery=paused],.graph-node-delivery[data-delivery=unknown]{background:#eef1f0;color:#445853;border-color:#c3cdc9}.graph-node-delivery[data-delivery=in_development],.graph-node-delivery[data-delivery=awaiting_release]{background:#e3edf7;color:#1d4d7a;border-color:#bcd2e4}.graph-node-delivery[data-delivery=awaiting_verification],.graph-node-delivery[data-delivery=awaiting_acceptance]{background:#fbf5e6;color:#6d4a10;border-color:#e3cfa4}.graph-node-delivery[data-delivery=completed]{background:#e2efe7;color:#1e5945;border-color:#9cc6b2}.graph-node-delivery[data-needs-review=true]{background:#fbf5e6;color:#6d4a10;border-color:#d9b96a;box-shadow:0 0 0 1px #d9b96a inset}.graph-node-label{font-size:14px;line-height:1.35;font-weight:600;color:#203344;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.graph-node-meta{display:flex;align-items:center;gap:7px;font-size:11px;line-height:1.3;color:#5a6b7c;padding-right:27px}.graph-node-status{border-radius:3px;background:#edf2f6;padding:3px 5px;max-width:145px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.graph-node-roadmap{border-radius:3px;background:#e8f0f7;color:#315f86;padding:3px 5px;max-width:170px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.graph-node-status[data-status=candidate]{background:#faf1da;color:#805a10}.graph-node-status[data-status=confirmed]{background:#e0f0e8;color:#205c45}.graph-node-status[data-status=observed]{background:#e8eef9;color:#294981}.graph-node-status[data-status=unknown]{background:#fae9e6;color:#9a4038}.graph-branch-toggle{position:absolute;right:3px;bottom:2px;width:44px;height:44px;min-height:44px;padding:0;border:0;background:transparent;color:#486383;font:22px/1 Consolas,monospace;cursor:pointer}.graph-branch-toggle:hover{background:#eaf0f6;border-radius:5px}
.graph-toolbox{display:flex;gap:4px;position:absolute;left:14px;top:14px;z-index:2;padding:4px;background:#fffffff2;border:1px solid #c7d2dd;border-radius:7px;box-shadow:0 2px 7px #2d455512}.graph-toolbox button{min-width:44px;min-height:44px;padding:.35rem .55rem;border:0;font-size:.86rem;background:transparent}.graph-toolbox button:hover{background:#eaf0f6}.graph-toolbox output{min-width:48px;align-self:center;text-align:center;font:.75rem Consolas,monospace;color:#536578}.graph-pan{position:absolute;left:14px;bottom:14px;display:flex;gap:3px;z-index:2;padding:3px;background:#fffffff2;border:1px solid #c7d2dd;border-radius:7px}.graph-pan button{width:44px;min-height:44px;border:0;padding:0;background:transparent;font-size:1rem}.graph-pan button:hover{background:#eaf0f6}.graph-minimap{position:absolute;right:14px;bottom:14px;width:160px;height:94px;border:1px solid #c7d2dd;border-radius:5px;background:#fffffff2;z-index:2;cursor:crosshair}.graph-message{position:absolute;top:85px;left:20px;right:20px;text-align:center;padding:.7rem;background:#fffffff2;border-radius:6px;color:#536578;font-size:.85rem;pointer-events:none}.graph-legend{display:flex;flex-wrap:wrap;gap:.5rem 1.2rem;align-items:center;padding:.65rem 1rem;background:#fff;font-size:.75rem;color:var(--muted);border-top:1px solid var(--line)}.graph-legend label{display:flex;align-items:center;gap:.4rem;cursor:pointer}.graph-legend input{min-height:0;width:16px;height:16px;accent-color:#2949a7}.graph-line-key{display:inline-block;width:24px;vertical-align:middle;border-top:2px solid #607fa8;margin-right:.4rem}.graph-line-key.cross{border-top:2px dashed #8b91aa}.graph-help{flex:1 1 100%;margin:0;line-height:1.5}.graph-inspector{min-width:0;border-left:1px solid var(--line);background:#fff;display:flex;flex-direction:column;max-height:785px;overflow:auto}.graph-inspector>header{padding:.85rem 1rem;border-bottom:1px solid var(--line)}.graph-inspector h2{font-size:.9rem;margin:0}.graph-inspector>header p{font-size:.75rem;color:var(--muted);margin:.15rem 0 0}.graph-inspector-content{padding:1rem}.graph-inspector-content>.node{border:0;padding:0}.graph-inspector-content .node header{display:block}.graph-inspector-content .node header>.badge{margin-top:.5rem}.graph-inspector-content .node h3{font-size:1.06rem;line-height:1.4}.graph-inspector-content .node details{margin-top:1rem;padding-top:.6rem;border-top:1px solid #e1e7ec}.graph-inspector-content .node details summary{font-weight:600;color:#35557b}.graph-inspector-content .node details li{font-size:.8rem;overflow-wrap:anywhere}.graph-inspector-content .node .badge{max-width:100%}.graph-inspector-content .node-id{font:11px/1.5 Consolas,monospace}.graph-snapshot-note{font-size:.75rem;line-height:1.6;color:var(--muted);padding:.8rem 1rem;border-top:1px solid var(--line);margin-top:auto}.graph-supplement{margin-top:.8rem;padding:.75rem 1rem;border:1px solid var(--line);border-radius:6px;background:#fff}.graph-supplement>summary{font-size:.86rem;color:var(--ink)}.graph-observations{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-top:.75rem;font-size:.82rem}.graph-observations h2{font-size:.9rem;margin:.4rem 0}.graph-observations ul{padding-left:1.1rem}.graph-observations p{margin:.4rem 0}.graph-layout-warning{color:var(--amber);font-size:.75rem;margin:0;padding:.4rem 1rem;background:var(--amber-soft)}
@media(max-width:1000px){.graph-workspace{grid-template-columns:minmax(0,1fr)}.graph-viewport{height:520px}.graph-inspector{border-left:0;border-top:1px solid var(--line);max-height:340px}.graph-minimap{width:134px;height:84px}.graph-toolbox{left:8px;top:8px;gap:0}.graph-toolbox button{padding:.3rem}}@media(max-width:760px){.graph-workspace{grid-template-columns:minmax(0,1fr)}.graph-inspector{border-left:0;border-top:1px solid var(--line);max-height:400px}.graph-inspector-content{display:block}.graph-viewport{height:440px}.view-controls{margin-left:0}.graph-inspector-content .node header{display:flex}.graph-observations{grid-template-columns:1fr;gap:.5rem}.graph-help{display:none}.graph-minimap{width:116px;height:78px}.graph-pan{gap:0;left:8px;bottom:8px}.graph-pan button{width:40px}.graph-heading{flex-wrap:wrap;padding:.65rem}.graph-heading>div:first-child{flex:1 1 100%}.graph-heading-actions{width:100%;justify-content:flex-start}.graph-live{flex:1 1 100%;text-align:left;font-size:.68rem}.graph-toolbox{max-width:calc(100% - 16px);flex-wrap:wrap}.graph-toolbox button{font-size:.78rem;min-width:40px}.graph-toolbox output{min-width:42px}}@media(prefers-reduced-motion:reduce){.graph-node-select{transition:none}}
.graph-viewport,.graph-viewport *{-webkit-user-select:none;user-select:none;-webkit-user-drag:none}.graph-node-select{cursor:grab}.graph-viewport.is-panning,.graph-viewport.is-panning *{cursor:grabbing!important}
/* Selection is blocked outside the viewport only while a graph gesture owns it. */
html.continuity-graph-gesture,html.continuity-graph-gesture *{-webkit-user-select:none!important;user-select:none!important}
/* Fullscreen keeps the existing inspector/review region, without cloning DOM or drafts. */
.graph-heading-actions{display:flex;align-items:center;gap:.7rem;flex-shrink:0}.graph-fullscreen{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;min-width:44px;min-height:44px;white-space:nowrap}.graph-fullscreen svg{width:1rem;height:1rem;flex-shrink:0}.graph-fullscreen-status{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.graph-fullscreen-status[data-mode=window]{position:static;width:auto;height:auto;clip-path:none;white-space:normal;flex-shrink:0;margin:0;padding:.35rem 1rem;background:var(--blue-soft,#e8f0f7);color:var(--blue,#315f86);font-size:.75rem}
html.continuity-graph-fullscreen,html.continuity-graph-fullscreen body{overflow:hidden}
.continuity-fullscreen-host{position:fixed!important;inset:0!important;z-index:1000;width:100%!important;height:100vh;height:100dvh;max-width:none!important;max-height:none!important;margin:0!important;padding:0 .7rem!important;box-sizing:border-box;overflow:auto;background:var(--paper,var(--surface,#fff));color:var(--ink,#1d2928)}.continuity-fullscreen-host .graph-legend{display:none}
.continuity-fullscreen-host::backdrop{background:var(--paper,var(--surface,#fff))}
.continuity-fullscreen-host#graph-view{display:flex;flex-direction:column}.continuity-fullscreen-host #graph-view{min-width:0;min-height:0;height:100%}
.continuity-fullscreen-host .graph-workspace{height:100%;min-height:0}.continuity-fullscreen-host .graph-board{display:flex;flex-direction:column;min-height:0}.continuity-fullscreen-host .graph-viewport{flex:1;min-height:160px;height:auto}.continuity-fullscreen-host .graph-heading,.continuity-fullscreen-host .graph-legend,.continuity-fullscreen-host .graph-layout-warning{flex-shrink:0}.continuity-fullscreen-host .graph-inspector{min-height:0;max-height:none}
.continuity-fullscreen-host.review-layout{align-items:stretch;grid-template-rows:minmax(0,1fr)}.continuity-fullscreen-host .review-main{display:block;min-height:0}.continuity-fullscreen-host .review-main>.directory{display:none}.continuity-fullscreen-host .review-panel{position:relative;top:auto;max-height:none;height:100%;min-height:0}
@media(max-width:1100px){.continuity-fullscreen-host.review-layout{grid-template-columns:minmax(0,1fr) minmax(300px,36%)}}
@media(max-width:1000px){.continuity-fullscreen-host .graph-workspace:not(.graph-workspace--single){grid-template-columns:minmax(0,1fr) 280px}.continuity-fullscreen-host .graph-inspector{border-top:0;border-left:1px solid var(--line)}}
@media(max-width:760px){.graph-heading-actions{gap:.4rem}.graph-fullscreen{font-size:.8rem}.continuity-fullscreen-host{padding:0 .4rem!important}.continuity-fullscreen-host.review-layout{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(260px,1fr) minmax(180px,.7fr)}.continuity-fullscreen-host .graph-workspace:not(.graph-workspace--single){grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(240px,1fr) minmax(140px,.5fr)}.continuity-fullscreen-host .graph-inspector{border-left:0;border-top:1px solid var(--line)}.continuity-fullscreen-host .graph-legend{padding:.4rem .6rem}}
.graph-filters{display:flex;flex-wrap:wrap;gap:.35rem .65rem;align-items:center;padding:.4rem .65rem;background:#fbfdfc;border-bottom:1px solid var(--line);font-size:.74rem;color:var(--muted)}.graph-filters label{display:flex;align-items:center;gap:.3rem}.graph-filters input,.graph-filters select{min-height:2rem;height:2rem;padding:.1rem .35rem;font-size:.74rem;border:1px solid #b8c6d0;border-radius:4px;background:#fff;color:var(--ink);max-width:12rem}.graph-filters input[type=search]{width:11rem}.graph-filters button{min-height:2rem;padding:.1rem .5rem;font-size:.74rem}
.graph-arrange-panel{display:flex;flex-wrap:wrap;align-items:center;gap:.35rem .6rem;padding:.35rem .65rem;background:#f4f8fb;border-bottom:1px solid var(--line);font-size:.72rem;color:#536578}.graph-arrange-panel p{margin:0}.graph-arrange-panel button{min-height:2rem;padding:.1rem .45rem;font-size:.72rem}.graph-arrange-actions{display:flex;gap:.3rem}.graph-arrange-panel .graph-group-form{display:flex;flex-wrap:wrap;align-items:center;gap:.3rem;flex-basis:100%}.graph-arrange-panel .graph-group-form label{display:flex;align-items:center;gap:.3rem}.graph-arrange-panel input{min-height:2rem;height:2rem;font-size:.72rem;padding:.1rem .35rem;width:10rem;max-width:45vw}
.graph-node{z-index:1}.graph-node.is-multi .graph-node-select{outline:2px dashed #2949a7;outline-offset:3px;box-shadow:0 0 0 5px #2949a71a}.graph-viewport.is-arranging .graph-node-select{cursor:move}
.graph-group{position:absolute;z-index:0;border:1px solid #aebfce;border-radius:12px;background:#e8f0f74d;box-shadow:inset 0 0 0 1px #ffffffb3;pointer-events:none}.graph-group.is-collapsed{overflow:hidden;background:#e8f0f799}.graph-group-head{position:absolute;left:-1px;top:-1px;display:flex;align-items:center;gap:.3rem;max-width:calc(100% + 2px);padding:.12rem .35rem;background:#fff;border:1px solid #aebfce;border-radius:11px 11px 3px 0;pointer-events:auto;cursor:grab;font-size:12px;color:#334a5e;user-select:none}.graph-group-head:active{cursor:grabbing}.graph-group-label{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:12rem}.graph-group-count{font-size:.68rem;color:#6b7c8b;background:#eef3f7;border-radius:3px;padding:0 .25rem}.graph-group-toggle,.graph-group-remove{min-height:1.4rem;min-width:1.4rem;height:1.4rem;padding:0;border:0;background:transparent;font-size:.8rem;line-height:1;color:#536578}.graph-group-toggle:hover,.graph-group-remove:hover{background:#eaf0f6;color:#1d2928}.graph-group-remove{font-size:1rem}
@media(max-width:760px){.graph-filters input[type=search]{width:8rem}.graph-filters{font-size:.7rem}.graph-arrange-panel p{display:none}}
.graph-node-type{padding-right:36px}
.graph-node-label{margin-right:36px}
.graph-node-details{position:absolute;z-index:2;right:6px;top:6px;display:grid;place-items:center;width:44px;height:44px;min-width:44px;min-height:44px;padding:0;border:1px solid #c7d2dd;border-radius:4px;background:var(--surface,#fff);color:#2949a7;font-size:.68rem;line-height:1.2;cursor:pointer}
.graph-node-details:hover{background:#eaf0f6}
.graph-node-details:focus-visible{outline:3px solid #2949a7;outline-offset:2px}
.graph-node-dialog{width:min(640px,calc(100vw - 32px));max-width:none;max-height:calc(100dvh - 32px);padding:0;border:1px solid var(--line,#aebcb6);border-radius:7px;background:var(--surface,#fff);color:var(--ink,#1d2928);box-shadow:0 18px 56px #14242c55;overflow:hidden}
.graph-node-dialog::backdrop{background:#13242b88}
.graph-node-dialog-inner{display:flex;flex-direction:column;max-height:calc(100dvh - 34px)}
.graph-node-dialog-head{display:flex;flex-shrink:0;align-items:flex-start;justify-content:space-between;gap:1rem;padding:1rem 1.1rem;border-bottom:1px solid var(--line,#d8e0dc)}
.graph-node-dialog-head h2{margin:0;font-size:1.15rem;overflow-wrap:anywhere}
.graph-node-dialog-head p{margin:.2rem 0 0;color:var(--muted,#5d6d69);font-size:.8rem}
.graph-node-dialog-close{flex:0 0 44px;width:44px;min-width:44px;min-height:44px;padding:0;font-size:1.2rem;line-height:1}
.graph-node-dialog-content{min-height:0;overflow:auto;padding:.9rem 1.1rem 1.1rem;overscroll-behavior:contain;touch-action:pan-y}
.graph-node-dialog-content section+section{margin-top:1rem;padding-top:.8rem;border-top:1px solid var(--line,#d8e0dc)}
.graph-node-dialog-content h3{margin:0 0 .4rem;font-size:.82rem;color:var(--muted,#536578)}
.graph-node-dialog-content p{margin:.25rem 0;white-space:pre-wrap;overflow-wrap:anywhere}
.graph-node-dialog-meta{display:flex;flex-wrap:wrap;gap:.35rem;margin-bottom:.8rem}
.graph-node-dialog-meta span{padding:.15rem .4rem;border:1px solid var(--line,#d8e0dc);border-radius:3px;font-size:.72rem}
.graph-node-dialog-relations{display:grid;gap:.4rem;margin:0;padding:0;list-style:none}
.graph-node-dialog-relations li{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:start;gap:.5rem;padding:.45rem 0;border-bottom:1px solid var(--line,#e6ebe8);font-size:.82rem}
.graph-node-dialog-relations li:last-child{border-bottom:0}
.graph-node-dialog-relations .relation-kind{color:var(--muted,#5d6d69)}
.graph-node-dialog-relations .relation-node{overflow-wrap:anywhere;font-weight:600}
@media(max-width:480px){.graph-node-dialog{width:calc(100vw - 16px);max-height:calc(100dvh - 16px)}.graph-node-dialog-inner{max-height:calc(100dvh - 18px)}.graph-node-dialog-head{padding:.8rem}.graph-node-dialog-content{padding:.75rem .8rem}.graph-node-dialog-relations li{grid-template-columns:1fr;gap:.1rem}}
.graph-node{content-visibility:auto;contain-intrinsic-size:224px 128px}
.graph-node-folded{position:absolute;left:14px;bottom:7px;max-width:155px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11px;color:#536578;pointer-events:none}
.graph-node:has(.graph-node-folded) .graph-node-meta{padding-right:30px;margin-bottom:17px}
.graph-viewport[data-detail=compact] .graph-node-progress,.graph-viewport[data-detail=compact] .graph-node-delivery,.graph-viewport[data-detail=compact] .graph-node-roadmap,.graph-viewport[data-detail=compact] .graph-node-meta{display:none}
.graph-viewport[data-detail=compact] .graph-node-select{display:grid;grid-template-rows:18px 48px;align-content:space-between;padding:12px 14px 30px}
.graph-viewport[data-detail=compact] .graph-node-type{font-size:15px}
.graph-viewport[data-detail=compact] .graph-node-label{margin-right:0;font-size:20px;line-height:1.2;-webkit-line-clamp:2}
.graph-viewport[data-detail=compact] .graph-node-folded{font-size:16px;line-height:1.2;bottom:7px}
.graph-viewport[data-detail=overview] .graph-node-type,.graph-viewport[data-detail=overview] .graph-node-meta,.graph-viewport[data-detail=overview] .graph-node-progress{display:none}
.graph-viewport[data-detail=overview] .graph-node-select{justify-content:center;box-shadow:none}
.graph-viewport[data-detail=overview] .graph-node-label{margin-right:0;flex-shrink:0;font-size:26px;line-height:1.2;-webkit-line-clamp:2}
.graph-viewport[data-detail=overview] .graph-node-folded{font-size:18px;bottom:5px}
.graph-viewport[data-detail=overview] .graph-node:has(.graph-node-folded) .graph-node-select{padding-bottom:32px}
.graph-viewport[data-detail=overview] .graph-node-details{opacity:0}
.graph-viewport[data-detail=overview] .graph-node:hover .graph-node-details,.graph-viewport[data-detail=overview] .graph-node:focus-within .graph-node-details{opacity:1}
`;

export function renderGraphShell(labels, options = {}) {
  const g = labels.graph;
  const showInspector = options.inspector !== false;
  const showArrange = options.arrange === true;
  const showFilters = options.filters === true;
  // Only trusted, already escaped renderer markup belongs in this optional dock.
  const timeline = options.timeline === true && typeof options.timelineContent === 'string' ? options.timelineContent : '';
  const filterBar = showFilters ? `<div class="graph-filters" role="search" aria-label="${g.search}">
    <label>${g.search}<input id="search" type="search" placeholder="${g.searchPlaceholder}" autocomplete="off"></label>
    <label>${g.statusField}<select id="status"><option value="">${g.allStatuses}</option>${Object.entries(g.statuses).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
    <label>${g.nodeType}<select id="kind"><option value="">${g.allNodeTypes}</option>${Object.entries(g.kinds).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
    <button type="button" id="reset">${g.resetFilters}</button>
  </div>` : '';
  const arrangePanel = showArrange ? `<div class="graph-arrange-panel" id="graph-arrange-panel" hidden>
      <p>${g.arrangeHint}</p>
      <div class="graph-arrange-actions"><button type="button" id="graph-group" disabled>${g.group}</button><button type="button" id="graph-reset-layout" hidden>${g.resetLayout}</button></div>
      <div class="graph-group-form" id="graph-group-form" hidden><label>${g.groupName}<input id="graph-group-name" maxlength="40" autocomplete="off"></label><button type="button" id="graph-group-create">${g.groupCreate}</button><button type="button" id="graph-group-cancel">${g.groupCancel}</button></div>
    </div>` : '';
  return `<section id="graph-view" hidden aria-label="${g.title}">
    <div class="graph-workspace${showInspector ? '' : ' graph-workspace--single'}">
      <div class="graph-board${timeline ? ' graph-board--timeline' : ''}">
        <header class="graph-heading"><div><h2>${g.title}</h2><p>${g.readOnly}</p></div><div class="graph-heading-actions"><output class="graph-live" id="graph-live" aria-live="polite"></output>${options.roadmap === true ? '<button type="button" id="graph-roadmap" class="graph-fullscreen" aria-controls="roadmap-panel">功能规划</button>' : ''}${options.timeline === true ? `<button type="button" id="graph-timeline" class="graph-fullscreen" aria-controls="product-timeline" aria-expanded="false" hidden>${g.timeline}</button>` : ''}<button type="button" id="graph-fullscreen" class="graph-fullscreen" aria-label="${g.fullscreen}" aria-pressed="false" title="${g.fullscreen}" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg><span>${g.fullscreen}</span></button></div></header>
        <p id="graph-fullscreen-status" class="graph-fullscreen-status" role="status" aria-live="polite"></p>
        ${filterBar}
        ${timeline ? '<div class="graph-stage">' : ''}
        ${arrangePanel}
        <div class="graph-viewport" id="graph-viewport" tabindex="0" role="region" aria-label="${g.navigation}" aria-describedby="graph-help">
          <canvas id="graph-edges" class="graph-edges" aria-hidden="true"></canvas><div id="graph-world" class="graph-world"></div>
          <div class="graph-toolbox" aria-label="${g.zoomTools}"><button type="button" id="graph-zoom-out" aria-label="${g.zoomOut}" title="${g.zoomOut}">−</button><output id="graph-zoom" aria-label="${g.zoomLevel}">100%</output><button type="button" id="graph-zoom-in" aria-label="${g.zoomIn}" title="${g.zoomIn}">+</button><button type="button" id="graph-fit">${g.fit}</button><button type="button" id="graph-actual">1:1</button><button type="button" id="graph-overview">${g.overview ?? '分层总览'}</button><button type="button" id="graph-expand">${g.expandAll}</button>${showArrange ? `<button type="button" id="graph-arrange" aria-pressed="false" title="${g.arrangeHint}">${g.arrange}</button><button type="button" id="graph-focus" aria-pressed="false" disabled>${g.focus}</button>` : ''}</div>
          <div class="graph-pan" aria-label="${g.panTools}">${['left', 'up', 'down', 'right'].map((direction, index) => `<button type="button" data-pan="${direction}" aria-label="${g.pan[index]}" title="${g.pan[index]}">${['←', '↑', '↓', '→'][index]}</button>`).join('')}</div>
          <canvas id="graph-minimap" class="graph-minimap" role="img" aria-label="${g.minimap}"></canvas><p class="graph-message" id="graph-message" hidden></p>
        </div>
        ${timeline ? `${timeline}</div>` : ''}
        <footer class="graph-legend"><span><i class="graph-line-key"></i>${g.hierarchy}</span><label><input type="checkbox" id="graph-cross" aria-label="${g.crossLinks}" checked><i class="graph-line-key cross"></i>${g.crossLinks}</label><p class="graph-help" id="graph-help">${g.help}</p></footer>
        <p id="graph-layout-warning" class="graph-layout-warning" hidden>${g.layoutWarning}</p>
      </div>
      ${showInspector ? `<aside class="graph-inspector" aria-label="${g.details}"><header><h2>${g.details}</h2><p>${g.selectHint}</p></header><div class="graph-inspector-content" id="graph-inspector-content"></div><p class="graph-snapshot-note">${g.snapshotNote}</p></aside>` : ''}
    </div>
    <dialog id="graph-node-dialog" class="graph-node-dialog" aria-labelledby="graph-node-dialog-title"><div class="graph-node-dialog-inner"><header class="graph-node-dialog-head"><div><h2 id="graph-node-dialog-title"></h2><p id="graph-node-dialog-subtitle"></p></div><button type="button" class="graph-node-dialog-close" id="graph-node-dialog-close" aria-label="${g.closeDetails}">×</button></header><div class="graph-node-dialog-content" id="graph-node-dialog-content" tabindex="0" role="region" aria-labelledby="graph-node-dialog-title"></div></div></dialog>
  </section>`;
}

// Inlined into the standalone page. Only already-escaped server-rendered cards
// are cloned; graph data is assigned with textContent, never innerHTML.
export function initializeGraph(data, buildLayout, hooks = {}) {
  const ui = data.labels;
  const viewport = document.querySelector('#graph-viewport');
  const world = document.querySelector('#graph-world');
  const canvas = document.querySelector('#graph-edges');
  const minimap = document.querySelector('#graph-minimap');
  const context = canvas?.getContext('2d');
  const miniContext = minimap?.getContext('2d');
  if (!context || !miniContext) return;
  const nodeDialog = document.querySelector('#graph-node-dialog');
  const nodeDialogTitle = document.querySelector('#graph-node-dialog-title');
  const nodeDialogSubtitle = document.querySelector('#graph-node-dialog-subtitle');
  const nodeDialogContent = document.querySelector('#graph-node-dialog-content');
  const nodeDialogClose = document.querySelector('#graph-node-dialog-close');
  let nodeDialogOpener = null;
  let sourceById = new Map(data.nodes.map((node) => [node.id, node]));
  let sourceByAnchor = new Map(data.nodes.filter((node) => node.anchor).map((node) => [node.anchor, node.id]));
  const nodeElements = new Map();
  const collapsed = new Set();
  const hasInspector = Boolean(document.querySelector('#graph-inspector-content'));
  const search = document.querySelector('#search');
  const status = document.querySelector('#status');
  const kind = document.querySelector('#kind');
  const hasFilters = Boolean(search && status && kind);
  let hierarchy;
  let descendants;
  let filterCollapsed = null;
  function indexHierarchy() {
    const full = buildLayout(data.nodes, data.edges);
    hierarchy = new Map(full.nodes.map((node) => [node.id, node]));
    descendants = new Map(full.nodes.map((node) => [node.id, 0]));
    for (const node of [...full.nodes].reverse()) {
      if (node.parentId !== null) descendants.set(node.parentId, descendants.get(node.parentId) + 1 + descendants.get(node.id));
    }
  }
  function collapseOverview() {
    collapsed.clear();
    for (const node of hierarchy.values()) {
      if (node.childCount && (sourceById.get(node.id)?.kind === 'user_task' || node.depth >= 2)) collapsed.add(node.id);
    }
  }
  indexHierarchy();
  if (data.nodes.length > 18) collapseOverview();
  const listView = document.querySelector('#list-view');
  const graphView = document.querySelector('#graph-view');
  const fullscreenButton = document.querySelector('#graph-fullscreen');
  // The live host contains both graph and the existing non-modal review panel.
  const fullscreenHost = graphView.closest('[data-graph-fullscreen-host]') || graphView;
  const fullscreenStatus = document.querySelector('#graph-fullscreen-status');
  // The review page docks the timeline under the canvas; size that dock to the
  // first screen after the review header, filters and arrange bar, so the pan
  // controls and minimap never sit below the fold on common laptop heights.
  // The dock's own strip stays inside the stage: only the canvas needs to fit
  // the first screen, otherwise the dock strip would steal height from it.
  const graphStage = document.querySelector('.graph-stage');
  const stageChrome = [document.querySelector('#review-header'), document.querySelector('.graph-heading'), document.querySelector('.graph-filters')].filter(Boolean);
  const stageTime = document.querySelector('#graph-time');
  const stageTimeline = document.querySelector('#product-timeline');
  let closedTimelineHeight = 0;
  function stageDockHeight() {
    if (stageTimeline) {
      if (!stageTimeline.open) closedTimelineHeight = stageTimeline.offsetHeight;
      if (!closedTimelineHeight) {
        const summary = stageTimeline.querySelector('summary');
        closedTimelineHeight = (summary?.offsetHeight || 0) + 1;
      }
    }
    return (stageTime?.offsetHeight || 0) + closedTimelineHeight;
  }
  function fitStageHeight() {
    if (!graphStage || !graphStage.isConnected || graphView.hidden) return;
    if (fullscreenHost.classList.contains('continuity-fullscreen-host')) return;
    const top = graphStage.getBoundingClientRect().top + window.scrollY;
    const available = Math.min(1360, Math.max(220, Math.round(window.innerHeight - top - 12)));
    const height = Math.min(1360, Math.max(320, available + stageDockHeight()));
    const next = height + 'px';
    if (document.documentElement.style.getPropertyValue('--graph-stage-h') !== next) {
      document.documentElement.style.setProperty('--graph-stage-h', next);
    }
  }
  if (graphStage) {
    fitStageHeight();
    window.addEventListener('resize', fitStageHeight);
    if (typeof ResizeObserver !== 'undefined') {
      const chromeObserver = new ResizeObserver(() => fitStageHeight());
      for (const element of stageChrome) chromeObserver.observe(element);
    }
  }
  let fullscreenActive = false;
  let fullscreenPending = false;
  let fullscreenSession = 0;
  let fullscreenOrigin;
  let fullscreenInert = [];
  const palette = {
    product_goal: '#2949a7', user_group: '#796047', user_task: '#266b88',
    behavior_commitment: '#6a5295', capability: '#28796c', business_object: '#527264',
    implementation: '#52677e', verification: '#8a6527', unknown: '#a04b45',
  };
  let layout;
  let positions;
  let selectedId = data.nodes[0]?.id;
  let matches = new Set(data.nodes.map((node) => node.id));
  let filtering = false;
  let width = 0;
  let height = 0;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let frame;
  let manualView = false;
  let updateUrl = true;
  let miniProjection;
  const miniCache = document.createElement('canvas');
  const miniCacheContext = miniCache.getContext('2d');
  let miniDirty = true;
  let minimapPaints = 0;
  let drawnEdges = 0;
  let culledEdges = 0;

  const arrangeEnabled = hooks.arrange === true;
  const storageKey = typeof hooks.storageKey === 'string' ? hooks.storageKey : '';
  const arrangeButton = document.querySelector('#graph-arrange');
  const focusButton = document.querySelector('#graph-focus');
  const arrangePanel = document.querySelector('#graph-arrange-panel');
  const groupButton = document.querySelector('#graph-group');
  const groupForm = document.querySelector('#graph-group-form');
  const groupName = document.querySelector('#graph-group-name');
  const groupCreate = document.querySelector('#graph-group-create');
  const groupCancel = document.querySelector('#graph-group-cancel');
  const resetLayoutButton = document.querySelector('#graph-reset-layout');
  let arrangeMode = false;
  let multiSelected = new Set();
  let groups = [];
  let customPositions = new Map();
  let groupElements = new Map();
  let groupHiddenIds = new Set();
  let nodeDrag = null;
  let groupDrag = null;
  let focusRoot = null;
  let focusSet = null;
  let adjacency = new Map();
  const GRID = 16;

  function loadOrganizeState() {
    if (!storageKey) return;
    try {
      const parsed = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (!parsed || parsed.version !== 1) return;
      for (const [id, point] of Object.entries(parsed.positions || {}).slice(0, 500)) {
        if (typeof id === 'string' && Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
          customPositions.set(id, { x: point.x, y: point.y });
        }
      }
      if (Array.isArray(parsed.groups)) {
        groups = parsed.groups.filter((group) => group && typeof group.id === 'string'
          && typeof group.label === 'string' && Array.isArray(group.nodeIds)).slice(0, 20).map((group) => ({
          id: group.id,
          label: String(group.label).slice(0, 40),
          nodeIds: group.nodeIds.filter((id) => typeof id === 'string').slice(0, 200),
          collapsed: Boolean(group.collapsed),
        })).filter((group) => group.label && group.nodeIds.length);
      }
    } catch { /* Private mode or a stale local layout must not break the map. */ }
  }

  function persistOrganizeState() {
    if (!storageKey) return;
    try {
      const positions = Object.fromEntries([...customPositions].map(([id, point]) => [id, { x: Math.round(point.x), y: Math.round(point.y) }]));
      sessionStorage.setItem(storageKey, JSON.stringify({
        version: 1,
        positions,
        groups: groups.map((group) => ({ id: group.id, label: group.label, nodeIds: [...group.nodeIds], collapsed: Boolean(group.collapsed) })),
      }));
    } catch { /* A view-only arrangement is best effort. */ }
  }

  loadOrganizeState();

  // A historical snapshot can legitimately omit nodes that still exist in the
  // current tree. Keep its view-only positions and groups untouched until the
  // current state returns, then drop only records that no longer exist.
  function pruneOrganize() {
    for (const id of [...customPositions.keys()]) if (!sourceById.has(id)) customPositions.delete(id);
    for (const group of groups) group.nodeIds = group.nodeIds.filter((id) => sourceById.has(id));
    groups = groups.filter((group) => group.nodeIds.length);
  }

  function groupBounds(group) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const id of group.nodeIds) {
      const point = positions?.get(id);
      if (!point) continue;
      minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x + point.width); maxY = Math.max(maxY, point.y + point.height);
    }
    if (!Number.isFinite(minX)) return null;
    return {
      x: Math.max(0, minX - 16), y: Math.max(0, minY - 44),
      width: maxX - minX + 32, height: group.collapsed ? 44 : maxY - minY + 60,
    };
  }

  function renderGroups() {
    groupElements = new Map();
    for (const group of groups) {
      const bounds = groupBounds(group);
      if (!bounds) continue;
      const element = document.createElement('div');
      element.className = 'graph-group' + (group.collapsed ? ' is-collapsed' : '');
      element.dataset.groupId = group.id;
      element.setAttribute('role', 'group');
      element.setAttribute('aria-label', group.label);
      element.style.left = bounds.x + 'px'; element.style.top = bounds.y + 'px';
      element.style.width = bounds.width + 'px'; element.style.height = bounds.height + 'px';
      const head = document.createElement('div');
      head.className = 'graph-group-head';
      head.dataset.groupId = group.id;
      const toggle = button(group.collapsed ? '+' : '−', 'graph-group-toggle');
      toggle.setAttribute('aria-label', (group.collapsed ? ui.groupExpand : ui.groupToggle) + ': ' + group.label);
      toggle.setAttribute('aria-expanded', String(!group.collapsed));
      toggle.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation();
        group.collapsed = !group.collapsed;
        persistOrganizeState(); rebuild();
      });
      const label = document.createElement('span');
      label.className = 'graph-group-label';
      label.textContent = group.label;
      const count = document.createElement('span');
      count.className = 'graph-group-count';
      count.textContent = String(group.nodeIds.filter((id) => positions.has(id)).length);
      const remove = button('×', 'graph-group-remove');
      remove.setAttribute('aria-label', ui.groupRemove + ': ' + group.label);
      remove.addEventListener('click', (event) => {
        event.preventDefault(); event.stopPropagation();
        groups = groups.filter((item) => item.id !== group.id);
        persistOrganizeState(); rebuild(); updateArrangeUI();
      });
      head.append(toggle, label, count, remove);
      element.append(head);
      world.append(element);
      groupElements.set(group.id, element);
    }
  }

  function positionGroupElements() {
    for (const group of groups) {
      const element = groupElements.get(group.id);
      const bounds = groupBounds(group);
      if (!element || !bounds) continue;
      element.style.left = bounds.x + 'px'; element.style.top = bounds.y + 'px';
      element.style.width = bounds.width + 'px'; element.style.height = bounds.height + 'px';
      element.classList.toggle('is-collapsed', group.collapsed);
    }
  }

  function computeGroupHidden() {
    const hidden = new Set();
    if (!groups.length) return hidden;
    const children = new Map();
    for (const node of layout.nodes) {
      if (!children.has(node.parentId)) children.set(node.parentId, []);
      children.get(node.parentId).push(node.id);
    }
    for (const group of groups) {
      if (!group.collapsed) continue;
      for (const id of group.nodeIds) {
        const stack = [id];
        while (stack.length) {
          const current = stack.pop();
          if (hidden.has(current)) continue;
          hidden.add(current);
          for (const child of children.get(current) || []) stack.push(child);
        }
      }
    }
    return hidden;
  }

  function updateBounds() {
    miniDirty = true;
    let maxX = 0; let maxY = 0;
    for (const point of positions?.values() || []) {
      maxX = Math.max(maxX, point.x + point.width);
      maxY = Math.max(maxY, point.y + point.height);
    }
    layout.width = maxX ? maxX + 40 : 0;
    layout.height = maxY ? maxY + 40 : 0;
  }

  function buildAdjacency() {
    adjacency = new Map(data.nodes.map((node) => [node.id, []]));
    for (const edge of data.edges) {
      if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
      adjacency.get(edge.from).push(edge.to);
      adjacency.get(edge.to).push(edge.from);
    }
  }

  function updateFocusButton() {
    if (!focusButton) return;
    focusButton.disabled = !selectedId || !sourceById.has(selectedId);
    focusButton.setAttribute('aria-pressed', String(Boolean(focusRoot)));
    focusButton.textContent = focusRoot ? ui.focusOff : ui.focus;
  }

  function updateFocusSet() {
    if (!focusRoot || !sourceById.has(focusRoot)) {
      focusRoot = null; focusSet = null;
    } else {
      const next = new Set([focusRoot]);
      let frontier = [focusRoot];
      for (let hop = 0; hop < 2; hop += 1) {
        const following = [];
        for (const id of frontier) {
          for (const other of adjacency.get(id) || []) {
            if (next.has(other)) continue;
            next.add(other); following.push(other);
          }
        }
        frontier = following;
      }
      focusSet = next;
    }
    updateFocusButton();
    updateMatches();
  }

  function updateMultiUI() {
    for (const [id, element] of nodeElements) element.classList.toggle('is-multi', multiSelected.has(id));
    if (groupButton) groupButton.disabled = !arrangeMode || multiSelected.size < 2;
  }

  function updateArrangeUI() {
    if (arrangeButton) {
      arrangeButton.setAttribute('aria-pressed', String(arrangeMode));
      arrangeButton.textContent = arrangeMode ? ui.arrangeDone : ui.arrange;
    }
    if (arrangePanel) arrangePanel.hidden = !arrangeMode;
    if (resetLayoutButton) resetLayoutButton.hidden = !(customPositions.size || groups.length);
    if (groupForm && !arrangeMode) groupForm.hidden = true;
  }

  function setArrangeMode(next) {
    arrangeMode = Boolean(next);
    viewport.classList.toggle('is-arranging', arrangeMode);
    if (!arrangeMode) {
      multiSelected.clear();
      if (groupForm) groupForm.hidden = true;
    }
    updateArrangeUI();
    updateMultiUI();
  }

  function toggleMulti(id) {
    if (multiSelected.has(id)) multiSelected.delete(id); else multiSelected.add(id);
    updateMultiUI();
  }

  function createGroup() {
    if (!groupName || multiSelected.size < 2) return;
    const label = groupName.value.trim();
    if (!label) return;
    const id = 'group-' + (globalThis.crypto?.randomUUID?.() || (Date.now() + '-' + Math.random().toString(36).slice(2, 8)));
    groups.push({ id, label: label.slice(0, 40), nodeIds: [...multiSelected], collapsed: false });
    multiSelected.clear();
    groupName.value = ''; groupForm.hidden = true;
    persistOrganizeState(); rebuild(); updateArrangeUI(); updateMultiUI();
  }

  function updateMembership(ids) {
    const moving = new Set(ids);
    const targets = new Map();
    // Compute each group from its remaining cards only; otherwise a card dragged
    // out of a group enlarges that group's own bounds and never leaves it.
    for (const group of groups) {
      if (group.collapsed) continue;
      const resting = group.nodeIds.filter((id) => !moving.has(id));
      if (!resting.length) continue;
      const bounds = groupBounds({ ...group, nodeIds: resting });
      if (bounds) targets.set(group.id, bounds);
    }
    const inside = (point, bounds) => point.x + point.width / 2 >= bounds.x
      && point.x + point.width / 2 <= bounds.x + bounds.width
      && point.y + point.height / 2 >= bounds.y
      && point.y + point.height / 2 <= bounds.y + bounds.height;
    const targetFor = (id) => {
      const point = positions.get(id);
      if (!point) return null;
      for (const [groupId, bounds] of targets) if (inside(point, bounds)) return groupId;
      return null;
    };
    let changed = false;
    for (const id of ids) {
      const current = groups.find((group) => group.nodeIds.includes(id))?.id ?? null;
      if (current !== targetFor(id)) { changed = true; break; }
    }
    if (!changed) return false;
    for (const group of groups) group.nodeIds = group.nodeIds.filter((id) => !moving.has(id));
    for (const id of ids) {
      const target = targetFor(id);
      if (target) groups.find((group) => group.id === target).nodeIds.push(id);
    }
    groups = groups.filter((group) => group.nodeIds.length);
    return true;
  }


  function button(text, className) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = className;
    element.textContent = text;
    return element;
  }

  function openNodeDetails(id, opener) {
    const source = sourceById.get(id);
    if (!source || !nodeDialog || !nodeDialogTitle || !nodeDialogContent) return;
    nodeDialogOpener = opener;
    nodeDialogTitle.textContent = source.label;
    if (nodeDialogSubtitle) nodeDialogSubtitle.textContent = source.kindLabel ?? source.kind;
    nodeDialogContent.replaceChildren();
    const meta = document.createElement('div');
    meta.className = 'graph-node-dialog-meta';
    for (const value of [source.statusLabel, source.roadmapLabel]) {
      if (!value) continue;
      const chip = document.createElement('span');
      chip.textContent = value;
      meta.append(chip);
    }
    if (meta.childElementCount) nodeDialogContent.append(meta);

    const appendSection = (heading, values) => {
      const content = values.filter((value) => typeof value === 'string' && value.trim());
      if (!content.length) return;
      const section = document.createElement('section');
      const title = document.createElement('h3');
      title.textContent = heading;
      section.append(title);
      for (const value of content) {
        const paragraph = document.createElement('p');
        paragraph.textContent = value;
        section.append(paragraph);
      }
      nodeDialogContent.append(section);
    };
    appendSection(data.labels.detailsDescription ?? '说明', [source.description]);
    const progressText = source.progressDetail || [source.progressLine, source.progressNext].filter(Boolean).join('\n');
    appendSection(data.labels.detailsProgress ?? '进度详情', [progressText,
      progressText?.includes(source.delivery?.title) ? null : source.delivery?.title]);

    const relations = data.edges.filter((edge) => edge.from === id || edge.to === id);
    const relationSection = document.createElement('section');
    const relationHeading = document.createElement('h3');
    relationHeading.textContent = data.labels.detailsRelationships ?? '关联关系';
    relationSection.append(relationHeading);
    if (relations.length) {
      const list = document.createElement('ul');
      list.className = 'graph-node-dialog-relations';
      for (const edge of relations) {
        const from = sourceById.get(edge.from);
        const to = sourceById.get(edge.to);
        const item = document.createElement('li');
        const fromLabel = document.createElement('span');
        fromLabel.className = 'relation-node';
        fromLabel.textContent = from?.label ?? edge.from;
        const relation = document.createElement('span');
        relation.className = 'relation-kind';
        relation.textContent = edge.label ?? edge.kind;
        const toLabel = document.createElement('span');
        toLabel.className = 'relation-node';
        toLabel.textContent = to?.label ?? edge.to;
        item.append(fromLabel, relation, toLabel);
        list.append(item);
      }
      relationSection.append(list);
    } else {
      const empty = document.createElement('p');
      empty.textContent = data.labels.detailsNoRelationships ?? '暂无关联关系';
      relationSection.append(empty);
    }
    nodeDialogContent.append(relationSection);
    nodeDialogContent.scrollTop = 0;
    if (typeof nodeDialog.showModal === 'function') nodeDialog.showModal();
    else nodeDialog.setAttribute('open', '');
    nodeDialogClose?.focus({ preventScroll: true });
  }

  function closeNodeDetails() {
    if (!nodeDialog) return;
    if (typeof nodeDialog.close === 'function' && nodeDialog.open) nodeDialog.close();
    else nodeDialog.removeAttribute('open');
    restoreNodeDialogFocus();
  }

  function restoreNodeDialogFocus() {
    if (nodeDialog?.open) return;
    if (nodeDialogOpener?.isConnected) nodeDialogOpener.focus({ preventScroll: true });
    nodeDialogOpener = null;
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !nodeDialog?.open) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeNodeDetails();
  }, true);
  nodeDialog?.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const controls = [...nodeDialog.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')]
      .filter((element) => element.getClientRects().length && !element.closest('[hidden],[inert]'));
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus({ preventScroll: true });
    }
  });
  nodeDialogClose?.addEventListener('click', closeNodeDetails);
  nodeDialog?.addEventListener('click', (event) => {
    if (event.target === nodeDialog) closeNodeDetails();
  });
  nodeDialog?.addEventListener('close', restoreNodeDialogFocus);

  function notifySelection(id) {
    try { hooks.onSelect?.(id); } catch { /* A review host must not break read-only navigation. */ }
    try { graphView.dispatchEvent(new CustomEvent('continuity:graph-select', { detail: { nodeId: id } })); } catch { /* CustomEvent can be unavailable in minimal viewers. */ }
  }

  function cloneInspectorCard(original) {
    const copy = original.cloneNode(true);
    copy.removeAttribute('id');
    copy.hidden = false;
    const idMap = new Map();
    for (const element of copy.querySelectorAll('[id]')) {
      const oldId = element.id;
      if (idMap.has(oldId)) {
        element.id = idMap.get(oldId);
        continue;
      }
      let nextId = 'inspector-' + oldId;
      let suffix = 1;
      while (document.getElementById(nextId)) nextId = 'inspector-' + oldId + '--' + (suffix++);
      idMap.set(oldId, nextId);
      element.id = nextId;
    }
    const remapTokens = (value) => value.split(/\s+/).map((token) => idMap.get(token) ?? token).join(' ');
    for (const element of [copy, ...copy.querySelectorAll('*')]) {
      for (const attribute of ['for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant', 'headers']) {
        if (element.hasAttribute(attribute)) element.setAttribute(attribute, remapTokens(element.getAttribute(attribute)));
      }
      for (const attribute of ['href', 'xlink:href']) {
        if (!element.hasAttribute(attribute)) continue;
        const value = element.getAttribute(attribute);
        if (!value.startsWith('#')) continue;
        const target = idMap.get(value.slice(1));
        if (target) element.setAttribute(attribute, '#' + target);
      }
    }
    for (const detail of copy.querySelectorAll('details')) detail.open = true;
    return copy;
  }

  function select(id, center = false, focusInspector = false) {
    if (!sourceById.has(id)) return;
    miniDirty = true;
    selectedId = id;
    if (focusRoot && focusRoot !== id) { focusRoot = id; updateFocusSet(); } else updateFocusButton();
    for (const [nodeId, element] of nodeElements) {
      element.querySelector('.graph-node-select').setAttribute('aria-pressed', String(nodeId === id));
    }
    const anchor = sourceById.get(id).anchor;
    const original = anchor ? document.getElementById(anchor) : null;
    const inspector = document.querySelector('#graph-inspector-content');
    if (hasInspector && inspector && original) {
      const copy = cloneInspectorCard(original);
      inspector.replaceChildren(copy);
      if (focusInspector) {
        copy.tabIndex = -1;
        copy.focus({ preventScroll: true });
      }
    }
    if (center) {
      if (revealPaths([id])) rebuild();
      // View-only groups may also contain a navigation target.
      if (groupHiddenIds.has(id)) {
        for (const group of groups) if (group.collapsed) group.collapsed = false;
        rebuild();
      }
      const node = positions.get(id);
      scale = Math.max(scale, .8);
      // Wide gutters can make a centred root push its whole branch column off
      // screen. Only move the canvas when the target is not already visible;
      // a visible node keeps the current overview and the user's pan.
      const left = node.x * scale + tx;
      const top = node.y * scale + ty;
      const visible = left >= 8 && top >= 76
        && left + node.width * scale <= width - 8
        && top + node.height * scale <= height - 62;
      if (!visible) {
        tx = width / 2 - (node.x + node.width / 2) * scale;
        ty = height / 2 - (node.y + node.height / 2) * scale;
        manualView = true;
      }
    }
    // Review mode uses ?claim=... while the graph keeps #node-...; never drop
    // the query when the graph updates its hash.
    try {
      if (updateUrl) {
      const nextUrl = location.pathname + location.search + (anchor ? '#' + anchor : '');
      history.replaceState(null, '', nextUrl);
      }
    } catch { /* Embedded/file viewers can restrict history. */ }
    notifySelection(id);
    requestDraw();
  }

  function revealPaths(ids) {
    let changed = false;
    for (const id of ids) {
      for (let parent = hierarchy.get(id)?.parentId; parent != null; parent = hierarchy.get(parent)?.parentId) {
        if (collapsed.delete(parent)) changed = true;
      }
    }
    return changed;
  }

  function rebuild() {
    buildAdjacency();
    layout = buildLayout(data.nodes, data.edges, [...collapsed]);
    for (const node of layout.nodes) {
      const custom = customPositions.get(node.id);
      if (custom) { node.x = Math.max(0, custom.x); node.y = Math.max(0, custom.y); }
    }
    positions = new Map(layout.nodes.map((node) => [node.id, node]));
    updateBounds();
    groupHiddenIds = computeGroupHidden();
    world.replaceChildren();
    nodeElements.clear();
    renderGroups();
    for (const node of layout.nodes) {
      if (groupHiddenIds.has(node.id)) continue;
      const source = sourceById.get(node.id);
      const wrapper = document.createElement('div');
      wrapper.className = 'graph-node';
      wrapper.dataset.nodeId = node.id;
      wrapper.style.left = node.x + 'px';
      wrapper.style.top = node.y + 'px';
      wrapper.style.setProperty('--node-color', palette[source.kind] || palette.unknown);
      const selectButton = button('', 'graph-node-select');
      selectButton.setAttribute('aria-pressed', String(selectedId === node.id));
      selectButton.setAttribute('aria-label', source.label + ' · ' + source.kindLabel + ' · ' + source.statusLabel
        + (source.roadmapLabel ? ' · ' + source.roadmapLabel : '')
        + (source.progressLine ? ' · ' + source.progressLine : '')
        + (source.progressNext ? ' · ' + source.progressNext : '')
        + (source.progressDetail ? ' · ' + source.progressDetail : ''));
      const type = document.createElement('span');
      type.className = 'graph-node-type';
      type.textContent = source.kindLabel;
      if (source.delivery) {
        // Saved delivery-stage chip on the type row: no extra line, the card
        // stays 224x128. The full name and basis are in the detail dialog.
        const delivery = document.createElement('span');
        delivery.className = 'graph-node-delivery';
        delivery.dataset.delivery = source.delivery.status;
        delivery.dataset.needsReview = String(source.delivery.needsReview === true);
        delivery.setAttribute('data-testid', 'graph-node-delivery');
        delivery.textContent = source.delivery.badgeText ?? source.delivery.text;
        type.append(delivery);
      }
      const label = document.createElement('span');
      label.className = 'graph-node-label';
      label.textContent = source.label;
      const meta = document.createElement('span');
      meta.className = 'graph-node-meta';
      const badge = document.createElement('span');
      badge.className = 'graph-node-status';
      badge.dataset.status = source.status;
      badge.textContent = source.statusLabel;
      meta.append(badge);
      if (source.roadmapLabel) {
        const roadmap = document.createElement('span');
        roadmap.className = 'graph-node-roadmap';
        roadmap.textContent = source.roadmapLabel;
        meta.append(roadmap);
      }
      selectButton.append(type, label, meta);
      if (source.progressLine || source.progressNext) {
        // One saved summary line plus one next-action/status line. Long text is
        // shown in the accessible detail dialog without expanding the card.
        if (source.progressLine) {
          const progress = document.createElement('span');
          progress.className = 'graph-node-progress';
          progress.textContent = source.progressLine;
          selectButton.append(progress);
        }
        if (source.progressNext) {
          const next = document.createElement('span');
          next.className = 'graph-node-progress graph-node-progress-next';
          next.textContent = source.progressNext;
          selectButton.append(next);
        }
      }
      selectButton.addEventListener('click', (event) => {
        // In arrange mode Shift+click toggles group membership; a plain click
        // still selects and clears any previous multi-selection.
        if (arrangeMode) {
          if (event.shiftKey) { event.preventDefault(); return; }
          multiSelected.clear(); updateMultiUI();
        }
        // Pointer gestures prevent the browser's focus/selection defaults. A real
        // click still focuses this node; a drag's trailing click is intercepted.
        selectButton.focus({ preventScroll: true });
        select(node.id);
      });
      selectButton.addEventListener('focus', () => {
        const left = node.x * scale + tx;
        const top = node.y * scale + ty;
        if (left < 8 || top < 76 || left + node.width * scale > width - 8 || top + node.height * scale > height - 62) {
          tx = width / 2 - (node.x + node.width / 2) * scale;
          ty = height / 2 - (node.y + node.height / 2) * scale;
          manualView = true;
          draw();
        }
      });
      selectButton.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && event.altKey) { event.preventDefault(); openNodeDetails(node.id, selectButton); }
      });
      const detailsButton = button(data.labels.detailsButton ?? '详情', 'graph-node-details');
      detailsButton.setAttribute('aria-label', `${data.labels.detailsButton ?? '详情'}：${source.label}`);
      detailsButton.setAttribute('aria-haspopup', 'dialog');
      detailsButton.setAttribute('aria-controls', 'graph-node-dialog');
      detailsButton.setAttribute('data-testid', 'graph-node-details');
      detailsButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openNodeDetails(node.id, detailsButton);
      });
      wrapper.append(selectButton, detailsButton);
      if (node.collapsed && descendants.get(node.id)) {
        const folded = document.createElement('span');
        folded.className = 'graph-node-folded';
        folded.textContent = descendants.get(node.id) + ' ' + (ui.folded ?? '个节点已收起');
        wrapper.append(folded);
      }
      if (node.childCount) {
        const toggle = button(node.collapsed ? '+' : '−', 'graph-branch-toggle');
        toggle.setAttribute('aria-label', (node.collapsed ? ui.expand : ui.collapse) + ': ' + source.label);
        toggle.setAttribute('aria-expanded', String(!node.collapsed));
        toggle.addEventListener('click', () => {
          if (collapsed.has(node.id)) collapsed.delete(node.id); else collapsed.add(node.id);
          rebuild();
          if (!positions.has(selectedId)) select(node.id);
          fit();
          nodeElements.get(node.id)?.querySelector('.graph-branch-toggle')?.focus({ preventScroll: true });
        });
        wrapper.append(toggle);
      }
      world.append(wrapper);
      nodeElements.set(node.id, wrapper);
    }
    document.querySelector('#graph-layout-warning').hidden = !layout.warnings.length;
    updateArrangeUI();
    updateMultiUI();
    updateFocusButton();
    if (focusRoot) updateFocusSet(); else updateMatches();
  }

  function updateMatches() {
    let visibleMatches = 0;
    for (const [id, element] of nodeElements) {
      const inFilter = !filtering || matches.has(id);
      const inFocus = !focusSet || focusSet.has(id);
      element.classList.toggle('is-dim', !inFilter || !inFocus);
      if (matches.has(id)) visibleMatches++;
    }
    const visibleCount = layout.nodes.length - groupHiddenIds.size;
    const live = document.querySelector('#graph-live');
    if (live) {
      live.textContent = (filtering ? matches.size + ' ' + ui.matches : visibleCount + ' ' + ui.nodes)
        + (layout.hiddenCount ? ' · ' + layout.hiddenCount + ' ' + ui.folded : '')
        + (groupHiddenIds.size ? ' · ' + groupHiddenIds.size + ' ' + ui.groupHidden : '')
        + (focusSet ? ' · ' + ui.focus + ' ' + focusSet.size + ' ' + ui.focusCount : '');
    }
    const message = document.querySelector('#graph-message');
    message.hidden = Boolean((visibleCount || groupHiddenIds.size) && (!filtering || visibleMatches || matches.size));
    message.textContent = data.nodes.length ? ui.noMatches : ui.noNodes;
    requestDraw();
  }

  function requestDraw() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = undefined; draw(); });
  }

  // Small maps keep the host's preferred scale. Dense outlines fit the actual
  // workspace, including the toolbar, instead of inheriting a clipped 1:1 view.
  const fitFloor = Number.isFinite(hooks.fitFloor) ? Math.min(1, Math.max(.05, hooks.fitFloor)) : .56;

  function fit({ overview = false } = {}) {
    if (!width || !height) return;
    const topSpace = (document.querySelector('.graph-toolbox')?.offsetHeight || 52) + 30;
    const bottomSpace = 112;
    const availableHeight = Math.max(100, height - topSpace - bottomSpace);
    const fittedScale = () => layout.width ? Math.min(1, (width - 32) / layout.width, availableHeight / layout.height) : 1;
    // A thousand miniature cards are not a readable overview. Fold display
    // branches only on this explicit command; zoom/pan never changes disclosure.
    if (overview && !filtering && layout.nodes.length > 18 && fittedScale() < .48) {
      collapseOverview();
      rebuild();
    }
    const floor = data.nodes.length > 18 ? (overview || collapsed.size ? .48 : fitFloor) : overview ? .05 : fitFloor;
    const fitted = fittedScale();
    scale = Math.max(floor, fitted);
    const contentWidth = layout.width * scale;
    tx = contentWidth <= width - 16 ? (width - contentWidth) / 2 : 16;
    ty = topSpace + Math.max(0, (availableHeight - layout.height * scale) / 2);
    // When the readable floor makes the graph larger than the viewport, a
    // top-left fit would leave the selected root below the fold. Center on the
    // selected node instead; panning and the minimap cover the rest.
    let focus = positions?.get(selectedId);
    for (let id = hierarchy.get(selectedId)?.parentId; !focus && id != null; id = hierarchy.get(id)?.parentId) focus = positions.get(id);
    if (fitted < floor && focus) {
      // Put the focus near the left edge so its outgoing branches, which run
      // left-to-right, get the remaining width.
      tx = 64 - focus.x * scale;
      ty = height / 2 - (focus.y + focus.height / 2) * scale;
    }
    manualView = false;
    // Background tabs may suspend animation frames. Keep their first fit valid.
    draw();
    requestDraw();
  }

  function zoom(next, x = width / 2, y = height / 2) {
    const previous = scale;
    scale = Math.max(.05, Math.min(2.5, next));
    tx = x - (x - tx) * scale / previous;
    ty = y - (y - ty) * scale / previous;
    manualView = true;
    requestDraw();
  }

  function draw() {
    if (!width || !height || graphView.hidden) return;
    const dpr = window.devicePixelRatio || 1;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * tx, dpr * ty);
    const showCross = document.querySelector('#graph-cross').checked;
    const detail = scale < .48 ? 'overview' : scale < .9 ? 'compact' : 'full';
    if (viewport.dataset.detail !== detail) viewport.dataset.detail = detail;
    const visible = { left: -tx / scale, top: -ty / scale, right: (width - tx) / scale, bottom: (height - ty) / scale };
    drawnEdges = 0;
    culledEdges = 0;
    const labelledKinds = new Set();
    const paintedRouteSegments = new Set();
    const routeGroups = new Map();
    for (const child of layout.nodes) {
      if (!child.shelf || child.parentId == null) continue;
      const group = routeGroups.get(child.parentId) || { children: [] };
      group.children.push(child);
      routeGroups.set(child.parentId, group);
    }
    const drawEdge = (edge, emphasize = true) => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return;
      const forward = to.x > from.x;
      const x1 = from.x + (forward ? from.width : 0);
      const x2 = to.x + (forward ? 0 : to.width);
      const y1 = from.y + from.height / 2;
      const y2 = to.y + to.height / 2;
      const bend = Math.max(35, Math.abs(x2 - x1) / 2);
      const c1 = x1 + (forward ? bend : -bend);
      const c2 = x2 + (forward ? -bend : bend);
      const child = to.parentId === from.id ? to : from.parentId === to.id ? from : null;
      const shelf = child?.shelf && !customPositions.has(from.id) && !customPositions.has(to.id) ? child.shelf : null;
      const parent = child === to ? from : to;
      const route = shelf ? [[parent.x + parent.width, parent.y + parent.height / 2],
        [shelf.laneX, parent.y + parent.height / 2], [shelf.laneX, shelf.laneY],
        [child.x + child.width / 2, shelf.laneY], [child.x + child.width / 2, child.y]] : null;
      if (route && child === from) route.reverse();
      const routeGroup = shelf ? routeGroups.get(parent.id) : null;
      const xs = route ? route.map((point) => point[0]) : [x1, c1, c2, x2];
      const ys = route ? route.map((point) => point[1]) : [y1, y2];
      const margin = 24 / scale;
      if (Math.max(...xs) < visible.left - margin || Math.min(...xs) > visible.right + margin
        || Math.max(...ys) < visible.top - margin || Math.min(...ys) > visible.bottom + margin) {
        culledEdges++;
        return;
      }
      drawnEdges++;
      const trace = (layer) => {
        context.beginPath();
        if (route) {
          for (let index = 1; index < route.length; index++) {
            const start = route[index - 1], end = route[index];
            const horizontal = start[1] === end[1];
            const axis = horizontal ? 0 : 1;
            const low = Math.min(start[axis], end[axis]), high = Math.max(start[axis], end[axis]);
            const candidates = [start[axis], end[axis], ...(routeGroup?.children || []).flatMap((item) => horizontal
              ? [item.x + item.width / 2, item.shelf.laneX]
              : [item.y, item.shelf.laneY, parent.y + parent.height / 2])];
            const stops = [...new Set(candidates.filter((value) => value >= low && value <= high))]
              .sort((a, b) => start[axis] <= end[axis] ? a - b : b - a);
            for (let part = 1; part < stops.length; part++) {
              const a = [...start], b = [...start];
              a[axis] = stops[part - 1];
              b[axis] = stops[part];
              const key = layer + ':' + (horizontal ? 'h:' + a[1] : 'v:' + a[0]) + ':'
                + Math.min(a[axis], b[axis]) + ':' + Math.max(a[axis], b[axis]);
              if (paintedRouteSegments.has(key)) continue;
              paintedRouteSegments.add(key);
              context.moveTo(...a);
              context.lineTo(...b);
            }
          }
        } else {
          context.moveTo(x1, y1);
          context.bezierCurveTo(c1, y1, c2, y2, x2, y2);
        }
      };
      const connected = emphasize && (edge.from === selectedId || edge.to === selectedId);
      const strokeWidth = connected ? (data.nodes.length > 40 ? 1.6 : 3.1) : 1.4;
      const outOfFocus = Boolean(focusSet && (!focusSet.has(edge.from) || !focusSet.has(edge.to)));
      context.globalAlpha = (filtering && (!matches.has(edge.from) || !matches.has(edge.to))) || outOfFocus ? .2 : 1;
      context.setLineDash(edge.hierarchical ? [] : [5 / scale, 5 / scale]);
      if (connected) {
        // A narrow background-tone casing keeps the highlighted relationship
        // legible where unrelated lines cross it. Same dash pattern, no glow.
        context.strokeStyle = '#f1f5f9';
        context.lineWidth = (strokeWidth + (data.nodes.length > 40 ? .8 : 1.6)) / scale;
        trace(connected ? 'selected-casing' : 'casing');
        context.stroke();
      }
      // The selected relationships reuse the selection blue so the highlight
      // reads as part of the same selection, not a separate decoration.
      context.strokeStyle = connected ? (data.nodes.length > 40 ? '#58728d' : '#2949a7') : edge.hierarchical ? '#8ca2bc' : '#a2a3b5';
      context.fillStyle = context.strokeStyle;
      context.lineWidth = strokeWidth / scale;
      trace(connected ? 'selected' : edge.hierarchical ? 'hierarchy' : 'cross');
      context.stroke();
      context.setLineDash([]);
      const arrowLength = (connected ? 9 : 6) / scale;
      const arrowHalf = (connected ? 4.5 : 3) / scale;
      const tip = route?.at(-1) ?? [x2, y2];
      const previous = route?.at(-2) ?? [c2, y2];
      const angle = Math.atan2(tip[1] - previous[1], tip[0] - previous[0]);
      context.beginPath();
      context.moveTo(...tip);
      context.lineTo(tip[0] - Math.cos(angle) * arrowLength - Math.sin(angle) * arrowHalf, tip[1] - Math.sin(angle) * arrowLength + Math.cos(angle) * arrowHalf);
      context.lineTo(tip[0] - Math.cos(angle) * arrowLength + Math.sin(angle) * arrowHalf, tip[1] - Math.sin(angle) * arrowLength - Math.cos(angle) * arrowHalf);
      context.fill();
      const label = edge.label ?? edge.kind;
      const labelX = route ? (route[2][0] + route[3][0]) / 2 : .125 * x1 + .375 * c1 + .375 * c2 + .125 * x2;
      const labelY = route ? (route[2][1] + route[3][1]) / 2 : (y1 + y2) / 2;
      // Labels would collide in a dense overview. Keep them for the selected
      // relationships, and show every label once the reader zooms in.
      if (scale < .48 || (!connected && (data.nodes.length > 40 || scale < .72))) return;
      if (labelX < visible.left || labelX > visible.right || labelY < visible.top || labelY > visible.bottom) return;
      if (data.nodes.length > 40 && labelledKinds.has(edge.kind)) return;
      labelledKinds.add(edge.kind);
      context.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
      const labelWidth = context.measureText(label).width;
      context.fillStyle = '#f1f5f9';
      context.fillRect(labelX - labelWidth / 2 - 4, labelY - 9, labelWidth + 8, 18);
      context.fillStyle = connected ? '#365282' : '#5b6c80';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(label, labelX, labelY);
    };
    // Unrelated lines first; the selected node's relationships are painted last
    // so their stronger stroke, arrows and labels stay above unrelated lines.
    const connectedEdges = [];
    const selectedDegree = layout.edges.reduce((count, edge) => count + (edge.from === selectedId || edge.to === selectedId ? 1 : 0), 0);
    for (const edge of layout.edges) {
      if (!edge.hierarchical && !showCross) continue;
      if (groupHiddenIds.has(edge.from) || groupHiddenIds.has(edge.to)) continue;
      if (edge.from === selectedId || edge.to === selectedId) connectedEdges.push(edge);
      else drawEdge(edge);
    }
    const emphasizeConnections = data.nodes.length <= 40 || selectedDegree <= 4;
    for (const edge of connectedEdges) drawEdge(edge, emphasizeConnections);
    context.globalAlpha = 1;
    world.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    viewport.style.backgroundPosition = tx + 'px ' + ty + 'px';
    const gridSize = Math.max(12, 20 * scale);
    viewport.style.backgroundSize = gridSize + 'px ' + gridSize + 'px';
    document.querySelector('#graph-zoom').textContent = Math.round(scale * 100) + '%';
    drawMinimap(dpr);
  }

  function drawMinimap(dpr) {
    const w = minimap.clientWidth;
    const h = minimap.clientHeight;
    const pixelWidth = Math.round(w * dpr), pixelHeight = Math.round(h * dpr);
    if (minimap.width !== pixelWidth || minimap.height !== pixelHeight) {
      minimap.width = miniCache.width = pixelWidth;
      minimap.height = miniCache.height = pixelHeight;
      miniDirty = true;
    }
    miniContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    miniContext.clearRect(0, 0, w, h);
    miniProjection = null;
    if (!layout.width) return;
    const ratio = Math.min((w - 16) / layout.width, (h - 16) / layout.height);
    const ox = (w - layout.width * ratio) / 2;
    const oy = (h - layout.height * ratio) / 2;
    miniProjection = { ratio, ox, oy };
    if (miniDirty && miniCacheContext) {
      miniCacheContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      miniCacheContext.clearRect(0, 0, w, h);
      for (const node of positions.values()) {
        if (groupHiddenIds.has(node.id)) continue;
        const source = sourceById.get(node.id);
        if (!source) continue;
        miniCacheContext.fillStyle = palette[source.kind] || palette.unknown;
        miniCacheContext.globalAlpha = node.id === selectedId ? 1 : .4;
        miniCacheContext.fillRect(ox + node.x * ratio, oy + node.y * ratio, node.width * ratio, node.height * ratio);
      }
      miniDirty = false;
      minimapPaints++;
    }
    if (miniCacheContext) miniContext.drawImage(miniCache, 0, 0, w, h);
    miniContext.globalAlpha = 1;
    miniContext.strokeStyle = '#2949a7';
    miniContext.lineWidth = 1.5;
    miniContext.strokeRect(ox - tx / scale * ratio, oy - ty / scale * ratio, width / scale * ratio, height / scale * ratio);
  }

  function resize() {
    if (graphView.hidden) return;
    fitStageHeight();
    const nextWidth = viewport.clientWidth, nextHeight = viewport.clientHeight;
    // Dock disclosure changes canvas height only. Preserve even an untouched
    // automatic-fit view, rather than silently fitting again on every toggle.
    if (graphView.querySelector('.graph-stage') && width === nextWidth && height && height !== nextHeight) manualView = true;
    width = nextWidth;
    height = nextHeight;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    if (!manualView) fit(); else requestDraw();
  }

  const pointers = new Map();
  const dragThreshold = 5; // CSS pixels, independent of graph zoom.
  const gestureClass = 'continuity-graph-gesture';
  let dragging = false;
  let suppressedClick = null;

  function clearSelection() {
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed) selection.removeAllRanges();
  }

  function beginDrag() {
    if (dragging) return;
    dragging = true;
    viewport.classList.add('is-panning');
    viewport.focus({ preventScroll: true });
    clearSelection();
    // Capture only after the threshold. Capturing the viewport on a node's
    // pointerdown would retarget an ordinary node click away from its button.
    for (const id of pointers.keys()) {
      try { viewport.setPointerCapture(id); } catch { /* A cancelled pointer is already gone. */ }
    }
  }

  function endPointer(event, cancelled = false) {
    if (!pointers.has(event.pointerId)) return;
    if (dragging || cancelled) {
      suppressedClick = { pointerId: event.pointerId, until: performance.now() + 800 };
    }
    pointers.delete(event.pointerId);
    if (!pointers.size) {
      dragging = false;
      viewport.classList.remove('is-panning');
      document.documentElement.classList.remove(gestureClass);
    }
    try {
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    } catch { /* Pointer cancellation may already have released capture. */ }
  }

  function snapToGrid(value) {
    return Math.max(0, Math.round(value / GRID) * GRID);
  }

  function finishNodeDrag(event, cancelled = false) {
    if (!nodeDrag || event.pointerId !== nodeDrag.pointerId) return;
    const drag = nodeDrag;
    nodeDrag = null;
    if (drag.moved) {
      suppressedClick = { pointerId: event.pointerId, until: performance.now() + 800 };
      for (const id of drag.ids) {
        const point = positions.get(id);
        if (point) customPositions.set(id, { x: point.x, y: point.y });
      }
      const membershipChanged = updateMembership(drag.ids);
      persistOrganizeState();
      if (membershipChanged) rebuild(); else { updateBounds(); positionGroupElements(); }
      manualView = true;
      requestDraw();
      updateArrangeUI();
    }
    try {
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    } catch { /* A cancelled pointer is already gone. */ }
    if (!pointers.size && !groupDrag) document.documentElement.classList.remove(gestureClass);
  }

  function finishGroupDrag(event, cancelled = false) {
    if (!groupDrag || event.pointerId !== groupDrag.pointerId) return;
    const drag = groupDrag;
    groupDrag = null;
    if (drag.moved) {
      suppressedClick = { pointerId: event.pointerId, until: performance.now() + 800 };
      for (const id of drag.ids) {
        const point = positions.get(id);
        if (point) customPositions.set(id, { x: point.x, y: point.y });
      }
      persistOrganizeState();
      updateBounds();
      positionGroupElements();
      manualView = true;
      requestDraw();
    }
    try {
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    } catch { /* A cancelled pointer is already gone. */ }
    if (!pointers.size && !nodeDrag) document.documentElement.classList.remove(gestureClass);
  }

  function endGraphDrag(event, cancelled = false) {
    if (nodeDrag && event.pointerId === nodeDrag.pointerId) { finishNodeDrag(event, cancelled); return true; }
    if (groupDrag && event.pointerId === groupDrag.pointerId) { finishGroupDrag(event, cancelled); return true; }
    return false;
  }

  function startNodeDrag(event, id) {
    if (event.shiftKey) { event.preventDefault(); toggleMulti(id); return true; }
    const ids = multiSelected.has(id) && multiSelected.size > 1 ? [...multiSelected] : [id];
    const origins = new Map();
    for (const nodeId of ids) {
      const point = positions.get(nodeId);
      if (point) origins.set(nodeId, { x: point.x, y: point.y });
    }
    if (!origins.size) return true;
    event.preventDefault();
    if (!multiSelected.has(id)) { multiSelected.clear(); updateMultiUI(); }
    nodeDrag = {
      pointerId: event.pointerId, ids: [...origins.keys()], origins,
      startX: event.clientX, startY: event.clientY, moved: false,
    };
    document.documentElement.classList.add(gestureClass);
    viewport.focus({ preventScroll: true });
    return true;
  }

  function startGroupDrag(event, groupId) {
    const group = groups.find((item) => item.id === groupId);
    if (!group || group.collapsed) return true;
    const origins = new Map();
    for (const id of group.nodeIds) {
      const point = positions.get(id);
      if (point) origins.set(id, { x: point.x, y: point.y });
    }
    if (!origins.size) return true;
    event.preventDefault();
    groupDrag = {
      pointerId: event.pointerId, groupId, ids: [...origins.keys()], origins,
      startX: event.clientX, startY: event.clientY, moved: false,
    };
    document.documentElement.classList.add(gestureClass);
    viewport.focus({ preventScroll: true });
    return true;
  }

  function moveNodeDrag(event) {
    if (event.pointerType === 'mouse' && !(event.buttons & 1)) { finishNodeDrag(event, true); return; }
    event.preventDefault();
    if (!nodeDrag.moved) {
      if (Math.hypot(event.clientX - nodeDrag.startX, event.clientY - nodeDrag.startY) < dragThreshold) return;
      nodeDrag.moved = true;
      try { viewport.setPointerCapture(event.pointerId); } catch { /* A cancelled pointer is already gone. */ }
    }
    const dx = (event.clientX - nodeDrag.startX) / scale;
    const dy = (event.clientY - nodeDrag.startY) / scale;
    for (const id of nodeDrag.ids) {
      const point = positions.get(id);
      const origin = nodeDrag.origins.get(id);
      if (!point || !origin) continue;
      point.x = snapToGrid(origin.x + dx);
      point.y = snapToGrid(origin.y + dy);
      const element = nodeElements.get(id);
      if (element) { element.style.left = point.x + 'px'; element.style.top = point.y + 'px'; }
    }
    updateBounds();
    positionGroupElements();
    requestDraw();
  }

  function moveGroupDrag(event) {
    if (event.pointerType === 'mouse' && !(event.buttons & 1)) { finishGroupDrag(event, true); return; }
    event.preventDefault();
    if (!groupDrag.moved) {
      if (Math.hypot(event.clientX - groupDrag.startX, event.clientY - groupDrag.startY) < dragThreshold) return;
      groupDrag.moved = true;
      try { viewport.setPointerCapture(event.pointerId); } catch { /* A cancelled pointer is already gone. */ }
    }
    const dx = (event.clientX - groupDrag.startX) / scale;
    const dy = (event.clientY - groupDrag.startY) / scale;
    for (const id of groupDrag.ids) {
      const point = positions.get(id);
      const origin = groupDrag.origins.get(id);
      if (!point || !origin) continue;
      point.x = Math.max(0, origin.x + dx);
      point.y = Math.max(0, origin.y + dy);
      const element = nodeElements.get(id);
      if (element) { element.style.left = point.x + 'px'; element.style.top = point.y + 'px'; }
    }
    updateBounds();
    positionGroupElements();
    requestDraw();
  }

  function cancelGesture() {
    for (const id of [...pointers.keys()]) endPointer({ pointerId: id }, true);
    if (nodeDrag) finishNodeDrag({ pointerId: nodeDrag.pointerId }, true);
    if (groupDrag) finishGroupDrag({ pointerId: groupDrag.pointerId }, true);
  }

  function updateFullscreenButton() {
    const label = fullscreenActive ? ui.exitFullscreen : ui.fullscreen;
    fullscreenButton.setAttribute('aria-pressed', String(fullscreenActive));
    fullscreenButton.setAttribute('aria-label', label);
    fullscreenButton.title = label;
    fullscreenButton.querySelector('span').textContent = label;
  }

  async function waitForFullscreen(request) {
    // Some embedded browsers expose the API but never settle its promise.
    // The window-fill fallback and exit button must still become available.
    let timeout;
    try {
      await Promise.race([request, new Promise((resolve) => { timeout = setTimeout(resolve, 1200); })]);
    } finally { clearTimeout(timeout); }
  }

  function leaveFullscreen() {
    if (!fullscreenActive) return;
    fullscreenActive = false;
    fullscreenPending = false;
    fullscreenButton.disabled = false;
    fullscreenSession++;
    cancelGesture();
    fullscreenHost.classList.remove('continuity-fullscreen-host');
    document.documentElement.classList.remove('continuity-graph-fullscreen');
    for (const [element, inert] of fullscreenInert) element.inert = inert;
    fullscreenInert = [];
    updateFullscreenButton();
    fullscreenStatus.removeAttribute('data-mode');
    fullscreenStatus.textContent = ui.fullscreenLeft;
    // Keep the latest pan/zoom, not a stale entry snapshot. Resizing must not fit.
    manualView = true;
    resize();
    const origin = fullscreenOrigin;
    fullscreenOrigin = undefined;
    if (origin?.focus?.isConnected) origin.focus.focus({ preventScroll: true });
    if (origin) window.scrollTo(origin.x, origin.y);
  }

  async function toggleFullscreen() {
    if (fullscreenActive) {
      if (fullscreenPending) return;
      fullscreenPending = true;
      fullscreenButton.disabled = true;
      if (document.fullscreenElement === fullscreenHost) {
        try { await waitForFullscreen(document.exitFullscreen()); } catch { /* Restore a retryable exit below. */ }
        if (document.fullscreenElement === fullscreenHost) {
          fullscreenPending = false;
          fullscreenButton.disabled = false;
          fullscreenStatus.textContent = ui.fullscreenExitFailed;
          return;
        }
      }
      leaveFullscreen();
      return;
    }
    // Do not take over an unrelated fullscreen element owned by another tool.
    if (document.fullscreenElement) return;
    cancelGesture();
    fullscreenOrigin = { focus: document.activeElement, x: window.scrollX, y: window.scrollY };
    fullscreenActive = true;
    fullscreenPending = true;
    fullscreenButton.disabled = true;
    const session = ++fullscreenSession;
    manualView = true;
    fullscreenHost.classList.add('continuity-fullscreen-host');
    document.documentElement.classList.add('continuity-graph-fullscreen');
    // Hidden page content must not receive Tab focus in window-fill fallback.
    fullscreenInert = [];
    for (let element = fullscreenHost; element.parentElement && element !== document.body; element = element.parentElement) {
      for (const sibling of element.parentElement.children) {
        if (sibling === element || !(sibling instanceof HTMLElement) || /^(SCRIPT|STYLE|LINK)$/.test(sibling.tagName)) continue;
        fullscreenInert.push([sibling, sibling.inert]);
        sibling.inert = true;
      }
    }
    updateFullscreenButton();
    resize();
    fullscreenButton.focus({ preventScroll: true });
    try {
      if (typeof fullscreenHost.requestFullscreen === 'function' && document.fullscreenEnabled !== false) {
        const request = fullscreenHost.requestFullscreen();
        // If a timed-out request succeeds after the user already left, close
        // that stale native fullscreen rather than surprising them later.
        Promise.resolve(request).then(() => {
          if (session !== fullscreenSession && !fullscreenActive && document.fullscreenElement === fullscreenHost) {
            try { document.exitFullscreen().catch(() => {}); } catch { /* Browser exit control remains. */ }
          }
        }, () => {});
        await waitForFullscreen(request);
      }
    } catch { /* Permissions/embedded viewers still get a reversible window-fill view. */ }
    if (session !== fullscreenSession) {
      if (!fullscreenActive && document.fullscreenElement === fullscreenHost) {
        try { await document.exitFullscreen(); } catch { /* Browser exit controls remain available. */ }
      }
      return;
    }
    fullscreenPending = false;
    fullscreenButton.disabled = false;
    if (document.fullscreenElement !== fullscreenHost) fullscreenStatus.dataset.mode = 'window';
    fullscreenStatus.textContent = document.fullscreenElement === fullscreenHost ? ui.fullscreenEntered : ui.fullscreenFallback;
    resize();
  }

  if (fullscreenButton) {
    fullscreenButton.hidden = false;
    fullscreenButton.setAttribute('aria-controls', fullscreenHost.id);
    fullscreenButton.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', () => {
      if (!fullscreenActive) return;
      if (document.fullscreenElement === fullscreenHost) {
        fullscreenStatus.removeAttribute('data-mode');
        fullscreenStatus.textContent = ui.fullscreenEntered;
        resize();
      }
      else if (!fullscreenPending) leaveFullscreen();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !fullscreenActive) return;
      // Escape exits the canvas, not the review editor or its draft underneath.
      event.preventDefault();
      event.stopImmediatePropagation();
      void toggleFullscreen();
    }, true);
    window.addEventListener('pagehide', () => {
      const native = document.fullscreenElement === fullscreenHost;
      leaveFullscreen();
      if (native) { try { document.exitFullscreen().catch(() => {}); } catch { /* Leaving document. */ } }
    });
  }

  document.addEventListener('pointerdown', () => { suppressedClick = null; }, true);
  document.addEventListener('click', (event) => {
    // Block only the click produced by the completed drag, even if its release
    // landed on a control outside the canvas. Keyboard and later clicks work.
    if (!suppressedClick || event.detail === 0) return;
    const pending = suppressedClick;
    suppressedClick = null;
    if (performance.now() > pending.until) return;
    if (event.pointerId !== undefined && event.pointerId !== pending.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener('selectstart', (event) => {
    if (pointers.size || viewport.contains(event.target)) event.preventDefault();
  });
  viewport.addEventListener('dragstart', (event) => event.preventDefault());
  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (arrangeMode) {
      const groupHead = event.target.closest('.graph-group-head');
      if (groupHead && !event.target.closest('button')) { startGroupDrag(event, groupHead.dataset.groupId); return; }
      const card = event.target.closest('.graph-node-select');
      if (card) {
        const wrapper = card.closest('.graph-node');
        if (wrapper) { startNodeDrag(event, wrapper.dataset.nodeId); return; }
      }
    }
    // Node cards support both click and pan. Dedicated controls never start pan.
    if (event.target.closest('.graph-toolbox, .graph-pan, .graph-minimap, .graph-branch-toggle, input, select, textarea, a, [contenteditable]')) return;
    if (event.target.closest('button') && !event.target.closest('.graph-node-select')) return;
    event.preventDefault();
    pointers.set(event.pointerId, {
      x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY,
    });
    document.documentElement.classList.add(gestureClass);
    clearSelection();
    if (pointers.size > 1) beginDrag();
  });
  document.addEventListener('pointermove', (event) => {
    if (nodeDrag && event.pointerId === nodeDrag.pointerId) { moveNodeDrag(event); return; }
    if (groupDrag && event.pointerId === groupDrag.pointerId) { moveGroupDrag(event); return; }
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    if (event.pointerType === 'mouse' && !(event.buttons & 1)) {
      endPointer(event, true);
      return;
    }
    event.preventDefault();
    const before = [...pointers.values()];
    const oldDistance = before.length > 1 ? Math.hypot(before[0].x - before[1].x, before[0].y - before[1].y) : 0;
    pointers.set(event.pointerId, { ...previous, x: event.clientX, y: event.clientY });
    const wasDragging = dragging;
    if (!dragging) {
      if (Math.hypot(event.clientX - previous.startX, event.clientY - previous.startY) < dragThreshold) return;
      beginDrag();
    }
    if (pointers.size === 1) {
      tx += event.clientX - (wasDragging ? previous.x : previous.startX);
      ty += event.clientY - (wasDragging ? previous.y : previous.startY);
    } else {
      const after = [...pointers.values()];
      const distance = Math.hypot(after[0].x - after[1].x, after[0].y - after[1].y);
      const rect = viewport.getBoundingClientRect();
      if (oldDistance) zoom(scale * distance / oldDistance, (after[0].x + after[1].x) / 2 - rect.left, (after[0].y + after[1].y) / 2 - rect.top);
    }
    clearSelection();
    manualView = true;
    requestDraw();
  }, { passive: false });
  document.addEventListener('pointerup', (event) => {
    if (endGraphDrag(event)) return;
    endPointer(event);
  });
  document.addEventListener('pointercancel', (event) => {
    if (endGraphDrag(event, true)) return;
    endPointer(event, true);
  });
  viewport.addEventListener('lostpointercapture', (event) => {
    if (endGraphDrag(event, true)) return;
    endPointer(event, true);
  });
  window.addEventListener('blur', cancelGesture);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelGesture(); });
  viewport.addEventListener('wheel', (event) => {
    // Keep the browser's own accessibility zoom shortcuts available.
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    zoom(scale * Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .002), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  viewport.addEventListener('keydown', (event) => {
    if (event.target !== viewport) return;
    const moves = { ArrowLeft: [80, 0], ArrowRight: [-80, 0], ArrowUp: [0, 80], ArrowDown: [0, -80] };
    if (moves[event.key]) {
      event.preventDefault();
      tx += moves[event.key][0]; ty += moves[event.key][1]; manualView = true; requestDraw();
    } else if (event.key === '+' || event.key === '=') { event.preventDefault(); zoom(scale * 1.2); }
    else if (event.key === '-') { event.preventDefault(); zoom(scale / 1.2); }
    else if (event.key === '0') { event.preventDefault(); fit({ overview: true }); }
    else if (event.key === 'Escape' && focusRoot) { event.preventDefault(); focusRoot = null; focusSet = null; updateFocusSet(); }
  });
  document.querySelector('#graph-zoom-in').addEventListener('click', () => zoom(scale * 1.2));
  document.querySelector('#graph-zoom-out').addEventListener('click', () => zoom(scale / 1.2));
  document.querySelector('#graph-fit').addEventListener('click', () => fit({ overview: true }));
  document.querySelector('#graph-actual').addEventListener('click', () => zoom(1));
  document.querySelector('#graph-expand').addEventListener('click', () => { collapsed.clear(); rebuild(); fit(); });
  document.querySelector('#graph-overview')?.addEventListener('click', () => {
    collapseOverview();
    if (filtering) {
      filterCollapsed = new Set(collapsed);
      revealPaths(matches);
    }
    rebuild();
    // Use a visible ancestor as the overview anchor without changing selection
    // or the review editor. The fit command still exposes the full extent.
    fit({ overview: true });
  });
  document.querySelector('#graph-cross').addEventListener('change', requestDraw);
  if (arrangeEnabled) {
    arrangeButton?.addEventListener('click', () => setArrangeMode(!arrangeMode));
    focusButton?.addEventListener('click', () => {
      if (focusRoot) { focusRoot = null; focusSet = null; }
      else if (selectedId) focusRoot = selectedId;
      updateFocusSet();
    });
    groupButton?.addEventListener('click', () => {
      if (!groupForm || multiSelected.size < 2) return;
      groupForm.hidden = false;
      groupName.value = '';
      groupName.focus();
    });
    groupCancel?.addEventListener('click', () => {
      if (!groupForm) return;
      groupForm.hidden = true;
      groupName.value = '';
    });
    groupCreate?.addEventListener('click', createGroup);
    groupName?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); createGroup(); return; }
      if (event.key !== 'Escape') return;
      event.preventDefault();
      groupForm.hidden = true;
      groupName.value = '';
    });
    resetLayoutButton?.addEventListener('click', () => {
      customPositions.clear();
      groups = [];
      multiSelected.clear();
      persistOrganizeState();
      rebuild();
      fit({ overview: true });
      updateArrangeUI();
    });
  }
  for (const control of document.querySelectorAll('[data-pan]')) {
    control.addEventListener('click', () => {
      const offset = { left: [100, 0], right: [-100, 0], up: [0, 100], down: [0, -100] }[control.dataset.pan];
      tx += offset[0]; ty += offset[1]; manualView = true; requestDraw();
    });
  }
  minimap.addEventListener('click', (event) => {
    if (!miniProjection) return;
    const { ratio, ox, oy } = miniProjection;
    const rect = minimap.getBoundingClientRect();
    tx = width / 2 - (event.clientX - rect.left - ox) / ratio * scale;
    ty = height / 2 - (event.clientY - rect.top - oy) / ratio * scale;
    manualView = true;
    requestDraw();
  });

  function applyFilters() {
    if (!hasFilters) return;
    const q = search.value.trim().toLocaleLowerCase();
    const wasFiltering = filtering;
    filtering = Boolean(q || status.value || kind.value);
    if (filtering && !wasFiltering) filterCollapsed = new Set(collapsed);
    let changed = false;
    if (filterCollapsed) {
      changed = [...collapsed].some((id) => !filterCollapsed.has(id))
        || [...filterCollapsed].some((id) => !collapsed.has(id));
      collapsed.clear();
      for (const id of filterCollapsed) if (sourceById.has(id)) collapsed.add(id);
    }
    matches = new Set();
    const directMatches = [];
    for (const node of data.nodes) {
      const card = document.getElementById(node.anchor);
      const cardSearch = String(card?.dataset?.search || '').toLocaleLowerCase();
      const haystack = [node.label, node.kindLabel, node.statusLabel, node.roadmapLabel]
        .filter(Boolean).join(' ').toLocaleLowerCase();
      const match = (!q || haystack.includes(q) || cardSearch.includes(q))
        && (!status.value || node.status === status.value)
        && (!kind.value || node.kind === kind.value);
      if (match) matches.add(node.id);
      if (match && q && node.label.toLocaleLowerCase().includes(q)) directMatches.push(node.id);
      if (card) card.hidden = !match;
    }
    for (const group of document.querySelectorAll('.group')) group.hidden = !group.querySelector('.node:not([hidden])');
    if (filtering) {
      changed = revealPaths(directMatches.length ? directMatches : matches) || changed;
      if (matches.size) {
        const targets = directMatches.length ? directMatches : [...matches];
        const paths = new Set();
        for (const target of targets) {
          for (let id = target; id != null; id = hierarchy.get(id)?.parentId) paths.add(id);
        }
        const pathParents = new Set([...paths].map((id) => hierarchy.get(id)?.parentId).filter((id) => id != null));
        for (const [id, node] of hierarchy) {
          if (node.childCount && !pathParents.has(id) && !collapsed.has(id)) { collapsed.add(id); changed = true; }
        }
      }
    }
    if (!filtering) filterCollapsed = null;
    if (changed) rebuild(); else updateMatches();
    if (filtering && (matches.size === 1 || directMatches.length === 1)) {
      const targetId = directMatches.length === 1 ? directMatches[0] : [...matches][0];
      let node = positions.get(targetId);
      for (let parent = hierarchy.get(targetId)?.parentId; !node && parent != null; parent = hierarchy.get(parent)?.parentId) node = positions.get(parent);
      if (node && !groupHiddenIds.has(node.id)) {
        scale = Math.max(.8, scale);
        tx = width / 2 - (node.x + node.width / 2) * scale;
        ty = height / 2 - (node.y + node.height / 2) * scale;
        manualView = true;
        requestDraw();
      }
    }
  }
  if (search) search.addEventListener('input', applyFilters);
  if (status) status.addEventListener('change', applyFilters);
  if (kind) kind.addEventListener('change', applyFilters);
  document.querySelector('#reset')?.addEventListener('click', () => {
    search.value = ''; status.value = ''; kind.value = ''; applyFilters(); search.focus();
  });

  function setView(view) {
    cancelGesture();
    const graph = view === 'graph';
    if (!graph && fullscreenActive) void toggleFullscreen();
    graphView.hidden = !graph;
    if (listView) listView.hidden = graph;
    const observations = document.querySelector('#graph-observations');
    if (observations) observations.hidden = !graph;
    for (const control of document.querySelectorAll('[data-view]')) control.setAttribute('aria-pressed', String(control.dataset.view === view));
    if (graph) resize();
  }
  for (const control of document.querySelectorAll('[data-view]')) control.addEventListener('click', () => setView(control.dataset.view));
  document.addEventListener('click', (event) => {
    const anchor = event.target.closest('a[href^="#node-"]');
    if (!anchor || graphView.hidden) return;
    const id = sourceByAnchor.get(anchor.getAttribute('href').slice(1));
    if (!id) return;
    event.preventDefault();
    select(id, true, true);
  });
  const viewControls = document.querySelector('#view-controls');
  if (viewControls) viewControls.hidden = false;
  pruneOrganize();
  rebuild();
  setView('graph');
  const initialId = sourceByAnchor.get(location.hash.slice(1));
  if (data.nodes.length) select(initialId || selectedId, Boolean(initialId));

  function refresh(nextData, options = {}) {
    cancelGesture();
    const focusedNodeId = document.activeElement?.closest?.('.graph-node')?.dataset.nodeId;
    if (options.updateUrl !== undefined) updateUrl = options.updateUrl;
    data = { ...nextData, labels: nextData.labels || data.labels };
    sourceById = new Map(data.nodes.map((node) => [node.id, node]));
    sourceByAnchor = new Map(data.nodes.filter((node) => node.anchor).map((node) => [node.anchor, node.id]));
    indexHierarchy();
    if (options.updateUrl !== false) pruneOrganize();
    for (const id of [...collapsed]) if (!sourceById.has(id)) collapsed.delete(id);
    if (!sourceById.has(selectedId)) selectedId = data.nodes[0]?.id;
    matches = new Set(data.nodes.map((node) => node.id));
    rebuild();
    if (hasFilters) applyFilters();
    if (options.view) restoreView(options.view);
    if (options.fit) { collapsed.clear(); rebuild(); fit(); }
    if (focusedNodeId) nodeElements.get(focusedNodeId)?.querySelector('.graph-node-select')?.focus({ preventScroll: true });
    requestDraw();
  }

  function restoreView(view) {
    collapsed.clear();
    for (const id of view.collapsed || []) if (sourceById.has(id)) collapsed.add(id);
    selectedId = sourceById.has(view.selectedId) ? view.selectedId : data.nodes[0]?.id;
    if ([view.scale, view.tx, view.ty].every(Number.isFinite) && view.scale > 0) {
      scale = view.scale; tx = view.tx; ty = view.ty; manualView = true;
    }
    rebuild(); requestDraw();
  }

  const api = {
    selectNode(id, center = false, focusInspector = false) { select(id, center, focusInspector); },
    refresh,
    restoreView,
    getViewState() { return { selectedId, scale, tx, ty, collapsed: [...collapsed], arrangeMode, focusRoot, groupCount: groups.length, customPositions: customPositions.size }; },
    getRenderStats() { return { nodes: layout.nodes.length, edges: layout.edges.length, drawnEdges, culledEdges, minimapPaints, detail: viewport.dataset.detail, width: layout.width, height: layout.height }; },
  };
  try { graphView.__continuityGraph = api; } catch { /* Frozen DOM hosts are harmless. */ }
  try { graphView.dispatchEvent(new CustomEvent('continuity:graph-ready', { detail: api })); } catch { /* Optional host hook. */ }
  new ResizeObserver(resize).observe(viewport);
  return api;
}
