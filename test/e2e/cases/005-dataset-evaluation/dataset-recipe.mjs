import fs from 'node:fs';
import assert from 'node:assert/strict';
import {deriveRootSshTruth} from './builtin-truth.mjs';
import {stableHash} from '../../shared/skill-archive.mjs';
export function createDatasetRecipe(log){
 const truth=deriveRootSshTruth(log);
 return {truth,input:'请分析 ~/.agent-insight/example/messages 中针对 root 账户的 SSH 认证失败：总次数是多少？请列出失败次数最多的五个来源及各自次数，并给出日志证据。只读取这份离线日志，不修改文件。',reference:`只统计包含 authentication failure; 且 user=root 的认证失败日志，root 认证失败共 ${truth.rootFailures} 次。失败次数最多的五个来源为：\n${truth.topSources.slice(0,5).map(([host,count])=>`${host} ${count}次`).join('\n')}\n回答必须引用原日志中真实的 root 认证失败记录作为证据。其他账户和 Kerberos 事件不计入本题统计。`};
}
export function statisticsSkillFiles(name){return {
 'SKILL.md':`---
name: ${name}
description: 只读分析用户提供的离线 UTF-8 messages 日志，统计 root SSH 认证失败和前五来源，引用原日志证据。
---

# root SSH 认证失败统计

## 输入和边界
输入为一个可读的 UTF-8 日志文件路径，支持当前用户的 ~ 路径。只读该文件，不访问网络、不读取其他系统日志、不修改输入。仅统计同时包含 authentication failure; 和独立 user=root 字段的行；其他账户和 Kerberos 事件不计入。

## 步骤 1：运行固定统计脚本
用 python3 <本 Skill 目录>/scripts/analyze_logs.py <用户日志路径>，路径包含空格或 ~ 时正确引用；脚本内部展开 ~，只依赖 Python 标准库。退出码 0 的 stdout 是完整 JSON。参数错误退出 2；缺失/不可读文件或非 UTF-8 输入退出 3，此时按 stderr 检查参数、文件路径、读权限和编码，不输出虚构统计或摘要。

## 步骤 2：报告计算结果及原始证据
仅根据本轮脚本 JSON 用中文报告：root_ssh_failures 总数，top_sources 中五个来源及各自 count；并从 evidence_by_source 逐字引用每个来源的至少一条日志。说明统计口径为 root 认证失败、其他账户和 Kerberos 不计入。不自行补取或生成证据，不推测攻击动机、地理位置、封禁建议或安全结论。

## 输出契约
所有数字及来源均从脚本输出取值。total_lines 包含无换行的最后一行。同次数来源按首次出现顺序排列；缺失 rhost 的 root 事件明确计入 (missing rhost)，不冒称已知来源。零匹配是正常结果：脚本仍返回 JSON，root_ssh_failures=0、top_source 为空字符串、top_source_failures=0、top_sources/evidence 为空数组、evidence_by_source 为空对象，此时如实说明未发现 root 认证失败，不编造来源或证据。只有退出码 0 的合法 JSON 可供后续格式化。
`,
 'scripts/analyze_logs.py':fs.readFileSync(new URL('./fixtures/dataset_root_ssh.py',import.meta.url),'utf8')};}
export function datasetBusinessHash(d){return stableHash({id:d.id,name:d.name,datasetKind:d.datasetKind,cases:d.cases.map(c=>({id:c.id,input:c.input,expectedOutput:c.expectedOutput}))});}
export function assertConstructedDataset(d,recipe,name,user,owner){assert.ok(d.id);assert.equal(d.name,name);assert.equal(d.datasetKind,'ideal_output');assert.equal(d.user??owner,user);assert.equal(d.cases.length,1);assert.ok(d.cases[0].id);assert.equal(d.cases[0].input,recipe.input);assert.equal(d.cases[0].expectedOutput,recipe.reference);return {case:d.cases[0],datasetHash:datasetBusinessHash(d)};}
