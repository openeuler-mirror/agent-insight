import fs from 'node:fs';
import path from 'node:path';
import {startModelMock} from '../cases/002-opencode-observation/model-mock.mjs';

export const textOf=value=>typeof value==='string'?value:Array.isArray(value)?value.map(p=>p.text||'').join('\n'):JSON.stringify(value??'');
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
const answer=value=>({role:'assistant',content:typeof value==='string'?value:JSON.stringify(value)});
const call=(input,name,args)=>{
 const tool=input.tools?.find(t=>t.function?.name===name);if(!tool)throw Error('Required mock tool unavailable: '+name);
 return {role:'assistant',tool_calls:[{id:'call_mock_'+name+'_'+(input.messages?.length||0),type:'function',function:{name,arguments:JSON.stringify(args)}}]};
};
const terminal=(input,command)=>{
 const tool=input.tools?.find(t=>['shell','bash'].includes(t.function?.name));if(!tool)throw Error('No terminal tool for actual fixture execution');
 const props=tool.function.parameters?.properties||{};return call(input,tool.function.name,{command,...(props.description?{description:'Execute controlled E2E fixture operation'}:{}),...(props.timeout?{timeout:10000}:{})});
};
function factsFromTools(messages){
 for(const m of [...messages].reverse().filter(m=>m.role==='tool')){
  const text=textOf(m.content),a=text.indexOf('{'),b=text.lastIndexOf('}');if(a<0||b<a)continue;
  try{const obj=JSON.parse(text.slice(a,b+1));if(typeof obj.root_ssh_failures==='number'&&typeof obj.top_source==='string'&&obj.evidence?.length){if(!/^EXIT=0\s*$/m.test(text))throw Error('Actual script exit must be zero');return obj;}}catch(error){if(error.message==='Actual script exit must be zero')throw error;}
 }
}
function factsAnswer(facts,loaded){
 const rawEvidence=facts.evidence_by_source&&facts.top_sources?facts.top_sources.flatMap(item=>facts.evidence_by_source[item.source]?.slice(0,1)||[]):facts.evidence;
 const evidence=rawEvidence.map(e=>typeof e==='string'?e:e.text).filter(Boolean);
 if(!evidence.length)throw Error('Actual script evidence missing');
 const top=facts.top_sources||facts.sources||[];
 const sources=Array.isArray(top)?top.map(x=>typeof x==='string'?x:`${x.source||x.ip||x.address||x.rhost} ${x.count||x.failures||x.root_ssh_failures} 次`).join('\n'):JSON.stringify(top);
 let text=`root SSH 认证失败 ${facts.root_ssh_failures} 次。最多来源 ${facts.top_source}，共 ${facts.top_source_failures} 次。\n${sources}\n| 字段 | 脚本值 | 报告值 |\n|---|---|---|\n${['root_ssh_failures','top_source','top_source_failures'].map(k=>`| ${k} | ${facts[k]} | ${facts[k]} |`).join('\n')}\n日志证据：\n${evidence.join('\n')}`;
 if(loaded.includes('E2E-SUMMARY')){const keys=loaded.includes('total_lines')?['total_lines','root_ssh_failures','top_source','top_source_failures']:['root_ssh_failures','top_source','top_source_failures'];text+='\nE2E-SUMMARY '+JSON.stringify(Object.fromEntries(keys.map(k=>[k,facts[k]])));}
 return answer(text);
}
function objectFromTools(messages,key){
 for(const m of [...messages].reverse().filter(m=>m.role==='tool')){
  const text=textOf(m.content);const start=text.indexOf('{'),end=text.lastIndexOf('}');if(start<0)continue;
  try{const obj=JSON.parse(text.slice(start,end+1));if(obj[key]!==undefined)return obj;}catch{}
 }
}
function writeFile(input,file,content){
 const tool=input.tools?.find(t=>t.function?.name==='write');if(!tool)throw Error('Actual file write tool unavailable');
 const props=tool.function.parameters?.properties||{};return call(input,'write',{[props.filePath?'filePath':props.path?'path':'file_path']:file,content});
}
function wroteFile(messages,file){return messages.some(m=>m.role==='assistant'&&m.tool_calls?.some(t=>t.function?.name==='write'&&Object.values(JSON.parse(t.function.arguments)).some(v=>typeof v==='string'&&v.endsWith(file))));}
function generationReply(input,users,messages){
 const name=users.match(/(?:名为|名称为)\s*(e2e-[a-z0-9-]+)/)?.[1];if(!name)throw Error('Controlled generation name missing');
 const source=objectFromTools(messages,'e2e_attachment');
 if(!source)return terminal(input,"python3 -c "+quote("import pathlib,json; files=list(pathlib.Path('uploads').rglob('*.py')); assert len(files)==1, 'Expected exactly one uploaded Python reference'; print(json.dumps({'e2e_attachment':str(files[0]),'content':files[0].read_text()}))"));
 if(!wroteFile(messages,'SKILL.md'))return writeFile(input,name+'/SKILL.md',`---\nname: ${name}\ndescription: Read-only analysis of root SSH failures in a user-supplied offline messages log.\n---\n\n# Root SSH 日志统计\n\n只读取用户指定离线日志，不扫描其他文件，不联网，不修改输入。\n\n## Step 1\n运行 python3 <本 Skill 目录>/scripts/count_root_ssh.py <用户日志绝对路径>。非零退出时报告错误并停止，不猜测结果；零次匹配是合法结果，报告 0。\n\n## Step 2\n根据有效 JSON 用中文报告 root_ssh_failures、top_source、top_source_failures，并原样引用 evidence 中的日志证据。只输出中文总结及日志证据。\n`);
 if(!wroteFile(messages,'count_root_ssh.py'))return writeFile(input,name+'/scripts/count_root_ssh.py',source.content);
 return answer('已根据实际上传附件生成两文件 Skill，脚本保持不变。');
}
function optimizationReply(input,all,messages){
 const source=objectFromTools(messages,'e2e_skill');
 if(!source)return terminal(input,"python3 -c "+quote("import pathlib,json; p=pathlib.Path('SKILL.md'); print(json.dumps({'e2e_skill':str(p),'content':p.read_text()}))"));
 if(!wroteFile(messages,'SKILL.md')){
  const keys=all.includes('total_lines')?'total_lines、root_ssh_failures、top_source、top_source_failures':'root_ssh_failures、top_source、top_source_failures';
  return writeFile(input,'SKILL.md',source.content+'\n## Step 3：机器摘要\n仅在脚本退出码 0 并得到合法 JSON 后，保留原中文总结和日志证据，在回答末尾新增单行 E2E-SUMMARY，紧跟严格 JSON 对象。对象只包含 '+keys+'，数值全部逐项直接取本轮脚本同名字段并核对一致；不包含 evidence，不硬编码数字、路径或 IP。\n');
 }
 return answer('## 修改总结\n保留原指令和脚本，在文档末尾追加结构化摘要规则。\n\n### 已解决的优化点\n- 输出格式：四字段或三字段直接取实际脚本 JSON，便于自动汇总。\n\n### 未解决的优化点\n无。');
}

export function coreMockReply(input,context={}){
 const messages=input.messages||[],users=messages.filter(m=>m.role==='user').map(m=>textOf(m.content)).join('\n'),all=messages.map(m=>textOf(m.content)).join('\n');
 if(users.startsWith('请对下面的 Agent Insight 执行记录运行 AgentDebug 五模块诊断')){
  if(messages.some(m=>m.role==='tool'&&textOf(m.content).includes('E2E-MOCK-DIAGNOSIS-VALIDATED')))return answer('AGENT_DEBUG_REPORT_READY');
  if(messages.some(m=>m.role==='tool'))throw Error('Actual diagnosis script validation failed');
  const script=fs.readFileSync(new URL('../cases/004-trace-evaluation/fixtures/mock_diagnosis.py',import.meta.url),'utf8');return terminal(input,"python3 - <<'E2E_DIAGNOSIS'\n"+script+"\nE2E_DIAGNOSIS");
 }
 if(all.includes('Skill 优化助手'))return optimizationReply(input,all,messages);
 if(all.includes('最终生成的 skill 必须用 write 工具'))return generationReply(input,users,messages);
 const marker=users.trim().match(/^["']?(?:请只回复\s*|只回复\s*)([A-Z][A-Za-z0-9-]+)/);if(marker)return answer(marker[1]);
 if(!input.tools?.length&&/^(?:Hi|Hello|你好|请回复.*|Say.*|test)[.!！。]?$/i.test(users.trim()))return answer('OK');
 if(all.includes('AI Agent Skill 评估专家')||all.includes('## 输出格式')&&all.includes('overall_comment')){
  const dims=all.includes('元数据')||all.includes('目的适配性')?['目的适配性','结构规范性','指令适配性','内容一致性']:all.includes('工程健壮性')?['工程健壮性']:['安全风险性'];
  return answer({overall_comment:'Mock 协议夹具：仅验证静态评估流程。',detailed_evaluation:dims.map(d=>({dimension:d,score:5,justification:'受控离线夹具，仅验证数据契约。',issues:[]}))});
 }
 if(all.includes('你是任务完成度评估专家。在无标准答案的情况下')){
  const requirement={content:'根据指定离线日志提供统计和原始证据。',type:'explicit',confidence:'high'};
  return answer({overall_reason:'Mock 判定用于验证无参考答案评测流程。',inferred_requirements:[requirement],requirement_results:[{...requirement,verdict:'covered',reason:'实际回答已进入评估器。'}],information_sufficiency:'sufficient',overall_analysis:'仅验证流程与数据契约，不代表真实模型质量。'});
 }
 if(all.includes('「关键动作轨迹分析器」')){
  const raw=users.match(/```json\s*([\s\S]*?)```/)?.[1];if(!raw)throw Error('Key action payload missing');const p=JSON.parse(raw);
  const ids=(p.actual_flat_trace_steps||[]).map((s,i)=>s.index??s.step_index??s.dialogStartIndex??i),actions=p.reference_key_actions||[];
  return answer({schema_version:'key-action-trace-analysis@1.0',overall:{score:1},reason_text:'Mock 关键动作覆盖判定：实际工具与回答已输入比较流程。',conclusion:'离线脚本执行及回答核验流程完成。',dimension_scores:{completeness:actions.length?1:null,tool_choice:1,redundancy:1},dimension_details:{completeness:{score:actions.length?1:null,not_scored:!actions.length,missing_steps:[],extra_steps:[],explanation:'受控核心动作流程。'},tool_choice:{score:1,problematic_steps:[],explanation:'真实 Skill 及脚本工具已调用。'},redundancy:{score:1,consecutive_same_runs:[],heavy_repeated_calls:[],explanation:'使用受控工具调用序列。'}},key_action_results:actions.map(a=>({action_id:a.id||a.actionId||a.action_id,action_content:a.content||a.actionContent,coverage:'covered',severity:'low',matched_trace_steps:ids,trace_comparison_analysis:'Mock 协议夹具：在本轮实际 Trace 中核验该动作流程。',confidence:1}))});
 }
 if(users.startsWith('你在审核「skill 脚本质量门」')){
  const facts=users.match(/## 候选事实[^\n]*\n([\s\S]*?)## 脚本/)?.[1]||'';
  const rows=[...facts.matchAll(/^(\d+)\. \[[^\]]+\]\s*(root_ssh_failures|top_source_failures|top_source)\b/gm)];return answer({keep:rows.map(m=>Number(m[1])),paths:Object.fromEntries(rows.map(m=>[m[1],m[2]]))});
 }
 if(all.includes('脚本质量门')&&all.includes('"facts"')){
  const reference=users.split('## 数据集标准答案')[1]||'';const count=reference.match(/root[^\d]{0,20}(\d+)\s*次/)?.[1];const ip=reference.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0];const top=ip?reference.slice(reference.indexOf(ip)+ip.length).match(/(?:共\s*)?(\d+)\s*次/)?.[1]:null;
  return answer({facts:[...(count?[{description:'root_ssh_failures',kind:'count',expectedValue:count}]:[]),...(ip?[{description:'top_source',kind:'identifier',expectedValue:ip}]:[]),...(top?[{description:'top_source_failures',kind:'count',expectedValue:top}]:[])]});
 }
 if(all.includes('extract ONLY the expected key points')){
  const reference=users.match(/Standard Answer:\s*"""([\s\S]*?)"""/)?.[1]?.trim();if(!reference)throw Error('Expected dataset reference missing');return answer({root_causes:[{content:reference,weight:1}]});
 }
 if(all.includes('Agent 任务完成度 + 关键观点根因分析')){
  const points=users.match(/## 关键观点\n([\s\S]*?)\n## 压缩执行轨迹/)?.[1]?.split('\n').filter(x=>/^\d+\. /.test(x)).map(x=>x.replace(/^\d+\. /,''))||[];
  const actual=users.match(/## 实际输出\n([\s\S]*?)\n## 关键观点/)?.[1]||'';
  return answer({score:1,is_correct:true,reason:'Mock 协议夹具已收到实际输出，完成评测流程。',key_point_findings:points.map(content=>({content,score:1,covered:true,coverage_status:'covered',severity:'low',explanation:'Mock 覆盖判定，用于流程验证。',coverage_reason:'实际输出已传入评估器。',missing_reason:'',evidence:{actual:actual.slice(0,500),expected:content},is_skill_attributable:false,attribution_reason:'',improvement_suggestion:''})),key_point_summary:'本轮预期观点均已进入评估流程。',result_issues:[]});
 }
 if(all.includes('擅长分析 Skill 定义并提取执行流程模式')){
  const skill=(users.split('Skill 定义：\n---\n')[1]||'').split('\n---\n\n请分析 skill')[0];
  const sections=[...skill.matchAll(/##\s+Step\s+\d+[^\n]*\n([\s\S]*?)(?=\n##\s|$)/g)];
  const steps=(sections.length?sections.map(m=>m[1].trim()):[skill]).map((description,i)=>({id:'step-'+(i+1),name:i===0?'运行离线统计脚本':'回答并核对脚本事实',description:description.slice(0,1000),type:i===0?'action':'output',isOptional:false}));
  return answer({steps,branches:[],conditionalGroups:[],loopGroups:[]});
 }
 if(all.includes('擅长分析 Agent 执行轨迹并提取执行步骤')){
  const raw=users.match(/\n---\n([\s\S]*?)\n---/)?.[1];let rows=[];try{rows=JSON.parse(raw);}catch{rows=[...(raw||'').matchAll(/\[(\d+)\] (SYSTEM|USER|ASSISTANT|TOOL): ([\s\S]*?)(?=\n\[\d+\] (?:SYSTEM|USER|ASSISTANT|TOOL):|$)/g)].map(m=>({content:m[3]}));}
  const start=Number(users.match(/对话序号从 (\d+)/)?.[1]||0);
  return answer({steps:rows.map((row,i)=>({name:'执行离线日志任务步骤',description:textOf(row.content||row.responseMessage?.content||row).slice(0,500),dialogStartIndex:start+i,dialogEndIndex:start+i,type:i===rows.length-1?'output':'action'}))});
 }
 if(all.includes('擅长分析 Agent 执行轨迹并生成执行流程图')){
  const raw=users.match(/实际执行步骤：\s*---\s*([\s\S]*?)\n---/)?.[1];let steps=[];try{steps=JSON.parse(raw);}catch{}
  return answer({matches:steps.map((step,i)=>({actualStepIndex:step.dialogStartIndex??i,actualAction:step.name||'执行离线日志任务步骤',type:step.type||'action'}))});
 }
 if(all.includes('最终执行结果')&&all.includes('请提取最终结果'))return answer((users.split('[ASSISTANT]:').at(-1)||'').split('**请提取最终结果')[0].trim());
 if(all.includes('failures')&&all.includes('中间故障')&&!input.tools?.length)return answer({failures:[],skill_issues:[]});
 if(all.includes('你是 Agent RAS 可靠性评测 Judge'))return answer({summary:'Mock 可靠性评分流程；实际回执和中断另由原生断言核验。',faultOccurred:{verdict:'met',reason:'受控重复流已生成。',suggestion:''},dimensions:['fault_detected','mitigation_triggered','fault_mitigated'].map(dimension=>({dimension,verdict:'met',reason:'Mock 协议固定判定。',suggestion:''}))});
 if(all.includes('你是思考循环检测器')&&all.includes('primary_fault'))return answer({abnormal:true,primary_fault:'semantic_deadlock',confidence:1,rationale:'Mock 受控重复流，用于真实检测与中断流程。'});
 if(context.caseId==='006'&&input.tools?.length){
  if(!messages.some(m=>m.role==='tool'&&textOf(m.content).includes('<skill_content name="thinking-dead-loop"'))){const tool=input.tools.find(t=>t.function?.name==='skill');const props=tool?.function.parameters?.properties||{};return call(input,'skill',{[props.id?'id':'name']:'thinking-dead-loop'});}
  const skill=fs.readFileSync(new URL('../../../agent_fault_injection/fault_inject/skills/thinking-dead-loop/SKILL.md',import.meta.url),'utf8');
  const section=skill.split('## 场景2：')[1]?.split('## 场景3：')[0];const sample=section?.match(/```(?:text)?\n([\s\S]*?)```/)?.[1]?.trim();if(!sample)throw Error('Actual FI semantic-loop sample missing');return answer((sample+'\n').repeat(8));
 }
 if(input.tools?.length&&/e2e-(?:messages-(?:generated|trace)|dataset)-/.test(all)){
  const loaded=messages.filter(m=>m.role==='tool'&&textOf(m.content).includes('<skill_content')).map(m=>textOf(m.content)).join('\n');
  if(!loaded){const name=all.match(/e2e-(?:messages-(?:generated|trace)|dataset)-[a-z0-9-]+/)?.[0];const tool=input.tools.find(t=>['skill','load_skill'].includes(t.function?.name));if(!tool)throw Error('Native Skill tool missing');const props=tool.function.parameters?.properties||{};return call(input,tool.function.name,{[props.id?'id':'name']:name});}
  const facts=factsFromTools(messages);if(facts)return factsAnswer(facts,loaded);
  if(messages.at(-1)?.role==='tool'&&!textOf(messages.at(-1).content).includes('<skill_content'))throw Error('Actual script tool output missing valid facts');
  const base=loaded.match(/Base directory for this skill:\s*([^\n]+)/)?.[1];
  let log=users.match(/~?(?:\/[^\s。，“”"<>]+)+(?:messages)(?=[\s。，“”"<>]|$)/)?.[0];
  if(log?.startsWith('~/')){const home=all.match(/真实用户目录\s+([^\s，]+)/)?.[1];if(!home)throw Error('Actual client home missing');log=home+log.slice(1);}
  if(!base||!log)throw Error('Actual Skill or logfile path missing');
  const script=loaded.includes('count_root_ssh.py')?'count_root_ssh.py':'analyze_logs.py';
  return terminal(input,`python3 ${quote(base+'/scripts/'+script)} ${quote(log)}; e2e_script_status=$?; echo "EXIT=$e2e_script_status"; exit "$e2e_script_status"`);
 }
 throw Error('Unsupported mock request: '+users.slice(0,120));
}
export async function startCoreModelMock(ctx){
 const folder=path.join(ctx.root,'private/model-mock');fs.mkdirSync(folder,{recursive:true,mode:0o700});let count=0;
 const mock=await startModelMock({}, {streamPlan:message=>ctx.selectedCase==='006'&&message.content?.length>4000&&message.content.includes('磁盘')?{chunkChars:80,delayMs:100}:null,reply:input=>{
  const id=String(++count).padStart(4,'0');fs.writeFileSync(path.join(folder,id+'-request.log'),JSON.stringify(input,null,2),{mode:0o600});
  const result=coreMockReply(input,{project:ctx.project,root:ctx.root,caseId:ctx.selectedCase});fs.writeFileSync(path.join(folder,id+'-reply.log'),JSON.stringify(result,null,2),{mode:0o600});return result;
 }});return mock;
}
