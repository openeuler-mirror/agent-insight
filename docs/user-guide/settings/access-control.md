---
title: "安装指导"
description: "为 AcTrail 配置 Agent Insight 链路上报"
---

# 安装指导

安装指导页面只提供 **AcTrail** 接入方式。它会生成带当前平台地址和 API Key 的配置命令，让已安装的 AcTrail 通过官方 `otel-http` 插件向 Agent Insight 上报链路数据。

> **Note**
> Agent Insight 不安装或包装 AcTrail。开始前请先安装并启动 AcTrail，并确认官方 `otel-http` 插件可用。

## 页面结构

页面包含三个区域：

1. **AcTrail 接入命令**
   提供在 Linux / WSL 中执行的一键命令。
2. **凭证与接入信息**
   展示当前账号、API Key、平台地址和 OTLP traces 上报路径。
3. **相关文档**
   提供使用手册及接入排障入口。

页面生成的命令固定选择 `actrail`，不会进入其他框架的交互式安装流程。

## 接入前提

执行命令前确认：

- `actraild` 已安装并运行
- AcTrail 官方 `otel-http` 插件存在
- 当前终端位于 AcTrail 实际运行的 Linux / WSL 环境
- 当前登录账号和页面右侧 API Key 归属一致

Windows 用户应进入安装 AcTrail 的 WSL 发行版后执行页面中的 Unix 命令，不要直接在 PowerShell 中执行。

## 操作流程

1. 进入 **配置 → 安装指导**。
2. 确认右侧账号、API Key 和平台地址。
3. 复制 **Linux / WSL** 命令。
4. 在 AcTrail 所在环境执行命令。
5. 脚本生成 `~/.agent-insight/actrail/otel-http.config.toml`，并通过 `actraild plugin load --persist` 加载 `agent-insight.otel-http` 实例。
6. 继续使用原有命令启动 Agent：

   ``bash
   sudo actrailctl launch --name <名称> -- <Agent 命令>
   ``

7. 进入 [链路追踪](../observability/view-traces) 确认新的 Trace。

AcTrail 使用 `/api/ingest/otel/v1/traces` 上报 protobuf OTLP traces，并在请求中携带当前用户的 API Key。

## 非默认安装目录

默认情况下，安装脚本查找：

- AcTrail operator 配置：`/etc/actrail/actraild.conf`
- 官方插件：`~/.actrail/plugins/otel-http/`、`/usr/share/actrail/plugins/otel-http/` 或 `/etc/actrail/plugins/otel-http/`

使用非默认目录时，在执行页面命令前设置：

```bash
export ACTRAIL_OPERATOR_CONFIG=/path/to/actraild.conf
export ACTRAIL_PLUGIN_DIR=/path/to/plugins
```

## 常见异常

### 未找到 actraild

确认 AcTrail 已安装，并确保 `actraild` 位于 `PATH`；也可以通过 `ACTRAILD_BIN` 指定可执行文件。

### 未找到 otel-http 插件

升级或重新安装包含官方 `otel-http` 插件的 AcTrail，或通过 `ACTRAIL_PLUGIN_DIR` 指定插件目录。

### 配置完成但没有 Trace

依次检查：

1. `agent-insight.otel-http` 插件实例是否已加载
2. AcTrail 所在环境能否访问页面显示的平台地址
3. API Key 是否属于当前登录账号
4. 是否使用 `actrailctl launch` 触发了一次真实 Agent 执行
5. `/api/ingest/otel/v1/traces` 是否可达

## 下一步

- 完成 Agent 资产登记： [Agent 管理](../agent-management)
- 验证链路是否成功上报： [链路追踪](../observability/view-traces)
- 继续完成整体接入流程： [5 分钟上手](../quickstart)
