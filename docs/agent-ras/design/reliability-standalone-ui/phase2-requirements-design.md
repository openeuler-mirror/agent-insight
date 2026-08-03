# AgentRAS 可靠性独立页面 — 需求设计

版本：v0.1  
最后更新：2026-07-28

> 文档类型：Phase2 需求设计 ｜ 关联 [Phase1](phase1-requirements-analysis.md)  
> 复杂度：Medium

---

## 导读

**定了什么** —— 新建独立导航分组"AgentRAS 可靠性"，内含可靠性追踪（故障统计 + Trace 列表 + 详情 + 节点跳转）和故障注入与评测（故障目录 + 注入配置 + mock 数据）；从链路追踪清理所有 RAS 标识。

**Review 重点**

- §1.2 设计决策（尤其 D-001 漂移说明、D-002 复用策略）
- §3 导航设计
- §4 可靠性追踪 UI
- §5 故障注入与评测 UI

---

## §1 设计概要

### 1.1 实现思路

```
侧栏 AGENT_GROUP
├── 仪表盘
├── Agent 管理
├── 运行观测 (OBSERVE_TREE)     ← 不变
├── AgentRAS 可靠性 (RAS_TREE)  ← 新增
│   ├── 可靠性追踪    /agent-ras/trace
│   └── 故障注入与评测 /agent-ras/fault-injection
├── 评测中心 (EVAL_TREE)
└── Skills 能力 (SKILLS_TREE)
```

1. **导航**：在 `AppSidebar.tsx` 中新增 `RAS_TREE`，插入 `AGENT_GROUP.items`。
2. **可靠性追踪**：复用 RasAnomalyEvent 数据 + AgentTraceView 组件，自建列表和统计。
3. **故障注入**：新建独立页面，纯 UI + mock 数据。
4. **清理**：从 `trace/page.tsx` 和 `TraceRasMarks.tsx` 移除 RAS 相关引用。

### 1.2 设计决策

| 编号 | 决策项 | 内容 | 理由 |
|------|--------|------|------|
| D-001 | 漂移声明 | 主动偏离 agent-ras-migration D-003（"无独立 RAS 页"），新建独立分组 | RAS 能力成熟，需要一等公民入口 |
| D-002 | 数据复用 | 可靠性追踪复用 RasAnomalyEvent 模型 + 现有 API；不新建表 | 数据已就绪，仅改变展示位置 |
| D-003 | 组件复用 | Trace 详情复用 AgentTraceView，在其基础上扩展异常节点高亮 | 避免重复造轮子 |
| D-004 | 故障注入数据 | 本期纯 mock，数据结构预留 `POST /api/agent-ras/fault-injection` 接口格式 | 快速出 UI，后续对接 |
| D-005 | 清理策略 | 从 trace/page.tsx 移除 RAS Badge 引用 + TraceRasMarks 使用 | 彻底解耦，不保留开关 |
| D-006 | locale | 在 `src/locales/{zh,en}.ts` 新增 4 个 key（分组名 + 2 个子页 + 统计标题） | 对齐现有国际化模式 |
| D-007 | 设计令牌 | 不引入新色板；故障统计图使用 `--primary` / `--color-*` 语义色 | NFR-002 + 设计系统约定 |

---

## §2 架构设计

### 2.1 模块变更总览

| 状态 | 模块 | 变更 |
|------|------|------|
| 🟡 | `src/components/shell/AppSidebar.tsx` | 新增 `RAS_TREE`，插入 `AGENT_GROUP.items` |
| 🟢 | `src/app/(main)/agent-ras/trace/page.tsx` | **新建**：可靠性追踪列表 + 统计 |
| 🟢 | `src/app/(main)/agent-ras/fault-injection/page.tsx` | **新建**：故障注入与评测 |
| 🟢 | `src/components/agent-ras/*` | **新建**：RAS 专用组件目录 |
| 🔴 | `src/app/(main)/trace/page.tsx` | **删减**：移除 RAS 相关引用 |
| 🔴 | `src/components/observe/TraceRasMarks.tsx` | **评估**：确认是否仍有其他调用方，若无则标记 deprecated |
| 🟡 | `src/locales/zh.ts` / `en.ts` | 新增 nav + page locale keys |

### 2.2 组件树（可靠性追踪）

```
/agent-ras/trace
├── PageContainer
│   ├── PageHeader (variant="management", title="可靠性追踪")
│   ├── FaultStatsPanel          ← 新建：故障类型统计（柱状/饼图 + 数字卡片）
│   ├── TraceFilterBar           ← 复用 observe/TraceFilterBar（精简版）
│   ├── RasTraceList             ← 新建：带故障标记的 Trace 列表
│   └── RasTraceDetail           ← 新建：Trace 详情（内嵌 AgentTraceView + 异常节点索引）
│       ├── AgentTraceView       ← 复用
│       └── FaultNodeIndex       ← 新建：异常节点跳转面板（侧边目录）
```

### 2.3 组件树（故障注入与评测）

```
/agent-ras/fault-injection
├── PageContainer
│   ├── PageHeader (title="故障注入与评测")
│   ├── PlatformSelector         ← 新建：平台切换（openjiuwen / opencode / hermes）
│   ├── FaultCatalog             ← 新建：故障类型目录（按类别分组）
│   ├── InjectionConfig          ← 新建：注入配置面板
│   │   ├── target selection
│   │   ├── fault parameters
│   │   └── single / batch toggle
│   └── InjectionHistory         ← 新建：注入历史列表（mock）
```

### 2.4 依赖方向

```
可靠性追踪 ──读──► GET /api/ingest/ras/v1/events (existing)
                  └──► RasAnomalyEvent + Execution join

故障注入   ──mock──► local state (reserved: POST /api/agent-ras/fault-injection)
```

---

## §3 导航设计

### 3.1 AppSidebar 变更

在 `AGENT_GROUP.items` 中，`OBSERVE_TREE` 之后插入 `RAS_TREE`：

```tsx
// src/components/shell/AppSidebar.tsx

const RAS_TREE: NavItem = {
    key: 'agent-ras',
    labelKey: 'nav.groupAgentRas',
    iconPath: ICON_RAS,  // 新建图标：盾牌样式
    children: [
        {
            key: 'agent-ras-trace',
            href: '/agent-ras/trace',
            labelKey: 'nav.rasTrace',
            iconPath: ICON_TRACE,  // 复用链路图标
            matchPrefixes: ['/agent-ras/trace'],
        },
        {
            key: 'agent-ras-fault-injection',
            href: '/agent-ras/fault-injection',
            labelKey: 'nav.rasFaultInjection',
            iconPath: ICON_FAULT,  // 复用故障图标
            matchPrefixes: ['/agent-ras/fault-injection'],
        },
    ],
};
```

`expandedTrees` 默认值新增 `'agent-ras'`。

### 3.2 导航图标

新建 `ICON_RAS`（盾牌形状，与 `ICON_OBSERVE` / `ICON_SKILLS` 等风格一致）：

```tsx
const ICON_RAS = (
    <path d="M7 1.5L2 4v4.5c0 3 2.5 4.5 5 5 2.5-.5 5-2 5-5V4L7 1.5z" />
);
```

> 与 `ICON_SECURITY` 用同一 shield path，RAS 的可靠性语义也借用盾牌。

### 3.3 Locale 新增

在 `src/locales/zh.ts` 的 `nav` 下新增：

```ts
nav: {
    // ... existing
    groupAgentRas: 'AgentRAS 可靠性',
    rasTrace: '可靠性追踪',
    rasFaultInjection: '故障注入与评测',
}
```

在 `src/locales/en.ts` 对应新增：

```ts
nav: {
    // ... existing
    groupAgentRas: 'AgentRAS Reliability',
    rasTrace: 'Reliability Tracing',
    rasFaultInjection: 'Fault Injection & Eval',
}
```

---

## §4 可靠性追踪 UI

### 4.1 页面布局

```
┌─────────────────────────────────────────────────────┐
│  PageHeader: 可靠性追踪                              │
├─────────────────────────────────────────────────────┤
│  FaultStatsPanel                                     │
│  ┌─────────┬─────────┬─────────┬─────────┐         │
│  │ thinking │ tool_err │ timeout  │ repeated │        │
│  │ _loop    │ or       │           │ _tool    │       │
│  │   12     │   8      │   3      │   5      │       │
│  └─────────┴─────────┴─────────┴─────────┘         │
├─────────────────────────────────────────────────────┤
│  TraceFilterBar (精简)                               │
├─────────────────────────────────────────────────────┤
│  RasTraceList                                        │
│  ┌──────────────────────────────────────────────┐   │
│  │ session-xxx │ thinking_loop │ 3m ago │ →    │   │
│  │ session-yyy │ tool_error    │ 5m ago │ →    │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### 4.2 FaultStatsPanel

顶部统计面板，展示各类故障的计数：

- 数据源：`GET /api/ingest/ras/v1/events?aggregate=byKind`
- 展示形式：水平排列的数字卡片（每类一个），左侧可选简易柱状图
- 交互：点击某类卡片 → 列表筛选到该类故障

### 4.3 RasTraceList

列表项展示字段：

| 列 | 来源 |
|----|------|
| Task ID | `Execution.taskId` |
| 故障类型 | `RasAnomalyEvent.anomalyKind`（中文 label） |
| 严重程度 | `RasAnomalyEvent.severity`（color-coded badge） |
| 时间 | `RasAnomalyEvent.ts` |
| 摘要 | `RasAnomalyEvent.summary`（截断） |
| 操作 | 点击展开详情 |

排序：默认按时间倒序。

### 4.4 RasTraceDetail（Trace 详情）

展开后复用 `AgentTraceView`，额外增加：

- **故障节点索引面板**（侧边栏）：列出所有异常节点的名称和位置，点击后 scroll into view
- **异常节点高亮**：在 `AgentTraceView` 的对应 node 上添加高亮边框/背景色（使用 `--color-amber-subtle` 语义色）
- 异常节点在 `AgentTraceView` 中通过 `RasAnomalyEvent` 的 `payloadJson` 中的节点标识定位

### 4.5 数据流

```
RasTraceList (fetch RasAnomalyEvents + join Execution)
  → 列表渲染 (anomalyKind / severity / summary / taskId)
  → 点击 → RasTraceDetail (fetch Session + Execution)
    → AgentTraceView (existing logic)
    → FaultNodeIndex (parse payloadJson for node positions)
```

---

## §5 故障注入与评测 UI

### 5.1 页面布局

```
┌──────────────────────────────────────────────────────────┐
│  PageHeader: 故障注入与评测                                │
├──────────────┬───────────────────┬───────────────────────┤
│ PlatformSel  │ FaultCatalog      │ InjectionConfig       │
│              │                   │                       │
│ ● openjiuwen │ ▼ 思考类          │ 单条注入              │
│ ○ opencode   │   thinking_loop   │ 故障: thinking_loop   │
│ ○ hermes     │   repeated_tool   │ 目标: session-xxx     │
│              │ ▼ 工具类          │ 参数: max_iter=3      │
│              │   tool_timeout    │                       │
│              │   tool_error      │ [注入]  [批量注入]    │
│              │ ▼ 通信类          │                       │
│              │   connection_lost │                       │
│              │   api_rate_limit  │                       │
├──────────────┴───────────────────┴───────────────────────┤
│  InjectionHistory (mock)                                 │
│  ┌──────────────────────────────────────────────────┐   │
│  │ #1 │ thinking_loop │ openjiuwen │ completed │ ... │   │
│  │ #2 │ tool_timeout  │ opencode   │ pending   │ ... │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

### 5.2 PlatformSelector

水平 tab 切换，列出所有支持的平台：

- openjiuwen（全量）
- opencode（薄插件）
- hermes（骨架）
- openclaw（骨架）

选中后影响 FaultCatalog（不同平台支持的故障类型不同）和 InjectionConfig（目标 Agent 列表）。

### 5.3 FaultCatalog

左侧可折叠目录，按类别分组：

| 类别 | 故障类型 |
|------|----------|
| 思考类 | thinking_loop、repeated_reasoning、hallucination_drift |
| 工具类 | tool_timeout、tool_error、repeated_tool、tool_output_parse_error |
| 通信类 | connection_lost、api_rate_limit、auth_expired |
| 资源类 | context_overflow、token_exhausted、memory_pressure |

每个故障类型显示名称、简介、严重等级（色标）。

### 5.4 InjectionConfig

右侧配置面板：

| 配置项 | 类型 | 说明 |
|--------|------|------|
| 注入模式 | toggle | 单条 / 批量 |
| 故障类型 | select（批量时为 multi-select） | 从 FaultCatalog 选择 |
| 目标 Agent | select / multi-select | 当前平台下的 Agent 列表 |
| 参数 | key-value editor | 故障特定参数（如 max_iter、timeout_ms） |
| 提交 | button | 调用注入 API（本期 mock 确认弹窗） |

### 5.5 Mock 数据结构

```ts
// 故障类型定义
interface FaultType {
    id: string;
    category: 'thinking' | 'tool' | 'communication' | 'resource';
    name: string;           // e.g. "thinking_loop"
    label: string;          // e.g. "思考循环"
    description: string;
    severity: 'critical' | 'warning' | 'info';
    platforms: string[];    // supported platform list
    params: FaultParam[];   // configurable params
}

// 注入历史
interface InjectionRecord {
    id: string;
    faultType: string;
    platform: string;
    target: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    createdAt: string;
    params: Record<string, unknown>;
}
```

---

## §6 清理链路追踪 RAS 标识

### 6.1 清理范围

| 文件 | 操作 |
|------|------|
| `src/app/(main)/trace/page.tsx` | 移除 `TraceRasListBadges` 引用、`useRasSummaries` hook 调用 |
| `src/components/observe/TraceRasMarks.tsx` | 检查是否还有其他调用方；若仅 trace/page.tsx 使用，标记 deprecated 并更新注释 |
| `src/components/observe/AgentTraceView.tsx` | 移除 RAS 面板嵌入（若有） |

### 6.2 清理后验证

- 链路追踪列表不再出现 RAS 徽章
- 链路追踪详情不再出现 RAS 面板
- 不影响 RasAnomalyEvent 表的数据写入（写路径不动）

---

## §7 风险与缓解

| 风险 | 缓解 |
|------|------|
| 链路追踪清理影响其他页面 | grep 所有 `TraceRas` / `rasSummary` 引用，确认范围 |
| 可靠性追踪列表性能 | 分页加载，不一次性拉全部 RasAnomalyEvent |
| 故障注入 mock 与实际 API 差异大 | mock 数据结构预留 `POST /api/agent-ras/fault-injection` 格式 |
| AgentTraceView 不支持节点跳转 | 增加 `scrollToNode` prop + `data-node-id` 标注 |

---

## §8 验收映射

| Phase1 | 落点 |
|--------|------|
| FR-001 | §3 导航设计 |
| FR-002 | §4.2 FaultStatsPanel |
| FR-003 | §4.4 RasTraceDetail |
| FR-004 | §5.3 FaultCatalog |
| FR-005 | §5.4 InjectionConfig |
| FR-006 | §5.4 批量 toggle |
| FR-007 | §5.2 PlatformSelector |
| FR-008 | §6 清理 |
| FR-009 | §5.5 Mock 数据结构 |
