import test from 'node:test';import assert from 'node:assert/strict';
import * as evidence from './skill-evidence.mjs';
test('trace identity ignores only empty tool-call representation and API payload markers',()=>{
 assert.equal(typeof evidence.assertSameTraceSnapshot,'function');const before=[{role:'user',content:'read log',tool_calls:[],_payloadVersion:2},{role:'assistant',content:'result',tool_calls:[{id:'call',function:{name:'read',arguments:'{"path":"log"}'},output:'facts'}]}],after=structuredClone(before);delete after[0].tool_calls;delete after[0]._payloadVersion;
 assert.equal(evidence.assertSameTraceSnapshot(before,after),evidence.semanticTraceHash(before));
 for(const change of [v=>v[0].content='different',v=>v[1].tool_calls[0].output='fabricated',v=>v[1].tool_calls[0].function.arguments='{}',v=>v.pop()]){const wrong=structuredClone(after);change(wrong);assert.throws(()=>evidence.assertSameTraceSnapshot(before,wrong));}
});
test('diagnosis must bind the exact accepted request snapshot and execution',()=>{
 assert.equal(typeof evidence.assertDiagnosticBinding,'function');const hash='a'.repeat(64),accepted={reportId:'r',row:{id:'r',executionId:'e',interactionsHash:hash}},done={row:{id:'r',executionId:'e',interactionsHash:hash},report:{executionId:'e',interactionHash:hash}};assert.equal(evidence.assertDiagnosticBinding(accepted,done,'e'),hash);
 for(const change of [v=>v.report.interactionHash='b'.repeat(64),v=>v.row.id='old',v=>v.report.executionId='other']){const wrong=structuredClone(done);change(wrong);assert.throws(()=>evidence.assertDiagnosticBinding(accepted,wrong,'e'));}
});
