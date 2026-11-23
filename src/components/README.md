# `src/components/` — 按业务模块组织

| 目录 | 对应模块 | 主要文件 |
|---|---|---|
| `shell/` | 应用外壳 | `AppSidebar`、`AppTopBar`、`providers` |
| `observe/` | 模块一 · 链路观测 | `AgentTraceView`、`TraceDrawer` |
| `eval/` | 模块二 · 评测能力 | `Dashboard`（聚合指标）、`SingleExecutionMetrics`、`SkillEvaluation`、`ExecutionFlowComparison` |
| `skills/` | 模块四 · Skills 资产 | `SkillRegistry`、`SkillDiagnosis`、`SkillLink` |
| `config/` | 平台配置 | `ModelConfigManager`（驱动 `/modelconfig/*` 三个子页） |
| `onboarding/` | 用户引导 | `UserGuide`（首登弹窗） |
| `primitives/` | 通用基础 | `ComingSoon`、`LanguageSwitch` |

## 与 `src/lib/` 的关系

UI 层（这里）只允许 import：
- `@/lib/client/*`（hooks / context / fetch 封装）
- `@/lib/auth/auth-context`（React Context）
- `@/lib/shared/*`（纯 util / 类型）

**不允许**：直接 import `@/lib/storage/`、`@/lib/ingest/`、`@/lib/engine/*` —— 那些是服务端模块，需要通过 `src/app/api/` 暴露的接口访问。
