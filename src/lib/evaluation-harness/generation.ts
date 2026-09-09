import {datasetSchema} from './domain';
const instruction = `根据目标的实际定义生成 4 至 8 个 Case，覆盖正例、反例、边界，至少包含一个多轮 Case。只使用目标提供的 Skill、工具和状态，不猜测不存在的能力；不要把预期当成实际结果。
只返回 JSON 对象 {"cases":[Case]}。每个 Case 的字段类型如下：
- id: 非空且唯一的字符串；name: 非空字符串。
- category: "positive"、"negative"、"boundary" 三选一。
- difficulty: "easy"、"medium"、"hard" 三选一。
- tags: 字符串数组；note: 字符串。
- turns: 数组，每轮含 input（非空字符串）、expectedOutput（预期回复字符串）、expectation（对象）。首轮 input 是用户起始问题，最后一轮 expectedOutput 是最终预期答案。
expectation 可用字段：contains 是一个字符串而不是数组；pattern 是有效正则字符串；expectedSkill 和 state 是字符串。
requiredTools 是对象数组，每项 {"name":"工具名称","arguments":{"参数名":"预期值"}}；arguments 可省略。forbiddenTools 和 toolOrder 是工具名称字符串数组，同一工具不能同时必需和禁止。
fields 是字段约束对象数组而不是字段名数组；每项 {"path":"balance","type":"number","required":true,"equals":100,"min":0,"max":1000,"enum":[100,200]}。只有 path 必填，其余可省略；type 仅 string/number/boolean/array/object。仅在实际输出应为 JSON 时填写 fields；不要用字段规则校验普通自然语言回复。
blocking 是布尔值。无需检查的可选字段应省略，数组字段可用 []，不要使用 null。`;
export async function generateCaseDefinitions(target:unknown,ask:(system:string,data:unknown)=>Promise<unknown>){
 let output=await ask(instruction,target);
 for(let attempt=0;attempt<2;attempt++){
  const parsed=datasetSchema.safeParse(output);
  if(parsed.success)return parsed.data;
  if(attempt===1)throw new Error('生成结果仍不符合 Case 格式，请重新生成或手动创建；未保存无效数据。');
  output=await ask(instruction+'\n上次输出未通过校验。根据 validationErrors 修正 previousOutput，保留原业务意图，返回完整且符合类型的 JSON。',{
   target,previousOutput:output,validationErrors:parsed.error.issues.map(issue=>({path:issue.path.join('.'),message:issue.message}))
  });
 }
 throw new Error('生成未完成');
}
