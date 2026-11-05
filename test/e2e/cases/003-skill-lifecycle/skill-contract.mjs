import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {createHash} from 'node:crypto';
import fs from 'node:fs';
import assert from 'node:assert/strict';

export const referenceScript = fs.readFileSync(new URL('./fixtures/count_root_ssh.py', import.meta.url), 'utf8');
export function assertControlledSnapshot(files, name) {
  assert.deepEqual(Object.keys(files).sort(), ['SKILL.md', 'scripts/count_root_ssh.py']);
  assert.equal(files['scripts/count_root_ssh.py'].replace(/\r\n/g, '\n').trimEnd(), referenceScript.trimEnd(), 'Reference script must remain unchanged');
  assert.ok(new RegExp(`^name:\\s*["']?${name}["']?\\s*$`, 'm').test(files['SKILL.md']), 'Skill name differs');
}
export function assertStaticAssessment(overview) {
  const evaluation = overview.evaluation;
  assert.ok(evaluation?.id, 'Assessment record missing');
  assert.ok(['ok', 'partial'].includes(evaluation.status), 'Assessment execution failed');
  assert.ok(['passed', 'blocked'].includes(overview.gate?.state), 'Assessment has no terminal quality result');
  assert.ok(Object.keys(evaluation.scores?.scores || evaluation.scores || {}).length > 0, 'Assessment scores missing');
  if (overview.gate.state === 'blocked') assert.ok(evaluation.issues.some(issue => issue.severity === 'high' && (issue.evidence || issue.reasoning)), 'Blocked result has no issue evidence');
  return { evaluationId: evaluation.id, assessmentStatus: evaluation.status, qualityPassed: overview.gate.state === 'passed', qualityGate: overview.gate, warnings: evaluation.issues.filter(issue => issue.severity === 'high').map(issue => ({ summary: issue.summary, evidence: issue.evidence })) };
}

export function generationPrompt(name, attachmentName) {
  return `把附件 ${attachmentName} 中已经验证的只读 Python 日志统计实现封装成名为 ${name} 的最小 Skill。\n在单独的 ${name}/ 目录中只生成两个文件：SKILL.md 和 scripts/count_root_ssh.py。脚本必须从附件原样复制，不改任何代码，不重新实现算法。\nSKILL.md 使用 name/description YAML frontmatter，简短说明：当用户要求分析离线 messages 的 root SSH 认证失败时使用；运行 python3 <Skill目录>/scripts/count_root_ssh.py <用户指定日志路径>；读取脚本 JSON 的 root_ssh_failures、top_source、top_source_failures，输出中文总结，并原样引用 evidence 中至少一条日志。非零退出码时转告错误并停止，不猜测数值。零次匹配是合法统计结果，报告 0 即可；文件是否选对由调用者负责，不扫描其他文件。\n当前输出是中文总结和日志证据，不增加机器汇总行。禁止增加 gzip、目录扫描、联网、第三方库、CLI 参数、其他文件或其他功能，不读取本机系统日志。\n不要把参考附件放进最终文件列表。需求已确认，请直接生成，不再澄清；不需要联网搜索。`;
}

export const optimizationPrompt = `优化这个两文件 Skill 的输出约定，保留 root 认证失败的统计逻辑和原始日志证据。允许必要调整 SKILL.md 和现有 scripts/count_root_ssh.py，不增加其他文件、功能或依赖。\n保留当前中文总结和原始 evidence，在末尾新增一行 E2E-SUMMARY，紧跟 JSON 对象。对象只取脚本实际输出的 root_ssh_failures、top_source、top_source_failures 三个字段；不要把 evidence 放进摘要 JSON。\n不硬编码路径、IP 或统计值，不增加功能或依赖。直接在当前 Skill 指令末尾追加清楚的输出规则即可。`;

export function assertOptimizedSnapshot(files,name,sourceLog,python=process.env.E2E_PYTHON||'/opt/homebrew/bin/python3'){
 assert.deepEqual(Object.keys(files).sort(),['SKILL.md','scripts/count_root_ssh.py']);
 assert.ok(new RegExp(`^name:\\s*["']?${name}["']?\\s*$`,'m').test(files['SKILL.md']),'Skill name differs');
 assert.ok(files['SKILL.md'].includes('E2E-SUMMARY'),'Optimized output contract missing');
 const original=fs.readFileSync(sourceLog),root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-candidate-oracle-'));
 try{
  const script=path.join(root,'count.py');fs.writeFileSync(script,files['scripts/count_root_ssh.py']);
  const probe=(label,data,factor)=>{const log=path.join(root,label);fs.writeFileSync(log,data);const run=spawnSync(python,['-I',script,log],{cwd:root,env:{PATH:process.env.PATH,HOME:root},encoding:'utf8',timeout:10000,maxBuffer:1048576});assert.equal(run.status,0,'Candidate script failed independent replay');const facts=JSON.parse(run.stdout);
   assert.equal(facts.root_ssh_failures,351*factor);assert.equal(facts.top_source,'150.183.249.110');assert.equal(facts.top_source_failures,80*factor);assert.ok(Array.isArray(facts.evidence)&&facts.evidence.length>0);const lines=data.toString().split(/\r?\n/);assert.ok(facts.evidence.every(entry=>{
    const text=typeof entry==='string'?entry:entry?.text;
    if(typeof text!=='string'||!text.includes('authentication failure;')||!/(?:^|\s)user=root(?:\s|$)/.test(text)||!/(?:^|\s)rhost=150\.183\.249\.110(?:\s|$)/.test(text))return false;
    if(typeof entry==='string')return lines.includes(text);
    return entry.file===log&&Number.isSafeInteger(entry.line)&&entry.line>=1&&entry.line<=lines.length&&lines[entry.line-1]===text;
   }),'Candidate evidence is not from the actual log');assert.deepEqual(fs.readFileSync(log),data,'Candidate modified readonly input');return {root_ssh_failures:facts.root_ssh_failures,top_source:facts.top_source,top_source_failures:facts.top_source_failures};};
  const doubled=Buffer.concat([original,original]);const result={original:probe('messages',original,1),doubled:probe('messages-doubled',doubled,2),scriptHash:createHash('sha256').update(files['scripts/count_root_ssh.py']).digest('hex')};assert.deepEqual(fs.readFileSync(sourceLog),original);return result;
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
