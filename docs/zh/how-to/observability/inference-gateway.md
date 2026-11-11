---
title: "显式接入模型转发与推理分析"
description: "为 OpenCode 和 Qoder CN CLI 显式配置本地模型转发，关联 Trace 与推理请求。"
---

# 显式接入模型转发与推理分析

采集插件安装与模型转发分别启用。平台的 curl 安装命令会在客户端准备转发组件，但不会改写模型地址。未执行下述命令时，原有采集和模型连接方式保持不变。

## 1. 安装采集组件

在运行 Agent 的客户端，从平台「客户端安装」页获取并执行对应命令。Unix/macOS/Linux 客户端需要 curl、sh 和 Node.js 20+。转发进程运行在客户端，只监听 `127.0.0.1`，无需在平台服务器开放模型代理端口。Windows 暂未提供此 Shell 接入流程。

转发组件是可选项。其下载或准备失败只会告警，不会中断采集安装；组件下载设置了连接和总时限。出现告警后可照常使用原有采集，待平台连接恢复后重新安装，再按需显式启用模型转发。

## 2. 显式配置模型转发

关闭 Agent，在使用该 Agent 的项目目录运行：

```sh
sh ~/.agent-insight/model-proxy.sh opencode
# 或 Qoder CN CLI
sh ~/.agent-insight/model-proxy.sh qoder
# 两种同时配置
sh ~/.agent-insight/model-proxy.sh opencode,qoder
```

自定义了 `AGENT_INSIGHT_HOME` 时用对应目录替换 `~/.agent-insight`。命令会先备份配置，登记原始模型服务地址，启动本地转发进程，再将支持的 base URL 替换为本地地址；凭据仍由 Agent 原配置提供。终端会打印每份配置的备份位置及未支持的字段。备份可能包含模型密钥，请按凭据文件保管。

- `original.jsonc`：首次配置的原件，后续不覆盖。
- `latest.jsonc`：保留用户后续配置变更，同时将已接管地址还原为其原始上游地址，便于人工恢复。

OpenCode 1.x 处理 `provider.*.options.baseURL`，2.x 处理 `providers.*.settings.baseURL`。支持 OpenAI compatible、OpenAI Responses 和 Anthropic Messages 的 HTTP 接口；默认内置 Provider、没有显式 URL、远程配置、仅内存配置和显式 WebSocket 等非 HTTP 传输不会自动接管。OpenCode 全局配置、自定义配置路径及当前项目祖先目录中的配置按命令实际报告为准。

Qoder CN CLI 处理 `providers.*.baseUrl`，支持显式的 OpenAI/Anthropic compatible Provider。使用自定义配置目录时传递相同参数，例如：

```sh
sh ~/.agent-insight/model-proxy.sh qoder --config-dir /path/to/qoder-config
```

Qoder Desktop、JetBrains 插件仍可采集，但其自定义模型地址接入与响应 ID 未验证，本功能不会改写其数据库、插件 XML 或可执行文件。

## 3. 重启 Agent 并使用

同一 Provider 下切换模型仍走同一已配置入口。新增 Provider、更换上游地址或增加项目配置后，重新执行第 2 步；命令会识别已接管地址，不会把代理地址再次登记为上游，并更新最新备份。没有后台扫描自动接管新模型。

OpenCode 启动/请求钩子可按已登记地址重启转发进程；手动停止后，当前会话下一次请求或重启 OpenCode 可重新拉起。Qoder CN CLI 无自动启动钩子，重启机器或手动停止进程后，先重新执行显式配置命令，再运行 CLI。

若需停用，关闭 Agent，将终端打印的 `latest.jsonc` 人工恢复到对应配置文件，核对近期修改后重启 Agent。没有自动卸载或回退命令；已有 Trace 数据不受此配置操作影响。

## 4. 配置推理页面入口

在平台进程或容器环境中设置：

```sh
AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN=http://192.0.2.20:8080
```

只填协议、主机和端口，修改后重启平台；无需重建前端。未配置时仍可查看关联 ID。打开「链路追踪」详情中的「推理分析」可查看整条 Trace 的请求列表；LLM 节点详情中的同名按钮只列出该节点的已确认请求。每个链接传递单个 ID：`/model-performance?GlobalTrackNO=<X-Request-Id>`，重试分别保留。

Qoder CLI 的成功响应通过会话及唯一服务响应 ID 回填 LLM；失败、缺失或重复响应 ID 无法证明节点归属时，仅列入整条 Trace，不按时间猜测。OpenCode 用原生会话、消息及 HTTP attempt 证据关联，缺失或冲突证据同样只保留 Trace 关联。历史无网关 ID 的 Trace 不会补造 ID。

推理服务接收方式及失败边界见 [统一推理请求关联契约](../../reference/observability/inference-correlation.md)。
