# 触发评测：超时上限 + 自动重试 + 跑完/没跑完可见性

日期：2026-06-05
分支：`feat/trigger-eval-timeout-retry-visibility`

## 背景 / 问题

线上（119）某 skill 触发评测的"应触发场景"全挂（TPR=0），排查发现**不是 skill 不触发，而是执行被超时掐断**：

- 单条 query 默认 30s 超时，并发 5。opencode/deepseek 在多路并发下慢，正样本常常在模型刚吐完前言、还没跑到 `skill` 调用时就被 abort。
- runner 里"30s 超时 abort"和"自然跑完没触发"落库后**完全一样**（都 `triggered:false`、无 error），前端无从区分，于是"全挂"看起来像 skill 质量问题，实则是执行问题。
- 反证：同一批里负样本在轻载时 9–11s 跑完并成功触发了目标 skill，说明 skill 本身能触发。

## 目标（用户确认）

1. 提高单条超时上限。
2. 在"执行 · 评测运行"卡片展示哪些**跑完了**、哪些**没跑完**。
3. 前端给出**报错原因**。
4. 超时导致没调用 skill 时**自动重试几次**。

### 已拍板的参数

- 超时：上限 `120s → 300s`，默认 `30s → 60s`。
- 重试：仅对 timeout 重试，最多 2 次（共 3 次尝试），`TRIGGER_EVAL_TIMEOUT_RETRIES` 可覆盖、clamp 到 [0,5]。

## 设计

### 数据模型：给 run 结果加"结束原因"维度

`SingleRunOutcome`（runner 内部）新增 `endReason: 'triggered' | 'completed' | 'timeout' | 'error'` 与 `attempts`。

- `triggered` 命中目标 skill / `completed` 自然跑完没触发 → **真正产出了路由决策**（跑完）
- `timeout` 被超时掐断 / `error` opencode 报错 → **没跑完**

`TriggerRunResultItem`（落库，JSON 字段，**无需 Prisma 迁移**）新增可选字段：
`runsCompleted` / `runsTimedOut` / `runsErrored` / `errorMessage`。旧记录无这些字段 → 前端按缺失兼容（显示为 0 / 不显示）。

### 纯逻辑抽出单测：`triggerEvalRetry.ts`

把唯一带分支的逻辑（结束原因分类、重试决策）抽成纯函数单放一处，避免单测被 opencode client / prisma 重依赖拖累：

- `classifyEndReason({triggered, sessionError, timedOut})` — 优先级：命中 > 报错 > 超时 > 自然跑完。
- `resolveMaxTimeoutRetries(env)` / `MAX_TIMEOUT_RETRIES`。
- `retryOnTimeout(runOnce, {maxRetries, isAborted, onRetry})` — 只重试 timeout；命中/自然跑完/报错都不重试；外部终止即停；返回带 `attempts`。

覆盖：`test/trigger-eval-retry.test.ts`（17 例）。

### 前端展示

- **卡片摘要 `ExecSummary`**：最近一次 run 若有 item 没跑完，追加 `⚠ N 条没跑完（超时 X · 出错 Y）`。
- **结果行（TriggerColumn 内联）**：`⏱ 超时 N`、`⚠ 出错 N`（hover 显示 errorMessage）。
- **详情证据（RecallResultBlock / toItem）**：触发率后追加 `⏱ N 次超时未跑完`、`⚠ N 次出错：<msg>`；并且当一条 fail 由"没跑完"主导时，建议从"改 SKILL.md"改成"提高超时/降并发后重测"，避免误导。
- RunDialog 超时 input `max 120000 → 300000`，默认 `30000 → 60000`。

## 触碰的文件

| 文件 | 改动 |
|---|---|
| `src/lib/engine/skill-generation/evaluator/runners/triggerEvalRetry.ts` | 新增：结束原因分类 + 重试纯逻辑 |
| `src/lib/engine/skill-generation/evaluator/runners/triggerEval.ts` | endReason 记录、`evalOneWithRetry`、聚合 runsCompleted/TimedOut/Errored/errorMessage |
| `src/server/skill_trigger_eval_storage.ts` | `TriggerRunResultItem` 加 4 个可选字段 |
| `src/app/api/skill-eval/trigger/[skillName]/run/route.ts` | 超时 cap/默认 300s/60s |
| `src/app/(main)/skill-eval/trigger/[skillName]/page.tsx` | 本地类型镜像 + 卡片/结果行/证据/输入框展示 |
| `test/trigger-eval-retry.test.ts` | 新增单测 |

## 验证

- `npx tsc --noEmit -p tsconfig.json`：`src/` 0 错（杂物来自仓库外未跟踪目录）。
- eslint（限改动文件）：0 新增错误；page.tsx 的 3 个 `set-state-in-effect` 为既有问题（upstream/master 同样 3 个）。
- `npm run test`：190 pass / 0 fail / 1 skip（含新增 17 例）。
- 端到端（真实触发评测路径）建议在 119 用新 build 重跑目标 skill 验证 TPR 回正——既验功能也复验本次根因。

## 风险

- 重试只对 timeout 生效，最坏把超时用例的 eval 成本放大 3×（受 `TRIGGER_EVAL_TIMEOUT_RETRIES` 约束）。
- 超时上限抬到 300s 后，极慢 run 会占用全局 opencode 槽更久（全局并发上限 5 不动）。
- 降并发往往比加超时更有效（轻载下 9–11s 即跑完），UI 已暴露并发旋钮，建议重测时一并调低。
