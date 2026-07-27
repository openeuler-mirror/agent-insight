# Pi Agent Trace 采集器：开发与验收计划

## 1. 实现顺序

### Phase A：契约与可靠传输

- A1：实现共享 JSONL append、完整行读取、checkpoint、锁、保留期和指数退避。
- A2：实现脱敏、2000 字符截断、稳定 ID 和 OTLP batch builder。
- A3：为 torn line、并发锁、500/断网恢复、重传去重和 API Key 隔离编写单元测试。

### Phase B：Pi 客户端

- B1：实现 Pi package manifest、版本检查和配置加载。
- B2：实现 session/agent/message/model/tool 事件状态机。
- B3：实现显式/自动 Skill、SubAgent 递归和 MCP metadata 解析。
- B4：实现 install/uninstall/self-check 和 setup 分发端点。
- B5：用 Pi 0.82.1 真实加载扩展，归档原始 spool 与 OTLP payload。

### Phase C：服务端

- C1：实现 `pi-agent` Adapter 和注册。
- C2：实现 Agent/SubAgent/Skill/Tool/LLM/MCP golden fixtures。
- C3：验证同 session 重传、部分 snapshot 和完整 snapshot 的 monotonic merge。

### Phase D：系统验收

- D1：openEuler 24.03 LTS SP4 一键/手工安装、卸载和重装。
- D2：标准任务、三层 SubAgent、五并发、Skill 与 MCP 成败场景。
- D3：20 次冷启动、30 次 TTFT 对照、RSS 和 8 小时 soak。
- D4：全量 `npm run test`、`npm run lint`、`npm run build`。

## 2. 测试证据规则

- 自动测试结果记录到 `test/pi-agent-trace/reports/automated-tests.md`。
- 真实 Pi 运行 payload 和结构化摘要放到忽略的 `test/pi-agent-trace/out/`，只把去敏后的报告纳入 PR。
- 性能报告必须记录机器、OS、Pi/Node/模型版本、样本数、median、P95 和原始数据哈希。
- 8 小时测试至少每 15 分钟记录 RSS、spool bytes、checkpoint bytes、上传成功/失败计数。
- “通过”必须同时具备矩阵中要求的命令、产物路径和断言；仅代码存在仍是“待验证”。

## 3. 逐条 AC 验收矩阵

| AC | 实现位置 | 自动测试 | 真实运行证据 | 当前状态（2026-07-28） |
|---|---|---|---|---|
| AC1 | Pi package + setup installer | package manifest/installer test | `pi list`、启动加载日志、首个 span | openEuler 安装/list/load/self-check通过；MiniMax-M3 首个真实模型 span 已入库 |
| AC2 | local package 手工安装流程 | manual config validation test | `pi install <path>` 后真实会话 | openEuler Pi 0.82.1 本地安装通过；真实模型与公开 Extension-core 夹具会话均已入库 |
| AC3 | transport spool initializer | directory/permission test | `~/.agent-insight/otel_data/pi-agent/` 树 | openEuler 真实 spool/checkpoint 已用于主会话、恢复和重装 |
| AC4 | API Key SHA-256 namespace | two-key isolation test | 两个 key 独立目录/checkpoint | openEuler managed layout 写入两个独立 namespace；scoped purge 后另一 key spool 哈希不变 |
| AC5 | Agent state + Adapter | Agent golden test | 一次真实 Pi 会话 ExecutionRecord | 四个真实模型 ExecutionRecord 与夹具 root + 8 child 均已在真实服务端入库 |
| AC6 | SubAgent result parser | single child fixture | 父/子 traceId 展示 | 官方 SubAgent 扩展真实启动独立 Pi 子进程，父子记录与 4252 child tokens 已持久化 |
| AC7 | recursive `details.results` | three-level fixture | A->B->C 真实/夹具报告 | openEuler 公开接口夹具已持久化三层 A->B->C |
| AC8 | result index stable IDs | five-parallel fixture | 五子树同父且互不串联 | openEuler 公开接口夹具已持久化五个同级 worker |
| AC9 | Skill state machine | explicit/automatic fixture | 两种 Skill 触发报告 | `fixture-skill@3` 与模型自动读取的 `zephyr-checksum` 均已入库 |
| AC10 | active Skill parentSpanId | Skill nested Tool/LLM test | Skill 子节点树 | automatic Skill 的 read Tool 与 LLM 子树已采集；自动 parentSpan 断言通过 |
| AC11 | Tool classifier | shell/file/MCP/search fixture | 标准任务五类 Tool | 模型真实调用 MCP Tool；夹具持久化 6 Tool，单一 provider 任务覆盖全部非 MCP Tool 类仍待验证 |
| AC12 | Tool start/end pairing | success/error/exit fixture | 参数、耗时、exit/error 样本 | openEuler 夹具持久化 6 Tool、1 error；配对自动断言通过 |
| AC13 | Tool owner resolver | parentSpan golden test | Agent-Tool 树 | openEuler 子树持久化，parentSpan 自动图校验通过 |
| AC14 | recursive redactor | credential corpus test | 去敏 spool 抽检 | 递归脱敏自动测试通过；2 个真实 spool 文件中 provider key 与 Agent Insight key 均 0 命中 |
| AC15 | assistant message LLM span | multi-provider fixture | 真实 LLM span | MiniMax-M3 四个真实任务 LLM span 与夹具 9 个 LLM call 均已持久化 |
| AC16 | Pi native usage mapping | exact usage test | 与 Pi usage 输出对照 | 基础真实任务六项 usage 精确一致：289 input/45 output/256 cache-read/0 cache-write/34 reasoning/590 total |
| AC17 | `model_select` handling | model switch test | 两模型真实会话 | 模型切换自动测试通过；两模型实测待验证 |
| AC18 | Unicode truncator | >2000 code point test | 超长 prompt/response 样本 | Unicode code-point 截断通过；真实超长样本待验证 |
| AC19 | MCP naming/metadata parser | MCP success fixture | MCP fixture extension 调用 | MiniMax-M3 真实调用 `mcp__fixture__lookup`，持久化 server `fixture` / tool `lookup` |
| AC20 | MCP error mapping | MCP failure fixture | error span | MCP 错误夹具通过；真实错误 span 待验证 |
| AC21 | timer + settled flush | fake timer/upload test | 会话结束 3 秒内请求 | settled flush 自动测试通过；openEuler 已上传，真实时延未单独计量 |
| AC22 | shutdown bounded flush | shutdown test | 退出前 checkpoint/spool 对照 | bounded shutdown 自动测试通过；openEuler 卸载保留 spool |
| AC23 | checkpoint + stable event ID | disconnect/replay test | 断网恢复且服务端无重复 | openEuler HTTP 500 时 checkpoint 不变，恢复上传 1，重放 0 |
| AC24 | exponential backoff | fake clock four-failure test | 500 注入重试时间线 | openEuler 500/恢复通过；四次退避时间线由 fake clock 覆盖 |
| AC25 | lazy extension startup | startup benchmark harness | 20 次 baseline/installed median/P95 | openEuler 20 次 median 529.952/534.719 ms，增量 4.767 ms |
| AC26 | no remote wait in prompt path | handler timing test | 30 次 TTFT 对照 | MiniMax-M3 30+30 次：median 2271.518/2326.948 ms，安装态增量 55.431 ms |
| AC27 | bounded buffers/timers | queue bound test | idle/active RSS 增量 | 61.2 秒匹配 RPC 进程稳态差分 1824 KB，11 点 baseline/installed growth 均 0 KB；非 V8 heap 归因 |
| AC28 | async I/O + cleanup | timer/lock leak test | 8 小时 soak 曲线 | soak harness 已实现；8小时实跑待验证 |
| AC29 | `pi remove` integration | settings removal test | 卸载后无新事件 | 真实 TTFT 完成后执行 remove，`pi list` 无 package 且无遗留 Pi 进程 |
| AC30 | purge-scoped cleanup | uninstall path safety test | 当前 key 目录与配置清理 | openEuler managed `uninstall.cjs --purge` 删除当前 key namespace，保留另一 key namespace |
| AC31 | framework path allowlist | negative path test | 其他 collector checksum 不变 | scoped purge 前后另一 key spool 与 Codex sentinel SHA-256 均不变 |
| AC32 | reinstall idempotency | install/remove/install test | 重装后新会话上报 | openEuler 重装 self-check 通过并新增持久化 session |
| AC33 | canonical six-kind batch | standardized fixture test | 标准任务完整报告 | 四个真实模型任务合计覆盖六类 Trace；公开接口夹具在单一标准批次覆盖六类并持久化 |
| AC34 | explicit parent graph validator | cycle/orphan validator test | 全图 0 orphan/0 cycle | 三层/五兄弟自动图校验通过；openEuler 持久化 root + 8 child |
| AC35 | leaf LLM token sum | exact token golden test | 与 Pi 内置 usage 误差计算 | 基础真实任务 Pi native/collector 六项 usage 逐项相等；夹具 token 也精确入库 |
| AC36 | deterministic structure projection | three-run snapshot test | 相同任务三次结构 diff | deterministic fixture通过；三次真实任务待验证 |
| AC37 | Pi Adapter | ExecutionRecord golden test | 服务端入库结果 | 真实模型隔离 SQLite 持久化 4 个 Execution；确定性 E2E 数据库另持久化 3 root 和 11 session |

真实模型、automatic Skill、MCP、单 SubAgent、native usage、30+30 次 TTFT 和短时
匹配进程 RSS 差分已闭合。三层/五同级 provider-backed SubAgent、第二真实模型、
真实 MCP error、三次真实任务结构 diff、V8 heap 归因和 8 小时 soak 仍保持为门禁。

## 4. 关键测试场景

### S1：断网与恢复

1. 启动本地 Agent Insight 并完成一轮基线上传。
2. 将 endpoint 切换为拒绝连接或返回 500。
3. 执行包含 LLM 与三个 Tool 的 Pi 会话。
4. 确认事件全部在 spool，checkpoint 未越过失败批次。
5. 恢复 endpoint，等待 uploader。
6. 确认所有事件一次入库，重复触发 uploader 后 interaction 数量不变。

### S2：三层与五并发 SubAgent

使用固定版官方 SubAgent 示例 fixture：

- chain 产生 A->B->C；
- parallel 一次产生 5 个结果；
- 每个结果内部至少有一次 LLM 和一次 Tool；
- graph validator 断言父节点存在、无环、子 ID 唯一。

### S3：Skill 与 MCP

- `/skill:fixture-skill arg` 验证 explicit。
- 普通 prompt 让模型读取 fixture `SKILL.md` 验证 automatic。
- fixture MCP Tool 命名为 `mcp__fixture__search`，分别返回成功和 error。
- Skill 内触发文件 Tool 和 MCP Tool，验证 parentSpanId。

### S4：卸载隔离

卸载前记录 `otel_data/opencode`、`claude`、`hermes`、`codex` 的目录列表和文件哈希；执行普通卸载
及 `--purge` 后，只有 Pi package/config 和当前 key 的 Pi spool 发生预期变化。

## 5. 提交拆分

1. `docs: design Pi Agent trace collector`
2. `feat(ingest): add shared durable trace transport`
3. `feat(pi): collect Pi agent trace events`
4. `feat(ingest): add Pi trace adapter and setup`
5. `test(pi): cover trace reliability and lifecycle`
6. `docs(pi): document install, uninstall, and verification`

每次提交只包含当前 issue 的文件，不混入 Codex collector。

## 6. 交付门

- `git diff --check`
- Pi 目标测试全部通过
- `npm run test`
- `npm run lint`
- `npm run build`
- openEuler 真实证据完整
- 37/37 AC 有明确结论；受上游能力限制的条目必须说明限制与替代接口
- PR 审核稿经用户确认并取得 `aaa` 后，才执行社区写操作
