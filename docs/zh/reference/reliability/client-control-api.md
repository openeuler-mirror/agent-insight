---
title: "可靠性客户端与配置控制接口"
description: "安装令牌、设备身份、能力上报、配置快照和控制通道的 HTTP 契约。"
---

本页说明 `/api/reliability/` 下现有 HTTP 方法及 `/api/agent-ras/config`、`/api/agent-ras/catalog`。基线为 `eabde5b0`。配置保存、通知、写入和 RAS 加载是不同阶段；接口成功不能直接解释为配置已生效。安装操作见[本机安装过程](../../how-to/reliability/agent-ras/local-install-process.md)，平台身份解析见 [HTTP 接口与用户身份](../platform/http-api.md)。

故障注入任务创建、停止、重跑和旧 Worker 的 `/api/fault-injection/` 接口不属于本页覆盖范围，参见[执行故障注入](../../how-to/reliability/agent-fault-injection/run-injection.md)。RAS 事件接入也不是本页的客户端控制协议。

## 身份与凭证

| 调用方 | 凭证与边界 |
| --- | --- |
| 平台用户 | 列表、安装令牌和客户端配置采用 `resolveUser`；非空显式 `user` 可优先于 Key，因此它是兼容身份选择，不是凭证验证。集成应带 `x-witty-api-key`，避免再传覆盖身份的 `user` |
| 安装器 | 注册体中的一次性 `installToken`。默认 600 秒，`expiresInSeconds` 被限制到 60～3600 秒；已使用返回 `409`，过期返回 `410`，无效返回 `401` |
| 已注册设备 | `Authorization: Bearer <deviceCredential>`；HTTP 设备接口可额外带 `x-agent-insight-client-id`，与凭证归属不匹配返回 `403`。凭证只在注册响应中返回，数据库保存哈希；实现未设置固定到期时间，撤销或重新注册轮换后旧凭证不可用 |
| 控制服务内部调用 | `x-agent-insight-internal` 匹配 `AGENT_INSIGHT_INTERNAL_TOKEN`（未配置时为 `local`），用于三个 `control-*` 桥接接口；不是用户 Key 或设备凭证，错误返回 `403 INTERNAL_ONLY` |

这里没有可替代上述身份的通用 `controlToken` 请求字段。WebSocket 握手必须同时携带设备 Bearer 和 `x-agent-insight-client-id`；普通 HTTP 设备接口中的可选头约定不能套到握手上。

## 平台查询与安装

| 方法与路径 | 输入 | 成功响应与限制 |
| --- | --- | --- |
| `GET /api/reliability/clients` | 查询 `page` 默认 1、`pageSize` 默认 20 且限制 1～100；可选 `status`、`keyword`、兼容 `user` | `200 { items, page, pageSize, total }`。合并注册客户端与旧 FI Worker，去重并按 `lastSeenAt` 倒序；条目有 `id`、主机/IP、`status`、`serviceHealth`、平台能力、`legacy`、`controlChannel` 等。当前实现先取最多 100 个注册客户端再合并旧 Worker，`total` 是该合并集合大小，不能视为无限量的注册表总数 |
| `POST /api/reliability/install-tokens` | JSON 可含 `name`、`platform`、`expiresInSeconds`、兼容 `user` | `201 { installToken, expiresAt, user, commands: { unix } }`；令牌用于下一步注册，安装命令中的服务地址来自请求/转发头 |
| `GET /api/reliability/config-schemas/:platform` | `platform` 为 `opencode/openjiuwen/xiaoo` | `200` 内置 Schema：`schemaVersion/platform/configVersion/defaults/sections/editable/source/updatedWithProductVersion`；`editable: false`、`source: builtin`。无用户鉴权，未知平台 `404 PLATFORM_SCHEMA_NOT_FOUND` |
| `GET /api/reliability/fault-modes` | 可选查询 `platform` | `200 { items, registryVersion }`。条目含 `id/name/description/supportedPlatforms/parameters/submodes` 及可选注入方式字段；未知平台为空集合。路由调用用户解析但不拒绝空身份，不能据此验证 Key |

列表和令牌在无法解析用户时返回 `401`。客户端在线窗口默认 90 秒，可用 `AGENT_INSIGHT_RAS_CLIENT_ONLINE_SEC` 调整，最小 30 秒；服务健康与在线状态是两个字段。`controlChannel: none` 不等于无法收命令：新鲜心跳的客户端仍可长轮询。

## 设备注册、心跳和能力

以下设备路径的前缀为 `/api/reliability/client/v1`。

| 方法与路径 | JSON 输入 | 成功响应 |
| --- | --- | --- |
| `POST /register` | 必填 `installToken`；可选 `client: { name, hostname, ip, os, arch, agentVersion, supervisor, machineId }`、`capabilities`、`previousClientId` | `201 { clientId, user, deviceCredential, unboundPrevious, reused, control }`。`control` 包含 `websocketUrl/pollUrl/heartbeatIntervalSeconds/ackTimeoutSeconds` |
| `POST /heartbeat` | 可选 `agentVersion`、`status`，`service: { processStartedAt, supervisor, watchdog, restartCount }` | `200 { serverTime, nextHeartbeatSeconds, refreshCapabilities }`；只更新在线度与健康度，不携带命令。默认窗口下建议间隔 30 秒 |
| `PUT /capabilities` | 可选 `revision`、`partial`、`hostname/reportedIp/os/arch`；能力字段 `platforms/actions/components/executionProfiles/faultInjection` | `200 { acceptedRevision, serverTime }`。同一非空 revision 重放不更新；`partial: true` 合并能力，其他情况归一化替换。并发合并冲突可返回 `409 CAPABILITIES_UPDATE_CONFLICT` |

除注册外，本节要求设备凭证。`observedIp` 由连接地址推导，请求体不能覆盖。平台能力条目可含 `id/version/models/agents/actions`、`runExperimentCase`、`runBenchmarkCase` 和参数定义；`faultInjection` 中 `ready: false` 表示该能力不可用，不等于整个客户端无法上线。

同一用户和 `machineId` 再次注册会复用客户端记录，并撤销旧设备凭证后换发新凭证。传入需改绑的 `previousClientId` 时，旧记录会标记解绑、撤销其凭证，并保留历史记录；安装令牌消耗和注册/改绑在同一事务内。令牌消耗后不能靠重复 POST 取回原凭证；保存首次响应，并通过安装流程处理响应丢失。

## 客户端配置读写与同步

配置路径为 `/api/reliability/clients/:clientId/config`，按用户、客户端和平台隔离。先校验归属；不属于用户也返回 `404 CLIENT_NOT_FOUND`。平台默认 `opencode`；支持的平台与 Schema 相同。

| 方法 | 输入 | 成功响应与状态码 |
| --- | --- | --- |
| `GET` | 查询 `platform`、兼容 `user` | `200 { clientId, platform, schemaVersion, builtinConfigVersion, revision, overrideDiff, effectiveConfig, fieldSources, delivery }`；`fieldSources` 区分 `builtin/client_override` |
| `PUT` | JSON `overrideDiff`、可选有限数值 `expectedRevision`、`sync`、`platform`、兼容 `user`；查询 platform 优先 | 只保存：`200 { revision, status: saved, saved: true }`。同步通知已创建：`202`，带 `revision/status/configRef/configVersion/checksum/deliveryId/commandId`。保存成功但客户端离线：仍为 `200`，`saved: true`、`status: notify_failed`、`sync.status: failed` |
| `DELETE` | 可选查询 `path`、`platform`、`sync=true`、兼容 `user` | 删除覆盖值以恢复内置值；无 `path` 清空全部覆盖，指定路径会清理该键及子键。返回新的 `revision` 和保存/同步信息，沿用 PUT 的 `200/202` 语义；不会删除客户端或历史快照 |
| `POST /api/reliability/clients/:clientId/config/sync` | 可选 JSON `configRef/platform/user`，查询 platform 优先 | 复用指定或最近一次投递的快照，不增加配置 revision；`202 { deliveryId, commandId, configRef, configVersion, status }`。没有快照 `404`；快照归属错误 `403`、平台不匹配 `409`、客户端离线 `503` |

`overrideDiff` 是以点分字段路径为键的**完整覆盖集合**，不是自动合并补丁。提交 `{}` 清空覆盖；未提交有效对象则保留原覆盖。字段按 Schema 校验，错误 `400 CONFIG_FIELD_INVALID`，`details.fields` 提供逐字段原因。带有效 `expectedRevision` 且与当前值不同则 `409 CONFIG_REVISION_CONFLICT`，响应带当前 revision。

```json
{
  "expectedRevision": 3,
  "overrideDiff": { "enabled": true },
  "sync": false
}
```

先用 GET 获取 revision 和需要保留的全部覆盖项。重复 PUT 会增加 revision，不能当作通用幂等接口。`sync: true` 会冻结不可变快照并通知客户端；离线保存不会回滚，也不排队等重连。需要同步时先确认客户端可收命令，再显式发同步请求。保存但未同步时，不应把已有 delivery 当作本次配置已生效的证据。

## 快照拉取和 RAS 加载回报

| 方法与设备路径 | 请求 | 响应与边界 |
| --- | --- | --- |
| `GET /config-snapshots/:configRef` | 设备凭证；可选 `If-None-Match` | `200 { configRef, clientId, platform, scope, schemaVersion, configVersion, checksum, correlation, expiresAt, config }`；`ETag` 是带引号的 checksum，完全匹配返回 `304`。快照默认有效 7 天；不存在 `404`、属于其他设备 `403`、过期 `410`。拉取将适用投递推进到 `pulling`，缓存命中也先执行此处理 |
| `POST /config-loads` | 必填 `platform/configVersion/status`；可选 `scope/checksum/rasProcessId/loadedAt/error` | `200 { ok: true, deliveryStatus }`。status 为 `loaded/version_mismatch` 时按原值处理，其他非空值归为 `failed`；缺必填项 `400`。报 `loaded` 但版本与最近 delivery 不同返回 `409 CONFIG_VERSION_MISMATCH`；没有 delivery 时返回 `saved` |

| delivery 状态 | 可信含义 |
| --- | --- |
| `saved` | 服务端已保存覆盖 |
| `sync_notified` | 已创建同步投递，可能等待 WebSocket 或轮询，不代表客户端已写入 |
| `pulling` | 客户端拉取快照；兼容 RAS 拉取通道也只能证明已拉取 |
| `written` | 配置类命令收到客户端 `SUCCEEDED`，且 `result.state` 明确为 `WRITTEN` |
| `ras_loaded` | RAS 通过 `config-loads` 回报匹配版本的 `loaded` |
| `notify_failed/pull_failed/write_failed/load_failed/version_mismatch` | 对应阶段失败或版本不一致，读取 `delivery.error` 和相关版本定位 |

用配置 GET 的 `delivery` 观察结果。服务端不会通过一次保存或一次命令 ACK 代客户端确认写入，也不会把写入自动升级为 RAS 加载成功。

## 命令与 WebSocket 桥接

`GET /api/reliability/client/v1/commands/next?waitSeconds=25` 是设备凭证鉴权的长轮询，默认等待 25 秒，上限 30 秒，内部每 500 ms 检查；当前表达式会把 `0` 也按默认 25 秒处理。有命令返回 `200` 的 `COMMAND` 帧，无命令或请求结束返回 `204`：

```json
{
  "type": "COMMAND",
  "commandId": "cmd_example",
  "action": "APPLY_CLIENT_CONFIG",
  "createdAt": "2026-11-02T00:00:00.000Z",
  "expiresAt": "2026-11-02T00:00:30.000Z",
  "payload": {
    "platform": "opencode",
    "scope": "client",
    "configRef": "cfg_example",
    "configVersion": "example-version",
    "checksum": "example-checksum"
  }
}
```

帧的引用和值为示例，需使用实际投递内容。命令白名单为 `APPLY_CLIENT_CONFIG/PREPARE_EXPERIMENT_CASE/RUN_EXPERIMENT_CASE/RUN_BENCHMARK_CASE/CANCEL_EXPERIMENT_RUN/REFRESH_CAPABILITIES/PREPARE_EXECUTION_ENVIRONMENT`。`RUN_EXPERIMENT_CASE/RUN_BENCHMARK_CASE/PREPARE_EXECUTION_ENVIRONMENT` 的 payload 顶层字段禁 `command/shell/args/cwd/executable/script`；其余白名单 action 禁 `url/config/path/downloadUrl/file`，执行环境准备还校验 context 结构与摘要。此接口不是任意命令执行入口。

`POST /api/reliability/client/v1/commands/:commandId/status` 使用设备凭证，JSON 为 `status` 加可选 `occurredAt/result/error`；允许 `RECEIVED/RUNNING/SUCCEEDED/FAILED`，成功 `200 { ok: true }`。错误状态 `400`，命令不存在或非本设备 `404`，未终结命令已过期 `410`，对已结束或不再接受开始确认的命令发送 `RECEIVED` 返回 `409 COMMAND_NOT_ACCEPTED`。命令终态不被后续回执改写；配置 delivery 仍需按上一节看写入与加载状态。

WebSocket `/api/reliability/client/v1/control` 由 `scripts/control-server.js` 处理升级，不是普通 Route Handler。服务端发送同一 `COMMAND` 帧，客户端发送 `COMMAND_STATUS` 帧（额外带 `type/commandId`，其余字段与 HTTP 回执一致）。同一 clientId 新连接替换旧连接。以下三个 HTTP 入口仅供控制服务桥接：

| 内部 POST 路径（设备前缀下） | 请求体 | 成功响应 |
| --- | --- | --- |
| `/control-auth` | `authorization`、`clientId` | `{ clientId, user }`，内部鉴权后校验设备凭证 |
| `/control-presence` | 必填 `clientId`，`connected: true/false` | `{ ok: true }`；建立连接刷新 lastSeenAt，断开由心跳窗口自然判离线 |
| `/control-receipt` | 必填 `clientId/commandId`，`status` 和可选 `occurredAt/result/error` | `{ ok: true }`，与设备 HTTP 回执走同一处理函数 |

客户端默认使用 `waitSeconds=5`，可在客户端运行环境设置 `AGENT_INSIGHT_RAS_POLL_WAIT_SEC` 为 1～30 的整数；无效值回退到 5 秒。等待时间应小于访问链路的空闲连接超时，单次请求另有等待时间加 10 秒的截止。轮询请求被明确取消时停止领取；并发请求通过原子状态更新竞争，同一命令只返回给一个请求。

当前客户端无论通过 WebSocket 还是轮询收到命令，都先通过 HTTPS 发送 `RECEIVED`，只有收到 `200 { ok: true }` 才执行本地动作；拒绝、超时或响应丢失时不执行。已有客户端必须更新并重启，单独更新平台镜像不会替换设备上已安装的脚本。WebSocket 仍可承载指令和后续进度、结果回执。

WebSocket 写入成功只表示写入 socket，送达需客户端 `RECEIVED`。ACK 窗口默认 5 秒（`AGENT_INSIGHT_RAS_ACK_TIMEOUT_SEC`，最小 1 秒）；通用命令 TTL 默认 30 秒（`AGENT_INSIGHT_RAS_COMMAND_TTL_SEC`，最小 5 秒），具体执行任务可覆盖 TTL。执行任务等待命令状态时会检查该命令的 ACK 截止，未确认的 `SENT` 会转为 `DELIVERY_FAILED/ACK_TIMEOUT`，无需查询客户端列表触发。已确认或运行中的指令不受此 ACK 清理影响；收到 ACK 后响应丢失时，客户端不执行，已记录的 `RECEIVED` 按任务原有 TTL 和超时机制收敛，不以丢失 ACK 为由重发可能已运行的工作。不能因网络中断就无限重复同步或假定进程已退出。

## 用户级 RAS 能力配置

这些接口管理用户 × 平台的 capability envelope，与客户端配置 revision/不可变快照是不同层。`GET/PUT /api/agent-ras/config` 都要求可解析用户，仅从请求读取 Key，不接受正文显式 user 选择。

| 方法与路径 | 输入 | 响应 |
| --- | --- | --- |
| `GET /api/agent-ras/config` | 必填查询 `platform`；可选 `format=yaml/json-export` | 默认 `200 { status: ok, envelope }`；导出格式直接返回 YAML/JSON 文本，不能套默认响应解析器 |
| `PUT /api/agent-ras/config` | 必填查询 `platform`；JSON 可含 `syncEnabled/config/platformExtras` | `200 { status: ok, envelope }`；`config` 包含 `enabled`、`detectors` 和 `recovery.notify_user_on_warning`，按默认值及目录 Schema 校验。缺省 config 保留原配置；config 有效对象按默认值补全，不是任意深度补丁 |
| `GET /api/agent-ras/catalog` | 可选 `force=1` 强制刷新 | `200 { status: ok, catalog }`，能力域、检测器和 Schema 等来自 RAS 目录；解析用户但不拒空身份 |

平台为 `opencode/openjiuwen/xiaoo`，无效/缺失 `400 invalid_platform`，缺身份 `401`；配置校验失败 `400 validation_error`。envelope 有 `platform/syncEnabled/revision/updatedAt/config/platformExtras`，只有值发生变化时增加 revision。当前自动同步支持 `opencode/xiaoo`，`openjiuwen` 的 `syncEnabled` 会归为 false。保存 envelope 不等于某个进程已加载。

## 错误与实现依据

设备、令牌和列表接口通常返回 `{ error: { code, message, details? } }`。客户端配置接口使用 `{ error, code, revision?, details? }`；agent-ras 接口另有 `{ error, detail/message }`，不能统一解析。未知异常常为 `500`。先判断 HTTP 状态和所属接口，再决定修参数、刷新 revision、重装设备或检查 delivery；写操作没有通用幂等键承诺。

按基线核对的源码：[设备注册与身份](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/reliability/client-registry.ts)、[客户端配置服务](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/reliability/client-config-service.ts)、[命令总线](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/reliability/command-bus.ts)、[回执处理](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/reliability/command-receipt.ts)、[WebSocket 服务](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/scripts/control-server.js)、[RAS 配置模型](https://gitcode.com/openeuler/agent-insight/blob/eabde5b02f69797fe7e09b446b3f178374325d82/src/lib/ingest/ras/capability-config.ts)。本页说明代码契约，不构成真实设备/网络的端到端验收结果。

[English](../../../en/reference/reliability/client-control-api.md)
