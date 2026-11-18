import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempDir } from './store-fixtures.mjs';
import { startReviewService } from '../scripts/review-service.mjs';
import { readTimelineHistory, readTimelineSnapshot } from '../scripts/timeline-history.mjs';
import { CAPABILITY, ROADMAP, makeItem, makeMcpState, makePlan, stored, startMcp, toolValue, writeFixture } from './mcp-fixtures.mjs';

const cli=fileURLToPath(new URL('../scripts/plan-roadmap.mjs',import.meta.url));
async function command(args) {
  const p=spawn(process.execPath,[cli,...args],{stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);
  const code=await new Promise((resolve,reject)=>{p.once('error',reject);p.once('exit',resolve);});
  return {code,out,err,value:JSON.parse(out||err)};
}
test('real offline CLI preview/apply and a persistent stdio MCP retain decisions, exact history and fresh versions',async(t)=>{
  const root=await makeTempDir('roadmap-mcp-integration-');t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const state=makeMcpState({confirmed:true,roadmap:false}),statePath=path.join(root,'state.json');const bytes=await writeFixture(statePath,state);
  const planPath=path.join(root,'plan.json');await fs.writeFile(planPath,JSON.stringify(makePlan(state,bytes,[makeItem()])));
  const server=startMcp(root,state.project.id);t.after(()=>server.kill());await server.initialize();
  const first=toolValue(await server.tool('project_get',{projectId:state.project.id}));
  const names=await fs.readdir(root);const preview=await command([statePath,planPath]);assert.equal(preview.code,0);assert.equal(preview.value.applied,false);
  assert.deepEqual(await fs.readFile(statePath),bytes);assert.deepEqual(await fs.readdir(root),names);
  const applied=await command([statePath,planPath,'--apply']);assert.equal(applied.code,0);assert.equal(applied.value.commitStatus,'verified');
  const after=await stored(statePath);assert.equal(after.state.stateVersion,state.stateVersion+1);
  for(const field of ['nodes','edges','intentClaims','decisions','reviews','evidence','checks'])assert.deepEqual(after.state[field],state[field]);
  assert.deepEqual(await fs.readFile(applied.value.backupPath),bytes);
  const second=toolValue(await server.tool('context_get',{projectId:state.project.id,roadmapItemIds:[ROADMAP]}));
  assert.equal(second.state.stateVersion,first.state.stateVersion+1);assert.notEqual(second.state.fileDigest,first.state.fileDigest);
  assert.equal(second.state.fileDigest,after.digest);assert.ok(second.intentClaims.some(c=>c.status==='confirmed'));
  assert.equal(second.authorization.roadmapGrantsImplementationPermission,false);
  const history=await readTimelineHistory(statePath,{state:after.state,fileDigest:after.digest});
  const old=await readTimelineSnapshot(statePath,{state:after.state,fileDigest:after.digest},history.samples[0]);
  assert.deepEqual(old.state,state);assert.equal(old.state.roadmapItems,undefined);
  const again=await command([statePath,planPath,'--apply']);assert.equal(again.value.replayed,true);assert.deepEqual(await fs.readFile(statePath),after.bytes);
  await server.close();
});
test('live review lock blocks planning CLI but never a read-only MCP; closing is not completion or a decision',async(t)=>{
  const root=await makeTempDir('roadmap-mcp-lock-');t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const state=makeMcpState({confirmed:true}),statePath=path.join(root,'state.json');const bytes=await writeFixture(statePath,state);
  const planPath=path.join(root,'plan.json');const closed=makeItem({status:'closed',closedReason:'Cancelled, never implemented'});
  await fs.writeFile(planPath,JSON.stringify(makePlan(state,bytes,[closed])));
  const service=await startReviewService(statePath,{port:0,logger:()=>{},projectRoot:root});
  const server=startMcp(root,state.project.id);t.after(()=>server.kill());await server.initialize();
  try {
    const names=await fs.readdir(root);const locks=await Promise.all(names.filter(n=>n.endsWith('.lock')).map(async n=>[n,await fs.readFile(path.join(root,n))]));
    const blocked=await command([statePath,planPath,'--apply']);assert.equal(blocked.code,1);assert.equal(blocked.value.code,'lock_held');
    const value=toolValue(await server.tool('context_get',{projectId:state.project.id,nodeIds:[CAPABILITY]}));assert.equal(value.roadmapItems[0].status,'ready');
    assert.deepEqual(await fs.readdir(root),names);for(const [n,b]of locks)assert.deepEqual(await fs.readFile(path.join(root,n)),b);
  } finally {await service.close();}
  const applied=await command([statePath,planPath,'--apply']);assert.equal(applied.code,0);
  const value=toolValue(await server.tool('context_get',{projectId:state.project.id,roadmapItemIds:[ROADMAP]}));
  assert.equal(value.roadmapItems[0].status,'closed');assert.equal(value.roadmapItems[0].closedReasonRole,'closing_is_not_implementation_or_verification');
  assert.equal(value.evidence.some(e=>e.isExecution),false);assert.deepEqual((await stored(statePath)).state.decisions,state.decisions);
  const current=await stored(statePath);await fs.writeFile(planPath,JSON.stringify(makePlan(current.state,current.bytes,[makeItem({nodeId:'goal:acceptance'})])));
  const rebind=await command([statePath,planPath,'--apply']);assert.equal(rebind.code,1);assert.deepEqual(await fs.readFile(statePath),current.bytes);
  await server.close();
});
