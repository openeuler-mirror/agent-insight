# Patterns — 页面骨架与交互行为

> **目录**：页面骨架 → 6 类页面模板 → PageHeader 锚定结构 → 长文本规范 → 导航 → 列表/详情/表单/反馈/危险操作交互 → 键盘可达 → 状态持久化 → 长任务 → 多用户 → 文案 → 多步骤 Wizard → 四条铁律 → PR Checklist → 后期治理
>
> **本文件覆盖**：页面级与交互级——页面长什么样、用户怎么操作、状态怎么持久化。
> **基础视觉规则**：见 [`foundations.md`](./foundations.md)。
> **组件契约**：见 [`components.md`](./components.md)。

---

## 1. 页面骨架与 6 类模板

### A.1 顶层布局

```
┌──────────────────────────────────────────────────────────┐
│  AppTopBar    (h=48,  sticky, z=20)                      │
├──────────┬───────────────────────────────────────────────┤
│          │                                               │
│ Sidebar  │   <PageContainer>                             │
│ (w=240,  │     PageHeader                                │
│  56 折叠)│     PageToolbar                               │
│          │     PageContent                               │
│          │     PageFooter                                │
│          │                                               │
└──────────┴───────────────────────────────────────────────┘
```

- **AppTopBar 高度 48px**（向下取整到 8px 网格）。包含：Logo / 全局搜索 (Cmd+K) / 主题切换 / 用户菜单 / 帮助。
- **Sidebar**：默认展开 240px、折叠 56px；一级导航 ≤ 7 项；超过下沉到二级。
- **Sidebar 背景** 比主背景略深一点（`--sidebar-bg`），自然形成纵向分割，无需 1px 边框。
- **Page 区**：用 `<PageContainer>` 统一控制宽度与 padding（见本文件 §1 后续"页面容器"小节）。
- 🚫 **全站禁止页面级居中**：所有页面在 Sidebar 右侧的工作区必须**左对齐铺满**，**禁止**对整页内容使用 `mx-auto + max-w-*`。表单类页面通过"字段限宽 + 右侧辅助卡片"实现可读性，而不是靠居中。这是为了解决项目里"有的页面铺满、有的页面居中"造成的视觉割裂（典型反例：早期"安装指导"页 max-w-960px 居中，与"Skill 分析"铺满布局完全不一致）。

### A.2 页面三段式模板

```tsx
<PageContainer>
  <PageHeader
    breadcrumbs={[...]}
    icon={ModuleIcon}
    title="..."
    variant="management | detail | live"
    action={{ label: '...', onClick: ... }}        // management / detail
    live={{ lastUpdate, refreshRate, ... }}        // live 专用
    description="..."
    banner={{ variant: 'info', message: '...' }}   // 可选
    metaStrip={{ kind: 'kpi' | 'filter' | 'tabs', ... }}  // 可选
  />
  <PageToolbar>{/* SearchInput, FilterChips, DateRange, ViewSwitch */}</PageToolbar>
  <PageContent>{/* List / Table / CardGrid / Detail / Form */}</PageContent>
  <PageFooter>{/* Pagination */}</PageFooter>
</PageContainer>
```

> **PageHeader 完整契约见 §A.5**——六个槽位 + 三种变体覆盖列表/详情/表单/Dashboard/流式/画布所有页面类型。**禁止**任何页面自己用 `<h1>` + flex 拼 header。

不允许页面自己写 `<div style={{padding:...}}>` 包裹整页。

### A.3 信息密度分级（Observability 关键能力）

| 级别 | 适用场景 | 行高 | 字号 | 卡片 padding |
| --- | --- | --- | --- | --- |
| **Comfort** | 详情 / 表单 / Settings | 48px | text-base 14/20 | 20×16 |
| **Compact**（默认） | 列表 / Skills / Eval | 36px | text-sm 12/18 | 16×12 |
| **Dense** | Trace / Trajectory / Logs | 28px | text-xs 11/16 | 12×8 |

由 `<DataTable density>` 控制，不允许各页面手写行高。

### A.4 页面布局模板（同类页面必须长一样）

> **核心目标：减少学习成本**。一个用户在 `/skills` 学会的列表交互，到 `/eval`、`/dataset`、`/trace` 必须能直接复用——同一种功能在所有页面**长得一样、操作位置一样、术语一样**。
> 我们把全站页面归为 **6 类模板**，新页面必须选其一，不允许自创布局。

#### 模板 1：列表页（List Page）

适用：`/skills`、`/eval`、`/dataset`、`/trace`、`/quality`、`/agents`、`/skill-history`、`/skill-release`、`/skill-debug`、`/accessconfig`、`/modelconfig/registry` 等。

```
┌─────────────────────────────────────────────────────────────┐
│ PageHeader        [Title]  [Breadcrumbs]      [Primary Btn] │  ← 主操作右上
├─────────────────────────────────────────────────────────────┤
│ PageToolbar  [🔍 Search]  [Filter chips]  [DateRange] [⚙ ⊞] │  ← 视图切换右
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   <DataTable density="compact">                             │
│     ☐  Name   Status   Owner   Updated   ⋯                  │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│ PageFooter           共 N 条     <Pagination>      20条/页  │
└─────────────────────────────────────────────────────────────┘
```

**位置约定（不允许偏移）**：
- 主操作（New / Upload / Import）→ PageHeader **右上**。
- 搜索框 → PageToolbar **左**，宽度 `w-72`（288px）。
- 筛选 chips → 搜索框右侧，按"高频在前"排列。
- 视图切换 / 密度切换 / 列设置 → PageToolbar **右**。
- 批量操作 → 选中行后从 PageToolbar 顶部滑入（不要塞底部、不要弹窗）。
- 分页 → PageFooter 右；左侧显示总数。

#### 模板 2：详情页（Detail Page）

适用：`/skill-detail/[id]`、`/eval/run/[runId]`、`/dataset/[id]`、`/evaluation/[id]` 等。

```
┌─────────────────────────────────────────────────────────────┐
│ Breadcrumbs:  Skills / Foo / v3                             │
│ PageHeader  [Title + StatusBadge]   [Run] [⋯ More]          │  ← 状态紧贴标题
├─────────────────────────────────────────────────────────────┤
│ Tabs (underline):  Overview · Versions · Runs · Settings    │  ← Tab 写 URL
├─────────────────────────────────────────────────────────────┤
│ TabContent                                                  │
│  ┌──────────────────────┬────────────────────────────────┐  │
│  │ Card: 概览数据         │ Card: 关联实体                  │  │
│  │  - Description        │  - Used by Agents              │  │
│  │  - Metadata           │  - Datasets                    │  │
│  │  - Tags               │                                │  │
│  └──────────────────────┴────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**位置约定**：
- 标题旁紧贴 `<StatusBadge>`，不要单独列一行。
- 主操作（Run / Publish / Save）→ PageHeader 右上；次操作进 `…` Overflow Menu。
- 编辑模式只允许 1 种：要么字段级 inline（单击进入），要么集中"编辑模式 + sticky FormFooter"，不允许同页混用。
- 关联实体放右侧（一般 1/3 宽），主信息放左侧（2/3 宽）。

#### 模板 3：表单页 / 设置页 / 帮助引导页（Form / Settings / Guide）

适用：`/modelconfig`、`/optapi`、`/security`、`/memory`、`/fault`、`/login`、`/accessconfig/install`（安装指导）等。

```
┌─────────────────────── PageContainer (w-full, 铺满) ────────┐
│ Breadcrumbs                                                 │
│ PageHeader   [Title]   [副标题/说明]                          │
├─────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────┐  ┌──────────────────────────┐   │
│ │ 主体内容（max-w-xl）       │  │ 辅助卡片（可选）           │   │
│ │ 左对齐，不居中             │  │ - 相关文档                │   │
│ │                          │  │ - 状态指示                │   │
│ │ Section 1 标题            │  │ - 快捷链接                │   │
│ │   Field A  [_______]     │  └──────────────────────────┘   │
│ │   Field B  [_______]     │                                │
│ │                          │                                │
│ │ Section 2 标题            │                                │
│ │   Field D  [_______]     │                                │
│ └─────────────────────────┘                                 │
├─────────────────────────────── sticky footer ───────────────┤
│                                  [Discard]  [Save changes]  │  ← 改动后才高亮
└─────────────────────────────────────────────────────────────┘
```

**位置约定**：
- **容器铺满**：统一 `<PageContainer variant="default">`，**禁止** `max-w-* mx-auto` 居中。
- **字段限宽不限容器**：表单字段在主体区用 `max-w-xl`（≈ 576px）左对齐限宽（保证可读），但容器本身仍然铺满。
- 单列表单（field 一行一条），除非两个 field 强相关（如开始-结束时间）。
- 必填在前 / 高频在前 / 选填和高级折叠在 `<Collapsible>` 内。
- 右侧空间放**辅助卡片**（文档链接、状态卡、近期记录），让空间不浪费、信息更密集；没有合适内容时**留空**也比居中好。
- 保存按钮 → 底部 sticky `<FormFooter>`，未修改时 disabled，修改后亮起；Footer 也是铺满，按钮右对齐。
- 表单未保存时跳走必须 `<ConfirmDialog>` 拦截。

**典型反例（截图 2 安装指导页的问题）**：

```tsx
// ❌ 整页居中，右侧 50% 空白
<div className="mx-auto max-w-[960px] px-6 py-6">
  <h1>客户端安装指导</h1>
  <CodeBlock>...</CodeBlock>
</div>

// ✅ 铺满容器 + 字段限宽 + 右侧辅助卡片填补
<PageContainer>
  <PageHeader title="安装指导" />
  <PageContent>
    <div className="grid grid-cols-12 gap-6">
      <div className="col-span-12 lg:col-span-8 max-w-xl space-y-6">
        {/* 安装命令、API Key、说明 */}
      </div>
      <aside className="col-span-12 lg:col-span-4 space-y-4">
        <Card>{/* 相关文档 */}</Card>
        <Card>{/* 健康检查状态 */}</Card>
        <Card>{/* 联系支持 */}</Card>
      </aside>
    </div>
  </PageContent>
</PageContainer>
```

#### 模板 4：Dashboard / 看板页

适用：`/dashboard`、`/metrics`。

```
┌────────────────────── (max-w-[1600px], wide) ───────────────┐
│ PageHeader  [Title]               [DateRange] [Refresh ⟳]   │
├─────────────────────────────────────────────────────────────┤
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                          │  ← KPI 卡片一行 4
│ │ KPI1 │ │ KPI2 │ │ KPI3 │ │ KPI4 │                          │
│ └──────┘ └──────┘ └──────┘ └──────┘                          │
│ ┌────────────────────────┐ ┌────────────────────────────┐    │
│ │  Chart A (2x 宽)        │ │  Chart B                   │    │
│ └────────────────────────┘ └────────────────────────────┘    │
│ ┌─────────────────────────────────────────────────────────┐  │
│ │  Recent Activity Table (compact)                        │  │
│ └─────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**位置约定**：
- 时间区间筛选 → PageHeader 右上的 `<DateRangeFilter>`，状态写 URL。
- KPI 卡片高度统一 96px，一行 4 个；超过 4 个折行。
- 图表使用统一 `<ChartCard title actions>` 包装。
- 不允许在 Dashboard 上做"独立筛选器组件"，所有筛选都进 PageToolbar。

#### 模板 5：流式 / 时间轴页（Streaming / Trace / Trajectory）

适用：`/eval/trajectory`、`/eval/trajectory/[taskId]/trace`、`/skill-opt`（迭代步骤）、`/playground`。

```
┌─────────────────────────────────────────────────────────────┐
│ PageHeader  [Title + StatusBadge]   [Pause/Resume] [Stop ⏹]  │
├──────────────────────┬──────────────────────────────────────┤
│                      │                                      │
│  Steps Timeline      │   Step Detail (right pane)           │
│  (StreamingList)     │                                      │
│  ◯ Step 1            │   - Input                            │
│  ● Step 2 (running)  │   - Output                           │
│  ○ Step 3            │   - Token / Latency / Cost           │
│                      │                                      │
│                      │                                      │
│  ↓ Jump to latest    │                                      │
└──────────────────────┴──────────────────────────────────────┘
```

**位置约定**：
- 左右 1:2 比例（左侧 380px，右侧 flex）。
- 左侧 `<StreamingList>` 自动滚动开关 + 跳到最新按钮（浮动右下）。
- 顶部"停止 / 暂停"按钮固定位置，所有流式页面一致。
- 右侧详情切换不更新 URL（高频切换避免污染历史）。

#### 模板 6：画布 / 全屏可视化页（Canvas）

适用：`/skill-debug/grayscale`（流程图）、未来的 Trace 全屏视图。

```
┌─────────────────────────────────────────────────────────────┐
│ FloatingToolbar (top-left): [Back] [Title] [Mode]            │
│                                          [Fit] [+] [-] [⛶]   │
│                                                             │
│                  <Full-bleed Canvas>                        │
│                                                             │
│ FloatingInspector (right): 当前选中节点的属性                │
└─────────────────────────────────────────────────────────────┘
```

**位置约定**：
- 容器 `<PageContainer variant="canvas">`，padding=0。
- 工具栏使用浮层，不挤占画布空间。
- 缩放控件、适应屏幕按钮固定右下。
- 退出 / 返回入口在左上。

#### 模板选择决策树

```
新页面 → 主要展示什么？
 │
 ├── 多条记录 → 模板 1 列表页
 ├── 单条记录的细节 → 模板 2 详情页
 ├── 填表 / 配置 → 模板 3 表单页
 ├── 多指标全景 → 模板 4 Dashboard
 ├── 实时流式输出 → 模板 5 流式页
 └── 节点 / 流程图 / 大数据可视化 → 模板 6 画布页
```

> 如果你的页面不属于以上 6 种，**先停下来**，找 TL / 设计讨论，**不要自创第 7 种布局**。绝大多数"我需要新布局"的需求最后都被证明是"现有模板 + 一个新组件"。

---

### A.5 PageHeader 锚定结构（v1.3 新增 · 强制统一）

> **背景**：v1.3 之前 PageHeader 没有强制结构，导致 6 类模板里出现 3 种不同的 header 组装方式 —— 概览页把"实时刷新集群"硬塞进标题行、Skill 管理页把主操作和标题挤在一行、Agent 管理页又把通知 banner 放在 header 外。**结果是用户每切到一个新页面都要重新学习一次 header 长什么样**。
>
> 本节定义全产品**唯一的** PageHeader 结构 —— 6 个固定槽位 + 3 种互斥变体，覆盖列表/详情/表单/Dashboard/流式/画布 所有 6 类模板。任何页面**禁止自己拼 header**，必须 import `src/components/shell/PageHeader.tsx`。

#### A.5.1 视觉签名（PageHeader 的"指纹"）

PageHeader 是用户访问每个页面**第一眼看到的元素**，理应是产品识别度的高密度承载点。但按 §0.1 第 8 条 / §0.2 原则，**不允许**通过装饰元素来"加风格"。PageHeader 的签名来自三处**功能即风格**的细节：

1. **严格的字号阶梯**：eyebrow `text-xs` (11/16) → title `text-2xl` (24/32) → description `text-sm` (12/18)，三档刚好相差一个跳级，垂直节奏严格对齐 4px 网格。**任何页面把 title 写成 `text-lg` / `text-xl` / `text-3xl` 都是违规**。
2. **Breadcrumb 分隔符 ` › `（U+203A）**：而不是 `/` 也不是 `>`。颜色 `var(--primary) / 50%` —— 这是全产品**唯一**允许的"装饰性主色"使用点（§0.2 锚点之外的窄豁口，因为它承担"层级导航"的功能性）。`›` + 主色透明度是 PageHeader 在视觉记忆中的锚。
3. **主操作永远在标题行右上**：不论 management / detail / live 变体，标题行右侧是固定的"行动锚点"。用户在任意页面把视线扫到右上都能找到"我现在能做什么"。

> 这三条之外**禁止**给 PageHeader 加任何装饰（渐变下划线、彩色徽章、背景图、阴影特效）。签名的本质是"在所有页面**完全一样**"，而不是"做得多漂亮"。

#### A.5.2 六个固定槽位（自上而下）

```
┌─────────────────────────────────────────────────────────────────────┐
│ ① eyebrow       Skills  ›  管理本地与企业 Skill                       │  text-xs muted, ›=primary/50
│                                                                     │
│ ② title-row    [📦] Skill 管理  [Badge]                [Right cluster] │  text-2xl semibold + Right
│                                                                     │
│ ③ description  上传、版本化和分发 Agent Skill 包，供 Agent 按需加载   │  text-sm secondary, max 72ch
│                                                                     │
│ ───────────────────────────────────────────────────────  hairline   │  ④ 1px var(--border), full-bleed
│                                                                     │
│ ⑤ banner       ℹ️ 检测到 13 个未注册的 Agent…       [查看全部 →]      │  optional, full-width Alert
│                                                                     │
│ ⑥ meta-strip   [KPI Strip] OR [FilterBar] OR [Tabs]                  │  optional, sticky-able, 一行选一种
└─────────────────────────────────────────────────────────────────────┘
```

| 槽位 | 必填 | 内容契约 |
| --- | --- | --- |
| ① eyebrow | 必填 | `<Breadcrumbs>` 或 `<ModuleLabel>`，至少 1 项；首页除外 |
| ② title-row 左 | 必填 | 可选 16px 模块图标（lucide-react，`currentColor`）+ 标题文本 + 可选 inline `<StatusBadge>` / `<VersionTag>` |
| ② title-row 右 | 视变体 | 见 §A.5.3 三种变体 |
| ③ description | 选填 | ≤ 2 行；超 2 行用 `<ExpandableText>` |
| ④ hairline | 必填 | 不可隐藏；与下方内容物 24px 间距 |
| ⑤ banner | 选填 | 单个 `<Alert>`，info / warning / error 三种；多条要堆叠请改用页面级 NotificationCenter |
| ⑥ meta-strip | 选填 | 一行只能选一种：KPI Strip / FilterBar / Tabs；支持 `sticky` 让滚动后仍可见 |

#### A.5.3 三种变体（title-row 右侧 · 互斥）

| variant | title-row 右侧 | 适用模板 | 示例 |
| --- | --- | --- | --- |
| `management` | 1 个 `default` Button（主操作） | 模板 1 列表页 / 模板 3 表单页 | `+ 注册 Agent` `+ 上传 Skill` |
| `detail` | 1 个 `default` Button + 1 个 `ghost icon` 的 `⋯` Overflow Menu | 模板 2 详情页 | `Run` + ⋯（包含 Edit / Duplicate / Delete） |
| `live` | 实时集群：● 实时徽章 + 时间戳 + 刷新频率 + 暂停/继续按钮 | 模板 4 Dashboard / 模板 5 流式页 | 概览 / Trajectory |

实时集群（`variant="live"`）的精确组成：

```tsx
<div className="flex items-center gap-3">
  <StatusBadge status="running">实时数据</StatusBadge>         {/* 呼吸 dot + 文案，§0.2 锚点① */}
  <span className="font-mono tabular-nums text-xs text-foreground-muted">
    {format(lastUpdate, 'M/d HH:mm:ss')}
  </span>
  <button className="...">
    <RefreshIcon className="size-3.5" /> {refreshRate}    {/* 当前刷新频率，可点击切换 */}
  </button>
  <Button variant="ghost" size="sm" onClick={onTogglePause}>
    {paused ? <Play /> : <Pause />} {paused ? '继续' : '暂停'}
  </Button>
</div>
```

> 实时集群里的时间戳必须用 `font-mono tabular-nums`（§0.2 锚点③ 的延伸用法）——时间在跳的时候不能"跳格"，等宽字体是 Observability 产品的基本盘。

#### A.5.4 TypeScript 接口（实现契约）

```tsx
// src/components/shell/PageHeader.tsx
export interface PageHeaderProps {
  // 槽位 ① eyebrow（二选一，至少一个）
  breadcrumbs?: BreadcrumbItem[];          // 优先
  moduleLabel?: string;                    // breadcrumbs 缺席时的兜底

  // 槽位 ② title-row 左
  icon?: LucideIcon;                       // 16px brand icon
  title: string;
  badges?: ReactNode[];                    // inline StatusBadge / VersionTag

  // 槽位 ② title-row 右（互斥三选一）
  variant: 'management' | 'detail' | 'live';

  // management / detail 共用
  action?: {
    label: string;
    icon?: LucideIcon;
    onClick: () => void;
    disabled?: boolean;
  };

  // detail 专属
  moreMenu?: MoreMenuItem[];

  // live 专属
  live?: {
    label?: string;                        // 默认"实时数据"
    lastUpdate: Date;
    refreshRate: '1s' | '3s' | '5s' | '15s' | '30s' | '1m';
    onRefreshRateChange?: (rate: string) => void;
    paused: boolean;
    onTogglePause: () => void;
  };

  // 槽位 ③
  description?: string;

  // 槽位 ⑤
  banner?: {
    variant: 'info' | 'warning' | 'error';
    message: ReactNode;
    action?: { label: string; onClick: () => void };
  };

  // 槽位 ⑥（互斥三选一）
  metaStrip?:
    | { kind: 'kpi'; items: KpiItem[] }
    | { kind: 'filter'; children: ReactNode }
    | { kind: 'tabs'; items: TabItem[]; value: string; onChange: (v: string) => void };
  stickyMeta?: boolean;                    // 默认 false；列表页 + tabs 推荐 true
}
```

#### A.5.5 三张截图对照（v1.2 → v1.3 改造案例）

> 本节直接对应 v1.3 评审中提交的三张截图（概览 / Agent 管理 / Skill 管理）—— 它们是 v1.2 时期"三种 header 写法"的真实样本。下面给出**改造前 → 改造后**的精确对照。

**Case A · 概览页（`variant="live"`）**

```tsx
<PageHeader
  breadcrumbs={[{ label: 'Dashboard' }, { label: '概览' }]}
  icon={LayoutDashboardIcon}
  title="概览"
  variant="live"
  live={{
    lastUpdate: now,
    refreshRate: '3s',
    paused: false,
    onTogglePause: () => set(p => !p),
  }}
  description="聚合视图，按 Agent 类型 / 平台筛选并实时刷新"
  metaStrip={{
    kind: 'filter',
    children: (
      <>
        <Select label="平台" defaultValue="全部平台" />
        <Select label="Agent 类型" defaultValue="用户 Agent" />
      </>
    ),
  }}
/>
```

修正点：①标题升级到 `text-2xl`（v1.2 是非标小号）；②"实时数据 / 时间 / 3s / 暂停"从顶栏挪进 PageHeader 的 live 变体；③筛选条进 metaStrip，不再"挂在 PageHeader 外"。

**Case B · Agent 管理（`variant="management"`）**

```tsx
<PageHeader
  breadcrumbs={[{ label: 'Agents' }, { label: '管理已接入 Agent' }]}
  icon={BotIcon}
  title="Agent 管理"
  variant="management"
  action={{ label: '注册 Agent', icon: PlusIcon, onClick: openRegister }}
  description="Agent 管理模块汇聚了当前环境中运行的所有已接入 Agent 实例。您可以查看其运行状态、成功率指标，并进行全链路分析与故障分析。"
  banner={{
    variant: 'info',
    message: '检测到 13 个未注册的 Agent 正在运行 Trace，建议及时转化为正式资产。',
    action: { label: '查看全部', onClick: gotoUnregistered },
  }}
/>
```

修正点：①banner 进 PageHeader 的 banner 槽，不再"游离"在 header 和 filter card 之间；②"筛选与排序"卡片从这里移除 —— 列表页的 FilterBar 不再用"卡片包筛选"，改进 PageToolbar（§A.2）。

**Case C · Skill 管理（`variant="management"` + KPI Strip）**

```tsx
<PageHeader
  breadcrumbs={[{ label: 'Skills' }, { label: '管理本地与企业 Skill' }]}
  icon={PackageIcon}
  title="Skill 管理"
  variant="management"
  action={{ label: '上传 Skill', icon: UploadIcon, onClick: openUpload }}
  description="上传、版本化和分发 Agent Skill 包，供 Agent 在执行时按需加载。"
  metaStrip={{
    kind: 'kpi',
    items: [
      { label: 'Skills 总数', value: 3, sub: '当前可见' },
      { label: '运行中', value: 1, sub: '近 7d 有调用' },
      { label: '7 天调用量', value: 15, sub: '跨所有版本' },
      { label: '待优化项', value: 8, sub: '中/高风险', tone: 'warning' },
    ],
  }}
/>
```

修正点：①`+ 上传 Skill` 从"标题旁 inline"移到标题行右上（管理类页面的统一位置）；②KPI 4 卡进 PageHeader 的 metaStrip（kind=kpi），不再"漂在标题和搜索框之间无主"。

#### A.5.6 红线（CR 直接打回）

- ❌ 页面自己用 `<h1>` + flexbox 拼 header（哪怕"看起来一样"）
- ❌ 主操作 inline 写在标题旁（如 Skill 管理 v1.2 的 `<h1>Skill 管理 <Button>+ 上传</Button></h1>`）
- ❌ "实时刷新" / "暂停" 按钮塞进顶栏 AppTopBar（顶栏只允许全局操作）
- ❌ 把通知 banner 写在 PageHeader 之外的某个独立卡片里
- ❌ 自定义标题字号（必须 `text-2xl`，不允许 `text-xl` / `text-3xl`）
- ❌ Breadcrumb 用 `/` / `>` / `→`（必须 `›`，主色 50%）
- ❌ KPI Strip 自己写一个 grid（必须 `metaStrip.kind='kpi'`）
- ❌ 同一行 metaStrip 同时塞 filter 又塞 tabs（互斥）

#### A.5.7 与其他规范的关系

- 主操作 Button 的 variant / size 见 [`components.md`](./components.md) §2 "E.1 Button"
- StatusBadge / live 集群的呼吸态见 §0.2 锚点①
- KPI 项内数值排版必须走 `<MetricValue>`（§0.2 锚点③）
- Breadcrumbs 组件契约见 [`components.md`](./components.md) §2 "E.11 Breadcrumbs"
- PageContainer 包裹 PageHeader，禁止 PageHeader 自管 padding（§D.1）

---

---

## 2. 长文本与文本格式化规范

> **背景**：Observability 平台到处是长文本——Prompt、Skill 描述、LLM 输出、错误堆栈、JSON Payload、URL、ID、文件路径。如果不处理，列表会被一条长文本撑爆、详情页一片密密麻麻、用户根本读不下去。
> 本节是**强制规范**，所有承载用户文本的组件都必须遵守。

### L.1 长文本核心原则

1. **永远先截断、再让用户主动展开**——列表 / 卡片 / 表格里**不允许**直接铺出长文本。
2. **截断后必须保留"完整可达"的入口**——`...` 后必须有 Tooltip、详情面板、复制按钮或 Dialog 三选一。
3. **不要省略关键信息**——ID / 时间戳 / 状态等可独立完整的信息不允许截断；要截只截描述性长文本。
4. **任何用户文本都可以被原样复制**——`<CopyButton>` 必须可达。

### L.2 长文本截断策略（按场景选）

| 场景 | 截断方式 | 完整态入口 | 备注 |
| --- | --- | --- | --- |
| **列表 / 表格单元格** | 单行截断 `truncate` + `...` | Hover `<Tooltip>` 显示前 200 字 + 点击行进详情 | 单元格内不允许折行 |
| **卡片描述** | 多行截断 `line-clamp-2` 或 `line-clamp-3` | 卡片末尾 "查看详情 →" 进详情页 | 卡片高度必须固定 |
| **详情页正文（描述、说明）** | 默认收起到 6 行（约 120px 高） | "展开 ▾" 按钮原地展开 / "收起 ▴" | 用 `<ExpandableText maxLines={6}>` |
| **超长字段（Prompt / Markdown 内容）** | 显示前 N 行 + 渐变遮罩 | "查看完整内容" 按钮 → 弹出 `<Dialog>` 全屏可滚动 | 用 `<LongTextField>` |
| **JSON / 结构化数据** | `<JsonViewer collapsed depth={2}>` | 点击节点展开；右上"在新窗口打开"进 `<Sheet>` 全屏 | 永远不要把 JSON 字符串原样塞进 `<p>` |
| **错误堆栈 / Log** | 显示 Title + 第 1 行 message + 行数提示 `(共 N 行)` | "展开堆栈"原地展开 / "复制"按钮 | 用 `<ErrorDetail>` |
| **URL / 路径** | 中部省略 `https://example.com/.../path?query=...` | Hover Tooltip 完整 URL + `<CopyButton>` | 用 `<TruncateMiddle>` |
| **长 ID（cuid / uuid / hash）** | 头部 6 字符 + `...` + 尾部 4 字符（如 `abc123...d4f9`） | Hover 完整 ID + `<CopyButton>` | 用 `<IdChip>` |
| **文件名** | 中部省略，保留扩展名（`prompt_v3_final....md`） | Hover Tooltip + 复制 | 用 `<TruncateMiddle>` |
| **AI 流式输出** | 实时追加显示，超过 ~500 行启用虚拟滚动 | 顶部"跳到最新"按钮 | 不截断，但用虚拟列表 |

### L.3 关键组件契约（待建）

```tsx
// 单元格 / Tag 级别——一行截断 + Tooltip
<TruncateText maxLength={40}>{text}</TruncateText>

// 卡片描述——多行截断
<ClampText lines={2}>{text}</ClampText>

// 详情页正文——可展开
<ExpandableText maxLines={6}>{text}</ExpandableText>

// 超长字段——预览 + Dialog 全文
<LongTextField
  preview={text}
  full={fullText}
  title="完整 Prompt"
  language="markdown"
/>

// URL / 文件路径——中部省略
<TruncateMiddle head={20} tail={8}>{url}</TruncateMiddle>

// ID 显示——头尾保留
<IdChip value={id} copy />

// 错误堆栈
<ErrorDetail error={err} maxLines={3} />
```

所有以上组件都必须：

- 在截断处显示视觉提示（`...` 或渐变遮罩 `mask-image: linear-gradient(...)`）。
- 提供"复制完整内容"动作。
- 在 `<Dialog>` / `<Sheet>` 内显示时**不再截断**。

### L.4 文本格式化规范（让用户读得下去）

#### L.4.1 Markdown 内容

用户输入的 Skill 描述、Prompt、Eval 结果说明等普遍是 Markdown。展示时必须：

- 通过 `react-markdown` + `remark-gfm` + `rehype-katex` 渲染（已装包），**禁止**直接 `dangerouslySetInnerHTML`。
- 用 `<Prose>` 包装器（待建）应用 `prose` 排版样式（基于 Tailwind Typography 但替换为本项目 Token）：
  - 标题：H1-H4 走本项目字号 scale。
  - 段落最大宽度 72ch。
  - 列表与段落之间 12px 间隔。
  - 代码块用 `<CodeBlock>`，行内代码 `bg-background-tertiary px-1.5 rounded-sm`。
  - 表格走 `<DataTable>` 样式（避免与 Markdown 默认表格冲突）。
  - 链接走 `<ExternalLink>` 自动加 `↗` 图标。
  - 数学公式走 KaTeX。

#### L.4.2 JSON / 结构化数据

- 永远用 `<JsonViewer>`，**禁止** `JSON.stringify(obj, null, 2)` 塞进 `<pre>`。
- 默认 `depth=2` 折叠；用户可手动展开。
- 数字 / 字符串 / null / true 用不同 token 色（已落 design-tokens）。
- 大于 100 个键的对象自动启用虚拟滚动 + 搜索。
- 右上角固定"复制 JSON / 在新窗口打开"。

#### L.4.3 代码与 Diff

- 单行代码：`<code class="font-mono text-sm bg-background-tertiary px-1.5 rounded-sm">`。
- 多行代码：`<CodeBlock language="python" showLineNumbers copy>`。
- 版本对比 / Diff：`<DiffViewer split>` 基于 `diff` 包（已装）；新增绿、删除红、上下文灰，色块用 Subtle 不刺眼。
- 高亮主题统一：Light → GitHub Light、Dark → GitHub Dark。

#### L.4.4 时间

- 列表内默认相对时间 "10 分钟前"，Hover Tooltip 显示绝对时间 `2026-05-18 14:32:01 (UTC+8)`。
- 详情页默认绝对时间 + 相对时间副文本。
- 时间区间跨年时显示年份；同年不显示。
- 用 `<RelativeTime value>` 与 `<AbsoluteTime value tz>` 两个组件统一。

#### L.4.5 数值

- 大数值 K/M/B 压缩：`<MetricValue value={1234567} format="compact">` → `1.23M`。
- 百分比保留 1 位小数（`92.4%`），除非业务明确要求更高精度。
- 货币 / Token / Latency 必须带单位（小字号灰色）。
- 0 值不显示空白，显示 `0` 或 "—"（明确表达"零"vs"无数据"）。

#### L.4.6 列表 / 数组

- 列表项数 ≤ 5 时全展示；> 5 时显示前 5 项 + "还有 N 项"。
- 标签列表（tags / labels）超过 3 个：显示前 3 + `+N` 徽章，Hover 显示全部。
- 用 `<TagList items max={3}>`。

#### L.4.7 空值与 "—"

- 后端返回 `null` / `undefined` / `""` → 显示 `—`（em dash，灰色 `text-foreground-muted`）。
- 不要显示 `null`、`undefined`、`N/A`、`无` 字面文字。
- 显式"零值"显示数字 `0`，不与"无数据"混淆。

### L.5 文本可读性细节

1. **段落与行高**：正文 `text-sm = 12/18` 即 18/12 = 1.5；代码块 1.6（在 `<CodeBlock>` 内部已设置）。
2. **段落最大宽度**：72ch，避免眼睛"换行回扫"距离过长。
3. **CJK 与英文混排**：用 `text-balance` 或 CSS `text-wrap: pretty` 优化最后一行的孤字。
4. **强调**：用 `font-semibold` 不用 `<b>`；用 `<mark>`（背景 `--warning-subtle`）做搜索结果高亮。
5. **引用**：Markdown blockquote 左侧 3px 主色竖条 + 缩进。
6. **大段错误信息**：必须先一行简述（标题），再展开详细 stack（折叠默认收起）。
7. **多语言混排**：中文用全角标点；中英文之间自动加细空格（CSS `text-spacing: ideograph-alpha`，或后端预处理）。

### L.6 红线（不允许）

- ❌ 列表 / 表格里直接 `<td>{prompt}</td>`，让一条长 prompt 把表格撑爆。
- ❌ 把 JSON `JSON.stringify` 后塞到 `<pre>` 或 `<p>` 里。
- ❌ 错误信息直接 `<div>{err.stack}</div>`，挤占整页。
- ❌ 长 URL / ID 不截断就放进单元格。
- ❌ 用 `…` 截断却没有完整态入口（Tooltip / Dialog / Copy 一个都没有）。
- ❌ Markdown 通过 `dangerouslySetInnerHTML` 渲染。
- ❌ 显示 `null` / `undefined` / `N/A` 字面值给用户看。

---

---

## 3. 总体交互原则

1. **可见性（Visibility of system status）**：用户每一次操作都必须有反馈，无论成功失败、是否异步。最长 100ms 内必须给即时视觉响应；超过 1s 必须显示进度。
2. **可恢复（Recovery）**：所有破坏性操作都可二次确认 / 撤销 / 软删除；可恢复的列表 state 必须写入 URL。
3. **一致性（Consistency）**：同一类操作在所有页面长得一样、放在相同位置、用相同文案。
4. **效率（Efficiency for expert users）**：常用动作支持快捷键、批量、命令面板（Cmd/Ctrl+K）。
5. **错误预防（Error prevention）**：通过 disable 状态、内联校验、危险操作二次确认，把错误挡在用户提交之前。
6. **匹配现实（Match between system and the real world）**：术语用业务侧词汇（Skill、Agent、Run、Trace），避免暴露技术细节（如 prismaId、cuid）。
7. **少即是多（Minimalist design）**：默认隐藏专家功能（高级筛选 / Debug 入口）到 "更多" 菜单。
8. **可发现（Discoverability）**：所有可点的东西在 Hover 时都要有可点提示（cursor、轻微背景）。

---

---

## 4. 导航与信息架构

### A.1 顶层导航

- 左侧 Sidebar **固定** 7 条一级导航：Dashboard / Skills / Eval / Dataset / Trace / Playground / Settings。
- 二级导航通过路由前缀实现 `/settings/access`, `/settings/model`, `/settings/optapi`。
- 当前路径 Active 态：Sidebar 项左侧 2px 主色竖条 + `bg-sidebar-active-bg` + `text-sidebar-active-fg`。
- **不允许**在内容区里出现"返回首页"按钮（用户用 Sidebar / Breadcrumbs）。

### A.2 面包屑

- 每个深度 ≥ 2 的页面顶部必须有 Breadcrumbs：`Skills / SkillA / 版本 v3`。
- 末段为当前页（不可点击、`text-foreground`）；前段可点击（`text-foreground-secondary hover:text-foreground`）。
- 不与 Sidebar Active 冲突——Breadcrumbs 服务于"我从哪儿来"，Sidebar 服务于"我现在在哪个模块"。

### A.3 返回行为

- 详情页右上角放 `[X]` 关闭只允许在 **Drawer / Sheet 弹出** 形态；全屏详情**不放返回箭头**，依赖 Breadcrumbs 与浏览器后退。
- 浏览器后退必须可用：路由结构保证 URL 单向，不在 push 历史里写大量瞬时状态。

### A.4 命令面板 Cmd+K（建议 P2 引入）

- 基于 `cmdk`，覆盖：跳页、搜 Skill / Agent / Run、运行常用动作。
- 单一入口、单一交互模型，替代散落各处的"快速搜索框"。

---

---

## 5. 列表页交互

### B.1 标准布局

```
PageHeader: 标题 + 主操作（New / Upload / Import）
PageToolbar: [搜索框] [筛选 chips] [视图切换] ………… [批量操作隐藏到选中态出现]
PageContent: <DataTable> 或 <CardGrid>
PageFooter:  <Pagination>
```

### B.2 搜索

- 搜索框置于 Toolbar **左侧**，`placeholder` 写明搜什么字段：`搜索 Skill 名称 / 描述`。
- 输入 **debounce 300ms** 后自动触发，不需要点搜索按钮。
- 关键字写进 URL `?q=xxx`，刷新 / 分享保留。
- 没结果时：在表格区显示 `<EmptyState title="未找到相关结果" description="试试调整关键字或清除筛选" action={清除筛选}>`。

### B.3 筛选

- 多条件筛选用"芯片下拉"（chip + dropdown），点击 chip 展开多选；选中后 chip 显示当前值与计数（`状态 · 2`）。
- 所有筛选条件写进 URL `?status=running,failed&dataset=foo`。
- 顶部显示"已应用 N 项" + "清除全部"链接。

### B.4 视图切换

- 提供 `Table | Card` 切换的列表页，切换状态存 `localStorage`（按用户偏好持久化，不写 URL，避免污染分享链接）。
- 默认视图按数据特性：
  - 多字段、强对比 → Table。
  - 视觉化、卡片化数据（Skill 卡） → Card。

### B.5 排序

- 仅允许点击表头排序；切换顺序：`none → asc → desc → none`。
- 排序字段与方向写入 URL：`?sort=createdAt:desc`。
- 多列排序非必需，确实要做时 Shift+点击表头。

### B.6 选择与批量操作

- 列表左侧第一列为复选框；选中至少 1 行后，PageToolbar **滑入"批量操作栏"**：`已选 N 项 [删除] [导出] [取消选择]`。
- 批量删除走 `<ConfirmDialog>` 二次确认，写明影响范围（"将删除 N 项 Skill"）。
- 跨页选择：选中后翻页保留状态，"全选 → 选择全部 X 项" 必须可点（避免误以为只选了当前页）。

### B.7 行操作（Row Actions）

- 每行右侧固定一列 `…` Icon（垂直三点）→ Dropdown：编辑 / 复制链接 / 删除（红色）。
- **禁止**给每行塞 3 个常驻按钮（视觉噪音）。
- 单击行 = 进详情；右键 = 上下文菜单（与 `…` 内容一致）。

### B.8 分页

- 默认 Page Size = 20。可切 10 / 20 / 50 / 100。
- 分页条左边 `共 N 条`、中间页码、右边 Page Size。
- Page Size 变更时回到第 1 页；分页状态写 URL `?page=2&pageSize=20`。

### B.9 加载与空态

- 首次加载：表格区 `<SkeletonRow count={pageSize}/>`（占满预期高度，避免页面跳动）。
- 有筛选 + 空：`<EmptyState>` + "清除筛选"动作。
- 无筛选 + 空（系统真的空）：`<EmptyState>` + 主操作（"新建 Skill"）。
- 加载失败：`<ErrorState onRetry>`，错误消息从后端返回；带 retry-after 时显示倒计时。

### B.10 列表自动刷新（运行中状态）

- 含运行中行的列表：默认 **不开启自动刷新**；提供"自动刷新 5s / 15s / 关闭"开关。
- 运行结束 / 错误时，行高亮一次（200ms）作为变更提示。
- 不允许整页 reload，只刷数据。

---


---

## 6. 详情页交互

### C.1 标准结构

```
Breadcrumbs
PageHeader: 标题 + 状态 Badge + 主操作 + Overflow Menu(…)
Tabs: Overview | Versions | Runs | Settings ……
TabContent: 主体
```

- Tab key 写 URL：`?tab=runs`；刷新可恢复。

### C.2 主操作位置

- 主操作（运行 / 发布 / 评估）固定在 PageHeader **右上角**；次操作进 `…` Overflow Menu。
- 同一种操作（如"运行"）在不同详情页文案必须一致（不能 Skill 页叫"运行"、Eval 页叫"开始评估"——文案要么都一样，要么各自的业务语义清晰可识别）。

### C.3 编辑模式

两种风格，按数据复杂度选其一：

1. **内联编辑（推荐用于单字段）**：点击字段进入编辑态，Enter 保存 / Esc 取消，保存后 Toast 反馈。
2. **集中编辑（用于复杂 Form）**：右上角"编辑"按钮 → 进入编辑态 → 底部 sticky `<FormFooter>` 显示 `[取消] [保存]`，未保存时离开页面要 confirm。

**禁止**两种风格在同一详情页混用。

### C.4 关联跳转

- 列出"被哪些 Agent 使用"等关联实体时，行末显示跳转图标；点击 = 新 Tab 打开（Cmd+click 行为）。
- 已存在的 `feature-skill-used-jump-link` 把它统一封装成 `<RelatedEntityList>`。

---

---

## 7. 表单交互

### D.1 字段顺序

- 必填字段在前 / 高频字段在前 / 选填和高级字段折叠在后。
- 每个字段一行（除非两个字段强相关，如"开始 - 结束时间"才并排）。

### D.2 校验

- 提交前：**禁用** Submit 按钮直到必填都填了 → 用户立即看到"还差什么"。
- 失焦校验（onBlur）：错误信息显示在字段下方 `<FieldError>`，输入框边框 `border-destructive`。
- 服务端校验失败：错误指向具体字段时映射回字段内联错误；否则用 `toast.error`。

### D.3 表单状态

- 未修改：保存按钮 disabled。
- 修改中：保存按钮高亮可点击。
- 提交中：保存按钮 `<Spinner/> 保存中…`、其他按钮全 disabled，防双提交。
- 提交成功：`toast.success("已保存")` + 状态回到"未修改"。
- 提交失败：`toast.error(...)`，保留用户输入。

### D.4 离开拦截

- 表单有未保存改动时，用户点 Sidebar / 关闭页面：弹 `<ConfirmDialog title="尚未保存，确定离开吗？">`。
- 实现：监听 `beforeunload` + Next.js router 的 `useEffect` blocker。

### D.5 字段说明

- 字段右上角小 `?` 图标 + Tooltip 解释术语（Skill / Agent / Trace 这类业务术语）。
- 例子放在 `placeholder`，单位 / 边界放在 `<FormHint>` 灰色字。

### D.6 上传文件

- 拖拽 + 点击两种入口必须并存。
- 上传中显示进度条与文件名；失败可重试。
- 大文件 > 50MB 必须分片上传 / 至少不阻塞 UI。

---

---

## 8. 反馈与状态

### E.1 Toast（异步操作）

| 类型 | 时长 | 何时用 |
| --- | --- | --- |
| `toast.success` | 3s | 保存 / 删除 / 复制成功 |
| `toast.error` | 5s | 同步失败、提交失败（附 Retry） |
| `toast.warning` | 4s | 已提交但部分成功 |
| `toast.info` | 4s | 状态变更通知 |
| `toast.loading → success/error` | 自管 | 长任务 |

**禁止** `alert()` / `confirm()` / 自写 Toast。

### E.2 Inline 反馈（同步操作）

- 复制按钮：点击后图标变 ✓ 持续 1.5s 再恢复。
- 切换开关：立即切换，背后异步保存；失败时 Toast 报错并回滚。
- 收藏 / Star：乐观更新。

### E.3 全屏 / 区块加载

- 首次进入页面：区块级 Skeleton，不允许全屏 spinner（白屏体验差）。
- 切换 Tab：保留前一个 Tab 的位置 + 在新 Tab 显示 Skeleton。
- 路由切换（页面到页面）：顶部 2px 进度条（用 `nprogress` 风格，或自实现），最长 800ms。

### E.4 错误页

- 4xx 业务错误：用 `<ErrorState>` 显示业务文案 + 操作建议。
- 5xx：通用错误页 + "重试 / 反馈问题"。
- 网络错误：识别 `offline`，显示离线 Banner。

### E.5 跨页信号一致（v1.3 新增）

> 相同语义的反馈，**在所有页面用相同的呈现方式**。这是 §0.2 "识别度" 的交互层对应规则：用户在 `/skills` 学会"保存成功 = 右下角 Toast"之后，到 `/eval`、`/dataset`、`/trace` 必须也是。**任何"我的页面要不一样"都是违规**。

| 语义 | 唯一呈现 | 禁止的替代实现 |
| --- | --- | --- |
| 保存 / 提交成功 | `toast.success("已保存")` 右下 3s | Banner 顶部提示 / 表单内 inline ✓ |
| 删除成功（可撤销） | `toast.success("已删除", { action: { label: "撤销", ... } })` 5s | 直接静默删除 / 列表内 ✓ 动效 |
| 表单字段错误 | 字段下方 `text-destructive text-xs` + `aria-invalid` | Toast / 顶部红色 Banner |
| 提交后服务端错 | 表单上方 `<ErrorState inline>` + 保留输入值 | Toast.error 后跳走 / 清空表单 |
| 运行中 / 流式中 | `<StatusBadge status="running">` (呼吸 dot + 文案) | 自己写 spinner / 自管"正在运行" |
| 长任务完成通知 | `toast.success / toast.error` + 跳转链接 action | 浏览器原生 Notification 二选一不能并用 |
| 复制成功 | 按钮图标变 ✓ 持续 1.5s（**不**触发 Toast） | Toast / 弹出 alert |
| 二次确认 | `<ConfirmDialog variant="destructive">` 居中 | inline 红色按钮原地确认 / 二次点击 |

> **核心规则**：用户对"反馈出现的位置 / 形式 / 时长" 有肌肉记忆。第二种实现哪怕"也合理"，仍然会破坏这种肌肉记忆——**用户必须重新学习一次**，而 Observability 平台不允许这种学习成本。

---

---

## 9. 危险操作

### F.1 二次确认

所有破坏性 / 不可逆动作走 `<ConfirmDialog variant="destructive">`：

- 删除（任意类型）
- 释放 / 发布（不可撤回）
- 重置 / 清空
- 撤销审批
- 批量操作（≥ 5 行）

文案规范：

- Title：动词在前，对象在后，如"删除 Skill Foo？"。
- Description：写**影响范围**和**可恢复性**，如"将一并删除 12 个版本和 87 条运行历史，此操作不可恢复。"
- 主按钮文案：用动词重复，如 `[删除]`，不要 `[确认]`。
- 主按钮 variant：`destructive`（红色）。
- 高风险（如"清空数据集"）需要用户在 Input 里 **输入对象名** 才能解锁按钮。

### F.2 软删除与撤销（推荐）

可逆删除场景使用 Sonner 的 `toast.success("已删除", { action: { label: "撤销", onClick: ... } })`，5s 内可撤销。

---

---

## 10. 键盘与可访问性

### G.1 通用快捷键

| 键 | 作用 |
| --- | --- |
| `Esc` | 关闭弹窗 / 退出编辑态 / 清空搜索 |
| `Enter` | 提交表单 / 触发主操作 |
| `Cmd/Ctrl + Enter` | 在多行输入框中提交（如 Chat） |
| `Cmd/Ctrl + K` | 打开命令面板 |
| `Cmd/Ctrl + S` | 保存当前表单（详情 / 编辑器） |
| `?` | 显示快捷键帮助 |
| `g + d` | 跳转 Dashboard（Linear 风） |
| `g + s` | 跳转 Skills |

### G.2 焦点管理

- 弹窗打开自动聚焦首个表单项 / 主按钮（Radix Dialog 默认行为）。
- 关闭弹窗焦点回到触发器。
- Tab 顺序与视觉顺序一致；不要乱跳。

### G.3 屏幕阅读器

- 所有图标按钮必须有 `aria-label`。
- 加载态用 `<div role="status" aria-live="polite">`。
- 错误态 `aria-live="assertive"`。

---

---

## 11. 状态持久化

### H.1 写入 URL（可分享、可恢复）

- 列表筛选 / 搜索 / 排序 / 分页 / Tab。
- 详情页打开的子页签 / 选中的子项。
- 工具：`nuqs`（已装包）。

### H.2 写入 localStorage（仅个人偏好）

- 主题（light/dark/system）。
- Sidebar 折叠状态。
- 表格视图切换（Table / Card）。
- 表格密度（comfort / compact / dense）。

### H.3 不要写在哪里都不写

- 一次性临时状态（Hover / Focus）。

---

---

## 12. 长任务

### I.1 启动反馈

- 点击"运行"后立即 toast.loading("已提交，正在调度…")。
- 转跳到 Run 详情页（或在原页面打开 Run 抽屉）。

### I.2 进度

- 已知步数：进度条 + "X / Y 步"。
- 未知步数：indeterminate 进度条 + 当前 step 描述。
- 实时步骤流式渲染（Trajectory）：Append-only 列表 + "跳到最新"按钮 + 自动滚动开关。

### I.3 中断

- 任何长任务必须可"取消"；点击取消走二次确认。
- 取消后状态明确（Cancelled vs Failed），不要让用户猜。

---

---

## 13. 多用户 / 协同

> 本期 v1 暂不强制实现，但**预留交互口子**：

- 列表项右下角显示"上次编辑：xxx · 10 分钟前"。
- 详情页头部显示当前操作者头像 stack。
- 编辑同一资源时显示"另一人正在编辑"警告。

---

---

## 14. 文案与措辞（UX Writing）

参考 GitHub / Linear / Stripe 文案规范：

- **简短**：句子尽量短，去掉"请"、"非常"、"我们"等。
- **以用户视角**：用动词开头，"创建技能" 而不是 "技能的创建"。
- **统一术语**：项目术语表见 `docs/PROJECT.md`；不允许 Skill / 技能 混着用，统一一种。
- **状态写人话**：`Running` → "运行中"；`Pending` → "等待中"；`Succeeded` → "成功"；`Failed` → "失败"；`Cancelled` → "已取消"。
- **错误信息可操作**：不要只说"发生错误"，要说"同步失败：检查网络后重试"。
- **按钮文案是动词**：[ 删除 ] / [ 保存 ] / [ 取消 ]；不要 [ 确认 ] [ 是 ] [ 否 ]。

---

---

## 15. 多步骤操作规范（Wizard / 复杂流程）

> **背景**：当前项目里有多类复杂多步流程——Skill 上传 → 评估、Dataset 导入 → 标注 → 评估、Skill 优化迭代、MCP / Access 接入、模型注册。它们目前各自的交互节奏、保存策略、可中断性都不一样，用户每接触一个流程都要重新学习。
> 本节给出**统一的多步骤交互模型**：所有 ≥ 2 个串行步骤的操作都按这套范式实现。

### L.1 何时需要走 Wizard（多步骤）

满足以下**任一**条件，才用 Wizard；否则单页表单解决：

1. 步骤数 ≥ 3；
2. 后续步骤的字段依赖前面步骤的选择（不是一次就能填完的）；
3. 中间需要后端校验 / 异步操作（如"测试连接")；
4. 流程跨实体（如先建数据集、再上传文件、再设字段映射）；
5. 用户预期可"先填一半、明天接着来"（需要草稿）。

**满足不了上面条件 → 用单页表单**，不要为了"看起来高级"硬塞 Wizard。

### L.2 三种多步骤模式（按复杂度选）

| 模式 | 适用 | 视觉 |
| --- | --- | --- |
| **A. Inline Stepper（单页内分步）** | 3-4 步、轻量、字段少 | 顶部进度条 + 步骤标签，主体是当前步表单，底部 `[← 上一步] [下一步 →]` |
| **B. Side Stepper（侧边导航）** | 5+ 步、字段多、跨实体 | 左侧固定步骤导航（带状态徽章），右侧当前步主体 |
| **C. Dialog Wizard（弹窗向导）** | 入口型流程（首次创建） | `<Dialog size="lg">` 内 Inline Stepper，关闭即取消 |

> 同一种业务流程**只能选一种模式**，不允许"Skill 上传是 Inline、Dataset 上传是 Dialog"。下面给出本项目的固定分派：

| 流程 | 模式 |
| --- | --- |
| Skill 上传 / 注册 | C. Dialog Wizard |
| Dataset 导入 → 字段映射 → 抽样 | B. Side Stepper |
| 模型注册 → 凭证 → 测试 → 启用 | A. Inline Stepper |
| MCP / Access 接入 | A. Inline Stepper |
| Skill 优化迭代 | 不是 Wizard，是流式页（见本文件 §1 模板 5） |
| 评估提交（选数据集 → 选模型 → 配置） | C. Dialog Wizard |

### L.3 Wizard 通用契约（所有模式必须遵守）

#### L.3.1 步骤状态可视化

每个步骤必须显示一种状态：

- **Pending**（未到达）：灰色编号 + 灰色标签。
- **Current**（当前）：主色编号 + 加粗标签 + 左侧主色 2px 竖条（Side Stepper）。
- **Completed**（已完成）：绿色 ✓ + 标签可点回退。
- **Error**（校验失败 / 后端拒绝）：红色 ✕ + 错误说明。
- **Skipped**（可跳过的非必填步骤）：灰色虚线 + "已跳过"。

固定组件：`<Stepper steps={[{title, status, optional}]} current={n}>`。

#### L.3.2 步骤标签与进度

- 标签必须是**动词或名词**短语，不要"步骤一 / 步骤二"。比如：`选择数据集 / 字段映射 / 抽样预览`。
- 总步数 ≤ 5 才显示数字 + 标签；> 5 改为"第 N 步 / 共 M 步"。
- 顶部进度条仅在 Inline 模式显示；Side Stepper 不需要。

#### L.3.3 导航按钮（位置固定）

底部右对齐：

```
[ ← 上一步 ]  [ 跳过此步（可选） ]    [ 下一步 → ]
                                     [ 完成 ] （末步）
```

约束：

- "下一步"是 `<Button>` 主操作；当前步未通过校验时 **disabled**。
- "上一步"是 `<Button variant="ghost">`，第 1 步隐藏。
- "跳过"仅当该步标记 `optional` 时显示。
- "完成"在末步出现，触发提交并显示 loading。
- **禁止**底部塞 4 个以上按钮（如顺手放"保存草稿"+"取消"），多余动作放 `…` Overflow。

#### L.3.4 校验与下一步

- **当前步内字段校验**：失焦校验 + 提交前重校；失败时下一步按钮 disabled 并在字段下方显示错误。
- **跨步骤校验**：必须在"下一步"点击时立刻完成（同步或带 loading 的异步），不能等到末步才报错。
- **后端依赖步骤**（如"测试连接"）：进入下一步前必须显示进行中状态，失败时停留当前步并展开错误详情。

#### L.3.5 草稿与离开

- 每完成一步自动保存草稿到后端 / localStorage（视复杂度而定）。
- 用户关闭浏览器 / 点 Sidebar 跳走：
  - 有未保存改动 → `<ConfirmDialog title="尚未保存，离开会丢失当前步" confirmText="继续离开" variant="destructive">`。
  - 已保存草稿 → 自动保存 + Toast "草稿已保存，可从 XXX 继续"。
- 重新进入流程：自动加载草稿，并在顶部显示横幅 `"已加载上次保存的草稿（10 分钟前）  [继续] [重新开始]"`。

#### L.3.6 步骤回退

- 用户点击已完成步骤标签 → 直接回退到该步，**保留**前后步骤数据。
- 修改前面某步并继续 → 自动重置后续步骤中**依赖被改字段**的子项，并 Toast 提示 `"已重置 N 个相关字段"`。
- **禁止**用户已完成的步骤变成不可回退（除非该步是不可逆动作，如已提交支付）。

#### L.3.7 取消与退出

- 顶部 / 弹窗右上角 `×` 按钮 → 走 `<ConfirmDialog>` 二次确认（除非无任何改动）。
- 已完成的部分操作（如已上传文件）必须显式回滚或保留为草稿，不允许"看起来取消了但服务端有残留"。

#### L.3.8 末步提交

- "完成"按钮按下 → 按钮变为 `<Spinner/> 正在提交…` + 其他按钮 disabled。
- 成功：Toast `"已创建 / 已提交"` + 跳到结果页（不要原地停留）。
- 失败：停留当前页，错误信息显示在末步顶部 Banner + 字段级映射。
- 提交期间用户尝试关闭 → 阻止并 Toast `"正在提交，请稍候"`。

### L.4 复杂操作的友好化设计原则

针对项目里"步骤多、决策点多、专家术语多"的场景，统一以下设计动作：

#### L.4.1 减少认知负担

- **预填默认值**：能从上下文推断的（用户上次选择、当前数据集类型）一律默认填好，用户只需"确认或修改"。
- **示例引导**：每个非平凡字段提供 `<FormHint>` 灰色辅助文字 + 一键"使用示例"链接。
- **专家术语用 Tooltip 解释**：业务术语（Trace / Span / Trajectory）右上小 `?` 图标，Hover 显示 1-2 句话定义。
- **隐藏专家选项**：高级配置默认折叠到 `<Collapsible title="高级选项">`，初次用户不必看。

#### L.4.2 让用户随时看见自己在哪儿

- 每步顶部显示"为什么有这一步"的一句话副标题（如：`"上传 Skill 包：上传后我们会自动解析 SKILL.md 并提取依赖"`）。
- 长流程提供 **"概览"侧栏**（Side Stepper 模式）：列出每步已填写的关键值快照。
- 长流程结束时给一个 **Summary 页**：完整回顾、可逐项编辑、确认后才提交。

#### L.4.3 让用户随时可逆

- "撤销"动作（Sonner toast.action）在所有可逆操作后出现 5s。
- 已提交但还在 Pending 的任务允许"取消"（区别于"撤销"，需要后端支持）。
- 任何"删除草稿 / 重置流程"动作走 `<ConfirmDialog>` 二次确认。

#### L.4.4 进度感

- 异步步骤（"正在校验 / 正在测试连接 / 正在解析文件"）必须显示**步内**进度，不要光转圈。
- 已知步数显示百分比；未知步数显示当前 step 文字描述。
- 任何 > 2s 的操作必须显示"已耗时 Xs"。

#### L.4.5 出错时给出"怎么办"

- 错误文案模板：**问题（1 句）+ 原因（1 句）+ 建议（1 句）+ 操作按钮（可选）**。
  - ❌ `"上传失败"`
  - ✅ `"Skill 包上传失败。SKILL.md 缺少 name 字段。请在 frontmatter 中添加 name 后重试。[查看示例] [重新选择文件]"`
- 校验失败的字段自动 `scrollIntoView({ block: 'center' })` + 闪烁高亮 500ms。
- 长流程**部分失败**时显式区分"已成功的步骤"和"失败的步骤"，不要全盘回滚（除非业务必须）。

#### L.4.6 批量与重复操作

- 大数据量批量操作（导入 100 条以上）必须支持后台运行：提交后跳走，完成后 Toast / 通知中心提醒。
- 重复操作（"再运行一次"、"复制此次配置"）必须在结果页提供一键入口，避免用户重走全流程。
- 已存在的配置应该可"另存为"或"复用"，不要逼用户每次从空白开始。

### L.4.7 进入流程前的"准备清单"

> 复杂流程开始前，先告诉用户**需要准备什么**，避免走到第 3 步发现少东西。

在流程入口（点击"新建 / 上传"按钮后）显示一个 30 秒可看完的概览：

```
新建评估任务

你需要准备：
  ✓  已上传至少 1 个数据集
  ✓  已注册至少 1 个模型
  ✗  评估指标配置（未配置，可选）

预计耗时：约 5 分钟。
                      [ 取消 ]   [ 开始 → ]
```

清单基于实际后端状态生成，未满足项显示红 ✕ + 跳转链接。

### L.5 子流程组件契约（待建）

```tsx
<Wizard
  mode="inline | side | dialog"
  steps={[
    { id: 'select', title: '选择数据集', optional: false, content: <Step1 /> },
    { id: 'mapping', title: '字段映射',  optional: false, content: <Step2 /> },
    { id: 'preview', title: '抽样预览',  optional: true,  content: <Step3 /> },
  ]}
  draftKey="dataset-import"
  onSubmit={...}
  onCancel={...}
  prerequisites={<Checklist />}   /* 准备清单 */
  summary={<SummaryStep />}        /* 末步总结 */
/>
```

提供 hooks：

- `useWizardState()` 管理当前步、各步数据、校验状态。
- `useWizardDraft(key)` 自动保存 / 加载 / 清理草稿。
- `useStepGuard()` 监听跳出，触发 ConfirmDialog。

### L.6 现有页面整改示例

| 页面 / 流程 | 现状 | 整改 |
| --- | --- | --- |
| Skill 上传 (`SkillUploadDialog`) | 单弹窗多 field 混合，无分步、无校验提示 | C 模式：3 步 Dialog Wizard（上传文件 → 解析确认 → 元信息确认） |
| Dataset 创建 (`AgentDatasetCenter`) | 一次性表单 | B 模式：左侧步骤（基础信息 → 文件上传 → 字段映射 → 抽样预览） |
| 模型注册 (`/modelconfig/registry`) | 一页填到底 | A 模式：3 步 Inline（基础 → 凭证 → 测试连接） |
| 评估提交 (`/eval` 触发) | 单按钮 + 隐藏配置 | C 模式：Dialog 内 Inline 3 步（数据集 → 模型 → 高级配置） |

### L.7 红线

- ❌ 多步流程没有"上一步" / 不允许回退。
- ❌ Wizard 中间步骤丢失数据（关闭后再打开数据没了）。
- ❌ 把校验都堆到末步才报错。
- ❌ Wizard 里面塞 Wizard（嵌套向导）。
- ❌ 不告诉用户总步数 / 当前进度。
- ❌ 提交后原地不动 / 不给反馈。

---

---

## 16. 四条铁律（写代码前再确认一遍）

> 写在每个新工程师入职前 3 天的卡片上：

1. **禁止 inline 样式做颜色**：不能 `style={{ color: '#xxx', background: '#xxx' }}`，必须用 Tailwind class（来自 Token）。
2. **禁止自造按钮 / 卡片 / 弹窗 / Toast**：必须用 `src/components/ui/*` 已有封装；缺什么先建公共组件再用。
3. **页面必须用 `<PageContainer>` 包裹**：不允许任何页面在最外层自管 padding / max-width。
4. **页面禁止居中**：禁止对页面级容器使用 `mx-auto`；全部左对齐铺满。表单页通过"字段限宽 + 右侧辅助卡片"实现可读性，而不是靠居中留白。

违反任一条，CR 直接退回。

---

---

## 17. PR 验收 Checklist（页面 / 交互层面）

对每个改动过的页面 / 组件逐条勾：

- [ ] 用了 `<PageContainer>` 而不是 inline padding。
- [ ] 整页**铺满左对齐**，没有 `mx-auto + max-w-*` 居中容器；表单字段限宽用 `max-w-xl`。
- [ ] 所有按钮都来自 `components/ui/button.tsx`。
- [ ] 没有 `alert()` / `confirm()` / 给用户看 console.error。
- [ ] 没有硬编码颜色（含 Tailwind 字面色 `bg-blue-500`、`text-gray-500`）。
- [ ] 数值用 `font-mono tabular-nums`。
- [ ] 加载 / 空 / 错误三态都显式实现。
- [ ] 危险操作走 `<ConfirmDialog>`。
- [ ] URL 上能恢复 Tab / 筛选 / 分页。
- [ ] 状态用 `<StatusBadge>` 三重编码（色 + 图标 + 文案）。
- [ ] 长文本截断 + 完整态入口（Tooltip / Dialog / Copy 至少一种）。
- [ ] Markdown / JSON / 错误堆栈走 `<Prose>` / `<JsonViewer>` / `<ErrorDetail>`，不裸渲染。
- [ ] 空值显示 `—`，不显示 `null` / `undefined` / `N/A`。
- [ ] 切到 dark mode 看一眼无明显违和。
- [ ] 键盘 Tab 一遍能到达所有控件。
- [ ] 1024px 屏幕宽下不破版。

详细 PR Review 清单见 [`components.md`](./components.md) §6。

---

对每个改动的页面：

- [ ] 顶部三段式齐备：Header / Toolbar / Content / Footer。
- [ ] 搜索 / 筛选 / 排序 / 分页 / Tab 状态都在 URL 里。
- [ ] 所有按钮文案是动词，状态文案翻译统一。
- [ ] 任何写操作都有 Toast 反馈。
- [ ] 删除 / 释放 / 批量操作走二次确认。
- [ ] 表单未保存时离开有 confirm。
- [ ] 空 / 加载 / 错误三态显式实现。
- [ ] 键盘可达 + 主要快捷键支持。
- [ ] Sidebar Active 状态正确。
- [ ] 自动刷新可控（默认关闭、用户可开启）。
- [ ] 多步骤流程符合 §L：固定模式、步骤状态、草稿、可回退、错误模板、准备清单。
- [ ] 同类功能页面布局选自本文件 §1 的 6 类模板之一，不自创布局。

---

## 18. 后期治理

- **ESLint 规则**：用 `no-restricted-syntax` 拦截 `style={{ color | background | borderColor }}`、`className="bg-[#...]"`、`alert(` / `confirm(`、原生 `<select>` / `<button>` 等。CI 直接拦截不合规 PR。
- **PR 模板**：`.github/pull_request_template.md` 内嵌 §M Checklist。
- **季度复盘**：每季度 `grep` 一次旧类（`.ai-btn-*` / `.btn-primary` / `bg-[#` / `style={` 的颜色用法），违规计数公开同步。
- **Storybook**（可选）：把 `src/components/ui/*` 全挂出来，作为设计 - 开发对照基线。
- **视觉回归**：Playwright 截图对比，至少覆盖 Dashboard / Skills / Skill Detail / Eval / Dataset 5 个核心页面。

任何偏离标准的写法都必须：

1. PR 描述写明理由。
2. 代码上方加注释 `// design-exception: <原因> · <issue-link>`。
3. 设计 / 前端 TL 至少一人 approve。

---
