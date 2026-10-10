# Agent Insight 接入 Goal Plus：全流程与状态流设计

- 状态：详细设计
- 关联文档：[需求分析](phase1-requirements-analysis.md) · [接口与数据设计](phase2-requirements-design.md) · [开发计划](phase3-development-plan.md)
- 交互原型：[集成后高保真页面](agent-insight-goal-plus-hifi.html)
- 最后更新：2026-09-03

## 1. 阅读说明

本文专门回答“Agent Insight 修改后如何完整观察 Goal Plus”这一问题。图中的边界和颜色含义如下：

- **Goal Plus 边界**：仍负责目标拆解、候选运行、选择和结果固化，不承担观测平台职责。
- **Agent Insight 本地边界**：负责显式挂载、只读解析、被动导入、检查点、缓冲和上传。
- **Agent Insight 服务端边界**：负责幂等入库、关联、完整性计算和聚合查询。
- **Native trace**：Codex/Pi 原生执行事件；保留宿主自己的父子调用树。
- **Semantic snapshot**：来自 `.gp` 的 goal/run/candidate/selection 等权威状态快照。
- **Composite view**：查询时拼装出的 Goal Plus 编排视图，不制造新的伪 Execution 树。

## 2. 系统上下文与职责边界

```mermaid
flowchart LR
    USER["用户 / 运维人员"]
    GP["Goal Plus\n编排与 durable state"]
    CX["Codex agent\n原生 trace"]
    PI["Pi agent\n原生 session JSONL"]

    subgraph LOCAL["Agent Insight 本地侧"]
        ATTACH["Source Manager\n显式挂载 .gp"]
        SEM["Semantic Collector\n只读解析快照"]
        PII["Pi Passive Importer\n被动转换原生会话"]
        OTEL["现有 OTel SDK / Spool"]
        SPOOL["Semantic Spool\ncheckpoint + retry"]
    end

    subgraph SERVER["Agent Insight 服务端"]
        INGEST["Semantic Ingest API"]
        TRACEAPI["现有 OTLP Ingest API"]
        DOMAIN["Goal Plus Domain Tables"]
        EXEC["Execution / Event Tables"]
        LINK["GoalPlusExecutionLink"]
        QUERY["Composite Query Service"]
        UI["Goal Plus Observability UI"]
    end

    USER -->|"执行 goal-plus 或查看结果"| GP
    GP -->|"启动"| CX
    GP -->|"启动 --no-extensions"| PI
    GP -->|"写入 .gp JSON/JSONL"| ATTACH
    CX -->|"现有 hooks / OTel"| OTEL
    PI -->|"保存 native session"| PII
    ATTACH --> SEM --> SPOOL --> INGEST --> DOMAIN
    PII -->|"canonical pi-agent events"| OTEL
    OTEL --> TRACEAPI --> EXEC
    DOMAIN --> LINK
    EXEC --> LINK
    DOMAIN --> QUERY
    EXEC --> QUERY
    LINK --> QUERY --> UI --> USER
```

关键约束：Agent Insight **不注入** Goal Plus worker、不修改 `.gp`、不把 Goal Plus 伪装成第三种 agent framework；Goal Plus 只是编排覆盖层。

## 3. 部署拓扑与信任边界

```mermaid
flowchart TB
    subgraph HOST["用户工作站 / CI Runner"]
        subgraph WORKSPACE["项目工作区"]
            GPDIR[".gp/\ngoals · runs · candidates · sessions"]
            PISESSION["Pi native session store"]
        end
        subgraph AISDK["~/.agent-insight"]
            CFG["sources.json\n仅本地保存绝对路径"]
            COL["goal-plus-collector"]
            SEMQ["semantic/pending"]
            OTLPQ["otel_data queue"]
        end
        CODEX["Codex runtime + Agent Insight hooks"]
    end

    subgraph NET["TLS + API Key"]
        SAPI["/api/ingest/goal-plus/v1/snapshots"]
        OAPI["现有 OTLP endpoints"]
    end

    subgraph CLOUD["Agent Insight Server"]
        PG[("PostgreSQL\nsemantic + execution + link")]
        API["REST / Query APIs"]
        WEB["Web UI"]
    end

    GPDIR -->|"read-only"| COL
    PISESSION -->|"read-only"| COL
    CFG --> COL
    COL --> SEMQ --> SAPI --> PG
    COL --> OTLPQ --> OAPI --> PG
    CODEX --> OTLPQ
    PG --> API --> WEB
```

信任边界规则：

1. `.gp` 绝对路径不得上传；服务端只保存 `source_id`、可选标签和不可逆 workspace fingerprint。
2. collector 按现有 API key 隔离本地缓冲；文件内容按 `metadata-only`、`bounded`、`full` 策略裁剪。
3. 本地文件权限、符号链接和路径穿越必须在打开文件前校验；只允许读取已 attach 根目录及声明的 Pi session 文件。
4. 服务端不根据时间窗口猜测关联；证据不足时保留 `unresolved`。

## 4. 端到端主流程

```mermaid
sequenceDiagram
    autonumber
    actor U as 用户
    participant GP as Goal Plus
    participant FS as .gp durable state
    participant C as AI Goal Plus Collector
    participant N as Native Trace Pipeline
    participant S as Agent Insight Server
    participant Q as Composite Query
    participant UI as Web UI

    U->>C: attach workspace/.gp --watch
    C->>FS: 校验结构、权限和 schema
    C-->>U: source 已挂载 + self-check 结果
    U->>GP: 执行目标
    par 语义状态链路
        GP->>FS: 写 goal/run/candidate/session 快照
        FS-->>C: 文件变更通知
        C->>C: 稳定性等待 + 解析 + 规范化 + 去重
        C->>S: snapshot batch + revision + checksum
        S->>S: 幂等 upsert domain tables
    and 原生执行链路
        GP->>N: 启动 Codex/Pi worker
        N->>S: Execution / Event / Token / Tool traces
        S->>S: 幂等写入 execution tables
    end
    S->>S: 关联 exact native IDs / task names / session IDs
    S->>S: 计算 completeness 与 fidelity
    U->>UI: 打开 Goal Plus 详情
    UI->>Q: goal graph + linked executions + quality
    Q->>S: 聚合查询
    S-->>Q: semantic + native + links
    Q-->>UI: composite Goal Plus trace
    UI-->>U: 候选对比、事件流、缺口与证据
```

## 5. Source 挂载、扫描与监听流程

```mermaid
flowchart TD
    START(["attach --root <workspace/.gp>"])
    ABS["解析真实路径 realpath"]
    SAFE{"目录存在、可读且不是危险链接？"}
    LAYOUT{"识别到支持的 .gp layout/schema？"}
    DUP{"workspace fingerprint 已挂载？"}
    SAVE["生成 source_id\n写本地 sources.json"]
    BASE["执行基线全量扫描"]
    WATCH{"是否启用 --watch？"}
    SUB["建立文件监听\n并启动低频 reconciliation scan"]
    DONE(["source=healthy"])
    REJECT(["拒绝挂载并返回可操作错误"])
    RETURN(["返回现有 source 并允许更新配置"])

    START --> ABS --> SAFE
    SAFE -- "否" --> REJECT
    SAFE -- "是" --> LAYOUT
    LAYOUT -- "否" --> REJECT
    LAYOUT -- "是" --> DUP
    DUP -- "是" --> RETURN
    DUP -- "否" --> SAVE --> BASE --> WATCH
    WATCH -- "是" --> SUB --> DONE
    WATCH -- "否" --> DONE
```

监听器只负责低延迟提示；周期 reconciliation scan 才是漏事件、编辑器原子替换和 collector 重启后的最终兜底。

## 6. Semantic snapshot 采集与幂等流程

```mermaid
flowchart TD
    EVENT["文件变化或 reconciliation 命中"]
    ALLOW{"路径位于 attach root 且类型允许？"}
    STABLE["等待 mtime/size 稳定\n避免读取半写文件"]
    READ["受限读取\nsize/time budget"]
    PARSE{"JSON/JSONL 可解析？"}
    MAP["映射 canonical semantic model"]
    VALID{"schema + referential checks 通过？"}
    HASH["计算 entity key、revision、checksum"]
    SAME{"checkpoint checksum 相同？"}
    QUEUE["原子写入 semantic/pending"]
    SEND["批量 POST snapshots"]
    ACK{"服务端逐项 ACK？"}
    CP["提交 checkpoint\n移除 pending item"]
    RETRY["保留 pending\n指数退避 + jitter"]
    QUAR["进入 rejected/quarantine\n记录诊断，不阻塞其他实体"]
    SKIP(["忽略"])

    EVENT --> ALLOW
    ALLOW -- "否" --> SKIP
    ALLOW -- "是" --> STABLE --> READ --> PARSE
    PARSE -- "否" --> QUAR
    PARSE -- "是" --> MAP --> VALID
    VALID -- "否" --> QUAR
    VALID -- "是" --> HASH --> SAME
    SAME -- "是" --> SKIP
    SAME -- "否" --> QUEUE --> SEND --> ACK
    ACK -- "成功/已存在" --> CP
    ACK -- "临时失败" --> RETRY --> SEND
    ACK -- "永久拒绝" --> QUAR
```

幂等键建议为 `tenant_id + source_id + entity_type + source_entity_id + revision`。同 revision 但 checksum 不同必须标记 source conflict，不能静默覆盖。

## 7. Codex 原生 trace 与关联流程

```mermaid
sequenceDiagram
    autonumber
    participant GP as Goal Plus
    participant CX as Codex Worker
    participant HK as Existing Agent Insight Hooks
    participant OT as OTLP Pipeline
    participant DB as Execution Store
    participant SEM as Goal Plus Domain Store
    participant L as Link Resolver

    GP->>CX: 创建 main/candidate/final-checker task
    Note over GP,CX: Goal Plus 持久化 native task name / thread ID / candidate ID
    CX->>HK: model、tool、skill、subagent 生命周期事件
    HK->>OT: canonical Codex spans/events
    OT->>DB: 写 Execution 与 Event
    GP->>SEM: `.gp` snapshot 被 collector 同步
    SEM->>L: semantic entity + native references
    DB->>L: execution identity index
    L->>L: 按 exact ID / deterministic task name 匹配
    alt 唯一且证据充分
        L->>DB: 创建 confirmed GoalPlusExecutionLink
    else 多个匹配或证据冲突
        L->>DB: 创建 ambiguous diagnostic，不建立 confirmed link
    else 暂未到达
        L->>L: unresolved，等待后续增量重试
    end
```

Codex 路径复用现有 hooks，Goal Plus 不需要额外注入 SDK。关联是服务端组合关系，不修改原生 Execution 的 `parent_execution_id`。

## 8. Pi `--no-extensions` 被动导入流程

```mermaid
sequenceDiagram
    autonumber
    participant GP as Goal Plus
    participant PI as Pi Worker --no-extensions
    participant PS as Pi Session Store
    participant FS as .gp Session Metadata
    participant C as Pi Passive Importer
    participant OT as Existing OTLP Ingest
    participant DB as Execution Store

    GP->>PI: 启动候选 worker
    PI->>PS: 写 native session JSONL
    GP->>FS: 写 session path/id、candidate、iteration、status
    C->>FS: 读取 session 元数据
    C->>C: 路径约束与 workspace ownership 校验
    C->>PS: 从 byte offset/checkpoint 增量读取
    loop 每条 native record
        C->>C: 解析 pi-agent canonical event
        C->>C: 生成 deterministic event_id
        C->>OT: 上报 execution/event batch
    end
    OT->>DB: 幂等 upsert
    C->>C: 仅在 ACK 后推进 offset
    Note over C,DB: 原始时间缺失时 timing_fidelity=derived，不能伪报 exact
```

该流程保留 Goal Plus 对 worker 的隔离意图：不加载 extension、不修改启动参数，只消费 worker 已经保存的原生会话。

## 9. 关联判定流程

```mermaid
flowchart TD
    E["待关联 semantic entity"]
    ID{"存在 native execution/thread/session ID？"}
    IDM["按 tenant + framework + native ID 查询"]
    ONE{"唯一匹配？"}
    NAME{"存在 deterministic task name？"}
    NAMEM["按 workspace + task name + role 查询"]
    CONSIST{"候选、迭代、role 与时间边界一致？"}
    LINK["confirmed link\nmethod + confidence + evidence"]
    WAIT["unresolved\n等待 native/semantic 另一侧到达"]
    AMB["ambiguous\n记录候选集合和冲突诊断"]
    NEVER["禁止仅按时间窗口自动确认"]

    E --> ID
    ID -- "是" --> IDM --> ONE
    ONE -- "是" --> CONSIST
    ONE -- "否：0" --> NAME
    ONE -- "否：多条" --> AMB
    ID -- "否" --> NAME
    NAME -- "是" --> NAMEM --> CONSIST
    NAME -- "否" --> WAIT
    CONSIST -- "是" --> LINK
    CONSIST -- "否：冲突" --> AMB
    WAIT -. "诊断提示" .-> NEVER
    AMB -. "人工排查" .-> NEVER
```

建议的证据优先级：native ID/session ID > Goal Plus 生成的 deterministic task name > 明确写入的 workspace/role/candidate 复合键。时间只能用于冲突校验和展示，不能独立生成 confirmed link。

## 10. 完整性与时间保真度状态机

```mermaid
stateDiagram-v2
    [*] --> SemanticOnly: 首个 .gp snapshot
    [*] --> NativeOnly: 首个 native Execution
    SemanticOnly --> Linking: native trace 到达
    NativeOnly --> Linking: semantic snapshot 到达
    Linking --> Complete: 所有预期角色与迭代已关联
    Linking --> Partial: 缺少事件、角色或关联
    Partial --> Linking: 新数据到达 / reconciliation
    Complete --> Complete: 幂等更新
    Complete --> Partial: 权威 snapshot 增加新的预期项
    SemanticOnly --> Stale: 超过等待阈值
    NativeOnly --> Stale: 超过等待阈值
    Partial --> Stale: 长时间无进展
    Stale --> Linking: 手动重扫 / 新数据到达
```

完整性计算不能只看“是否有 trace”。每个 Goal 需要分别计算：

```text
semantic_coverage = observed_semantic_entities / expected_semantic_entities
native_coverage   = linked_native_executions / expected_native_executions
event_coverage    = observed_required_event_categories / required_event_categories
link_coverage     = confirmed_links / expected_links

overall_completeness = weighted_min_or_policy(
  semantic_coverage,
  native_coverage,
  event_coverage,
  link_coverage
)
```

UI 同时显示独立的 fidelity：

| 维度 | 值 | 解释 |
|-|-|-|
| 时间 | `exact` / `mixed` / `derived` | native 记录是否带可靠时间；不得由完整性百分比掩盖 |
| 内容 | `full` / `bounded` / `metadata-only` | 由采集策略决定，不等同于数据缺失 |
| 关联 | `confirmed` / `ambiguous` / `unresolved` | 是否存在可审计证据 |
| 顺序 | `native` / `reconstructed` | 事件顺序来自原生序号还是导入时重建 |

## 11. 查询与界面渲染流程

```mermaid
flowchart LR
    PAGE["/goal-plus/:goalId"]
    GAPI["GET goal overview"]
    CAPI["GET candidate matrix"]
    TAPI["GET composite trace"]
    QAPI["GET data quality"]
    DAPI["GET provenance / diagnostics"]

    subgraph AGG["Composite Query Service"]
        AUTH["tenant/source authorization"]
        SEM["semantic graph query"]
        NAT["linked native trace query"]
        MERGE["stable ordering + overlay assembly"]
        REDACT["content policy + redaction"]
    end

    subgraph UI["Agent Insight Goal Plus 页面"]
        OVER["概览\nKPI + 目标生命周期"]
        COMP["候选对比\niteration lanes"]
        TRACE["原生 Trace\n树 + 事件详情"]
        QUALITY["数据质量\ncoverage + fidelity"]
        FLOW["数据流\nprovenance + diagnostics"]
    end

    PAGE --> GAPI & CAPI & TAPI & QAPI & DAPI
    GAPI & CAPI & TAPI & QAPI & DAPI --> AUTH
    AUTH --> SEM
    AUTH --> NAT
    SEM --> MERGE
    NAT --> MERGE --> REDACT
    REDACT --> OVER & COMP & TRACE & QUALITY & FLOW
```

页面遵循渐进展开：默认先回答“Goal 是否成功、选了谁、为何选择、数据是否完整”；只有进入“原生 Trace”才展示模型调用、工具和 subagent 的细节。

## 12. 故障、重试与恢复流程

```mermaid
flowchart TD
    F{"故障类型"}
    PARSE["单文件解析失败"]
    NET["网络/API 临时失败"]
    AUTH["401/403 或 source 禁用"]
    CONFLICT["同 revision checksum 冲突"]
    MISSING["native session 被清理/移动"]
    CRASH["collector 崩溃或主机重启"]

    Q["隔离坏记录\n继续处理其他实体"]
    BACK["pending 保留\n指数退避"]
    PAUSE["暂停上传\n保留本地数据并告警"]
    DIAG["标记 source conflict\n禁止覆盖"]
    PARTIAL["标记 partial + missing reason"]
    RECOVER["读取 checkpoint\n重放 pending + reconciliation scan"]
    HEALTH["source health / diagnostics API"]

    F --> PARSE & NET & AUTH & CONFLICT & MISSING & CRASH
    PARSE --> Q --> HEALTH
    NET --> BACK --> HEALTH
    AUTH --> PAUSE --> HEALTH
    CONFLICT --> DIAG --> HEALTH
    MISSING --> PARTIAL --> HEALTH
    CRASH --> RECOVER --> HEALTH
```

恢复设计遵循 at-least-once 上传和服务端幂等：checkpoint 只能在服务端 ACK 后推进；任何进程终止点都允许安全重放。

## 13. 页面交互状态流

```mermaid
stateDiagram-v2
    [*] --> Overview
    Overview --> CandidateCompare: 点击候选对比
    CandidateCompare --> IterationDetail: 选择候选/迭代
    IterationDetail --> NativeTrace: 查看对应原生 Trace
    NativeTrace --> EventDetail: 选择模型/工具/验证事件
    EventDetail --> NativeTrace: 返回事件列表
    NativeTrace --> DataQuality: 查看完整性徽标
    DataQuality --> DataFlow: 查看来源与关联证据
    DataFlow --> NativeTrace: 打开 linked execution
    CandidateCompare --> Overview: 返回概览
    DataQuality --> Overview: 返回概览
```

高保真原型实现了上述主路径中的标签切换、候选/迭代选择、Trace 节点选择和明暗主题切换；生产实现再接入真实 API、URL 路由和分页。

## 14. 开发完成后的端到端验收流

```mermaid
flowchart TD
    FIXTURE["准备含 Codex + Pi 的 Goal Plus fixture"]
    ATTACH["attach .gp + self-check"]
    RUN["运行 2 candidates × 2 iterations + final checker"]
    WAIT["等待 semantic/native queues drain"]
    DB["检查 domain、execution、link 幂等记录"]
    UI["打开 Goal Plus 详情页"]
    ASSERT1{"Goal/run/candidate/selection 一致？"}
    ASSERT2{"Codex/Pi trace 可逐层展开？"}
    ASSERT3{"token/tool/model/skill 指标可追溯？"}
    ASSERT4{"completeness/fidelity 与证据一致？"}
    RESTART["重启 collector 并重复 scan"]
    IDEM{"记录数和关联无重复？"}
    PASS(["验收通过"])
    FAIL(["阻断发布并保留诊断包"])

    FIXTURE --> ATTACH --> RUN --> WAIT --> DB --> UI --> ASSERT1
    ASSERT1 -- "否" --> FAIL
    ASSERT1 -- "是" --> ASSERT2
    ASSERT2 -- "否" --> FAIL
    ASSERT2 -- "是" --> ASSERT3
    ASSERT3 -- "否" --> FAIL
    ASSERT3 -- "是" --> ASSERT4
    ASSERT4 -- "否" --> FAIL
    ASSERT4 -- "是" --> RESTART --> IDEM
    IDEM -- "否" --> FAIL
    IDEM -- "是" --> PASS
```

验收结论只有在语义链路、两种 native trace、关联证据、恢复幂等和 UI 解释性同时通过时，才能声明 Agent Insight “完整采集”本次 Goal Plus 执行。

## 15. 结论

该集成可以做到完整且可审计，但“完整”必须定义为两条链路的组合：

1. `.gp` 提供 Goal Plus 的编排语义真相；
2. Codex hooks 和 Pi passive importer 提供 agent 的原生执行真相；
3. link resolver 用强证据把两者连接起来；
4. completeness 与 fidelity 明确暴露缺口，不用推断数据冒充原生事实。

只采 `.gp` 无法还原所有模型、工具和 token 事件；只采 OTLP 又无法解释候选、迭代、选择和 promotion。以上双链路方案是 Agent Insight 接入 Goal Plus 后形成完整观测面的必要条件。
