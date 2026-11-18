import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { resolveProjectBinding, runTool, normaliseToolArguments } from '../scripts/mcp-context.mjs';
import { makeTempDir } from './store-fixtures.mjs';
import { CAPABILITY, ROADMAP, encode, makeItem, makeMcpState, writeFixture } from './mcp-fixtures.mjs';

async function fixture(t,options) {
  const root=await makeTempDir('mcp-context-');t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const state=makeMcpState(options);const statePath=path.join(root,'state.json');await writeFixture(statePath,state);
  const binding=await resolveProjectBinding({projectRoot:root,state:'state.json',projectId:state.project.id});
  return {root,state,statePath,binding,args:{projectId:state.project.id}};
}
const rejectCode=(promise,code)=>assert.rejects(promise,error=>error.code===code);

test('MCP returns full governing ancestor/constraint claims, history, decisions, evidence and unknowns without writes',async(t)=>{
  const f=await fixture(t,{confirmed:true});const before=await fs.readFile(f.statePath), names=await fs.readdir(f.root);
  const value=await runTool('context_get',f.binding,{...f.args,roadmapItemIds:[ROADMAP]});
  assert.equal(value.authorization.roadmapGrantsImplementationPermission,false);
  assert.equal(value.roadmapItems[0].acceptanceCriteriaRole,'planning_targets_not_test_results');
  assert.ok(value.intentClaims.some(c=>c.status==='confirmed'));
  assert.ok(value.intentClaims.some(c=>c.status==='superseded'));
  const confirmed=value.intentClaims.find(c=>c.status==='confirmed');
  assert.deepEqual(confirmed.intent,{statement:'Only local synthetic records; no remote upload.',scope:['Local records'],conditions:['User initiated'],exceptions:['Never send private data']});
  assert.equal(value.intentClaims.find(c=>c.nodeId===CAPABILITY).interpretation,'candidate_not_confirmed_intent');
  assert.ok(value.decisions.some(d=>d.kind==='adopt_intent'));
  assert.ok(value.evidence.some(e=>e.kind==='test_definition'&&e.isDefinition&&!e.isExecution&&e.validation==='defined_only'));
  assert.equal(value.evidence.some(e=>e.kind==='test_execution'),false);
  assert.equal(value.unknowns[0].id,'unknown:mcp');
  assert.equal(value.coverage.truncated,false);assert.ok(value.coverage.selectionRules.length);
  assert.match(value.state.fileDigest,/^sha256:[a-f0-9]{64}$/);assert.ok(Number.isFinite(Date.parse(value.state.readAt)));
  assert.deepEqual(await fs.readFile(f.statePath),before);assert.deepEqual(await fs.readdir(f.root),names);
  value.intentClaims[0].statement='caller mutation';
  assert.notEqual((await runTool('context_get',f.binding,{...f.args,nodeIds:[CAPABILITY]})).intentClaims[0].statement,'caller mutation');
});

test('MCP exact evidence paths select related context but never read or execute source files',async(t)=>{
  const f=await fixture(t);await fs.mkdir(path.join(f.root,'fixtures'));
  const source=path.join(f.root,'fixtures/record.mjs');await fs.writeFile(source,'throw new Error("DO NOT EXECUTE"); SECRET_SOURCE_NOT_CONTEXT');
  const value=await runTool('context_get',f.binding,{...f.args,files:['./fixtures\\record.mjs'],task:'Implement synthetic record'});
  assert.deepEqual(value.matched.files,['fixtures/record.mjs']);assert.ok(value.evidence.some(e=>e.path==='fixtures/record.mjs'));
  assert.ok(value.intentClaims.some((claim)=>claim.nodeId===CAPABILITY),'implementation-path selection traces back to its owning capability intent');
  assert.equal(JSON.stringify(value).includes('SECRET_SOURCE_NOT_CONTEXT'),false);
  assert.equal(value.selectors.task.semanticSearchPerformed,false);
  const no=await runTool('context_get',f.binding,{...f.args,files:['fixtures/no-file.mjs']});
  assert.equal(no.status,'no_match');assert.equal(no.nodes.length,0);assert.deepEqual(no.unmatched.files,['fixtures/no-file.mjs']);
});

test('MCP strictly rejects injected selectors, task-only search, cross-project and response overflows',async(t)=>{
  const f=await fixture(t);
  for(const args of [{...f.args,path:'elsewhere'},{...f.args,files:['../state.json']},{...f.args,files:['C:\\private']},{...f.args,files:['//server/share']},{...f.args,nodeIds:[CAPABILITY,CAPABILITY]},{...f.args,task:'semantic search only'},{...f.args,nodeIds:[CAPABILITY],task:null}]) {
    assert.throws(()=>normaliseToolArguments('context_get',args));
  }
  await rejectCode(runTool('project_get',f.binding,{projectId:'different'}),'project_mismatch');
  await rejectCode(runTool('context_get',f.binding,{...f.args,nodeIds:[CAPABILITY]},{limits:{maxClaims:1}}),'result_too_large');
  await rejectCode(runTool('context_get',f.binding,{...f.args,nodeIds:[CAPABILITY]},{limits:{maxNodes:1}}),'result_too_large');
  await rejectCode(runTool('context_get',f.binding,{...f.args,nodeIds:[CAPABILITY]},{limits:{maxResponseBytes:100}}),'result_too_large');
  assert.equal((await runTool('map_query',f.binding,f.args)).status,'ok');
});

test('MCP direct planning dependencies are complete records but never pretend to be recursive intent context', async (t) => {
  const f = await fixture(t);
  for (const suffix of ['second','third']) {
    f.state.nodes.push({id:'capability:'+suffix,kind:'capability',label:'Synthetic '+suffix,status:'candidate',evidenceIds:[]});
    f.state.roadmapItems.push(makeItem({id:'roadmap:'+suffix,nodeId:'capability:'+suffix,objective:'Full dependency target '+suffix,scope:['Dependency scope '+suffix],acceptanceCriteria:['Future goal '+suffix],dependsOn:suffix==='second'?['roadmap:third']:[]}));
  }
  f.state.roadmapItems[0].dependsOn = ['roadmap:second']; await fs.writeFile(f.statePath,encode(f.state));
  const value = await runTool('context_get',f.binding,{...f.args,roadmapItemIds:[ROADMAP]});
  assert.deepEqual(value.roadmapDependencyItems.map(item=>item.id),['roadmap:second']);
  assert.deepEqual(value.roadmapDependencyItems[0].scope,['Dependency scope second']);
  assert.deepEqual(value.roadmapDependencyItems[0].dependsOn,['roadmap:third']);
  assert.equal(value.nodes.some(node=>node.id==='capability:second'),false);
  assert.match(value.boundaries.join('\n'),/not recursively expanded intent context/);
  const second = await runTool('context_get',f.binding,{...f.args,roadmapItemIds:['roadmap:second']});
  assert.deepEqual(second.roadmapDependencyItems.map(item=>item.id),['roadmap:third']);
  await rejectCode(runTool('context_get',f.binding,{...f.args,roadmapItemIds:[ROADMAP]},{limits:{maxRoadmapItems:1}}),'result_too_large');
});

test('MCP re-reads and validates every request; invalid or foreign replacements never use stale cache',async(t)=>{
  const f=await fixture(t);assert.equal((await runTool('project_get',f.binding,f.args)).state.stateVersion,1);
  for(const [bytes,code] of [[Buffer.from('{'),'invalid_state'],[Buffer.from([0xff]),'invalid_state'],[encode({...f.state,schemaVersion:'9'}),'unsupported_schema'],[encode({...f.state,project:{...f.state.project,id:'foreign'}}),'project_mismatch'],[encode({...f.state,roadmapItems:[makeItem({dependsOn:['missing']})]}),'invalid_state']]) {
    await fs.writeFile(f.statePath,bytes);await rejectCode(runTool('project_get',f.binding,f.args),code);
  }
  await fs.unlink(f.statePath);await rejectCode(runTool('project_get',f.binding,f.args),'state_not_found');
  await fs.writeFile(f.statePath,encode({...f.state,stateVersion:2}));assert.equal((await runTool('project_get',f.binding,f.args)).state.stateVersion,2);
  await rejectCode(runTool('project_get',f.binding,f.args,{limits:{maxStateBytes:10}}),'state_too_large');
});

test('MCP root binding prevents outside paths, hardlinks and later parent junction substitution',async(t)=>{
  const f=await fixture(t), outside=await makeTempDir('mcp-outside-');t.after(()=>fs.rm(outside,{recursive:true,force:true}));
  await writeFixture(path.join(outside,'state.json'),f.state);
  await rejectCode(resolveProjectBinding({projectRoot:f.root,state:path.join(outside,'state.json'),projectId:f.state.project.id}),'state_outside_project_root');
  await fs.link(f.statePath,path.join(f.root,'alias.json'));
  await rejectCode(runTool('project_get',f.binding,f.args),'state_unreadable');await fs.unlink(path.join(f.root,'alias.json'));
  const inner=path.join(f.root,'inner');await fs.mkdir(inner);await writeFixture(path.join(inner,'state.json'),f.state);
  const binding=await resolveProjectBinding({projectRoot:f.root,state:'inner/state.json',projectId:f.state.project.id});
  await fs.rename(inner,path.join(f.root,'original-inner'));
  await fs.symlink(outside,inner,'junction');
  await rejectCode(runTool('project_get',binding,f.args),'state_path_changed');
});

test('MCP frozen 0.1 state and old 0.2 states are read without migration or planning invention',async(t)=>{
  const f=await fixture(t,{roadmap:false});
  assert.equal((await runTool('project_get',f.binding,f.args)).roadmap.present,false);
  const old=JSON.parse(await fs.readFile(new URL('./fixtures/state-0.1-shared-decision.json',import.meta.url),'utf8'));
  await fs.writeFile(f.statePath,encode(old));const binding={...f.binding,projectId:old.project.id};
  const value=await runTool('context_get',binding,{projectId:old.project.id,nodeIds:[old.nodes[0].id]});
  assert.equal(value.state.schemaVersion,'0.1');assert.deepEqual(value.intentClaims,[]);assert.deepEqual(value.roadmapItems,[]);
  assert.match(value.boundaries.join('\n'),/schema 0.1/);
});
