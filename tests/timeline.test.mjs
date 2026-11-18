import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { runInNewContext, Script } from 'node:vm';
import { deriveProgress, deriveTimeline } from '../scripts/timeline-model.mjs';
import { readTimelineHistory, readTimelineSnapshot } from '../scripts/timeline-history.mjs';
import { initializeGraphTime, initializeTimeline, renderGraphTimeShell, renderTimelineOverview, renderTimelineShell } from '../scripts/timeline-ui.mjs';
import { openStateStore, sha256Bytes, validateFullState } from '../scripts/state-store.mjs';
import { getPageSession, httpJson } from './http-test-helpers.mjs';
import { startReviewService } from '../scripts/review-service.mjs';
import { ACCEPTANCE_NODE, ACCEPTANCE_TARGET, makeAcceptanceState } from './acceptance-fixtures.mjs';

const temporaryRoot = path.join(tmpdir(), 'product-continuity-tests');
await fs.mkdir(temporaryRoot, { recursive: true });
const demo = JSON.parse(await fs.readFile(new URL('../examples/demo-project-state-0.2.json', import.meta.url), 'utf8'));
const helpers = {deriveProgress, renderTimelineOverview};

test('progress separates active intent, implementation links and actual execution inventory', () => {
  const state = makeAcceptanceState();
  const metrics = deriveProgress(state);
  assert.equal(metrics.activeClaims, 1); assert.equal(metrics.confirmedClaims, 0);
  assert.equal(metrics.implementedTasks, 1); assert.equal(metrics.validationLinkedTasks, 1);
  assert.equal(metrics.passingTasks, 0); assert.equal(metrics.testDefinitions, 1);
  state.evidence.push({id:'e:pass',kind:'test_execution',claim:'Synthetic',validation:'passed'}, {id:'e:fail',kind:'test_execution',claim:'Synthetic',validation:'failed'});
  state.nodes.find((node) => node.kind === 'verification').evidenceIds.push('e:pass','e:fail');
  const next = deriveProgress(state);
  assert.equal(next.passingTasks, 1); assert.equal(next.failedTasks, 1);
  assert.equal(next.passedExecutions, 1); assert.equal(next.failedExecutions, 1);
  assert.equal(next.confirmedClaims, 0, 'test pass must not confirm intent');
});

test('progress excludes retired intent, counts no task twice and terminates hierarchy cycles', () => {
  const state = makeAcceptanceState();
  state.intentClaims.push({...structuredClone(state.intentClaims[0]),id:'old',status:'retired'});
  state.edges.push({id:'cycle',from:ACCEPTANCE_NODE,to:'task:acceptance',kind:'contains'}, {...state.edges[2],id:'duplicate'});
  assert.equal(deriveProgress(state).activeClaims, 1);
  assert.equal(deriveProgress(state).retiredClaims, 1);
  assert.equal(deriveProgress(state).implementedTasks, 1);
  state.nodes.find((node) => node.id === 'impl:acceptance').status = 'retired';
  assert.equal(deriveProgress(state).implementedTasks, 0);
  const empty = deriveProgress({}); assert.equal(empty.activeClaims, 0); assert.equal(empty.tasks, 0);
});

test('timeline preserves each event source, missing timestamps and lifecycle semantics', () => {
  const before = JSON.stringify(demo), result = deriveTimeline(demo);
  assert.ok(result.events.some((event) => event.category === 'review' && event.stateVersion === 9));
  assert.ok(result.events.some((event) => event.title.includes('停止决定（不计作现行确认）')));
  const creation = result.events.find((event) => event.recordId === 'claim:commitment:note-limit:v2');
  assert.equal(creation.at, '2026-11-11T00:06:00.000Z');
  assert.equal(creation.timeField, 'createdAt');
  assert.ok(creation.refs.some((ref) => ref.id === creation.recordId));
  const undated = result.events.filter((event) => event.at === null);
  assert.ok(undated.length); assert.equal(result.undated, undated.length);
  assert.ok(result.events.slice(-undated.length).every((event) => event.at === null));
  assert.equal(JSON.stringify(demo), before);
});

test('evidence events trace back to implementation and verification nodes without inventing a commit', () => {
  const state = makeAcceptanceState();
  state.evidence[0].observedAt = '2026-11-10T12:00:00+08:00';
  const events = deriveTimeline(state).events;
  const implementation = events.find((event) => event.category === 'implementation');
  assert.equal(implementation.at, '2026-11-10T04:00:00.000Z');
  assert.deepEqual(implementation.nodeIds, ['impl:acceptance']);
  assert.equal(events.find((event) => event.category === 'validation').at, null);
  assert.ok(!events.some((event) => event.collection === 'commits'));
  state.intentClaims[0].createdAt = 'yesterday';
  assert.equal(deriveTimeline(state).events.find((event) => event.category === 'claim').at, null);
});

test('review clock regression is flagged rather than changing version order', () => {
  const state = structuredClone(demo);
  state.reviews[1].createdAt = '2026-11-10T00:00:00Z';
  assert.equal(deriveTimeline(state).clockRegression, true);
  assert.equal(state.reviews[1].resultingStateVersion, 4);
});

test('overview has accessible exact denominators, no empty percent and no fabricated single-point trend', () => {
  const state = makeAcceptanceState();
  const history = {samples:[{stateVersion:1,source:'current',at:'2026-11-11T12:00:00.000Z',timeBasis:'read',metrics:deriveProgress(state)}]};
  const html = renderTimelineOverview(state,history,helpers);
  assert.match(html,/目前只有当前快照/); assert.match(html,/本次读取，非保存时间/);
  assert.match(html,/有关联不等于已完成/); assert.match(html,/通过与失败可以同时存在/);
  assert.doesNotMatch(html,/<svg/); assert.match(html,/<caption>/);
  assert.match(renderTimelineOverview({},null,helpers),/暂无分母/);
});

test('chart uses actual time spacing, distinct line styles and never bridges a missing version', () => {
  const metrics = deriveProgress(makeAcceptanceState());
  const samples = [2,3,5,6].map((version,index) => ({stateVersion:version,source:'backup',at:`2026-11-11T0${index}:00:00.000Z`,timeBasis:'review',gapBefore:version===5,metrics:{...metrics,confirmedClaims:index%2}}));
  const html = renderTimelineOverview(makeAcceptanceState(),{samples,warnings:['version_gap']},helpers);
  assert.match(html,/<svg[^>]*role="img"/); assert.match(html,/stroke-dasharray="6 4"/);
  const path = html.match(/<path d="([^"]+)" fill="none"/)[1];
  assert.equal((path.match(/M/g)||[]).length,2); assert.equal((path.match(/L/g)||[]).length,2);
  assert.match(html,/前有缺口/);
});

test('trend requires four distinct saved times and detects clock regression across unknown-time versions', () => {
  const state = makeAcceptanceState(), metrics = deriveProgress(state);
  const samples = [2,3,4,5].map((stateVersion) => ({stateVersion,source:'backup',at:'2026-11-11T01:00:00.000Z',timeBasis:'review',metrics}));
  assert.doesNotMatch(renderTimelineOverview(state,{samples},helpers),/<svg/);
  for (let index=0;index<samples.length;index++) samples[index].at = `2026-11-11T0${index+1}:00:00.000Z`;
  samples.splice(2,0,{stateVersion:4,source:'backup',at:null,timeBasis:'unknown',metrics});
  samples[3].at = '2026-11-11T00:00:00.000Z';
  assert.doesNotMatch(renderTimelineOverview(state,{samples},helpers),/<svg/);
});

test('embedded timeline helpers are self-contained and escape arbitrary labels', () => {
  for (const fn of [deriveProgress, deriveTimeline, renderTimelineOverview, renderTimelineShell, initializeTimeline, initializeGraphTime, renderGraphTimeShell]) assert.doesNotThrow(() => new Script(`(${fn.toString()})`));
  const state = makeAcceptanceState(); state.nodes[0].label = '<img onerror="bad">';
  const html = renderTimelineShell(state,null,helpers);
  assert.doesNotMatch(html,/<img/); assert.match(html,/&lt;img/);
  const other = runInNewContext(`(${deriveProgress.toString()})(${JSON.stringify(state)})`);
  assert.equal(other.implementedTasks,1);
});

test('timeline tabs and their panels retain one selected tab and no duplicate IDs', () => {
  const html = renderTimelineShell(makeAcceptanceState(),null,helpers);
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match)=>match[1]);
  assert.equal(ids.length,new Set(ids).size);
  assert.equal((html.match(/role="tab"/g)||[]).length,2);
  assert.equal((html.match(/role="tabpanel"/g)||[]).length,2);
  assert.equal((html.match(/aria-selected="true"/g)||[]).length,1);
  for(const name of ['events','progress']){
    assert.ok(ids.includes('timeline-'+name));
    assert.match(html,new RegExp(`aria-labelledby="timeline-${name}-tab"`));
  }
});

async function historyFixture(t, count = 4) {
  const directory = await fs.mkdtemp(path.join(temporaryRoot,'timeline-unit-'));
  const statePath = path.join(directory,'project-state.json');
  const initial = makeAcceptanceState();
  await fs.writeFile(statePath,JSON.stringify(initial,null,2)+'\n');
  let tick = 0;
  const store = await openStateStore(statePath,{clock:() => `2026-11-11T0${++tick}:00:00.000Z`,renderViews:null});
  t.after(async () => {await store.close(); await fs.rm(directory,{recursive:true,force:true});});
  for (let index=0;index<count;index++) {
    const snapshot = await store.read();
    await store.submitReview({projectId:initial.project.id,action:'defer',targetClaimId:ACCEPTANCE_TARGET,payload:{reason:'needs_evidence'},expectedStateVersion:snapshot.state.stateVersion,expectedDigest:snapshot.fileDigest,idempotencyKey:randomUUID()});
  }
  return {directory,statePath,store,snapshot:await store.read()};
}

test('history validates raw backup digests, full records and review prefixes without changing files', async (t) => {
  const fixture = await historyFixture(t);
  const bytes = await fs.readFile(fixture.statePath), names = await fs.readdir(fixture.directory);
  const history = await readTimelineHistory(fixture.statePath,fixture.snapshot,{now:'2026-11-11T12:00:00Z'});
  assert.deepEqual(history.samples.map((sample)=>sample.stateVersion),[1,2,3,4,5]);
  assert.equal(history.acceptedBackups,4); assert.equal(history.samples[0].timeBasis,'unknown');
  assert.equal(history.samples[0].at,null); assert.equal(history.samples[1].at,'2026-11-11T01:00:00.000Z');
  assert.equal(history.samples[4].timeBasis,'review');
  assert.deepEqual(await fs.readFile(fixture.statePath),bytes); assert.deepEqual(await fs.readdir(fixture.directory),names);
  assert.equal(validateFullState(fixture.snapshot.state).length,0);
  assert.match(renderTimelineOverview(fixture.snapshot.state,history,helpers),/<svg/);
});

test('history rejects tampering, foreign/unanchored files and ignores pending/failed artifacts', async (t) => {
  const fixture = await historyFixture(t,2);
  const names = await fs.readdir(fixture.directory), backup = names.find((name)=>name.startsWith('project-state.json.bak.2.'));
  await fs.appendFile(path.join(fixture.directory,backup),' ');
  await fs.writeFile(path.join(fixture.directory,'project-state.json.bak.999.aaaaaaaa.bbbbbbbb'),'{}');
  await fs.writeFile(path.join(fixture.directory,backup+'.pending'),'bad');
  await fs.writeFile(path.join(fixture.directory,backup+'.failed'),'bad');
  const history = await readTimelineHistory(fixture.statePath,fixture.snapshot);
  assert.equal(history.acceptedBackups,1); assert.equal(history.rejectedBackups,2);
  assert.ok(history.warnings.includes('invalid_backup')); assert.ok(history.warnings.includes('unanchored_backup'));
  assert.ok(history.warnings.includes('version_gap'));
  assert.ok(!JSON.stringify(history).includes(fixture.directory));
});

test('history rejects a fully valid digest-anchored backup from a different review prefix', async (t) => {
  const fixture = await historyFixture(t,3);
  const name = (await fs.readdir(fixture.directory)).find((entry)=>entry.startsWith('project-state.json.bak.3.'));
  const old = JSON.parse(await fs.readFile(path.join(fixture.directory,name),'utf8'));
  old.reviews[0].createdAt = '2026-11-11T00:30:00.000Z';
  assert.deepEqual(validateFullState(old),[]);
  const bytes = Buffer.from(JSON.stringify(old,null,2)+'\n'), digest = sha256Bytes(bytes);
  await fs.writeFile(`${fixture.statePath}.bak.3.${digest.slice(7,15)}.aaaaaaaa`,bytes);
  const snapshot = structuredClone(fixture.snapshot);
  snapshot.state.reviews.find((review)=>review.observedStateVersion===3).observedDigest = digest;
  const result = await readTimelineHistory(fixture.statePath,snapshot);
  assert.ok(!result.samples.some((sample)=>sample.stateVersion===3));
  assert.ok(result.warnings.includes('invalid_backup'));
  assert.equal(await readTimelineSnapshot(fixture.statePath,snapshot,{stateVersion:3,digest}),null);
});

test('history refuses a hard-linked backup and reports bounded partial reads', async (t) => {
  const fixture = await historyFixture(t,3);
  const backup = (await fs.readdir(fixture.directory)).find((name)=>name.startsWith('project-state.json.bak.2.'));
  await fs.link(path.join(fixture.directory,backup),path.join(fixture.directory,'extra-hardlink'));
  const full = await readTimelineHistory(fixture.statePath,fixture.snapshot);
  assert.ok(full.warnings.includes('invalid_backup')); assert.equal(full.acceptedBackups,2);
  const limited = await readTimelineHistory(fixture.statePath,fixture.snapshot,{maxBackups:1});
  assert.ok(limited.warnings.includes('backup_limit')); assert.equal(limited.acceptedBackups,1);
  const small = await readTimelineHistory(fixture.statePath,fixture.snapshot,{maxTotalBytes:1});
  assert.ok(small.warnings.includes('byte_limit')); assert.equal(small.acceptedBackups,0);
});

test('no history never borrows evidence/baseline times as whole-state save time', async (t) => {
  const fixture = await historyFixture(t,0);
  const history = await readTimelineHistory(fixture.statePath,fixture.snapshot,{now:'2026-11-11T12:00:00Z'});
  assert.equal(history.samples.length,1); assert.equal(history.samples[0].timeBasis,'read');
  assert.equal(history.samples[0].at,'2026-11-11T12:00:00Z');
  const unavailable = await readTimelineHistory(path.join(fixture.directory,'missing','state.json'),fixture.snapshot);
  assert.ok(unavailable.warnings.includes('history_unavailable')); assert.equal(unavailable.samples.length,1);
});

test('HTTP exposes only bounded history projections through existing guarded GET state', async (t) => {
  const fixture = await historyFixture(t,2);
  await fixture.store.close();
  const service = await startReviewService(fixture.statePath,{port:0,logger:()=>{}});
  t.after(()=>service.close());
  const session = await getPageSession(service);
  const unauthorized = await httpJson(service.port,'/api/state'); assert.equal(unauthorized.status,403);
  const response = await httpJson(service.port,'/api/state',{headers:{Cookie:session.cookieHeader}});
  assert.equal(response.status,200); assert.equal(response.json.timelineHistory.samples.length,3);
  assert.ok(!JSON.stringify(response.json.timelineHistory).includes(fixture.directory));
  assert.ok(response.json.timelineHistory.samples.every((sample)=>!Object.hasOwn(sample,'state')));
  assert.equal(sha256Bytes(await fs.readFile(fixture.statePath)),fixture.snapshot.fileDigest);
  const extra = await httpJson(service.port,'/api/history?path=outside'); assert.equal(extra.status,404);
});

test('snapshot reads return the exact complete tree, claims and evidence without persisting or replaying', async (t) => {
  const fixture = await historyFixture(t,3);
  const history = await readTimelineHistory(fixture.statePath,fixture.snapshot);
  const bytes = await fs.readFile(fixture.statePath), names = await fs.readdir(fixture.directory);
  const sample = history.samples[1];
  const result = await readTimelineSnapshot(fixture.statePath,fixture.snapshot,sample);
  const backup = names.find((name) => name.startsWith(`project-state.json.bak.2.${sample.digest.slice(7,15)}.`));
  assert.deepEqual(result.state,JSON.parse(await fs.readFile(path.join(fixture.directory,backup),'utf8')));
  assert.equal(result.state.reviews.length,1);
  assert.equal(result.sample.timeBasis,'review');
  assert.equal((await readTimelineSnapshot(fixture.statePath,fixture.snapshot,history.samples[0])).sample.at,null);
  assert.equal(await readTimelineSnapshot(fixture.statePath,fixture.snapshot,{...sample,digest:'sha256:'+'f'.repeat(64)}),null);
  assert.equal(await readTimelineSnapshot(fixture.statePath,fixture.snapshot,{stateVersion:2,digest:'../outside'}),null);
  assert.equal(await readTimelineSnapshot(fixture.statePath,fixture.snapshot,sample,{maxTotalBytes:1}),null);
  assert.deepEqual(await fs.readFile(fixture.statePath),bytes); assert.deepEqual(await fs.readdir(fixture.directory),names);
  await fs.appendFile(path.join(fixture.directory,backup),' ');
  assert.equal(await readTimelineSnapshot(fixture.statePath,fixture.snapshot,sample),null,'must not trust a previously listed backup');
});

test('snapshot endpoint enforces exact selectors, session, host and origin with no paths or writes', async (t) => {
  const fixture = await historyFixture(t,2); await fixture.store.close();
  const service = await startReviewService(fixture.statePath,{port:0,logger:()=>{}}); t.after(()=>service.close());
  const session = await getPageSession(service), headers = {Cookie:session.cookieHeader};
  const state = await httpJson(service.port,'/api/state',{headers});
  const sample = state.json.timelineHistory.samples[1];
  const url = '/api/snapshot?'+new URLSearchParams({version:String(sample.stateVersion),digest:sample.digest});
  assert.equal((await httpJson(service.port,url)).status,403);
  for (const badHeaders of [{Origin:'https://example.invalid'},{Host:'localhost:'+service.port},{'Sec-Fetch-Site':'cross-site'}]) assert.equal((await httpJson(service.port,url,{headers:{...headers,...badHeaders}})).status,403);
  for (const suffix of ['', '?path=outside', '?version=2&version=3&digest='+sample.digest, '?version=02&digest='+sample.digest, '?version=2&digest='+sample.digest+'&path=outside', '?version=2&digest=bad']) {
    assert.equal((await httpJson(service.port,'/api/snapshot'+suffix,{headers})).status,400);
  }
  const response = await httpJson(service.port,url,{headers});
  assert.equal(response.status,200); assert.equal(response.json.writable,false); assert.equal(response.json.historical,true);
  assert.equal(response.json.state.stateVersion,2); assert.equal(response.json.fileDigest,sample.digest);
  assert.equal(response.json.stateIdentity,state.json.stateIdentity);
  assert.equal(response.headers['cache-control'],'no-store');
  assert.ok(!JSON.stringify(response.json).includes(fixture.directory));
  assert.equal((await httpJson(service.port,url,{method:'POST',headers,body:{}})).status,405);
  const names = await fs.readdir(fixture.directory);
  const backup = names.find((name) => name.startsWith('project-state.json.bak.2.'));
  await fs.rename(path.join(fixture.directory,backup),path.join(fixture.directory,backup+'.failed'));
  const missing = await httpJson(service.port,url,{headers});
  assert.equal(missing.status,404); assert.equal(missing.json.code,'snapshot_unavailable');
  assert.equal(sha256Bytes(await fs.readFile(fixture.statePath)),fixture.snapshot.fileDigest);
});

test('injected stores do not authorize historical filesystem reads', async (t) => {
  const fixture = await historyFixture(t,1);
  const service = await startReviewService(fixture.statePath,{port:0,store:fixture.store,logger:()=>{}}); t.after(()=>service.close());
  const session = await getPageSession(service);
  const response = await httpJson(service.port,'/api/snapshot?'+new URLSearchParams({version:'1',digest:fixture.snapshot.state.reviews[0].observedDigest}),{headers:{Cookie:session.cookieHeader}});
  assert.equal(response.status,404);
});

test('timeline marks feature checkpoints as continuation, not review', async () => {
  const feature = JSON.parse(await fs.readFile(new URL('./fixtures/state-0.2-feature-valid.json', import.meta.url), 'utf8'));
  const timeline = deriveTimeline(feature);
  const checkpoints = timeline.events.filter((event) => event.collection === 'featureCheckpoints');
  assert.deepEqual(checkpoints.map((event) => event.recordId), [
    'checkpoint:00000000-0000-4000-8000-000000000001',
    'checkpoint:00000000-0000-4000-8000-000000000002',
    'checkpoint:00000000-0000-4000-8000-000000000003',
  ]);
  assert.deepEqual(checkpoints.map((event) => event.stateVersion), [2, 3, 4]);
  assert.ok(checkpoints.every((event) => event.category === 'checkpoint'));
  assert.ok(checkpoints.every((event) => event.title.includes('续接记录（非评审）')));
  assert.deepEqual(checkpoints.map((event) => event.nodeIds), [['capability:progress-resume'], ['capability:progress-resume'], ['capability:search']]);
  const receipts = timeline.events.filter((event) => event.collection === 'mapUpdates');
  assert.ok(receipts.every((event) => event.category === 'checkpoint' && event.title.startsWith('续接记录（非评审）')));
  assert.ok(!timeline.events.some((event) => event.category === 'review'));
});
