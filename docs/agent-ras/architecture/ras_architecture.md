# Agent RAS 整体架构

> 真源：多平台同进程架构。与 [`capability_matrix.md`](./capability_matrix.md) 配套。

## 设计目标

- 检测/恢复算法**单源**（Python `core/`），禁止其它语言复制 LoopDetector / Recovery 策略
- openjiuwen **深挂载不降级**（进程内直连 L0）
- OpenCode / openclaw / Hermes 经统一协议挂载，能力见矩阵
- OpenCode 使用 `ras_embed` + bun:ffi，Python 宿主直接调用 `ras_embed`
- runtime 生命周期归宿主进程，平台只写薄适配
- inproc 不内嵌 UI；人机监控通过 Insight `/agent-ras/trace` 页面

## 四层逻辑架构

```text
L3 platform_adapter  — 宿主钩子 ↔ observe；平台 HostControl 实现（abort/notice/steer API）
L2 ras_client + host_actions — 同进程 facade；wire → Host 方法调度
L1 ras_embed — inproc 进程内门面
L0 core              — Monitor / Detectors / Recovery / AgentAdapter / HostControl
```

依赖单向：`L3 → L2 → L1 → L0`。jiuwen 默认 `L3 → L0`。恢复路径 =
**common 调度 + 平台 Host**；浏览器只读取 Agent Insight 落库事件，不连接 runtime。

配置示例：[`agent_ras/config/`](../../../agent_ras/config/)。支持 `inproc` transport。

### 恢复：决策 vs 投递

| 职责 | 落点 | 说明 |
|------|------|------|
| **决策** | L0 `core/recovery/operations.build_recovery_actions`（+ `engine.plan_recovery` / `robustness_prompt`） | anomaly → wire actions（abort / notice / steer 及已渲染 `message`） |
| **投递** | L3 HostControl / OpenCode `host_control.js` | 平台 API；不得改写文案或重做策略 |
| **调度** | L2 `applyActions` ≡ L0 `apply_recovery_actions` | wire type → Host 方法映射 |

## 进程拓扑

| 关系 | 基数 |
|------|------|
| runtime : 宿主进程 | 1 : 1 |
| session : runtime | N : 1（`{platform}:{native_id}`） |
| Agent Insight : runtime | 旁路事件上报，fail-open |

## 生命周期

runtime 随宿主进程初始化和释放，不监听 RAS 端口，不写 sidecar PID/锁文件。

## 目录

```text
core/                              # L0（唯一内核包名）
ras_embed/                         # L1 同进程门面（bun:ffi）
platform_adapter/common/           # L2 ras_client.js / ras_client.py
platform_adapter/{openjiuwen,opencode,openclaw,hermes}/  # L3
docs/agent-ras/architecture/ras_architecture.md
```

## 加新平台

只实现 L3：采点钩子 + ActionHandler + INSTALL。禁止复制 detector/recovery 或进程管理逻辑。
