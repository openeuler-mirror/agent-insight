# Components — 组件清单、契约与 PR 自查表

> **目录**：组件注册表（强制复用） → 组件标准 → 图标 → 已有/需新增清单 → 组件 API 约定 → PR 自查表 → 旧代码迁移对照 → 开发起步 → 例外管理
>
> **本文件覆盖**：组件层面的所有规则——哪些组件必须复用、每个组件的 API 契约、PR 检查清单。
> **基础视觉规则、暗黑模式、Token**：见 [`foundations.md`](./foundations.md)。
> **页面骨架、交互行为**：见 [`patterns.md`](./patterns.md)。

---

## 1. 同一功能 = 同一组件 注册表（一致性强制）

> §A.4 解决了"页面布局长一样"，本节解决"页面内的功能元件长一样"。
> **核心原则**：一致性不是"我对照规范写出来的版本也对"，而是 **import 同一个文件**。
>
> 任何 PR 新增"看起来像下表里某个功能但走自己实现"的代码，**直接打回**——"我的场景特殊"不是理由，特殊场景请回去给共享组件加 prop。

### Q.1 强制复用组件清单（v1.3 起严格执行）

| 功能 | 唯一组件 | 出现位置 | 禁止行为 |
| --- | --- | --- | --- |
| 数据为空 | `src/components/feedback/EmptyState.tsx` | 列表 / 详情 Tab / Dashboard / Search 无结果 | 自己写"暂无数据" `<div>` |
| 加载失败 | `src/components/feedback/ErrorState.tsx` | 全站任何 catch 出错的位置 | 把 `err.message` 直接渲染到 `<div>` |
| 加载占位 | `src/components/ui/skeleton.tsx` | 所有首次加载 | 用 `<Loading...>` 文字代替 |
| 状态徽章 | `src/components/feedback/StatusBadge.tsx` | 列表状态列 / 详情页标题 / Trace Span | 自己用 `bg-green-100 text-green-700` 拼 |
| 关键指标 | `src/components/text/MetricValue.tsx` | KPI 卡 / 表格数值列 / 详情 metadata | `<span>{value} {unit}</span>` |
| 长 ID | `src/components/text/IdChip.tsx` | 所有 cuid / uuid / hash 字段 | 整 ID 直接渲染 |
| 相对时间 | `src/components/text/RelativeTime.tsx` | 列表"更新时间" / Trace 时间戳 | `new Date().toLocaleString()` 字符串拼 |
| AI 卡片 | `src/components/feedback/AiCard.tsx` | Skill 推理 / Trace 流式 / Eval 自动评分 | 自己用 `border-image` 模仿渐变 |
| 页面头部 | `src/components/shell/PageHeader.tsx`（契约见 [`patterns.md`](./patterns.md) §1 PageHeader 小节） | 所有页面 | inline `<h1>` + 按钮；自管 breadcrumbs / KPI Strip / 实时刷新集群 |
| 页面容器 | `src/components/shell/PageContainer.tsx` | 所有页面 | inline padding / max-width |
| 筛选条 | `src/components/filter/FilterBar.tsx` | 所有列表 / Dashboard | 自管的 search input + chips |
| 二次确认 | `src/components/feedback/ConfirmDialog.tsx` | 所有破坏性操作 | `window.confirm` / 自管 Dialog |
| 数值复制 | `src/components/text/CopyButton.tsx` | ID / Code / URL 的复制 | 自管 `navigator.clipboard` + 自己的成功反馈 |
| 长文本展开 | `src/components/text/ExpandableText.tsx` | 详情页超过 6 行的描述 | 自管 useState 切 collapsed |
| 代码块 | `src/components/text/CodeBlock.tsx` | 多行代码 / Prompt | `<pre>{code}</pre>` |
| JSON 展示 | `src/components/text/JsonViewer.tsx` | 所有结构化数据展示 | `JSON.stringify(obj, null, 2)` |
| 错误堆栈 | `src/components/feedback/ErrorDetail.tsx` | 任何 `err.stack` 展示位置 | 整段塞 `<pre>` |
| 术语提示 | `src/components/text/TermPopover.tsx` | KPI 卡指标名 / 表头列名 / 卡片标题里的领域术语 / 长文本叙述里首次出现的术语 / 表单字段标签 | 自己用原生 `title="..."`；用 `<Tooltip>` 塞多行术语解释；inline 写一个浮层 |

> 标 ⚠️ 的组件部分尚未实现 —— 参考本文件 §4 "已有 / 需新增 组件清单" 中的"待建"标记。**未实现的组件不构成"我可以自己写一版"的理由**：第一个需要它的页面**有责任**把它建成共享组件，而不是在本页面内嵌一个私有版本。

### Q.2 新增组件的"晋升"流程

如果你发现需要一个本表里没有的组件：

1. **先搜**：`grep -r "<YourFeature" src/components/` —— 90% 的情况已经有了，只是名字不一样。
2. **再问**：在 PR 描述里 @设计 / 前端 TL，问"这是不是一个全站功能"。
3. **后建**：如果是，新建 `src/components/<domain>/<Name>.tsx`，**同时更新本文件 §1 注册表与 §4 组件清单**。
4. **才用**：本页面 import 使用。

**禁止顺序**：先在页面里写一版 → 之后再 "提取公共组件"。**实际从来不会发生**，最后留下 N 个长得像但行为各异的"私有实现"。

### Q.3 跨页面一致性自检（PR 前对自己问一遍）

在 §N 的 16 条之上，本节追加 9 条 **一致性维度**自检：

- [ ] 我的"空数据" 用了 `<EmptyState>` 而不是自己写 `<div>` 提示文案
- [ ] 我的"加载错误" 用了 `<ErrorState onRetry>` 而不是 toast 一下就完事
- [ ] 我的"加载中" 是 Skeleton 复刻最终布局，不是一个居中 spinner
- [ ] 我的状态全部走 `<StatusBadge>`（即使只用一种状态也得走）
- [ ] 我的所有数值走 `<MetricValue>`（即使是简单的"3 条"也得走）
- [ ] 我的相对时间走 `<RelativeTime>`，不是 dayjs/.format() 字符串
- [ ] 我的页面头是 `<PageHeader>`，标题 / 副标题 / 主操作位置与全站一致
- [ ] 我的筛选条是 `<FilterBar>`，搜索框宽度 / chip 排列与全站一致
- [ ] 在 dark 模式下截图比对一遍，没有亮色专属的对比度问题

---


---

## 2. 组件标准

> 所有交互组件**必须**使用 `src/components/ui/*` 下的封装；现存的 `.ai-btn-*`、`.btn-primary`、`.btn-manage` 等 CSS 类**全部弃用**（迁移路径见 [`ROADMAP.md`](./ROADMAP.md) P0-B / P2-B）。

### E.1 Button

唯一来源：[`src/components/ui/button.tsx`](../../src/components/ui/button.tsx)。允许的变体：

| variant | 视觉 | 适用 |
| --- | --- | --- |
| `default` | 主色 Indigo 填充 | **主操作**，每屏 ≤ 1 个 |
| `secondary` | 灰底 | 次操作 |
| `outline` | 描边 | 与 `secondary` 同语义，仅在白底 Card 内使用 |
| `ghost` | 透明 | 工具栏、行内 icon 按钮 |
| `destructive` | 红色 | 删除 / 不可逆的二次确认 |
| `link` | 文字 + 下划线 | 跳转 |

尺寸：`sm (h-8) / default (h-9) / lg (h-10) / icon (size-9)`。同一行内不允许混用不同尺寸。

#### E.1.1 Legacy 变体（过渡期 · 待迁出）

| variant | 视觉 | 状态 |
| --- | --- | --- |
| `brand` | 硬编码 `#2F6868` 青绿底 | **@deprecated** · 仅遗留页面（早期品牌色按钮）保留兼容 |

`brand` 是 v1.2 之前的品牌兜底色，违反"95% 灰 + 单一 Indigo + 0 硬编码色"原则，**不算正式变体**：

- ❌ **新代码禁止新增 `brand` 用法**。主操作一律用 `default`（Indigo）。
- ❌ 任何 PR 不允许新增 `variant="brand"` 引用；Reviewer 直接打回。
- ✅ 存量引用走"灰度迁移"：每个 Sprint 至少清理 5 处 `brand`，记入迁移度量（见 [`ROADMAP.md`](./ROADMAP.md) 末尾"度量"小节）。
- 🎯 目标：在文档 v1.3 发布前从 `button.tsx` 删除 `brand` 变体定义。

如需保留品牌色（如 Logo 旁的"开始使用"按钮），通过 `<Button>` + `style` **不允许**，应该把该入口提到 `src/components/brand/` 下做品牌专用组件，与通用 Button 解耦。

### E.2 Input / Textarea / Select / Switch / Checkbox / Radio

- Input、Textarea、Switch、Label、PasswordInput 已封装在 `src/components/ui/`。
- 缺失的 Select / Checkbox / RadioGroup / Combobox / DatePicker 必须基于 Radix 封装（见本文件 §4）。
- **禁止**原生 `<select>`（视觉与状态控制差异大，主题切换断裂）。
- 所有表单字段必须配 `<Label htmlFor>`，错误信息在字段下方 `text-destructive text-xs`。

### E.3 Card

唯一形状：

```tsx
<Card>
  <CardHeader>{/* px-5 py-4, border-b */}
    <CardTitle/>
    <CardDescription/>
  </CardHeader>
  <CardContent>{/* px-5 py-4 */}</CardContent>
  <CardFooter>{/* px-5 py-3, border-t, justify-end */}</CardFooter>
</Card>
```

禁止自定义 `.ai-card`、`.skill-card`。

### E.4 DataTable

封装在 `src/components/ui/data-table.tsx`（待建），基于 TanStack Table。约定：

- Header `text-xs text-foreground-muted uppercase tracking-wide`。
- 行高跟随 density（Comfort 48 / Compact 36 / Dense 28）。
- Hover 整行 `bg-background-secondary`。
- 选中态主色 subtle 背景 `bg-primary-subtle`。
- 行操作只在 Hover 显示（`group-hover:visible`），常驻一个 `…` 即可。
- 排序：单列单击切换 asc/desc/none，箭头图标 `ArrowUp/Down/ArrowUpDown`。

### E.5 StatusBadge

唯一来源 `src/components/feedback/StatusBadge.tsx`（待建）。

```tsx
<StatusBadge status="running" />
// → Subtle 蓝底 + 旋转图标 + "运行中"
```

支持状态：`running / success / warning / error / cancelled / pending / queued`。
颜色 + 图标 + 文案三重编码。

### E.6 Dialog / Sheet / Popover / Tooltip

- 全部使用 `@radix-ui/*` + 项目封装。
- **禁止**自己用 fixed div 写 Modal。
- Dialog 标准结构：Header（Title + Description） / Body（可滚动） / Footer（右对齐 Cancel + Confirm）。
- **二次确认对话框**统一用 `<ConfirmDialog variant="destructive">`。
- Sheet 用于"列表右侧滑出详情"或"侧栏过滤器"，宽度 `w-[480px]`（小）或 `w-[640px]`（大）。

### E.7 Toast / Notification

- 唯一来源：`sonner`。
- 触发：`import { toast } from "sonner"; toast.success("已保存"); toast.error("同步失败");`。
- **禁止** `window.alert / confirm`、**禁止**自写 Toast。
- 时长：成功 3s、错误 5s（含"重试"）、信息 4s。
- 位置：右下角，单列最多 3 条。

### E.8 Loading / Empty / Error 三态

| 状态 | 标准组件 |
| --- | --- |
| 初次加载 | `<Skeleton>` 占位（保留布局高度） |
| 数据为空 | `<EmptyState icon title description action>` |
| 加载错误 | `<ErrorState title description onRetry>` |
| 操作进行中 | `<Button disabled> <Spinner/> 正在保存…</Button>` |

### E.9 Pagination / 无限滚动

- 列表统一 `<Pagination>`（页码 + 跳页 + Page Size）。
- Trace / Trajectory 这种持续追加的流式数据用"加载更多"按钮 + 顶部"跳到最新"。
- 不允许同一类页面一个用分页一个用无限滚动。

### E.10 Tabs / SegmentedControl

- 页面内 Tab 统一 `<Tabs underline>`（下划线 + 主色），位于 PageHeader 下方。
- 表单 / Card 内的小切换用 `<SegmentedControl>`（胶囊背景）。
- Tab key **必须**写进 URL `?tab=overview`（用 `nuqs`）。

### E.11 Breadcrumbs

详情页第一行必须有面包屑：`首页 / Skills / Skill X / 版本 v3`。
封装 `<Breadcrumbs items>`。

### E.12 Code Block / JSON Viewer

- 单行代码：`<code className="font-mono text-sm bg-background-tertiary px-1.5 rounded-sm">`。
- 多行代码：`<CodeBlock language>` 基于 `react-syntax-highlighter`，含一键复制 + 行号。
- JSON：基于 `react18-json-view` 封装 `<JsonViewer collapsed depth=2>`，关闭其默认主题、套上 Token。

### E.13 Trace / Trajectory 专用

观测平台核心视图：

- **Span Bar**：水平时间轴条，颜色按 Span 类型（AGENT / TASK / TOOL / LLM / SKILL / USER），耗时长度按比例缩放。
- **TimelineItem**：竖向时间线，每个节点 `8px solid dot + 状态色 + 时间戳 + 标题`。
- **StreamingList**：append-only 列表，自动滚动开关 + "跳到最新"浮动按钮。

#### E.13.1 Span 类型 → 颜色映射（唯一权威表）

实现位置：[`src/lib/charts/palette.ts`](../../src/lib/charts/palette.ts) 的 `SPAN_KIND_COLOR` / `SPAN_KIND_CLASSES`。**禁止**在组件里硬编码 `bg-amber-*` / `text-emerald-*` 给某个 Span 类型，必须从 `SPAN_KIND_CLASSES` 取。

| Span 类型 | Chart Palette 槽位 | 颜色 | Tailwind 锚类 | 选用理由 |
| --- | --- | --- | --- | --- |
| AGENT | 1 | Indigo | `bg-primary-subtle text-primary` | 主色 = "主角"，第一序列 |
| TASK | 2 | Sky | `bg-sky-50 text-sky-700` | 冷色，叙事感强（任务编排） |
| TOOL | 3 | Emerald | `bg-emerald-50 text-emerald-700` | 偏中性绿，"动作执行"语义 |
| LLM | 6 | **Violet** | `bg-violet-50 text-violet-700` | 紫色 = "AI / 模型 / 智能体"语义（§1.4），LLM 是该语义最纯粹的成员 |
| SKILL | 7 | **Pink** | `bg-pink-50 text-pink-700` | LLM 让出 violet 后，SKILL 取剩余槽位；SKILL 频次低，暖色视觉负担可接受 |
| USER | — | Neutral | `bg-background-secondary text-foreground-muted` | 不是系统行为，灰阶降权 |

> **🚫 红线**：Span / 节点类型禁止用 Amber 或 Red 上色。Amber 是 warning 色、Red 是 error 色 —— 用它们标注类型会让用户读成"这步出问题了"。详见 [`foundations.md`](./foundations.md) §2 图表配色红线。
>
> **🚫 红线 · 类型色之间必须有足够色相距离**：相邻槽位（≤ 30° 色相差）不能同时分配给两个高频出现的 Span 类型。Trace 视图里 LLM 是高频，必须独占一个**远离其他类型**的色相。
>
> **🚫 红线 · 高频类型避免暖色 / 偏红色**：LLM、TOOL 这类一屏可能出现 10+ 次的类型，禁止用 Pink / Rose / Fuchsia 等偏红色相 —— 大量暖色块会视觉疲劳并暗示"出错 / 警告"。暖色只能分配给低频类型（如 SKILL，一次任务出现 1–3 次）。
>
> **🚫 红线 · LLM-violet 与 AGENT-indigo 的近邻例外**：这两个槽位色相差仅 ~19°，按常规会冲突。允许并存的依据：① AGENT 是带 chevron 的容器节点、LLM 是无 chevron 的叶节点，**树结构本身就在区分它们**；② chip 文字标签 `AGENT` / `LLM` 是强区分锚点；③ Trace 视图里 AGENT 出现频次远低于 LLM。如果未来新增的视图里两者频次都高 + 树结构区分消失，必须重新评估。
>
> **历史教训**（迭代 4 次才收敛）：
> - **2026-05-18 之前**：LLM = Amber `#F59E0B` → 与 warning 状态色冲突，被用户读成"一长串告警"。
> - **2026-05-19 #1**：临时 → Teal `#14B8A6` → 与 TOOL 的 Emerald `#10B981` 仅 ~15° 色相差，密排时肉眼难分。
> - **2026-05-19 #2**：→ Pink `#EC4899`（槽位 7）→ 唯一暖色解决了色相距离问题，但 Pink 偏红、在高频出现下视觉疲劳 + 隐含"出错"暗示。
> - **2026-05-19 #3（当前）**：→ Violet `#8B5CF6`（槽位 6）→ Violet 原属 SKILL；改为 LLM 取 violet（§1.4 的 AI 语义本就最贴 LLM），SKILL 让到 Pink（SKILL 频次低，暖色可接受）。LLM/AGENT 色相靠近的代价由"容器 vs 叶节点"结构差异和 chip 文字标签兜底。

### E.14 TermPopover（术语提示 · 圆形 i 角标 + Popover）

观测平台术语密集（Trace / Span / Skill / CHAIN_ERROR / P95 / SMART RUN…），新用户对着列名 / 指标名"猜意思"。本组件统一所有"挂角标 → 浮层解释"的实现；禁止任何页面再用原生 `title=""`、`<Tooltip>` 塞多行术语，或自管浮层。

唯一来源 `src/components/text/TermPopover.tsx`（🆕 待建）。

> 本节是 v1 高保真 `glossary-popover-v2.html` 的正式规范化收口：HTML 里用了 `#5a3df0` 主色、`#00a870 / #ff8800 / #f53f3f` 状态色、`13×13` 角标 + `9px` 字符、自定义双层 box-shadow、`3px` 圆角和 5 色 type tag —— 这些值与 [`foundations.md`](./foundations.md) §1.2 / §B.3 / §B.5 / §C.2 / §D.2 / §D.3 都有冲突。本节给出的 Token / 字号 / 尺寸为**正式值**，HTML 的具体像素不再作参考。

#### E.14.1 与 Tooltip 的差异（什么时候用哪个）

| 维度 | `<Tooltip>` | `<TermPopover>` |
| --- | --- | --- |
| 信息量 | ≤ 1 行短语 | 1-4 行 + 可选公式块 + 可选关联链接 |
| 可点击内容 | ❌ 不允许（hover 移出即消失） | ✅ 允许（popover 内可放关联跳转链接） |
| 触发器 | 触发器自带语义（图标按钮、被截断的文字） | 触发器是**术语文字 + 圆形 i 角标** |
| 触发方式 | hover / focus | hover / focus / tap（移动端） |
| 典型用例 | "点击复制"、被 truncate 的完整文本、键盘快捷键提示 | "P95 是什么？"、"CHAIN_ERROR 怎么解读？"、"综合健康分如何计算？" |

🚫 红线：术语解释一律走 `<TermPopover>`，**禁止**用 `<Tooltip>` 塞 ≥ 2 行术语解释。

#### E.14.2 API

```tsx
<TermPopover
  term="P95 时延"
  tag="metric"                // 'metric' | 'trace' | 'tool' | 'skill' | 'fault' | 'eval'
  body="把所有请求耗时从小到大排序，第 95 个百分位的值。代表绝大多数用户能感受到的最差体验。"
  formula={{                  // 可选：公式 / 阈值 / 取值范围
    label: '阈值参考',         // 短标签，<= 8 字
    content: '< 2s 良好 · 2-5s 可接受 · > 5s 需关注'
  }}
  related={[                  // 可选：跳转到术语表 / 关联指标的链接
    { label: '置信加权', href: '/glossary/confidence-weighted' },
    { label: 'SMART RUN', href: '/glossary/smart-run' }
  ]}
>
  P95 时延   {/* 触发器文本；不传 children 时自动用 term */}
</TermPopover>
```

推荐用法是 `<Term id="p95-latency" />` —— 由 id 从术语表 (`docs/agent-insight-glossary.md`，待建) 取出完整字段，避免每个用法处重复写文案。详见 E.14.7。

#### E.14.3 视觉规格（Token / 字号 / 尺寸 / 间距）

**① 触发器：lucide `<Info>` 图标（不是圆圈包字符）**

| 维度 | 值 | Token / 备注 |
| --- | --- | --- |
| 图标库 | `lucide-react` 的 `<Info>` | 项目已装；**禁止**用 Unicode `ⓘ` 字符（移植性差、字体回退不可控） |
| 尺寸 | `size-3` (12×12px) | 比 14px 文字小一档，形成清晰层级；**不用** `size-3.5` / `size-4`（视觉抢戏） |
| 透明度 | `opacity-70` | 进一步让图标视觉退后 |
| 默认字色 | `--foreground-muted`（badgeTone="muted"，默认）/ `--primary`（badgeTone="primary"，仅高亮卡片如渐变 KPI 用） | — |
| 与术语文字间距 | `gap-1` (4px) | — |
| 与基线对齐 | `align-baseline` | — |
| Focus 环 | `focus-visible:ring-2 ring-ring`（套在 trigger span 上） | 与 §P.4 主操作以外的统一 focus 规则一致 |
| 光标 | `cursor-help` | 跨平台一致的"可补充信息"语义 |

🚫 红线：
- 不用渐变、阴影、发光（违反 §0.2 锚点②的渐变白名单）。
- 不用 hover 切换主色填充——Tooltip 已经在 hover 时显示卡片，图标再变色是双重信号、视觉嘈杂。

**② Tooltip 卡片**

| 维度 | 值 | Token |
| --- | --- | --- |
| 背景 | `bg-card` | `--card-bg` |
| 边框 | `border border-card-border` (1px) | `--card-border` |
| 圆角 | `rounded-md` (8px) | `--radius-md`；**不用** HTML 的 3px |
| 阴影 | `shadow-sm` | §D.3 三档之一；**禁止**自定义双层 box-shadow |
| 宽度 | `w-[260px]` 固定 | 带 formula / related 时按内容自然撑高；**不允许**横向溢出滚动 |
| 内 padding | `p-4` (16px 各边) | 落到 4px 网格 |
| 与触发器距离 | `sideOffset={6}` (Radix prop) | — |
| 三角箭头 | **无**（Tooltip 默认无 Arrow，比 Popover 视觉更轻；如需，可用 `<Tooltip.Arrow />` 但与"补充说明"语义不符） | — |
| 边界翻转 | Radix `collisionPadding={12}` 自动处理 | **不**写自定义 `term-end` 类 |
| Z-index | `z-50` | 不允许手写 `z-[xxx]` |

**③ Popover 内容结构（5 个固定槽位 · 自上而下）**

```
┌─────────────────────────────────┐
│  ① TypeTag      ◀── 单个 tag，左对齐
│                                 
│  ② Term         ◀── 术语本身
│                                 
│  ③ Body         ◀── 解释，最多 4 行
│                                 
│  ┌───────────────────────────┐  
│  │ ④ Formula 块（可选）       │  
│  │   label 行（小写小标签）   │  
│  │   content 行（等宽数字）   │  
│  └───────────────────────────┘  
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  ◀── dashed 分隔
│  ⑤ Related: [chip] [chip] ...   
└─────────────────────────────────┘
```

| 槽位 | 字号 | 字色 / 字重 | 间距 |
| --- | --- | --- | --- |
| ① TypeTag | `text-[10px] font-medium uppercase tracking-wide` | 见 §E.14.4 配色表；`px-1.5 py-0.5 rounded-sm` | `mb-1.5` |
| ② Term | `text-sm font-semibold` | `text-foreground` | `mb-1` |
| ③ Body | `text-xs leading-relaxed` (11/18) | `text-foreground-secondary` | `mb-0` |
| ④ Formula 容器 | — | `bg-background-tertiary rounded-md px-2 py-1.5` | `mt-2` |
| ④.a Formula label | `text-[10px] uppercase tracking-wider` | `text-foreground-muted` | `block mb-0.5` |
| ④.b Formula content | `font-mono text-xs tabular-nums` | `text-foreground` | — |
| ⑤ Related 容器 | — | `flex flex-wrap items-center gap-1 pt-2 border-t border-dashed border-border` | `mt-2` |
| ⑤.a Related label | `text-[10px]` | `text-foreground-muted mr-1` | — |
| ⑤.b Related link | `text-[10px] px-1.5 py-0.5 rounded-sm` | `bg-primary-subtle text-primary hover:bg-primary-subtle-border` | — |

⚠️ Body 超过 4 行时用 `<ExpandableText lines={4}>` 包；**不允许** popover 内出现滚动条（滚动会破坏 hover 状态、移动端体验差）。如果术语解释天然 > 6 行，把详细信息挪到术语表页面，popover 只放 1-2 句概要 + `related` 跳转。

#### E.14.4 类型 Tag 配色（6 类 · 唯一权威表）

类型 Tag 表达"术语属于哪个领域"，不是状态信号。规则：**95% 走灰**，仅 2 类术语本身就在描述错误 / 评测语义时保留 `--error` / `--success`。

| Tag | 适用术语示例 | 背景 | 文字 | 选用理由 |
| --- | --- | --- | --- | --- |
| `metric` 指标 | P95 时延 / 成功率 / 调用量 / Token 数 | `--tag-gray-bg` | `--tag-gray-fg` | 默认灰，避免与 KPI 卡的状态色争抢注意力 |
| `trace` 链路 | Trace ID / Span / 执行状态列名 / 执行时间 | `--tag-gray-bg` | `--tag-gray-fg` | 灰；链路术语高频出现，必须低噪音 |
| `tool` 工具 | background_output / search / file_write | `--tag-gray-bg` | `--tag-gray-fg` | 灰；与 trace 同档 |
| `skill` Skill | 综合健康分 / 置信加权 / A/B 测试 / SMART RUN | `--tag-purple-bg` | `--tag-purple-fg` | 紫；**唯一**符合 §B.5"紫仅用于 AI/模型领域"白名单的术语类 |
| `fault` 故障 | CHAIN_ERROR / TIMEOUT / NODE_DOWN | `--error-subtle` | `--error` | 红；术语本身在描述错误，语义对齐 §B.4 `--error` |
| `eval` 评测 | 命中率 / 误触发率 / Judge 分 / 评估覆盖度 | `--success-subtle` | `--success` | 绿；术语本身在描述"通过 / 评分"，语义对齐 §B.4 `--success` |

🚫 红线 · HTML 高保真里"指标 = 紫、链路 = 蓝"的方案**不被采纳**：
- 紫色重复使用会与 §B.3"主色仅用于可交互"和 §B.5"紫仅 AI/模型"白名单冲突。
- 蓝色会与 §B.4 `--running` 蓝（仅运行状态）冲突——用户会把"Trace ID 列名"读成"列在运行中"。

🚫 红线 · 禁止自创第 7 类 tag。如果出现一个不属于上述 6 类的术语，先在 PR 里讨论是否新增类型，**而不是临时再挑一个色相**。

#### E.14.5 触发与可访问性

| 端 | 行为 |
| --- | --- |
| 桌面 hover | 角标 / 术语文字 hover → **150ms** 延迟展开；移出 → 自动收起；hover 进卡片内部时不收起（Tooltip 默认 hoverable content）；同区域内连续切换术语 → **50ms** 即时展开（`skipDelayDuration`） |
| 桌面键盘 | Tab 焦点到角标 → **自动展开**（focus = hover 等价）；Esc 收起，焦点回到角标 |
| 移动 / 触屏 | tap 切换（首次 tap 打开、再 tap 关闭）；外部 tap 关闭。Related 链接需挂在 popover 内部，确保移动端可点 |
| `prefers-reduced-motion: reduce` | 关闭 transition，立即显隐 |

- **必须**基于 [`Radix Tooltip`](https://www.radix-ui.com/primitives/docs/components/tooltip)（项目已装 `@radix-ui/react-tooltip`）；禁止用纯 CSS `:hover` 实现（HTML v2 用的就是 CSS hover，移动端不可用、键盘不可达）。
- 不用 Radix Popover：Popover 需要点击触发，跟术语提示的"补充说明"语义不符；Tooltip 的 hover/focus 触发更轻、无需用户主动点击。
- 全局每屏最多 1 个 tooltip 同时打开（Radix 默认）。
- 触发器 `aria-label="术语解释：{term}"`；卡片容器 `role="tooltip"` 由 Radix 处理。

#### E.14.6 何时挂角标（详见 [`patterns.md`](./patterns.md) §2.5 "术语提示 4 类挂载场景"）

**允许**：
- ✅ KPI 卡指标名（"P95 时延"、"今日调用量"）
- ✅ 表格表头列名（"Trace ID"、"执行状态"、"执行时间"）
- ✅ 卡片标题里的领域术语（"综合健康分 · 置信加权"）
- ✅ 长文本叙述中**首次出现**的专业术语（"系统检测到一次 CHAIN_ERROR…"）
- ✅ 表单字段标签（替代 [`patterns.md`](./patterns.md) §7.D.5 旧的"小 ? 图标 + Tooltip"方案）

**禁止**：
- ❌ 列表行数据里逐行重复挂角标（噪音、信息冗余）
- ❌ 同一术语在同一屏出现 ≥ 2 次时除首次外重复挂（违反"首次出现"原则）
- ❌ 当作"详情链接"用（详情链接走 `<a>` 下划线 + 跳转，不走 popover）
- ❌ Popover 内塞操作按钮（"开始评测"、"删除"），破坏"只读 = 解释"语义
- ❌ 一个角标里放多个 term（每个角标对应一个术语）

#### E.14.7 内容来源（与术语表单一事实源）

- 所有术语文案来自 `docs/agent-insight-glossary.md`（🆕 待建）。
- **禁止**在组件用法处 inline 写术语解释 —— 改一处全站不一致。
- 推荐封装：

  ```tsx
  // src/components/text/Term.tsx
  export function Term({ id, children }: { id: TermId; children?: ReactNode }) {
    const def = GLOSSARY[id];  // 注册表查表
    return <TermPopover {...def}>{children ?? def.term}</TermPopover>;
  }

  // 用法
  <Term id="p95-latency" />
  <Term id="chain-error">CHAIN_ERROR</Term>   {/* 自定义触发器文字 */}
  ```

- 术语表注册表落在 `src/lib/glossary/registry.ts`，导出 `GLOSSARY: Record<TermId, TermDef>`；新增术语必须同步更新 `docs/agent-insight-glossary.md`。

---

---

## 3. 图标与插画

- 图标库唯一 `lucide-react`；尺寸只用 14/16/20px；颜色继承 `currentColor`。
- 状态图标固定映射见 [`foundations.md`](./foundations.md) §2 "语义状态色"。
- 空态插画 SVG 放 `public/illustrations/`，**单色**（用 `--foreground-muted`），避免渐变 / 拟物。
- 不允许另装 Heroicons / Tabler / 自定义 SVG 图标（业务插画 / 品牌图除外）。

---

---

## 4. 已有 / 需新增 组件清单

✅ = 已实现可用　🛠 = 已有但需重构 / 增强　🆕 = 待新建

### 基础控件（`src/components/ui/*`）

| 组件 | 状态 | 来源 / 备注 |
| --- | --- | --- |
| Button | ✅ | shadcn / Radix Slot + CVA |
| Input | ✅ | shadcn |
| Textarea | ✅ | shadcn |
| Label | ✅ | Radix Label |
| Switch | ✅ | Radix Switch |
| Avatar | ✅ | Radix Avatar |
| Badge | ✅ | shadcn（需补 success / warning / destructive variants） |
| Card | ✅ | shadcn |
| Separator | ✅ | Radix Separator |
| Skeleton | ✅ | shadcn |
| Tooltip | ✅ | Radix Tooltip |
| Sheet | ✅ | Radix Dialog |
| Password Input | ✅ | 自封装 |
| Sonner (Toaster) | ✅ | sonner |
| Dialog | 🛠 | 当前散落，需统一封装 `Dialog/Trigger/Content/Header/Footer` |
| Select | 🆕 | 基于 Radix Select |
| Checkbox | 🆕 | 基于 Radix Checkbox |
| RadioGroup | 🆕 | 基于 Radix RadioGroup |
| Tabs | 🆕 | 基于 Radix Tabs（underline 样式） |
| SegmentedControl | 🆕 | 基于 Radix Toggle Group |
| Popover | 🆕 | 基于 Radix Popover |
| DropdownMenu | 🆕 | 基于 Radix DropdownMenu |
| Combobox | 🆕 | Radix Popover + cmdk |
| DatePicker / DateRange | 🆕 | react-day-picker（按需） |
| Slider | 🆕 | Radix Slider（如有） |
| FileUpload | 🆕 | 支持拖拽 + 进度 + 分片 |

### 反馈与状态

| 组件 | 状态 | 备注 |
| --- | --- | --- |
| Spinner | 🆕 | `Loader2 animate-spin` |
| EmptyState | 🆕 | `{icon, title, description, action}` |
| ErrorState | 🆕 | `{title, description, onRetry}` |
| SkeletonRow / SkeletonCard | 🆕 | 表格 / 卡片专用 |
| StatusBadge | 🆕 | `running / success / failed / cancelled / pending` |
| StatusPill | 🆕 | Settings 连接健康度状态 |
| ConfirmDialog | 🆕 | 二次确认（destructive variant） |

### 列表与展示

| 组件 | 状态 | 备注 |
| --- | --- | --- |
| DataTable | 🆕 | 基于 TanStack Table + shadcn Table；支持排序、密度、行操作菜单、批量选择 |
| Pagination | 🆕 | 页码 + Page Size 切换 |
| CardGrid | 🆕 | 用于 Skill 卡片视图 |
| StreamingList | 🆕 | Trajectory / Trace 用，append-only + 跳到最新 |
| TimelineItem | 🆕 | 用于 skill-opt 步骤、Run 详情 |
| RelatedEntityList | 🆕 | 收口 feature-skill-used-jump-link 等关联跳转 |

### 数据展示

| 组件 | 状态 | 备注 |
| --- | --- | --- |
| CodeBlock | 🆕 | 基于 react-syntax-highlighter，一键复制 |
| JsonViewer | 🆕 | 包一层 react18-json-view，统一主题 + collapsed |
| CopyButton | 🆕 | 复制 + 1.5s 反馈 + toast |
| RelativeTime | 🆕 | "10 分钟前" + Tooltip 显示绝对时间 |
| AbsoluteTime | 🆕 | 详情页绝对时间 + 时区 + 相对时间副文本 |
| MetricValue | 🆕 | 数值 + 单位 + tabular-nums，支持 compact 格式 |
| ExternalLink | 🆕 | 自带外链图标 + target="_blank" |
| ProviderBadge | 🆕 | OpenAI / Anthropic / Gemini 等 |
| Tag | 🆕 | 类型标签（与 Badge 区分语义） |
| Prose | 🆕 | Markdown 容器（react-markdown + 项目 Token） |
| DiffViewer | 🆕 | 基于 `diff` 包，split / unified |

### 长文本与格式化

| 组件 | 状态 | 备注 |
| --- | --- | --- |
| TruncateText | 🆕 | 单行截断 + Tooltip 完整内容 |
| ClampText | 🆕 | 多行截断（`line-clamp-N`） |
| ExpandableText | 🆕 | 默认收起到 N 行，"展开 / 收起" |
| LongTextField | 🆕 | 预览 + Dialog 全文 + 一键复制 |
| TruncateMiddle | 🆕 | URL / 路径 中部省略 |
| IdChip | 🆕 | 长 ID 头尾保留 + 复制 |
| ErrorDetail | 🆕 | 错误堆栈折叠展示 + 复制 |
| TagList | 🆕 | 列表 + "+N" 超量提示 |
| TermPopover | 🆕 | 圆形 i 角标 + Popover 术语解释，6 类 type tag（详见 §2 E.14） |
| Term | 🆕 | TermPopover + 术语表注册表的薄包装；用法 `<Term id="p95-latency" />` |

### 多步骤流程

| 组件 | 状态 | 备注 |
| --- | --- | --- |
| Wizard | 🆕 | inline / side / dialog 三种模式 |
| Stepper | 🆕 | 步骤导航 + 5 种步骤状态 |
| WizardFooter | 🆕 | [上一步] [跳过] [下一步 / 完成] |
| SummaryStep | 🆕 | Wizard 末步：可逐项编辑回顾 |
| PrerequisiteChecklist | 🆕 | 流程入口的准备清单 |
| useWizardState / useWizardDraft / useStepGuard | 🆕 | 配套 hooks |

### 布局

| 组件 | 状态 | 备注 |
| --- | --- | --- |
| PageContainer | 🆕 | default / wide / canvas（**已废止 narrow**，详见 [`patterns.md`](./patterns.md) §1） |
| PageHeader | 🆕 | **6 槽位（eyebrow / title-row / description / hairline / banner / meta-strip）+ 3 变体（management / detail / live）**，完整契约见 [`patterns.md`](./patterns.md) §1 "PageHeader 锚定结构"；自查清单见本文件 §6 "PageHeader" |
| PageToolbar | 🆕 | search + filters + view switch |
| PageContent | 🆕 | 内容区，处理 scroll |
| PageFooter | 🆕 | 分页 / 表单 footer |
| Breadcrumbs | 🆕 | 列表式 + chevron |
| Stack / Grid | 🆕 | 轻量布局糖（可选） |
| FormShell + FormFooter | 🆕 | sticky 保存条 |
| FieldError / FormHint | 🆕 | 表单字段下方反馈 |

### 高阶 / 业务向

| 组件 | 状态 | 备注 |
| --- | --- | --- |
| ChartTooltip | 🆕 | Recharts Tooltip 统一样式 |
| chartPalette | 🆕 | 多系列配色 token |
| CommandPalette | 🆕 | cmd+k，基于 cmdk |
| DateRangeFilter | 🆕 | Dashboard / Trace / Metrics 通用 |
| FilterChipDropdown | 🆕 | 列表筛选 chip + dropdown |

---

---

## 5. 组件 API 约定

1. **导出**：`export function XxxComponent(...)` + `export type XxxProps`。
2. **样式**：用 `cn(...)` 合并 className，外部传入的 `className` 始终能覆盖默认。
3. **CVA**：变体多于 2 个的用 `class-variance-authority`，把 variants 用 type 暴露出来。
4. **Composability**：复合组件用 `<Card.Header>` 这种 dot notation 或 `CardHeader` 子导出。
5. **a11y**：图标按钮必有 `aria-label`；表单字段必有 `id` + `<Label htmlFor>`。
6. **Forward Refs**：基础控件 `React.forwardRef` 转发 ref，方便 React Hook Form 用。
7. **Headless 优先**：交互逻辑能用 Radix Primitive 就用，不要自造轮子。

---


---

## 6. PR Reviewer 自查表

> 复制下面 checklist 进 PR 描述，逐条勾选。

> Reviewer 收到 PR 后逐条勾选。任何一项打 × 都需要作者修改。

### 视觉

- [ ] 没有硬编码颜色（`#xxx` / `rgb(` / `bg-[#xxx]` / `text-gray-500` 等）
- [ ] 间距 / 圆角 / 阴影都用 Token 或 Tailwind utility
- [ ] 字号在 7 档 scale 内（不出现 `text-[15px]` 之类）
- [ ] 暗黑模式下截图没问题（至少手测一次）
- [ ] 图标统一 lucide-react，尺寸只用 14/16/20

### 组件

- [ ] 所有按钮用 `<Button>` 组件，没有 `<button className="...">`
- [ ] 输入控件用 `src/components/ui/*`，没有原生 `<select>`
- [ ] 弹窗用 `Dialog / Sheet / Popover` 封装，没有 fixed div 自管
- [ ] 反馈走 `toast.*`，没有 `alert / confirm`

### 布局

- [ ] 用 `<PageContainer>` 而不是 inline padding
- [ ] 用 `<PageHeader>` 渲染标题 / 面包屑 / 操作
- [ ] Card / 间距遵守 8px 网格

### 三态

- [ ] 加载有 Skeleton，不是空白或全屏 spinner
- [ ] 空数据有 `<EmptyState>` 引导动作
- [ ] 错误有 `<ErrorState>` 与"重试"

### 交互

- [ ] 列表 search/filter/sort/page 写入 URL（nuqs）
- [ ] Tab key 写入 URL
- [ ] 危险操作走 `<ConfirmDialog>`，文案 = 动词 + 对象 + 影响
- [ ] 表单未保存时离开有 confirm
- [ ] 主操作有 keyboard shortcut（至少 Enter / Cmd+S）
- [ ] 多步骤流程符合 [`patterns.md`](./patterns.md) §15（模式固定 / 步骤状态 / 草稿 / 可回退 / 错误模板 / 准备清单）

### 长文本与格式化（[`patterns.md`](./patterns.md) §2）

- [ ] 列表 / 卡片 / 表格里的长文本一律先截断（`<TruncateText>` / `<ClampText>`）
- [ ] 截断必须配合"完整态入口"（Tooltip / Dialog / Copy 三选一）
- [ ] Markdown 走 `<Prose>` / JSON 走 `<JsonViewer>` / 错误堆栈走 `<ErrorDetail>`
- [ ] 长 URL / 文件路径 / ID 用 `<TruncateMiddle>` 或 `<IdChip>`
- [ ] 数值用 `<MetricValue>` 或 `font-mono tabular-nums`
- [ ] 空值显示 `—`，不显示 `null` / `undefined` / `N/A`
- [ ] 术语解释走 `<TermPopover>` / `<Term id>`，不用 `<Tooltip>` 塞多行；术语在同一屏只在**首次出现**处挂角标

### 页面布局（[`patterns.md`](./patterns.md) §1 6 类模板）

- [ ] 页面布局选自 6 类模板之一（列表 / 详情 / 表单 / Dashboard / 流式 / 画布）
- [ ] 主操作位于 PageHeader 右上，次操作进 `…` Overflow
- [ ] 搜索在 Toolbar 左、视图切换在右；批量操作从 Toolbar 滑入
- [ ] 分页在 PageFooter 右、总数在左
- [ ] **页面铺满左对齐**：没有 `mx-auto + max-w-*` 居中整页内容；表单字段用 `max-w-xl` 限宽，但容器本身铺满

### PageHeader（[`patterns.md`](./patterns.md) §1 PageHeader 锚定结构）

> 全产品唯一的 PageHeader 结构。任何"自己用 `<h1>` + flex 拼"的都视作违规，CR 直接打回。
> 完整契约见 [`patterns.md`](./patterns.md) §1 "PageHeader 锚定结构"；本节只列 PR 自查条目。

**装配检查（page 用法）**

- [ ] 使用 `<PageHeader>` 组件渲染头部，**没有**任何页面自己用 `<h1>` + flexbox 拼装
- [ ] `<PageHeader>` 是 `<PageContainer>` 内的第一个子元素，且页面**只有 1 个** PageHeader
- [ ] PageHeader 没有自管 `padding` / `margin` / `max-width`（容器边距由 PageContainer 管）

**6 个槽位逐项检查**

- [ ] **① eyebrow** —— 至少传了 `breadcrumbs` 或 `moduleLabel` 之一（首页除外）；breadcrumb 至少 1 项
- [ ] **② title-row 左** —— 传了 `title`（必填，不允许为空字符串）；标题文本不含主操作动词（"上传 Skill" 不是标题，是 action）
- [ ] **② title-row 右** —— 三种变体（`management` / `detail` / `live`）**只选其一**；不存在"既传 action 又传 live" 的混乱状态
- [ ] **③ description** —— 如传，长度 ≤ 2 行；超 2 行用 `<ExpandableText>` 包；不允许把 description 当成"行动提示"塞 CTA 文案
- [ ] **④ hairline** —— 没有 `borderBottom={false}` / 自己叠 `border-b-0` 把底边隐藏（hairline 是结构性的）
- [ ] **⑤ banner** —— 如传，只用 1 个 `<Alert>`；多条通知请改走页面级 NotificationCenter，不要在 banner 里堆叠
- [ ] **⑥ meta-strip** —— 如传，`kind` 是 `kpi` / `filter` / `tabs` 三选一（互斥）；**不**允许一个 strip 同时放 filter 和 tabs

**3 种变体使用检查**

- [ ] `variant="management"`（列表/表单/管理类）—— title-row 右是**唯一** `default` Button；按钮文案是动词（"注册 Agent" / "上传 Skill"），不是"+ 新建"等通用词
- [ ] `variant="detail"`（详情类）—— title-row 右是 `default` Button + `ghost icon` `⋯` Overflow Menu；次要操作（Edit / Duplicate / Delete）进 Overflow，不直接铺在标题行
- [ ] `variant="live"`（Dashboard/流式）—— title-row 右是实时集群（StatusBadge 呼吸 + 时间戳 + 刷新频率 + 暂停按钮）；**不**允许把这组元素塞进 AppTopBar 或散落在页面其他位置

**视觉签名 3 处（§A.5.1）**

- [ ] 标题字号是 `text-2xl font-semibold`（24/32），**不是** `text-lg` / `text-xl` / `text-3xl`；非 PageHeader 不允许使用 `text-2xl` 模仿
- [ ] Breadcrumb 分隔符是 ` › `（U+203A），颜色 `var(--primary) / 50%`；**不是** `/` / `>` / `→`
- [ ] 主操作 / 实时集群在 title-row **右上**；没有把主操作 inline 写在标题旁（如 `<h1>Skill 管理 <Button>上传</Button></h1>`）

**实时集群专项（仅 `variant="live"` 适用）**

- [ ] 时间戳用 `font-mono tabular-nums`（数值跳动不抖格）
- [ ] 状态徽章是 `<StatusBadge status="running">`，带呼吸 dot（§0.2 锚点①）
- [ ] 刷新频率可点击切换（`1s / 3s / 5s / 15s / 30s / 1m` 六档）
- [ ] 暂停按钮文案随状态切换（`暂停` ↔ `继续`），不是固定文案 + 状态指示

**meta-strip 专项**

- [ ] `kind="kpi"` 时，每个 KPI 的数值走 `<MetricValue>`（§0.2 锚点③），**没有**自己用 `<span>` 拼数值 + 单位
- [ ] `kind="filter"` 时，FilterBar 在 meta-strip 内**或**在 PageToolbar 内，**不能两处都有**（一份筛选状态不能写两遍）
- [ ] `kind="tabs"` 时，Tab key 通过 nuqs 写进 URL `?tab=...`
- [ ] 列表页 / Tabs 详情页设置 `stickyMeta` 让滚动后筛选 / Tab 仍可见

**红线对照（CR 直接打回 · 来自 §A.5.6）**

- [ ] 没有 `<h1 className="text-3xl">` 等自定义标题字号
- [ ] 没有把"+ 上传"/"+ 新建" inline 写在标题文本旁
- [ ] 没有把"实时刷新"/"暂停"按钮放在 AppTopBar 或独立条
- [ ] 没有把通知 banner 写成 PageHeader 之外的独立卡片
- [ ] 没有用 `/` `>` `→` 作为 breadcrumb 分隔符
- [ ] 没有自己 grid 拼 KPI Strip（必须 `metaStrip.kind='kpi'`）
- [ ] 没有同一行 meta-strip 既塞 filter 又塞 tabs

### 文案

- [ ] 用户可见文案走 i18n
- [ ] 按钮文案是动词（"删除"而不是"是 / 确认"）
- [ ] 错误信息可操作（说清楚怎么办）
- [ ] 术语与 `docs/PROJECT.md` 一致

### 可访问性

- [ ] 图标按钮有 `aria-label`
- [ ] 表单字段有 Label + 错误的 `aria-invalid`
- [ ] Tab 顺序合理
- [ ] 焦点环可见

### 性能与代码

- [ ] 没有未使用的 import / class
- [ ] 没有 `console.log`（debug 用 `console.debug` 或日志库）
- [ ] 没有 `// TODO` 没有 issue 链接
- [ ] 改动了 globals.css 的，必须在 PR 描述里 @设计

---

---

## 7. 旧代码迁移对照表（重构时查）

| 旧写法 | 新写法 |
| --- | --- |
| `<button className="ai-btn-p">` | `<Button>` |
| `<button className="ai-btn-sp">` | `<Button variant="secondary">` |
| `<button className="ai-btn-s">` | `<Button variant="outline" size="sm">` |
| `<button className="btn-primary">` | `<Button>` |
| `<button className="btn-delete">` | `<Button variant="destructive" size="sm">` |
| `style={{ padding: '12px 20px 24px' }}` | `<PageContainer>` |
| `className="dashboard-container"` | `<PageContainer variant="wide">` |
| `className="ai-card"` / `.skill-card` | `<Card>` |
| `className="ai-badge ai-badge-g"` | `<Badge variant="success">` |
| `className="type-chip"` | `<Tag>` |
| `className="metadata-badge"` | `<Badge variant="secondary" size="sm">` |
| `alert(msg)` | `toast.error(msg)` |
| `confirm('确定？')` | `<ConfirmDialog>` |
| `<table>` 手写 | `<DataTable>` |
| `<td>{longText}</td>` 长文本直接铺 | `<TruncateText>` / `<ClampText>` + Tooltip |
| `JSON.stringify(obj, null, 2)` 塞 `<pre>` | `<JsonViewer collapsed depth={2}>` |
| `<div>{err.stack}</div>` 暴露堆栈 | `<ErrorDetail>` |
| 长 URL / 长 ID 不截断 | `<TruncateMiddle>` / `<IdChip>` |
| 显示 `null` / `undefined` / `N/A` | 显示 `—` |
| Markdown `dangerouslySetInnerHTML` | `<Prose>` 包 react-markdown |
| 多步骤一次性塞一个大表单 | `<Wizard mode="inline/side/dialog">` |
| 自创页面布局 | 选 [`patterns.md`](./patterns.md) §1 的 6 类模板之一 |
| `<div className="mx-auto max-w-[960px]">` 整页居中 | `<PageContainer>` 铺满 + 表单字段 `max-w-xl` 左对齐 |
| `<div className="container mx-auto">` | `<PageContainer>` 铺满，左对齐 |
| `<h1 className="text-3xl">Skill 管理 <Button>+ 上传</Button></h1>` 主操作 inline | `<PageHeader variant="management" title="Skill 管理" action={{ label: '上传 Skill', ... }} />` |
| 自己写 breadcrumb：`Skills / 管理已接入 Agent` | `<PageHeader breadcrumbs={[{ label: 'Skills' }, { label: '管理已接入 Agent' }]} />`（分隔符 ` › ` 自动渲染） |
| AppTopBar 里塞"实时刷新 / 3s / 暂停" | `<PageHeader variant="live" live={{ lastUpdate, refreshRate: '3s', paused, onTogglePause }} />` |
| 通知 banner 写成 PageHeader 之外的卡片 | `<PageHeader banner={{ variant: 'info', message: '...', action: {...} }} />` |
| KPI 4 卡自己 grid `<div className="grid grid-cols-4">` | `<PageHeader metaStrip={{ kind: 'kpi', items: [...] }} />`，KPI 数值内走 `<MetricValue>` |
| 列表页"筛选与排序"独立卡片 | `<PageHeader metaStrip={{ kind: 'filter', children: <FilterBar /> }} />` 或留在 PageToolbar，二选一 |
| `<h1 className="text-3xl">` / `text-xl` 等非标标题 | `<PageHeader title="...">`（内部强制 `text-2xl font-semibold`） |
| inline `style={btnStyle}` | `<Button>` |
| `bg-white` / `bg-gray-50` | `bg-card` / `bg-background-secondary` |
| `text-gray-500` | `text-foreground-secondary` 或 `text-foreground-muted` |
| `border-gray-200` | `border-border` |
| `localStorage` 存筛选 | `useQueryStates` (nuqs) |
| `<span title="P95 时延是...">P95</span>` 原生 title | `<Term id="p95-latency" />` |
| `<Tooltip><span>P95 <Info /></span><div>多行解释...</div></Tooltip>` Tooltip 塞多行术语 | `<Term id="p95-latency" />`（用 TermPopover，支持 formula / related） |
| 自管 popover `<div className="popover-card">...</div>` + 自写 hover 显隐 | `<TermPopover>`（基于 Radix Tooltip 悬停触发，三端可达） |

---

---

## 8. 开发起步建议

如果你是新接手这个项目的工程师：

1. 先读 [`README.md`](./README.md) 了解文档结构。
2. 读 [`foundations.md`](./foundations.md) §10 Token 字典熟悉 Token 名字（开发时按 token 写代码）。
3. 看 [`patterns.md`](./patterns.md) §17 PR 验收 Checklist 做快速对照。
4. 写代码时左手开本文件 §4 组件清单和 §7 迁移对照表随时查。
5. PR 提交前自走一遍本文件 §6 PR Reviewer 自查表。
6. 任何"我不知道该用哪个组件"的情况，先在 `#design-system` 频道或 PR 里 @设计。

---

---

## 9. 例外管理

任何偏离标准的写法都必须：

1. 在 PR 描述写明理由。
2. 在代码上方加注释 `// design-exception: <原因> · <ref to issue>`。
3. 设计 / 前端 TL 至少一人 approve。

定期（每季度）梳理 exception 数量，超阈值意味着标准需要修订。
