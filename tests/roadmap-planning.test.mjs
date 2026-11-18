import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { applyMapMaintenance } from '../scripts/maintain-map.mjs';
import { applyRoadmapPlan, previewRoadmapPlan } from '../scripts/plan-roadmap.mjs';
import { deriveRoadmap, validateRoadmap } from '../scripts/roadmap-model.mjs';
import { openStateStore, sha256Bytes, validateFullState } from '../scripts/state-store.mjs';
import { readTimelineHistory, readTimelineSnapshot } from '../scripts/timeline-history.mjs';
import { deriveTimeline } from '../scripts/timeline-model.mjs';
import { deferRequest, makeFakeDomain, makeStoreState, uuid } from './store-fixtures.mjs';

const temporaryRoot = path.join(tmpdir(), 'product-continuity-tests');
await fs.mkdir(temporaryRoot, { recursive: true });
const time = '2026-11-12T04:00:00.000Z';
const encode = (state) => Buffer.from(JSON.stringify(state, null, 2) + '\n');
const rejected = (promise, code) => assert.rejects(promise, (error) => { assert.equal(error.code, code, error.message); return true; });

function roadmapItem(overrides = {}) {
  return {
    id:'roadmap:catalog', nodeId:'capability:catalog',
    objective:'Plan synthetic catalog browsing for contract tests',
    scope:['Synthetic planning data only'], exclusions:[], horizon:'now', status:'ready',
    acceptanceCriteria:['Synthetic planning goal, not a test result'], dependsOn:[], blockers:[], closedReason:null,
    ...overrides,
  };
}

function makeRoadmapState() {
  const state = makeStoreState();
  state.project.id = 'project:roadmap-planning';
  state.project.name = 'Roadmap planning synthetic test';
  state.nodes.push(
    {id:'capability:catalog', kind:'capability', label:'Browse catalog', status:'candidate', evidenceIds:[]},
    {id:'capability:search', kind:'capability', label:'Search catalog', status:'candidate', evidenceIds:[]},
  );
  state.roadmapItems = [roadmapItem()];
  return state;
}

function makePlan(digest, stateVersion = 1) {
  return {
    projectId:'project:roadmap-planning', operationId:'roadmap-plan-catalog-checkout',
    expectedStateVersion:stateVersion, expectedDigest:digest,
    authorizationRef:'Synthetic test authorization; not a product approval',
    summary:'Synthetic roadmap planning only',
    items:[
      roadmapItem({horizon:'next', status:'in_progress', objective:'Plan synthetic catalog browsing for contract tests, revised'}),
      roadmapItem({id:'roadmap:checkout', nodeId:'capability:checkout', objective:'Plan synthetic checkout', horizon:'later', status:'idea'}),
    ],
    capabilities:[{id:'capability:checkout', kind:'capability', label:'Checkout', status:'candidate', evidenceIds:[]}],
  };
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'roadmap-planning-'));
  const statePath = path.join(directory, 'project-state.json'), state = makeRoadmapState(), bytes = encode(state);
  await fs.writeFile(statePath, bytes);
  t.after(() => fs.rm(directory, {recursive:true, force:true}));
  return {directory, statePath, state, bytes, plan:makePlan(sha256Bytes(bytes))};
}
const apply = (f, options = {}) => applyRoadmapPlan(f.statePath, f.plan, {authorized:true, clock:time, ...options});
const snapshot = async (statePath) => { const bytes = await fs.readFile(statePath); return {state:JSON.parse(bytes), fileDigest:sha256Bytes(bytes)}; };

test('roadmap schema and model keep old 0.1/0.2 states and reject strict field, reference and cycle errors', async (t) => {
  const old01 = JSON.parse(await fs.readFile(new URL('./fixtures/state-0.1-shared-decision.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateFullState(old01), []);
  const old02 = makeStoreState();
  assert.deepEqual(validateFullState(old02), []);
  assert.deepEqual(validateRoadmap(old02), []);
  assert.equal(deriveRoadmap(old02).total, 0);

  const state = makeRoadmapState();
  assert.deepEqual(validateFullState(state), []);
  assert.deepEqual(validateRoadmap(state), []);
  for (const mutate of [
    (s) => { s.roadmapItems[0].extra = 'not allowed'; },
    (s) => { delete s.roadmapItems[0].closedReason; },
    (s) => { s.roadmapItems[0].status = 'closed'; },
    (s) => { s.roadmapItems[0].closedReason = 'Only closed items may carry this'; },
    (s) => { s.roadmapItems[0].horizon = 'soon'; },
    (s) => { s.roadmapItems[0].scope = ['']; },
  ]) { const invalid = structuredClone(state); mutate(invalid); assert.ok(validateFullState(invalid).length > 0); }

  for (const mutate of [
    (s) => { s.roadmapItems.push({...s.roadmapItems[0]}); },
    (s) => { s.roadmapItems.push(roadmapItem({id:'roadmap:duplicate-node', nodeId:'capability:catalog'})); },
    (s) => { s.roadmapItems[0].nodeId = 'capability:missing'; },
    (s) => { s.roadmapItems[0].nodeId = 'goal:demo'; },
    (s) => { s.roadmapItems[0].dependsOn = ['roadmap:missing']; },
    (s) => { s.roadmapItems[0].dependsOn = ['roadmap:catalog']; },
  ]) { const invalid = structuredClone(state); mutate(invalid); assert.ok(validateRoadmap(invalid).length > 0); }

  const cycle = structuredClone(state);
  cycle.roadmapItems.push(roadmapItem({id:'roadmap:search', nodeId:'capability:search', dependsOn:['roadmap:catalog']}));
  cycle.roadmapItems[0].dependsOn = ['roadmap:search'];
  assert.match(validateRoadmap(cycle).join('\n'), /dependency cycle/);
  assert.ok(validateFullState(cycle).some((error) => /dependency cycle/.test(error)));

  const original = JSON.stringify(state), view = deriveRoadmap(state);
  assert.equal(JSON.stringify(state), original);
  assert.equal(view.total, 1);
  assert.equal(view.byHorizon.now, 1);
  assert.equal(view.items[0].nodeLabel, 'Browse catalog');
  assert.deepEqual(view.items[0].dependencyStatuses, []);
});

test('roadmap preview is read-only and apply needs explicit authorization', async (t) => {
  const f = await fixture(t), names = await fs.readdir(f.directory);
  const result = await previewRoadmapPlan(f.statePath, f.plan, {clock:time});
  assert.equal(result.applied, false); assert.equal(result.replayed, false); assert.equal(result.stateVersion, 2);
  assert.equal(result.changes.source, 'local_roadmap_planning');
  await rejected(applyRoadmapPlan(f.statePath, f.plan), 'roadmap_authorization_required');
  assert.deepEqual(await fs.readdir(f.directory), names);
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
  await assert.rejects(fs.stat(f.statePath + '.review.lock'), {code:'ENOENT'});
});

test('roadmap apply saves exact v1 bytes, one planning receipt and no review, claim or decision', async (t) => {
  const f = await fixture(t), result = await apply(f), saved = await snapshot(f.statePath);
  assert.equal(result.commitStatus, 'verified'); assert.equal(result.stateVersion, 2);
  assert.deepEqual(await fs.readFile(result.backupPath), f.bytes);
  assert.deepEqual(validateFullState(saved.state), []);
  for (const field of ['intentClaims','decisions','reviews','proposals','baselines','project','activeBaselineId','checks','edges','evidence']) assert.deepEqual(saved.state[field], f.state[field]);
  assert.deepEqual(saved.state.nodes.slice(0, f.state.nodes.length), f.state.nodes);
  assert.deepEqual(Object.keys(saved.state.nodes.at(-1)), ['id','kind','label','status','evidenceIds']);
  assert.equal(saved.state.nodes.at(-1).id, 'capability:checkout');
  assert.equal(saved.state.nodes.at(-1).status, 'candidate');
  assert.equal(saved.state.roadmapItems.length, 2);
  assert.deepEqual(saved.state.roadmapItems[0], f.plan.items[0]);
  assert.deepEqual(saved.state.roadmapItems[1], f.plan.items[1]);
  const record = saved.state.mapUpdates[0];
  assert.equal(record.source, 'local_roadmap_planning');
  assert.equal(record.observedDigest, sha256Bytes(f.bytes));
  assert.equal(record.resultingStateVersion, 2);
  assert.deepEqual(record.changedNodeIds, ['capability:checkout']);
  assert.deepEqual(record.changedRoadmapItemIds, ['roadmap:catalog','roadmap:checkout']);
  assert.deepEqual(record.addedEdgeIds, []); assert.deepEqual(record.addedEvidenceIds, []); assert.deepEqual(record.addedCheckIds, []);
  assert.equal(saved.state.reviews.length, 0); assert.equal(saved.state.decisions.length, 0);
  assert.equal(saved.state.intentClaims.length, f.state.intentClaims.length);
  await assert.rejects(fs.stat(f.statePath + '.review.lock'), {code:'ENOENT'});
});

test('roadmap planning rejects rebinding, deletion by omission, forged capabilities and no-op versions', async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    (p) => { p.reviews = []; },
    (p) => { p.items[0].extra = 'not allowed'; },
    (p) => { p.items.push(structuredClone(p.items[0])); },
    (p) => { p.capabilities[0].status = 'confirmed'; },
    (p) => { p.capabilities[0].kind = 'implementation'; },
    (p) => { p.capabilities[0].claims = []; },
    (p) => { p.items[0].closedReason = 'not closed'; },
    (p) => { p.expectedDigest = 'deadbeef'; },
  ]) { const plan = structuredClone(f.plan); mutate(plan); await rejected(previewRoadmapPlan(f.statePath, plan), 'invalid_roadmap_plan'); }

  const rebound = structuredClone(f.plan); rebound.items[0].nodeId = 'capability:search';
  await rejected(previewRoadmapPlan(f.statePath, rebound), 'roadmap_item_boundary');
  const duplicateCapability = structuredClone(f.plan); duplicateCapability.items.push(roadmapItem({id:'roadmap:second-catalog', nodeId:'capability:catalog'}));
  await rejected(previewRoadmapPlan(f.statePath, duplicateCapability), 'roadmap_item_boundary');
  const foreignCapability = structuredClone(f.plan); foreignCapability.capabilities[0].id = 'capability:catalog';
  await rejected(previewRoadmapPlan(f.statePath, foreignCapability), 'roadmap_node_boundary');
  const nonCapabilityTarget = structuredClone(f.plan); nonCapabilityTarget.items[1].nodeId = 'goal:demo';
  await rejected(previewRoadmapPlan(f.statePath, nonCapabilityTarget), 'roadmap_item_boundary');
  const noOp = structuredClone(f.plan); noOp.items = [structuredClone(f.state.roadmapItems[0])]; noOp.capabilities = [];
  await rejected(previewRoadmapPlan(f.statePath, noOp), 'empty_roadmap_plan');
  assert.deepEqual(await fs.readFile(f.statePath), f.bytes);
});

test('roadmap planning closes with an explicit reason and never grants a claim', async (t) => {
  const f = await fixture(t), plan = makePlan(sha256Bytes(f.bytes));
  plan.items = [roadmapItem({status:'closed', closedReason:'Synthetic cancellation reason'})];
  plan.capabilities = [];
  await applyRoadmapPlan(f.statePath, plan, {authorized:true, clock:time});
  const saved = (await snapshot(f.statePath)).state;
  assert.equal(saved.roadmapItems[0].status, 'closed');
  assert.equal(saved.roadmapItems[0].closedReason, 'Synthetic cancellation reason');
  assert.deepEqual(saved.intentClaims, f.state.intentClaims);
  assert.deepEqual(saved.mapUpdates[0].changedRoadmapItemIds, ['roadmap:catalog']);
  assert.deepEqual(saved.mapUpdates[0].changedNodeIds, []);
  assert.equal(saved.mapUpdates[0].source, 'local_roadmap_planning');
});

test('maintenance does not silently change roadmap items and review cannot add them', async (t) => {
  const f = await fixture(t);
  const plan = {
    projectId:f.state.project.id, operationId:'maintenance-with-roadmap', expectedStateVersion:1, expectedDigest:sha256Bytes(f.bytes),
    summary:'Synthetic maintenance only', authorizationRef:'Synthetic test authorization; not a product approval',
    changes:{nodes:[{id:'impl:roadmap-maintenance', kind:'implementation', label:'Synthetic annotation', status:'observed', evidenceIds:[]}], edges:[], evidence:[], checks:[]},
  };
  await applyMapMaintenance(f.statePath, plan, {authorized:true, clock:time});
  const saved = (await snapshot(f.statePath)).state;
  assert.deepEqual(saved.roadmapItems, f.state.roadmapItems);
  assert.equal(saved.mapUpdates[0].source, 'local_map_maintenance');
  assert.ok(!Object.hasOwn(saved.mapUpdates[0], 'changedRoadmapItemIds'));

  const g = await fixture(t), before = await fs.readFile(g.statePath);
  const domain = makeFakeDomain(), applyReview = domain.applyReview;
  domain.applyReview = async (...args) => {
    const result = await applyReview(...args);
    result.state.roadmapItems = result.state.roadmapItems.map((item) => ({...item, horizon:'later'}));
    return result;
  };
  const store = await openStateStore(g.statePath, {renderViews:null, clock:time, domain});
  try {
    const current = await store.read();
    await assert.rejects(store.submitReview(deferRequest({projectId:g.state.project.id, stateVersion:current.stateVersion, digest:current.fileDigest, idempotencyKey:uuid(7), note:'Synthetic review that must not edit the roadmap'})), (error) => {
      assert.equal(error.code, 'state_validation_failed');
      assert.match(String(error.details?.errors), /roadmap planning items/);
      return true;
    });
  } finally { await store.close(); }
  assert.deepEqual(await fs.readFile(g.statePath), before);
});

test('roadmap planning and map maintenance receipts stay schema-distinct', async (t) => {
  const f = await fixture(t); await apply(f);
  const saved = (await snapshot(f.statePath)).state;
  const missing = structuredClone(saved); delete missing.mapUpdates[0].changedRoadmapItemIds;
  assert.ok(validateFullState(missing).length > 0);
  const maintenanceSource = structuredClone(saved); maintenanceSource.mapUpdates[0].source = 'local_map_maintenance';
  assert.ok(validateFullState(maintenanceSource).length > 0);
  const forgedAdds = structuredClone(saved); forgedAdds.mapUpdates[0].addedEdgeIds = ['edge:forged'];
  assert.ok(validateFullState(forgedAdds).length > 0);
});

test('capability-only planning adds no roadmap item and records an empty changed item list', async (t) => {
  const f = await fixture(t), plan = makePlan(sha256Bytes(f.bytes));
  plan.items = [];
  await applyRoadmapPlan(f.statePath, plan, {authorized:true, clock:time});
  const saved = (await snapshot(f.statePath)).state;
  assert.deepEqual(saved.roadmapItems, f.state.roadmapItems);
  assert.deepEqual(saved.mapUpdates[0].changedNodeIds, ['capability:checkout']);
  assert.deepEqual(saved.mapUpdates[0].changedRoadmapItemIds, []);
  assert.deepEqual(saved.intentClaims, f.state.intentClaims);
});

test('roadmap stale version, formatting-only digest changes, live locks and failed readback do not claim success', async (t) => {
  const f = await fixture(t); f.plan.expectedStateVersion = 2;
  await rejected(apply(f), 'stale_roadmap_plan');
  f.plan.expectedStateVersion = 1; await fs.appendFile(f.statePath, ' ');
  await rejected(apply(f), 'stale_roadmap_plan');
  assert.deepEqual((await fs.readdir(f.directory)).sort(), ['project-state.json']);

  const g = await fixture(t), store = await openStateStore(g.statePath, {renderViews:null});
  try { await rejected(apply(g), 'lock_held'); } finally { await store.close(); }
  assert.deepEqual(await fs.readFile(g.statePath), g.bytes);

  const h = await fixture(t);
  await rejected(apply(h, {hooks:{afterRename:() => fs.appendFile(h.statePath, ' ')}}), 'write_unverified');
  assert.equal((await snapshot(h.statePath)).state.stateVersion, 2, 'a replaced state is not silently rolled back');
});

test('identical planning retry is a read-only replay and operation key reuse with other content is rejected', async (t) => {
  const f = await fixture(t), first = await apply(f), bytes = await fs.readFile(f.statePath), names = await fs.readdir(f.directory);
  const again = await apply(f);
  assert.equal(again.replayed, true); assert.equal(again.applied, false); assert.equal(again.record.id, first.record.id);
  assert.deepEqual(await fs.readFile(f.statePath), bytes); assert.deepEqual(await fs.readdir(f.directory), names);
  f.plan.summary += ' different'; await rejected(apply(f), 'roadmap_key_conflict');
  const g = await fixture(t), results = await Promise.allSettled([apply(g), apply(g)]);
  assert.equal(results.filter((item) => item.status === 'fulfilled' && item.value.applied).length, 1);
  assert.equal((await snapshot(g.statePath)).state.mapUpdates.length, 1);
});

test('planning history keeps exact v1/v2 snapshots and labels the record as planning, not review', async (t) => {
  const f = await fixture(t), result = await apply(f);
  const saved = await snapshot(f.statePath), history = await readTimelineHistory(f.statePath, saved);
  assert.deepEqual(history.samples.map((item) => item.stateVersion), [1,2]);
  assert.deepEqual(history.samples.map((item) => item.timeBasis), ['unknown','planning']);
  assert.equal(history.samples[1].at, time); assert.equal(history.rejectedBackups, 0);
  assert.deepEqual(await fs.readFile(result.backupPath), f.bytes);
  const v1 = await readTimelineSnapshot(f.statePath, saved, history.samples[0]);
  assert.deepEqual(v1.state, f.state);
  const v2 = await readTimelineSnapshot(f.statePath, saved, history.samples[1]);
  assert.deepEqual(v2.state, saved.state);
  const planning = deriveTimeline(saved.state).events.find((event) => event.category === 'planning');
  assert.match(planning.title, /规划记录（非评审）/);
  assert.equal(planning.stateVersion, 2);
  assert.ok(planning.nodeIds.includes('capability:catalog'));
  assert.ok(planning.nodeIds.includes('capability:checkout'));
  assert.equal(deriveTimeline(saved.state).events.filter((event) => event.category === 'review').length, 0);
});

test('planning history combines with a later review and still selects the planned v2 snapshot', async (t) => {
  const f = await fixture(t); await apply(f);
  const store = await openStateStore(f.statePath, {renderViews:null, clock:time});
  try {
    const current = await store.read();
    await store.submitReview(deferRequest({projectId:f.state.project.id, stateVersion:2, digest:current.fileDigest, idempotencyKey:uuid(8)}));
  } finally { await store.close(); }
  const saved = await snapshot(f.statePath), history = await readTimelineHistory(f.statePath, saved);
  assert.deepEqual(history.samples.map((item) => item.stateVersion), [1,2,3]);
  assert.deepEqual(history.samples.map((item) => item.timeBasis), ['unknown','planning','review']);
  const planned = await readTimelineSnapshot(f.statePath, saved, history.samples[1]);
  assert.equal(planned.state.roadmapItems[1].id, 'roadmap:checkout');
  assert.deepEqual(planned.state.reviews, []);
  assert.equal(await readTimelineSnapshot(f.statePath, saved, {stateVersion:9, digest:'sha256:' + 'f'.repeat(64)}), null);
});

test('history rejects an anchored backup whose roadmap change has no planning receipt', async (t) => {
  const f = await fixture(t);
  const maintenance = (operationId, version, digest, node) => ({
    projectId:f.state.project.id, operationId, expectedStateVersion:version, expectedDigest:digest,
    summary:'Synthetic maintenance for roadmap history test', authorizationRef:'Synthetic test authorization; not a product approval',
    changes:{nodes:[node], edges:[], evidence:[], checks:[]},
  });
  await applyMapMaintenance(f.statePath, maintenance('history-maint-1', 1, sha256Bytes(f.bytes), {id:'impl:history', kind:'implementation', label:'Synthetic', status:'observed', evidenceIds:[]}), {authorized:true, clock:time});
  const v2 = await snapshot(f.statePath);
  v2.state.roadmapItems.push(roadmapItem({id:'roadmap:unexplained', nodeId:'capability:search', objective:'Silently added without a planning receipt'}));
  const forgedBytes = encode(v2.state);
  await fs.writeFile(f.statePath, forgedBytes);
  await applyMapMaintenance(f.statePath, maintenance('history-maint-2', 2, sha256Bytes(forgedBytes), {id:'impl:history', kind:'implementation', label:'Synthetic', description:'Later note', status:'observed', evidenceIds:[]}), {authorized:true, clock:time});
  const saved = await snapshot(f.statePath), history = await readTimelineHistory(f.statePath, saved);
  assert.ok(history.warnings.includes('invalid_backup'));
  assert.ok(history.warnings.includes('unexplained_roadmap_change'));
  assert.deepEqual(history.samples.map((item) => item.stateVersion), [3], 'both endpoints of an unexplained historical interval are excluded; no trusted anchor determines which was rewritten');
  assert.equal(history.rejectedBackups, 2);
});

test('historical planning receipts cannot explain a deleted or rebound stable item identity', async (t) => {
  for (const rebind of [false,true]) {
    const f = await fixture(t); await apply(f);
    const saved = await snapshot(f.statePath), current = saved.state.roadmapItems[0];
    // Simulate an externally rewritten current file. Keep it structurally valid
    // and keep a receipt listing this ID: a receipt is not permission to delete
    // or swap the feature binding, even if a later writer saved those bytes.
    saved.state.roadmapItems = rebind
      ? [{...current,nodeId:'capability:search'},saved.state.roadmapItems[1]]
      : saved.state.roadmapItems.filter(item=>item.id!==current.id);
    if (!rebind) saved.state.mapUpdates[0].changedRoadmapItemIds = ['roadmap:checkout'];
    const bytes = encode(saved.state); await fs.writeFile(f.statePath,bytes);
    assert.deepEqual(validateFullState(saved.state),[]);
    const history = await readTimelineHistory(f.statePath,{state:saved.state,fileDigest:sha256Bytes(bytes)});
    assert.deepEqual(history.samples.map(sample=>sample.stateVersion),[2]);
    assert.ok(history.warnings.includes('unexplained_roadmap_change'));
    assert.equal(await readTimelineSnapshot(f.statePath,{state:saved.state,fileDigest:sha256Bytes(bytes)},{stateVersion:1,digest:sha256Bytes(f.bytes)}),null);
    assert.deepEqual(await fs.readFile(f.statePath),bytes,'history must not repair or roll back current bytes');
  }
});
