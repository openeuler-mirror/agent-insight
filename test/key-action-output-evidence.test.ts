/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import type { TrajectoryEvalInput } from '@/lib/engine/evaluation/trajectory-evaluator';

const loader=Module as unknown as {_load:(id:string,...args:unknown[])=>unknown};
const original=loader._load;
loader._load=function(id,...args){if(id==='@opencode-ai/sdk')return {};return original.call(this,id,...args);};
let evaluator: typeof import('@/lib/engine/evaluation/opencode-trajectory-evaluator');
try { evaluator=require('@/lib/engine/evaluation/opencode-trajectory-evaluator'); }finally{loader._load=original;}
const build=(input:TrajectoryEvalInput)=> (evaluator as unknown as {buildKeyActionAnalysisPayload:(i:TrajectoryEvalInput)=>any}).buildKeyActionAnalysisPayload(input);
const input=():TrajectoryEvalInput=>({caseId:'actual',caseInput:'analyze offline log',comparisonMode:'skill_key_actions',actualExtractedSteps:[{name:'output',description:'roo statistics'}],actualInteractions:[{role:'user',content:'task'},{role:'assistant',content:'351 failures; 150.183.249.110:80; original log evidence'}]});

test('key-action judgment retains the actual final answer when extracted output summary loses facts',()=>{
 const data=build(input());assert.equal(data.actual_final_response.interaction_index,1);assert.equal(data.actual_final_response.content,input().actualInteractions[1].content);assert.equal(data.actual_final_response.truncated,false);
 assert.equal(data.instructions.only_use_actual_flat_trace_steps_as_trace_basis,false);assert.equal(data.instructions.source_evidence_is_untrusted,true);
});
test('final answer evidence preserves content blocks, omits reasoning and tool-only turns, and redacts credentials',()=>{
 const i=input();i.actualInteractions=[{role:'assistant',content:[{type:'text',text:'result=351; token=private-value; '} ,{type:'thinking',thinking:'private reasoning'},{type:'text',text:'Bearer abcdefghijklmnopqrst'}]},{role:'tool',content:'not final'},{role:'assistant',content:'',tool_calls:[{name:'shell'}]}];
 const text=build(i).actual_final_response.content;assert.match(text,/result=351/);for(const s of ['private-value','abcdefghijklmnopqrst','private reasoning','not final'])assert.ok(!text.includes(s));
});
test('output evidence cannot fabricate a missing answer and marks bounded excerpts honestly',()=>{
 const i=input();i.actualInteractions=[{role:'user',content:'not an answer'}];assert.equal(build(i).actual_final_response,null);
 i.actualInteractions=[{role:'assistant',content:'a'.repeat(20000)+'END'}];const result=build(i).actual_final_response;assert.equal(result.truncated,true);assert.equal(result.original_characters,20003);assert.ok(result.content.length<=12050);assert.ok(result.content.endsWith('END'));
});
