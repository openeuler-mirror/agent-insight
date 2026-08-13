# Platform Adapter 接入契约

> **Insight 拓扑说明**：编排与 Judge 在 agent-insight 服务端；本机 FI Worker + [`agent_fault_injection/`](../../../../agent_fault_injection/) 负责注入与采集。独立 FastAPI/Vite 不纳入产品路径。


> 面向在 `agent-fault-injection` 中新增被测 Agent 平台（如 xiaoO）。  
> 产品评判走 Insight 服务端 Judge；被测平台只负责注入、执行与轨迹映射（本机 Python Judge 已删除）。

---

## 1. 最小接入清单

1. 实现 `PlatformAdapter`（`execute` + `map_trajectory`）。
2. 在 `PlatformAdapterRegistry._load_builtins`（或测试中 `register`）注册平台名。
3. 写出 `raw/events.jsonl`（含激活事件）与 `trajectory.jsonl`；`interactions.json` 仅 markers + Trace ID（`interactions` 恒为 `[]`）。平台可另写 `execution.jsonl` 作本地证据，**不是** Insight Judge 真源。
4. 可选实现 `list_agents` / `list_models` / `health_check`；FI Worker 启动时经 `platform inventory --json` 聚合为本机 inventory（Insight platforms API 读 Worker heartbeat）。
5. **不必**实现平台专用 Judge。

---

## 2. `PlatformAdapter` 契约

| 方法 | 必需 | 说明 |
|------|------|------|
| `execute` | 是 | 安装故障资产、启动被测运行时、等待结束，返回 `PlatformRunResult` |
| `map_trajectory` | 是 | 写 `trajectory.jsonl`；可选写 `execution.jsonl`（本地证据，非 Judge 真源） |
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

`recorded_at` 建议为毫秒或秒级数值时间戳；激活窗口与 markers 用其标注注入时点。

---

## 4. 规范化证据 `execution.jsonl`（可选本地产物）

路径：`RunArtifacts.execution_file` → `{run_root}/execution.jsonl`。

平台 `map_trajectory` **可**写出该文件作本地排障/映射中间态。**Insight Judge 不以它为真源**：评判主树来自 Insight ⓪ `Session.interactions`（经 `sessionTaskId` join）；FI ③ 只提供 markers / `faultActivated` / Trace ID。

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

OpenCode 适配器 `map_trajectory` 写 `trajectory.jsonl`（FI kinds）；**不**依赖旧 `opencode.event` / `session.json`。xiaoO 等平台可继续写 `execution.jsonl` 作本地证据。

---

## 5. 统一 Judge（Insight 服务端）

- 产品路径：采集上传后由 Insight `src/lib/fault-injection/judge.ts` 评判（用户 `getActiveConfig`）。
- 本机 Python Judge / CLI `--judge*` **已删除**；Worker 只跑 inject+collect。
- 语义：`outcome` × `faultContainmentStatus`（含 `inconclusive`）；**主树 join Insight ⓪ `Session.interactions`**，FI markers / `faultActivated` 为注入侧证据。

---

## 6. `platform_options` 约定

**公共键（编排）：**

`model`、`auto`、`executable`、`plugin_startup_timeout`

**平台私有键：** 与公共键同层放在 `platform_options`（暂不强制嵌套 `opencode.*` / `xiaoo.*`）。

---

## 7. Insight / Worker 目录委托

平台与故障目录由 Insight BFF（`/api/fault-injection/...`）聚合；本机 Worker 通过 Python `FaultRegistry` / `PlatformAdapterRegistry` 执行。独立 FastAPI/Vite **不**纳入本仓产品路径。

---

## 8. 已不做 / 后续可接

**已不做（插件化后）：**

- 按平台过滤故障 catalog（原 `platforms: [opencode, xiaoo]` 字段已删除）；UI 默认双平台，能力差由 Adapter / 文档说明

**后续可接（本阶段未实现）：**

- setuptools entry points：`agent_fault_injection.platforms`

---

## 9. 扩展约定（防债）

- 新平台：实现 `platform-adapter-spi.md` 所述 SPI；**不要**复制 OpenCode/xiaoO 整段 `execute`。
- **不做**完整 Ports 六边形 / L2 Method 类 Facade；能力面以 `capability_api.yaml` + CI 为准。
- OpenCode runtime 改写见 `opencode-rewrite-spike.md`。
