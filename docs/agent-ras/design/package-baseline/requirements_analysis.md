# agent_ras 需求分析规格（IR）

> Phase1 产出。来源：抽仓交接、多平台讨论定稿、implementation_status。视角：产品/宿主集成方。  
> **落位**：能力模块进入 **AgentInsight**。

## 1. 背景与动机

Agent 长任务中易出现 thinking loop、重复工具调用等环内故障。现有 **Agent RAS** 已在 openjiuwen（DeepAgent Rail）内实现检测 + 自动恢复（abort / steer / notice / HITL / L3 Skill），但代码与宿主强绑定，无法以同一套可靠性语义挂到 OpenCode、openclaw、Hermes 等运行时。

业务诉求：

1. **不削弱**现有 jiuwen 用户能力；
2. **可扩展**到更多 Agent 宿主，且检测/恢复逻辑可复用、模块边界清晰；
3. 后续作为能力模块进入 **AgentInsight**，安装与监控 UI 对齐 insight 约定。

## 2. 用户与场景

| 角色 | 场景 | 期望 |
|------|------|------|
| jiuwen / jiuwenclaw 集成方 | `create_deep_agent(agent_ras=…)` / YAML 启用 | 行为与今日一致：流中检测、停流、steering、L3、HITL |
| OpenCode + AgentInsight 用户 | 经 insight 安装 RAS 后可选启用 | 在能力范围内降低死循环/重复工具危害；不强求与 jiuwen 同深；监控看 insight Trace 页面 |
| openclaw / Hermes 集成方 | 按平台 INSTALL 挂载 | 映射宿主已有 abort/steer/hooks；深度见能力矩阵 |
| RAS / AgentInsight 维护者 | 加新平台或改检测算法 | 改算法只动 `agent_ras/core`；加平台只加 adapter；insight 侧只做胶水 |

## 3. 需求边界

### 在范围内

- 环内异常检测（L1/L2/L3）与恢复策略复用
- openjiuwen 全量深挂载保真
- OpenCode / openclaw / Hermes 可挂载（允许能力子集）
- Host 控制面与 L3 Agent 运行时均可按平台切换
- 包结构可迁入 AgentInsight（仓根 `agent_ras/` + insight 安装/UI 胶水）

### 不在范围内

- 用 OTLP **替代**环内恢复（旁路上报可选，非本阶段必需）
- 与 jiuwen **同等** chunk 级停流（除非该宿主原生具备）
- agent_ras_eval、fork openjiuwen.core
- 做成独立于 AgentInsight 的第二套长期全局安装根
- 重写检测算法语义

## 4. 功能需求

| ID | 需求 | 优先级 | 验收要点 |
|----|------|--------|----------|
| FR-01 | 保持 jiuwen 现有 RAS 能力不降级 | P0 | 流观测、abort、steer、notice、HITL、L3 DeepAgent、factory/YAML 路径可用 |
| FR-02 | 检测/恢复领域逻辑平台无关、单份实现 | P0 | core 无宿主 SDK import；换平台不改 Detector/Recovery 源码 |
| FR-03 | Host 控制面可适配（abort/steer/notice 等） | P0 | 经 HostControl；jiuwen 委托原 API |
| FR-04 | L3 Skill 调用可适配（AgentAdapter） | P0 | 已有 Protocol；平台可换实现或 NoOp |
| FR-05 | OpenCode 可挂载 RAS（允许 partial） | P1 | 插件 hooks + 能力矩阵文档；默认可不启 L3 |
| FR-06 | openclaw / Hermes 可扩展挂载 | P2 | 独立 adapter 目录 + INSTALL + 矩阵行 |
| FR-07 | 并入 AgentInsight 的安装与落位 | P1 | 仓根 `agent_ras/`；`agent-insight install-ras` 安装 OpenCode 插件；人机 UI 走可靠性观测 |

## 5. 非功能需求

| ID | 需求 | 优先级 |
|----|------|--------|
| NFR-01 | 模块边界清晰：core / 契约 / platform_adapter | P0 |
| NFR-02 | 不过度设计：不为 adapter 内部机制建多余 Protocol | P0 |
| NFR-03 | Fail-open：L3/控制失败不拖垮主 Agent | P0 |
| NFR-04 | 能力诚实：文档矩阵标明 deep/partial/none | P0 |
| NFR-05 | 可测：core 可用假 HostControl/AgentAdapter 单测 | P0 |

## 6. 约束与假设

- abort 流语义依赖宿主已提供的契约（jiuwen：agent-core rail-base）；本仓不 fork core。
- OpenCode 通过 bun:ffi 在宿主进程嵌入 Python；Python 宿主直接调用 `ras_embed`。
- 会话中已否决：顶层 ports 大而全、StreamBus Protocol、capabilities 模块。
- 分层仍是「核 + 薄适配器」；安装/UI 跟 insight。

## 7. 优先级结论

**P0**：FR-01～04 + NFR → 先抽核保 jiuwen。  
**P1**：OpenCode partial + AgentInsight 落位安装。  
**P2**：openclaw、Hermes。
