> 历史方案：当前能力与 API 请以 [`../implementation_status.md`](../implementation_status.md) 为准。

---
name: Agent Reliability 可靠性监控框架 — 方案介绍
type: solution-overview
description: "openjiuwen 可靠性监控框架方案介绍：harness/agent_ras（41 文件，共享基座+单 Agent）+ agent_teams/agent_ras（7 文件，多 Agent team-level 扩展）。4+1 视图架构、检测器、恢复动作、LLM 思考死循环检测案例、目录结构设计、与 jiuwenswarm 的架构关联。"
change: feat
version: v1.0
update_time: 2026-07-10 (UTC+8)
---

# Agent Reliability 可靠性监控框架 — 方案介绍

> **项目名称**: openJiuwen Harness Agent Reliability  
> **版本**: v1.0 (实现基线 2026-07-09)  
> **代码位置**: `openjiuwen/harness/agent_ras/` (41 文件, 6677 行) + `openjiuwen/agent_teams/agent_ras/` (7 文件, 691 行) = **48 文件, 7373 行**  
> **定位**: agent-core 框架级基础能力 — DeepAgent 内置可靠性 Rail 子系统 + 多 Agent team-level 扩展
>
> 📌 文档层级：方案介绍（面向外部读者）

---

## 1. 背景与问题

### 1.1 可靠性能力建设的痛点

AI Agent 在实际生产环境中面临多种"不健康"运行状态——工具调用死循环、LLM 思考死循环、模型流式错误爆发、输出超长、频繁上下文压缩等。这些故障如果不被及时检测和恢复，会导致：

| 痛点 | 影响 | 典型场景 |
|------|------|----------|
| **工具调用死循环** | Agent 反复调用同一工具同一参数，消耗 token/API 配额无进展 | 搜索引擎返回空结果时反复重试 |
| **LLM 思考死循环** | 模型输出无限重复同一段文字，或语义上原地踏步不前进 | 复杂推理任务中模型"卡住"反复阐述计划 |
| **模型错误爆发** | 短时间内模型/API 连续报错，Agent 无法自愈 | API 限流、网络抖动导致连续 5xx |
| **输出超长** | 单次模型输出超出上下文窗口，导致后续调用失败 | 代码生成任务输出超 32K 字符 |
| **频繁上下文压缩** | 上下文管理器频繁触发压缩，丢失关键信息 | 长会话中消息列表快速膨胀 |

### 1.2 设计目标

| 目标 | 实现方式 |
|------|----------|
| **集中检测** | 统一 `AgentRASMonitor` 聚合 8 种检测器，Signal 事件总线驱动 |
| **可逆恢复** | 7 种 `RecoveryAction`，按 severity × kind 映射，从不自动 force_finish |
| **统一观测** | `RingBuffer` + `events()` async iterator + `get_metrics()` |
| **框架内置** | 通过 `create_deep_agent(enable_agent_ras=True)` 一行启用，零侵入 |
| **跨进程可选** | `spawn_mode=inprocess`（默认）与 `spawn_mode=process`（独立 service） |

---

## 2. 业务价值

| 价值维度 | 量化指标 | 说明 |
|----------|----------|------|
| **故障自愈率** | MEDIUM+ 异常自动恢复率 > 80% | INJECT_STEERING 自动纠偏 + SUPPRESS_STREAM 流式截断 |
| **人工介入延迟** | HITL 询问 < 5s（model_call 结束即触发） | DEFER_HITL 在模型调用结束后立即提问 |
| **检测延迟** | L1/L2 语法检测 p99 < 1ms；L3 语义检测 ≤ 30s（skill 超时） | 同步算法 O(n) + 异步 skill 单次调用 |
| **误报率** | < 5%（目标） | 边沿触发 + degenerate 过滤 + 枚举豁免 |
| **可观测性** | 1000 events/min 持续吞吐；10K 事件 RingBuffer | p99 事件处理 ≤ 10ms |
| **部署灵活性** | 零配置默认启用；YAML 60+ 参数可调 | `config.yaml[reliability]` 单一配置入口 |

---

## 3. 4+1 视图架构

### 3.1 场景视图 (Scenarios View)

#### 核心角色与痛点

| Actor | 核心痛点 | 框架如何解决 |
|-------|---------|-------------|
| **Agent 开发者** | 需为每个 Agent 配置可靠性检测，但不希望侵入业务代码 | `create_deep_agent(enable_agent_ras=True)` 一行启用；AgentRASRail 自动注册为 default rail (priority=5) |
| **SRE 运维** | 需实时监控 Agent 运行状态、异常事件、恢复动作 | `monitor.events()` async iterator 实时订阅；`get_metrics()` 聚合指标；`get_recent_events(n)` 历史查询 |
| **最终用户** | Agent 卡死时无感知，体验中断 | DEFER_HITL 在模型调用结束后向用户提问"输出是否正常"；ESCALATE_USER 主动通知 |
| **框架开发者** | 需扩展新检测器但不影响现有代码 | `DETECTOR_BUILDERS` 注册表 + `Detector` Protocol；新增检测器只需实现 `observe(signal) -> Anomaly | None` |

#### 关键场景

| 场景 | 触发条件 | 核心组件 | 后置状态 |
|------|---------|---------|---------|
| **Agent 启动 + 可靠性初始化** | `create_deep_agent(enable_agent_ras=True)` | factory.py → `agent_ras_rail_from_components()` → AgentRASRail(priority=5) 注册 | Monitor.start()；RingBuffer 初始化；stream callback 注册 |
| **流式输出中的实时检测** | LLM 产生 STREAM_CHUNK | AgentRASRail._on_stream_output → Signal(STREAM_CHUNK) → Monitor.feed → 8 detectors fan-out | 异常 → SUPPRESS_STREAM 截断 + DEFER_HITL 挂起 |
| **工具调用循环检测** | Agent 反复调用同一工具 | Signal(BEFORE/AFTER_TOOL_CALL) → RepeatToolCallDetector(4-tier) | LOW/MEDIUM/HIGH/CRITICAL → INJECT_STEERING / ESCALATE_USER |
| **LLM 思考死循环检测** | 模型输出重复文字或语义原地踏步 | Signal(STREAM_CHUNK) → LlmThinkingLoopDetector(双通道) | LLM_THINKING_LOOP → SUPPRESS_STREAM + DEFER_HITL → HITL 询问 |
| **HITL 人工介入** | DEFER_HITL 挂起后 model_call 结束 | RecoveryExecutor.run_deferred_completion → invoke_ask_user | 用户选择 → resolve_hitl_choice → 注入 steering 或继续 |
| **会话结束清理** | `after_invoke` | Rail 内 `Monitor.stop()` + 从 session 缓存 pop；async recovery drain | Monitor 为 invoke-scoped；HITL 待恢复数据保留在 session.state |

### 3.2 逻辑视图 (Logical View)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Application Layer (应用层)                        │
│  jiuwenclaw/agentserver/deep_agent/interface_deep.py                 │
│  └─ create_deep_agent(enable_agent_ras=True, reliability_config)  │
├─────────────────────────────────────────────────────────────────────┤
│                    Harness Layer (框架层)                             │
│  openjiuwen/harness/factory.py                                       │
│  └─ default_rails.append((AgentRASRail, True, ...))              │
├─────────────────────────────────────────────────────────────────────┤
│              Agent Reliability Layer (可靠性层)                       │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ AgentRASRail│ │ ReliabilityMon│  │    Signal Builder        │  │
│  │ (DeepAgentRail │ │ itor + Ring  │  │  7 个 build_xxx_signal() │  │
│  │  priority=5)   │ │  Buffer      │  │  从 ctx.inputs 构造 Signal│  │
│  │ 7 个生命周期钩子│ │ feed/route/  │  └──────────────────────────┘  │
│  │ + stream cb    │ │ events/      │                                 │
│  └──────┬─────────┘ └──────┬───────┘                                 │
│         │                  │                                         │
│         ▼                  ▼                                         │
│  ┌──────────────┐  ┌──────────────────────────────────────────┐    │
│  │ Remediation  │  │         Detectors (8 个检测器)             │    │
│  │ Executor     │  │  ┌─────────────┐ ┌──────────────────┐    │    │
│  │ + Policy     │  │  │ RepeatTool  │ │ LlmThinkingLoop   │    │    │
│  │ + AutoRemed  │  │  │ CallDetector│ │ Detector (653L)   │    │    │
│  │ + StreamGate │  │  │ (511L,4-tier)│ │ (双通道+Skill)    │    │    │
│  └──────┬───────┘  │ ├─────────────┤ ├──────────────────┤    │    │
│         │          │ │ ToolError   │ │ ModelStreamError │    │    │
│         ▼          │ │ RateDetector│ │ Detector         │    │    │
│  ┌──────────────┐  │ ├─────────────┤ ├──────────────────┤    │    │
│  │ Remediation  │  │ │ OutputLength│ │ FrequentCompaction│   │    │
│  │ Operations   │  │ │ Detector    │ │ Detector         │    │    │
│  │ steer/suppress│ │ ├─────────────┤ ├──────────────────┤    │    │
│  │ /flush/ask/   │  │ │ ErrorBurst  │ │ skill_verdicts   │    │    │
│  │ terminate     │  │ │ (base)      │ │ (parse_verdict)  │    │    │
│  └──────────────┘  │ └─────────────┘ └──────────────────┘    │    │
│                    └──────────────────────────────────────────┘    │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Agents       │  │ Messager     │  │    Service               │  │
│  │ (Port&Adapter│  │ (跨进程传输)  │  │ (独立进程监控)           │  │
│  │  Skill调用)  │  │ topics/publish│  │ subscribe+monitor+recover│  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────┤
│              Core Layer (基础层 — 冻结，不得修改)                     │
│  openjiuwen/core/single_agent/rail/base.py (AgentRail, 10 钩子)      │
│  openjiuwen/core/runner/callback.py (AgentEvents, callback_framework)│
└─────────────────────────────────────────────────────────────────────┘
```

#### 分层职责

| 层 | 职责 | 关键类 |
|----|------|--------|
| **信号层** | 从 DeepAgent 生命周期钩子构造 Signal | `signal_builder.py` (7 个 builder) |
| **收集层** | Rail 钩子捕获 Signal，交给 Monitor | `AgentRASRail` (priority=5, 7 钩子 + stream callback) |
| **检测层** | Monitor.detection 将 Signal fan-out 到 Detector | `AgentRASMonitor.detection` + Detectors |
| **恢复层** | Monitor.recovery → engine 映射 → operations | `RecoveryPolicy` / `RecoveryExecutor` / `operations` |
| **语义层** | 通过短生命周期 DeepAgent 调用 Skill 做语义判决 | `AgentAdapter` (Port) + `DeepAgentAdapter` + `NoOpAgentAdapter` |
| **传输层** | 跨进程 Signal/Recovery 传输 (MESSAGER 模式) | `MessagerAgentRASRail` + `AgentRASMessagerService` |

### 3.3 进程视图 (Process View)

```
方案 A: LOCAL 模式 (默认, 进程内)
┌─────────────────────────────────────────┐
│           Agent 进程                     │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐ │
│  │DeepAgent│→ │Reliabil.│→ │Monitor  │ │
│  │ Runner  │  │Rail     │  │+8 Detec.│ │
│  └─────────┘  └────┬────┘  └────┬────┘ │
│                     │            │      │
│                ┌────▼────────────▼───┐  │
│                │ RecoveryExecutor    │  │
│                │ + operations/HITL   │  │
│                └─────────────────────┘  │
└─────────────────────────────────────────┘
零延迟本地调用; 适合单 Agent / 低延迟场景


方案 B: MESSAGER 模式 (跨进程)
┌──────────────────────┐     ┌──────────────────────────┐
│    Agent 进程         │     │    Reliability Service    │
│  ┌────────────────┐  │     │    (独立进程)              │
│  │MessagerReliab. │  │     │  ┌──────────────────────┐ │
│  │Rail            │──┼────▶│  │ReliabilityMessager   │ │
│  │(publish Signal)│  │     │  │Service               │ │
│  └────────┬───────┘  │     │  │  subscribe signal    │ │
│           │          │     │  │  → Monitor.detection │ │
│  ┌────────▼───────┐  │     │  │  → Detector → Anomaly│ │
│  │Recovery drain  │◀─┼────│  │  → RecoveryAction    │ │
│  │(subscribe recov)│ │     │  │    publish back      │ │
│  └────────────────┘  │     │  └──────────────────────┘ │
└──────────────────────┘     └──────────────────────────┘
    topic: reliability:<id>      topic: recovery:<id>
    适合多 Agent / 重型检测隔离 / 集中监控
```

**Messager 传输契约**:

| Topic | 方向 | 载荷 |
|-------|------|------|
| `reliability:<agent_id>` | Agent → Service | `AgentRASSignalEvent` (Signal 序列化) |
| `recovery:<agent_id>` | Service → Agent | `RecoveryActionEvent` (恢复指令) |
| `reliability_control:<agent_id>` | 双向 | 控制消息 (start/stop/reset) |

### 3.4 开发视图 (Development View)

#### 目录结构

```
openjiuwen/harness/agent_ras/           # 41 文件 / 6677 行
├── __init__.py                  (151L)  # 公开 API (64 个符号导出)
├── models.py                    (185L)  # Signal/Anomaly/Severity/AnomalyKind/SignalKind/Event
├── window.py                    (127L)  # SlidingWindowCounter + stable_call_hash/result_hash
├── config.py                    (236L)  # AgentRASConfig + AgentRASSpawnMode + AgentRASTransportSpec
├── monitor.py                   (284L)  # AgentRASMonitor + RingBuffer
├── rail.py                      (389L)  # AgentRASRail (DeepAgentRail, priority=5)
├── reporter.py                   (85L)  # AnomalyReporter Protocol + RailEventAnomalyReporter
├── factory.py                   (426L)  # create_monitor / build_agent_ras_rail / DETECTOR_BUILDERS
├── signal_builder.py            (109L)  # 7 个 build_xxx_signal() 工具函数
├── async_recovery.py            (103L)  # AsyncRecoveryDetector Protocol
│
├── detectors/                           # 检测算法层
│   ├── __init__.py              (41L)   # 8 个 Detector re-export + 别名
│   ├── base.py                  (149L)  # Detector Protocol + ErrorBurstDetector 基类
│   ├── repeat_tool.py           (511L)  # RepeatToolCallDetector (4-tier 工具循环)
│   ├── llm_thinking_loop.py     (653L)  # LlmThinkingLoopDetector (双通道 + Skill)
│   ├── tool_error.py            (40L)   # ToolErrorRateDetector (ErrorBurst 子类)
│   ├── model_error.py           (43L)   # ModelStreamErrorDetector (ErrorBurst 子类)
│   ├── output_length.py         (65L)   # OutputLengthDetector (直接阈值)
│   ├── compaction.py            (83L)   # FrequentCompactionDetector (滑动窗口)
│   └── skill_verdicts.py        (180L)  # Skill JSON 契约解析 (parse_skill_verdict)
│
├── recovery/                           # 恢复引擎层
│   ├── __init__.py                      # re-export
│   ├── engine.py                        # RecoveryAction / Policy / Executor / plan_recovery
│   ├── operations.py                    # 原子操作 + HITL interrupt 持久化
│   ├── robustness_prompt.py             # cn/en 文案与 HITL 渲染
│   └── state.py                         # PendingRecovery / SuppressFlushState
│
├── agents/                             # 语义 Skill 层 (Hexagonal Port & Adapter)
│   ├── __init__.py              (28L)   # re-export
│   ├── base.py                  (88L)   # AgentAdapter Protocol + NoOpAgentAdapter
│   ├── deep_agent_adapter.py    (196L)  # DeepAgentAdapter (短生命周期 DeepAgent + SkillUseRail)
│   └── ras_agents.py    (46L)   # RASAgents 聚合 (timeout fail-open)
│
├── diagnosis/                          # 诊断层 (预留扩展点)
│   └── __init__.py              (3L)    # "reserved for future PR"
│
├── messager/                           # 方案 B: 跨进程传输 (Agent 侧)
│   ├── __init__.py              (29L)   # re-export
│   ├── topics.py                (20L)   # topic 命名: reliability/recovery/control
│   ├── serialization.py         (19L)   # Signal <-> dict
│   ├── publish.py               (36L)   # publish_event 统一异常处理
│   ├── recovery_reporter.py     (70L)   # MessagerRecoveryReporter (service 侧)
│   └── messager_rail.py         (238L)  # MessagerAgentRASRail (Agent 侧 publish + drain)
│
└── service/                            # 方案 B: 独立进程 service
    ├── __init__.py              (20L)   # re-export
    ├── service.py               (113L)  # AgentRASMessagerService (subscribe + monitor + recover)
    ├── runner.py                (84L)   # CLI: python -m ...service.runner --config ...
    └── recovery_dispatcher.py   (19L)   # backward-compat alias
```

#### 多 Agent 扩展层: `agent_teams/agent_ras/` (7 文件, 691 行)

```
openjiuwen/agent_teams/agent_ras/           # 多 Agent team-level 扩展
├── __init__.py                  (38L)   # 导出: PingPongDetector, AgentRASHandler, TeamAgentRASConfig, ...
├── config.py                    (64L)   # TeamAgentRASConfig (team 配置, to_agent_ras_config() 转换)
├── handler.py                   (261L)  # AgentRASHandler (Leader 侧 ANOMALY_DETECTED + MESSAGE 聚合)
├── reporter.py                  (98L)   # EventAnomalyReporter + LocalAnomalyReporter (跨进程报告)
├── factory.py                   (144L)  # build_pingpong_detector / build_team_agent_ras_rail / build_team_agent_ras_handler
└── detectors/
    ├── __init__.py              (8L)    # 导出 PingPongDetector
    └── pingpong.py              (78L)   # PingPongDetector (team-level 消息 ping-pong)
```

**架构关系**: `agent_teams` 单向依赖 `harness`（import 共享基座: AgentRASConfig, AgentRASRail, Signal, Anomaly, RecoveryAction 等）。`TeamAgentRASConfig.to_agent_ras_config()` 将 team 配置转换为 harness 层 `AgentRASConfig`。

**关键差异**: team 模式使用 `TEAM_SEVERITY_ACTIONS`（MEDIUM→REPORT_LEADER 而非 REPORT_TO_USER）:
- LOW=[OBSERVE_ONLY], MEDIUM=[REPORT_LEADER], HIGH=[INJECT_STEERING, REPORT_LEADER], CRITICAL=[INJECT_STEERING, ESCALATE_USER]

**team-only 组件**:
| 组件 | 职责 |
|------|------|
| `PingPongDetector` | 检测 team 成员间消息来回往复无进展（≥6 次 MEDIUM, ≥12 次 HIGH） |
| `AgentRASHandler` | Leader 侧事件处理器: ANOMALY_DETECTED → 按策略路由到 Leader LLM; MESSAGE/BROADCAST → 喂给 PingPongDetector |
| `EventAnomalyReporter` | 跨进程上报: 通过 Messager 发布 AnomalyDetectedEvent 到 Leader |
| `LocalAnomalyReporter` | 进程内上报: 直接调用 Leader 的 AgentRASHandler |
| `TeamAgentRASConfig` | team 配置: enabled, monitor_roles, TEAM_SEVERITY_ACTIONS |

#### 模块依赖规则

1. **Rail 是唯一的可靠性扩展点** — 不 monkey-patch Agent，不子类化 DeepAgent
2. **基础层不依赖上层** — `core/single_agent/rail/base.py` 不 import harness/agent_ras
3. **检测器纯算法** — `Detector.observe(signal) -> Anomaly | None`，无 IO，可单元测试
4. **阈值必须可配置** — 不硬编码，全部通过 `AgentRASConfig` 注入

### 3.5 物理视图 (Physical View)

```
┌────────────────────────────────────────────────────────────────────┐
│                      jiuwenswarm (jiuwenclaw)                      │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  jiuwenclaw/agentserver/deep_agent/interface_deep.py         │  │
│  │  └─ _init_agent_instance_sync()                              │  │
│  │     create_deep_agent(enable_agent_ras=rel_cfg.enabled,    │  │
│  │       reliability_config=rel_cfg,                             │  │
│  │       reliability_messager=rel_messager,                      │  │
│  │       reliability_ask_user_fn=_reliability_ask_user_fn)      │  │
│  └──────────────────────────┬───────────────────────────────────┘  │
│                             │ 参数透传                               │
│  ┌──────────────────────────▼───────────────────────────────────┐  │
│  │  jiuwenclaw/resources/config.yaml                            │  │
│  │  reliability:                                                │  │
│  │    enabled: true                                             │  │
│  │    spawn_mode: inprocess  # 或 process + transport               │  │
│  │    detectors: { tool_error: {...}, repeat_tool: {...}, ... } │  │
│  │    remediation: { policy: {...}, restart_intensity: {...} }  │  │
│  └──────────────────────────────────────────────────────────────┘  │
├────────────────────────────────────────────────────────────────────┤
│                      agent-core (openjiuwen)                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  harness/factory.py                                          │  │
│  │  └─ create_deep_agent() → default_rails.append(AgentRASRail)│
│  └──────────────────────────┬───────────────────────────────────┘  │
│                             │                                       │
│  ┌──────────────────────────▼───────────────────────────────────┐  │
│  │  harness/agent_ras/  (41 文件 / 6677 行)              │  │
│  │  ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │  │
│  │  │Reliability-│ │Monitor + │ │Remediation│ │Messager/     │  │  │
│  │  │Rail        │ │RingBuffer│ │Executor  │ │Service       │  │  │
│  │  │(priority=5)│ │+8 Detect.│ │+Policy   │ │(方案B)       │  │  │
│  │  └────────────┘ └──────────┘ └──────────┘ └──────────────┘  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                             │                                       │
│  ┌──────────────────────────▼───────────────────────────────────┐  │
│  │  core/single_agent/rail/base.py  (冻结)                      │  │
│  │  AgentRail (10 钩子) + AgentCallbackContext + AgentCallbackEvent│
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

---

## 4. 支持的故障模式

### 4.1 故障模式总览

| AnomalyKind | 检测器 | 严重度 | 触发条件 | 默认恢复动作 |
|-------------|--------|--------|----------|-------------|
| `REPEAT_TOOL_CALL` | RepeatToolCallDetector | LOW | 同一工具+参数重复 ≥10 次 | OBSERVE_ONLY + INJECT_STEERING |
| `TOOL_CALL_LOOP` | RepeatToolCallDetector | HIGH/CRITICAL | 尾部连续相同调用 ≥20/30 次 | REPORT_TO_USER + INJECT_STEERING / INJECT_STEERING + ESCALATE_USER |
| `LLM_THINKING_LOOP` | LlmThinkingLoopDetector | LOW/MEDIUM | 后缀循环(5次) / 相似子句(5个) | OBSERVE_ONLY + SUPPRESS_STREAM + DEFER_HITL |
| `LLM_THINKING_DEAD_LOOP` | LlmThinkingLoopDetector | HIGH | 语义死循环(skill 判定 abnormal) | OBSERVE_ONLY + SUPPRESS_STREAM + DEFER_HITL |
| `TOOL_ERROR_RATE` | ToolErrorRateDetector | MEDIUM/HIGH | 60s 内错误 ≥5 次 / ≥10 次 | REPORT_TO_USER / REPORT_TO_USER + INJECT_STEERING |
| `MODEL_ERROR` | ModelStreamErrorDetector | MEDIUM/HIGH | 120s 内错误 ≥3 次 / ≥6 次 | REPORT_TO_USER / REPORT_TO_USER + INJECT_STEERING |
| `OUTPUT_TOO_LONG` | OutputLengthDetector | LOW | text_len > 32000 | OBSERVE_ONLY + INJECT_STEERING |
| `THINKING_TOO_LONG` | OutputLengthDetector | LOW | thinking_len > 16000 | OBSERVE_ONLY + INJECT_STEERING |
| `FREQUENT_COMPACTION` | FrequentCompactionDetector | MEDIUM | 300s 内压缩 ≥3 次 | REPORT_TO_USER |
| `PING_PONG` | PingPongDetector (agent_teams) | MEDIUM/HIGH | team 成员间消息来回 ≥6/12 次 | REPORT_LEADER / INJECT_STEERING + REPORT_LEADER |

### 4.2 恢复动作体系 (7 种)

```python
class RecoveryAction(str, Enum):
    OBSERVE_ONLY    = "observe_only"      # 仅记录, 不干预
    REPORT_TO_USER  = "report_to_user"   # 通过 Rail 事件流报告用户
    REPORT_LEADER   = "report_leader"    # 报告 Leader (team 模式)
    INJECT_STEERING = "inject_steering"  # 注入 steering 提示 (rate-limited 5/60s)
    ESCALATE_USER   = "escalate_user"    # 主动通知用户 (CRITICAL)
    SUPPRESS_STREAM = "suppress_stream"  # 截断流式输出中的重复内容
    DEFER_HITL      = "defer_hitl"       # 挂起, 等待 model_call 结束后向用户提问
```

### 4.3 严重度 → 动作映射 (DEFAULT_SEVERITY_ACTIONS)

| Severity | 默认动作 | 说明 |
|----------|---------|------|
| LOW | [OBSERVE_ONLY, INJECT_STEERING] | 记录 + 尝试自动纠偏 |
| MEDIUM | [REPORT_TO_USER] | 报告用户, 不自动纠偏 |
| HIGH | [REPORT_TO_USER, INJECT_STEERING] | 报告 + 强力纠偏 |
| CRITICAL | [INJECT_STEERING, ESCALATE_USER] | 强力纠偏 + 升级通知 |

### 4.4 Kind 覆盖映射 (DEFAULT_KIND_OVERRIDES)

LLM 思考循环类异常使用**特殊恢复路径**（不遵循 severity 默认映射）:

```python
DEFAULT_KIND_OVERRIDES = {
    AnomalyKind.LLM_THINKING_LOOP:      [OBSERVE_ONLY, SUPPRESS_STREAM, DEFER_HITL],
    AnomalyKind.LLM_THINKING_DEAD_LOOP: [OBSERVE_ONLY, SUPPRESS_STREAM, DEFER_HITL],
}
```

> **设计意图**: LLM 思考循环的恢复不依赖 severity 等级，而是统一走"截断流式 → 挂起 HITL"三阶段路径。无论检测到的是轻度文字重复(LOW)还是重度语义死锁(HIGH)，恢复策略一致：先截断正在输出的重复内容，再在 model_call 结束后向用户提问。

---

## 5. LLM 思考死循环检测与修复流程（示例详解）

> 本节以 LLM 思考死循环为案例，完整展示从信号捕获到恢复执行的全流程。这是 agent_ras 框架中最复杂的检测器，也是设计理念的集中体现。

### 5.1 问题描述

LLM 在复杂推理任务中可能进入"思考死循环"——模型反复输出相同或语义等价的内容，无法取得进展。有两种表现形式：

| 类型 | 表现 | 检测难度 |
|------|------|----------|
| **字面重复** | 模型输出"让我重新检查API规范并验证输入..." 这段 60 字文字重复 5 次 | 低（可直接匹配） |
| **语义死锁** | 模型每次用不同措辞重述同一计划，文字不同但语义无进展 | 高（需 LLM 判断） |

### 5.2 检测架构 — 双通道设计

```
        STREAM_CHUNK 到达 (chunk_type="llm_output" 或 "llm_reasoning")
                        │
                        ▼
              ┌─────────────────────┐
              │  LlmThinkingLoop    │
              │  Detector.observe() │
              └─────────┬───────────┘
                        │
           ┌────────────┴────────────┐
           ▼                         ▼
  ┌─────────────────┐     ┌─────────────────────┐
  │ _TextRepetition │     │ _PlanExecution      │
  │ Channel (L1/L2) │     │ Channel (L3)        │
  │                 │     │                     │
  │ • 同步执行      │     │ • 异步执行          │
  │ • 100字间隔扫描 │     │ • 4000字 AND 10分钟 │
  │ • LoopDetector  │     │ • Skill 判决        │
  │ • suffix_cycle  │     │ • asyncio.Task      │
  │ • similar_clauses│    │ • single-flight     │
  └────────┬────────┘     └──────────┬──────────┘
           ▼                         ▼
  AnomalyKind.               AnomalyKind.
  LLM_THINKING_LOOP          LLM_THINKING_DEAD_LOOP
  (LOW / MEDIUM)             (HIGH)
  channel="text_repetition"  channel="plan_execution"
```

**双通道设计原理**:
- **L1/L2 语法通道**: 快速、确定性、无网络——在数百毫秒内捕获字面循环
- **L3 语义通道**: 昂贵、语义化、LLM 驱动——捕获文字不同但语义无进展的死锁
- 两通道**共享输入但不共享状态**，独立 latch，互不阻塞

### 5.3 检测算法

#### L1: suffix_cycle — 后缀周期搜索

在归一化文本的尾部 600 字窗口中，对每个候选周期长度 (10~150 字) 检查尾部是否重复 ≥ 阈值次:

```
tail_text = normalize(buffer)[-600:]
for p_len in range(10, 151):
    pattern = tail_text[-p_len:]
    if is_degenerate(pattern): continue    # 排除空白/单字符
    repeats = count_backward_repeats(tail_text, pattern)
    if repeats >= threshold:  # default 5
        return DetectionResult(detected=True, mode="suffix_cycle", count=repeats, start_pos=...)
```

#### L2: similar_clauses — 近似子句配对扫描

将文本按标点分割为子句，两两计算相似度 (SequenceMatcher.ratio)，≥ 阈值(0.9)的视为近重复:

```
clauses = split(normalize(buffer))   # 按 。！？\n 分割
clauses = [c for c in clauses if lexical_len(c) > 5]  # 过滤短子句
for i, j in combinations(clauses, 2):
    if similarity(lexical_key(clauses[i]), lexical_key(clauses[j])) >= 0.9:
        similar_set.add(i); similar_set.add(j)
if len(similar_set) >= threshold:  # default 5
    return DetectionResult(detected=True, mode="similar_clauses", count=len(similar_set))
```

**关键过滤**:
- `is_degenerate()`: 排除空白占主导(≥70%)、唯一字符≤2 的退化文本
- `_is_enumeration_exempt()`: 豁免合法编号列表 ("1. ..., 2. ..., 3. ...")
- `_strip_code_fences()`: 移除代码块避免伪重复
- `normalize()`: 小写化 + 折叠空白 + 去除 "Step N:" 前缀

#### L3: plan_execution — 语义死锁检测 (Skill 驱动)

当文本量 ≥ 4000 字 AND 距上次评估 ≥ 10 分钟时，异步触发 `llm-loop-detection` Skill:

```
incremental_len = len(buffer) - last_evaluated_pos
elapsed = now() - last_evaluated_at
if eval_in_flight: return None        # single-flight 防重入
if incremental_len < 4000: return None # 字符门控
if elapsed < 600: return None         # 时间门控

asyncio.create_task(_run_semantic_eval(
    excerpt=buffer[last_evaluated_pos:],
    skill_name="llm-loop-detection",
    timeout=30
))
```

Skill 返回 `LlmLoopDetectionVerdict`:

```python
class ThinkingLoopFault(str, Enum):
    NONE = "none"
    SEMANTIC_DEADLOCK = "semantic_deadlock"    # 语义死锁
    TEXT_DEGRADATION = "text_degradation"      # 文本退化
    OVERTHINKING = "overthinking"              # 过度思考

class LlmLoopDetectionVerdict(SkillVerdict):
    abnormal: bool
    primary_fault: ThinkingLoopFault
    confidence: float       # 0..1
    rationale: str
```

> **Fail-open 原则**: Skill 调用失败/超时/JSON 解析失败时，`parse_llm_loop_verdict` 返回 `abnormal=False`，不阻塞 Agent。

### 5.4 端到端修复流程 — 三阶段恢复

LLM 思考循环使用**特殊的三阶段恢复路径**（由 `DEFAULT_KIND_OVERRIDES` 覆盖 severity 默认映射）:

```
                         Anomaly 产生
                    (LLM_THINKING_LOOP / DEAD_LOOP)
                              │
                              ▼
              ┌───────────────────────────────┐
              │ RecoveryPolicy.actions_for │
              │  → kind_overrides 命中         │
              │  → [OBSERVE_ONLY,             │
              │     SUPPRESS_STREAM,          │
              │     DEFER_HITL]               │
              └───────────────┬───────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
  ① OBSERVE_ONLY      ② SUPPRESS_STREAM     ③ DEFER_HITL
  (即时)              (即时, 流式中)         (挂起, model_call 后)
  │                    │                    │
  ▼                    ▼                    ▼
  记录指标             StreamGate 截断       PendingRecovery 入队
  invoke_count++      重复 chunk            recovery_profile=
  anomaly_count++     仅保留 start_pos      "thinking_loop_text_rep"
                       之前的内容
                                              │
                                              ▼
                                    ┌─────────────────┐
                                    │ model_call 结束 │
                                    │ after_model_call│
                                    └────────┬────────┘
                                             ▼
                                    ┌─────────────────┐
                                    │ run_deferred_   │
                                    │ completion()    │
                                    └────────┬────────┘
                                             ▼
                                    ┌─────────────────┐
                                    │ invoke_ask_user │
                                    │ HITL 提问:      │
                                    │ "输出是否正常?" │
                                    └────────┬────────┘
                                             │
                                    ┌────────▼────────┐
                                    │ 用户回答        │
                                    └─┬────────────┬──┘
                              "yes"   │            │  "no"
                                      ▼            ▼
                              继续(无干预)    INJECT_STEERING
                                              注入纠偏提示
```

### 5.5 实例追踪 — "模型反复输出同一段话"

**场景**: Agent 执行代码审查任务，LLM 输出中反复出现 60 字段落"让我重新检查API规范并验证输入参数的正确性..."，连续 5 次。

**Step 1 — 流式 chunk 到达，缓冲区填充**

```
AgentRASRail._on_stream_output(result={"chunk_type": "llm_output", "chunk_text": "让我重新检查API..."})
  → signal_builder.build_stream_chunk_signal(member_name="reviewer", inputs=...)
  → Signal(kind=STREAM_CHUNK, member_name="reviewer", chunk_type="llm_output", chunk_text="让我重新检查API...")
  → monitor.detection(signal)
```

每次 chunk 到达，`LlmThinkingLoopDetector.observe()` 被调用:
- 过滤 chunk_type ∈ {"llm_output", "llm_reasoning"} ✓
- 追加到 `tr.buffer` 和 `pe.buffer`
- 检查 `pending = len(tr.buffer) - tr.last_scanned_pos`，若 < 100 则返回 None

**Step 2 — L1 suffix_cycle 触发 (约 300 字时)**

当 5 份 60 字段落累积到 ~300 字:
```
pending = 300 ≥ 100  →  执行 _run_text_repetition()
LoopDetector.detect(normalize(buffer), threshold=5)
  → _strategy_suffix_cycle(tail_text=buffer[-600:], threshold=5)
    → p_len=60, pattern="让我重新检查api规范并验证输入参数的正确性"
    → repeats = 5 ≥ threshold=5  →  DETECTED!
  → DetectionResult(detected=True, mode="suffix_cycle", count=5, start_pos=<循环起点>)
```

构建 Anomaly:
```python
Anomaly(
    detector="llm_thinking_loop",
    kind=AnomalyKind.LLM_THINKING_LOOP,
    severity=Severity.LOW,                    # suffix_cycle → LOW
    member_name="reviewer",
    summary="llm_thinking_loop (suffix_cycle)",
    evidence={
        "mode": "suffix_cycle",
        "channel": "text_repetition",
        "recovery_profile": "thinking_loop_text_rep",
        "count": 5, "threshold": 5,
        "start_pos": <循环起点位置>,
        "buffer_len": 300,
        "chunk_type": "llm_output",
        "stream_chunk_keep_len": <当前 chunk 保留长度>,
    },
)
```

**Step 3 — Rail 接收异常，应用恢复**

```
AgentRASRail._emit() → monitor.detection() 返回 [anomaly]
  → _dispatch(anomaly, ctx)
    → _extract_policy_actions(monitor, anomaly)
      → policy.actions_for(severity=LOW, kind=LLM_THINKING_LOOP)
        → kind_overrides 命中! → [OBSERVE_ONLY, SUPPRESS_STREAM, DEFER_HITL]
    → needs_immediate_apply({OBSERVE_ONLY, SUPPRESS_STREAM, DEFER_HITL})
      → True (SUPPRESS_STREAM 需要立即执行)
    → executor.apply(ctx, anomaly, policy_actions)
```

Executor 执行:
1. **OBSERVE_ONLY**: 记录 `invoke_count` / `anomaly_count` 指标
2. **SUPPRESS_STREAM**: `StreamRecoveryGate` 计算 `stream_chunk_keep_len`，截断当前 chunk 的重复部分，缓冲被截断的内容到 `SuppressFlushState`
3. **DEFER_HITL**: `PendingRecovery(recovery_profile="thinking_loop_text_rep")` 入队，等待 model_call 结束

**Step 4 — 后续 chunk 被截断**

```
StreamObserver / Monitor.on_stream_chunk
  → executor.should_suppress_stream("llm_output")  →  True
  → suppress_and_buffer(executor.suppress_state, "llm_output", chunk_text, chunk)
  → return  # 不再喂给 monitor, 重复内容不展示给用户
```

**Step 5 — model_call 结束，HITL 询问**

```
AgentRASRail.after_model_call(ctx)
  → executor.run_deferred_completion(ctx, COMPLETION_HOOK_AFTER_MODEL_CALL)
    → pending = suppress_flush.pending  →  PendingRecovery 存在
    → hitl_questions_for(pending, locale="cn")
      → "检测到模型输出可能存在重复循环。输出内容是否正常?"
         选项: ["是, 内容正常", "否, 存在循环"]
    → invoke_ask_user(ctx, questions, ask_user_fn)
    → 用户选择 "否, 存在循环"
    → resolve_hitl_choice(answers) → "no"
    → hitl_steering_on_no(locale="cn")
      → "检测到输出重复, 已停止当前生成。请尝试调整 prompt 或重新发起请求。"
    → inject_steering(ctx, steering_text)
```

**Step 6 — 下一轮 model_call, 检测器 reset**

```
AgentRASRail.before_model_call(ctx)
  → executor.take_pending_recovery_notice()  →  有待发送通知
  → emit_user_notice(ctx, notice)  →  用户看到恢复通知
  → Signal(BEFORE_MODEL_CALL)
  → LlmThinkingLoopDetector.observe(BEFORE_MODEL_CALL signal)
    → self.reset()
      → _generation += 1  (使所有 in-flight L3 async task 失效)
      → 清空所有 _text_rep / _plan_exec channel
      → 取消所有 _eval_tasks
```

### 5.6 变体 — 语义死锁 (L3 路径)

当模型每次用不同措辞重述同一计划，L1/L2 不会触发。当 `pe.buffer` 增长 ≥ 4000 字 AND 距上次评估 ≥ 10 分钟:

```
_maybe_invoke_semantic_skill()
  → eval_in_flight? No
  → incremental_len ≥ 4000? Yes
  → elapsed ≥ 600s? Yes
  → asyncio.create_task(_run_semantic_eval(excerpt, skill_name, timeout=30))
```

异步 Skill 执行:
```
RASAgents.invoke_skill(role="detection", skill_name="llm-loop-detection", payload=excerpt, timeout=30)
  → DeepAgentAdapter.invoke_skill()
    → create_deep_agent(model, card, system_prompt=ROLE_PROMPTS["detection"], rails=[SkillUseRail], enable_agent_ras=False)
    → agent.invoke({"query": "分析以下 LLM 输出是否存在思考死循环..."})
    → 返回 JSON verdict
  → parse_llm_loop_verdict(result)
    → LlmLoopDetectionVerdict(abnormal=True, primary_fault=SEMANTIC_DEADLOCK, confidence=0.92)
```

异常构建 + 恢复:
```
Anomaly(
    kind=AnomalyKind.LLM_THINKING_DEAD_LOOP,
    severity=Severity.HIGH,
    evidence={
        "mode": "plan_execution_loop_lock",
        "channel": "plan_execution",
        "recovery_profile": "thinking_loop_plan_exec",
        "primary_fault": "semantic_deadlock",
        "skill_confidence": 0.92,
        "stream_chunk_keep_len": 0,  # 全部截断
    },
)
→ async_recovery_handler(anomaly, chunk_type)  # 异步回调
  → Rail._complete_async_stream_recovery()
    → StreamGate.apply_anomaly(SUPPRESS_STREAM + DEFER_HITL)
    → after_invoke → HITL 提问 (基于 primary_fault 定制问题)
```

> **Generation 计数器**: L3 的 async task 在 spawn 时捕获 `_generation`。如果 `BEFORE_MODEL_CALL` 触发 reset() 导致 `_generation` 递增，正在执行的 async task 完成时会检测到 generation 不匹配，**静默丢弃**结果——避免把上一轮的语义判决应用到新一轮 model_call。

---

## 6. 目录结构设计

### 6.1 设计原则

| 原则 | 体现 |
|------|------|
| **关注点分离** | 检测(detectors/)、恢复(remediation/)、语义(agents/)、传输(messager/ + service/)各自独立子目录 |
| **Port & Adapter** | `agents/` 定义 Protocol(Port)，`DeepAgentAdapter`/`NoOpAgentAdapter` 是 Adapter，detector 不依赖具体实现 |
| **数据模型集中** | `models.py` 统一 Signal/Anomaly/Severity/AnomalyKind/SignalKind/AgentRASMonitorEvent，不拆分多文件 |
| **配置即代码** | `config.py` 用 pydantic BaseModel，所有阈值可配置，支持 YAML 注入 |
| **扩展点预留** | `diagnosis/` 空目录占位 ("reserved for future PR")；`DETECTOR_BUILDERS` 注册表支持新增检测器 |

### 6.2 模块职责矩阵

| 子目录 | 文件数 | 核心职责 | 公开 API |
|--------|--------|---------|---------|
| (根级) | 11 | Rail/Monitor/Config/Factory/Signal/Reporter/Window/AsyncRecovery | AgentRASRail, AgentRASMonitor, AgentRASConfig, create_monitor |
| `detectors/` | 9 | 8 个检测器 + Skill 判决解析 | Detector Protocol, RepeatToolCallDetector, LlmThinkingLoopDetector, ... |
| `remediation/` | 7 | 恢复引擎 + 策略 + 操作 + 流式门控 + 文案 | RecoveryAction, RecoveryExecutor, LocalAutoRecovery, load_message |
| `agents/` | 4 | 语义 Skill 调用的 Port & Adapter | AgentAdapter, DeepAgentAdapter, RASAgents |
| `messager/` | 6 | 跨进程 Signal/Recovery 传输 (Agent 侧) | MessagerAgentRASRail, MessagerRecoveryReporter |
| `service/` | 4 | 独立进程监控服务 (方案 B) | AgentRASMessagerService, runner CLI |
| `diagnosis/` | 1 | 预留扩展点 (未实现) | — |

### 6.3 DETECTOR_BUILDERS 注册表

```python
# factory.py
DETECTOR_BUILDERS = {
    "repeat_tool":      lambda cfg: RepeatToolCallDetector(cfg.repeat_tool),
    "llm_thinking_loop": lambda cfg: LlmThinkingLoopDetector(cfg.llm_thinking_loop),
    "tool_error":       lambda cfg: ToolErrorRateDetector(cfg.tool_error),
    "model_error":      lambda cfg: ModelStreamErrorDetector(cfg.model_error),
    "output_length":    lambda cfg: OutputLengthDetector(cfg.output_length),
    "compaction":       lambda cfg: FrequentCompactionDetector(cfg.compaction),
}
```

新增检测器只需: (1) 实现 `Detector` Protocol; (2) 在 `DETECTOR_BUILDERS` 注册; (3) 在 `DetectorsConfig` 添加配置字段。

---

## 7. 与 jiuwenswarm 的架构关联

### 7.1 总体定位

```
┌────────────────────────────────────────────────────────────────────┐
│ jiuwenswarm (jiuwenclaw) — 应用层                                   │
│   ├─ single_agent 路径: interface_deep.py → create_deep_agent(...)  │
│   └─ agent_teams 路径: monitor_handler.py → agent_teams/monitor    │
├────────────────────────────────────────────────────────────────────┤
│ agent-core / harness — 框架层                                       │
│   └─ agent_ras/ ← 框架级基础能力 (本文档主线)              │
│       ├─ LOCAL 模式: AgentRASRail + AgentRASMonitor (进程内)  │
│       └─ MESSAGER 模式: MessagerAgentRASRail + Service (跨进程)  │
├────────────────────────────────────────────────────────────────────┤
│ agent-core / core — 基础层 (冻结)                                   │
│   └─ single_agent/rail/base.py (AgentRail, 10 钩子)                │
└────────────────────────────────────────────────────────────────────┘
```

### 7.2 集成点

**jiuwenswarm 侧唯一接触点**: `jiuwenclaw/agentserver/deep_agent/interface_deep.py`

```python
# interface_deep.py:3533-3549 (核心集成代码)
agent = create_deep_agent(
    model=model,
    card=card,
    enable_agent_ras=rel_cfg.enabled,          # 是否启用
    reliability_config=rel_cfg,                  # AgentRASConfig
    reliability_messager=rel_messager,           # MESSAGER 模式 transport
    reliability_ask_user_fn=_reliability_ask_user_fn,  # HITL 桥接
    ...
)
```

**框架侧吸收点**: `openjiuwen/harness/factory.py`

```python
# factory.py:355-373
if enable_agent_ras:
    default_rails.append((
        AgentRASRail,
        True,  # is_default
        lambda: agent_ras_rail_from_components(
            config=rel_cfg,
            member_name=card.name,
            ask_user_fn=reliability_ask_user_fn,
            messager=reliability_messager,
            ...
        ),
    ))
```

AgentRASRail 自动追加为 default rail (priority=5)，与 SecurityRail、SkillUseRail、SubagentRail、TaskPlanningRail 同层。

### 7.3 配置入口

`jiuwenclaw/resources/config.yaml`:

```yaml
reliability:
  enabled: true
  spawn_mode: inprocess          # inprocess | process
  detectors:
    tool_error:     { window_seconds: 60, rate_threshold: 5, consecutive_threshold: 3 }
    repeat_tool:    { history_size: 30, repeat_warn: 10, loop_block: 20, global_stop: 30 }
    model_error:    { window_seconds: 120, rate_threshold: 3, consecutive_threshold: 2 }
    output_length:  { text: 32000, thinking: 16000 }
    compaction:     { window_seconds: 300, frequency: 3, drop_ratio: 0.3 }
    llm_thinking_loop:
      check_interval_chars: 100
      window_max_chars: 2000
      loop_repeat_threshold: 5
      similar_clause_sim_threshold: 0.9
      semantic_eval_chars: 4000
      thinking_timeout_minutes: 10
  remediation:
    policy: { ... }
    restart_intensity: { intensity: 5, period_seconds: 60 }
```

### 7.4 HITL 桥接

jiuwenswarm 的 `ask_user_question_tool` 通过 `reliability_ask_user_fn` 桥接到框架:

```python
# interface_deep.py:2735-2741
async def _reliability_ask_user_fn(ctx, questions):
    """将框架的 HITL 询问桥接到 jiuwenclaw 的 ask_user_question_tool。"""
    return await ask_user_question_tool.invoke(ctx, questions)
```

### 7.5 swarm 装配与 reliability 的关系

**现状**: jiuwenswarm 的 swarm 装配（`agents/`、`ai_assistance/`）与 agent_ras 是**两条独立子系统**，目前没有直接调用:

- **swarm 编排** 走 `agent_teams` 通道 (TeamMonitor, spawn, messager)
- **可靠性监控** 走 `harness/agent_ras` 通道 (AgentRASRail, DeepAgent lifecycle)

如需在 swarm 编排中启用可靠性，有两种路径:
1. **单 Agent 级**: 在子成员构造时通过 `create_deep_agent(enable_agent_ras=True)` 启用
2. **Team 级**: 启用 `agent_teams/agent_ras/handler.py` 的 Leader 侧聚合（agent_teams/agent_ras/handler.py 已实现 AgentRASHandler（261L））

### 7.6 三个"reliability"概念辨析

| 概念 | 路径 | 定位 | 本分支状态 |
|------|------|------|-----------|
| **harness/agent_ras** | `openjiuwen/harness/agent_ras/` | 单 Agent DeepAgent lifecycle 内置 Rail | ✅ 已实现 (41 文件) |
| **agent_teams/agent_ras** | `openjiuwen/agent_teams/agent_ras/` | 多 Agent Leader 侧异常聚合 | ⚠️ 仅有 handler.py 框架 (未完整启用) |
| **agent_teams/monitor/TeamMonitor** | `openjiuwen/agent_teams/monitor/` | swarm 监控 (非可靠性, 是 spawn/task/message 流转监控) | ✅ jiuwenswarm 已使用 |

> **注意**: `TeamMonitor` 不是可靠性监控，它是 Team 级别的运行时行为监控（子成员状态、任务流转、消息总线），与 `harness/agent_ras` 是正交的两套子系统。

---

## 8. 部署模式

### 8.1 方案 A: LOCAL 模式 (默认)

```
Agent 进程内: Rail + Monitor + Detectors + RecoveryExecutor
零延迟本地调用; 适合单 Agent / 低延迟 / 简单部署
```

- 配置: `spawn_mode: inprocess`
- 启动: `create_deep_agent(enable_agent_ras=True)` 自动启用
- HITL: 通过 `ask_user_fn` 回调到应用层
- 适合: 单 Agent、低延迟、简单部署

### 8.2 方案 B: MESSAGER 模式 (跨进程)

```
Agent 进程: MessagerAgentRASRail (publish Signal + drain Recovery)
    ↕ messager transport (inproc / pyzmq)
Service 进程: AgentRASMessagerService (subscribe → Monitor → Recovery publish)
```

- 配置: `spawn_mode: process` + `transport.*` 配置块
- 启动 Service: `python -m openjiuwen.harness.agent_ras.service.runner --config ... --agent-id ...`
- 传输契约: `reliability:<id>` (Signal) / `recovery:<id>` (RecoveryAction) / `reliability_control:<id>` (控制)
- 适合: 多 Agent、重型检测不阻塞主线程、跨进程监控隔离、集中报警

### 8.3 模式选型建议

| 场景 | 推荐模式 | 理由 |
|------|---------|------|
| 单 Agent / 开发环境 | inprocess | 零配置、零延迟 |
| 生产单 Agent | inprocess | 简单可靠、无额外进程 |
| 多 Agent / 集中监控 | process | 检测隔离、集中观测 |
| 重型 L3 Skill 检测 | process | 不阻塞 Agent 主线程 |
| jiuwenswarm 当前默认 | inprocess | `config.yaml` reliability.spawn_mode |

---

## 附录 A: 公开 API 速查

```python
from openjiuwen.harness.agent_ras import (
    # 核心类
    AgentRASRail, AgentRASMonitor, RingBuffer, AgentRASConfig,
    # 数据模型
    Signal, SignalKind, Anomaly, AnomalyKind, Severity, AgentRASMonitorEvent,
    # 检测器
    Detector, ErrorBurstDetector, RepeatToolCallDetector, LlmThinkingLoopDetector,
    ToolErrorRateDetector, ModelStreamErrorDetector, OutputLengthDetector,
    FrequentCompactionDetector,
    # 恢复
    RecoveryAction, RecoveryPolicy, DEFAULT_SEVERITY_ACTIONS,
    LocalAutoRecovery, RecoveryExecutor, load_message,
    # 报告
    AnomalyReporter, RailEventAnomalyReporter,
    # 工厂
    create_monitor, build_agent_ras_rail, build_agent_ras_components,
    agent_ras_rail_from_components, build_member_detectors, DETECTOR_BUILDERS,
    # 语义 Skill
    AgentAdapter, DeepAgentAdapter, NoOpAgentAdapter, RASAgents,
    # 跨进程 (方案 B)
    MessagerAgentRASRail, AgentRASMessagerService, AgentRASSpawnMode,
    AgentRASTransportSpec,
    # 别名 (向后兼容)
    
    
    TextRepetitionDetector,  # = RepeatToolCallDetector
)
```

## 附录 B: 关键不变量

1. **Rail 是唯一扩展点** — 不 monkey-patch Agent，不子类化 DeepAgent
2. **检测器纯算法** — `observe(signal) -> Anomaly | None`，无 IO，可单测
3. **per-detector try/except 隔离** — 单个检测器异常不阻塞其他检测器
4. **边沿触发** — severity 上升时才 emit，同级别不重复
5. **Rate-limited steering** — INJECT_STEERING 60s 窗口内最多 5 次
6. **从不自动 force_finish** — 恢复动作全部可逆，终止决策留给 LLM/User
7. **Fail-open** — Skill 调用失败/超时/解析失败 → `abnormal=False`，不阻塞
8. **Generation 计数器** — reset() 使所有 in-flight async task 失效
9. **single-flight** — L3 语义 Skill 同时只允许一个 in-flight task
10. **stream_chunk_keep_len** — 精确控制截断位置，保留循环前的有效内容

---

> **文档版本**: v1.0 (2026-07-09)  
> **代码基线**: `openjiuwen/harness/agent_ras/` (41 文件 / 6677 行)  
> **权威参考**: `agent-core/docs/agent_ras/implementation_status.md`
