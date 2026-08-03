# Agent RAS 能力矩阵

> 真源文档。平台实现不得宣称超出本表的深度。架构见 [ras_architecture.md](./ras_architecture.md)。

| 能力 | openjiuwen | OpenCode | openclaw | Hermes |
|------|------------|----------|----------|--------|
| 生命周期 → Signal / observe | 深（in-proc） | partial（part/tool → 协议） | 骨架（协议） | 骨架（协议） |
| Stream / 文本观测 | 深（chunk） | partial（`message.part.updated`） | 视宿主 | turn 级 |
| 检测/恢复算法 | 同一 core | **ras_embed（inproc）** | **ras_embed（inproc）** | **ras_embed（inproc）** |
| Insight 旁路 | InsightAnomalyReporter → ras-events | insight_push → ras-events | 经 hooks + insight_push | 经 hooks + insight_push |
| abort | `abort_stream`（流内） | L3 Host：`session.abort` + 确认重试（非 deep chunk） | 宿主映射 | 宿主映射 |
| steering | `push_steering` | L3 Host：idle 后 `session.prompt` ← action | `/steer` 等 | inject 近似 |
| user notice | 深（写流） | L3 Host：toast → idle 可见回退 → 日志（禁止静默） | 视宿主 | 视宿主 |
| L3 AgentAdapter | DeepAgent（SKILL 内联、独立 conversation；无 SkillUseRail） | `HostCallbackAgentAdapter` + Host `ras-judge` subagent（限 steps、禁工具） | 可选 | 可选 |
| runtime 生命周期 | 随宿主 | 随 OpenCode | 随宿主 | 随宿主 |
| 首期交付 | 全量（本仓已实现） | 协议客户端 + 思考/工具闸 | 预留骨架 | 预留骨架 |

图例：深 = 与 jiuwen 同级；partial = 可用但不等价；骨架 = 共享 client 可接、宿主钩子待填。

协议路径恢复分层：L0 `build_recovery_actions` 决策 → L1 下发 wire actions → L2 `applyActions`（≡ `apply_recovery_actions`）映射 Host 方法 → **平台 API 仅在 L3 Host 实现**（OpenCode：`platform_adapter/opencode/host_control.js`）。

### OpenCode L3（inproc）

- `service.transport: inproc`；`semantic_content_enabled` 默认 `true`（显式 `false` 关闭）。
- 安装脚本合并 `ras-judge` 到 `opencode.json`（hidden subagent，`steps: 2`，工具全 deny）。
- 门控命中后 `observe` 返回 `skill_requests`；插件**后台**开独立 session 跑 Judge（不阻塞 delta），再 `skill_result`；同 request 只下发一次；Judge 会话文本不回灌 observe。

### openjiuwen 运行时依赖（PR#2055 对齐说明）

- L3 判定成员：`DeepAgentAdapter` 将 `SKILL.md` **内联**进 query，并使用独立 `conversation_id`；跳过带 `stream_source_id` 的子流，避免串扰父会话检测。
- 开 `llm.stream` 前清除陈旧 abort 闩（`consume_abort_stream`）在 **openjiuwen `ReActAgent`** 内，本仓无对应文件；需使用含该修复的 agent-core / openjiuwen。
