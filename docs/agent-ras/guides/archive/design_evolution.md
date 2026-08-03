> 历史文档：当前能力与 API 请以 [`../implementation_status.md`](../implementation_status.md) 为准。

---
name: Agent Reliability Design Evolution
type: design-evolution
description: "agent_ras 从 v2.0.0 设计文档到 v1.0 实现基线的演进记录：路径变更、规模变更（harness 41 文件 + agent_teams 7 文件 = 48 文件/7368 行）、数据模型变更、检测器变更、恢复策略变更。"
change: feat
version: v1.0
update_time: 2026-07-10 (UTC+8)
---

# Agent Reliability 设计演进记录

> **用途**: 记录从 v2.0.0 设计文档到 v1.0 实现基线的所有偏离与演进。  
> **代码基线**: `openjiuwen/harness/agent_ras/` (41 文件, 6677 行, 2026-07-09)  
> **关联文档**: SDD (req-001-reliability-monitoring-design.md)、dev-plan、reuse-mapping 等
>
> 📌 文档层级：版本演进记录

---

## 1. 路径变更

| 维度 | v2.0.0 设计 | v1.0 实现 |
|------|------------|-----------|
| 实现路径 | `jiuwenclaw/agentserver/deep_agent/reliability/` (企业版私有) | `openjiuwen/harness/agent_ras/` (框架级公共模块) |
| 架构定位 | 企业版镜像 develop 分支 | agent-core 框架一等公民，develop+enterprise 共享 |
| jiuwenclaw 适配层 | 设计 4 文件 re-export 适配层 | 不存在；通过 `create_deep_agent(enable_agent_ras=True)` 内置 |

## 2. 规模变更

| 维度 | v2.0.0 设计 | v1.0 实现 |
|------|------------|-----------|
| 文件数 | 22 文件 (19 镜像 + 4 新建 - 1 跳过) | 48 文件 (harness 41 + agent_teams 7) |
| 总行数 | ~1738 行 | 7368 行 (harness 6677 + agent_teams 691) |
| 子目录 | 平铺 (signals.py/anomaly.py/window.py/...) | harness: 6 子目录 (agents/ + detectors/ + diagnosis/ + messager/ + remediation/ + service/); agent_teams: 2 子目录 (detectors/ + 根级) |

## 3. 数据模型变更

### 3.1 AnomalyKind

| v2.0.0 设计 (8 种, 去 PING_PONG) | v1.0 实现 (10 种, 保留 PING_PONG) |
|---|---|
| TOOL_ERROR_RATE | TOOL_ERROR_RATE |
| REPEAT_TOOL_CALL | REPEAT_TOOL_CALL |
| TOOL_CALL_LOOP | TOOL_CALL_LOOP |
| MODEL_ERROR | MODEL_ERROR |
| OUTPUT_TOO_LONG | OUTPUT_TOO_LONG |
| THINKING_TOO_LONG | THINKING_TOO_LONG |
| FREQUENT_COMPACTION | FREQUENT_COMPACTION |
| ~~LLM_TEXT_LOOP~~ | LLM_THINKING_LOOP (重命名) |
| — | LLM_THINKING_DEAD_LOOP (新增) |
| ~~PING_PONG (删除)~~ | PING_PONG (保留) |

### 3.2 SignalKind

| v2.0.0 设计 (6 种, 去 MESSAGE) | v1.0 实现 (9 种, 保留 MESSAGE) |
|---|---|
| BEFORE_TOOL_CALL | BEFORE_TOOL_CALL |
| AFTER_TOOL_CALL | AFTER_TOOL_CALL |
| TOOL_EXCEPTION | TOOL_EXCEPTION |
| MODEL_EXCEPTION | MODEL_EXCEPTION |
| BEFORE_MODEL_CALL | BEFORE_MODEL_CALL |
| AFTER_MODEL_CALL | AFTER_MODEL_CALL |
| ~~MESSAGE (删除)~~ | MESSAGE (保留) |
| — | STREAM_CHUNK (新增) |
| — | INVOKE_RESET (新增) |

### 3.3 Signal/Anomaly 字段

| 字段 | v2.0.0 设计 | v1.0 实现 |
|------|------------|-----------|
| `peer_member` | 移除 (单 Agent 无 team 概念) | **保留** (Signal + Anomaly 均保留) |
| `tool_msg_content` | — | 新增 |
| `chunk_type` | — | 新增 |
| `chunk_text` | — | 新增 |
| `to_dict()` / `from_dict()` | — | 新增 (messager 序列化) |

### 3.4 数据模型文件合并

| v2.0.0 设计 (5 文件) | v1.0 实现 (合并) |
|---|---|
| signals.py | → models.py |
| anomaly.py | → models.py |
| events.py (AgentRASMonitorEvent) | → models.py |
| ring_buffer.py (RingBuffer) | → monitor.py |
| api.py (create_monitor/events/diagnose/...) | → factory.py |

## 4. 检测器变更

| v2.0.0 设计 (5+1) | v1.0 实现 (8) |
|---|---|
| RepeatToolCallDetector | RepeatToolCallDetector (511L) |
| ToolErrorRateDetector | ToolErrorRateDetector |
| ModelStreamErrorDetector | ModelStreamErrorDetector |
| OutputLengthDetector | OutputLengthDetector |
| FrequentCompactionDetector | FrequentCompactionDetector |
| ~~PingPongDetector (跳过)~~ | — (PingPongConfig 保留, 无独立检测器文件) |
| ~~OutputQualityDetector (第 6 个, 单 Agent 特有)~~ | **从未实现** — 被 LlmThinkingLoopDetector 取代 |
| — | **LlmThinkingLoopDetector** (653L, 新增, 双通道+Skill) |
| — | **skill_verdicts.py** (180L, parse_skill_verdict) |
| — | ErrorBurstDetector (base, 公开) |

## 5. 恢复策略变更

### 5.1 RecoveryAction 枚举

| v2.0.0 设计 (4 种) | v1.0 实现 (7 种) |
|---|---|
| OBSERVE_ONLY | OBSERVE_ONLY |
| ~~REPORT_LEADER → REPORT_TO_USER (重命名)~~ | REPORT_TO_USER + **REPORT_LEADER** (两者并存) |
| ~~LOCAL_STEER~~ | INJECT_STEERING (重命名) |
| ESCALATE_USER | ESCALATE_USER |
| — | **SUPPRESS_STREAM** (新增) |
| — | **DEFER_HITL** (新增) |

### 5.2 DEFAULT_SEVERITY_ACTIONS

| Severity | v2.0.0 设计 | v1.0 实现 | 差异 |
|----------|------------|-----------|------|
| LOW | [OBSERVE_ONLY] | [OBSERVE_ONLY, **INJECT_STEERING**] | 新增 steering |
| MEDIUM | [REPORT_TO_USER, INJECT_STEERING] | [REPORT_TO_USER] | **丢失 steering** |
| HIGH | [REPORT_TO_USER, INJECT_STEERING] | [REPORT_TO_USER, INJECT_STEERING] | 一致 |
| CRITICAL | [INJECT_STEERING, ESCALATE_USER] | [INJECT_STEERING, ESCALATE_USER] | 一致 |

### 5.3 DEFAULT_KIND_OVERRIDES (新增)

v2.0.0 设计中**不存在** kind_overrides 机制。v1.0 实现新增:

```python
DEFAULT_KIND_OVERRIDES = {
    LLM_THINKING_LOOP:      [OBSERVE_ONLY, SUPPRESS_STREAM, DEFER_HITL],
    LLM_THINKING_DEAD_LOOP:  [OBSERVE_ONLY, SUPPRESS_STREAM, DEFER_HITL],
}
```

LLM 思考循环类异常不遵循 severity 默认映射，统一走"截断→挂起HITL"三阶段路径。

### 5.4 RecoveryExecutor (新增类)

v2.0.0 设计仅有 `LocalAutoRecovery`。v1.0 新增 `RecoveryExecutor` (engine.py:169, 424L)，职责:
- apply(ctx, anomaly, actions) — 即时执行恢复动作
- run_stream_recovery(ctx, anomaly, ...) — 流式恢复
- run_deferred_completion(ctx) — 延迟 HITL 执行
- should_suppress_stream(chunk_type) — 流式截断判断

## 6. 恢复引擎文件变更

| v2.0.0 设计 (4 文件) | v1.0 实现 (7 文件) |
|---|---|
| remediation/action.py | → engine.py (合并) |
| remediation/policy.py | → engine.py (合并) |
| remediation/local.py | → engine.py (合并) |
| recovery/messages/cn.py + en.py | → remediation/messages.py (801L 单文件, load_message()) |
| — | remediation/plan.py (119L, RecoveryPlan/plan_recovery) |
| — | remediation/operations.py (273L) |
| — | remediation/playbooks.py (34L) |
| — | remediation/stream_gate.py (114L, StreamRecoveryGate) |

## 7. 新增子目录 (v2.0.0 设计中不存在)

| 子目录 | 文件数 | 职责 |
|--------|--------|------|
| `agents/` | 4 | Hexagonal Port & Adapter: AgentAdapter Protocol + DeepAgentAdapter + NoOpAgentAdapter + RASAgents |
| `messager/` | 6 | 跨进程传输: MessagerAgentRASRail + topics + publish + serialization + recovery_reporter |
| `service/` | 4 | 独立进程: AgentRASMessagerService + runner CLI + recovery_dispatcher |
| `diagnosis/` | 1 (空) | 预留扩展点: 仅 3 行 `__init__.py` ("reserved for future PR") |

## 8. 诊断层状态

| v2.0.0 设计 | v1.0 实现 |
|------------|-----------|
| `diagnosis/` 子目录含 DiagnosisEngine + 3 默认 Skill + Queue + Protocol + DiagnosisResult | `diagnosis/__init__.py` 仅 3 行占位 ("reserved for future PR")；DiagnosisEngine/Skills **未实现** |

## 9. execution_guard 状态

| v2.0.0 设计 | v1.0 实现 |
|------------|-----------|
| execution_guard/ 标记 deprecated，保留兼容 | execution_guard/ **已删除** (代码库中无此目录) |

## 10. 别名机制 (v2.0.0 设计中不存在)

v1.0 实现保留向后兼容别名:

```python
LlmTextLoopDetector = LlmThinkingLoopDetector    # detectors/__init__.py:27
LlmTextLoopConfig = LlmThinkingLoopConfig         # __init__.py:88
TextRepetitionDetector = RepeatToolCallDetector     # detectors/__init__.py:28
```

## 11. 公开导出清单变更

v2.0.0 设计约 20 个导出符号。v1.0 实现导出 **65 个符号**，新增:
- AgentAdapter 层: AdapterConfig, AgentAdapter, DeepAgentAdapter, NoOpAgentAdapter, RASAgents, load_skill_body
- Skill 集成: parse_skill_verdict, DETECTOR_BUILDERS
- Messager/Service: AgentRASSpawnMode, AgentRASTransportSpec, MessagerAgentConfig, MessagerAgentRASRail, AgentRASMessagerService, build_agent_adapter, build_messager_service_bundle, create_agent_ras_messager
- 恢复层: PendingRecovery, SuppressFlushState, RecoveryPlan, plan_recovery, should_emit_user_notice, RecoveryExecutor, load_message

## 12. 任务计划偏离 (dev-plan T001-T022)

| 设计任务 | 计划内容 | 实际状态 |
|---------|---------|---------|
| T001-T006 | 基础类型层 (signals/anomaly/window/config/remediation/detectors base) | ✅ 已实现 (文件合并到 models.py + engine.py) |
| T007-T011 | 5 个 Detector | ✅ 已实现 + 新增 LlmThinkingLoopDetector + skill_verdicts |
| T012 | monitor.py | ✅ 已实现 |
| T013 | rail.py | ✅ 已实现 |
| T014 | reporter.py (EventAnomalyReporter → RailEventAnomalyReporter) | ✅ 已实现 |
| T015 | factory.py | ✅ 已实现 |
| T016 | ring_buffer.py | ✅ 合并到 monitor.py |
| T017 | events.py | ✅ 合并到 models.py |
| T018 | api.py | ✅ 合并到 factory.py |
| T019 | skill_diagnosis.py | ❌ **未实现** (diagnosis/ 空占位) |
| T020-T022 | 集成测试 | ✅ 已实现 |

**新增任务 (计划外)**:
- agents/ 子目录 (4 文件)
- messager/ 子目录 (6 文件)
- service/ 子目录 (4 文件)
- LlmThinkingLoopDetector (653L)
- RecoveryExecutor 类
- remediation/ 扩展 (plan/operations/playbooks/stream_gate)

---

> **文档版本**: v1.0 (2026-07-09)  
> **用途说明**: 本文档记录设计文档 (v2.0.0) 与实际实现 (v1.0) 之间的差异。各设计文档 (SDD/dev-plan/reuse-mapping/requirements 等) 应描述当前实现状态，版本差异统一引用本文档。
