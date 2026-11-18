// Synthetic context and real stdio test client. No real project data or host config.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { applyReview, previewReview } from '../scripts/review-actions.mjs';
import { sha256Bytes, validateFullState } from '../scripts/state-store.mjs';
import { makeAcceptanceState, ACCEPTANCE_NODE, ACCEPTANCE_TARGET } from './acceptance-fixtures.mjs';

export const CAPABILITY = 'capability:mcp-record';
export const ROADMAP = 'roadmap:mcp-record';
export const encode = (state) => Buffer.from(JSON.stringify(state,null,2)+'\n');
export function makeItem(overrides = {}) {
  return {id:ROADMAP,nodeId:CAPABILITY,objective:'Synthetic future planning, not permission',scope:['Local fixture'],exclusions:['No product approval'],horizon:'now',status:'ready',acceptanceCriteria:['A future goal, not a test result'],dependsOn:[],blockers:['Human decision still required'],closedReason:null,...overrides};
}
export function makeMcpState({confirmed = false, roadmap = true} = {}) {
  let state = makeAcceptanceState();
  if (confirmed) {
    for (const [action,targetClaimId,payload] of [
      ['edit_candidate',ACCEPTANCE_TARGET,{content:{statement:'Only local synthetic records; no remote upload.',scope:['Local records'],conditions:['User initiated'],exceptions:['Never send private data']},assessment:{disposition:'single',reviewedLegacyContext:false}}],
      ['confirm_candidate',null,{confirmationAttested:true}],
    ]) {
      const bytes = encode(state), digest = sha256Bytes(bytes);
      const request = {projectId:state.project.id,action,targetClaimId:targetClaimId ?? state.intentClaims.find((claim)=>claim.status==='candidate').id,payload,expectedStateVersion:state.stateVersion,expectedDigest:digest};
      const p = structuredClone(request); delete p.payload.confirmationAttested;
      const preview = previewReview(state,p,{fileDigest:digest});
      if (preview.requiresPreview) request.payload.previewDigest = preview.previewDigest;
      state = applyReview(state,{...request,idempotencyKey:randomUUID()},{fileDigest:digest,clock:'2026-11-12T04:00:00.000Z'}).state;
    }
  }
  state.nodes.push({id:CAPABILITY,kind:'capability',label:'Synthetic record capability',status:'candidate',evidenceIds:[]},
    {id:'unknown:mcp',kind:'unknown',label:'Synthetic unresolved retention policy',status:'unknown',evidenceIds:[]});
  state.edges.push({id:'edge:mcp-task',from:'task:acceptance',to:CAPABILITY,kind:'contains'},
    {id:'edge:mcp-constraint',from:ACCEPTANCE_NODE,to:CAPABILITY,kind:'constrains'},
    {id:'edge:mcp-impl',from:CAPABILITY,to:'impl:acceptance',kind:'implemented_by'},
    {id:'edge:mcp-verify',from:CAPABILITY,to:'verify:acceptance',kind:'verified_by'},
    {id:'edge:mcp-unknown',from:CAPABILITY,to:'unknown:mcp',kind:'depends_on'});
  const template = state.intentClaims.find((claim)=>claim.id===ACCEPTANCE_TARGET);
  state.intentClaims.push({...structuredClone(template),id:'claim:mcp-feature',nodeId:CAPABILITY,statement:'Synthetic candidate suggestion, not a rule',status:'candidate',origin:'onboarding',createdByReviewId:null,assessment:{disposition:'unreviewed',contentDigest:null,reviewedLegacyContext:false,reviewId:null},governingDecisionId:null,retiredByDecisionId:null,supersedesClaimIds:[],supersededByClaimIds:[]});
  if (roadmap) state.roadmapItems = [makeItem()];
  const errors = validateFullState(state);
  if (errors.length) throw new Error(errors.join('\n'));
  return state;
}
export function makePlan(state, bytes, items, operationId = randomUUID()) {
  return {projectId:state.project.id,operationId,expectedStateVersion:state.stateVersion,expectedDigest:sha256Bytes(bytes),authorizationRef:'Synthetic explicit test authorization only',summary:'Synthetic planning update, not a decision',items,capabilities:[]};
}
export async function stored(path) {
  const bytes = await readFile(path); return {bytes,state:JSON.parse(bytes),digest:sha256Bytes(bytes)};
}
export async function writeFixture(path,state) { const bytes=encode(state);await writeFile(path,bytes,{flag:'wx'});return bytes; }

export function startMcp(root, projectId, {state = 'state.json', extraArgs = []} = {}) {
  const child = spawn(process.execPath,[fileURLToPath(new URL('../scripts/mcp-server.mjs',import.meta.url)),'--project-root',root,'--state',state,'--project-id',projectId,...extraArgs],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const messages = [], pending = new Map(); let id=0, output='', stderr='', rest='';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data',(data)=>{stderr+=data;});
  child.stdout.on('data',(data)=>{
    output+=data;rest+=data;
    let index;
    while ((index=rest.indexOf('\n'))>=0) {
      const line=rest.slice(0,index);rest=rest.slice(index+1);
      let message;try{message=JSON.parse(line);}catch(error){for(const p of pending.values())p.reject(error);pending.clear();continue;}
      messages.push(message);const p=pending.get(message.id);
      if(p){clearTimeout(p.timer);pending.delete(message.id);p.resolve(message);}
    }
  });
  const exit = new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{
    for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('MCP exited: '+code+' '+stderr));}pending.clear();resolve({code,signal});
  });});
  function request(method,params) {
    const n=++id;return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(n);reject(new Error('MCP timeout: '+method));},10000);
      pending.set(n,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,...(params===undefined?{}:{params})})+'\n');
    });
  }
  return {child,messages,exit,request,raw:(value)=>child.stdin.write(value),
    output:()=>output,stderr:()=>stderr,
    async initialize(protocolVersion='2025-06-18') {
      const response=await request('initialize',{protocolVersion,capabilities:{},clientInfo:{name:'synthetic-test',version:'1'}});
      child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');return response;
    },
    async tool(name,args,meta) {return request('tools/call',{name,arguments:args,...(meta?{_meta:meta}:{})});},
    async close(){child.stdin.end();const timeout=setTimeout(()=>child.kill(),5000);try{return await exit;}finally{clearTimeout(timeout);}},
    kill(){child.kill();},
  };
}
export function toolValue(response) {
  if(response.error)throw new Error(JSON.stringify(response.error));
  return JSON.parse(response.result.content[0].text);
}
