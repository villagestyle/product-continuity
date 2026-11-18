import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Script, runInNewContext } from 'node:vm';
import { deriveRoadmap } from '../scripts/roadmap-model.mjs';
import { digestValue } from '../scripts/intent-model.mjs';
import { deriveFeatureProgress, getFeatureProgressBrowserSource, selectFeatureContext } from '../scripts/feature-progress.mjs';
import { featureProgressCardLines, featureProgressSummaryMap, renderFeatureProgressDetail, renderRoadmapDetail, renderRoadmapIndex, renderRoadmapFilters } from '../scripts/roadmap-ui.mjs';
import { renderDirectory } from '../scripts/review-ui.mjs';
import { renderReview } from '../scripts/render-review.mjs';
import { renderMap } from '../scripts/render-map.mjs';
import { renderTimelineOverview, renderTimelineShell } from '../scripts/timeline-ui.mjs';
import { deriveProgress } from '../scripts/timeline-model.mjs';
import { CAPABILITY, ROADMAP, makeItem, makeMcpState } from './mcp-fixtures.mjs';

const featureState = JSON.parse(await readFile(new URL('../examples/feature-progress-state-0.2.json', import.meta.url), 'utf8'));
const featureDigest = (content) => digestValue(content);
const featureView = () => deriveFeatureProgress(featureState, { includeRetired: true, digest: featureDigest });
const featureDetail = (nodeId = 'capability:progress-resume') => selectFeatureContext(featureState, nodeId, { digest: featureDigest });

test('roadmap model and all embedded render helpers run without module closures',()=>{
  const state=makeMcpState(), view=deriveRoadmap(state);
  const embedded=runInNewContext('('+deriveRoadmap.toString()+')');
  assert.equal(JSON.stringify(embedded(state)),JSON.stringify(view));
  for(const [fn,args]of [[renderRoadmapFilters,[]],[renderRoadmapIndex,[view]],[renderRoadmapDetail,[state,view,ROADMAP]]]) {
    assert.equal(runInNewContext('('+fn.toString()+')')(...args),fn(...args));
  }
});
test('read-only planning detail exposes complete fields and evidence definition separately; malicious strings stay text',()=>{
  const state=makeMcpState();state.roadmapItems[0].objective='<img src=x onerror="window.roadmapXss=1">';state.roadmapItems[0].scope=['</script><script>bad()</script>'];
  const view=deriveRoadmap(state),html=renderRoadmapDetail(state,view,ROADMAP);
  for(const text of ['规划目标','范围','排除','验收目标','依赖','阻塞','关闭原因','定义、执行、运行时分开','定义不等于测试通过','defined_only'])assert.ok(html.includes(text),text);
  assert.ok(html.includes('&lt;img'));assert.equal(html.includes('<img'),false);assert.equal(html.includes('<script>'),false);
  assert.doesNotMatch(html,/<form|<textarea|data-action=|data-submit=|data-open-claim=/);
  assert.equal(view.items[0].nodeId,CAPABILITY);assert.equal(state.nodes.filter(n=>n.id===CAPABILITY).length,1);
});
test('history empty/loading/unavailable renders never borrow present planning or expose offline writes',()=>{
  for(const options of [{historical:true},{mode:'loading'},{mode:'unavailable'}]) {
    const html=renderRoadmapIndex(null,options);assert.doesNotMatch(html,/Synthetic future planning|--apply|data-action=/);
  }
  assert.match(renderRoadmapIndex(null,{historical:true}),/当时没有规划记录/);
  const state=makeMcpState();assert.match(renderRoadmapIndex(deriveRoadmap(state),{filter:'later'}),/没有规划项/);
});

test('planning detail includes implementation/verification edge evidence without promoting definitions to results', () => {
  const state = makeMcpState();
  const evidence = state.evidence.find((item) => item.kind === 'test_definition');
  state.nodes.forEach((node) => { node.evidenceIds = node.evidenceIds.filter((id) => id !== evidence.id); });
  state.edges.find((edge) => edge.id === 'edge:mcp-verify').evidenceIds = [evidence.id];
  const html = renderRoadmapDetail(state,deriveRoadmap(state),ROADMAP);
  assert.ok(html.includes(evidence.claim)); assert.match(html,/defined_only/);
  assert.match(html,/测试定义不等于测试通过/);
});
test('live and static 0.2 include roadmap entry, valid embedded scripts, no duplicate IDs or planning write controls',()=>{
  const state=makeMcpState();
  for(const html of [renderReview({state,fileDigest:'sha256:'+'a'.repeat(64),writable:true},{nonce:'roadmap-test'}),renderMap(state)]) {
    assert.match(html,/id="graph-roadmap"/);assert.match(html,/功能规划/);
    const markup=html.slice(0,html.indexOf('<script'));
    const ids=[...markup.matchAll(/ id="([^"]+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
    const script=html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];assert.doesNotThrow(()=>new Script(script));
    assert.doesNotMatch(markup,/data-roadmap-save|data-roadmap-apply/);
  }
});
test('closed dependency carries status only, never inferred satisfaction or completion',()=>{
  const state=makeMcpState();state.nodes.push({id:'capability:dependency',kind:'capability',label:'Cancelled dependency',status:'candidate',evidenceIds:[]});
  state.roadmapItems.push(makeItem({id:'roadmap:dependency',nodeId:'capability:dependency',status:'closed',closedReason:'Cancelled without implementation'}));
  state.roadmapItems[0].dependsOn=['roadmap:dependency'];const view=deriveRoadmap(state);
  assert.deepEqual(view.items.find(i=>i.id===ROADMAP).dependencyStatuses,[{id:'roadmap:dependency',status:'closed'}]);
  assert.equal(view.items[0].unresolvedDependencies,undefined);
  assert.match(renderRoadmapDetail(state,view,'roadmap:dependency'),/Cancelled without implementation/);
});
test('timeline planning save time and category are explicitly non-review in rendered output',()=>{
  const state=makeMcpState(),metrics=deriveProgress(state),history={samples:[{stateVersion:1,source:'current',at:'2026-11-12T04:00:00.000Z',timeBasis:'planning',metrics}],warnings:[]};
  assert.match(renderTimelineOverview(state,history,{deriveProgress}),/规划记录，非评审/);
  assert.match(renderTimelineShell(state,history,{deriveProgress,renderTimelineOverview}),/value="planning">规划记录（非评审）/);
});
test('checkpoint save time and category are explicitly non-review and never a review count',()=>{
  const state=makeMcpState(),metrics=deriveProgress(state);
  const history={samples:[{stateVersion:1,source:'current',at:'2026-11-12T04:00:00.000Z',timeBasis:'checkpoint',metrics}],warnings:[]};
  const overview=renderTimelineOverview(state,history,{deriveProgress});
  assert.match(overview,/续接记录，非评审/);
  assert.doesNotMatch(overview,/评审动作/);
  const shell=renderTimelineShell(state,history,{deriveProgress,renderTimelineOverview});
  assert.match(shell,/value="checkpoint">续接记录（非评审）/);
  const event={id:'featureCheckpoints:checkpoint:1:createdAt',recordId:'checkpoint:1',collection:'featureCheckpoints',category:'checkpoint',title:'续接记录（非评审）',at:'2026-11-12T04:00:00.000Z',timeField:'createdAt',stateVersion:2,nodeIds:[CAPABILITY],refs:[]};
  assert.match(renderTimelineShell({...state,featureCheckpoints:[]},{samples:[],warnings:[]},{deriveProgress,renderTimelineOverview}),/id="timeline-category"/);
  assert.ok(event.category==='checkpoint');
});
test('feature progress summaries give cards and planning rows the saved stop and next action',()=>{
  const view=deriveRoadmap(featureState),progress=featureProgressSummaryMap(featureView());
  const html=renderRoadmapIndex(view,{progress});
  assert.match(html,/停点：Synthetic stop point; not an execution position\./);
  assert.match(html,/下一步：Synthetic next action; it grants no authorization\./);
  assert.doesNotMatch(html,/%|完成率|已交付|测试通过/);
  const card=featureProgressCardLines(featureView().features.find((feature)=>feature.nodeId==='capability:progress-resume'));
  assert.equal(card.line1,'Synthetic checkpoint for contract tests.');assert.match(card.line2,/^下一步：Synthetic next action/);
  const empty=featureProgressCardLines(featureView().features.find((feature)=>feature.nodeId==='capability:search'));
  assert.equal(empty.line1,'尚无续接记录');assert.equal(empty.line2,'下一步未记录');
  assert.doesNotMatch(empty.aria,/未开发|已完成/);
});
test('feature progress detail shows stop, next action authority, work basis, remaining responsibility and history',()=>{
  const detail=featureDetail(),html=renderFeatureProgressDetail(detail);
  for(const term of ['停点与下一步','Synthetic stop point','Synthetic next action','责任方：代理','所需授权：运行测试或命令','Synthetic work item','Synthetic remaining item','历次续接（1 条，旧→新）','非评审','不是执行指令','规划位置：Next · 接下来'])assert.ok(html.includes(term),term);
  assert.doesNotMatch(html,/%|已交付|全部完成|测试通过/);
  assert.doesNotMatch(html,/<form|<textarea|data-action=|data-submit=/);
  const empty=renderFeatureProgressDetail(featureDetail('capability:search'));
  assert.match(empty,/尚无续接记录/);assert.match(empty,/规划未记录/);assert.doesNotMatch(empty,/未开发/);
  const noRemaining=structuredClone(featureState);
  noRemaining.featureCheckpoints[0].remaining=[];
  const noRemainingHtml=renderFeatureProgressDetail(selectFeatureContext(noRemaining,'capability:progress-resume',{digest:featureDigest}));
  assert.match(noRemainingHtml,/剩余事项未记录/);assert.doesNotMatch(noRemainingHtml,/无剩余/);
});
test('feature progress detail uses exact contract wording for unchanged, none, not prepared and unavailable',()=>{
  const unchanged=featureDetail();
  assert.equal(unchanged.context.status,'unchanged');
  assert.match(renderFeatureProgressDetail(unchanged),/保存态相关上下文未变（不代表源码或运行状态已核验）/);
  const none=structuredClone(featureState);
  none.featureCheckpoints[0].nextActions=[];none.featureCheckpoints[0].nextActionsStatus='none';
  const noneDetail=selectFeatureContext(none,'capability:progress-resume',{digest:featureDigest});
  const noneHtml=renderFeatureProgressDetail(noneDetail);
  assert.match(noneHtml,/已明确无后续动作/);
  assert.match(featureProgressCardLines(noneDetail).line2,/下一步：已明确无后续动作/);
  const notPrepared=structuredClone(featureState);
  notPrepared.featureCheckpoints[0].nextActions=[];notPrepared.featureCheckpoints[0].nextActionsStatus='not_prepared';
  const notPreparedDetail=selectFeatureContext(notPrepared,'capability:progress-resume',{digest:featureDigest});
  assert.match(renderFeatureProgressDetail(notPreparedDetail),/下一步尚未整理/);
  assert.match(featureProgressCardLines(notPreparedDetail).line2,/下一步：下一步尚未整理/);
  const unavailable=structuredClone(featureState);
  delete unavailable.featureCheckpoints[0].basis.contextIds;
  const unavailableDetail=selectFeatureContext(unavailable,'capability:progress-resume',{digest:featureDigest});
  assert.equal(unavailableDetail.context.status,'unavailable');
  assert.match(renderFeatureProgressDetail(unavailableDetail),/续接依据无法比较/);
  const unplanned=structuredClone(featureState);unplanned.roadmapItems=[];
  const unplannedHtml=renderFeatureProgressDetail(selectFeatureContext(unplanned,'capability:progress-resume',{digest:featureDigest}));
  assert.match(unplannedHtml,/规划未记录/);assert.match(unplannedHtml,/Feature 有记录但规划尚未记录/);
});
test('feature progress detail escalates stale context and closed planning without claiming delivery',()=>{
  const changed=structuredClone(featureState);
  changed.nodes.find((node)=>node.id==='capability:progress-resume').label='Renamed after the checkpoint';
  const changedDetail=selectFeatureContext(changed,'capability:progress-resume',{digest:featureDigest});
  const changedHtml=renderFeatureProgressDetail(changedDetail);
  assert.match(changedHtml,/续接依据有变化，需复核/);
  assert.match(changedHtml,/本次未核对源码/);
  const closed=structuredClone(featureState);
  closed.roadmapItems[0].status='closed';closed.roadmapItems[0].closedReason='Synthetic close';
  assert.match(renderFeatureProgressDetail(selectFeatureContext(closed,'capability:progress-resume',{digest:featureDigest})),/规划项已关闭（不等于交付）/);
  const noDigest=selectFeatureContext(featureState,'capability:progress-resume');
  assert.match(renderFeatureProgressDetail(noDigest),/保存态结构未变；内容指纹未重算/);
});
test('feature progress detail escapes untrusted checkpoint text and stays self-contained',()=>{
  const state=structuredClone(featureState);
  const checkpoint=state.featureCheckpoints[0];
  checkpoint.summary='<img src=x onerror="window.__featureXss=1">';
  checkpoint.stopPoint='</script><script>window.__featureXss=2</script>';
  checkpoint.workDone[0].statement='<svg onload=window.__featureXss=3>';
  checkpoint.remaining[0].statement='"><iframe src=javascript:window.__featureXss=4>';
  checkpoint.nextActions[0].statement='<a href="javascript:window.__featureXss=5">next</a>';
  const detail=selectFeatureContext(state,'capability:progress-resume',{digest:featureDigest});
  const html=renderFeatureProgressDetail(detail);
  assert.ok(html.includes('&lt;img'));assert.equal(html.includes('<img'),false);
  assert.equal(html.includes('<script>'),false);assert.equal(html.includes('<iframe'),false);assert.equal(html.includes('<a href'),false);
  const embedded=runInNewContext('('+renderFeatureProgressDetail.toString()+')');
  assert.equal(embedded(detail),html);
  for(const fn of [featureProgressSummaryMap,featureProgressCardLines])assert.doesNotThrow(()=>new Function('return ('+fn.toString()+');'));
});
test('planning detail carries the same feature progress block above the original planning fields',()=>{
  const view=deriveRoadmap(featureState),detail=featureDetail();
  const progressHtml=renderFeatureProgressDetail(detail);
  const html=renderRoadmapDetail(featureState,view,'roadmap:progress-resume',{progressHtml});
  assert.ok(html.includes('data-testid="roadmap-progress"'));
  assert.ok(html.indexOf('Synthetic stop point')<html.indexOf('<h3>规划目标</h3>'),'stop point must stay on the first screen before planning detail');
  for(const term of ['范围','排除','验收目标','依赖','阻塞','关闭原因','在画布定位这个功能'])assert.ok(html.includes(term),term);
});
test('static and live pages embed the same progress meaning and self-contained browser model',()=>{
  const staticHtml=renderMap(featureState);
  const liveHtml=renderReview({state:featureState,fileDigest:'sha256:'+'b'.repeat(64),writable:true,readOnlyReason:'',viewStatus:null},{nonce:'feature-progress-test'});
  const browserModel=getFeatureProgressBrowserSource();
  for(const html of [staticHtml,liveHtml]){
    assert.ok(html.includes(browserModel),'the exact self-contained browser model source is embedded');
    assert.match(html,/停点：Synthetic stop point/);
    assert.match(html,/下一步：Synthetic next action/);
    assert.ok(html.includes('尚无续接记录'));
    const body=html.slice(html.indexOf('<body'));
    const firstScript=body.indexOf('<script');
    const visible=firstScript===-1?body:body.slice(0,firstScript);
    assert.doesNotMatch(visible,/完成率|已交付|全部完成/);
    for(const section of visible.matchAll(/<section class="feature-progress"[\s\S]*?<\/section>/g))assert.doesNotMatch(section[0],/%|已交付|全部完成|测试通过/);
    const script=html.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(()=>new Script(script));
  }
  assert.match(liveHtml,/featureProgressApi:/);
  assert.match(liveHtml,/renderFeatureProgressDetail:/);
  assert.doesNotMatch(liveHtml,/\bimport\s+[\w{]/);
});
test('feature cards carry a scannable delivery badge with saved basis; empty stays 状态待补充',()=>{
  const feature=featureView().features.find((item)=>item.nodeId==='capability:progress-resume');
  const card=featureProgressCardLines(feature);
  assert.equal(card.delivery.status,'awaiting_verification');
  assert.equal(card.delivery.label,'待验证');
  assert.equal(card.delivery.badgeText,'待验证');
  assert.equal(card.delivery.text,'交付：待验证');
  assert.equal(card.delivery.needsReview,false);
  assert.match(card.delivery.title,/按保存的剩余事项/);
  assert.ok(card.aria.includes(card.delivery.aria),'full delivery basis stays in aria');
  const empty=featureProgressCardLines(featureView().features.find((item)=>item.nodeId==='capability:search'));
  assert.equal(empty.delivery.status,'unknown');
  assert.equal(empty.delivery.badgeText,'状态待补充');
  assert.doesNotMatch(empty.delivery.aria,/未开发|已完成/);
  // The embedded card helper produces the identical badge shape in the page realm.
  const embedded=runInNewContext('('+featureProgressCardLines.toString()+')');
  assert.equal(JSON.stringify(embedded(feature)),JSON.stringify(card));
  assert.equal(JSON.stringify(embedded(null)),JSON.stringify(featureProgressCardLines(null)));
});
test('changed context prefixes the delivery badge with 需复核 without dropping the saved stage',()=>{
  const changed=structuredClone(featureState);
  changed.nodes.find((node)=>node.id==='capability:progress-resume').label='Renamed after the checkpoint';
  const feature=deriveFeatureProgress(changed,{includeRetired:true,digest:featureDigest}).features.find((item)=>item.nodeId==='capability:progress-resume');
  const card=featureProgressCardLines(feature);
  assert.equal(card.delivery.status,'awaiting_verification');
  assert.equal(card.delivery.needsReview,true);
  assert.equal(card.delivery.badgeText,'需复核 · 待验证');
  assert.equal(card.delivery.text,'交付：待验证 · 需复核');
  assert.match(card.delivery.title,/续接依据有变化，交付状态需复核/);
});
test('planning rows render the delivery badge with the same meaning and no completion wording',()=>{
  const view=deriveRoadmap(featureState),progress=featureProgressSummaryMap(featureView());
  assert.equal(progress['capability:progress-resume'].delivery.status,'awaiting_verification');
  const html=renderRoadmapIndex(view,{progress});
  assert.match(html,/data-testid="roadmap-item-delivery"[^>]*data-delivery="awaiting_verification"/);
  assert.ok(html.includes('>待验证</span>'));
  assert.match(html,/title="[^"]*交付：待验证（按保存的剩余事项）/);
  assert.doesNotMatch(html,/%|完成率|已交付|测试通过|全部完成/);
  const embedded=runInNewContext('('+renderRoadmapIndex.toString()+')');
  assert.equal(embedded(view,{progress}),html);
});
test('feature detail leads with delivery status, reason, basis and save time; never a completion switch',()=>{
  const html=renderFeatureProgressDetail(featureDetail());
  assert.match(html,/data-testid="feature-delivery-status"[^>]*data-delivery="awaiting_verification"[^>]*data-needs-review="false"/);
  assert.ok(html.includes('交付状态'));
  assert.match(html,/data-testid="feature-delivery-badge"[^>]*>待验证</);
  assert.match(html,/按保存的剩余事项/);
  assert.match(html,/保存于 2026-/);
  assert.ok(html.includes('交付状态是保存记录的读数：不是人工验收，不是意图确认，也不是发布授权。'));
  assert.doesNotMatch(html,/%|已交付|全部完成|测试通过/);
  assert.doesNotMatch(html,/<form|<textarea|data-action=|data-submit=/);
  const empty=renderFeatureProgressDetail(featureDetail('capability:search'));
  assert.match(empty,/data-testid="feature-delivery-status"[^>]*data-delivery="unknown"/);
  assert.ok(empty.includes('状态待补充'));
  assert.doesNotMatch(empty,/未开发|已完成/);
});
test('detail escalates a stale delivery reading and shows an explicit saved delivery statement as saved',()=>{
  const changed=structuredClone(featureState);
  changed.nodes.find((node)=>node.id==='capability:progress-resume').label='Renamed after the checkpoint';
  const changedHtml=renderFeatureProgressDetail(selectFeatureContext(changed,'capability:progress-resume',{digest:featureDigest}));
  assert.match(changedHtml,/data-testid="feature-delivery-status"[^>]*data-needs-review="true"/);
  assert.match(changedHtml,/需复核 · 待验证/);
  assert.match(changedHtml,/续接依据有变化，交付状态需复核/);
  const stated=structuredClone(featureState);
  stated.featureCheckpoints[0].delivery={status:'awaiting_release',summary:'Synthetic saved delivery statement; not a release authorization.',basisRefs:[]};
  const statedHtml=renderFeatureProgressDetail(selectFeatureContext(stated,'capability:progress-resume',{digest:featureDigest}));
  assert.match(statedHtml,/data-delivery="awaiting_release"/);
  assert.ok(statedHtml.includes('交付说明：Synthetic saved delivery statement; not a release authorization.'));
  assert.match(statedHtml,/按保存的交付说明/);
  assert.doesNotMatch(statedHtml,/全部完成|已交付/);
});
test('static and live pages pass the same delivery badge to text cards and graph nodes',()=>{
  const staticHtml=renderMap(featureState);
  const liveHtml=renderReview({state:featureState,fileDigest:'sha256:'+'c'.repeat(64),writable:true},{nonce:'delivery-test'});
  // Static text cards are server-rendered. The live text directory is also
  // server-rendered for the initial markup and re-rendered in the page by the
  // same renderDirectory helper, fed with the same featureProgressCardLines
  // projection — so both pages carry the badge directly in their text cards.
  assert.match(staticHtml,/data-testid="node-feature-delivery"[^>]*data-delivery="awaiting_verification"/);
  assert.ok(staticHtml.includes('交付：待验证'));
  assert.match(liveHtml,/data-testid="node-feature-delivery"[^>]*data-delivery="awaiting_verification"/);
  for(const html of [staticHtml,liveHtml]){
    assert.ok(html.includes('交付：待验证'));
    assert.ok(html.includes('"delivery":{"status":"awaiting_verification"'),'graph node data carries the delivery shape');
    assert.ok(html.includes('graph-node-delivery'),'graph card chip renderer is embedded');
    const body=html.slice(html.indexOf('<body'));
    const visible=body.slice(0,body.indexOf('<script'));
    assert.doesNotMatch(visible,/完成率|已交付|全部完成/);
  }
  assert.ok(liveHtml.includes('featureProgressCardLines'),'the live page embeds the shared card-lines helper');
});
test('live text directory renders the shared delivery projection, escapes it and adds no execution controls',()=>{
  const progress={};
  for(const feature of featureView().features) progress[feature.nodeId]=featureProgressCardLines(feature);
  const html=renderDirectory(featureState,{writable:true,progress});
  assert.match(html,/data-testid="node-feature-progress"/);
  assert.match(html,/data-testid="node-feature-delivery"[^>]*data-delivery="awaiting_verification"[^>]*data-needs-review="false"/);
  assert.ok(html.includes('交付：待验证'));
  assert.ok(html.includes('下一步：Synthetic next action'));
  assert.match(html,/data-delivery="unknown"/);
  assert.ok(html.includes('状态待补充'));
  // The stringified helper produces identical markup in the page realm.
  const embedded=runInNewContext('('+renderDirectory.toString()+')');
  assert.equal(embedded(featureState,{writable:true,progress}),html);
  // Without the projection the directory stays as before: no badge invented.
  assert.doesNotMatch(renderDirectory(featureState,{writable:true}),/node-feature-delivery/);
  // Filtered redraw (node panel) keeps the badge for the selected node only.
  const filtered=renderDirectory(featureState,{writable:true,progress,nodeId:'capability:progress-resume'});
  assert.match(filtered,/data-testid="node-feature-delivery"[^>]*data-delivery="awaiting_verification"/);
  assert.doesNotMatch(filtered,/data-node-id="capability:search"/);
  // No execution controls inside the progress block.
  const block=html.match(/<p class="node-progress"[\s\S]*?<\/p>/)[0];
  assert.doesNotMatch(block,/<button|data-action=|<form|<textarea/);
  // Untrusted projection text stays text in every attribute and span.
  const base=progress['capability:progress-resume'];
  const hostile={...progress,'capability:progress-resume':{...base,
    line1:'<img src=x onerror="window.__dirXss=1">',
    line2:'</p><script>bad()</script>',
    aria:'" onload="bad()',
    delivery:{...base.delivery,title:'"><svg onload=bad()>',text:'<b>交付</b>'}}};
  const hostileHtml=renderDirectory(featureState,{writable:true,progress:hostile});
  assert.ok(hostileHtml.includes('&lt;img'));
  assert.equal(hostileHtml.includes('<img'),false);
  assert.equal(hostileHtml.includes('<script>bad'),false);
  assert.equal(hostileHtml.includes('<svg onload'),false);
  assert.equal(hostileHtml.includes('<b>交付</b>'),false);
});
