# Agent 执行步骤效率与执行过程质量评估器 Implementation Plan

**Goal:** 在不新增 Prisma 字段和新页面的前提下，交付 `preset-agent-step-efficiency` 五维效率评估器和独立的 `preset-agent-process-quality` 六维过程质量评估器，完整覆盖 Issue #168 的 24 个验收场景，同时保持原 `preset-agent-trace-quality` 不变。

**Architecture:** 采用“统一轨迹事实 → 离散 Judge → 代码事实锚定 → 代码计分与封顶 → 实验适配”的单一事实来源。Canonical 模块不访问 Prisma、不返回 `EvaluatorOutput`；两个新评估器仅由实验入口投影领域结果，旧质量评估器继续走原 faithful/opencode 链路。

**Tech Stack:** TypeScript 5.9、Next.js 16、Zod 3、Node.js test runner、Prisma 5（只使用现有模型）、现有 `judge-llm.ts` Judge 边界。

**Spec:** [Phase 2 需求设计](phase2-requirements-design.md)，已于 2026-08-24 批准；实现基线 `master@0f8006e7`。

## Global Constraints

- [ ] 开始编码前检查工作树，不覆盖或回滚用户已有改动。
- [ ] 不修改 `prisma/schema.prisma`，不新增 API 路由，不新增页面。
- [ ] Issue 场景只进入测试，不把原文复制进生产 Prompt。
- [ ] Judge 只返回 `met | partial | missing` 和结构化证据；分数、权重、封顶全部由代码决定。
- [ ] Prompt 保留全部步骤；单文本字段最多 500 字，总字符超过 120,000 时明确失败，禁止静默头尾截断。
- [ ] `opencode-trajectory-evaluator.ts`、旧轨迹 API 和消费者保持原有职责。
- [ ] 效率卡与执行过程质量卡只注册到实验执行引擎；旧轨迹质量卡及其既有入口保持不变。
- [ ] 每项实现遵循红灯测试 → 最小实现 → 绿灯 → 定向回归。
- [ ] 未经用户明确授权，不 commit、不 push、不创建 MR；下面的 commit 步骤均为条件步骤。
- [ ] 全量 TypeScript 若命中既有基线错误，保存输出并证明本次文件无新增错误。

---

## File Structure

### 新增文件

```text
src/lib/engine/evaluation/agent-trajectory-facts.ts
src/lib/engine/evaluation/agent-trajectory-assessment.ts
src/lib/engine/evaluation/agent-trajectory-judge.ts
src/lib/engine/experiment/agent-trajectory-preset-evaluators.ts
src/prompts/agent-step-efficiency-prompt.ts
src/prompts/agent-process-quality-prompt.ts
test/agent-trajectory-facts.test.ts
test/agent-trajectory-assessment.test.ts
test/agent-trajectory-preset-evaluators.test.ts
test/evaluator-surface.test.ts
```

### 修改文件

```text
src/lib/evaluators/registry.ts
src/lib/evaluators/preset-evaluators.ts
src/app/(main)/skill-eval/page.tsx
src/app/(main)/skill-eval/_batch/page.tsx
src/app/(main)/skill-eval/grayscale/page.tsx
test/preset-registry-consistency.test.ts
test/experiment-engine.test.ts
docs/developer-guide/10-evaluator-development.md
docs/user-guide/evaluation/evaluators.md
docs/design/README.md
```

---

## Task 1: 统一轨迹事实层

**Files:** Create `src/lib/engine/evaluation/agent-trajectory-facts.ts`, `test/agent-trajectory-facts.test.ts`; keep `src/lib/engine/evaluation/trace-summarizer.ts` unchanged.

- [ ] **Step 1: 写索引和状态归一化红灯测试。** 覆盖 `buildAgentCallTree()` / `walkTree()` 顺序、跳过 `ras`、从 0 连续编号、`interactionIndex`、`depth`、`toolStatus` 优先级、底层 `trace_status/status/error` 回退和缺失状态 `unknown`。

- [ ] **Step 2: 定义并实现最小事实接口。**

```ts
export interface AgentTrajectoryFacts {
  steps: AgentTrajectoryStepFact[];
  statistics: AgentTrajectoryStatistics;
  candidates: AgentTrajectoryCandidates;
}

export function extractAgentTrajectoryFacts(interactions: unknown[]): AgentTrajectoryFacts;
export function promptAgentTrajectoryFacts(facts: AgentTrajectoryFacts): unknown;
```

复用 `agent-trace.ts` 的树构建与遍历，不复制第二套遍历算法。

- [ ] **Step 3: 写 Token、耗时、摘要、指纹红灯测试。** 对象键顺序不同但语义相同的参数 SHA-256 必须一致；摘要最多 500 字；缺失 Token 保持缺失；仅有效时间戳生成 `durationMs`。

- [ ] **Step 4: 实现稳定排序、SHA-256 和统计。** 统计包含各 kind 数量、失败数、总耗时和可验证 Token 总计；指纹不进入用户展示文本。

- [ ] **Step 5: 写并实现四类候选测试。** 覆盖 `repeatedSameCallCandidates`、`repeatedSameResultCandidates`、`unchangedRetryCandidates`、`consecutiveSimilarCandidates`，并加入分页、分片、参数变化反例。

- [ ] **Step 6: 保持旧 `trace-summarizer.ts` 完全不变。** 新 canonical 评估器直接使用事实层；通过测试固定事实层与旧入口都使用从 0 开始的稳定 `step-N` 锚点，但不改写旧提取路径。

- [ ] **Step 7: 写 Prompt 边界测试。** 81 步仍全部存在；120,000 字符可继续；120,001 字符抛 `TrajectoryPromptTooLargeError`。

- [ ] **Step 8: 运行定向验证。**

```bash
node --import tsx --test test/agent-trajectory-facts.test.ts
npx eslint src/lib/engine/evaluation/agent-trajectory-facts.ts test/agent-trajectory-facts.test.ts
```

预期：事实测试全绿，无 lint 错误。

- [ ] **Step 9: 条件提交。** 用户授权后再提交，建议消息：`feat(evaluation): add canonical trajectory facts`。

---

## Task 2: 严格 Judge 契约、grounding 和计分

**Files:** Create `src/lib/engine/evaluation/agent-trajectory-assessment.ts`, `test/agent-trajectory-assessment.test.ts`.

- [ ] **Step 1: 写 schema 红灯测试。** 分别覆盖五维和六维的缺维、重复维、额外维度、未知 code、code/dimension 不匹配、`met` 有建议、非 `met` 无建议或无问题。

- [ ] **Step 2: 定义领域输出。**

```ts
export type AgentTrajectoryEvaluatorKind = 'step-efficiency' | 'process-quality';

export interface AgentTrajectoryAssessment {
  kind: AgentTrajectoryEvaluatorKind;
  rubricVersion: 'agent-step-efficiency/1.0.0' | 'agent-process-quality/1.0.0';
  summary: string;
  score: number;
  baseScore: number;
  dimensions: AgentTrajectoryDimensionResult[];
  issues: GroundedTrajectoryIssue[];
  discardedIssues: DiscardedTrajectoryIssue[];
  appliedCaps: AppliedTrajectoryCap[];
  factsSummary: Record<string, unknown>;
}
```

- [ ] **Step 3: 固化 Phase 2 rubric。** 在代码中写死五/六维集合、16 个问题代码、等权、维度封顶、附加维度封顶和总分封顶，不允许 Judge 提供这些值。

- [ ] **Step 4: 写并实现 grounding。** 不存在的 step、与步骤不匹配的 `toolName`、未命中候选的确定性 code 进入 `discardedIssues`；非 `met` 因此失去全部证据时抛 `JudgeOutputParseError`。

- [ ] **Step 5: 写并实现去重。** 键为 `code + dimension + 排序后 stepIndexes + toolName`；同一根因的 `irrelevant_detour`/`excessive_detour` 只保留后者。

- [ ] **Step 6: 写并实现计分。** 顺序必须是 `100/50/0` → 维度/附加维度封顶 → 等权 baseScore → 最小总分封顶 → 一位小数；显式覆盖 0 分不被 falsy fallback 吞掉。

```ts
export function buildAgentTrajectoryAssessment(
  kind: AgentTrajectoryEvaluatorKind,
  facts: AgentTrajectoryFacts,
  judgment: unknown,
): AgentTrajectoryAssessment;
```

- [ ] **Step 7: 运行定向验证。**

```bash
node --import tsx --test test/agent-trajectory-assessment.test.ts
npx eslint src/lib/engine/evaluation/agent-trajectory-assessment.ts test/agent-trajectory-assessment.test.ts
```

预期：schema、grounding、计分和封顶测试全绿；新契约拒绝旧兼容字段。

- [ ] **Step 8: 条件提交。** 用户授权后再提交，建议消息：`feat(evaluation): add trajectory assessment contract`。

---

## Task 3: 统一 Judge 编排与效率评估器

**Files:** Create `agent-trajectory-judge.ts`, `agent-step-efficiency-prompt.ts`, `agent-trajectory-preset-evaluators.ts`, `test/agent-trajectory-preset-evaluators.test.ts`.

- [ ] **Step 1: 写 Judge 边界红灯测试。** 使用现有 `setJudgeLlmCallerForTest` 注入 JSON，不 fake 整个 runner；请求包含任务、完整事实、候选和 rubric，不包含权重或封顶。

- [ ] **Step 2: 实现统一编排接口。**

```ts
export interface RunAgentTrajectoryJudgeInput {
  kind: AgentTrajectoryEvaluatorKind;
  task: string;
  interactions: unknown[];
}

export async function runAgentTrajectoryJudge(
  input: RunAgentTrajectoryJudgeInput,
  callJudge: JudgeLlmCaller,
): Promise<AgentTrajectoryAssessment>;
```

Canonical 模块不得依赖用户、Prisma 或 `EvaluatorOutput`。

- [ ] **Step 3: 写效率正向场景 1、7、10、11。** 单步直接查询=100；参数错误后修正成功总分≥80；`2+2`=100；必要多步链总分≥90。

- [ ] **Step 4: 编写五维 Prompt 和实验映射。**

```ts
export const AGENT_TRAJECTORY_PRESET_IDS = [
  'preset-agent-step-efficiency',
  'preset-agent-trace-quality',
] as const;

export function isAgentTrajectoryPresetId(id: string): id is AgentTrajectoryPresetId;
export async function runAgentTrajectoryPreset(
  id: AgentTrajectoryPresetId,
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput>;
```

- [ ] **Step 5: 写效率负向场景 2、3、4、5、6、8、9、12。**

| 场景 | 必须命中 | 断言 |
|---:|---|---|
| 2 | `duplicate_no_gain` | total≤50，step_necessity≤40 |
| 3 | `irrelevant_detour` | total≤40，path_detour≤30 |
| 4 | `unchanged_retry_loop` | total≤40，retry_efficiency≤20 |
| 5 | `avoidable_llm_overuse` | total≤50，cost_efficiency≤30 |
| 6 | `fragmented_mergeable_steps` | total≤60，step_density≤50 |
| 8 | `excessive_detour` | total≤30，path_detour≤20，step_necessity≤30 |
| 9 | `unused_tool_result_processing` | total≤50，cost_efficiency≤30；须锚定成功工具结果、终态回答前的额外处理和终态回答 |
| 12 | `overrollback` | total≤40，retry_efficiency≤20 |

- [ ] **Step 6: 跑完效率 12 场景。** Prompt 明确分页、分片、轮询、幂等重试和必要串行不是天然问题；无预算/价格/历史时不得只凭绝对 Token 或耗时扣分。

- [ ] **Step 7: 定向验证。**

```bash
node --import tsx --test test/agent-trajectory-facts.test.ts test/agent-trajectory-assessment.test.ts test/agent-trajectory-preset-evaluators.test.ts
```

预期：效率 12 场景全绿，非法 Judge 输出仍能触发重试边界。

- [ ] **Step 8: 条件提交。** 用户授权后再提交，建议消息：`feat(evaluation): add step efficiency evaluator`。

---

## Task 4: 独立六维过程质量契约

**Files:** Create `src/prompts/agent-process-quality-prompt.ts`; modify Judge、实验适配和场景测试。

- [ ] **Step 1: 写质量正向场景 1、9、10、12。** 正常天气提醒≥95；无工具事实回答=100；完整 503 排障≥85 且各维≥80；主源失败后降级≥80 且异常处理≥80。

- [ ] **Step 2: 编写六维 Prompt。** 只评价可观察消息、参数、返回和决策；无显式计划按动作覆盖；无错误时 exception_handling=`met`；不得要求隐藏 chain-of-thought。

- [ ] **Step 3: 写质量负向场景。**

| 场景 | 必须命中 | 断言 |
|---:|---|---|
| 2 | `goal_drift` | total≤50，goal_alignment≤40 |
| 3 | `missing_required_step` | total≤50，planning_completeness≤30 |
| 4 | `unsupported_reasoning_jump` | total≤50，reasoning_coherence≤40 |
| 5 | `unhandled_recoverable_error` | total≤40，exception_handling≤30 |
| 6 | `contradicted_tool_result` | total≤50，information_utilization≤30 |
| 7 | `decision_thrashing` | total≤40，path_robustness≤30 |
| 8 | `internal_contradiction` | total≤40，reasoning_coherence≤30 |
| 11 | `unused_required_information` | total≤60，information_utilization≤50 |

- [x] **Step 4: 实现六维输出。** `rubricVersion='agent-process-quality/1.0.0'`，六个 points 等权；结果只使用新评估器自己的问题与证据结构，不投影到旧 Skill 偏差模型。

- [x] **Step 5: 写事实锚定与契约测试。** Judge 的问题步骤、工具名和候选问题必须能被 canonical facts 验证；缺维度、未知维度、无效步骤或错误工具名必须失败并进入一次安全 repair。

- [x] **Step 6: 隔离旧兼容字段。** 新 Prompt、Judge 契约、实验 evidence 和输出中均不包含 `referenceKeyActions`、`legacyCompatibility`、`toolChoice`、`redundancy`、`keyActions` 或 `completeness`。

- [ ] **Step 7: 跑 24 场景和破坏性检查。**

```bash
node --import tsx --test test/agent-trajectory-preset-evaluators.test.ts
```

预期：测试名可数出 efficiency 1..12 和 quality 1..12。临时移除任一 cap 时对应测试失败；确认后恢复临时改动。

- [ ] **Step 8: 条件提交。** 用户授权后再提交，建议消息：`feat(evaluation): upgrade trace quality rubric`。

---

## Task 5: Registry、产品卡和实验唯一分发

**Files:** Modify registry、preset cards、canonical runner ownership tests and experiment engine tests.

- [x] **Step 1: 写注册红灯测试。** 效率卡与执行过程质量卡 category=traj、requires=[]；旧质量卡仍属于 faithful 族且元数据不变；每张 ready 卡恰好一个 runner。

- [x] **Step 2: 最小扩展 registry。**

```ts
EVALUATOR_META['preset-agent-process-quality'] = {
  category: 'traj',
  requires: [],
};
```

只为新卡补充运行元数据，不给既有卡增加字段，不改变自建卡和公共 registry 契约。

- [x] **Step 3: 更新产品卡。** 新增执行过程质量卡，使用六维、0-100、canonical Judge 且不加入默认选择；旧轨迹质量卡恢复原卡片元数据。

- [x] **Step 4: 固定唯一分发。** `AGENT_TRAJECTORY_PRESET_IDS` 登记新质量 ID；`FAITHFUL_PRESET_IDS` 继续登记旧质量 ID；守卫测试断言两者互斥。

- [x] **Step 5: 改写实验引擎测试。** 新质量 ID 使用 Judge 注入；断言质量六 points、效率五 points 和 evidence/rubricVersion 完整，并保留旧 faithful runner 回归。

- [ ] **Step 6: 运行验证。**

```bash
node --import tsx --test test/preset-registry-consistency.test.ts test/experiment-engine.test.ts test/agent-trajectory-preset-evaluators.test.ts
```

- [ ] **Step 7: 条件提交。** 用户授权后再提交，建议消息：`feat(experiment): register trajectory evaluators`。

---

## Task 6: 证明旧轨迹链路未被修改

**Files:** 旧轨迹 API、faithful runner、Skill 对齐与质量监控文件只做基线比对，不实施功能修改。

- [x] **Step 1: 逐文件比对最新 `upstream/master`。** `route.ts`、`trajectory-evaluator.ts`、faithful runner、alignment、Skill 优化和质量监控文件均未被本需求修改。
- [x] **Step 2: 移除替换旧链路的测试和实现。** 不保留 legacy canonical adapter 或兼容消费者迁移代码。
- [ ] **Step 3: 运行旧 faithful、旧 API、Skill 和质量监控回归。**

---

## Task 8: 隔离旧 Skill 与旧轨迹入口

**Files:** Create `test/evaluator-surface.test.ts`; minimally modify three existing Skill selection pages.

- [x] **Step 1: 写入口边界测试。** 新执行过程质量卡可被实验 runner 唯一认领；三处 Skill 页面明确排除新 ID；旧轨迹 API 白名单不包含新 ID；旧轨迹质量卡的卡片和入口保持不变。

- [x] **Step 2: 最小修改三处 Skill 页面。** 保留原有 `status==='ready'` 逻辑，仅追加 `id !== 'preset-agent-process-quality'`；不修改实验弹窗、`useEvaluatorLookup.ts`、旧 API 或公共 registry 行为。

- [ ] **Step 3: 运行测试和组件 lint。**

```bash
node --import tsx --test test/evaluator-surface.test.ts test/preset-registry-consistency.test.ts
npx eslint src/components/eval/NewEvaluationBatchDialog.tsx src/components/eval/useEvaluatorLookup.ts "src/app/(main)/skill-eval/page.tsx" "src/app/(main)/skill-eval/_batch/page.tsx" "src/app/(main)/skill-eval/grayscale/page.tsx"
```

- [ ] **Step 4: 条件提交。** 用户授权后再提交，随新评估器一起提交，不拆出公共入口重构。

---

## Task 9: 文档、门禁和 openEuler SP4 验收

**Files:** Modify开发指南、用户指南、设计索引和本计划的实际完成状态。

- [x] **Step 1: 更新开发指南。** 记录 canonical/adapter 边界、rubricVersion、离散 Judge、grounding、Prompt 上限、入口隔离和新增卡测试清单。

- [x] **Step 2: 更新用户指南。** 说明效率五维、执行过程质量六维、两个质量 ID 的入口范围和旧评估器保持不变。

- [x] **Step 3: 跑目标测试。**

```bash
node --import tsx --test test/agent-trajectory-facts.test.ts test/agent-trajectory-assessment.test.ts test/agent-trajectory-preset-evaluators.test.ts test/evaluator-surface.test.ts test/preset-registry-consistency.test.ts test/experiment-engine.test.ts test/quality-monitoring-scorer.test.ts test/derive-skill-opt-points.test.ts
```

预期：全部通过，24 个场景各有独立测试名。

- [ ] **Step 4: 跑仓库门禁。**

```bash
npm run test
npx tsc --noEmit
git diff --name-only --diff-filter=ACMR -- '*.ts' '*.tsx' | xargs npx eslint
```

预期：全量测试和改动文件 lint 通过；`tsc` 若有基线错误，提供与 `master@0f8006e7` 对比证据。

实际（2026-08-29，openEuler SP4）：最终父链的事实层、Judge 契约、两个评估器、Prompt 安全、注册表和实验引擎定向测试 131/131 通过；`tsconfig.next.json`、任务范围非页面文件 ESLint 和 `git diff --check` 均通过。三份既有大型 Skill 页面只追加一条新 ID 排除条件，仍保留仓库已有 lint 债；全仓测试此前也存在与本任务无关的基线失败，因此本报告不宣称全仓全绿，只声明 Issue #168 的定向门禁和真实 Judge 验收通过。

- [x] **Step 5: 做差异自检。**

```bash
git diff --check
rg -n "TO[D]O|TB[D]|待[补]" docs/design/agent-trajectory-evaluation/phase3-development-plan.md
git status --short
git diff --stat
```

预期：diff check 无输出；计划无未替换占位符；diff 不含 Prisma、lockfile 或无关格式化。

- [x] **Step 6: 在 openEuler 24.03 LTS SP4 完成当前新 ID 的真实 Judge 验收。** DeepSeek Pro 无测试注入的 `...authoritative-v22-process-quality-final` 单一报告通过 `preset-agent-process-quality` 生产入口达到 24/24 场景、48/48 调用，错误分类为空；满足放行条件。报告和脱敏 JSON 仅保存在 VM 验收目录，未纳入提交。

- [x] **Step 7: 验证历史兼容。** 新六维能力使用独立 ID；旧 ID 的卡片、runner、API 与消费者相对最新 `upstream/master` 不变，不回写、不重算历史结果。

- [x] **Step 8: 最终复核。** 核对 Phase 2 第 16 节、24 场景、新旧 ID 隔离、旧 AgentDebug 路径、无 Prisma 变更、每个有分 point 均有 evidence；只勾选实际完成项。

- [x] **Step 9: 条件提交和交付。** 真实验收通过后，五个分支按精确父提交重建，每层一个提交；Author 与 Committer 均使用个人 CLA 对应邮箱。旧 PR `#350`、`#351`、`#361`、`#362` 已关闭，不作为最终交付。

---

## PR 拆分交付设计

### 撤销策略

不在旧分支追加 `revert` 提交。先为旧 HEAD 建立仅本地备份引用，再从最新 `upstream/master` 重建拆分分支。替代 PR 完成验证并建立关联后，关闭旧 PR `#350`；在此之前不删除旧分支、不强制覆盖远端，确保全部代码与讨论可恢复。

### PR 1：canonical 轨迹事实层

- 范围：轨迹规范化、事实抽取、敏感信息脱敏和确定性候选。
- 边界：只新增 `agent-trajectory-facts.ts` 及对应测试；不修改 `trace-summarizer.ts`，不注册产品评估器，不修改 UI 入口。
- 门禁：事实层专项测试、TypeScript、变更文件 ESLint、`git diff --check`。
- 分支：`feature/issue-168-trajectory-facts-v2@41e5f967`，基于 `upstream/master@a767463b`。

### PR 2：canonical Judge 基础

- 范围：共享 assessment、Judge 输出契约、单次安全修复和 canonical 采样配置。
- 边界：不注册任何产品 ID，不增加卡片，不修改 UI 或实验分发；具体提示词由后续评估器注入。
- 门禁：assessment、契约修复、采样配置专项测试与 `git diff --check`。
- 分支：`feature/issue-168-trajectory-judge-foundation-v2@9ee77407`。
- 依赖：分支父提交精确指向 PR 1；正式合入时按 PR 1 → PR 2 顺序处理。

### PR 3：Agent 执行步骤效率评估器

- 范围：步骤必要性、路径绕行、成本效率、步骤密度、重试效率五维评分，效率 Prompt、预置卡片、注册表和实验入口。
- 边界：只认领 `preset-agent-step-efficiency`；`preset-agent-process-quality` 尚未注册，原 `preset-agent-trace-quality` 仍由 faithful runner 唯一认领。
- 门禁：12 个效率验收场景、引擎分发、注册唯一性和旧 faithful 回归。
- 分支：`feature/issue-168-step-efficiency-v3@7e32ecce`。
- 依赖：分支父提交精确指向 PR 2；正式合入时按 PR 1 → PR 2 → PR 3 顺序处理。

### PR 4：Agent 执行过程质量评估器与产品接入

- 范围：新增 `preset-agent-process-quality` 卡片，提供目标对齐、规划完整性、推理连贯性、异常处理、路径稳健性和信息利用六维评分；在三个 Skill 专用入口排除该通用评估器。
- 边界：不修改原 `preset-agent-trace-quality` 的卡片、faithful runner、旧轨迹 API 或质量监控；不回改效率产品 ID。
- 门禁：12 个质量验收场景、完整 24 场景回归、真实 Judge 24/24 场景与 48/48 调用、TypeScript、变更文件 ESLint、`git diff --check`。
- 分支：`feature/issue-168-process-quality-v5@29cc17e9`。
- 依赖：分支父提交精确指向 PR 3；正式合入时按 PR 1 → PR 2 → PR 3 → PR 4 顺序处理。

### PR 5：文档与验收证据

- 范围：需求分析、设计、开发计划、验收报告、开发者指南与用户指南。
- 边界：docs-only，不修改运行时代码、测试、依赖或数据库。
- 门禁：文档与最终代码标识一致，无旧内部 kind/rubric/文件名残留，开发者指南 provenance 指向 PR 4 代码提交。
- 依赖：分支父提交精确指向 PR 4；正式合入时按 PR 1 → PR 2 → PR 3 → PR 4 → PR 5 顺序处理。

### 提交与关联规则

- 每个拆分 PR 使用 Conventional Commits，并由个人 CLA 对应邮箱同时作为 Author 与 Committer 邮箱。
- 每个 PR 正文使用开源实习任务单的完整 URL，不使用裸 `#168`。
- 每个 PR 如实披露全仓基线失败，不宣称全仓测试全绿。
- 旧 PR `#350`、`#351`、`#361`、`#362` 已关闭；新 PR 创建后在描述中列出完整依赖顺序。

---

## Completion Gate

- [x] 效率卡只在实验入口可选并落库五维结果。
- [x] 执行过程质量卡以独立 ID 在实验入口输出六维 canonical 结果。
- [x] 原轨迹质量卡及旧入口保持最新 `upstream/master` 行为。
- [x] 24 场景通过真实评估器入口的自动化测试。
- [x] Judge 无法控制分数，虚构证据无法参与计分或封顶。
- [x] 每个有分 point 都有可回到真实步骤的 evidence/anchor。
- [x] 新质量卡不读取或改写旧 toolChoice/redundancy/keyAction 兼容信号。
- [x] AgentDebug Skill 分析与旧质量消费者仍使用旧链路。
- [x] 测试、改动文件 lint 和 diff check 通过，或已隔离既有基线错误。
- [x] openEuler 24.03 LTS SP4 使用当前 `preset-agent-process-quality` 的 v22 真实 Judge 单一报告达到 24/24 场景、48/48 调用，错误分类为空。
- [x] 文档与实现一致；五层分支按依赖顺序完成本地提交，旧 PR 已关闭并由新分支接管。
