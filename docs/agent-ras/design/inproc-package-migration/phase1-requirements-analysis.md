# agent_ras 迁入 agent-insight — 需求分析

版本：v0.1  
最后更新：2026-07-27

> 文档类型：Phase1 需求分析 ｜ 关联项目：agent-insight  
> 复杂度：**Medium**（跨仓整树迁入 + Python inproc + Next UI + 安装桥接；不改检测算法）  
> 源仓：`/home/iceory/work/agent-reliability/agent_ras`  
> 关联文档：[`docs/agent-ras/architecture/ras_architecture.md`](../../architecture/ras_architecture.md) / [`capability_matrix.md`](../../architecture/capability_matrix.md)

---

## 导读

**这是什么** —— 把独立仓 `agent_ras`（环内异常检测 + 恢复）整包迁入本仓根目录 `agent_ras/`，复用 insight 安装入口；在 **agent-insight UI** 展示 anomaly / actions；原 `ras_service/ui` 静态监控台已移除。

**为什么要做** —— RAS 与 insight 互补：insight 做旁路观测/评测/Skill；RAS 做环内 abort/notice/steer。目标仓已有分支 `dev_agent_ras` 但零实现；源仓文档原指向 AET `packages/`，需按本仓约定重定落位。

**这一期做到哪**

1. 仓内 `agent_ras/` 整树可用（生产安装基础包；开发使用 `pip install -e ".[dev]"`）。
2. 安装复用（OpenCode 插件与 runtime 由统一 Node 安装器管理；配置根归 `~/.agent-insight`）。
3. Insight 可靠性页面可看普通执行、异常、处置和完整 Agent 行为链。

**明确不碰**

- 不把 LoopDetector / Recovery 决策 port 到 TypeScript。
- 不用 OTel 替代 `observe` 热路径。
- 不实现 openclaw/hermes L3 填实（骨架随树迁入即可）。
- 不并入 `agent_ras_eval`；不改 AgentDebug 事后诊断语义。

---

## §1 基本信息

### 1.1 背景

| 维度 | agent-insight | agent_ras（源） |
|------|---------------|-----------------|
| 定位 | 旁路 AgentOps | 环内 Reliability / Anomaly / Stewardship |
| 栈 | Next.js + Prisma + TS | Python core/embed + JS L2/L3 |
| 干预 | 无宿主控制面 | HostControl：abort / notice / steer |
| UI | `/trace` `/fault` `/quality` `/agent-ras/trace` | 无独立 RAS runtime UI |

### 1.2 已确认前提（用户拍板）

| ID | 前提 |
|----|------|
| P-01 | 整包落在仓根 **`agent_ras/`**，便于独立模块维护 |
| P-02 | core / platform_adapter 等在包内**独立维护**；insight 只做薄胶水 |
| P-03 | **安装方式复用** insight 现有分发/CLI 范式 |
| P-04 | 一期范围：**仓内可用 + 安装复用 + anomaly 进 insight UI** |
| P-05 | **原先 agent-ras UI 弃用**（insight 为唯一人机监控面） |

### 1.3 结构化信息

| 维度 | 内容 |
|------|------|
| Who | 平台维护者；OpenCode / openjiuwen 用户；看 RAS 异常的开发者 |
| When | 开发机本地；Agent 运行时环内检测触发后 |
| What | 迁入包、可安装、insight 可见 anomaly |
| Why | 单仓交付环内恢复 + 旁路观测；避免 AET/双仓真源 |
| Where | 本仓 `agent_ras/` + `scripts/` + Trace 上 RAS 标识 + `/api/ingest/ras/v1/events` |
| How | 整树复制；配置/安装桥接；EventBus → insight UI；下线静态 `/ui/` |

---

## §2 核心能力

### 2.1 场景

| 编号 | 路径 | 触发 | 期望 |
|------|------|------|------|
| S-001 | 迁入后单测 | `pytest tests/unit_tests`（在 `agent_ras/`） | 与源仓同级绿 |
| S-002 | 生命周期 | runtime 随 Agent 宿主进程初始化和释放 | 不监听本地端口，不拉起独立进程 |
| S-003 | OpenCode 安装 | insight 安装入口 / 复用脚本 | 插件指到 `agent_ras/platform_adapter/opencode/plugin.js` |
| S-004 | 环内命中 | thinking loop / 重复工具 | 宿主收到 abort/notice/steer；对应 Trace 上出现 RAS 标识 |
| S-005 | 在可靠性观测查看 | 用户打开有关联的 Trace | 列表含普通执行；详情含 anomaly/actions 和完整行为链 |
| S-006 | 静态 UI 弃用 | 访问原 `/ui/` | 不再提供可用监控台（410/重定向说明/移除静态资源） |
| S-007 | jiuwen 深路径 | `build_agent_ras_rail` | 仍 in-proc L0 |
| S-008 | fail-open | runtime 初始化 / 检测异常 | 不影响宿主主路径（沿用 RAS 既有语义） |

### 2.2 功能需求

| ID | 需求 | 优先级 |
|----|------|--------|
| FR-001 | 源树迁入 `agent_ras/`（core / ras_embed / platform_adapter / tests / pyproject / docs） | P0 |
| FR-002 | 包可编辑安装；pytest 门禁保留 | P0 |
| FR-003 | 配置与锁文件归 `~/.agent-insight/`（过渡可读旧 `~/.aet`） | P0 |
| FR-004 | OpenCode（及既有 install 脚本）路径改为仓内 `agent_ras/` | P0 |
| FR-005 | 在既有链路追踪标识 RAS anomaly / actions（按 session 关联） | P0 |
| FR-006 | 删除 `ras_service`、HTTP/WS transport 与静态 UI；可靠性观测由 Insight 独立页面承载 | P0 |
| FR-007 | 用户指南/开发者指南：观测 vs 环内恢复边界；安装步骤 | P1 |
| FR-008 | anomaly 事件在 insight 侧可事后查阅（服务 idle 退出后仍可见近期记录） | P1 |

### 2.3 非功能

| ID | 要求 |
|----|------|
| NFR-001 | 检测/恢复算法单源仍在 Python `agent_ras/core/` |
| NFR-002 | 依赖单向：L3→L2→L1→L0；insight UI **不**反向改写 wire message |
| NFR-003 | 双栈：`npm test` 与 `agent_ras` pytest 可独立跑 |
| NFR-004 | 默认绑定本机回环；不引入公网暴露假设 |
| NFR-005 | 设计系统：Trace 上 RAS 标识用共享令牌，不引入 `--ras-*` 色板 |

### 2.4 业务规则

| ID | 规则 |
|----|------|
| BR-001 | 文案真源：`core/recovery/robustness_prompt.py`；UI 只展示不改写 |
| BR-002 | 决策真源：`build_recovery_actions`；insight 不内嵌恢复分支 |
| BR-003 | 产品人机只读 Insight 数据库，不连接 Agent 进程 |
| BR-004 | 与 AgentDebug / quality anomaly **术语区分**：环内 RAS anomaly ≠ 事后诊断 |
| BR-005 | Skill 对外 key 仍用 name；RAS 内嵌 L3 SKILL **不**并入仓根 `skills/` |

---

## §3 边界

### 做

- 整包迁入、安装桥接、Trace 上 RAS 标识、静态 UI 弃用、anomaly 持久化（FR-008）。

### 不做（本期）

- openclaw / hermes 深适配实现。
- 将 RAS 控制面并入 OTel ingest 主路径。
- 用 RAS 替换 `/fault` AgentDebug。
- monorepo npm workspace / 改动 CI 脚本（若需改 `package.json` scripts，另开授权）。

### 与现有模块关系

| 模块 | 关系 |
|------|------|
| `scripts/*` 平台插件 | **并列**：OTel 旁路 vs RAS 环内，不合并 |
| `src/lib/engine/agent-debug` | **正交**：事后 vs 环内 |
| `src/lib/ingest` | RAS 事件旁路入口；与 OTLP 热路径隔离 |

---

## §4 验收要点（概要）

1. `agent_ras/` 在本仓可 `pip install -e ".[dev]"` 且单元测试通过。  
2. OpenCode 安装后插件指向稳定 runtime，启动不拉起独立服务。  
3. 人为触发或单测级 anomaly 后，在对应可靠性链路中可见告警与行为链。  
4. 不存在 RAS 本地 HTTP/WS/UI 控制面。  
5. 文档说明配置根与「观测 vs 恢复」边界。

---

## §5 待 Phase2 决策项

| ID | 问题 | 倾向（供设计） |
|----|------|----------------|
| Q-01 | 人机入口 | **仅 Trace 标识**；不做 `/ras`（v1.5 已定） |
| Q-02 | 是否订 UI WS | **否**（产品不依赖；历史走 Prisma） |
| Q-03 | FR-008 持久化 | 侧表 `RasAnomalyEvent` + **`/api/ingest/ras/v1/events`**（对齐 OTel ingest；不进 otel spool） |
| Q-04 | 静态 UI：删除目录 vs 保留文件但路由 410 | 停止挂载 + README 标明弃用；目录可移 `agent_ras/docs/legacy-ui` 或删 |
