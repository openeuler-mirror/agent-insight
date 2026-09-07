# WorkBuddy Trace 采集开发计划

> 需求背景与数据源结论见 [`phase1-requirements-analysis.md`](phase1-requirements-analysis.md)；架构与详细设计见 [`phase2-requirements-design.md`](phase2-requirements-design.md)。

## 本次实现范围

已落地（代码 + 测试，随仓库提交）：

- 客户端映射 `scripts/workbuddy-collector/mapper.cjs`（纯函数，已用 9 条真实 trace 验证：逐轮精确 token 提取、function 工具映射、mcp_tools 噪声剔除、OTLP 往返 `service.name=workbuddy` 与 `llm.token_count.*` 正确）。
- 客户端 `session-registry.mjs`（pid→sessionId 缓存 + 宽限期）、`collector.mjs`（文件监听 + D4 只读富化 + 单实例锁 + 触发上传）、隐藏窗口启动器 `collector-launcher.vbs`。
- 独立 Windows 安装器 `scripts/workbuddy_setup.mjs`（Task Scheduler 登录触发 + 失败自动重启 + `--status`/`--uninstall`），已实现"免手动启动"端到端能力；采集器运行时复用 WorkBuddy 自带 Electron（`ELECTRON_RUN_AS_NODE=1`），**用户无需单独安装 Node.js**（已实测 WorkBuddy.exe 可执行本方案的 ESM/CJS 脚本）。
- 服务端 `src/lib/ingest/otel/adapters/workbuddy.ts` + 注册表接入。
- 测试 `test/workbuddy-collector.test.ts`（mapper 单测 + 全链路往返 + 多轮归并 + 无 usage 不编造 + 工具就近归属 + Agent 命名 + 完成状态 + 子 Agent 命名 + 路径保留/密钥脱敏 + latency 毫秒）。

真机反馈迭代修复（均已落地）：

- **Agent 命名**：内部根 Agent 名 `cli`/`terminalTitleGenerator` 归一化为产品名 `WorkBuddy`。
- **工具顺序**：WorkBuddy 的 function/generation span 平级挂在 agent 下、工具与 LLM 无父子链；改为**按时间就近归属**（工具挂到开始时间在它之前的最近一次 LLM），修复"LLM 全堆一起、Tool 全堆一起"。
- **执行状态**：设 `trace_completed_at` + `trace_status='success'`，详情页从"执行中"变为"已完成"。
- **子 Agent**：WorkBuddy 用名为 `Agent` 的工具（参数带 `subagent_type`/`prompt`）派发子 Agent。曾尝试归一化为平台 `task` + 合成子 Agent 节点，但子 Agent 跑在独立 worker、内部链路 WorkBuddy 未落盘，合成的节点只是无内容的叶子、反而与父 TOOL 重名易混淆；最终**回退为按普通 TOOL 节点显示**（名为 `Agent`，参数与子 Agent 报告照常保留），符合 WorkBuddy 的实际模型。
- **文件路径保留**：共享 transport 增 `redactLocalPaths` 开关（默认不变），WorkBuddy 关闭本地路径脱敏 → 保留 Read/Write/Edit/Bash 的真实文件路径；密钥/token/邮箱仍脱敏。
- **标题生成器 trace 跳过**：纯 `terminalTitleGenerator` 的内部 trace 不上报（消除 `<session>…</session>` 污染的 USER 节点，并少传约 1/3 噪声）。
- **latency 单位**：改回毫秒（去掉误加的 `/1000`），详情页"耗时"与链路树根节点一致。
- **免装 Node + 自愈**：安装器/启动器复用 WorkBuddy 自带 Electron（`ELECTRON_RUN_AS_NODE=1`）；启动器 `.vbs` 阻塞等待采集器 + `WScript.Quit(code)`，使 Task Scheduler 状态正确显示 Running 且 `RestartOnFailure` 崩溃自愈真正生效。
- **安装输出**：安装器输出全 ASCII（消除 node 在 GBK 控制台的乱码）；安装完成后打印可直接复制的免 Node 管理命令（启动/停止/状态/是否在跑/卸载，停止用 `schtasks /end`）；一键脚本汇总块补上 WorkBuddy 组件/用法行。

一键安装入口接入（已补做）：

- 前端安装页 `src/app/(main)/accessconfig/install/page.tsx` 的 `FRAMEWORK_OPTIONS` 末尾追加 `workbuddy`，安装界面出现 WorkBuddy 复选项。
- `src/app/api/ingest/setup/route.ts`（curl/PowerShell 一键脚本）与 `src/app/api/ingest/setup/auto/route.ts`（`npx agent-insight install`）：均按「末尾追加、不改已有顺序」规则加入 `workbuddy` 到 FRAMEWORKS 白名单、交互选择器、INSTALL 标志与「未选择」守卫；PowerShell 侧新增下载采集器文件并调用 `workbuddy_setup.mjs` 的安装块；Unix/bash 侧因 WorkBuddy 是 Windows 桌面应用只打印「请在 Windows 运行」提示。
- 新增文件分发路由 `src/app/api/ingest/setup/workbuddy-collector/[file]/route.ts`，白名单分发 `workbuddy_setup.mjs` / `collector.mjs` / `session-registry.mjs` / `mapper.cjs` / `trace-transport.cjs`，下载后按 `workbuddy_setup.mjs` 期望的目录布局落地。
- `src/lib/ingest/framework-reporting-channels.ts` 标注 WorkBuddy 走 OTLP Traces 通道。

后续：

- CI 环境跑通 TS 测试套件与 setup 契约测试（本地开发机无 Node/依赖，纯 JS 管线已用 Electron-as-node 验证，服务端 adapter 全链路往返已在 WSL 真实 Node 环境验证通过）。

## 开发步骤

1. 落地纯映射逻辑 `scripts/workbuddy-collector/mapper.cjs`：span → canonical event（`agent`/`generation`/`function` 三类有效 span，`custom`/`mcp_tools` 噪声跳过），从 `generation.toolOutput` 解析精确 usage 与 model，先用真实 trace JSON 样本跑通单测，不接文件监听。
2. 实现 `scripts/workbuddy-collector/session-registry.mjs`：订阅 `sessions/*.json`，维护 pid→sessionId 缓存 + 宽限期淘汰，覆盖"心跳先于 trace 消失"的乱序场景。
3. 实现 `scripts/workbuddy-collector/collector.mjs`：Trace Watcher（监听 `traces/**/*.json`）+ Enricher（D3 增量读取、D4 只读查询）+ Canonical Mapper，接入第 1 步的转换函数；加上单实例 lock 文件保护。
4. 接入共享 spool/uploader（`trace-transport.cjs` 里的 `DurableTraceWriter`/`DurableTraceUploader`），落盘到 `~/.agent-insight/otel_data/workbuddy/<apiKeyHash>/`。
5. 实现 `src/lib/ingest/otel/adapters/workbuddy.ts`（`matches`/`aggregate`）并注册进 `src/lib/ingest/otel/adapter-registry.ts`，测试在 `test/workbuddy-collector.test.ts`。
6. 实现 Windows 安装器 `scripts/workbuddy_setup.mjs`：探测 WorkBuddy 安装 → 落地采集器脚本与配置 → 生成任务定义 XML 并 `schtasks /create` 注册（`LogonTrigger` + `RestartOnFailure`）→ 立即 `schtasks /run` 启动一次 → `--status`/`--uninstall` 子命令；配套隐藏窗口启动器 `collector-launcher.vbs`（阻塞等待采集器 + `WScript.Quit(code)`，让 RestartOnFailure 能盯到崩溃）。
7. 按 `docs/developer-guide/09-trace-collector.md` 的追加式规则，在 `setup/route.ts` 和 `setup/auto/route.ts` 的框架列表末尾接入 WorkBuddy 选项。
8. 真实环境验收：连续开关 WorkBuddy 会话做时序压测（验证心跳/trace 乱序处理）、模拟 WorkBuddy 版本升级改变 D1～D5 字段（验证降级不抛错）、杀死采集器进程验证 Task Scheduler 自动重启、重启电脑验证登录自动拉起。
9. 补充用户接入指南到 `docs/user-guide/`，说明装完自动开机启动、无需手动运行。

## 风险与待验证项

| 风险点 | 说明 | 应对 |
|---|---|---|
| trace 文件写入原子性未做压测验证 | 目前观察到的样本都是完整文件，但没有在高并发/大 trace 场景下验证过是否可能读到半截文件 | 读取前判断 mtime 静默 200ms 再解析；JSON.parse 失败时延迟重试而不是丢弃 |
| 心跳文件清理时机 | 已用"缓存 + 宽限期"缓解，但没有在真实"秒级连续开关会话"场景下压测过 | 上线前用脚本连续快速开关会话做一次时序压测（见开发步骤 8） |
| SQLite 读写并发 | WAL 模式下理论上读写不互斥，但高频只读查询仍可能短暂拿不到锁 | 短超时 + 跳过本次关联，不做阻塞重试 |
| 版本升级导致 schema/日志格式变化 | D1～D4 全部是闭源内部实现，不是公开 API，作者可能随时改格式 | 所有解析点做防御式处理：字段缺失时降级而不是抛异常；D5 迁移文件可用于探测 schema 版本 |
| Token 语义混淆 | 逐轮精确拆分（generation.toolOutput.usage）与会话级占用快照（SQLite）是两个维度，易被展示层混为一谈 | 两维度分开字段、分开标注；无数据留空不估算，不用会话总量反推逐轮值（见 phase2 §4.3） |
| 隐私/合规 | trace 文件的 `toolInput` 含完整 system prompt 和用户对话原文 | 上传前做内容长度截断 + 敏感信息脱敏（沿用平台已有的脱敏规范），并确认这批数据的采集范围获得了必要授权 |
| 采集器自身可靠性 | 无 Hook 触发，采集器是独立常驻进程，进程本身若崩溃需要能自愈 | Task Scheduler 登录触发 + `RestartOnFailure`；**关键前提**：启动器 `.vbs` 必须阻塞等待采集器（`Run(...,0,True)` + `WScript.Quit(code)`），否则 wscript 秒退、采集器脱离，RestartOnFailure 盯不到崩溃、状态永远 Ready（详见 phase2 §3） |
| Task Scheduler 触发时机与 WorkBuddy 启动顺序无关 | 登录触发的任务不保证 WorkBuddy 已经启动，采集器需要能在 WorkBuddy 还没打开时安静空跑，不报错 | 用 `fs.watch` 监听目录本身即可，目录/文件不存在时降级为等待重试，不依赖 WorkBuddy 进程存在 |

## 落地文件清单

| 阶段 | 工作项 | 位置 |
|---|---|---|
| 客户端 | Session Registry（pid→sessionId 缓存+宽限期） | `scripts/workbuddy-collector/session-registry.mjs` |
| 客户端 | Trace Watcher + Enricher + Canonical Mapper | `scripts/workbuddy-collector/collector.mjs` |
| 客户端 | 复用共享 spool/uploader | 直接引用 `scripts/agent-trace-collectors/shared/trace-transport.cjs` |
| 客户端 | 单实例 lock 文件保护 | `scripts/workbuddy-collector/collector.mjs` 启动时检查 |
| 安装 | Windows 安装器：落地脚本+配置+注册 Task Scheduler+立即启动+`--status`/`--uninstall` | `scripts/workbuddy_setup.mjs` |
| 安装 | 隐藏窗口启动器 | `scripts/workbuddy-collector/collector-launcher.vbs` |
| 安装 | 接入一键安装入口（末尾追加，不改动已有顺序） | `src/app/api/ingest/setup/route.ts`、`src/app/api/ingest/setup/auto/route.ts` |
| 客户端 | 文件分发路由（一键安装下载采集器文件） | `src/app/api/ingest/setup/workbuddy-collector/[file]/route.ts` |
| 服务端 | 新增 Adapter | `src/lib/ingest/otel/adapters/workbuddy.ts` |
| 服务端 | 注册 Adapter | `src/lib/ingest/otel/adapter-registry.ts` |
| 服务端 | 路径脱敏开关（保留文件路径） | `scripts/agent-trace-collectors/shared/trace-transport.cjs`（`redactLocalPaths`） |
| 服务端 | 上报通道标注 | `src/lib/ingest/framework-reporting-channels.ts` |
| 服务端 | 单元测试 | `test/workbuddy-collector.test.ts` |
| 文档 | 用户接入指南 | `docs/user-guide/observability/workbuddy-trace-collector.md` |
