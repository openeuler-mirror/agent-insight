# Agent 运行时切换需求设计

## 分层

```text
页面 / API（本阶段）
        |
运行时探测 + 能力判定（本阶段）
        |
个人默认值（UserSettings JSON，本阶段）
        |
统一执行服务 → 任务宿主与能力检查 → OpenCode / Pi 适配器（后续阶段）
```

本阶段只实现上半部分。执行层不在业务模块里增加运行时分支；后续统一由执行服务按选中的运行时
调用适配器。

## 运行时定义

每个运行时由一份静态定义描述：

| 字段 | 说明 |
| --- | --- |
| `id` | 稳定标识，用于保存偏好与 API 契约 |
| `envVar` | 部署侧覆盖可执行文件路径的环境变量 |
| `bundledRelativePath` | 随包安装的相对路径 |
| `command` | PATH 上的命令名 |
| `versionArgs` | 读取版本号的参数 |
| `minimumVersion` | 最低兼容版本；高于基线按语义版本放行 |
| `capabilities` | 适配器实际提供的能力 |
| `adapterAvailable` | 平台是否已提供执行适配器 |

首批定义：

- **OpenCode**：`OPENCODE_BIN` → 安装根 `node_modules/.bin/opencode` → `PATH`；最低版本
  1.14.30（与 `@opencode-ai/sdk` 一致）；适配器已提供。
- **Pi**：`AGENT_RUNTIME_PI_BIN` → 安装根 `node_modules/.bin/pi` → `PATH`；最低版本
  0.82.1（与 Pi Trace 采集器基线一致）；适配器尚未提供。

显式配置的路径不存在时直接返回 `CONFIGURED_PATH_MISSING`，不静默回落到 PATH，避免部署方
误以为配置生效。

## 探测

- 只读取当前服务进程的 `fs`、`PATH` 和环境变量。
- 版本号通过 `<executable> --version` 获取，单次超时 3 秒；异常、非零退出或超时一律视为
  版本不可读。
- 结果缓存 30 秒；页面「重新检测」带 `refresh=1` 绕过缓存。并发请求复用同一个进行中的探测。
- 探测不执行任务、不调用模型、不安装依赖。

## 可用性判定

```text
usable = installed && compatible && adapterAvailable
```

不可用原因按优先级只保留第一条：

1. `CONFIGURED_PATH_MISSING`：显式配置路径不存在；
2. `NOT_INSTALLED`：未找到可执行文件；
3. `VERSION_UNREADABLE`：无法读取版本号；
4. `INCOMPATIBLE`：低于最低版本；
5. `NO_ADAPTER`：找到可执行文件，但平台没有执行适配器。

未适配的运行时不展示能力列表，避免把「文件存在」误读成「能力可用」。

## 数据与契约

不修改 Prisma schema。个人默认值保存在既有 `UserSettings.settingsJson`：

```json
{ "agentRuntime": { "defaultRuntimeId": "opencode" } }
```

- 读取时校验结构，非法值按「无偏好」处理。
- 模型注册与联网搜索页提交完整 settings 时，持久化逻辑保留已有的 `agentRuntime`，避免偏好被
  整份表单覆盖。
- 运行时偏好使用独立的读改写路径，与 settings 全量写入共用同一串行化队列。

## API

`GET /api/agent-runtimes?user=<user>&refresh=1`

返回：

```json
{
  "runtimes": [
    {
      "id": "opencode",
      "displayName": "OpenCode",
      "installed": true,
      "version": "1.14.39",
      "executable": "/app/node_modules/.bin/opencode",
      "source": "bundled",
      "minimumVersion": "1.14.30",
      "compatible": true,
      "adapterAvailable": true,
      "usable": true,
      "capabilities": ["session", "tools", "skills"],
      "unavailableReason": null
    }
  ],
  "checkedAt": "2026-11-09T00:00:00.000Z",
  "defaultRuntimeId": "opencode",
  "selection": { "runtimeId": null, "usable": false, "reason": null }
}
```

`PUT /api/agent-runtimes`，body `{ "user": "...", "runtimeId": "opencode" | null }`。

- `runtimeId=null` 清除个人偏好。
- 未知运行时返回 400 `INVALID_RUNTIME`；不可用运行时返回 409 `RUNTIME_UNAVAILABLE` 并携带
  结构化原因。不可用值不会被保存，也不存在自动回退。

## 页面

配置 → Agent 运行时：

- 列出部署环境中的运行时、版本、来源、可执行路径、能力与不可用原因；
- 「重新检测」触发强制探测；
- 可选择「平台默认」或任一可用运行时并保存；
- 不可用运行时不可选；
- 明确提示容器内结果不代表宿主机、可执行文件不等于执行能力、保存只影响新任务和新会话。

## 与执行层的关系

本阶段不改变 `runGeneralAgent` 的行为。阶段二引入执行服务后，运行时偏好才参与执行选择；
执行前仍需重新检查安装、版本与能力，不能因为保存时可用就跳过检查。
