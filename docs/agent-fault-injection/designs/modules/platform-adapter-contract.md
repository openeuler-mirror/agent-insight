# Platform Adapter 接入契约

> **Insight 拓扑说明**：编排与 Judge 在 agent-insight 服务端；本机 FI Worker + [`agent_fault_injection/`](../../../agent_fault_injection/) 负责注入与采集。 独立 FastAPI/Vite 不纳入产品路径。见 [server-client-split.md](../server-client-split.md) · [ras-fi-insight-relationship.md](../ras-fi-insight-relationship.md)。


> 面向在 `agent-fault-injection` 中新增被测 Agent 平台（如 xiaoO）。  
> 产品评判走 Insight 服务端 Judge；被测平台只负责注入、执行与规范化证据（本机可选 OpenCodeFaultJudge 调试）。  
> 另见 [../xiaoo-platform-adaptation.md](../xiaoo-platform-adaptation.md)、[server-judge.md](server-judge.md)。

---

## 1. 最小接入清单

1. 实现 `PlatformAdapter`（`execute` + `map_trajectory`）。
2. 在 `PlatformAdapterRegistry._load_builtins`（或测试中 `register`）注册平台名。
3. 写出 `raw/events.jsonl`（含激活事件）与 **`execution.jsonl`**（规范化证据）。
4. 可选实现 `list_agents` / `list_models` / `health_check` 供 Insight Faults/Platforms API（本机 Worker 侧 catalog）。
5. **不必**实现平台专用 Judge。

---

## 2. `PlatformAdapter` 契约

| 方法 | 必需 | 说明 |
|------|------|------|
| `execute` | 是 | 安装故障资产、启动被测运行时、等待结束，返回 `PlatformRunResult` |
| `map_trajectory` | 是 | 写 `trajectory.jsonl`；并应写 `execution.jsonl` |
| `list_agents` | 否 | 默认返回空列表 + note |
| `list_models` | 否 | 默认返回空列表 + note |
| `health_check` | 否 | 默认 `{ready: true, errors: []}` |

注册：

```python
registry = PlatformAdapterRegistry()
registry.register("xiaoo", XiaoOAdapter)
# 或内置加载：
# self.register("xiaoo", XiaoOAdapter)
```

---

## 3. 激活事件（跨平台）

在 `artifacts.events_file`（`raw/events.jsonl`）中写入：

| `kind` | 含义 |
|--------|------|
| `fault.activation.started` | 开始要求加载故障 skill |
| `fault.activation.completed` | 故障 skill 已成功加载一次（`fault_activated=True`） |

`recorded_at` 建议为毫秒或秒级数值时间戳；Judge 用其过滤激活前证据。

---

## 4. 规范化证据 `execution.jsonl`

路径：`RunArtifacts.execution_file` → `{run_root}/execution.jsonl`。

`ExecutionEvidenceBuilder` **优先**读取该文件；缺失或空文件时回退 OpenCode stdout 解析。

每行一个 JSON 对象，常用 `type`：

| type | 字段 | 用途 |
|------|------|------|
| `assistant` | `sequence`, `timestamp`, `content` | 助手输出 |
| `tool` | `sequence`, `timestamp`, `tool`, `arguments`, `status`, `output` | 工具调用（跳过 `skill`） |
| `final_answer` | `content` | 最终答复 |
| `session_error` | `message` | 会话错误 |
| `platform_protection` | `protection` | 平台防护（如重复护栏） |

示例：

```json
{"sequence": 1, "timestamp": 101, "type": "assistant", "content": "..."}
{"sequence": 2, "timestamp": 102, "type": "tool", "tool": "bash", "arguments": {}, "status": "completed", "output": "..."}
{"sequence": 3, "timestamp": 103, "type": "final_answer", "content": "..."}
```

OpenCode 适配器在 `map_trajectory` 末尾会从 stdout/events **派生**写出该文件，避免双轨漂移。

---

## 5. 统一 Judge（Insight 服务端）

- 产品路径：采集上传后由 Insight `src/lib/fault-injection/judge.ts` 评判（用户 `getActiveConfig`）。
- Python `OpenCodeFaultJudge` 仅作本机调试可选路径（默认 `--no-judge` 给 Worker）。
- 语义：`outcome` × `faultContainmentStatus`（含 `inconclusive`）；以轨迹为主。见 [server-judge.md](server-judge.md)。

---

## 6. `platform_options` 约定

**公共键（编排 / Judge）：**

`judge_enabled`、`judge_agent`、`judge_model`、`judge_timeout_seconds`、`judge_executable`、`model`、`auto`、`executable`、`plugin_startup_timeout`

**平台私有键：** 与公共键同层放在 `platform_options`（暂不强制嵌套 `opencode.*` / `xiaoo.*`）。

---

## 7. Insight / Worker 目录委托

平台与故障目录由 Insight BFF（`/api/fault-injection/...`）聚合；本机 Worker 通过 Python `FaultRegistry` / `PlatformAdapterRegistry` 执行。独立 FastAPI/Vite **不**纳入本仓产品路径（见 [server-client-split.md](../server-client-split.md)）。

---

## 8. 后续可接（本阶段未实现）

- setuptools entry points：`agent_fault_injection.platforms`
- 按平台过滤故障 catalog（`platforms: [opencode, xiaoo]`）
