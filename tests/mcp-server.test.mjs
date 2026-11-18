import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { parseServerArguments, serveStdio } from '../scripts/mcp-server.mjs';
import { resolveProjectBinding } from '../scripts/mcp-context.mjs';
import { makeTempDir } from './store-fixtures.mjs';
import { CAPABILITY, makeMcpState, startMcp, toolValue, writeFixture } from './mcp-fixtures.mjs';

async function fixture(t) {
  const root=await makeTempDir('mcp-stdio-');t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const state=makeMcpState();await writeFixture(path.join(root,'state.json'),state);
  const server=startMcp(root,state.project.id);t.after(()=>server.kill());
  return {root,state,server,args:{projectId:state.project.id}};
}
test('stdio lifecycle negotiates only supported revisions and exposes exactly three read-only tools',async(t)=>{
  const f=await fixture(t), s=f.server;
  assert.equal((await s.request('tools/list')).error.code,-32002);
  const initialized=await s.initialize('2026-07-28');assert.equal(initialized.result.protocolVersion,'2025-06-18');
  assert.deepEqual(initialized.result.capabilities,{tools:{listChanged:false}});
  const list=await s.request('tools/list',{_meta:{'client/session':'not-auth'}});
  assert.deepEqual(list.result.tools.map(t=>t.name),['project_get','context_get','map_query']);
  assert.ok(list.result.tools.every(t=>t.annotations.readOnlyHint&&t.annotations.openWorldHint===false));
  const value=toolValue(await s.tool('context_get',{...f.args,nodeIds:[CAPABILITY]},{'client/session':'test'}));
  assert.equal(value.readOnly,true);assert.ok(value.intentClaims.length);
  assert.equal((await s.request('initialize',{})).error.code,-32600);
  assert.equal((await s.request('resources/list',{})).error.code,-32601);
  assert.equal((await s.request('tools/list',{cursor:'fake'})).error.code,-32602);
  const before=s.messages.length;
  s.raw(JSON.stringify({jsonrpc:'2.0',method:'notifications/unknown'})+'\n');
  s.raw(JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name:'project_get',arguments:f.args}})+'\n');
  assert.deepEqual((await s.request('ping')).result,{});assert.equal(s.messages.length,before+1,'notifications must have no responses');
  assert.equal((await s.close()).code,0);assert.equal(s.stderr(),'');
  assert.ok(s.output().trim().split('\n').every(line=>JSON.parse(line).jsonrpc==='2.0'));
});
test('stdio distinguishes argument/protocol errors from tool execution errors and recovers cleanly',async(t)=>{
  const f=await fixture(t),s=f.server;await s.initialize('2024-11-05');
  for(const args of [{name:'decision.confirm',arguments:f.args},{name:'project_get',arguments:{...f.args,path:'secret'}},{name:'context_get',arguments:{...f.args,task:'guess scope'}}]) {
    assert.equal((await s.request('tools/call',args)).error.code,-32602);
  }
  const foreign=await s.tool('project_get',{projectId:'foreign'});assert.equal(foreign.result.isError,true);assert.equal(toolValue(foreign).error.code,'project_mismatch');
  s.raw('{bad json}\n');s.raw('[1,2]\n');s.raw(JSON.stringify({jsonrpc:'2.0',id:null,method:'ping'})+'\n');
  await s.request('ping');
  assert.ok(s.messages.some(m=>m.error?.code===-32700));assert.ok(s.messages.some(m=>m.error?.code===-32600));
  await fs.writeFile(path.join(f.root,'state.json'),'{bad state');
  const bad=await s.tool('project_get',f.args);assert.equal(bad.result.isError,true);assert.equal(toolValue(bad).error.code,'invalid_state');
  assert.equal(JSON.stringify(bad).includes(f.root),false);
  assert.equal((await s.close()).code,0);
});
test('stdio accepts fragmented UTF-8 and EOF final line, with no stdout diagnostics',async(t)=>{
  const f=await fixture(t),s=f.server;await s.initialize();
  const request=Buffer.from(JSON.stringify({jsonrpc:'2.0',id:'unicode',method:'tools/call',params:{name:'context_get',arguments:{...f.args,nodeIds:[CAPABILITY],task:'合成任务'}}})+'\n');
  const split=request.indexOf(Buffer.from('合'))+1;s.raw(request.subarray(0,split));s.raw(request.subarray(split));await s.request('ping');
  assert.ok(s.messages.find(m=>m.id==='unicode').result);
  s.raw(JSON.stringify({jsonrpc:'2.0',id:'eof',method:'ping'}));assert.equal((await s.close()).code,0);
  assert.deepEqual(s.messages.find(m=>m.id==='eof').result,{});
});
test('stdio closes on over-limit frames and request floods instead of buffering unbounded input',async(t)=>{
  const f=await fixture(t);await f.server.initialize();
  f.server.raw('x'.repeat(65537));f.server.child.stdin.end();assert.equal((await f.server.exit).code,1);
  assert.match(f.server.stderr(),/transport_limit/);assert.equal(f.server.output().includes('xxx'),false);
  const second=startMcp(f.root,f.state.project.id);t.after(()=>second.kill());await second.initialize();
  second.raw(Array.from({length:100},(_,i)=>JSON.stringify({jsonrpc:'2.0',id:100+i,method:'tools/call',params:{name:'project_get',arguments:f.args}})+'\n').join(''));
  second.child.stdin.end();assert.equal((await second.exit).code,1);assert.match(second.stderr(),/transport_limit/);
});
test('stdio startup arguments fail safely without paths or stdout contamination',async(t)=>{
  const f=await fixture(t);await f.server.close();
  const s=startMcp(f.root,f.state.project.id,{extraArgs:['--state','private']});t.after(()=>s.kill());
  assert.equal((await s.exit).code,1);assert.equal(s.output(),'');assert.match(s.stderr(),/invalid_arguments/);assert.equal(s.stderr().includes(f.root),false);
  for (const key of ['constructor','toString','__proto__']) assert.throws(() => parseServerArguments([key,'x','--state','state.json','--project-id','p']), (error) => error.code === 'invalid_arguments');
});

test('stdio serializes output under backpressure, drains EOF and rejects a broken output safely', async (t) => {
  const f = await fixture(t); await f.server.close();
  const binding = await resolveProjectBinding({projectRoot:f.root,state:'state.json',projectId:f.state.project.id});
  const input = new PassThrough(), lines = [];
  let active = 0, maximum = 0;
  const output = new Writable({highWaterMark:1, write(chunk, encoding, callback) {
    active++; maximum = Math.max(maximum,active); lines.push(chunk.toString());
    setImmediate(() => { active--; callback(); });
  }});
  const done = serveStdio(binding,{input,output});
  input.end(Array.from({length:10}, (_,id) => JSON.stringify({jsonrpc:'2.0',id,method:'ping'}) + '\n').join(''));
  await done;
  assert.equal(maximum,1); assert.equal(lines.length,10);
  assert.deepEqual(lines.map((line) => JSON.parse(line).id),Array.from({length:10},(_,id)=>id));
  const brokenInput = new PassThrough();
  const brokenOutput = new Writable({write(chunk, encoding, callback) { callback(Object.assign(new Error('Synthetic broken pipe'),{code:'EPIPE'})); }});
  const rejected = assert.rejects(serveStdio(binding,{input:brokenInput,output:brokenOutput}), (error) => error.code === 'EPIPE');
  brokenInput.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'ping'}) + '\n');
  await rejected;
});
