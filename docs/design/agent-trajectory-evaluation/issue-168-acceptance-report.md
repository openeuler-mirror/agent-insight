# Issue #168 验收报告

## 当前结论：PASS（按五层依赖链提交）

Issue #168 的事实抽取、Judge 契约、两个独立评估器、Prompt 安全、注册与实验分发均已完成定向验证。2026-08-29 在 openEuler 24.03 LTS SP4 上通过生产调用路径使用 DeepSeek Pro 重跑，24/24 场景、48/48 调用通过，错误分类为空。

原 `preset-agent-trace-quality` 的卡片、faithful runner、旧轨迹 API 和消费者没有被替换。新增能力使用两个独立 ID：`preset-agent-step-efficiency` 与 `preset-agent-process-quality`。

## 环境与提交边界

- 操作系统：openEuler 24.03 LTS SP4 x86_64。
- 基线：`upstream/master@a767463b`。
- PR 1：`feature/issue-168-trajectory-facts-v2@b55fa7fd`，新增轨迹事实层、采集去重修复与专项测试。
- PR 2：`feature/issue-168-trajectory-judge-foundation-v2@9ee77407`，新增共享 Judge 基础，不注册产品 ID。
- PR 3：`feature/issue-168-step-efficiency-v3@e13df9a6`，仅新增步骤效率评估器及其产品接入。
- PR 4：`feature/issue-168-process-quality-v5@e3c53fed`，新增执行过程质量评估器及产品接入。
- PR 5：文档与验收证据，父提交精确指向 PR 4。

各层保持独立依赖边界，新增修复与验收记录均使用 Conventional Commit，Author 与 Committer 邮箱为 `2404873013@qq.com`。临时脚本、模型配置、API Key、原始报告和 JSON 证据均未纳入提交。

## 自动化门禁

| 门禁 | 结果 |
|---|---|
| 任务相关 Node.js 测试 | 131/131 通过，覆盖事实层、契约修复、24 个场景、Prompt 安全、注册唯一性和实验引擎分发 |
| TypeScript | `npx tsc --noEmit -p tsconfig.next.json` 通过 |
| ESLint | 任务范围非页面 TypeScript 文件通过 |
| 差异检查 | `git diff --check` 通过 |
| 旧能力隔离 | 原轨迹质量仍由 faithful runner 唯一认领；两个新增评估器不替换旧评估器，也不通过特殊 ID 在 Skill 入口隐藏 |

三个既有 Skill 评测页面沿用统一的 `status === 'ready'` 可见性规则，没有增加针对新增评估器的特殊 ID 分支。全仓测试此前存在与本任务无关的基线失败，因此本报告不宣称全仓全绿。

## 三组复杂问题轨迹实机验收

2026-09-01 使用 WSL 中的真实 Agent 执行三组受控复杂任务，通过正常客户端链路上报到 openEuler 上的 Agent Insight；评估输出由真实 Judge 调用生成，不使用 mock 分数。

| Case | 轨迹问题 | 实际工具调用 | 步骤效率 | 过程质量 | 综合分 |
|---|---|---:|---:|---:|---:|
| A | 重复检查、碎片化读取、可合并调用 | 11 | 50 | 100 | 75 |
| B | 连续读取不存在文件，并执行无关系统探测 | 9 | 30 | 100 | 65 |
| C | 最终结论违背工具证据，并遗漏关键失败记录 | 5 | 40 | 50 | 45 |

- 实验 ID：`cmthiyb3g0007p0ml2s1cgjq8`。
- 进度：3 个 Case、2 个评估器，6/6 完成，0 失败，0 待执行。
- 综合分：61.7；步骤效率平均分 40；执行过程质量平均分 83.3。
- Case B 的步骤效率评估明确定位无关的系统信息探测与路径绕行，并给出中文改进建议和关联步骤。
- Case C 的过程质量评估明确定位“工具证据为 7 个失败、失败率 16.67%，最终结论却写成 0/0%”及关键 ID 遗漏。
- 页面已验证实验总览、评估器分解、Case 明细、评分点、中文证据、建议和关联步骤均可下钻展示，证据区不会直接暴露内部 JSON。

采集侧额外覆盖 Hook 与 OTel 的批量 JSONL、合并标签、截断输出和延迟事件重复上报；修复后上述三条轨迹的平台工具调用数与物理执行数一致，适配器定向测试 34/34 通过。演示截图、受控输入与运行时原始证据保存在验收环境，不提交二进制截图、凭据或模型配置。

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
