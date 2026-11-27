import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { validateDshContext, dshContextTokens } from '../src/lib/ingest/deepseek-harness-otel/context-membership';
import { aggregateDeepSeekHarnessOtelEvents } from '../src/lib/ingest/deepseek-harness-otel/aggregator';

const source = import(pathToFileURL(path.resolve('scripts/agent-trace-collectors/deepseek-harness/dsh-context-source.mjs')).href);
const fields={system:1,tools:2,user:3,inject:4,skill:5,assistant:6,tool:7};
const event={seq:18,time:1000,data:{turn:1,step:2}};
const facts={ok:true,value:{rev:2,asOfSeq:19,parts:{requests:[{seq:18,turn:1,step:2,total:28,...fields}],events:[{seq:17,kind:'prune',tokens:40,detail:'DO_NOT_EXPORT'}]}}};
const delta={ok:true,value:{counts:fields,removedCounts:fields,tokenUp:fields,tokenDown:fields,viewNodes:[{text:'SECRET_BODY'}]}};

test('Profile version checks use the active profile and never borrow another profile version',async()=>{
 const {dshContextProfile:p}=await source;
 assert.equal(p(['node','dsh','headless','task']),'headless');
 assert.equal(p(['node','dsh','web']),'web');
 assert.equal(p(['node','dsh','--profile','customer','task']),'customer');
 assert.equal(p(['node','dsh','--profile=headless','task']),'headless');
 assert.equal(p(['node','dsh','--profile','../web']),null);
 assert.equal(p(['node','dsh','unknown-profile-command']),null);
});

test('A first projection keeps the no-previous-request reason through platform validation',async()=>{
 const {normalizeContextFacts:n}=await source;
 const result=validateDshContext(n(facts,'s',event),'s',18,1,2);
 assert.deepEqual(result?.delta,{status:'no-previous-request'});
});

test('dsh-context reuse keeps source categories and projected delta separate from body membership',async()=>{
 const {normalizeContextFacts}=await source;
 const d=normalizeContextFacts(facts,'s',event,8,delta);
 assert.equal(d.source,'dsh-context');assert.deepEqual(d.categories,fields);assert.equal(d.total,28);
 assert.equal(d.delta.baseSeq,8);assert.equal(d.events[0].seq,17);
 assert.equal(JSON.stringify(d).includes('SECRET_BODY'),false);assert.equal(JSON.stringify(d).includes('DO_NOT_EXPORT'),false);
 assert.deepEqual(dshContextTokens({sourceSessionId:'s',eventSequence:18,turn:1,step:2,dshContext:d}),{system:1,'tool-definition':2,user:3,'runtime-context':4,'skill-injection':5,assistant:6,tool:7});
});

test('Missing, ambiguous and mismatched source rows never borrow a nearby request',async()=>{
 const {normalizeContextFacts:n}=await source;
 assert.equal(n({ok:false},'s',event).status,'missing-requests');
 for(const rows of [[],[{...facts.value.parts.requests[0],seq:19}],[{...facts.value.parts.requests[0],step:3}],Array(2).fill(facts.value.parts.requests[0])])
  assert.equal(n({ok:true,value:{parts:{requests:rows}}},'s',event).status,'unmatched-request');
 assert.equal(n({...facts,value:{parts:{requests:[{...facts.value.parts.requests[0],tool:undefined}]}}},'s',event).status,'incomplete-categories');
});

test('Trust boundary rejects wrong session, step, version and invalid category estimates',async()=>{
 const {normalizeContextFacts:n}=await source,d=n(facts,'s',event,8,delta);
 for(const bad of [{...d,sourceSessionId:'other'},{...d,step:3},{...d,version:'0.86.0'},{...d,categories:{...fields,tool:-1}},{...d,categories:{...fields,tool:'7'}},{...d,total:Infinity}])
  assert.equal(validateDshContext(bad,'s',18,1,2),undefined);
 assert.deepEqual(validateDshContext({status:'not-installed',text:'SECRET'},'s',18,1,2),{status:'not-installed',version:null});
});

test('Adapter invokes published routes with a real managed owner peer and disposes it',async()=>{
 const {createDshContextSource}=await source;const calls:any[]=[];let disposed=false,cleanup:any;
 const connection={createPeer(options:any){assert.equal(options.interactions,'none');return{principal:options.principal,dispose(){disposed=true}}},createSharedFetchHandler(channel:string){assert.equal(channel,'/api');return{async fetch(req:Request,peer:any){assert.equal(peer.principal.kind,'owner');calls.push({url:req.url,body:await req.json()});return Response.json(req.url.endsWith('/facts')?facts:delta)}}}};
 const lookup=createDshContextSource({inject(_:any,fn:any){cleanup=fn({get(){return connection}})}},{version:'0.85.1'});
 assert.equal((await lookup({id:'s'},event,8)).status,'available');assert.equal(calls.length,4);assert.equal(calls[1].body.baseSeq,8);
 await cleanup();assert.equal(disposed,true);
 assert.equal((await lookup({id:'s'},event)).status,'connection-unavailable');
});

test('Unsupported versions and missing connection fail open for the original Trace',async()=>{
 const {createDshContextSource}=await source;
 assert.equal((await createDshContextSource({}, {version:'0.86.0'})({id:'s'},event)).status,'unsupported-version');
 assert.equal((await createDshContextSource({}, {version:'0.85.1'})({id:'s'},event)).status,'connection-unavailable');
});

test('A hung read is isolated and the next session can recover without releasing the old work',async()=>{
 const {createDshContextSource}=await source;let finish:any,calls=0;
 const connection={createPeer(){return{dispose(){}}},createSharedFetchHandler(){return{fetch(){calls++;if(calls>1)return Promise.resolve(Response.json(facts));return new Promise(resolve=>{finish=resolve})}}}};
 const lookup=createDshContextSource({inject(_:any,fn:any){fn({get(){return connection}})}},{version:'0.85.1',timeoutMs:30});
 assert.equal((await lookup({id:'s'},event)).status,'timeout');
 assert.equal((await lookup({id:'other'},event)).status,'available');assert.equal(calls,4);
 finish(Response.json({ok:false}));
 await new Promise(resolve=>setImmediate(resolve));
});

test('Auxiliary context events cannot replace LLM events and bind independently of arrival order',async()=>{
 const {normalizeContextFacts:n}=await source;const d=n(facts,'s',event,8,delta);
 const base:any={receivedAt:'2026-11-18T10:00:00Z',eventTimestamp:'2026-11-18T10:00:00Z',sessionId:'s',sourceSessionId:'s',user:'u',resource:{},attributes:{},scope:{}};
 const llm={...base,eventType:'assistant/message',sequence:18,body:{turn:1,step:2,message:{role:'assistant',content:[{type:'text',text:'ORIGINAL'}]},usage:{inputTokens:10,outputTokens:2}}};
 const extra={...base,eventType:'agent-insight/context',body:{responseEventSequence:18,turn:1,step:2,dshContext:d}};
 const record:any=aggregateDeepSeekHarnessOtelEvents('s',[extra,llm]);
 const rows=record.interactions.flatMap((i:any)=>i.harnessRequests??[]);
 assert.equal(rows.length,1);assert.equal(rows[0].dshContext.total,28);assert.equal(rows[0].providerUsage.input,10);
 const wrong:any=aggregateDeepSeekHarnessOtelEvents('s',[llm,{...extra,sourceSessionId:'wrong'}]);
 assert.equal(wrong.interactions.flatMap((i:any)=>i.harnessRequests??[])[0].dshContext,undefined);
});

test('Repeated uncooperative timeouts stay bounded to two reads and late completion frees capacity',async()=>{
 const {createDshContextSource}=await source;const pending:any[]=[];let disposed=0;
 const connection={createPeer(){return{dispose(){disposed++}}},createSharedFetchHandler(){return{fetch(){return new Promise(resolve=>pending.push(resolve))}}}};
 const lookup=createDshContextSource({inject(_:any,fn:any){fn({get(){return connection}})}},{version:'0.85.1',timeoutMs:20});
 assert.equal((await lookup({id:'a'},event)).status,'timeout');assert.equal((await lookup({id:'b'},event)).status,'timeout');
 for(let i=0;i<5;i++)assert.equal((await lookup({id:'c'},event)).status,'source-busy');
 assert.equal(pending.length,2);assert.equal(disposed,2);
 for(const finish of pending)finish(Response.json({ok:false}));await new Promise(resolve=>setImmediate(resolve));
 const retry=lookup({id:'d'},event);await new Promise(resolve=>setImmediate(resolve));assert.equal(pending.length,3);
 pending[2](Response.json({ok:false}));assert.equal((await retry).status,'missing-requests');
});
test('Cooperative cancellation reaches the carrier and repeated timeouts release capacity',async()=>{
 const {createDshContextSource}=await source;let aborts=0;
 const connection={createPeer(){return{dispose(){}}},createSharedFetchHandler(){return{fetch(req:Request){return new Promise((_,reject)=>req.signal.addEventListener('abort',()=>{aborts++;reject(new Error('aborted'))},{once:true}))}}}};
 const lookup=createDshContextSource({inject(_:any,fn:any){fn({get(){return connection}})}},{version:'0.85.1',timeoutMs:20});
 for(let i=0;i<4;i++){assert.equal((await lookup({id:String(i)},event)).status,'timeout');await new Promise(resolve=>setImmediate(resolve));}
 assert.equal(aborts,4);
});
