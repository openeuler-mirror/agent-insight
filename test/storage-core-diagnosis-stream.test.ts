import assert from 'node:assert/strict';
import test from 'node:test';

const load=()=>import('../src/lib/storage-core/diagnosis-stream');
test('diagnosis text is delivered only after its checkpoint, in order',async()=>{
 const {DiagnosisTextQueue}=await load();let release!:()=>void;const delivered:string[]=[];const saved:string[]=[];
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const queue=new DiagnosisTextQueue(async(content)=>{await gate;saved.push(content);},(event)=>delivered.push(event.fullText),()=>{});
 queue.push({delta:'A',fullText:'A'});queue.push({delta:'B',fullText:'AB'});
 await Promise.resolve();assert.deepEqual(delivered,[]);release();await queue.flush();
 assert.deepEqual(saved,['A','AB']);assert.deepEqual(delivered,['A','AB']);
});
test('checkpoint failure stops subsequent delivery and rejects completion',async()=>{
 const {DiagnosisTextQueue}=await load();let aborted=0;let sent=0;
 const queue=new DiagnosisTextQueue(async()=>{throw new Error('unavailable');},()=>sent++,()=>aborted++);
 queue.push({delta:'private',fullText:'private'});queue.push({delta:'next',fullText:'private next'});
 await assert.rejects(queue.flush(),/unavailable/);assert.equal(sent,0);assert.equal(aborted,1);
});
test('slow storage has a strict pending budget and aborts the producer',async()=>{
 const {DiagnosisTextQueue}=await load();let aborted=0;let release!:()=>void;
 const queue=new DiagnosisTextQueue(async()=>new Promise<void>(r=>{release=r;}),()=>{},()=>aborted++,{maxPending:2,maxBytes:128,maxContentBytes:128});
 queue.push({delta:'1',fullText:'1'});queue.push({delta:'2',fullText:'12'});queue.push({delta:'3',fullText:'123'});
 await Promise.resolve();release?.();await assert.rejects(queue.flush(),/budget/);assert.equal(aborted,1);
});
test('complete Unicode text is byte bounded without truncation',async()=>{
 const {DiagnosisTextQueue}=await load();let saved=0;let aborted=0;
 const queue=new DiagnosisTextQueue(async()=>{saved++;},()=>{},()=>aborted++,{maxContentBytes:3});
 queue.push({delta:'中文',fullText:'中文'});await assert.rejects(queue.flush(),/budget/);assert.equal(saved,0);assert.equal(aborted,1);
});

test('SSE done follows text checkpoint and terminal chat commit',async()=>{
 const {streamDiagnosisTurn}=await load();const order:string[]=[];
 const response=streamDiagnosisTurn({executionId:'original-task',diagnosisSessionId:'chat',sessionId:null,
  execute:async(handlers)=>{handlers.onText!({delta:'Answer',fullText:'Answer'} as never);order.push('record-trace');return {sessionId:'upstream',workspaceDir:'/isolated',output:'Answer',stats:{}};},
  checkpoint:async(content)=>{order.push('checkpoint:'+content);},renew:async()=>{},finish:async(args)=>{order.push('finish:'+args.state);}
 });
 const wire=await response.text();assert.ok(wire.includes('event: ready'));assert.ok(wire.includes('event: text'));assert.ok(wire.includes('event: done'));assert.ok(!wire.includes('event: error'));
 assert.ok(order.indexOf('checkpoint:Answer')<order.indexOf('finish:done'));assert.equal(order.at(-1),'finish:done');
});
test('failed durable recorder or chat commit emits error and never done',async()=>{
 const {streamDiagnosisTurn}=await load();
 for(const failure of ['recorder','finish']){
  const states:string[]=[];const response=streamDiagnosisTurn({executionId:'task',diagnosisSessionId:'chat',sessionId:null,
   execute:async(handlers)=>{handlers.onText!({delta:'partial',fullText:'partial'} as never);if(failure==='recorder')throw Error('private recorder path');return {sessionId:'up',workspaceDir:'/isolated',output:'partial',stats:{}};},
   checkpoint:async()=>{},renew:async()=>{},finish:async(args)=>{states.push(args.state);if(args.state==='done')throw Error('private credentials');}
  });
  const wire=await response.text();assert.ok(wire.includes('event: error'));assert.ok(!wire.includes('event: done'));assert.ok(!wire.includes('private'));assert.equal(states.at(-1),'failed');
 }
});
test('revocation during streaming aborts execution and cannot emit later text',async()=>{
 const {streamDiagnosisTurn}=await load();let aborted=false;
 const response=streamDiagnosisTurn({executionId:'task',diagnosisSessionId:'chat',sessionId:null,leaseIntervalMs:2,
  execute:async(handlers,signal)=>{await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));handlers.onText!({delta:'secret',fullText:'secret'} as never);throw Error('revoked');},
  checkpoint:async()=>{throw Error('revoked');},renew:async()=>{throw Error('revoked');},finish:async()=>{throw Error('revoked');}
 });
 const wire=await response.text();assert.equal(aborted,true);assert.ok(!wire.includes('secret'));assert.ok(wire.includes('event: error'));assert.ok(!wire.includes('event: done'));
});
