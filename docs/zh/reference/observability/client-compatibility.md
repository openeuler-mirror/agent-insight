---
title: "客户端版本与框架兼容性"
description: "共享采集模块更新、框架安装差异与已验证范围。"
---

Pi Agent、Codex 和 Goal Plus 共用采集传输模块。重新安装时，已校验的官方旧版会先备份到
`$AGENT_INSIGHT_HOME/collectors/shared/*.bak` 再原子替换，同版本不重复备份。
若提示 `Refusing to overwrite a different shared collector module`，说明文件不是已知可升级版本；
请保留文件并核对本地改动，不要直接删除整个采集目录。共享模块冲突会在写入框架文件和配置前拦截。
选择 OpenCode 时，脚本通过 `opencode --version` 自动选择采集插件：1.x 使用原有插件接口，
2.x 使用原生插件定义和会话事件接口。请先安装 OpenCode 并确保命令在当前终端可用，再运行采集安装命令；
OpenCode 跨大版本升级或降级后，重新执行安装命令并重启 OpenCode。采集安装不修改模型 Provider、
模型地址或请求路由。

OpenCode 1.x 继续安装原有 TUI 附件和 Agent RAS，使用当前登录账号 API Key；
2.x 支持 Trace 采集和普通数据集「生成 Trace」，跳过不兼容的 1.x TUI 附件和 OpenCode RAS 插件。
生成 Trace 还需要常驻客户端注册成功、在线并发现可用 Agent；仅出现 `Telemetry: READY` 不代表这些条件已经满足。
更新服务端后，请重新执行当前账号的一键接入命令以更新常驻客户端，再刷新实验页面。
更新后的常驻客户端支持 OpenCode 1.x 与 2.x 的 Skill 冻结快照和只读触发分析（2.x 原生验证版本为 2.1.4）。
用例分析生成 Trace 和 A/B 测试需要客户端上报版本隔离能力；触发分析还需要只读路由能力。
若提示未上报能力，请更新并重启 Agent Insight 常驻客户端、等待能力重新上报，再刷新执行目标；仅升级 OpenCode 不会更新常驻客户端。
实验显示“等待 Trace 入库”表示 Agent 已结束但上传尚未完成；超过独立的 60 秒期限会明确报错，不会自动重跑 Agent。请检查采集器及上传日志，详见[用例分析](../../how-to/evaluation/skills/use-case-analysis.md)。
若从已安装 RAS 的 1.x 环境升级，安装脚本会检测全局插件目录及 `opencode.json` / `opencode.jsonc` 中的旧 RAS 引用，
发现残留时显示备份与迁移提示；`install-ras --check` 也会明确报告 OpenCode 2.x 不支持 RAS，而不会将其显示为已就绪。
旧文件和用户配置会保留：请先备份提示的 OpenCode 配置及插件目录，再移走 `plugins/agent-insight-ras.js`，
并从配置的 `plugin` 列表中移除对应条目；保留其他插件、模型和自行修改的 `ras-judge` Agent 配置。
项目内单独配置的旧 RAS 插件也需要按同样方式迁移。
之后重启 Agent Insight 只会同步平台地址，不会把客户端身份覆盖成内部 `admin` 账号。

2.x 已用 OpenCode 2.0.32 在 macOS ARM64 和本地模拟模型服务验证多次调用、并发子 Agent 与失败重试的
采集数据；普通数据集生成 Trace 已在 Linux/WSL 使用 1.14.39、2.1.4 和本地模拟模型验证执行、上传、Case 绑定、取消与失败回报。其他版本及 Windows 原生运行仍需对应环境验证；脚本的版本选择不等于所有版本均已实测。

你也可以选择 **OpenClaw**。安装脚本会生成一个同名命令包装函数，在调用原始 `openclaw` 命令时注入 OTel 环境变量；OpenClaw 仍直接访问自己的模型供应商，Agent Insight 只接收遥测数据，不代理模型请求。

如果使用 **AcTrail**，先自行完成 AcTrail 安装并启动守护进程，再在安装指导中选择 AcTrail，并于 AcTrail 所在的 Linux 环境运行页面生成的 curl 命令。脚本不会安装或包装 AcTrail，而是完成两项配置：合并更新 AcTrail 守护进程配置，启用完整请求、结构化工具调用、工具结果和子 Agent 关系；生成 `~/.agent-insight/actrail/otel-http.config.toml`，把平台地址和当前用户 API Key 配给官方 `otel-http` 插件。修改守护进程配置前，脚本会备份原文件；若守护进程正在运行则自动重启，然后持久化加载 `agent-insight.otel-http` 实例。之后继续使用原来的 `sudo actrailctl launch --name <名称> -- <Agent 命令>`，AcTrail 会自动上报。默认守护进程配置为 `/etc/actrail/actraild.conf`；非默认部署可在运行脚本前设置 `ACTRAIL_OPERATOR_CONFIG`、`ACTRAIL_PLUGIN_DIR`。

OTLP Logs 上报到 `/api/ingest/otel/v1/logs`，Traces 上报到 `/api/ingest/otel/v1/traces`；AcTrail 默认使用 OTLP/HTTP Protobuf。安装脚本末尾也会输出一份可手动复制的纯配置环境变量块。旧版 watcher 仅作为兼容方式保留；同一 OpenClaw 实例只能选择 OTel 或 watcher 其中一种，避免重复 Trace。

如果使用 **QwenPaw**，在安装指导中勾选 QwenPaw 并执行对应系统的一行命令。脚本会下载
`agent-insight-qwenpaw` collector zip，安装 Python 包，并把 `agent-insight-qwenpaw` 插件注册到
QwenPaw plugins 目录。安装后必须重启 QwenPaw；新建对话时会在链路追踪中生成一条 Trace，同一
对话继续提问会追加新的 USER 和 LLM/Tool 调用，新建对话才新增 Trace。详情页中的子 Agent 会按
`AGENT -> TASK -> AGENT` 树展示。完整说明见
[QwenPaw Trace Collector 接入指南](../../how-to/observability/qwenpaw-trace-collector.md)。

这些是安装行为和已有验证范围，不代表任意版本、操作系统或真实模型均通过验证。安装入口见[客户端安装](../../how-to/platform/settings/access-control.md)。
