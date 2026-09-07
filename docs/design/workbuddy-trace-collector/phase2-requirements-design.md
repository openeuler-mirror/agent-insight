# WorkBuddy Trace 采集需求设计

> 需求背景、数据源实测结论与 token 边界见 [`phase1-requirements-analysis.md`](phase1-requirements-analysis.md)；开发步骤与风险清单见 [`phase3-development-plan.md`](phase3-development-plan.md)。

## 一、总体架构

```mermaid
flowchart TB
    subgraph WB["WorkBuddy.exe（Electron，无 Hook/插件扩展点）"]
        direction TB
        WBM["主进程 / CLI 运行时"]
    end

    subgraph FS["本地文件系统 ~/.workbuddy/"]
        direction TB
        D1["traces/&lt;pid&gt;/trace_*.json<br/>span 树（核心）"]
        D2["sessions/&lt;pid&gt;.json<br/>心跳：pid → sessionId（易失）"]
        D3["logs/&lt;date&gt;/sdk/conversations/&lt;sessionId&gt;.log<br/>模式/模型/用户原文（追加写）"]
        D4[("workbuddy.db（SQLite WAL）<br/>sessions / session_usage")]
    end

    WBM -- 写 --> D1
    WBM -- 写(心跳) --> D2
    WBM -- 追加写 --> D3
    WBM -- 写 --> D4

    subgraph COL["Agent Insight WorkBuddy Collector（独立常驻进程）"]
        direction TB
        W1["Session Registry<br/>持续订阅 D2，维护 pid→sessionId 缓存<br/>（心跳消失前必须已缓存）"]
        W2["Trace Watcher<br/>监听 D1 新文件"]
        W3["Enricher<br/>用 sessionId 拉取 D3 增量 + D4 只读查询"]
        W4["Canonical Mapper<br/>span 树 → canonical event"]
        W5["Spool（本地 JSONL 队列）"]
        W6["Uploader<br/>批量 POST + 重试"]
    end

    D2 -.持续 tail.-> W1
    D1 -- 新文件事件 --> W2
    W1 -- pid→sessionId --> W2
    W2 --> W3
    D3 -.增量读取(按偏移量).-> W3
    D4 -.只读查询(query_only).-> W3
    W3 --> W4 --> W5 --> W6

    subgraph SRV["Agent Insight 服务端"]
        direction TB
        S1["/api/ingest/otel/v1/traces<br/>decode.ts"]
        S2["normalize.ts<br/>→ OtelTraceEvent[]"]
        S3["adapter-registry.ts<br/>按 service.name=workbuddy 匹配"]
        S4["adapters/workbuddy.ts<br/>聚合成 ExecutionRecord"]
        S5[("data-service.ts<br/>入库 Execution / Session")]
        S6["Web UI：Trace 详情 / 诊断"]
    end

    W6 -- "HTTP POST（OTLP JSON）" --> S1 --> S2 --> S3 --> S4 --> S5 --> S6
```

---

## 二、客户端采集器设计

### 2.1 为什么必须是独立常驻进程

WorkBuddy 没有暴露 `SessionStart`/`PreToolUse` 之类的生命周期钩子，也没有原生 OTel 配置项，因此不能像 Claude Code / Qwen Code 那样"配置一个环境变量就完事"，也不能像 Qoder 那样"在 Hook 里同步触发一次快照"。采集器只能是一个**独立的本地文件监听服务**，跟 WorkBuddy 进程完全解耦：WorkBuddy 崩溃、重启、升级都不影响采集器；采集器崩溃、重启也不影响 WorkBuddy 正常使用。

代价是：不能像 Hook 模式那样精确知道"这一刻会话结束了"，只能靠"新 trace 文件出现"作为触发信号——好在 D1 的 trace 文件本身就是完整写完才落盘的（观测到的所有样本都是 `startedAt`/`endedAt` 同时存在），所以拿"文件新增事件"当触发点是可靠的。

### 2.2 核心风险：心跳文件的时序问题

`sessions/<pid>.json`（D2）在会话结束后会被清理，如果采集器"看到 trace 文件才去查 D2"，很可能已经查不到了。所以设计上把 Session Registry 做成**持续订阅**而不是"按需查询"：

```mermaid
sequenceDiagram
    participant WB as WorkBuddy 进程(pid=P)
    participant D2 as sessions/P.json
    participant SR as Session Registry(采集器)
    participant D1 as traces/P/*.json
    participant TW as Trace Watcher(采集器)

    WB->>D2: 会话开始，写入心跳 {sessionId, mode, version...}
    D2-->>SR: chokidar add 事件
    SR->>SR: 缓存 pid=P → sessionId（写入本地小缓存文件，防采集器重启丢失）
    WB->>D2: 定期更新心跳 updatedAt
    D2-->>SR: change 事件（刷新缓存）
    Note over WB,D1: 一次对话产生一条 trace
    WB->>D1: 写完整 trace_xxx.json
    D1-->>TW: add 事件
    TW->>SR: 查询 pid=P 对应的 sessionId
    SR-->>TW: 命中缓存（无论 D2 此刻是否已被清理）
    WB->>D2: 会话结束，删除心跳文件
    D2-->>SR: unlink 事件（缓存保留一段 TTL 后再淘汰，防止清理时序早于最后一条 trace）
```

要点：
- 缓存以 `pid` 为 key，`unlink` 时不立即删缓存，而是打上"已结束"标记，保留一段宽限期（例如 10 分钟）再真正淘汰，避免"心跳先被清理、trace 文件后落盘"的乱序。
- 采集器重启后先做一次 D2 目录全量扫描重建缓存，再进入订阅模式，减少重启窗口期的丢失。
- 极端情况下（缓存里也找不到，比如采集器重启时机极不巧）：不丢弃这条 trace，而是降级用 `workerPid + workerHostname + trace.startedAt` 拼一个兜底 session key 入库，标记 `sessionResolution: "degraded"`，好过整条丢弃。

### 2.3 数据关联与增量读取

- **D3（会话日志）增量读取**：这个文件持续追加、单文件可以长到几 MB，不能每次全量重读。采集器按 `(文件路径 → 已读字节偏移量)` 维护游标，每次只 `read from offset`，按行解析新增内容，提取 `method:sendPrompt` 里的 `mode`/`modelId` 和 `userContent` 原文。
- **D4（SQLite）只读关联**：连接时设置 `PRAGMA query_only = ON`（只读事务，不与主进程的写事务抢锁），查询按 `session_id` 精确查一行，短超时（如 200ms）拿不到就跳过本次关联，不阻塞整体流程；下一条 trace 触发时再查一次即可，不需要专门重试机制。
- **D5（迁移 SQL）**：采集器启动时读一次，做字段存在性探测；如果发现 `session_usage` 表缺少 `credit_json` 或 `sessions` 表缺少 `mode`/`model` 列（版本升级导致的 schema 变化），对应字段直接置空，不抛错、不阻塞采集，这是应对"闭源内部实现随时可能变"的基本姿势。

### 2.4 Span → Canonical Event 映射

复用项目现有的 `scripts/agent-trace-collectors/shared/trace-transport.cjs` 里的 canonical event 结构和 `canonicalEventsToOtlp()`，不用重新发明协议。映射由纯函数 `scripts/workbuddy-collector/mapper.cjs` 的 `mapWorkBuddyTrace()` 实现（无 I/O，便于单测）：

| WorkBuddy 原始结构 | canonical event `kind` | 说明 |
|---|---|---|
| `trace`（整条 trace） | `chain`（合成根节点） | `name` 取 `trace.name`；承载该轮用户原文、`mode`、会话级 token 快照；作为所有 `parentId=null` 顶层 span 的父节点 |
| `spans[].type === "agent"` | `agent` | `agentName` 映射为 agent 名称 |
| `spans[].type === "generation"` | `llm` | `input` = `toolInput` 里最后一条 user 文本；`output` = 响应的 `choices[].message.content`；`model` 与 `usage` 从 `toolOutput` 内嵌的模型响应直接解析 |
| `spans[].type === "function"` | `tool` | 真实工具调用：`tool.name`=`toolName`，`tool.arguments`=`toolInput`，`tool.result`=`toolOutput.content`。子 Agent 派发（`toolName === "Agent"`）也是普通工具调用，**按普通 TOOL 节点显示**（保留 `subagent_type`/`prompt` 参数与子 Agent 报告），不转成 task、不合成子 Agent 节点——因为子 Agent 内部链路 WorkBuddy 未落盘，无可展开内容 |
| `spans[].type === "custom"`（`mcp_tools`） | —（跳过） | 无 I/O 的发现类噪声 span（单条 trace 常有几十个），不逐条上报；仅在根节点记 `workbuddy.mcp_tools_span_count` 计数 |
| 整条 trace 的 agent 全是内部工具（如 `terminalTitleGenerator`） | —（整条跳过） | WorkBuddy 生成侧边栏标题等内部会话，不是用户对话，映射为空、不上报 |

用户原文优先取自 D3 `method:sendPrompt`（若采集），否则回退 `generation.toolInput` 最后一条 user 消息——后者是逐 trace 精确的，MVP 直接用它，`mode`/`model` 从 D4 补全。

Token 字段填法（逐轮精确值来自 trace 文件本身，无需估算）：

```js
// 每个 generation span：从 toolOutput 内嵌的模型响应解析真实 usage
usage: {
  input:     rawUsage.prompt_tokens,                                  // 精确
  output:    rawUsage.completion_tokens,                              // 精确
  reasoning: rawUsage.completion_tokens_details?.reasoning_tokens,    // 精确
  total:     rawUsage.total_tokens,                                   // 精确
}
// cache 单独走 attribute（canonical usage 无标准槽位）
attributes["workbuddy.cache_read_tokens"] = rawUsage.prompt_tokens_details?.cached_tokens;

// 根节点：会话级上下文占用快照（来自 D4，独立维度，非逐轮累计）
attributes["workbuddy.session.total_tokens"] = sessionUsage?.used;
attributes["workbuddy.context_window"]       = sessionUsage?.size;
// 无 usage 的 generation → 该事件不带 usage，绝不填 0
```

### 2.5 Spool 与上传

不需要 Qoder 那种"按产品+账号多级隔离"的复杂 spool 结构（WorkBuddy 只有一个产品形态），直接复用现有共享工具（`trace-transport.cjs` 里的 `DurableTraceWriter`/`DurableTraceUploader`）：

- 落盘目录：`~/.agent-insight/otel_data/workbuddy/<apiKeyHash>/`
- 触发时机：**每条 trace 文件出现即处理即上传**（不用等会话结束），比 Qoder 的"整会话快照"粒度更细、更及时，实现也更简单——因为 WorkBuddy 天然按 trace 分片，不需要自己做会话级缓冲。
- 上传失败：写入本地 spool，独立的上传线程定时扫描重试，成功后删除，这部分和其他框架的采集器完全一致，不需要为 WorkBuddy 单独设计。

---

## 三、客户端安装与自动启动

采集器不应该要求用户每次手动敲命令启动——这一节把"装完就一直在后台跑，开机/登录自动拉起，崩了自己重启"作为硬性要求来设计，而不是留到"按需追加"的可选项。

### 3.1 现状：平台目前只做了 Linux/macOS，Windows 是空白

仓库里现成的常驻客户端安装器 `scripts/install-ras-client.js`（Agent RAS 的可靠性客户端，同样是一个不依赖任何 Agent Hook、需要开机自启的独立进程，场景和这里几乎一样）已经做了：

- Linux：生成 `systemd --user` unit，`enable` + `restart`，自带 `Restart=on-failure`/`WatchdogSec` 崩溃自愈
- macOS：生成 `launchd` plist，`RunAtLoad` + `KeepAlive.SuccessfulExit=false` 自愈

但代码里写死了：

```js
if (process.platform === 'win32') {
  fail(
    'Windows 暂不支持自动注册为系统服务',
    '本期仅支持 Linux (systemd) 与 macOS (launchd)。Windows 上可手动运行: node ...',
  )
}
```

也就是说，**"Windows 下免手动启动的常驻安装"这块目前整个平台都没做过**，WorkBuddy 采集器要补的正是这个空白，不是照抄一个现成方案。

### 3.2 Windows 侧自启动方案选型

| 方案 | 免管理员权限 | 崩溃自愈 | 隐藏窗口运行 | 结论 |
|---|---|---|---|---|
| 启动文件夹快捷方式（`shell:startup`） | ✅ | ❌ 不支持 | 需要额外包一层 | 太弱，进程崩了就永久停摆，直到下次登录 |
| Windows 服务（`node-windows`/NSSM） | ❌ 需要管理员权限装服务 | ✅ | ✅ | 安装体验差（UAC 弹窗打断一键安装），且服务默认在 Session 0 运行，访问用户 `%USERPROFILE%\.workbuddy` 还要额外配置以用户身份运行，没必要这么重 |
| **计划任务（Task Scheduler，登录触发，当前用户范围）** | ✅ | ✅（原生支持"失败后自动重启"） | ✅ | **采用**：系统自带 `schtasks.exe`，不需要额外依赖；免管理员权限；效果上等价于 systemd --user / launchd 在 Windows 上的对应物 |

选定 **Task Scheduler + 登录触发（LogonTrigger）+ 当前用户范围**，效果上正好补齐 `install-ras-client.js` 在 Linux/macOS 已经做到、Windows 一直缺的那一块。

### 3.2.1 运行时：复用 WorkBuddy 自带 Electron，免装 Node

采集器与安装器都是 JS 脚本，需要一个 Node 运行时。若要求用户单独安装 Node.js，接入门槛会高很多。WorkBuddy 本身是 Electron 应用，`WorkBuddy.exe` 在 `ELECTRON_RUN_AS_NODE=1` 下等价于普通 `node`（已实测：能正确执行本方案的 `.cjs`/`.mjs`，含 ESM import 与 top-level await）。因此：

- 安装器 `workbuddy_setup.mjs` 通过 `findWorkBuddyExe()` 定位 `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`（回退 `%PROGRAMFILES%`），作为采集器运行时；找不到才回退到 `process.execPath`。
- 生成的隐藏窗口启动器 `.vbs` 先 `shell.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"` 再运行 `WorkBuddy.exe collector.mjs`（对真实 node.exe 设该变量无副作用）。
- 一键 PS 安装块同样优先用 `WorkBuddy.exe`（设 `ELECTRON_RUN_AS_NODE=1`）运行安装器，其次回退 `node`。
- 一键脚本开头的 Node.js 检查对「仅选 WorkBuddy」放行（`workbuddyOnly`，与既有 `llamaIndexOnly` 同样的旁路），Node-less 机器也能装。

结论：**接入 WorkBuddy 采集不需要在用户机器上单独安装 Node.js**（前提是 WorkBuddy 已安装，这本就是采集的前提）。`node:sqlite` 只读富化需 Node ≥ 22.5，Electron 内置 Node 若不带该模块，采集器按缺失降级（逐轮 token/model 仍来自 trace 文件，不受影响）。

### 3.3 安装流程

```mermaid
flowchart LR
    A["用户执行一键安装脚本<br/>(PowerShell / npx agent-insight install)"] --> B{"探测 WorkBuddy 是否已安装<br/>%LOCALAPPDATA%\Programs\WorkBuddy 或 ~/.workbuddy"}
    B -- 未安装 --> B1["提示：请先安装并至少打开一次 WorkBuddy"]
    B -- 已安装 --> C["落地采集器脚本到<br/>~/.agent-insight/packages/workbuddy/collector.mjs"]
    C --> D["写入配置<br/>~/.agent-insight/otel_data/workbuddy/config.json<br/>(endpoint + apiKeyHash)"]
    D --> E["生成任务定义 XML 并注册<br/>schtasks /create /tn AgentInsight-WorkBuddyCollector /xml ... /f"]
    E --> F["立即拉起一次<br/>schtasks /run /tn AgentInsight-WorkBuddyCollector"]
    F --> G["采集器常驻运行<br/>之后每次登录自动启动，崩溃后按策略自动重启"]
```

关键实现点：

1. **必须用 XML 注册，不能只用 `schtasks /create` 的命令行参数**：命令行参数不支持"失败后自动重启"这个设置项，只有导入任务定义 XML 才能带上：

```xml
<Settings>
  <RestartOnFailure>
    <Interval>PT1M</Interval>
    <Count>999</Count>
  </RestartOnFailure>
  <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>  <!-- 常驻进程，不限时长 -->
  <Hidden>true</Hidden>
</Settings>
<Triggers>
  <LogonTrigger>
    <Enabled>true</Enabled>
  </LogonTrigger>
</Triggers>
```

   安装脚本：`schtasks /create /tn "AgentInsight-WorkBuddyCollector" /xml "<生成的临时xml路径>" /f`（`/f` 覆盖已存在的同名任务，保证重复安装/升级是幂等的）。

2. **动作不要直接指向控制台程序**：Task Scheduler 直接跑控制台程序，登录瞬间偶尔会闪一下黑框，体验很差。用一个隐藏窗口的 `.vbs` 小启动器包一层，设 `ELECTRON_RUN_AS_NODE=1` 让 WorkBuddy.exe 以 Node 模式运行采集器；并且 `.vbs` 必须 **阻塞等待**采集器（`Run(..., 0, True)`）再 `WScript.Quit(code)`：

```vbs
Dim shell, code
Set shell = CreateObject("WScript.Shell")
shell.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"
code = shell.Run(Chr(34) & "<WorkBuddy.exe 绝对路径>" & Chr(34) & " " & Chr(34) & "<collector.mjs 绝对路径>" & Chr(34), 0, True)
WScript.Quit(code)
```

   为什么必须 `True`（阻塞等待）而不是 `False`：若不等待，wscript 发射后立即退出、采集器脱离成孤儿进程，Task Scheduler 认为任务瞬间成功结束 → 状态永远显示 `Ready` 而非 `Running`，且 `RestartOnFailure` **盯不到采集器崩溃**（崩溃自愈失效）。阻塞等待后，wscript 与采集器同生命周期：状态正确显示 `Running`，采集器崩溃以非零码退出 → wscript `Quit` 非零 → `RestartOnFailure` 真正拉活。代价：多驻留一个 wscript 进程（开销可忽略）。任务 Action 指向 `wscript.exe collector-launcher.vbs`，全程不弹窗；运行时是 WorkBuddy 自带 Electron，无需系统 Node。

   **停止的正确姿势**随之改变：因为采集器是 wscript 的子进程且崩溃会被 `RestartOnFailure` 拉活，手动停止**不能只杀采集器进程**（会被立刻拉回），要用 `schtasks /end /tn ...` 结束整个任务实例。

3. **安装后立即启动一次**，不用等用户重新登录：`schtasks /run /tn "AgentInsight-WorkBuddyCollector"`，对齐 `install-ras-client.js` 里 `installSystemd(start)`/`installLaunchd(start)` 的"装完即起"逻辑。

4. **单实例保护**：采集器进程启动时检查一个带 PID 的 lock 文件——如果 lock 里的 PID 仍在跑，直接退出。这样即使用户手动又运行了一次，或者 Task Scheduler 因为某些原因重复触发，也不会跑出两个实例重复上传。

5. **`--status` / `--uninstall`**：延续 `install-ras-client.js` 的既有 UX 习惯——

```bash
node workbuddy_setup.mjs --status      # schtasks /query /tn AgentInsight-WorkBuddyCollector
node workbuddy_setup.mjs --uninstall   # schtasks /delete /tn ... /f + 清理配置和 lock 文件
```

### 3.4 接入平台既有的一键安装入口

按 `docs/developer-guide/09-trace-collector.md` 里已经定死的规矩：新框架只能在 `setup/route.ts`（curl/PowerShell 一键安装）和 `setup/auto/route.ts`（`npx agent-insight install`）两个入口的框架列表**末尾追加**，不能改动已有条目的顺序/名称/值。WorkBuddy 选项选中后，服务端吐出一段包含上述 Task Scheduler 注册逻辑的 PowerShell 脚本，用户粘贴执行即可，或者由本地 npm 包自动调用，两条入口都要覆盖到，跟其他框架的验收要求一致。

### 3.5 跨平台备注

本节的 Task Scheduler 方案只覆盖 Windows。如果未来 WorkBuddy 出 macOS/Linux 版本，直接复用 `install-ras-client.js` 里已经跑通的 `systemd --user`/`launchd` 代码，不需要重新设计一遍。

---

## 四、服务端设计

### 4.1 新增 Adapter

位置：`src/lib/ingest/otel/adapters/workbuddy.ts`，实现现有接口：

```typescript
export interface OtelTraceAdapter {
  readonly id: string;
  matches(events: OtelTraceEvent[]): boolean;      // 通过 service.name === "workbuddy" 识别
  aggregate(sessionId: string, events: OtelTraceEvent[]): ExecutionRecord | null;
}
```

在 `src/lib/ingest/otel/adapter-registry.ts` 里追加注册（放在 `genericOtelTraceAdapter` 兜底适配之前）：

```typescript
import { workbuddyOtelTraceAdapter } from './adapters/workbuddy';

const adapters: readonly OtelTraceAdapter[] = [
  // ...既有 adapter
  workbuddyOtelTraceAdapter,
  genericOtelTraceAdapter, // 兜底，始终放最后
];
```

### 4.2 ExecutionRecord 字段映射

| `ExecutionRecord` 字段 | 取值来源 |
|---|---|
| `task_id` | WorkBuddy `sessionId`（D2/D4 关联得到，不是 pid） |
| `query` | D3 里第一条 `method:sendPrompt` 对应的用户输入原文 |
| `framework` | 固定 `"WorkBuddy"` |
| `model` | 最近一次 generation 的 `toolOutput.model`（如 `hy4-preview`、`custom-local:deepseek-v4-flash`） |
| `tokens` / `input_tokens` / `output_tokens` / `reasoning_tokens` / `cache_read_input_tokens` | 各 generation 的精确 usage 汇总（逐轮真实值）；无任何 usage 时全部留空 |
| `context_window_limit` / `workbuddy_session_context_tokens` / `context_window_source` | 会话级上下文窗口上限 / 当前占用快照 / 来源标记（`workbuddy_local_sqlite`），来自 D4，独立于逐轮 token |
| `latency` | 端到端墙钟时长，**毫秒**（与链路树根节点同源同单位，不做 /1000） |
| `trace_completed_at` / `trace_status` | 设为最后一个 span 结束时间 / `success`，使详情页"执行状态"显示"已完成"（trace 文件写完即代表该轮结束） |
| `agent` / `agentName` | span `type==="agent"` 的 `agentName`；内部名 `cli`/`terminalTitleGenerator` 归一化为 `WorkBuddy` |
| `llm_call_count` | `type==="generation"` 的 span 数 |
| `tool_call_count` | `type==="function"` 的 span 数（`mcp_tools` 噪声 span 不计入） |
| 子 Agent | 名为 `Agent` 的 function 工具（带 `subagent_type`/`prompt`）**按普通 TOOL 呈现**，不转 task、不合成子 Agent 节点；子 Agent 的返回报告即该 TOOL 的 `result` |
| `interactions[]` | 按时间戳排序：user（该轮原文）→ assistant/generation（含精确 usage）→ tool（来自 function span，**按时间就近**挂到对应 assistant，而非全部堆到最后一个） |

### 4.3 Token 精度的诚实表达

服务端落库和展示层遵守一个原则：**有真实值就精确填，没有就留空，绝不用会话总量反推逐轮、也不估算**。WorkBuddy 的有利条件是逐轮拆分本就落盘在 generation.toolOutput.usage，因此：

- `interactions[]` 里每条 `assistant` 的 `usage`（input/output/reasoning/cache/total）是该次 LLM 调用的精确值；某次调用无 usage 时，该字段直接不出现（不是填 0）。
- 会话级 `workbuddy_session_context_tokens`（当前上下文占用）与 `context_window_limit` 单独成列，UI 标注为"当前上下文占用/窗口上限"，与逐轮消耗区分，避免误读。
- `session_usage.credit_json` 是计费/积分（与 token 无关），不参与任何 token 字段。

---

## 五、端到端时序（一次真实对话的完整生命周期）

```mermaid
sequenceDiagram
    participant U as 用户
    participant WB as WorkBuddy
    participant FS as 本地文件系统
    participant COL as Collector
    participant API as /api/ingest/otel/v1/traces
    participant DB as Agent Insight DB

    U->>WB: 发一条消息（craft 模式）
    WB->>FS: 心跳 sessions/pid.json 已存在（会话开始时写入）
    WB->>FS: 追加写 sdk/conversations/sessionId.log（sendPrompt, 用户原文）
    WB->>WB: 调用模型 / 工具 / MCP
    WB->>FS: 完整写入 traces/pid/trace_xxx.json（span 树）
    WB->>FS: upsert workbuddy.db.session_usage（used/size/credit_json）

    FS-->>COL: chokidar 触发 trace 文件 add 事件
    COL->>COL: 用 pid 查本地 pid→sessionId 缓存
    COL->>FS: 增量读取该 sessionId 的会话日志（按偏移量）
    COL->>FS: 只读查询 workbuddy.db（session_usage/sessions）
    COL->>COL: 映射为 canonical event → OTLP
    COL->>COL: 写入本地 spool
    COL->>API: POST OTLP JSON
    API->>API: decode → normalize → adapter-registry 匹配 workbuddy adapter
    API->>DB: 写入 Execution / Session
    DB-->>U: Web UI 可查看该次对话的 Trace / 诊断结果
```
