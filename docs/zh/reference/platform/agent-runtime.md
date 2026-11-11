---
title: "Agent 运行时参考"
description: "平台内置 Agent 运行时的检测范围、状态与能力语义、HTTP 接口和执行入口约束。"
keywords: ["Agent 运行时", "运行时检测", "RUNTIME_SELECTION_UNAVAILABLE", "接口参考"]
changefreq: "monthly"
---

# Agent 运行时参考

操作步骤见[Agent 运行时操作指南](../../how-to/platform/settings/agent-runtime.md)。

## 检测范围

检测对象是**平台服务进程**可访问的部署环境，覆盖 `PATH` 和以下覆盖变量：

| 运行时 | 环境变量 | 附加候选 |
|-|-|-|
| OpenCode | `OPENCODE_BIN` | `<package-root>/node_modules/.bin/opencode` |
| Pi | `AGENT_INSIGHT_PI_EXECUTABLE`、`PI_EXECUTABLE` | — |

探测命令固定为 `<executable> --version`，参数不可配置，默认 3 秒超时。检测不调用模型、不安装或升级依赖。结果在进程内缓存 30 秒。

- Windows 上 `PATH` 查找会按 `PATHEXT` 补全扩展名（含 npm 生成的 `.cmd` 垫片）。`.cmd` / `.bat` 无法直接 spawn，因此经 `cmd.exe /d /s /c` 引导执行；命令行仍是固定字面量，不拼接调用方输入。
- 其他平台直接以 `shell: false` 启动可执行文件。

## 状态

| 状态 | 是否可选 | 含义 |
|-|-|-|
| `available` | 是 | 适配器已交付、版本兼容 |
| `not-installed` | 否 | 部署环境找不到可执行文件 |
| `probe-failed` | 否 | 版本探测失败、超时或输出无法解析 |
| `incompatible-version` | 否 | 版本低于最低要求 |
| `adapter-missing` | 否 | 版本兼容，但平台没有执行适配器 |

最低版本：Pi `0.82.1`，OpenCode `1.0.0`。

## 能力

能力由适配器声明，不从 CLI 参数推断。没有适配器时所有能力均为否。

| 能力 | 含义 |
|-|-|
| `tool-policy` | 可下发工具禁用、只读、白名单等策略 |
| `session-resume` | 可跨轮次续接原生会话 |
| `cancel` | 支持服务端确认式取消 |
| `timeout` | 支持任务级超时与异常退出回收 |
| `skill-loading` | 可加载平台部署的 Skill |
| `trace-attribution` | 执行事实可归入平台 Trace |

## 个人默认值

保存在 `UserSettings.settingsJson.agentRuntimeId`，不需要数据库迁移。

- 未保存：按目录顺序选择第一个可选（`selectable`）运行时，`source = platform-default`。
- 已保存且可用：`source = user`。
- 已保存但不可用：`status = unavailable`，`effectiveId = null`，不回退。
- 保存值未知：`status = unavailable`，诊断码 `RUNTIME_SELECTION_INVALID`。

默认值只影响新任务和新会话；历史 Execution、Session 和进行中任务保持原绑定。

## HTTP 接口

两个接口都会先解析请求身份：请求携带可解析的凭据身份（`x-witty-api-key` 或 `apiKey`）时，`user` 必须与之一致，否则返回 `403`；未携带凭据身份的部署继续沿用 `user` 参数。

### `GET /api/agent-runtime`

查询参数：`user`（身份解析，见 [HTTP 接口与用户身份](./http-api.md)）、`refresh=1`（强制重新检测）。

```json
{
  "checkedAt": "2026-11-09T00:00:00.000Z",
  "runtimes": [
    {
      "id": "opencode",
      "label": "OpenCode",
      "adapter": { "id": "opencode-general-agent", "label": "OpenCode 通用 Agent", "capabilities": { "...": true } },
      "executable": { "path": "/opt/opencode/bin/opencode", "source": "environment" },
      "version": "1.1.39",
      "minimumVersion": "1.0.0",
      "status": "available",
      "selectable": true,
      "capabilities": { "tool-policy": true, "...": true },
      "diagnostics": [{ "code": "RUNTIME_READY", "message": "OpenCode 1.1.39 可用于平台任务。" }],
      "checkedAt": "2026-11-09T00:00:00.000Z"
    }
  ],
  "preference": {
    "selectedId": null,
    "effectiveId": "opencode",
    "source": "platform-default",
    "status": "ready",
    "runtime": { "...": "与 runtimes 中相同结构" },
    "diagnostic": null
  }
}
```

### `PUT /api/agent-runtime`

请求体：`{ "user": "<user>", "runtimeId": "opencode" }`。`runtimeId` 为 `null` 时清除个人默认值。

写入前重新检测并校验。运行时未知或不可选择时返回 `409`：

```json
{
  "error": "Pi 当前不可用于平台任务。",
  "code": "RUNTIME_SELECTION_UNAVAILABLE"
}
```

## 执行入口

平台内置任务统一从 `runGeneralAgent` 进入执行层。入口在每次新任务开始时读取个人默认值：

- 未保存或为 `opencode`：沿用现有 OpenCode 执行路径。
- 为其他值：返回 `AGENT_RUNTIME_UNAVAILABLE`，不静默换引擎。

Pi 执行适配器交付后，入口内部按适配器分派，业务模块无需改动。
