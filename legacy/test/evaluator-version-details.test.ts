import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatorVersionFields, compareEvaluatorVersions } from '@/lib/evaluators/evaluator-version-details';
import type {EvaluatorCard} from '@/lib/evaluators/custom-evaluator-model';
const card:EvaluatorCard={id:'custom-test',name:'Judge',description:'说明',source:'custom',evaluatorType:'LLM',category:'res',targetTypes:['Agent'],objectives:[],scenarios:[],runMode:'模型判断',scoreRange:'0-100',popularity:0,mappedMetrics:[],status:'ready',pointsDef:[{label:'准确性',note:'核对事实'}],llmConfig:{model:'registered-model',systemPrompt:'first',skills:[]}};
test('版本详情展示冻结的提示词、模型、评分点和Skill绑定，代码版本也可查看',()=>{
 const fields=evaluatorVersionFields(card), find=(key:string)=>fields.find(f=>f.key===key)?.value;
 assert.equal(find('llm.systemPrompt'),'first');assert.equal(find('llm.model'),'registered-model');assert.match(find('pointsDef')||'',/准确性/);
 const code={...card,evaluatorType:'Code' as const,llmConfig:undefined,codeConfig:{language:'python' as const,scoreMode:'0-100' as const,sourceCode:'return 100'}};
 assert.equal(evaluatorVersionFields(code).find(f=>f.key==='code.sourceCode')?.value,'return 100');
 assert.equal(evaluatorVersionFields(code).some(f=>f.key.startsWith('llm.')),false);
});
test('版本差异按方向展示变更项，新增/移除字段不遗漏且不修改输入',()=>{
 const next={...card,description:'新说明',pointsDef:[],llmConfig:{...card.llmConfig!,systemPrompt:'second',userPrompt:'new'}};
 const frozen=structuredClone(card),diff=compareEvaluatorVersions(card,next);
 assert.deepEqual(diff.map(f=>f.label),['描述','评分点','System Prompt','User Prompt']);
 assert.equal(diff.find(f=>f.label==='System Prompt')?.before,'first');assert.equal(diff.find(f=>f.label==='System Prompt')?.after,'second');
 assert.deepEqual(card,frozen);assert.equal(compareEvaluatorVersions(card,card).length,0);
});
test('忽略配置对象属性顺序及空值噪声，不展示未知字段或连接凭证',()=>{
 const skill={name:'check',source:{kind:'library',owner:null,version:1},snapshotHash:'abc',fileCount:1,totalBytes:1};
 const a={...card,llmConfig:{...card.llmConfig!,skills:[skill]}},b={...card,llmConfig:{...card.llmConfig!,userPrompt:'',skills:[{...skill,source:{version:1,owner:null,kind:'library'}}]}};
 assert.equal(compareEvaluatorVersions(a as EvaluatorCard,b as EvaluatorCard).length,0);
 const unsafe={...card,apiKey:'private',llmConfig:{...card.llmConfig,apiKey:'private'}};
 assert(!JSON.stringify(evaluatorVersionFields(unsafe as EvaluatorCard)).includes('private'));
});
test('实际填写的“未配置”文本与空配置仍是不同版本内容',()=>{
 const a={...card,llmConfig:{...card.llmConfig!,userPrompt:undefined}},b={...card,llmConfig:{...card.llmConfig!,userPrompt:'未配置'}};
 const changes=compareEvaluatorVersions(a,b);assert.equal(changes.length,1);assert.equal(changes[0].label,'User Prompt');
});
