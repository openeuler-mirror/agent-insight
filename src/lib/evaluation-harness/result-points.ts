import type {Check, EvalCase, TurnEvidence} from './domain';
function suggestion(c:Check) {
  if(c.skipped)return '先处理阻断后续评估的关键失败，再重新运行本用例。';
  if(c.verdict==='unknown')return '补齐该轮 Trace、Skill、工具或版本证据后重新评估；证据不足不能判定通过。';
  if(c.verdict==='pass')return '本项已通过，保留为后续版本的回归检查。';
  if(c.name==='路由')return '核对预期 Skill 的触发条件、描述与 Agent 路由提示词，排查是否误选其他 Skill。';
  if(/工具|顺序/.test(c.name))return '对照预期工具、参数及调用顺序检查 Skill 执行步骤；涉及审批时同时核对授权与人工复核条件。';
  if(/状态/.test(c.name))return '检查该轮业务分支的结束条件，确认应继续询问、结束任务还是转人工复核。';
  return '对照预期输出与实际回复检查内容和格式；如规则本身不符合业务要求，请修改 Case 并发布新版本后回归。';
}
export function buildCheckPoints(checks:Check[], turns:TurnEvidence[], definition?:EvalCase) {
  return checks.map(c=>{
    const actual=c.turn>0?turns[c.turn-1]:undefined, expected=definition?.turns?.[c.turn-1];
    const e=expected?.expectation;
    const requirements=e?[e.expectedSkill&&`Skill：${e.expectedSkill}`,e.state&&`结束状态：${e.state}`,e.contains&&`包含文本：${e.contains}`,e.pattern&&`正则：${e.pattern}`,...(e.requiredTools||[]).map(t=>`必须调用 ${t.name}；参数 ${JSON.stringify(t.arguments||{})}`),e.forbiddenTools?.length&&`禁止调用：${e.forbiddenTools.join('、')}`,e.toolOrder?.length&&`调用顺序：${e.toolOrder.join(' → ')}`,...(e.fields||[]).map(f=>`字段 ${f.path}：${JSON.stringify(f)}`)].filter(Boolean).join('\n\n'):'';
    const md=[`判定依据：${c.reason}`,expected?`预期输出：${expected.expectedOutput||'按规则判断'}\n\n${requirements}`:'',actual?`实际输入：${actual.input}\n\n实际输出：${actual.output}\n\n实际 Skill：${actual.skill||'未采集'}；结束状态：${actual.state||'未采集'}\n\n实际工具：${actual.tools===undefined?'未采集':actual.tools.length?actual.tools.map(t=>`${t.name}；参数 ${JSON.stringify(t.arguments)}`).join('\n\n'):'本轮没有工具调用'}`:c.turn>0?'该轮未取得执行证据。':'适用于整个 Case。'].filter(Boolean).join('\n\n');

    return {label:c.name+(c.skipped?'（已跳过）':c.verdict==='unknown'?'（未评完整）':''),...(!c.skipped&&c.verdict!=='unknown'?{score:c.verdict==='pass'?100:0}:{}),evidence:{md},suggestion:'规则排查建议：'+suggestion(c),anchors:['turn-'+c.turn]};
  });
}
