import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sidebar = readFileSync('src/components/shell/sidebar-navigation.ts', 'utf8');
const legacyTabs = readFileSync('src/components/skills/skill-workspace-navigation.ts', 'utf8');
const previewPage = readFileSync('src/app/(main)/skill-workbench/page.tsx', 'utf8');
const managementPage = readFileSync('src/app/(main)/config/skills/page.tsx', 'utf8');

test('Skill 主入口切到 /skills 工作台，同时旧 Skill 页签和管理深链接保持不变', () => {
  assert.match(sidebar, /href:\s*['"]\/skills['"]/);
  assert.doesNotMatch(legacyTabs, /href:\s*['"]\/skill-workbench['"]/);
  assert.match(legacyTabs, /href:\s*['"]\/skills['"]/);
  assert.match(managementPage, /\.\.\/\.\.\/skills\/page/);
  const skillsPage = readFileSync('src/app/(main)/skills/page.tsx', 'utf8');
  assert.match(skillsPage, /SkillWorkbenchShell/);
  assert.match(skillsPage, /openSkillId/);
});

test('兼容别名只挂载新的工作台组件，不嵌入旧巨型页面', () => {
  assert.match(previewPage, /SkillWorkbenchShell/);
  assert.doesNotMatch(previewPage, /SkillCatalogV2|skill-generator\/page|skill-eval\/page|skill-opt\/\[name\]/);
});

test('统一实验冻结执行配置，并用旧灰度执行器认可的数据集字段', () => {
  const experimentService = readFileSync('src/lib/skill-workbench/experiment-service.ts', 'utf8');
  const grayscaleRoute = readFileSync('src/app/api/debug/grayscale-tasks/[taskId]/route.ts', 'utf8');
  const experimentBaseline = readFileSync('src/lib/skill-workbench/experiment-baseline.ts', 'utf8');
  const retestService = readFileSync('src/lib/skill-workbench/retest-service.ts', 'utf8');
  assert.match(experimentService, /linkedDatasetIds:\s*\[dataset\.id\]/);
  assert.match(experimentService, /modelConfigId:\s*activeModel\?\.id/);
  assert.match(experimentService, /interactionPolicy:\s*'auto-deny'/);
  assert.match(experimentService, /timeoutMs:\s*3 \* 60 \* 1000/);
  assert.match(experimentService, /executionSides:\s*input\.preset === 'skill-ab' \? \['a', 'b'\] : \['b'\]/);
  assert.match(experimentService, /triggerRouting:\s*input\.preset === 'trigger'/);
  assert.match(grayscaleRoute, /configuredExecutionSides/);
  assert.match(grayscaleRoute, /runWorkbenchTriggerTask/);
  assert.match(grayscaleRoute, /runTriggerEvalLive/);
  assert.match(grayscaleRoute, /evaluators:\s*\[SKILL_TRIGGER_ANALYZER_EVALUATOR_ID\]/);
  assert.match(grayscaleRoute, /const exactIds = new Set\(\[SKILL_TRIGGER_ANALYZER_EVALUATOR_ID\]\)/);
  assert.match(grayscaleRoute, /pointsJson:\s*JSON\.stringify\(exactEvaluation\.points \|\| \[\]\)/);
  assert.match(grayscaleRoute, /action === 'start'[\s\S]*status:\s*'draft'[\s\S]*status:\s*'running'/);
  assert.match(grayscaleRoute, /loadServerModelForUserById/);
  assert.match(grayscaleRoute, /modelOptions:\s*args\.config\.modelOptions/);
  assert.match(retestService, /snapshot\.runtime\?\.modelConfigId/);
  assert.match(retestService, /modelOptions:\s*snapshot\.runtime\?\.modelOptions/);
  assert.match(experimentBaseline, /snapshot\.baselineSide \|\| 'b'/);
  assert.match(experimentBaseline, /states\[caseId\]\?\.\[baselineSide\]\?\.runs/);
  assert.match(retestService, /resolveRetestableExperimentBaseline/);
  assert.match(retestService, /round < repeatRounds/);
});

test('工作台使用独立 BFF，不复用旧 Skill 写接口', () => {
  const shell = readFileSync('src/components/skill-workbench/SkillWorkbenchShell.tsx', 'utf8');
  assert.match(shell, /\/api\/skill-workbench\/sessions/);
  assert.doesNotMatch(shell, /\/api\/skills\/publish|\/api\/skills\/upload|\/api\/skill-opt/);
});

test('工作快照静态评估按当前 hash 投影，并区分执行状态与发布门禁', () => {
  const evaluationService = readFileSync('src/lib/skill-workbench/evaluation-service.ts', 'utf8');
  const publishService = readFileSync('src/lib/skill-workbench/publish-service.ts', 'utf8');
  const optimizationAdapter = readFileSync('src/lib/skill-workbench/optimization-adapter.ts', 'utf8');
  const evaluationPanel = readFileSync('src/components/skill-workbench/StaticEvaluationPanel.tsx', 'utf8');
  const shell = readFileSync('src/components/skill-workbench/SkillWorkbenchShell.tsx', 'utf8');
  assert.match(evaluationService, /getLatestSnapshotEvaluation\([\s\S]*contentHash/);
  assert.match(evaluationService, /static-evaluation:\$\{snapshotHash\}/);
  assert.match(evaluationService, /'not_started' \| 'running' \| 'failed' \| 'stale' \| 'blocked' \| 'passed'/);
  assert.match(publishService, /quality\.status === 'pending'/);
  assert.match(publishService, /quality\.status === 'failed'/);
  assert.match(publishService, /highIssueCount > 0/);
  assert.match(shell, /evaluationOverview\?\.gate\.state === 'running'/);
  assert.match(shell, /qualityGate=\{displayedQualityGate\}/);
  assert.match(evaluationPanel, /AI 修复.*高风险问题/);
  assert.match(shell, /startOptimization\(\{ autoRun: true \}\)/);
  assert.match(shell, /autoStart=\{autoStartOptimization\}/);
  assert.match(optimizationAdapter, /updatesWorkingSnapshot = session\.source !== 'management'/);
  assert.match(optimizationAdapter, /filesJson: JSON\.stringify\(candidateFiles\)/);
  assert.match(optimizationAdapter, /activeView: 'evaluation'/);
});

test('Skill 实验复用四步向导并仅由预设改变默认配置', () => {
  const wizard = readFileSync('src/app/(main)/experiments/new/page.tsx', 'utf8');
  const panel = readFileSync('src/components/skill-workbench/ExperimentPanel.tsx', 'utf8');
  const result = readFileSync('src/components/skill-workbench/SkillExperimentResult.tsx', 'utf8');
  const experimentDetail = readFileSync('src/app/(main)/experiments/[id]/page.tsx', 'utf8');
  const caseDetail = readFileSync('src/app/(main)/experiments/[id]/cases/[caseId]/page.tsx', 'utf8');
  const experimentService = readFileSync('src/lib/skill-workbench/experiment-service.ts', 'utf8');
  const triggerEvaluator = readFileSync('src/lib/skill-workbench/trigger-evaluator.ts', 'utf8');
  const presetEvaluators = readFileSync('src/lib/evaluators/preset-evaluators.ts', 'utf8');
  assert.match(wizard, /\['实验设计', 'Trace 来源', '预期答案', '评估器与执行'\]/);
  assert.match(wizard, /traceMode === 'existing' && \(/);
  assert.doesNotMatch(wizard, /traceMode === 'existing' && skillPreset !== 'skill-ab'/);
  assert.match(wizard, /用例明细/);
  assert.match(wizard, /转为不触发/);
  assert.match(triggerEvaluator, /SKILL_TRIGGER_ANALYZER_EVALUATOR_ID/);
  assert.match(triggerEvaluator, /label:\s*'触发准确率'/);
  assert.match(presetEvaluators, /id:\s*SKILL_TRIGGER_ANALYZER_EVALUATOR_ID/);
  assert.match(wizard, /Skill 版本回归/);
  assert.match(wizard, /证据忠实度/);
  assert.match(wizard, /skillPreset === 'skill-ab' \|\| traceMode === 'generate'/);
  assert.match(panel, /ExperimentWizard/);
  assert.match(panel, /context\.experiments/);
  assert.doesNotMatch(panel, /\/api\/experiments\?user=/);
  assert.match(experimentService, /scope:\s*'skill-workbench'/);
  assert.match(experimentService, /status:\s*experiment\.status === 'draft' \? 'running' : experiment\.status/);
  assert.match(experimentService, /input\.preset === 'trigger'[\s\S]*SKILL_TRIGGER_ANALYZER_EVALUATOR_ID/);
  assert.match(wizard, /SKILL_TRIGGER_ANALYZER_EVALUATOR_ID/);
  assert.match(result, /SKILL_TRIGGER_ANALYZER_EVALUATOR_ID/);
  assert.match(result, /ExperimentCaseDetail/);
  assert.match(result, /onOpenCase=\{setCaseDetailId\}/);
  assert.match(experimentDetail, /embedded && onOpenCase/);
  assert.match(caseDetail, /export function ExperimentCaseDetail/);
  assert.match(caseDetail, /!embedded && <AppTopBar/);
  assert.match(caseDetail, /embedded && onBack/);
  assert.match(result, /冻结实验配置/);
  assert.match(result, /生成实验结论/);
});

test('生成和优化由服务端完成工作台同步，客户端断开 SSE 不会中止任务', () => {
  const mirror = readFileSync('src/lib/chat/block-mirror.ts', 'utf8');
  const generatorRoute = readFileSync('src/app/api/skill-generator/chat/route.ts', 'utf8');
  const optimizerRoute = readFileSync('src/app/api/skill-opt/chat/route.ts', 'utf8');
  const generationConversation = readFileSync('src/components/skill-workbench/GenerationConversation.tsx', 'utf8');
  const optimizationConversation = readFileSync('src/components/skill-workbench/OptimizationConversation.tsx', 'utf8');
  assert.match(mirror, /clientConnected/);
  assert.match(mirror, /catch \{\s*clientConnected = false/);
  assert.match(generatorRoute, /finishWorkbenchGenerationRun/);
  assert.match(optimizerRoute, /finishWorkbenchOptimizationRun/);
  assert.doesNotMatch(generationConversation, /action:\s*'sync'/);
  assert.doesNotMatch(optimizationConversation, /action:\s*'sync'/);
  assert.match(generationConversation, /后台执行中/);
  assert.match(optimizationConversation, /后台执行中/);
});
