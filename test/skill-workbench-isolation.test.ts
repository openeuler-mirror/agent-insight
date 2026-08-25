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
  assert.match(experimentService, /timeoutMs:\s*isTriggerExperiment \? 30 \* 1000 : 3 \* 60 \* 1000/);
  assert.match(experimentService, /retryLimit:\s*isTriggerExperiment \? 1 : 2/);
  assert.match(experimentService, /getSkillExperimentConcurrencyPolicy\(input\.preset\)/);
  assert.match(experimentService, /evaluationConcurrency:\s*runtime\.evaluationConcurrency/);
  assert.match(experimentService, /triggerConcurrency:\s*runtime\.triggerConcurrency/);
  assert.match(experimentService, /executionSides:\s*input\.preset === 'skill-ab' \? \['a', 'b'\] : \['b'\]/);
  assert.match(experimentService, /boundSide:\s*input\.preset === 'skill-ab' \? 'a' : 'b'/);
  assert.match(experimentService, /triggerRouting:\s*input\.preset === 'trigger'/);
  assert.match(grayscaleRoute, /configuredExecutionSides/);
  assert.match(grayscaleRoute, /isGrayscaleTaskBindingValid/);
  assert.match(grayscaleRoute, /runWorkbenchTriggerTask/);
  assert.match(grayscaleRoute, /runTriggerEvalLive/);
  assert.match(grayscaleRoute, /startEvalExperimentCases/);
  assert.match(grayscaleRoute, /evaluateRunsAsExperimentBatch/);
  assert.match(grayscaleRoute, /abPairConcurrency/);
  assert.match(grayscaleRoute, /Promise\.all\(pair\.map\(executeItem\)\)/);
  assert.match(grayscaleRoute, /config\.triggerConcurrency \|\| config\.agentMaxConcurrency/);
  assert.match(grayscaleRoute, /timeoutMs:\s*Math\.max\(5_000, Math\.min\(30_000, Number\(config\.timeoutMs\) \|\| 30_000\)\)/);
  assert.match(grayscaleRoute, /maxTimeoutRetries:\s*Math\.max\(0, Math\.min\(1, Number\(config\.retryLimit \?\? 1\)\)\)/);
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

test('触发分析在创建 Session 时绑定独立 Skill 工作目录，并让后续请求沿用该目录', () => {
  const triggerRunner = readFileSync(
    'src/lib/engine/skill-generation/evaluator/runners/triggerEval.ts',
    'utf8',
  );
  const opencodeClient = readFileSync(
    'src/lib/engine/skill-generation/opencode-agent-cli/opencode-client.ts',
    'utf8',
  );
  const generalAgent = readFileSync(
    'src/lib/engine/general-agent/runner.ts',
    'utf8',
  );
  assert.match(
    triggerRunner,
    /new AgentInsight\(\{[\s\S]*?directory:\s*workspaceRoot/,
  );
  assert.match(
    triggerRunner,
    /createSession\(\{[\s\S]*?directory:\s*args\.workspaceRoot/,
  );
  assert.match(opencodeClient, /sessionDirectories\s*=\s*new Map<string, string>\(\)/);
  assert.match(opencodeClient, /sessionDirectories\.set\(sessionId, sessionDirectory\)/);
  assert.match(
    opencodeClient,
    /const subscribeDirectory\s*=[\s\S]*?this\.directoryForSession\(sessionId\)/,
  );
  assert.match(
    opencodeClient,
    /tryGetChildSessionIDs\([\s\S]*?this\.directoryForSession\(sessionId\)/,
  );
  assert.match(
    generalAgent,
    /createSession\(\{[\s\S]*?directory:\s*workspaceDir/,
  );
  assert.match(generalAgent, /const payload: SendPromptPayload = \{[\s\S]*?directory:\s*workspaceDir/);
});

test('工作台使用独立 BFF，不复用旧 Skill 写接口', () => {
  const shell = readFileSync('src/components/skill-workbench/SkillWorkbenchShell.tsx', 'utf8');
  assert.match(shell, /\/api\/skill-workbench\/sessions/);
  assert.doesNotMatch(shell, /\/api\/skills\/publish|\/api\/skills\/upload|\/api\/skill-opt/);
});

test('Skill 与版本作为右栏资产上下文，优化记录按所选基线版本过滤', () => {
  const shell = readFileSync('src/components/skill-workbench/SkillWorkbenchShell.tsx', 'utf8');
  const management = readFileSync('src/lib/skill-workbench/skill-management.ts', 'utf8');
  const optimizationService = readFileSync('src/lib/skill-workbench/optimization-service.ts', 'utf8');
  const optimizationPanel = readFileSync('src/components/skill-workbench/OptimizationRecordsPanel.tsx', 'utf8');
  const optimizationRoute = readFileSync('src/app/api/skill-workbench/skills/[name]/optimizations/route.ts', 'utf8');
  const optimizationPlanRoute = readFileSync('src/app/api/skill-opt/plan/route.ts', 'utf8');
  const evaluationRoute = readFileSync('src/app/api/skill-workbench/skills/[name]/versions/[version]/evaluations/route.ts', 'utf8');
  assert.match(shell, /aria-label="选择 Skill"/);
  assert.match(shell, /aria-label="选择 Skill 版本"/);
  assert.match(shell, /selectedAsset\.kind === 'formal'/);
  assert.match(shell, /selectedAsset\.kind === 'draft'/);
  assert.match(management, /getManagedSkillVersionAsset/);
  assert.match(optimizationService, /baseVersion:\s*input\.baseVersion/);
  assert.match(optimizationService, /sourceSession:\s*session \|\| null/);
  assert.match(optimizationPanel, /顶部所选 Skill 版本/);
  assert.match(optimizationPanel, /getOptimizationTransitionLabel/);
  assert.match(optimizationRoute, /versionParam == null \? undefined/);
  assert.match(optimizationPlanRoute, /syncCompletedSkillExperimentIssues[\s\S]*aggregateSkillIssues/);
  assert.match(optimizationPlanRoute, /refreshFinishedConfirmedPlan/);
  assert.match(optimizationPlanRoute, /status:\s*\{\s*in:\s*\['pending',\s*'running'\]/);
  assert.match(optimizationPlanRoute, /existing\.status === 'applied' && hasNewIssues/);
  assert.match(shell, /const scope = asset\.kind === 'formal'[\s\S]*version=\$\{encodeURIComponent\(String\(asset\.version\)\)\}/);
  assert.match(shell, /records=\{active\.optimizations\}/);
  assert.match(evaluationRoute, /sessionId\s*\?\s*await getWorkbenchEvaluationOverview[\s\S]*getWorkbenchStaticEvaluation/);
});

test('会话固定 Skill 并恢复工作版本，顶部资产控制右栏全部页签', () => {
  const shell = readFileSync('src/components/skill-workbench/SkillWorkbenchShell.tsx', 'utf8');
  const picker = readFileSync('src/components/skill-workbench/SkillManagementPicker.tsx', 'utf8');
  const publishService = readFileSync('src/lib/skill-workbench/publish-service.ts', 'utf8');
  assert.match(shell, /pickerPurpose === 'bind'[\s\S]*\/context/);
  assert.match(shell, /openHistorySession[\s\S]*showSessionAsset\(session\)/);
  assert.match(shell, /const viewingSessionAsset = Boolean/);
  assert.match(shell, /右栏使用.*不会改变当前会话/);
  assert.match(shell, /disabled=\{!selectedAsset\}/);
  assert.doesNotMatch(shell, /view\.key !== 'detail' && !viewingSessionAsset/);
  assert.match(picker, /purpose === 'bind'[\s\S]*起始工作版本/);
  assert.match(picker, /切换右侧全部页签使用的 Skill 和版本/);
  assert.match(picker, /max-w-6xl/);
  assert.match(picker, /h-10[\s\S]*搜索 Skill 名称或描述/);
  assert.match(publishService, /skillWorkbenchSession\.update[\s\S]*workVersion: version/);
});

test('正式 Skill 评估与实验按资产运行，不创建或要求工作台会话', () => {
  const shell = readFileSync('src/components/skill-workbench/SkillWorkbenchShell.tsx', 'utf8');
  const evaluationRoute = readFileSync('src/app/api/skill-workbench/skills/[name]/versions/[version]/evaluations/route.ts', 'utf8');
  const evaluationService = readFileSync('src/lib/skill-workbench/evaluation-service.ts', 'utf8');
  const experimentRoute = readFileSync('src/app/api/skill-workbench/skills/[name]/experiments/route.ts', 'utf8');
  const experimentService = readFileSync('src/lib/skill-workbench/experiment-service.ts', 'utf8');
  const panel = readFileSync('src/components/skill-workbench/ExperimentPanel.tsx', 'utf8');
  assert.match(shell, /selectedAsset\.kind === 'draft'[\s\S]*loadSession/);
  assert.match(shell, /\.\.\.\(taskSession \? \{ sessionId: taskSession\.id \} : \{\}\)/);
  assert.doesNotMatch(panel, /onEnsureSession|runSessionId|准备实验会话/);
  assert.match(evaluationRoute, /!formalAsset && typeof body\.sessionId !== 'string'/);
  assert.match(evaluationService, /if \(input\.formalAsset\)[\s\S]*runStaticEvaluation/);
  assert.match(experimentRoute, /sessionId: typeof body\.sessionId === 'string' \? body\.sessionId : undefined/);
  assert.match(experimentService, /sessionId\?: string/);
  assert.match(experimentService, /if \(input\.sessionId\) \{[\s\S]*createOrReuseSkillWorkbenchTask/);
});

test('优化记录复用 Monaco 行级 Diff，评测详情限制长内容溢出并隐藏轨迹质量重复证据', () => {
  const shell = readFileSync('src/components/skill-workbench/SkillWorkbenchShell.tsx', 'utf8');
  const conversation = readFileSync('src/components/skill-workbench/OptimizationConversation.tsx', 'utf8');
  const records = readFileSync('src/components/skill-workbench/OptimizationRecordsPanel.tsx', 'utf8');
  const recordDiff = readFileSync('src/components/skill-workbench/OptimizationRecordDiff.tsx', 'utf8');
  const legacyDiff = readFileSync('src/app/(main)/skill-opt/_FileDiff.tsx', 'utf8');
  const caseDetail = readFileSync('src/app/(main)/experiments/[id]/cases/[caseId]/page.tsx', 'utf8');
  assert.match(records, /OptimizationRecordDiff/);
  assert.match(records, /selectedRecordId[\s\S]*onSelectRecordId/);
  assert.match(records, /优化摘要[\s\S]*max-h-64 min-h-28 overflow-y-auto/);
  assert.doesNotMatch(records, /items-start gap-3 border-b border-border pb-4/);
  assert.doesNotMatch(records, /item\.before[\s\S]*item\.after/);
  assert.match(conversation, /onClick=\{\(\) => onViewRecords\(record\)\}/);
  assert.match(shell, /openOptimizationRecord[\s\S]*record\.id[\s\S]*record\.skillName, record\.baseVersion[\s\S]*switchView\('optimization'\)/);
  assert.match(recordDiff, /MonacoDiffEditor/);
  assert.match(legacyDiff, /MonacoDiffEditor/);
  assert.match(caseDetail, /'preset-agent-trace-quality'/);
  assert.match(caseDetail, /overflow-x-hidden/);
  assert.match(caseDetail, /overflowX: 'auto'/);
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
  assert.doesNotMatch(optimizationAdapter, /activeView: 'optimization'/);
});

test('生成快照沿用旧生成与发布门禁，不把工作台静态评估升级为发布前置条件', () => {
  const generationService = readFileSync('src/lib/skill-workbench/generation-service.ts', 'utf8');
  const publishService = readFileSync('src/lib/skill-workbench/publish-service.ts', 'utf8');
  const detail = readFileSync('src/components/skill-workbench/SkillDetailWorkspace.tsx', 'utf8');
  const shell = readFileSync('src/components/skill-workbench/SkillWorkbenchShell.tsx', 'utf8');
  assert.doesNotMatch(generationService, /runSnapshotStaticEvaluation/);
  assert.match(generationService, /resultType:\s*'workbench-snapshot'/);
  assert.match(generationService, /skillMd\.name \|\| 'untitled-skill'/);
  assert.match(publishService, /usesLegacyGenerationGate = session\.source === 'generated'/);
  assert.match(publishService, /if \(!usesLegacyGenerationGate\) \{[\s\S]*skillSnapshotEvaluation/);
  assert.match(publishService, /usesLegacyGenerationGate \? expectedVersion : session\.workVersion/);
  assert.match(detail, /usesLegacyGenerationGate[\s\S]*paths\.length > 0 && !generationRunning/);
  assert.match(shell, /requiresConfirmation = selectedAsset\.source !== 'generated'/);
  assert.match(shell, /confirmed: requiresConfirmation/);
});

test('Skill 实验复用四步向导并仅由预设改变默认配置', () => {
  const wizard = readFileSync('src/app/(main)/experiments/new/page.tsx', 'utf8');
  const panel = readFileSync('src/components/skill-workbench/ExperimentPanel.tsx', 'utf8');
  const result = readFileSync('src/components/skill-workbench/SkillExperimentResult.tsx', 'utf8');
  const experimentDetail = readFileSync('src/app/(main)/experiments/[id]/page.tsx', 'utf8');
  const caseDetail = readFileSync('src/app/(main)/experiments/[id]/cases/[caseId]/page.tsx', 'utf8');
  const experimentService = readFileSync('src/lib/skill-workbench/experiment-service.ts', 'utf8');
  const experimentApi = readFileSync('src/app/api/experiments/[id]/route.ts', 'utf8');
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
  assert.doesNotMatch(wizard, /任务结果正确性|Skill 版本回归|证据忠实度|name:\s*'执行成本'/);
  assert.match(wizard, /Array\.from\(catalog\.values\(\)\)/);
  assert.match(wizard, /skillPreset === 'skill-ab' \|\| traceMode === 'generate'/);
  assert.match(panel, /ExperimentWizard/);
  assert.match(panel, /context\.experiments/);
  assert.match(panel, /experiments\?user=\$\{encodeURIComponent\(user\)\}&version=\$\{version\}/);
  assert.doesNotMatch(panel, /\/api\/experiments\?user=/);
  assert.match(experimentService, /listWorkbenchExperiments\(user: string, skillName: string, skillVersion: number\)/);
  assert.match(experimentService, /where:\s*\{\s*user,\s*skillName,\s*skillVersion,\s*scope: 'skill-workbench'/);
  assert.match(experimentService, /scope:\s*'skill-workbench'/);
  assert.match(experimentService, /status:\s*experiment\.status === 'draft' \? 'running' : experiment\.status/);
  assert.match(experimentService, /input\.preset === 'trigger'[\s\S]*SKILL_TRIGGER_ANALYZER_EVALUATOR_ID/);
  assert.match(experimentApi, /snapshot\.grayscaleTaskId/);
  assert.match(experimentApi, /evalExperimentId === id/);
  assert.match(experimentApi, /tx\.grayscaleTask\.deleteMany/);
  assert.match(wizard, /SKILL_TRIGGER_ANALYZER_EVALUATOR_ID/);
  assert.match(result, /SKILL_TRIGGER_ANALYZER_EVALUATOR_ID/);
  assert.match(result, /experiments\?user=\$\{encodeURIComponent\(user\)\}&version=\$\{version\}/);
  assert.match(result, /ExperimentCaseDetail/);
  assert.match(result, /onOpenCase=\{setCaseDetailId\}/);
  assert.match(experimentDetail, /embedded && onOpenCase/);
  assert.match(caseDetail, /export function ExperimentCaseDetail/);
  assert.match(caseDetail, /!embedded && <AppTopBar/);
  assert.match(caseDetail, /embedded && onBack/);
  assert.match(result, /冻结实验配置/);
  assert.match(result, /生成实验结论/);
  assert.match(result, /评估完成后生成最终 A\/B 结论/);
  assert.match(result, /formatScore\(isDone \? abComparison\.aScore : null\)/);
  assert.match(result, /useEvaluatorLookup\(user\)/);
  assert.match(result, /evaluatorLookup\.nameOf\(id\)/);
  assert.match(result, /buildAbComparison/);
  assert.match(result, /当前版本[\s\S]*对比版本/);
  assert.match(result, /评估器分解/);
  assert.match(result, /A 胜[\s\S]*B 胜[\s\S]*未配对/);
  assert.match(result, /参考输出[\s\S]*A · \{versionALabel\} 实际输出[\s\S]*B · \{versionBLabel\} 实际输出/);
  assert.doesNotMatch(result, /const EVALUATOR_LABELS/);
  assert.doesNotMatch(result, /任务结果正确性|Skill 版本回归|证据忠实度|'执行成本'/);
});

test('生成和优化由服务端完成工作台同步，客户端断开 SSE 不会中止任务', () => {
  const mirror = readFileSync('src/lib/chat/block-mirror.ts', 'utf8');
  const generatorRoute = readFileSync('src/app/api/skill-generator/chat/route.ts', 'utf8');
  const optimizerRoute = readFileSync('src/app/api/skill-opt/chat/route.ts', 'utf8');
  const optimizationAdapter = readFileSync('src/lib/skill-workbench/optimization-adapter.ts', 'utf8');
  const generationConversation = readFileSync('src/components/skill-workbench/GenerationConversation.tsx', 'utf8');
  const optimizationConversation = readFileSync('src/components/skill-workbench/OptimizationConversation.tsx', 'utf8');
  assert.match(mirror, /clientConnected/);
  assert.match(mirror, /catch \{\s*clientConnected = false/);
  assert.match(generatorRoute, /finishWorkbenchGenerationRun/);
  assert.match(optimizerRoute, /finishWorkbenchOptimizationRun/);
  assert.match(optimizerRoute, /repair: chatError \? undefined/);
  assert.match(optimizationAdapter, /inspectWorkbenchOptimizationForRepair/);
  assert.match(optimizationAdapter, /自动修复后重新质量校验/);
  assert.doesNotMatch(generationConversation, /action:\s*'sync'/);
  assert.doesNotMatch(optimizationConversation, /action:\s*'sync'/);
  assert.match(generationConversation, /后台执行中/);
  assert.match(optimizationConversation, /后台执行中/);
});

test('Skill 优化固定入口执行归并、自验证和静态质量门禁，通过后可直接发布', () => {
  const shell = readFileSync('src/components/skill-workbench/SkillWorkbenchShell.tsx', 'utf8');
  const conversation = readFileSync('src/components/skill-workbench/OptimizationConversation.tsx', 'utf8');
  const adapter = readFileSync('src/lib/skill-workbench/optimization-adapter.ts', 'utf8');
  const records = readFileSync('src/components/skill-workbench/OptimizationRecordsPanel.tsx', 'utf8');
  const optimizerRoute = readFileSync('src/app/api/skill-opt/chat/route.ts', 'utf8');
  const optimizerBridge = readFileSync('src/lib/skill-opt-bridge.ts', 'utf8');
  assert.match(shell, /Skill 优化[\s\S]*startOptimization\(\{ autoRun: true \}\)/);
  assert.match(conversation, /根据这些问题优化 Skill/);
  assert.match(conversation, /\/api\/skill-opt\/plan/);
  assert.match(conversation, /planId: plan\.id/);
  assert.match(conversation, /optimization_plan/);
  assert.match(conversation, /verify_progress/);
  assert.match(conversation, /verify_ok/);
  assert.match(conversation, /我会基于评估与实验结果生成候选版本，当前版本不会被覆盖/);
  assert.match(conversation, /分析优化依据[\s\S]*生成候选版本[\s\S]*执行质量校验[\s\S]*整理优化报告/);
  assert.match(conversation, /recordMessageIndexes[\s\S]*recordsAtMessage/);
  assert.match(conversation, /OptimizationResultCard[\s\S]*查看优化报告/);
  assert.doesNotMatch(conversation, /latestRecord/);
  assert.match(shell, /role="separator"/);
  assert.match(shell, /skill-workbench-copilot-width/);
  assert.match(optimizerRoute, /optimization_meta/);
  assert.match(optimizerRoute, /optimization-run/);
  assert.match(optimizerRoute, /blocks: JSON\.stringify\(\[runMeta\]\)/);
  assert.match(conversation, /optimizationRoundAssignments/);
  assert.match(conversation, /runId = crypto\.randomUUID\(\)/);
  assert.match(conversation, /setLocalStep\(1\)/);
  assert.match(conversation, /index === liveMessageIndex \? activeTask : undefined/);
  assert.doesNotMatch(conversation, /find\(\(item\) => \['pending', 'running'\]\.includes\(item\.status\)\) \|\| tasks\.at\(-1\)/);
  assert.match(conversation, /未关联的历史优化记录/);
  assert.doesNotMatch(conversation, /Date\.parse/);
  assert.match(optimizerRoute, /模型服务连接失败，当前候选未生成，请稍后重新优化/);
  assert.match(optimizerBridge, /connectionFailedBeforeWork[\s\S]*模型服务连接中断，正在自动重试（1\/1）/);
  assert.match(conversation, /executionFailed[\s\S]*重新优化/);
  assert.match(conversation, /qualityFailed[\s\S]*qualityBlocked[\s\S]*未通过/);
  assert.match(adapter, /buildCandidateDiff/);
  assert.match(adapter, /beginSkillOptimizationRecord/);
  assert.match(records, /质量规则已通过/);
  assert.match(records, /发布为 \{getOptimizationTargetVersion\(selected\)\}/);
  assert.doesNotMatch(shell, /\/retest|optimizationRecordId=/);
  assert.match(shell, /role="dialog"[\s\S]*确认发布/);
});
