import test from 'node:test';
import assert from 'node:assert/strict';
import {generateCaseDefinitions} from '../../src/lib/evaluation-harness/generation';
import {jsonModelOptions} from '../../src/lib/evaluation-harness/llm-request';
const valid={cases:[{id:'one',name:'查询',category:'positive',difficulty:'easy',turns:[{input:'查询余额',expectedOutput:'余额 100',expectation:{contains:'100',fields:[{path:'balance',type:'number',equals:100}]}}]}]};
test('invalid model field shapes are corrected once using validation feedback before returning a dataset',async()=>{
 const requests:any[]=[];
 const output=await generateCaseDefinitions({prompt:'查询余额'},async(system,data)=>{
  requests.push({system,data});return requests.length===1?{cases:[{...valid.cases[0],turns:[{input:'q',expectation:{contains:['100'],fields:['balance']}}]}]}:valid;
 });
 assert.equal(requests.length,2);assert.deepEqual(output.cases[0].turns[0].expectation.fields[0],{path:'balance',type:'number',required:true,equals:100});
 assert(requests[1].data.validationErrors.some((e:any)=>e.path.includes('contains')));
 assert.equal(requests[1].data.target.prompt,'查询余额');
});
test('repeated invalid output terminates without inventing cases or retrying indefinitely',async()=>{
 let calls=0;await assert.rejects(()=>generateCaseDefinitions({},async()=>{calls++;return {cases:[]};}),/生成结果仍不符合/);assert.equal(calls,2);
});
test('valid generation needs one call and transport errors do not trigger a format retry',async()=>{
 let calls=0;await generateCaseDefinitions({},async()=>{calls++;return valid;});assert.equal(calls,1);
 calls=0;await assert.rejects(()=>generateCaseDefinitions({},async()=>{calls++;throw Error('网络错误');}),/网络错误/);assert.equal(calls,1);
});
test('DeepSeek v4 structured requests opt out of default thinking without sending vendor fields elsewhere',()=>{
 assert.deepEqual(jsonModelOptions({baseUrl:'https://api.deepseek.com',model:'deepseek-v4-flash'}),{thinking:{type:'disabled'},response_format:{type:'json_object'},max_tokens:8192});
 assert.deepEqual(jsonModelOptions({baseUrl:'https://example.test/v1',model:'deepseek-v4-flash'}),{});
 assert.deepEqual(jsonModelOptions({baseUrl:'https://api.deepseek.com',model:'other'}),{});
});
