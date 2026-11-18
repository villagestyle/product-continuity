import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { applyMapMaintenance, previewMapMaintenance } from '../scripts/maintain-map.mjs';
import { openStateStore, sha256Bytes, validateFullState } from '../scripts/state-store.mjs';
import { readTimelineHistory, readTimelineSnapshot } from '../scripts/timeline-history.mjs';
import { deriveProgress, deriveTimeline } from '../scripts/timeline-model.mjs';
import { renderTimelineOverview } from '../scripts/timeline-ui.mjs';
import { startReviewService } from '../scripts/review-service.mjs';
import { getPageSession, httpJson } from './http-test-helpers.mjs';
import { ACCEPTANCE_TARGET, makeAcceptanceState } from './acceptance-fixtures.mjs';

const temporaryRoot = path.join(tmpdir(), 'product-continuity-tests');
await fs.mkdir(temporaryRoot, { recursive: true });
const time = '2026-11-12T03:00:00.000Z';
const encode = (state) => Buffer.from(JSON.stringify(state, null, 2) + '\n');
const rejected = (promise, code) => assert.rejects(promise, (error) => { assert.equal(error.code, code, error.message); return true; });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'map-maintenance-'));
  const statePath = path.join(directory, 'project-state.json'), state = makeAcceptanceState(), bytes = encode(state);
  await fs.writeFile(statePath, bytes);
  t.after(() => fs.rm(directory, {recursive:true, force:true}));
  const plan = {
    projectId:state.project.id, operationId:'synthetic-map-update', expectedStateVersion:1, expectedDigest:sha256Bytes(bytes),
    summary:'Synthetic implementation evidence only', authorizationRef:'Synthetic test authorization, not a product approval',
    changes:{
      nodes:[{id:'impl:time-travel',kind:'implementation',label:'Synthetic v2 branch',status:'observed',evidenceIds:['evidence:execution']}],
      edges:[{id:'edge:time-travel',from:'task:acceptance',kind:'implemented_by',to:'impl:time-travel'}],
      evidence:[{id:'evidence:execution',kind:'test_execution',claim:'Synthetic execution record for contract tests, not a product result',validation:'passed',observedAt:time}],
      checks:[],
    },
  };
  return {directory, statePath, state, bytes, plan};
}
const apply = (f, options = {}) => applyMapMaintenance(f.statePath, f.plan, {authorized:true, clock:time, ...options});
const snapshot = async (statePath) => { const bytes = await fs.readFile(statePath); return {state:JSON.parse(bytes), fileDigest:sha256Bytes(bytes)}; };

test('maintenance preview is read-only and apply needs explicit authorization', async (t) => {
  const f = await fixture(t), names = await fs.readdir(f.directory);
  const result = await previewMapMaintenance(f.statePath, f.plan, {clock:time});
  assert.equal(result.stateVersion, 2); assert.equal(result.applied, false);
  await rejected(applyMapMaintenance(f.statePath, f.plan), 'maintenance_authorization_required');
  assert.deepEqual(await fs.readdir(f.directory), names); assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
});

test('maintenance saves v2 with exact v1 raw bytes and no human review or confirmation', async (t) => {
  const f = await fixture(t), result = await apply(f), saved = await snapshot(f.statePath);
  assert.equal(result.commitStatus, 'verified'); assert.equal(result.stateVersion, 2);
  assert.deepEqual(await fs.readFile(result.backupPath), f.bytes);
  assert.equal(result.digest, saved.fileDigest); assert.deepEqual(validateFullState(saved.state), []);
  for (const field of ['intentClaims','decisions','reviews','proposals','baselines','project','activeBaselineId','checks']) assert.deepEqual(saved.state[field], f.state[field]);
  for (const field of ['nodes','edges','evidence']) assert.deepEqual(saved.state[field].slice(0, f.state[field].length), f.state[field]);
  assert.equal(saved.state.mapUpdates[0].observedDigest, sha256Bytes(f.bytes));
  assert.equal(saved.state.mapUpdates[0].source, 'local_map_maintenance');
  await assert.rejects(fs.stat(f.statePath + '.review.lock'), {code:'ENOENT'});
  assert.ok(!(await fs.readdir(f.directory)).includes('product-map.review.html'));
});

test('maintenance-only v1 is exactly anchored; its unknown save time is not backdated', async (t) => {
  const f = await fixture(t); await apply(f);
  const saved = await snapshot(f.statePath), names = await fs.readdir(f.directory);
  const history = await readTimelineHistory(f.statePath, saved);
  assert.deepEqual(history.samples.map((item) => item.stateVersion), [1,2]);
  assert.equal(history.samples[0].at, null); assert.equal(history.samples[0].timeBasis, 'unknown');
  assert.equal(history.samples[1].timeBasis, 'maintenance'); assert.equal(history.samples[1].at, time);
  assert.equal(history.rejectedBackups, 0);
  assert.deepEqual((await readTimelineSnapshot(f.statePath, saved, history.samples[0])).state, f.state);
  assert.deepEqual(await fs.readdir(f.directory), names);
  const projection = deriveTimeline(saved.state), event = projection.events.find((item) => item.category === 'maintenance');
  assert.equal(event.collection, 'mapUpdates'); assert.equal(event.stateVersion, 2); assert.match(event.title, /非人工评审/);
  const html = renderTimelineOverview(saved.state, history, {deriveProgress});
  assert.match(html, /维护记录，非评审/); assert.doesNotMatch(html, /<svg/);
});

test('identical retry is a read-only replay; operation key reuse with different payload is rejected', async (t) => {
  const f = await fixture(t), first = await apply(f), names = await fs.readdir(f.directory), bytes = await fs.readFile(f.statePath);
  const again = await apply(f); assert.equal(again.replayed, true); assert.equal(again.applied, false); assert.equal(again.record.id, first.record.id);
  f.plan.summary += ' different'; await rejected(apply(f), 'maintenance_key_conflict');
  assert.deepEqual(await fs.readFile(f.statePath), bytes); assert.deepEqual(await fs.readdir(f.directory), names);
});

test('stale version and formatting-only digest changes do not write or produce backups', async (t) => {
  const f = await fixture(t); f.plan.expectedStateVersion = 2;
  await rejected(apply(f), 'stale_maintenance_plan');
  f.plan.expectedStateVersion = 1; await fs.appendFile(f.statePath, ' ');
  await rejected(apply(f), 'stale_maintenance_plan');
  assert.deepEqual(await fs.readdir(f.directory), ['project-state.json']);
});

test('live review store lock prevents maintenance; concurrent maintenance commits at most once', async (t) => {
  const f = await fixture(t), store = await openStateStore(f.statePath, {renderViews:null});
  const lockBytes = await fs.readFile(f.statePath + '.review.lock');
  await rejected(apply(f), 'lock_held'); assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
  assert.deepEqual(await fs.readFile(f.statePath + '.review.lock'), lockBytes); await store.close();
  const results = await Promise.allSettled([apply(f), apply(f)]);
  assert.equal(results.filter((item) => item.status === 'fulfilled' && item.value.applied).length, 1);
  assert.equal((await snapshot(f.statePath)).state.mapUpdates.length, 1);
});

test('strict maintenance plan rejects protected top-level fields and invalid/duplicate data', async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    (p) => { p.reviews = []; }, (p) => { p.changes.intentClaims = []; },
    (p) => { p.expectedDigest = 'deadbeef'; }, (p) => { p.expectedStateVersion = Number.MAX_SAFE_INTEGER; },
    (p) => { p.changes.nodes.push(p.changes.nodes[0]); }, (p) => { p.authorizationRef = ' '; },
  ]) { const plan = structuredClone(f.plan); mutate(plan); await rejected(applyMapMaintenance(f.statePath, plan, {authorized:true}), 'invalid_maintenance_plan'); }
  const foreign = {...f.plan, projectId:'another-project'}; await rejected(applyMapMaintenance(f.statePath, foreign, {authorized:true}), 'project_mismatch');
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
});

test('maintenance rejects creating intent nodes, changing intent labels/status and decision evidence', async (t) => {
  const f = await fixture(t);
  for (const node of [
    {id:'new-intent',kind:'capability',label:'Not authorized',status:'candidate',evidenceIds:[]},
    {...f.state.nodes[0],label:'Rewritten intent'}, {...f.state.nodes[0],status:'confirmed'},
    {...f.state.nodes[0],kind:'implementation',status:'observed'},
  ]) { const plan = structuredClone(f.plan); plan.changes.nodes = [node]; await rejected(applyMapMaintenance(f.statePath, plan, {authorized:true}), 'maintenance_intent_boundary'); }
  f.plan.changes.evidence[0].kind = 'decision_record';
  await rejected(apply(f), 'maintenance_intent_boundary'); assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
});

test('node annotations may add source links, but old evidence/edges/checks cannot be rewritten or removed', async (t) => {
  const f = await fixture(t);
  f.plan.changes.nodes.push({...f.state.nodes[2],description:'Implementation status only; not a new intent',evidenceIds:[...f.state.nodes[2].evidenceIds,'evidence:execution']});
  await apply(f);
  assert.deepEqual((await snapshot(f.statePath)).state.intentClaims, f.state.intentClaims);
  const g = await fixture(t);
  g.plan.changes.nodes.push({...g.state.nodes[2],evidenceIds:[]}); await rejected(apply(g), 'maintenance_history_boundary');
  g.plan.changes.nodes.pop(); g.plan.changes.evidence.push({...g.state.evidence[0],claim:'rewrite'}); await rejected(apply(g), 'maintenance_history_boundary');
  g.plan.changes.evidence.pop(); g.plan.changes.edges.push({...g.state.edges[0],to:'impl:time-travel'}); await rejected(apply(g), 'maintenance_history_boundary');
});

test('no-op, dangling refs and invalid test claims fail before persistence', async (t) => {
  const f = await fixture(t), empty = {...f.plan,changes:{nodes:[f.state.nodes[0]],edges:[],evidence:[],checks:[]}};
  await rejected(applyMapMaintenance(f.statePath, empty, {authorized:true}), 'empty_maintenance_plan');
  f.plan.changes.edges[0].to = 'missing'; await rejected(apply(f), 'state_validation_failed');
  f.plan.changes.edges[0].to = 'impl:time-travel'; f.plan.changes.evidence[0].kind = 'test_definition';
  await rejected(apply(f), 'state_validation_failed'); assert.deepEqual(await fs.readdir(f.directory), ['project-state.json']);
});

test('maintenance snapshots coexist with later review actions and retain both append-only prefixes', async (t) => {
  const f = await fixture(t); await apply(f);
  const store = await openStateStore(f.statePath, {renderViews:null, clock:time});
  try {
    const before = await store.read();
    await store.submitReview({projectId:f.state.project.id,action:'defer',targetClaimId:ACCEPTANCE_TARGET,payload:{reason:'needs_evidence'},expectedStateVersion:2,expectedDigest:before.fileDigest,idempotencyKey:randomUUID()});
    const after = await store.read();
    assert.deepEqual(after.state.mapUpdates, before.state.mapUpdates); assert.equal(after.state.reviews.length, 1);
    const history = await readTimelineHistory(f.statePath, after);
    assert.deepEqual(history.samples.map((item) => item.stateVersion), [1,2,3]);
    assert.deepEqual(history.samples.map((item) => item.timeBasis), ['unknown','maintenance','review']);
  } finally { await store.close(); }
});

test('maintenance history rejects changed raw bytes and changed append-only prefixes even with a matching anchor', async (t) => {
  const f = await fixture(t), first = await apply(f), second = await snapshot(f.statePath);
  const plan2 = {...f.plan,operationId:'second-map-update',expectedStateVersion:2,expectedDigest:second.fileDigest,changes:{nodes:[{...second.state.nodes.at(-1),label:'Next annotation'}],edges:[],evidence:[],checks:[]}};
  await applyMapMaintenance(f.statePath, plan2, {authorized:true, clock:time});
  await fs.appendFile(first.backupPath, ' ');
  const current = await snapshot(f.statePath), history = await readTimelineHistory(f.statePath, current);
  assert.ok(!history.samples.some((item) => item.stateVersion === 1)); assert.ok(history.warnings.includes('invalid_backup'));
  const v2 = structuredClone(second.state); v2.mapUpdates[0].summary = 'An unrelated prefix';
  const bytes = encode(v2), digest = sha256Bytes(bytes);
  await fs.writeFile(`${f.statePath}.bak.2.${digest.slice(7,15)}.aaaaaaaa`, bytes);
  current.state.mapUpdates[1].observedDigest = digest;
  assert.equal(await readTimelineSnapshot(f.statePath, current, {stateVersion:2,digest}), null);
});

test('map update schema/invariants reject forged source, missing refs, duplicate IDs/versions and future versions', async (t) => {
  const f = await fixture(t); await apply(f); const saved = (await snapshot(f.statePath)).state;
  for (const mutate of [
    (s) => { s.mapUpdates[0].source = 'local_review_ui'; },
    (s) => { s.mapUpdates[0].observedDigest = 'bad'; },
    (s) => { s.mapUpdates[0].resultingStateVersion = 3; },
    (s) => { s.mapUpdates[0].changedNodeIds = ['missing']; },
    (s) => { s.mapUpdates.push({...s.mapUpdates[0]}); },
    (s) => { s.mapUpdates[0].resultingDigest = 'sha256:'+'0'.repeat(64); },
  ]) { const invalid = structuredClone(saved); mutate(invalid); assert.ok(validateFullState(invalid).length); }
});

test('backup failure preserves main bytes, releases our lock and leaves diagnostics', async (t) => {
  const f = await fixture(t);
  await rejected(apply(f, {hooks:{beforeBackupWrite:() => { throw new Error('synthetic backup failure'); }}}), 'backup_failed');
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
  await assert.rejects(fs.stat(f.statePath+'.review.lock'), {code:'ENOENT'});
  assert.ok((await fs.readdir(f.directory)).some((name) => name.endsWith('.failed')));
});

test('external bytes and lock loss during transaction are not overwritten or force-unlocked', async (t) => {
  const f = await fixture(t), external = Buffer.concat([f.bytes, Buffer.from(' ')]);
  await rejected(apply(f, {hooks:{beforeReread:() => fs.writeFile(f.statePath, external)}}), 'external_modification');
  assert.deepEqual(await fs.readFile(f.statePath), external);
  const g = await fixture(t), foreign = JSON.stringify({token:'synthetic-foreign-token',pid:0});
  await rejected(apply(g, {hooks:{beforeBackupWrite:() => fs.writeFile(g.statePath+'.review.lock', foreign)}}), 'lock_lost');
  assert.equal(await fs.readFile(g.statePath+'.review.lock','utf8'), foreign); assert.deepEqual(await fs.readFile(g.statePath), g.bytes);
});

test('failed replacement and failed post-write validation never report a verified save', async (t) => {
  const f = await fixture(t);
  await rejected(apply(f, {io:{rename:async (from, to) => { if (to === f.statePath) throw Object.assign(new Error('synthetic rename refusal'), {code:'EBUSY'}); return fs.rename(from,to); }}}), 'replace_failed_preserved');
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
  const g = await fixture(t);
  await rejected(apply(g, {hooks:{afterRename:() => fs.appendFile(g.statePath,' ')}}), 'write_unverified');
  assert.equal((await snapshot(g.statePath)).state.stateVersion, 2, 'do not roll back a replaced state');
});

test('hard-linked main state is refused and caller plan is snapshotted before asynchronous work', async (t) => {
  const f = await fixture(t); await fs.link(f.statePath,path.join(f.directory,'alias.json'));
  await rejected(apply(f), 'hardlink_state'); assert.deepEqual(await fs.readFile(f.statePath),f.bytes);
  const g = await fixture(t), promise = apply(g); g.plan.changes.nodes[0].label = 'late caller mutation';
  await promise; assert.equal((await snapshot(g.statePath)).state.nodes.at(-1).label, 'Synthetic v2 branch');
});

test('HTTP reads maintenance history and exact v1 without offering maintenance writes', async (t) => {
  const f = await fixture(t); await apply(f);
  const service = await startReviewService(f.statePath,{port:0,logger:()=>{}}); t.after(() => service.close());
  const session = await getPageSession(service), headers = {};
  headers.Cookie = session.cookieHeader;
  const response = await httpJson(service.port,'/api/state',{headers});
  assert.equal(response.status,200); assert.equal(response.json.timelineHistory.samples.length,2);
  const url = '/api/snapshot?'+new URLSearchParams({version:'1',digest:sha256Bytes(f.bytes)});
  const old = await httpJson(service.port,url,{headers}); assert.equal(old.status,200); assert.equal(old.json.writable,false); assert.deepEqual(old.json.state,f.state);
  assert.equal(old.headers['cache-control'],'no-store');
  assert.equal((await httpJson(service.port,'/api/maintenance',{method:'POST',headers,body:f.plan})).status,404);
  assert.equal((await snapshot(f.statePath)).state.stateVersion,2);
});
