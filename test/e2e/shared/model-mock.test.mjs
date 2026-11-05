import test from 'node:test';
import assert from 'node:assert/strict';
import {coreMockReply} from './model-mock.mjs';
const tools=[{type:'function',function:{name:'shell',parameters:{type:'object',properties:{command:{type:'string'}}}}},{type:'function',function:{name:'skill',parameters:{type:'object',properties:{id:{type:'string'}}}}}];
test('native preparation probe returns the requested marker even with tools enabled',()=>{
 const r=coreMockReply({tools,messages:[{role:'user',content:'请只回复 CLIENT-READY-mock-six-001-ras'}]});assert.equal(r.content,'CLIENT-READY-mock-six-001-ras');
});
test('static assessment responds with dimension schema, not a generic successful answer',()=>{
 const r=coreMockReply({messages:[{role:'user',content:'你是一位资深的 AI Agent Skill 评估专家。目的适配性 结构规范性 指令适配性 内容一致性'}]});const d=JSON.parse(r.content);assert.equal(d.detailed_evaluation.length,4);assert.ok(d.detailed_evaluation.every(d=>d.score===5));
});
test('business answer uses actual tool facts and rejects missing evidence',()=>{
 const user={role:'user',content:'使用 e2e-dataset-mock-six-005 分析 /work/example/messages。'};
 const loaded={role:'tool',content:'<skill_content name="e2e-dataset-mock-six-005">E2E-SUMMARY\nBase directory for this skill: /work/.opencode/skills/e2e-dataset-mock-six-005\n</skill_content>'};
 const facts={total_lines:4,root_ssh_failures:2,top_source:'192.0.2.7',top_source_failures:2,evidence:['actual fixture line'],top_sources:[{source:'192.0.2.7',count:2}]};
 const r=coreMockReply({tools,messages:[user,loaded,{role:'tool',content:JSON.stringify(facts)+'\nEXIT=0'}]});assert.match(r.content,/192\.0\.2\.7/);assert.match(r.content,/E2E-SUMMARY/);assert.doesNotMatch(r.content,/351|150\.183/);
 assert.throws(()=>coreMockReply({tools,messages:[user,loaded,{role:'tool',content:'script failed'}]}),/script|tool|fact/i);
});
test('unknown model request is rejected instead of inventing a passing response',()=>{
 assert.throws(()=>coreMockReply({messages:[{role:'user',content:'do something unknown'}]}),/Unsupported mock/);
});
test('generation consumes uploaded attachment through a real terminal tool before writing',()=>{
 const input={tools,messages:[{role:'system',content:'最终生成的 skill 必须用 write 工具写到当前工作目录根'},{role:'user',content:'封装成名为 e2e-messages-generated-mock-003 的最小 Skill。附件 count_root_ssh.py'}]};
 const r=coreMockReply(input);assert.equal(r.tool_calls[0].function.name,'shell');assert.match(JSON.parse(r.tool_calls[0].function.arguments).command,/uploads/);
});
test('optimization reads existing Skill before editing and preserves the actual prefix',()=>{
 const input={tools,messages:[{role:'system',content:'你是 **Skill 优化助手**。'},{role:'user',content:'只追加四字段 E2E-SUMMARY total_lines'}]};
 const r=coreMockReply(input);assert.match(JSON.parse(r.tool_calls[0].function.arguments).command,/SKILL\.md/);
});
test('dataset reference extraction uses supplied reference and completion preserves the requested points',()=>{
 const expected='离线日志 root 失败共 2 次，来源 192.0.2.7。';
 const extracted=JSON.parse(coreMockReply({messages:[{role:'user',content:'Your task is to extract ONLY the expected key points (root_causes) from the standard answer.\nStandard Answer:\n"""\n'+expected+'\n"""'}]}).content);assert.equal(extracted.root_causes[0].content,expected);
 const judged=JSON.parse(coreMockReply({messages:[{role:'system',content:'你是「Agent 任务完成度 + 关键观点根因分析」评估器。'},{role:'user',content:'## 实际输出\n'+expected+'\n## 关键观点\n1. '+expected+'\n## 压缩执行轨迹\n实际脚本已执行'}]}).content);assert.equal(judged.key_point_findings[0].content,expected);assert.equal(judged.score,1);
});

test('embedded probe text in extracted history cannot override static analysis response',()=>{
 const r=coreMockReply({messages:[{role:'user',content:'你是一位专家级的日志分析师，提取最终执行结果。[USER]: 请只回复 CLIENT-READY-old\n[ASSISTANT]: actual response\n**请提取最终结果：**'}]});assert.equal(r.content,'actual response');
});
test('diagnosis mock requests actual static, detector and validation scripts before reporting completion',()=>{
 const input={tools,messages:[{role:'user',content:'请对下面的 Agent Insight 执行记录运行 AgentDebug 五模块诊断（Memory、Reflection、Planning、Action、System）。'}]};
 const r=coreMockReply(input);const command=JSON.parse(r.tool_calls[0].function.arguments).command;assert.match(command,/agentdebug_static/);assert.match(command,/detector_runner/);assert.match(command,/agentdebug_validate/);
});
test('no-reference evaluator provides matching requirements and verdicts',()=>{
 const r=JSON.parse(coreMockReply({messages:[{role:'system',content:'你是任务完成度评估专家。在无标准答案的情况下，需求推断 + 逐条对齐 + 置信度标记。'},{role:'user',content:'**用户输入**\n分析离线日志\n**Agent 输出**\n实际分析内容'}]}).content);assert.ok(r.inferred_requirements.length);assert.deepEqual(r.inferred_requirements,r.requirement_results.map(({verdict,reason,...r})=>r));
});
test('key-action mock retains actual action IDs and existing trace indexes',()=>{
 const payload={comparison_mode:'skill_key_actions',reference_key_actions:[{actionId:'ka_17',content:'读取脚本结果'}],actual_flat_trace_steps:[{index:9,name:'shell'}]};
 const r=JSON.parse(coreMockReply({messages:[{role:'system',content:'你是 Agent Insight 的「关键动作轨迹分析器」。'},{role:'user',content:'```json\n'+JSON.stringify(payload)+'\n```'}]}).content);assert.equal(r.key_action_results[0].action_id,'ka_17');assert.deepEqual(r.key_action_results[0].matched_trace_steps,[9]);
});
test('flow extraction includes both core actions after YAML frontmatter',()=>{
 const text='你是一个专家，擅长分析 Skill 定义并提取执行流程模式。\nSkill 定义：\n---\n---\nname: example\n---\n## Step 1：运行脚本\n执行实际脚本\n## Step 2：核对结果\n报告并逐项核对\n---\n\n请分析 skill 并提取结构化的执行流程。';
 const r=JSON.parse(coreMockReply({messages:[{role:'user',content:text}]}).content);assert.equal(r.steps.length,2);
});
test('FI mock loads injected native Skill then emits a bounded repeated stream fixture',()=>{
 const input={tools,messages:[{role:'user',content:'执行 thinking-dead-loop 场景2'}]};let r=coreMockReply(input,{caseId:'006'});assert.equal(r.tool_calls[0].function.name,'skill');
 r=coreMockReply({...input,messages:[...input.messages,{role:'tool',content:'<skill_content name="thinking-dead-loop">实际注入技能</skill_content>'}]},{caseId:'006'});assert.ok(r.content.length>=4000);assert.ok((r.content.match(/磁盘/g)||[]).length>10);
});
test('native dataset task resolves tilde against the actual client home from execution context',()=>{
 const r=coreMockReply({tools,messages:[{role:'system',content:'用户输入中的 ~/ 指客户端真实用户目录 /work/isolated/host，读取时转换为该绝对路径。'},{role:'user',content:'使用 e2e-dataset-mock-005 分析 ~/.agent-insight/example/messages。'},{role:'tool',content:'<skill_content name="e2e-dataset-mock-005">scripts/analyze_logs.py\nBase directory for this skill: /work/isolated/skill\n</skill_content>'}]});
 assert.match(JSON.parse(r.tool_calls[0].function.arguments).command,/\/work\/isolated\/host\/\.agent-insight\/example\/messages/);
});
test('experiment selects the frozen Skill from system context when user input contains no Skill name',()=>{
 const r=coreMockReply({tools,messages:[{role:'system',content:'本次实验只能使用 .opencode/skills/e2e-dataset-mock-005/SKILL.md 中的 e2e-dataset-mock-005 v0。'},{role:'user',content:'请分析 ~/.agent-insight/example/messages 中针对 root 账户的 SSH 失败。'}]});assert.equal(JSON.parse(r.tool_calls[0].function.arguments).id,'e2e-dataset-mock-005');
});
test('valid facts followed by a failing exit cannot become a successful answer',()=>{
 const facts={root_ssh_failures:2,top_source:'192.0.2.7',top_source_failures:2,evidence:['actual evidence']};
 assert.throws(()=>coreMockReply({tools,messages:[{role:'user',content:'使用 e2e-dataset-mock-005 分析 /work/messages。'},{role:'tool',content:'<skill_content name="e2e-dataset-mock-005">脚本</skill_content>'},{role:'tool',content:JSON.stringify(facts)+'\nEXIT=1'}]}),/exit|script/i);
});
test('dataset response quotes actual evidence for every top source without inventing security conclusions',()=>{
 const facts={total_lines:5,root_ssh_failures:3,top_source:'192.0.2.7',top_source_failures:2,top_sources:[{source:'192.0.2.7',count:2},{source:'192.0.2.8',count:1}],evidence:['top evidence'],evidence_by_source:{'192.0.2.7':['top evidence'],'192.0.2.8':['second source actual evidence']}};
 const r=coreMockReply({tools,messages:[{role:'user',content:'使用 e2e-dataset-mock-005 分析 /work/messages。'},{role:'tool',content:'<skill_content name="e2e-dataset-mock-005">脚本</skill_content>'},{role:'tool',content:JSON.stringify(facts)+'\nEXIT=0'}]});assert.match(r.content,/second source actual evidence/);assert.doesNotMatch(r.content,/严重爆破风险/);
});
