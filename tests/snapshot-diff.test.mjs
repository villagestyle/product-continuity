import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { compareSnapshots } from '../scripts/snapshot-diff.mjs';

const base=()=>({project:{id:'test'},stateVersion:1,nodes:[{id:'a',label:'A',status:'candidate',evidenceIds:[]},{id:'b',label:'B',status:'observed',evidenceIds:[]}],edges:[],evidence:[],intentClaims:[]});
test('snapshot comparison uses stable IDs, chronological direction and exact changed fields',()=>{
  const before=base(),after=structuredClone(before);after.stateVersion=2;
  after.nodes[0].description='New description';after.nodes[0].evidenceIds=['e'];
  after.nodes.pop();after.nodes.push({id:'c',label:'C',status:'unknown',evidenceIds:[]});
  after.edges.push({id:'edge',from:'a',to:'c',kind:'depends_on'});
  after.evidence.push({id:'e',kind:'test_definition',validation:'defined_only'});
  const original=JSON.stringify([before,after]);
  const diff=compareSnapshots(after,before);
  assert.equal(diff.beforeVersion,1);assert.equal(diff.afterVersion,2);assert.equal(diff.gap,false);
  assert.deepEqual(diff.collections.nodes,{added:1,changed:1,removed:1});
  assert.deepEqual(diff.rows.find(r=>r.id==='a').fields.map(f=>f.key),['evidenceIds','description']);
  assert.match(diff.nodeChanges.a.label,/证据链接 \+1/);assert.match(diff.nodeChanges.a.label,/关系 1/);
  assert.equal(diff.nodeChanges.b.kind,'removed');assert.equal(diff.nodeChanges.c.kind,'added');
  assert.equal(JSON.stringify([before,after]),original);
});
test('intent, status and evidence changes remain distinct from removals and completion',()=>{
  const before=base(),after=structuredClone(before);after.stateVersion=4;
  before.intentClaims=[{id:'claim',nodeId:'a',statement:'Before',scope:[],conditions:[],exceptions:[],status:'candidate'}];
  after.intentClaims=[{...before.intentClaims[0],statement:'After',status:'retired'}];
  after.nodes[1].status='retired';
  const diff=compareSnapshots(before,after);
  assert.equal(diff.gap,true);assert.equal(diff.collections.nodes.removed,0);
  assert.match(diff.nodeChanges.a.label,/意图/);assert.match(diff.nodeChanges.b.label,/状态/);
  assert.equal(diff.rows.find(r=>r.id==='claim').fields.find(f=>f.key==='statement').before,'Before');
});
test('unlinked records and collection absence are reported without inventing node changes',()=>{
  const before=base(),after=structuredClone(before);after.stateVersion=2;
  after.nodes.reverse();after.nodes[0]={evidenceIds:[],status:'observed',label:'B',id:'b'};
  after.featureCheckpoints=[];after.checks=[{id:'check',summary:'Observed only'}];
  const diff=compareSnapshots(before,after);
  assert.equal(diff.rows.length,1);assert.deepEqual(Object.keys(diff.nodeChanges),[]);
  assert.equal(diff.rows[0].collection,'checks');
});
test('relationship-linked evidence annotates endpoints without implying intent or execution',()=>{
  const before=base(),after=structuredClone(before);after.stateVersion=2;
  before.edges=[{id:'edge',from:'a',to:'b',kind:'verified_by',evidenceIds:['e']}];
  after.edges=structuredClone(before.edges);
  before.evidence=[{id:'e',kind:'test_definition',claim:'Before',validation:'defined_only'}];
  after.evidence=[{...before.evidence[0],claim:'After'}];
  const diff=compareSnapshots(before,after);
  assert.equal(diff.collections.edges.changed,0);
  assert.deepEqual(diff.rows[0].nodeIds,['a','b']);
  assert.match(diff.nodeChanges.a.label,/证据内容 1/);
  assert.doesNotMatch(diff.nodeChanges.b.label,/确认|完成|通过/);
});
test('field absence differs from null and prototype-like IDs remain ordinary stable IDs',()=>{
  const before=base(),after=structuredClone(before);after.stateVersion=2;
  before.nodes[0].id=after.nodes[0].id='__proto__';after.nodes[0].description=null;
  after.nodes[1].id='constructor';
  const diff=compareSnapshots(before,after),field=diff.rows.find(row=>row.id==='__proto__').fields[0];
  assert.equal(field.beforePresent,false);assert.equal(field.afterPresent,true);
  assert.equal(diff.nodeChanges.__proto__.kind,'changed');
  assert.equal(diff.nodeChanges.constructor.kind,'added');
  assert.equal(Object.getPrototypeOf(diff.nodeChanges),null);
});
test('planning, checkpoints and bookkeeping changes are complete but never promoted to intent confirmation',()=>{
  const before=base(),after=structuredClone(before);after.stateVersion=2;
  after.roadmapItems=[{id:'plan',nodeId:'a',status:'closed',horizon:'later'}];
  after.featureCheckpoints=[{id:'checkpoint',nodeId:'a',summary:'Saved continuation only',remaining:[]}];
  after.mapUpdates=[{id:'maintenance',changedNodeIds:['b']}];
  after.reviews=[{id:'review'}];after.conversationCaptures=[{id:'capture'}];after.decisions=[{id:'decision',nodeIds:['a']}];after.proposals=[{id:'proposal',nodeId:'a'}];
  after.baselines=[{id:'baseline'}];
  const diff=compareSnapshots(before,after);
  assert.equal(Object.keys(diff.collections).length,13);
  assert.equal(diff.rows.length,8);
  assert.match(diff.nodeChanges.a.label,/规划 1 · 续接 1 · 提案 1/);
  assert.equal(diff.nodeChanges.b,undefined);
  assert.equal(diff.collections.nodes.changed,0);
  assert.equal(diff.collections.intentClaims.changed,0);
});
test('browser-embedded comparison is self-contained, rejects foreign/equal versions and preserves unsafe text as data',()=>{
  const before=base(),after=structuredClone(before);after.stateVersion=2;after.nodes[0].label='<img src=x onerror=bad>';
  const result=runInNewContext(`(${compareSnapshots.toString()})(${JSON.stringify(before)},${JSON.stringify(after)})`);
  assert.equal(result.rows[0].title,after.nodes[0].label);
  assert.throws(()=>compareSnapshots(before,before));assert.throws(()=>compareSnapshots(before,{...after,project:{id:'other'}}));
});
