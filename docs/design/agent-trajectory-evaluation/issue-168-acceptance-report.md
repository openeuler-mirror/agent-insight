# Issue #168 验收报告

## 当前结论：PASS（按五层依赖链提交）

Issue #168 的事实抽取、Judge 契约、两个独立评估器、Prompt 安全、注册与实验分发均已完成定向验证。2026-08-29 在 openEuler 24.03 LTS SP4 上通过生产调用路径使用 DeepSeek Pro 重跑，24/24 场景、48/48 调用通过，错误分类为空。

原 `preset-agent-trace-quality` 的卡片、faithful runner、旧轨迹 API 和消费者没有被替换。新增能力使用两个独立 ID：`preset-agent-step-efficiency` 与 `preset-agent-process-quality`。

## 环境与提交边界

- 操作系统：openEuler 24.03 LTS SP4 x86_64。
- 基线：`upstream/master@a767463b`。
- PR 1：`feature/issue-168-trajectory-facts-v2@41e5f967`，仅新增轨迹事实层与专项测试。
- PR 2：`feature/issue-168-trajectory-judge-foundation-v2@9ee77407`，新增共享 Judge 基础，不注册产品 ID。
- PR 3：`feature/issue-168-step-efficiency-v3@7e32ecce`，仅新增步骤效率评估器及其产品接入。
- PR 4：`feature/issue-168-process-quality-v5@29cc17e9`，新增执行过程质量评估器及入口隔离。
- PR 5：文档与验收证据，父提交精确指向 PR 4。

每层只有一个 Conventional Commit，Author 与 Committer 邮箱均为 `2404873013@qq.com`。临时脚本、模型配置、API Key、原始报告和 JSON 证据均未纳入提交。

## 自动化门禁

| 门禁 | 结果 |
|---|---|
| 任务相关 Node.js 测试 | 131/131 通过，覆盖事实层、契约修复、24 个场景、Prompt 安全、注册唯一性和实验引擎分发 |
| TypeScript | `npx tsc --noEmit -p tsconfig.next.json` 通过 |
| ESLint | 任务范围非页面 TypeScript 文件通过 |
| 差异检查 | `git diff --check` 通过 |
| 旧能力隔离 | 原轨迹质量仍由 faithful runner 唯一认领；新过程质量不进入三个 Skill 专用入口和旧轨迹 API |

三份既有大型 Skill 页面只增加 `preset-agent-process-quality` 排除条件，仍保留仓库已有 lint 债。全仓测试此前存在与本任务无关的基线失败，因此本报告不宣称全仓全绿。

## 真实 Judge 证据

- 报告标识：`authoritative-v22-process-quality-final`。
- 生产调用路径：`runAgentTrajectoryPreset → runAgentTrajectoryJudge → callJudgeLlm`。
- 测试注入或 mock：未使用。
- 模型：`DeepSeek (Official)` / `deepseek-v4-pro`，配置内容已脱敏。
- 结果：24/24 场景通过，48/48 调用通过，错误分类 `{}`。
- Q02“执行目标持续漂移”两轮均输出 `goal_drift`，覆盖“最终回到原目标也不能抵消此前多个无关动作”的回归边界。
- 报告和脱敏 JSON 只保存在 VM 验收目录，不提交模型输出或凭据。

## 提交与合并顺序

1. canonical 轨迹事实层。
2. canonical Judge 基础。
3. Agent 执行步骤效率评估器。
4. Agent 执行过程质量评估器。
5. 文档与验收证据。

后置 PR 的平台页面在前置 PR 合并前可能显示累计差异；评审本层真实增量时，应使用 PR 描述中给出的相邻提交区间。五个 PR 必须按上述顺序合并。
