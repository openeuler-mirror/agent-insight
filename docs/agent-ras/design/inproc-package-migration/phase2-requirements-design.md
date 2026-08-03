# agent_ras 迁入 agent-insight — 需求设计

版本：v0.5  
最后更新：2026-07-27

> 文档类型：Phase2 需求设计 ｜ 关联 [Phase1](phase1-requirements-analysis.md)  
> 复杂度：Medium  
> **v0.5**：落库对齐 Insight **OTel ingest 规范**（`/api/ingest/ras/v1/events`、`witty.session.id`→`taskId`）；仍禁止进 OTLP 热路径。UI 见 v0.4。

---

## 导读

**定了什么** —— 仓根 `agent_ras/` 整包真源；只保留同进程 inproc runtime，不保留 `ras_service`、本地 HTTP transport 或进程拉起逻辑；Insight 负责配置/安装、事件 ingest 和可靠性页面。anomaly/actions **落库**后按 `sessionId` join 到 Trace。

**Review 重点**

- §1.2 设计决策表（尤其 D-003）  
- §4 Trace 标识 UI  
- §5 数据模型 / §6 API  

---

## §1 设计概要

### 1.1 实现思路

```text
[宿主 L3] --observe--> [ras_embed L1] --actions--> [L2 applyActions → L3 Host]
                            |
                            +--> POST insight ingest (anomaly/actions) --> Prisma
                            |
                            +--> [可靠性观测] join taskId --> 列表 + 完整链路详情
```

1. **物理迁入**：源仓整树 → `agent_ras/`。  
2. **配置**：`~/.agent-insight/ras/config.json`；兼容旧 `~/.aet`。  
3. **安装**：OpenCode 插件与 OTel 并列。  
4. **UI**：使用 `/agent-ras/trace` 可靠性观测列表和详情；详情复用 `AgentTraceView`。  
5. **弃用**：独立 RAS 服务、端口、HTTP/WS 控制面和静态 `ui/`。

### 1.2 设计决策

| 编号 | 决策项 | 内容 | 理由 |
|------|--------|------|------|
| D-001 | 落位 | 仓根 `agent_ras/` | 用户指定 |
| D-002 | 算法边界 | 禁止 TS 复制 detectors/recovery | RAS 硬约束 |
| D-003 | 人机 UI | `/agent-ras/trace` 独立可靠性入口，详情复用普通链路组件；保留 Mock 故障注入页 | 产品信息架构 |
| D-004 | 机器 API | 不保留本地 HTTP/WS 控制面；仅保留进程内 facade | 纯 inproc |
| D-005 | 实时通道 | 产品页面读 Prisma，不连接 Agent 进程 | 与事后观测模型一致 |
| D-006 | 持久化 | Prisma `RasAnomalyEvent`；异步 POST **`/api/ingest/ras/v1/events`**；鉴权/user/`taskId` 对齐 OTel ingest | FR-008；与 Insight 规范一致 |
| D-007 | 配置根 | `~/.agent-insight/ras/`；过渡读 `~/.aet` | 统一数据根 |
| D-008 | 与 OTel | 并列安装，不合并热路径 | 旁路 vs 环内 |
| D-009 | 静态 UI | 停止挂载 | 弃用不留双入口 |
| D-010 | jiuwen | 仍 L3→L0；可选上报 insight | 不阻塞 OpenCode |
| D-011 | OpenCode L3 | 仅 inproc；落库包含 anomaly/action_result，后续可扩展 skill_* | capability_matrix |
| D-012 | 关联键 | RAS `taskId` = OTel `witty.session.id` = `Execution.taskId` / `Session.taskId` | 与现网 Trace 归并一致 |
| D-013 | 孤儿事件 | 无对应 Trace 则本期不展示（不做待关联页） | 用户确认 |
| D-014 | ingest 形态 | inproc runtime 异步旁路 `/api/ingest/ras/v1/*` + `witty.ras.*`；**不**进 otel spool | 同家法不同热路径 |
| D-015 | 事件身份 | 每次真实异常/处置结果生成唯一 `deliveryId`；同一事件的发送重试复用该值。旧 `rasEventId` 只用于兼容历史数据 | 内容哈希不能区分同内容复发事件，CRC32 也存在碰撞 |
| D-016 | 安装生命周期 | 平台启动不安装/检查 RAS；安装指导选择 OpenCode 后使用服务端匹配版本安装 telemetry + RAS，并保留当前邮箱用户 Key | 平台主机与 Agent 主机可分离；避免 npm latest 漂移和 admin 归属覆盖 |

---

## §2 架构设计

### 2.1 模块变更总览

| 状态 | 模块 | 变更 |
|------|------|------|
| 🟢 | `agent_ras/**` | 整树迁入 |
| 🔴 | `ras_service/**` | 删除；不发布、不安装 |
| 🟡 | `ras_client.*` / install | 配置根 → insight |
| 🟢 | 安装脚本 / setup | OpenCode RAS 插件 |
| 🟢 | `src/app/api/ingest/ras/v1/*` | 对齐 otel ingest 目录；按 taskId 查询 |
| 🟡 | 可靠性列表 / Trace 详情 | 独立列表 + 复用完整 Agent 行为链 |
| 🟢 | `lib/ras/labels.ts` | kind/severity 文案 |
| 🟢 | Prisma `RasAnomalyEvent` | 持久化 |
| 🟢 | `AppSidebar` 可靠性入口 | 指向 `/agent-ras/trace` |
| 🔴 | `agent_ras/core/**` 算法 | 禁改 |

### 2.2 依赖方向

```text
ras_embed          ──写──► POST /api/ingest/ras/v1/events（x-witty-api-key）→ Prisma
可靠性页            ──读──► Prisma（按 taskId）+ Execution
OTel traces/logs    ──不经──► RAS 表（热路径隔离）
```

---

## §3 安装与配置

`~/.agent-insight/ras/config.json` 含 `insight.events_url` →
`/api/ingest/ras/v1/events`，并配置与 OTel 相同的 API Key；OpenCode 插件与 OTel 并存。
安装指导是自动安装唯一入口，生成命令绑定服务端包版本。平台启动只维护服务端，不要求
Agent 主机 runtime；同机部署时也不得覆盖安装指导已写入的客户端邮箱 Key。

---

## §4 UI 设计

| 位置 | 行为 |
|------|------|
| 可靠性列表 | 普通执行也展示；含 Trace ID、摘要、故障、严重度、执行状态 |
| 可靠性详情 | RAS 告警/处置 + 复用普通链路的完整 Agent 行为链 |
| 异常锚点 | 优先按 OpenCode message/part ID 关联，旧数据才回退短时间窗 |
| Mock 故障注入 | 明确标记 Mock，不向运行中 Agent 下发故障 |

文案区分：RAS = 环内已发生；`/fault` = 事后诊断。

---

## §5 数据模型

`RasAnomalyEvent`（侧表，**不**改 `Execution` 列语义）：

- `deliveryId String?`：新链路的事件实例/投递幂等键，`@@unique([taskId, deliveryId])`。
- `rasEventId Int?`：仅兼容旧数据和旧发送端。
- 新发送端不得用 payload 内容哈希生成事件 ID；重复发送同一事件时复用 `deliveryId`，新的复发事件生成新的 `deliveryId`。

| 字段 | 说明（对齐 Insight） |
|------|----------------------|
| id | `cuid()` |
| taskId | = `witty.session.id` / `Execution.taskId` |
| user | API Key 归属 |
| framework | 平台标签 |
| type | event_type |
| anomalyKind / severity / summary / actionTypes | 冗余筛选 |
| payloadJson | 原文 JSON string |
| rasEventId | 去重可选 |
| executionId | 可选，解析到 root 时回填 |
| ts / createdAt | 事件 / 写入时间 |

索引：`(taskId, ts)`、`(user, ts)`、`(anomalyKind, ts)`；去重 `@@unique([taskId, rasEventId, type])`。  

---

## §6 API 契约（insight）

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/ingest/ras/v1/events` | ras_embed 推送（`x-witty-api-key`） |
| GET | `/api/ingest/ras/v1/events` | 按 `taskId` / kind / 时间筛（供 Trace） |

**不**做：把 RAS 写入 `/api/ingest/otel/v1/traces|logs` spool。  
**不**在 insight 实现 `/observe` 控制面。  
实现后在 [09-otlp-attribute-contract](../../../developer-guide/09-otlp-attribute-contract.md) 追加「RAS 旁路 ingest」小节。

---

## §7 弃用静态 UI

移除静态 `/ui/`；更新 ras 文档：人机 = Insight 链路追踪标识。

---

## §8 风险与缓解

| 风险 | 缓解 |
|------|------|
| taskId / witty.session.id 对不齐 | D-012；L3 与 OTel 插件写同一 session |
| 用户仍找独立 RAS 页 | 文档与安装说明写清 |
| 与 `/fault` 混淆 | 文案：环内 vs 事后 |
| ingest 拖慢热路径 | 异步、短超时、失败忽略 |

---

## §9 验收映射

| Phase1 | 落点 |
|--------|------|
| FR-005 | §4 Trace 标识 |
| FR-006 | §7 + D-003 |
| FR-008 | §5 + §6 |
