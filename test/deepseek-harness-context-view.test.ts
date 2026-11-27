
import test from 'node:test';
import assert from 'node:assert/strict';
import { adjacentContextDiff, contextViewEvents, requestContextEvents, type ContextEntry } from '../src/lib/ingest/deepseek-harness-otel/context-view';
const counts={system:1,tools:2,user:3,inject:4,skill:5,assistant:6,tool:7};
const entry=(source:string,seq:number,events:any[]=[]):ContextEntry=>({key:source+':'+seq,request:{sourceSessionId:source,eventSequence:seq,turn:seq,step:1,dshContext:{schemaVersion:1,source:'dsh-context',version:'0.85.1',status:'available',sourceSessionId:source,responseEventSequence:seq,turn:seq,step:1,approximate:true,total:28,categories:counts,events}}});
test('v1 only uses validated existing projections and isolates event intervals by source',()=>{
 const before=entry('a',27),after=entry('a',41,[{seq:35,kind:'compaction',tokens:20}]),foreign=entry('b',40);
 after.request.contextEvents=[{sourceSessionId:'a',eventSequence:36,eventType:'compaction/prune',body:{text:'ENHANCED_ONLY'}}];
 const events=contextViewEvents([before,after,foreign]);
 assert.deepEqual(events.map(e=>[e.seq,e.projected]),[[35,true]]);
 assert.equal(requestContextEvents(events,after.request).length,1);assert.equal(requestContextEvents(events,foreign.request).length,0);
 assert.equal(JSON.stringify(events.map(e=>e.body)).includes('ENHANCED_ONLY'),false);
 after.request.dshContext!.version='unknown';assert.equal(contextViewEvents([after]).length,0);
});
test('v1 never uses additional membership even when a complete manifest is available',()=>{
 const a=entry('a',10),b=entry('a',20);delete b.request.dshContext;
 for(const r of [a,b])r.request.membership={schemaVersion:1,bindingStatus:'bound',membershipCoverage:'complete-at-capture-boundary',identityCoverage:'stable',items:[{itemId:'secret',category:'user',contentFingerprint:'private'}]};
 const result=adjacentContextDiff([entry('b',19),a,b],b.request);
 assert.equal(result.source,'unavailable');assert.equal(result.reason,'existing-source-diff-unavailable');assert.equal(result.previous?.eventSequence,10);
 assert.equal(adjacentContextDiff([b],b.request).reason,'no-previous-captured-request');
});
test('validated adjacent projection usable; mismatched bases and identities fail closed',()=>{
 const a=entry('a',10),b=entry('a',20);
 b.request.dshContext!.delta={status:'available',baseSeq:10,addedCounts:counts,removedCounts:counts,tokenUp:counts,tokenDown:counts};
 assert.equal(adjacentContextDiff([a,b],b.request).source,'dsh-context');
 b.request.dshContext!.delta.baseSeq=9;assert.equal(adjacentContextDiff([a,b],b.request).projectionReason,'projection-base-not-adjacent');
 b.request.dshContext!.sourceSessionId='wrong';assert.equal(adjacentContextDiff([a,b],b.request).source,'unavailable');
});
