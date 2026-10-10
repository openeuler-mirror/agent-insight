# 客户端控制面：安装、保活、配置下发与双向通信（开发中）

落地《[Agent RAS 可靠性闭环-服务端与客户端交互设计](Agent%20RAS%20可靠性闭环-服务端与客户端交互设计.md)》第一部分：独立常驻客户端服务、统一安装与进程保活、配置动态渲染下发、服务端与客户端双向通信。

## 目标

- 一次安装同时部署常驻客户端、RAS 与故障组件；由 systemd / launchd 守护，崩溃自动重启。
- 客户端主动建立出站 WSS；建立后服务端与客户端双向通信，HTTPS 长轮询兜底。
- 内置只读配置 Schema 动态渲染配置页；客户端级差异覆盖；服务端冻结不可变快照。
- 配置状态链路可追踪且**每一步都由真实回执驱动**：已保存 → 已通知 → 拉取中 → 本地已写入 → RAS 已加载。
- 新客户端吸收 FI Worker 职责；FI Worker 端点保留兼容期。

## 非目标

- Windows Service（本期不做，见「平台范围」）。
- 实验编排、可靠性数据集、可靠性评估器、Trace 异常呈现（属需求文档后续部分）。
- 服务端下发任意 Shell、任意路径、任意下载 URL。
- 客户端离线时排队、重连后自动补发历史指令。

## 关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 控制通道 | **自定义 Node server 承载 WSS**（方案 A） | 单进程单端口，与 `output: 'standalone'` 部署形态一致；Next Route Handler 无法处理 `upgrade` |
| 平台范围 | **Linux + macOS** | 二者可用纯 shell 完成用户级安装免 root；Windows Service 通常需管理员权限并依赖 `nssm` 等外部工具，与「不依赖外部下载源」冲突 |
| 客户端形态 | **Node 脚本** | 复用 `fi-worker.js` 骨架与既有 npm 分发链路；自包含二进制需额外打包链路 |
| 与 FI Worker | **新客户端吸收，旧端点保留兼容期** | 无断裂升级；最终只剩一个常驻进程 |
| 安装命令 | **客户端 + FI 合并为一条；Trace 采集器不并** | 采集器要装进 10 种 Agent 平台且支持 Windows，与常驻服务的 Linux/macOS 边界不同 |
| 存储 | **Prisma** | 现文件存储在并发/多实例下有读改写竞态；设计文档要求可审计 |

## 修正现有实现的一处语义失真

当前 [`client-config-service.ts`](../../../../src/lib/reliability/client-config-service.ts) 在「保存并通知同步」时**由服务端自行**把 delivery 标记为 `written` 并填入 `pulledAt` / `writtenAt`，此刻客户端可能从未拉取。

这违反需求文档 §1 决策 8（「客户端确认写入和 RAS 确认加载是两个不同状态，页面不得把『已写入』显示为『已生效』」）。本期改为：

```text
服务端只能写 saved / sync_notified / notify_failed
pulling    ← 客户端 GET config-snapshots 时
written    ← 客户端 COMMAND_STATUS: SUCCEEDED(WRITTEN)
ras_loaded ← RAS 独立回报 config-loads
```

同时删除 [`clients-from-workers.ts`](../../../../src/lib/reliability/clients-from-workers.ts) —— 客户端不再从 FI Worker 心跳镜像伪造。

## 数据模型

新增 8 个模型（`prisma/schema.prisma`）：

| 模型 | 关键字段 | 说明 |
|------|----------|------|
| `ReliabilityInstallToken` | `tokenHash/user/name/expiresAt/consumedAt` | 一次性安装令牌，只存哈希 |
| `ReliabilityClient` | `clientId/user/hostname/reportedIp/observedIp/os/arch/status/serviceHealth/processStartedAt/restartCount/lastSeenAt/capabilitiesJson/capabilitiesRevision` | 常驻客户端；区分网络在线与进程健康 |
| `ReliabilityClientCredential` | `clientId/credentialHash/createdAt/revokedAt` | 设备凭证，只存哈希，可撤销 |
| `ReliabilityCommand` | `commandId/clientId/action/payloadJson/status/expiresAt/sentAt/receivedAt/completedAt/errorCode` | 指令审计与幂等 |
| `ReliabilityClientConfig` | `clientId/platform/revision/overrideJson` | 客户端差异项，`clientId+platform` 唯一 |
| `ReliabilityConfigSnapshot` | `configRef/clientId/platform/scope/configVersion/checksum/configJson/expiresAt` | 不可变权威快照 |
| `ReliabilityConfigDelivery` | `deliveryId/clientId/platform/configRef/commandId/status/pulledAt/writtenAt/loadedAt/error` | 一次通知→拉取→写入→加载 |
| `ReliabilityConfigLoad` | `clientId/platform/configVersion/checksum/rasProcessId/status/loadedAt` | RAS 加载回报历史 |

`FaultInjectionRun.workerId` 保持不变（可空字符串，无外键），新客户端复用该字段填入 `clientId` —— **无数据迁移**。

## 接口

### 新增

| 编号 | 方法与路径 | 调用方 |
|------|-----------|--------|
| IF-N01 | `POST /api/reliability/install-tokens` | Web |
| IF-N02 | `GET /api/ingest/setup/ras-client` | 安装器 |
| IF-N04 | `POST /api/reliability/client/v1/register` | 客户端 |
| IF-N05 | `WSS /api/reliability/client/v1/control` | 客户端 ↔ 服务端 |
| IF-N06 | `POST /api/reliability/client/v1/heartbeat` | 客户端 |
| IF-N07 | `GET /api/reliability/client/v1/commands/next` | 客户端（兜底） |
| IF-N08 | `POST /api/reliability/client/v1/commands/{commandId}/status` | 客户端 |
| IF-N15 | `PUT /api/reliability/client/v1/capabilities` | 客户端 |

### 修改

- IF-N09 `GET /api/reliability/clients` —— 数据源由 FI Worker 镜像改为 `ReliabilityClient`。
- IF-N11 `PUT/DELETE /api/reliability/clients/{clientId}/config`、`POST .../config/sync` —— 通知走控制通道；客户端离线时保存成功但 `sync.status=failed`，不排队。
- IF-N17 `GET /api/reliability/client/v1/config-snapshots/{configRef}` —— 改设备凭证鉴权；拉取时推进 `pulling`。
- IF-N12 `POST /api/reliability/client/v1/config-loads` —— 改设备凭证鉴权。
- `/api/fault-injection/worker/*` 三端点 —— 同时接受 API Key 与设备凭证（兼容期）。

## 控制通道

### 承载方式

`scripts/start.js` 改为拉起 `scripts/control-server.js`：该脚本 require Next standalone 的 `server.js` 之外自行创建 HTTP server，
在 `upgrade` 事件上分流 `/api/reliability/client/v1/control` 到 `ws`，其余交给 Next handler。

单实例内存连接注册表 `Map<clientId, WebSocket>`。多实例部署下连接亲和性不在本期范围。

### 帧契约

```ts
// 服务端 → 客户端
type CommandFrame = {
  type: 'COMMAND'
  commandId: string
  action: 'APPLY_CLIENT_CONFIG' | 'PREPARE_EXPERIMENT_CASE' | 'RUN_EXPERIMENT_CASE' | 'REFRESH_CAPABILITIES'
  createdAt: string
  expiresAt: string
  payload: Record<string, unknown>   // 配置类只含 platform/scope/configRef/configVersion/checksum
}

// 客户端 → 服务端
type CommandStatusFrame = {
  type: 'COMMAND_STATUS'
  commandId: string
  status: 'RECEIVED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  occurredAt: string
  result?: { state?: 'PULLING' | 'WRITTEN'; [k: string]: unknown }
  error?: { code: string; message: string }
}
```

双端各自维护 action 白名单。配置类 action 的 payload **禁止出现** `url` / `config` / `path`；
`RUN_EXPERIMENT_CASE` **禁止出现** `command` / `shell` / `args` / `cwd` / `executable`。

### 送达语义

### 制品由服务端下发，不依赖 npm 与执行目录

安装脚本原先只能 `npm pack` 取制品，导致在仓库外执行时拿到 npm 上版本号相同但内容滞后的包，
内网/离线环境更是直接失败。curl 命令里唯一确定可达的是服务端自身，故新增
`GET /api/ingest/setup/bundle?name=ras|client`：把服务端安装目录里的源码打 tar 返回
（白名单查表，绝不把参数拼进路径）。

RAS 与客户端安装统一为三级回退：

```
1. 本地 checkout      → 开发者改完立即生效
2. 服务端 bundle 接口  → 与执行目录、npm registry 均无关
3. npm pack           → 兼容尚无该接口的旧服务端
```

**客户端运行时必须固化**：安装器可能是从 bundle 解压到 /tmp 后执行的，装完临时目录即被删除。
若 systemd/launchd 指向那里，服务会以 `MODULE_NOT_FOUND` 反复崩溃。因此把
`reliability-client.cjs`、`ws-client.cjs` 与 `config_sync.js` 一并拷到
`~/.agent-insight/client/runtime/`，服务只引用该稳定路径。
两份守护进程脚本使用 `.cjs`，避免被用户目录上层 `package.json` 的
`"type": "module"` 误判为 ESM；`config_sync.js` 仍保持 ESM 并由客户端动态导入。
`config_sync.js` 少拷会让 RAS 运行时配置**静默跳过写入** —— 页面显示「已写入」，
RAS 却永远读到旧值。

安装 FI 时，系统 Python 只负责执行 `-m venv`；FI 包与第三方依赖只允许由
`~/.agent-insight/fault-injection/runtimes/<id>/venv/bin/python -m pip` 安装。
安装器以包摘要、Python 版本和运行时 schema 生成版本化目录，经 `python -I` 验证后才把
`fiPython`/`fiRuntimeRoot` 原子写入客户端配置。不得先试全局 pip，也不得使用
`--break-system-packages`。macOS launchd 仍继承安装时的 `PATH` 以发现用户级 Agent 可执行文件，
但 xiaoO Hook 使用 `fiPython` 对应的绝对解释器，不再解析 PATH 中的 `python3`。
完全离线所需 wheel 仍属独立议题，需先定 OS/arch/Python 版本矩阵。

### Trace 采集器安装顺带纳管本机

Trace 采集与主机纳管仍是两个独立安装项（采集器要覆盖 10 种 Agent 平台且支持 Windows，
常驻客户端只支持 Linux/macOS，不宜强行合并入口）。但 `/api/ingest/setup` 装完采集器后会
自动申请一次性令牌并调用 `install-ras-client` —— 否则用户装完采集器，
「客户端配置」页仍是空的，且页面无从提示还差一步。

该步骤**失败只告警不中断**：Trace 采集不依赖常驻客户端。
本地 checkout 走 `./scripts/install-ras-client.js`；npm 安装场景回退到 `npm pack` 解包，
包内不含该安装器时明确报错而非静默跳过。

### 「同一台机器」的判定依据

原先只有 `clientId`，且每次注册都新生成 —— 服务端没有机器的概念。去重完全依赖
本机 `config.json` 里的 `previousClientId`，那个文件一删（重装、换盘、清理），
服务端就认不出是同一台机器，于是每装一次多一条记录，页面上同一主机堆成好几个条目；
A→B→A 绕回来时 A 拿到的也是第三个全新 id，配置下发历史断档。

现在以**机器指纹**为准：

| 平台 | 来源 |
|---|---|
| macOS | `IOPlatformUUID`（`ioreg -rd1 -c IOPlatformExpertDevice`） |
| Linux | `/etc/machine-id`，回退 `/var/lib/dbus/machine-id` |
| 兜底 | `sha256(hostname + 首个非回环 MAC)`，前缀 `fallback:` |
| 覆盖 | 环境变量 `AGENT_INSIGHT_MACHINE_ID` —— 容器/克隆虚拟机可能共用 machine-id |

`ReliabilityClient.machineId` + `@@unique([user, machineId])`；注册时命中
`(user, machineId)` 就**复用原 clientId**（换发凭证、清 `unboundAt`），未命中才新建。

要点：
- 字段可空：旧版本客户端装的记录没有指纹，SQL 中 NULL 互不相等，不会因唯一约束冲突，
  行为退回原样（无法判定同机）
- 复用时必须撤销该 clientId 下的旧凭证 —— 安装器拿不回原凭证只能换发，
  留着旧的等于多一把还能用的钥匙
- 与换账号解绑逻辑正交：换账号仍是新建+解绑，绕回来时才走复用

### 换账号：一台机器只能属于一个账号

数据面在本机只有一份 —— OpenCode 插件只读一份 `.env`，RAS 只读一份 `config.json`，
一次会话只能归属一个账号。因此**不支持同一 OS 账号下 A、B 共存**，换账号只能是完整交接。

原实现按「配置文件是否存在」决定跳过，导致换账号后机器裂成两半：
`.env` 被新账号的 key 覆盖（Trace 归 B），而客户端注册被跳过（纳管仍归 A）——
两边页面都只看到一半，且 A 仍能向这台机器下发配置。

现在按**归属**判定：

| 情况 | 行为 |
|---|---|
| 归属一致 | 跳过注册（幂等） |
| 归属不同 | 自动改绑：新注册 + 旧记录标 `unboundAt` + **旧凭证立即撤销** |
| 本机无归属记录（旧版本装的） | 一律改绑，消除歧义 |

要点：
- `client/config.json` 记录 `user`，否则无从比对
- 解绑与新注册在**同一事务**内完成，避免「旧凭证已撤销、新客户端没建成」的半态
- 旧记录保留而非删除，配置下发历史仍可追溯；`deriveStatus` 对已解绑返回 `unbound`
  而非 `offline` —— 后者会让人以为机器只是掉线
- 判定必须放在安装脚本层，光改 `install-ras-client.js` 无效：shell 会在调用它之前就 return

### 无控制网关的部署（start.sh）

`scripts/start.sh` 直接跑 `.next/standalone/server.js`，**不加载 control-server，因此没有 WSS**。
这是受支持的部署形态，不是错误配置：

- 客户端 WSS 握手超时后自动降级 IF-N07 长轮询，指令照样送达。
- 服务端判定「能否下发」用 `canReceiveCommands()`：WSS 已连 → 用 WSS；未连但**心跳新鲜** → 仍创建指令，等长轮询取走。
  只用 `isConnected()` 把关会让该部署永远无法下发配置。
- 客户端每次启动按当前 `insightBaseUrl` **重算** ws/poll 地址；注册时写入 config.json 的绝对地址
  在服务端换端口后会指向旧实例，表现为「客户端在跑却永远连不上」。

### 配置要写 RAS 真正读的文件

客户端写两份：

| 文件 | 用途 |
|---|---|
| `~/.agent-insight/ras/<platform>/client-config.json` | 审计快照（带 configVersion/checksum，便于排查） |
| `~/.agent-insight/ras/config.json` | **RAS 与 OpenCode 插件实际读取的运行时配置** |

只写前者等于配置没生效。后者复用 OpenCode 插件自己的 `mergeCapabilityIntoLocalRasConfig()`，
保证两条写入路径产出一致结构，并保留 RAS 安装时写入的 `python`/`runtimeRoot` 等字段。
只有 `client` scope 写运行时配置：`experiment` scope 是单次 Case 的临时配置，不应污染长期配置。

**长轮询必须独立于 WSS 重连退避**：原先两者写在同一个循环里 ——
WSS 握手失败 → 轮询一次 → 退避 sleep（指数增长至 60s 上限）→ 重试。
在没有控制网关的部署（`start.sh`）下 WSS 永远失败，backoff 很快涨满，
轮询空窗随之超过服务端指令 TTL（默认 30s），指令还没被取走就 `COMMAND_EXPIRED`，
页面显示「同步失败」而客户端明明在线。

退避的作用是避免猛敲服务端，只该管重连；长轮询是 WSS 不可用时的**唯一**取指令通道，
节奏只能由 TTL 决定。约束：`long-poll 等待(25s) + 失败重试(3s) < 指令 TTL(30s)`。

**客户端必须自己判活**：服务端每 30s 发 ping，但服务端进程被杀时可能不发 FIN（半开连接），
OS 不会通知客户端，只等 `close` 事件会永远挂住 —— 表现为服务端重启后客户端再也不回来。
客户端以「最近收到任何帧」为准，超过 75s 无动静即主动断开重连。

**离线后 `serviceHealth` 必须降级为 `unknown`**：它只在心跳时写库，客户端一停就冻结在最后一次的值，
否则页面会同时显示「离线」和「healthy」。

连接在线 ≠ 指令送达。`SENT` 后 ACK 窗口（默认 5s）内未收到 `RECEIVED` → `DELIVERY_FAILED`。
用户重试创建新 `commandId`；旧指令不在重连后自动执行。客户端按 `commandId` 幂等。

## 客户端

`scripts/reliability-client.cjs`，配置根 `~/.agent-insight/client/`。

| 模块 | 职责 |
|------|------|
| 控制连接 | 出站 WSS + 断线指数退避重连；失败降级长轮询 |
| 能力发现 | hostname / IP / os / arch / 平台 / 模型 / 组件版本；复用 FI `platform inventory` |
| 配置同步 | 按 `configRef` 拉取 → 校验绑定与 checksum → 写临时文件 → fsync → 原子 rename |
| FI 采集 | 搬运 `runCollector` / `buildCollectorArgs` / `readCollectResult` |
| 并发闸 | 可靠性 Case 独占互斥槽，持有期间拒领 FI run；反之亦然 |

### 一条命令同时生效

安装器默认串联故障注入组件安装（`--no-fi` 可跳过），失败仅告警不中断。
客户端在心跳循环里**同时上报两份**：

| 上报 | 端点 | 消费方 |
|------|------|--------|
| 客户端能力 | `PUT /api/reliability/client/v1/capabilities` | 客户端配置页 |
| FI Worker 心跳 | `POST /api/fault-injection/worker/heartbeat`（`workerId = clientId`） | 实验页 / 注入页 / 平台·模型下拉 |

实验页与注入页只读 `FaultInjectionWorker`，客户端不写这张表就等于不存在 —— 这是「一条命令同时生效」的关键。
两份上报同源于一次 `probeFaultInjection()`（结果缓存），避免两个页面各说各话。

`/api/reliability/clients` 按 `workerId ∈ 已注册 clientId` 过滤 legacy 行，
否则同一台机器会既作为常驻客户端、又作为「存量 Worker」出现两次。

**客户端要用的 FI 端点必须全部支持设备凭证**（`worker-dual-auth.ts`）：
`worker/heartbeat`、`worker/claim`、`worker/commands`、`runs/:runId/collect-result`。
漏掉任何一个都会造成「能领任务但传不回结果」，run 永远卡在 `collecting`。

**Python 解释器与工作目录**：`fiPackageRoot` 是版本化安装源（开发模式可为 checkout），
`fiPython` 是唯一权威执行解释器。探测与 spawn 采集器均使用该绝对路径和 `-I`，不读取通用
`PYTHON`，缺少配置时只上报 `faultInjection.ready=false`，不得回退到 PATH 中的 `python3`。
Homebrew / Debian 的 PEP 668 只影响系统环境；managed venv 从一开始就是唯一安装目标，
所以正常安装不会产生 `externally-managed-environment` 错误。

**launchd 切换**：`bootout` 后必须等旧 label 消失；`bootstrap` 遇到 macOS 37
`Operation already in progress` 时有限重试，并以 `launchctl print` 为最终成功判据。
`kickstart` 失败或 label 不存在都必须让安装失败，禁止无条件打印“服务已启动”。

客户端 `capabilities` 的 `revision` 带进程启动时间前缀。该字段只用于幂等去重，
重启后必须换一批，否则服务端会把首次上报当成重放丢弃（表现为 platforms 恒为空）。

### Python 可选化

FI Worker 现有 `assertWorkerReady` 在 Python 不可用时 `process.exit(1)`。常驻服务中这会造成 crash loop 直至 `DISABLED`，
届时用户连配置都改不了。改为：Python / `agent_fault_injection` 缺失时客户端**照常上线**，
能力上报 `faultInjection: { ready: false, note }`，服务端不向其派发 FI run。

关键：不就绪时**仍然上报 FI 心跳**，只跳过 claim。页面据此区分
「机器没装」（Worker 列表为空）与「机器在线但 FI 未就绪」（`ready:false` + `note`）——
后者应显示缺什么（如缺 python3），而不是让用户去重装一个已经装好的客户端。

### 并发互斥

需求文档 §7.4 要求同一客户端可靠性 Case 并发为 1，避免多个故障注入互相污染。
FI Worker 默认 `maxParallel=5`。二者合并后：

```text
reliabilitySlot 被占用 → 拒领 FI run（claim limit = 0）
FI run 在跑        → 拒绝 RUN_EXPERIMENT_CASE，回 FAILED(CLIENT_BUSY)
```

## 保活

| 平台 | 机制 | 参数 |
|------|------|------|
| Linux | systemd user unit | `Restart=on-failure` `RestartSec=5s` `StartLimitIntervalSec=300` `StartLimitBurst=5` `WatchdogSec=30s` |
| macOS | launchd `LaunchAgent` | `KeepAlive.SuccessfulExit=false` `ThrottleInterval=10` |

客户端**不得**通过递归拉起自身实现守护。连续失败超阈值后由进程管理器停止重启，客户端状态置 `DISABLED` 并在页面告警。
`Type=notify` 必须先 `sd_notify(READY=1)`（在 capabilities 等慢探测之前），再按约 `WatchdogSec/2` 周期发 `WATCHDOG=1`；`StartLimitIntervalSec` / `StartLimitBurst` 写在 `[Unit]`。Node 核心无 unix datagram，经 `systemd-notify --pid=<client>` 投递（无第三方依赖）。

## 安全

- 安装令牌一次性、短有效期（默认 600s），只存哈希。
- 设备凭证按客户端隔离、只返回一次、只存哈希、可撤销；客户端以 `0600` 保存。
- 快照接口校验 `configRef → clientId` 绑定，跨客户端 `403`，过期 `410`。
- 控制指令不携带下载 URL、文件路径或完整配置。
- 日志不记录设备凭证与完整安装令牌。

## 兼容与升级

1. 存量 FI Worker 继续用 API Key 走 `/api/fault-injection/worker/*`，不受影响。
2. 新装机器只装新客户端，走设备凭证。
3. `/api/reliability/clients` 同时列出两者；FI Worker 来源标记 `legacy: true`。
4. 一到两个版本后移除旧路径。

## 验收对照

对应需求文档 §15 验收口径第 1–3 条与第 9 条（客户端离线 / 未 ACK / 拉取失败 / 写入失败 / RAS 未加载可区分）。
第 4–8 条属实验与评估器范围，不在本期。
