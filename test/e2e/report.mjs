import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { assertRunRoot, redact, renderReport, requiredStagesFor } from './shared/core.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: { 'run-dir': { type: 'string' }, 'npm-result': { type: 'string' } } });
if (!values['run-dir']) throw new Error('--run-dir is required');
const root = path.resolve(values['run-dir']);assertRunRoot(project, root);
const report = JSON.parse(fs.readFileSync(path.join(root, 'report.json')));
const selectedCase = report.selectedCase || '001';
const first = report.scenarios[Number(selectedCase) - 1];
const requiredStages = report.requiredStages || requiredStagesFor(selectedCase).filter(id=>selectedCase!=='004'||!['skill-binding','skill-verification'].includes(id));
for (const id of requiredStages) {
  if (!first.stages.some(s => s.id === id)) first.stages.push({ id, status: 'NOT_RUN', expected: '完成本场景所需准备', actual: '前序阶段未通过，本阶段未执行，不能计入通过' });
}
first.stages.sort((a, b) => requiredStages.indexOf(a.id) - requiredStages.indexOf(b.id));
if (values['npm-result']) {
  const source = JSON.parse(fs.readFileSync(values['npm-result']));
  report.npmTest = { interrupted: !!source.interrupted, fullSuiteComplete: !!source.fullSuiteComplete, countsAreLowerBound: !!source.countsAreLowerBound, observedSummary: source.observedSummary, reason: source.reason, testFile: source.testFile, exitCode: source.exitCode };
}
if (selectedCase === '004') {
  const supplemental = first.stages.find(stage => stage.id === 'diagnosis')?.actual?.supplementalSkillAnalysis;
  report.coverageNotes = [
    report.testPlanVersion==='trace-skill-complete-v2' ? '使用两文件最小 Skill 验证 root SSH 核心分支，包含原生加载、Trace 关联和 Skills 步骤核验；未覆盖其他日志类型。' : '历史运行仅验证旧主路径，未完成原生 Skill 关联及 Skills 步骤核验，不能视为完整闭环。',
    ...(supplemental && supplemental.status !== 'done' ? [`独立 Skills 步骤核验未通过：${supplemental.reason || supplemental.status}。该缺项不能视为完整闭环通过。`] : []),
    '优化会话通过正式接口准备，定向优化从页面提交；原生行为门因无数据集明确跳过，效果由直接重跑和第二个无数据集实验验收。',
    'PR Mock、CI 触发及每日调度尚未接入本入口。',
  ];
}
if(selectedCase==='005')report.coverageNotes=['只覆盖 thinking-dead-loop 的语义重复一题；真实 RAS 检测、原生中断及同客户端新会话恢复分别验收。','配置下发验收本地文件及实际行为；RAS 已加载页面状态未接入回报时单列缺项，不计通过。','报告由代码生成；业务故障执行、RAS 语义判断和可靠性评分会调用 DeepSeek。','PR Mock、CI 和每日调度尚未接入本入口。'];
report.reproduction = `node test/e2e/run-case.mjs --case ${selectedCase} --key-file /absolute/path/to/deepseek-key.txt`;
const defectFile = path.join(root, 'defect.json');
if (fs.existsSync(defectFile)) report.findings = [JSON.parse(fs.readFileSync(defectFile))];
if (report.npmTest) fs.writeFileSync(path.join(root, 'npm-test.json'), JSON.stringify(report.npmTest, null, 2) + '\n');
report.artifacts = ['report.json', 'coverage.md', 'model.png', 'ordinary-client.png', 'ras-client.png', 'failure.png', 'trace.png', 'trace-refreshed.png', 'agent-overview.png', 'agent.png', 'npm-test.json', 'verification.json', 'ui-followup.json', '004-harness-tests.log', '004-product-tests.log', '004-typecheck.log', '005-harness-tests.log', '005-product-tests.log', '005-typecheck.log', 'regression-red.log', 'defect.json', 'repro.zip', ...fs.readdirSync(root).filter(file => /^(skill|trace-only|builtin|ras)-[a-z-]+\.png$/.test(file))].filter(file => file === 'coverage.md' || fs.existsSync(path.join(root, file)));
const safe = JSON.parse(redact(JSON.stringify(report)));
fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(safe, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'report.html'), renderReport(safe));
const coverage = ['# 核心 E2E 覆盖', '', '| 用例 | 结果 | 范围 |', '|---|---|---|', ...safe.scenarios.map(s => `| ${s.id} ${s.title} | ${s.status} | ${s.status === 'NOT_RUN' ? '尚未实现/执行，不计通过' : '详见逐阶段证据'} |`), '', `系统后台服务注册/自启动及本轮未执行的其他场景不在本轮通过范围。` , 'npm test 单独统计，中断或缺少尾部汇总时不得给完整通过结论。', ''];
fs.writeFileSync(path.join(root, 'coverage.md'), coverage.join('\n'));
console.log('Generated code-only report:', path.join(root, 'report.html'));
