# WorkBuddy Trace 采集需求分析

## 背景

腾讯 WorkBuddy Windows 桌面版是一个未接入 Agent Insight 的闭源客户端。启动前的现状排查（README「支持平台」表、`docs/developer-guide/09-trace-collector.md`、全仓 `workbuddy` 关键字检索）确认：仓库内没有任何 WorkBuddy 相关代码、适配器或文档，本机安装前也没有任何可参考的实现。因此本需求没有"照抄现成集成"的捷径，第一步必须先摸清 WorkBuddy 本地到底留下了哪些可用数据。

在本机实际安装并使用 WorkBuddy（`appVersion 5.5.3`，内嵌 CLI 内核 `2.137.1`）后，对 `%USERPROFILE%\.workbuddy\` 目录、`resources/app.asar` 编译后源码、`workbuddy.db` SQLite 库做了实测排查，结论记录如下，作为后续设计（见 `phase2-requirements-design.md`）的事实依据。

## 现状调研：WorkBuddy 是什么

WorkBuddy 是 Electron 应用，内嵌一个类 Claude Code 的 CLI 运行时，每个会话在本地起一个 HTTP 服务，同时把关键数据落盘到本地文件系统。它不是纯黑盒——安装包自带一个离线诊断工具 `resources/conversation-report.html`，工具标题栏里写死的路径约定（`sdk/perf/*.jsonl`、`sdk/conversations/*.log`）证明这套本地文件本来就是给诊断用的，不是纯逆向猜出来的。

排查还确认：`~/.workbuddy/settings.json` 只有 `sandbox`/`enabledPlugins`/`claw` 配置项，**没有找到任何 Hook/插件扩展点**（不像 Qoder CN 那样有 `SessionStart`/`PreToolUse` 之类的钩子可挂）。这一点决定了采集方式只能是文件监听，不能走 Hook 模式，是后续设计的关键前提。

### 数据源清单（均已实测验证）

| # | 路径 | 结构 | 提供什么 | 生命周期风险 |
|---|---|---|---|---|
| D1 | `~/.workbuddy/traces/<pid>/trace_<uuid>.json` | `{trace:{traceId,name,workerPid,workerHostname,startedAt,endedAt,duration,status,spanCount,totalTokens,metadata}, spans:[{traceId,spanId,parentId,name,type,startedAt,endedAt,duration,status,error,...}]}` | **核心 span 树**：`type:"agent"`（agentName）、`type:"generation"`（LLM 调用，`toolInput`=messages、`toolOutput`=模型响应含 choices + **usage**）、`type:"function"`（真实工具调用，`toolName`/`toolInput`/`toolOutput`）、`type:"custom"`（`mcp_tools` 等无 I/O 的发现类噪声 span） | 一次 trace 完成后一次性写入，未观察到增量追加；文件名带 uuid，不会被覆盖 |
| D2 | `~/.workbuddy/sessions/<pid>.json` | `{sessionId,cwd,startedAt,kind,url,endpoint,mode,version,os,arch,hostname,updatedAt}` | 把 `pid`（trace 里的 `workerPid`）关联回真正的 `sessionId`，附带 WorkBuddy 版本、工作目录 | **会话结束后会被清理**，必须在文件存在期间就抓下来，不能等 trace 出现再查 |
| D3 | `~/.workbuddy/logs/<date>/sdk/conversations/<sessionId>.log` | 逐行 JSON：`method:sendPrompt{mode,modelId,blockCount}`、`event-machine:dispatch{input,requestId,messageId}`、用户原始输入（`userContent`）、`usage_update`（仅布尔标记，无具体数值） | 补全 trace 里没有的：**对话模式**（ask/craft/work）、**modelId**、**用户原始提问文本** | 文件持续追加增长（观察到几小时内长到 2MB），需要按字节偏移增量读取，不能每次全量重读 |
| D4 | `~/.workbuddy/workbuddy.db`（+`-wal`/`-shm`，Drizzle 管理的 SQLite，WAL 模式） | `sessions(id,cwd,user_id,title,status,mode,model,expert_id,permission_mode,use_sandbox_cli,...)`、`session_usage(session_id,used,size,updated_at,credit_json)` | 会话级元数据（真实 `model`/`mode`）+ token 用量（见下节） | 是主进程正在写的活库，读时必须只读打开，不能获取写锁 |
| D5 | `~/.workbuddy/.workbuddy-sqlite-migrations/*.sql` | 官方 Drizzle 迁移 SQL 明文 | 直接读 schema，不用逆向猜字段；也是判断 WorkBuddy 版本升级是否动过表结构的依据 | 只在应用升级时变化，采集器启动时读一次即可 |

### Token 数据的真实边界

Token 有两个层次，分别落在两处，都能拿到真实值：

**1. 逐轮（每次 LLM 调用）的精确拆分 —— 就在 trace 文件里。** 每个 `type:"generation"` span 的 `toolOutput` 字段是模型 API 的原始响应 JSON，内嵌完整 `usage`。真实样本（9 条 trace 全部一致，`gensWithUsage == gens`）：

```json
"usage": {
  "prompt_tokens": 513,
  "completion_tokens": 1105,
  "total_tokens": 1618,
  "prompt_tokens_details": { "cached_tokens": 448 },
  "completion_tokens_details": { "reasoning_tokens": 1087 }
}
```

即 input(`prompt_tokens`)/output(`completion_tokens`)/total/cache(`prompt_tokens_details.cached_tokens`)/reasoning(`completion_tokens_details.reasoning_tokens`) 逐轮拆分**均可从 D1 直接读到**，`model` 也在同一响应对象里。这推翻了早期"逐轮拆分只在内存、未落盘"的判断——它确实落盘，只是藏在 generation span 的 `toolOutput` 字符串内。

**2. 会话级上下文占用快照 —— 在 SQLite。** 顺着 `session_usage` 表在 `app.asar` 找到持久化源码 `SqliteConversationUsagePort.persistUsage()`：

```js
const incomingUsed = finiteInteger(usage.totalTokens ?? usage.inputTokens);
const incomingSize = finiteInteger(usage.contextWindow);
// session_usage.used = usage.totalTokens（当前会话上下文总占用，覆盖式更新）
// session_usage.size = usage.contextWindow（模型上下文窗口上限，随选择的模型变化）
// session_usage.credit_json = 按 requestId 累加的 usage.cost.amount（计费/积分，与 token 无关）
```

结论：**逐轮精确 token（含 cache/reasoning）以 trace 文件的 generation.toolOutput.usage 为准，全部可精确填充**；`session_usage.used`/`size` 提供会话级"当前上下文占用 / 窗口上限"快照，作为独立维度呈现（不与逐轮值混淆）。因此本方案不需要任何估算或 `estimated=true` 标记——所需 token 数据都是真实落盘值。

## 目标

- 在不依赖 WorkBuddy 任何官方 Hook/插件 API 的前提下，采集其本地产生的 Agent 会话数据（D1～D5），转换为 Agent Insight 平台标准 OTLP trace 并入库。
- 覆盖 Agent 调用（`type:"agent"`）、LLM 生成（`type:"generation"`）、MCP/工具调用（`type:"custom"`）三类核心 span，以及用户原始提问、会话模式、模型名称。
- token 用量以真实落盘值填充：逐轮 input/output/cache/reasoning 精确拆分取自 trace 文件的 generation.toolOutput.usage；会话级上下文占用/窗口上限取自 SQLite。无可用数据时留空，绝不估算或伪造。
- 采集器安装后无需用户手动启动：开机/登录自动拉起，进程崩溃后自动恢复。
- 遵循平台现有的 OTLP + Adapter 摄入契约，复用现有共享 spool/上传工具，不重新发明协议。

## 非目标

- 不对齐 Qoder CN Desktop 的多产品/多账号隔离体系、`estimated=true` 估算标记体系等重型设计——WorkBuddy 只有一个产品形态，且 token 拆分是"数据不存在"而非"估算不准"，不适用同一套标记语义。
- 不尝试破解或使用 WorkBuddy 本地 HTTP 服务（`sessions/<pid>.json` 里的 `endpoint`）等未公开协议；本方案严格限定在"读取本地文件系统落盘数据"范围内。
- 不解析或上报 Tencent Beacon 埋点库（`AppData\Roaming\Tencent\beacon\*.db`）——这是腾讯全家桶共用的统计上报库，schema 未知且是多产品共用存储，不在本方案范围内。
- 一期不覆盖 macOS/Linux 版本 WorkBuddy 的自动启动注册（若未来存在，可直接复用平台已有的 `systemd --user`/`launchd` 实现，见 phase2）。

## 验收标准

1. 一次真实 WorkBuddy 对话（craft/ask/work 任一模式）产生的 trace，能在 Agent Insight Web UI 的 Trace 详情页里查看到：用户原始提问、Agent/LLM/工具调用的时间线、模型名称、逐轮精确 token 以及会话级上下文占用。
2. 会话结束、心跳文件（D2）被清理后，仍能正确追溯到该 trace 所属的 `sessionId`（不因心跳消失而丢数据或归并到错误会话）。
3. WorkBuddy 主进程重启、崩溃或升级期间，采集器不受影响；采集器自身重启或崩溃，不影响 WorkBuddy 正常使用。
4. 用户完成一次安装操作后，无需任何手动命令即可让采集器在下次开机/登录后自动运行；采集器进程被杀死后能自动恢复。
5. token 展示分两个维度且不混淆：逐轮 input/output/cache/reasoning（来自 generation.toolOutput.usage 的精确值）与会话级"当前上下文占用/窗口上限"（来自 SQLite 快照）。无数据时字段不出现，不得估算或用会话总量反推逐轮值。
6. WorkBuddy 版本升级导致 D1～D5 任一格式发生变化时，采集器按字段缺失降级处理，不抛异常、不中断其余数据的采集。

> 后续设计见 [`phase2-requirements-design.md`](phase2-requirements-design.md)；开发步骤与风险清单见 [`phase3-development-plan.md`](phase3-development-plan.md)。
