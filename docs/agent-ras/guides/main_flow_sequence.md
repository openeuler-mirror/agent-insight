# Agent Reliability 主流程时序图（历史）

> 当前流程以 `implementation_status.md` 和代码为准。

> LLM 思考死循环检测 → Monitor 内统一检测+恢复 → 统一 HITL。

```mermaid
sequenceDiagram
    participant App as jiuwenclaw 上层应用
    participant Rail as AgentRASRail
    participant Monitor as AgentRASMonitor
    participant Detector as Detector
    participant Agents as RASAgents
    participant Remed as Remediation

    loop 每个 STREAM_CHUNK
        App-->>Rail: STREAM_CHUNK 回调
        Rail->>Monitor: feed_and_recover(Signal, ctx)

        Monitor->>Detector: observe(signal)
        alt L1/L2 字面重复命中 (≥100字)
            Detector-->>Monitor: Anomaly(LLM_THINKING_LOOP)
        else L3 语义死锁命中 (≥4000字 AND ≥10分钟)
            Detector->>Agents: invoke_skill("llm-loop-detection")
            Agents-->>Detector: verdict(abnormal=true)
            Detector-->>Monitor: Anomaly(LLM_THINKING_DEAD_LOOP)
        end

        Monitor->>Monitor: kind_overrides → [SUPPRESS_STREAM, DEFER_HITL]
        Monitor->>Remed: run_stream_recovery(chunk)
        Remed-->>App: 截断重复内容

        Note over Remed,App: HITL（Monitor 内触发）
        Remed->>App: ask_user("检测到可能的输出循环，是否停止？")
        App-->>Remed: 用户选择
        alt "是，停止"
            Remed->>App: request_force_finish(), 终止模型
            Remed->>App: inject_steering(纠偏提示)
        else "否，继续"
            Remed-->>App: flush 缓冲内容，恢复输出
        end
    end
```

## 流程说明

| 阶段 | 触发条件 | 所在位置 |
|------|---------|---------|
| L1/L2 字面检测 | 后缀循环 ≥5次 或 近似子句 ≥5个 | Monitor 内 detector.observe() |
| L3 语义检测 | ≥4000字 AND ≥10分钟 → Skill 判决 | Monitor 内 detector → Agents |
| 恢复 + HITL | 任一检测命中 | **Monitor 内统一执行**（Rail 不参与恢复决策） |
