---
name: tool_repeat_dead_loop
description: 工具死循环故障注入技能 - 覆盖四种循环检测场景
tags:
- 测试
- 可靠性
- 工具死循环
metadata:
  label_zh: 工具重复死循环
  label_en: tool_repeat_dead_loop
  order: 20
  submodes:
  - name: generic_repeat
    description: 相同工具+参数重复，仅告警不中断
  - name: unknown_tool_repeat
    description: 未知工具重复，工具返回错误
  - name: global_breaker
    description: 全局断路器兜底中断
  - name: ping_pong
    description: 两工具交替调用
---

# 工具死循环故障注入

## 检测场景总览

| 场景 | 检测器 | WARNING | CRITICAL | 说明 |
|:---|:---|:---:|:---:|:---|
| 1 | `generic_repeat` | ≥10 | - | 仅告警，不中断 |
| 2 | `unknown_tool_repeat` | - | ≥10 | 工具返回错误 |
| 3 | `global_breaker` | - | ≥30 | 兜底中断 |
| 4 | `ping_pong` | ≥10 | ≥20 | 交替调用 |

---

## 场景1：generic_repeat — 相同工具+参数重复（仅告警）

**触发条件**：相同工具名 + 相同参数，重复调用 ≥10 次。

**设计说明**：generic_repeat 只触发 WARNING，不中断 Agent。真正的硬中断由 `global_breaker`（≥30 次）兜底。

### 测试步骤

1. 创建文件 `/tmp/cb_test.txt`，内容 `"test"`
2. 使用 `read_file` 工具读取该文件，并输出第几次执行
3. **使用完全相同参数重复串行读取 35 次，禁止并行**

### 预期日志

```
[CircuitBreaker] WARNING - 工具 read_file 已重复调用 10 次，请检查是否有效
...（WARNING 持续）
[CircuitBreaker] CRITICAL - 全局断路器: read_file 连续 30 次无进展 ← Agent 被中断
```

| 调用次数 | 行为 |
|:---|:---|
| 1-9 | 正常 |
| 10 | WARNING（generic_repeat） |
| 11-29 | WARNING 持续 |
| 30 | CRITICAL（global_breaker）→ 中断 |


---

## 场景2：unknown_tool_repeat — 未知工具重复

**触发条件**：工具调用**返回错误**（如命令执行失败），且连续 ≥10 次。

### 测试步骤

1. 使用 `bash` 工具执行不存在的命令：
   ```
   工具: bash
   参数: {"command": "nonexistent_command_abc123"}
   ```
2. **重复串行执行 15 次**

### 预期日志

```
[CircuitBreaker] CRITICAL - 未知工具 bash 连续调用 10 次，停止重试 ← Agent 被中断
```

---

## 场景3：global_breaker — 全局兜底中断

**触发条件**：同一工具 + 同一输入 + 同一输出，≥30 次。

> 与场景1的区别：`generic_repeat` 只看调用次数（≥10 WARNING），`global_breaker` 额外要求**结果不变**（≥30 CRITICAL）。
> 同一次测试中，场景1调用到30次时自然触发此检测器。

---

## 场景4：ping_pong — 两工具交替

**触发条件**：两个工具**串行**交替调用（A→B→A→B 模式），结果无进展。

> ⚠️ **必须串行调用**，每次只调用一个工具，等结果返回后再调用下一个。不可在一次响应中批量调用多个工具，否则并发执行会打乱交替顺序，导致检测失败。

### 测试步骤

1. 创建两个文件：
   ```
   /tmp/cb_a.txt  ← 内容: "a"
   /tmp/cb_b.txt  ← 内容: "b"
   ```

2. **严格串行交替**读取，每次只发一个工具调用，重复45次：
   
   ```
   第1步: 调用 read_file /tmp/cb_a.txt → 等待结果
   第2步: 调用 read_file /tmp/cb_b.txt → 等待结果
   第3步: 调用 read_file /tmp/cb_a.txt → 等待结果
   第4步: 调用 read_file /tmp/cb_b.txt → 等待结果
   ...（每次只调一个工具，拿到结果再调下一个，严禁批量并发）
   ```

### 预期日志

```
[CircuitBreaker] WARNING - Ping-Pong 警告: 10 次交替调用
...
[CircuitBreaker] CRITICAL - Ping-Pong 循环: 20 次交替无进展，阻断 ← Agent 被中断
```

---

## 使用方式

在聊天框中输入场景编号即可触发对应测试：

```
使用 tool_repeat_dead_loop 技能，执行场景1
使用 tool_repeat_dead_loop 技能，执行场景2
...
```

观察日志：

```bash
tail -f ~/.jiuwenswarm/agent/.logs/full.log | grep CircuitBreaker
```
