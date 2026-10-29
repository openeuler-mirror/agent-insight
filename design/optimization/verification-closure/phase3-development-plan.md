# 开发与验证

1. 验收结果、目标失败反馈、证据持久化与候选关联。
2. Issue 证据驱动关闭、定向范围、上下文与输出控制。
3. 重试诊断与 UI 状态/链接，同步中英文操作与解释文档。
4. 专项集成测试：0→0、fail→pass、分数回归、部分覆盖、取消、候选变更、配置变化、复测复用、Issue 隔离、定向范围、输出截断、重试脱敏。
5. 全量测试、类型检查、真实模型端到端与浏览器正常/失败边界及刷新恢复，记录结果与限制。


## 验证结果（2026-10-29）

- TypeScript 全量类型检查通过；`git diff --check` 通过。
- 最终专项回归：99/99 通过，覆盖目标 0→0 拒绝、fail→pass、单用例退步、覆盖不全、来源与最终候选关联、复测零新增执行、配置/输入/评分变化失效、Issue 原始 ID 隔离、定向请求、输出截断全文保留、重试诊断脱敏。
- 全量 `npm run test`：4490 项，4452 通过、13 失败、25 跳过。其中 1 项旧 UI 文案断言已更新并在上述专项回归通过；剩余 12 项环境失败：PowerShell/pwsh、sqlite3 和 Python pydantic 缺失。未为此修改依赖。
- 真实模型浏览器 E2E：独立测试账号、标准 references/ Skill 连续两轮定向优化。耗时 60.312 秒、53.740 秒；各仅一次静态评估；行为均为 100→100，第二轮复用 1 个旧版结果。两轮 OpenCode session ID 不同，工作区与上一轮约束保留，实际文件差异均仅 SKILL.md。此轻量样例不能用来估算安全检查 Skill 的耗时降幅。
- UI：提交实际定向请求（checkedIssues 为空）、完成与刷新恢复、复用数量、待完整复测状态；失败夹具验证 0→0 提示、失败状态刷新保持、验证实验链接、用例详情重试次数/原因/耗时；浏览器 pageerror 为 0。
- 来源实验客户端分支使用真实 SQLite + 可控客户端/评分器集成测试，未对用户原安全检查 Skill 再发起真实客户端执行。失败 UI 和重试诊断使用明确标识的边界夹具。
- 最终按用户指示撤回 reference/ 兼容，标准目录仍为 references/；未修改用户已有 Skill、历史优化或评估结果。

本机验证材料：`/tmp/verification-closure-focused-final.log`、`/tmp/verification-closure-full.log`、`/tmp/verification-closure-types-final.log`、`/tmp/insight-closure-ui/browser-results.json`。UI 截图：`/tmp/insight-closure-ui/standard-final.png`、`/tmp/insight-closure-ui/failed-boundary.png`、`/tmp/insight-closure-ui/retry-diagnostics.png`。

## 临时实验自动清理追加验证

- 专项回归 102/102 通过；包括优化收尾自动清理、多轮清理、清理后复测零新增调用、证据变化失效后正式复测保留、失败/确认取消、运行中保护、跨用户隔离、历史任务时间范围与手动删除不复用。
- 全量 `npm run test`：4493 项，4456 通过、12 失败、25 跳过；失败仍为上述 pwsh、sqlite3、pydantic 环境依赖缺失。最终 TypeScript 检查、差异空白检查通过。
- 浏览器成功与失败夹具验证：报告显示分数/用例覆盖与清理提示，删除实验的链接消失；实验列表保留来源和正式复测，临时实验详情返回 404，pageerror 为 0。端到端收尾链路使用真实 SQLite 和可控客户端/评分器；此次清理未重新调用模型或执行用户 Case。
- 按用户要求清理所指会话关联的 3 个历史临时实验；事前保存受影响行的本机备份，事后验证来源实验未删除、已发布状态未变、原 100 分完整证据仍能通过复用校验，并通过列表 API 确认清理生效。
- 材料：`/tmp/verification-cleanup-final-focused.log`、`/tmp/verification-cleanup-full.log`、`/tmp/verification-cleanup-types.log`、`/tmp/insight-closure-ui/cleanup-browser-results.json`。截图：`cleanup-success.png`、`cleanup-failure.png`、`cleanup-experiments.png`（均在 `/tmp/insight-closure-ui/`）。
