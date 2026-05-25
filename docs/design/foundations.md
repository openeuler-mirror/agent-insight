# Foundations — 视觉基础与主题约束

> **目录**：视觉定位 → 主题与暗黑模式 → 颜色 → 字体 → 间距/圆角/阴影 → 动效 → 响应式 → 国际化 → 可访问性 → 克制的科技感 → Token 字典 → Z-index
>
> **本文件覆盖**：所有"页面级以下"的视觉决策——颜色、字体、Token、暗黑、动效、a11y。
> **页面骨架、组件 API、交互行为**：分别见 [`patterns.md`](./patterns.md) 与 [`components.md`](./components.md)。
>
> **唯一事实来源（SOT）**：所有 Token 的实际值在 [`src/app/globals.css`](../../src/app/globals.css) 的 `:root` 与 `[data-theme='dark']` 双声明块；本文件只描述**规则**与**索引**，不复述 hex 值。

---

## 0. 视觉定位：Observability 专业风

Agent Insight 的产品定位是 **Skill 评估与观测平台（LLM Observability）**：高密度数据、多状态信号、长时间盯屏、专家用户。视觉风格必须为这种使用场景服务——既不能是面向消费者的"花哨产品风"，也不能是冷硬的"工业控制台风"。

我们选择的视觉方向是 **Observability 专业风**，灵感来源与我们做的取舍：

| 参考产品 | 学习什么 | 不学什么 |
| --- | --- | --- |
| **Grafana** | Indigo/Purple 主色 + 深中性灰底；多状态信号清晰；图表 token 化 | 过深的纯黑底、过密的工程师味 |
| **Datadog** | 大量数据表格的密度处理；行为状态色系；金融级 tabular nums | 信息冗余、Tab 嵌套过深 |
| **Honeycomb / Tempo / Jaeger** | Trace 时间轴、Span 颜色编码、Trajectory 流式视图 | 暗色为主，对小屏不友好 |
| **Langfuse**（同领域开源） | LLM 观测术语与卡片骨架；Token / Cost / Latency 三件套 | 蓝绿杂糅、品牌不统一 |
| **Vercel Geist + Linear** | 中性灰阶基底；动效节奏；间距 8px 网格 | 信息密度偏低 |
| **shadcn/ui + Radix Colors** | 组件 API 与可访问性 | 默认配色偏中性，缺少观测语义 |

提炼出 Agent Insight 的视觉关键词：

> **冷静、高密度、强信号、可凝视。**
>
> 95% 灰阶背景 + Indigo 主色（仅用于"可交互"语义）+ 5 个状态色（仅用于"状态"语义）。任何超出这 7 个语义色之外的颜色都**不允许**作为装饰使用。

### 0.1 视觉原则（写代码 / 评设计稿前默念）

1. **页面默认是灰阶世界**。第一眼看不出主色的页面，才是合格的 Observability 页面。
2. **颜色用来传递信息，而不是装饰**。每一个非灰阶颜色都必须对应"语义"——主色 = 可交互；红 = 失败；绿 = 成功；琥珀 = 警告；紫 = AI / 模型。
3. **数据是主角，UI 是脚手架**。卡片 / 边框 / 阴影必须克制，给数据让位。
4. **稳态优于动效**。Observability 屏要被长时间盯着看，所有动效必须 ≤ 300ms 且 `ease-out`，禁止 spring / 反弹 / 大幅缩放。
5. **状态可见 / 可预期 / 可恢复**。Running / Success / Failed / Cancelled / Pending 必须用 **颜色 + 图标 + 文案三重编码**，不能只靠颜色。
6. **数字必须可对齐**。所有 metric / count / duration 必须用 `tabular-nums + font-mono`，列右对齐。
7. **暗黑模式是一等公民**，不是事后补丁。所有 Token 必须同时在 Light/Dark 下被验证。
8. **识别度只投放在 3 处**（详见 §0.2）。其余位置一律不许"做设计"。
9. **一致性是物理的，不是约定的**——"同类功能用同一个组件"指的是 import 同一个文件（详见 [`components.md`](./components.md)）。
10. **暗黑模式是品牌主表达，不是降级方案**。任何视觉决策必须**先在 dark 下成立**，再回推 light。
11. **微动效只服务一种叙事："状态在改变"**。允许动效的位置只有 3 处：运行态呼吸、Toast 滑入、Tab 下划线滑动。

### 0.2 三个识别锚点（产品 DNA · 只在这三处投放视觉个性）

> 全产品只挑 3 处投放视觉个性，其余 95% 仍然是灰阶克制。这 3 处合起来才是 Agent Insight 的 DNA，缺一个产品就泛 SaaS，多一个就开始噪音。
>
> 任何 PR 想加"科技感装饰"——先回到这张表，**对不上号就不要加**。

| 锚点 | 出现位置（仅限） | 视觉规则 | 为什么是它 |
| --- | --- | --- | --- |
| **① 呼吸态运行指示** | 所有 `running` 状态徽章；Sidebar Active 项左侧 2px 竖条；流式页"跳到最新"浮动按钮；Trace Span 正在执行的节点 dot | 8px solid dot，`transform: scale(1) → scale(1.15) → scale(1)`，周期 **1.6s** `ease-in-out` 无限循环。与 `Loader2` 旋转图标**二选一**，不同时使用 | "运行中" 是 Observability 产品出现频率最高的状态。统一的呼吸节奏让用户在任意页面 1 秒内识别 |
| **② AI / 流式 / 自动评分 卡片描边** | 仅 3 处：①Skill 推理输出卡片 ②Trace 流式 Span 卡片 ③Eval AI 自动评分卡片 | 1px **渐变描边**：`linear-gradient(135deg, var(--primary) 0%, #EC4899 100%)`（Indigo → Pink）+ `--card-bg` 内填充；hover 时 opacity `0.5 → 1`。**其他卡片一律禁止** | 让用户一眼区分"模型生成"与"系统记录"。135° 渐变是产品视觉签名 |
| **③ 等宽数字 + 单位 对位呈现** | 所有 KPI 卡 / 表格数值列 / 详情 metadata 的数值 | `<MetricValue>` 强制三段式：`font-mono tabular-nums text-2xl font-semibold` 数字 + 半字号灰色下标单位 + 数字基线对齐的 1px 灰色 baseline；右对齐 | Observability 的"数据感"完全来自数字的视觉表达；不是装饰，是技术语言 |

**实现位置**（v1.3 必须落地的 3 个组件）：

```
src/components/feedback/StatusBadge.tsx   →  锚点 ①
src/components/feedback/AiCard.tsx        →  锚点 ②
src/components/text/MetricValue.tsx       →  锚点 ③
```

> **🚫 红线**：这 3 处之外的"科技感投放"全部禁止。
> - ❌ Card Header 加渐变横线 / 渐变图标
> - ❌ Hover 时按钮加发光 / 缩放 / 变色相
> - ❌ 数字直接 `<span>{value}</span>` 不用 MetricValue
> - ❌ 在 Dashboard 顶部加"科技背景"（点阵 + 渐变）

---

## 1. 主题与暗黑模式（5 条红线）

### 1.1 当前架构（已落地，保留不变）

```
single source of truth: src/app/globals.css
  ├── @theme { --color-* : var(--*) }         注册 Tailwind 工具类
  ├── :root { --background:#fff; ... }         Light 值
  └── [data-theme='dark'] { --background:#09090B; ... }   Dark 值
切换：next-themes → <html data-theme="...">
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
```

这是 shadcn/ui + Tailwind v4 的标准范式。**不要再加第二套机制**（不要混用 `dark:` 前缀 + 媒体查询 + 自定义 hook）。

### 1.2 5 条强制约束（PR 自查 & Reviewer 复核）

| # | 约束 | 反例（违反） | 正确写法 |
| --- | --- | --- | --- |
| 1 | **任何颜色必须走 token**：组件里不许出现 `#xxxxxx` / `rgb(...)` / `rgba(...)` / `bg-[#xxx]` / Tailwind 调色板字面色（`text-gray-500`） | `box-shadow: 0 4px 12px rgba(79,70,229,.12)` | `box-shadow: 0 4px 12px var(--shadow-primary)` |
| 2 | **同一 token 必须在 `:root` 和 `[data-theme='dark']` 同名同语义双声明**——禁止只声明一处 | `:root { --foo }` 而 `[data-theme='dark']` 没有 | 两个块都声明 `--foo` |
| 3 | **组件中禁止 `dark:` 前缀**（除非该值确实无法 token 化，如 SVG 内联） | `class="bg-white dark:bg-zinc-900"` | `class="bg-card"` |
| 4 | **shadow / overlay / gradient 必须 token 化**——这是最容易被忽略的（黑底上看不见的浅黑阴影） | 直接 `shadow-lg` 用默认黑阴影 | `--shadow-color` / `--shadow-primary` 双模式声明 |
| 5 | **PR 必须附两张截图（Light + Dark）**，且两套模式都通过对比度门：正文 ≥ 4.5:1、关键 ≥ 7:1、图表相邻系列 ≥ 3:1 | 只截亮色 | 用 preview 同页双截 |

### 1.3 切换行为

- 仅"亮 / 暗"两套，**不允许第三套品牌主题**。
- `next-themes` 默认跟随系统；用户偏好写 `localStorage`。
- 切换瞬间不能闪烁（通过 `data-theme` + script 注入解决）。

### 1.4 暗黑模式特殊规则（Observability 用户大量在夜间盯屏）

- **暗黑底色不能用纯黑 `#000`**（与状态色对比过强、视觉疲劳）。用 `#09090B`（zinc-950）。
- **暗黑下主色变亮**：Indigo 600 → Indigo 400，否则灰阶吃掉主色。
- **暗黑下卡片用 Surface 分层**：底 `#09090B` < 卡片 `#18181B` < 嵌套卡片 `#27272A`，靠层次而不是边框。
- **暗黑下状态 Subtle 用 rgba 半透明**（已落 Token），而不是固定深色。
- **图表线条暗黑下变亮 1 档**，确保 ≥ 3:1 对比。

### 1.5 自动适配机制

所有组件用 CSS variable 驱动，不允许在 component 里写 `dark:bg-*` 之类 Tailwind dark 前缀（除非该值无法 token 化）。

---

## 2. 颜色系统

### B.1 三层色系（一定要分清楚）

```
1. 中性灰阶（Surface 层）—— 占 95% 的视觉面积
2. 品牌主色 Indigo（Interaction 层）—— 仅用于"可交互"语义
3. 语义状态色（Signal 层）—— 仅用于状态描述
```

任何超出这三层的颜色都属于**装饰色**，**装饰色不被允许使用**。

### B.2 灰阶（Surface）—— 页面的呼吸

观测平台的灰阶不能用 Tailwind 默认 `gray-*`（偏蓝偏冷）；我们用 **Zinc 色阶**（中性偏暖一点点），更适合长时间盯屏。

| Token | Light | Dark | 用途 |
| --- | --- | --- | --- |
| `--background` | `#FFFFFF` | `#09090B` | 页面底色（最外层） |
| `--background-secondary` | `#F4F4F5` | `#27272A` | 卡片底色 / 区块切分 |
| `--background-tertiary` | `#FAFAFA` | `#18181B` | 嵌套卡片、Code block 底 |
| `--card-bg` | `#FFFFFF` | `#18181B` | Card 表面 |
| `--card-border` | `#E4E4E7` | `#27272A` | Card 边框（1px） |
| `--sidebar-bg` | `#FAFAFA` | `#09090B` | Sidebar 底色（比 background 略深，构成视觉锚定） |
| `--foreground` | `#18181B` | `#FAFAFA` | 主要文字（标题、值） |
| `--foreground-secondary` | `#52525B` | `#A1A1AA` | 次要文字（label、提示） |
| `--foreground-muted` | `#71717A` | `#71717A` | 三级文字（占位、注释、辅助说明） |
| `--border` | `#E4E4E7` | `#27272A` | 通用 1px 分隔线 |
| `--border-dark` | `#D4D4D8` | `#3F3F46` | 强调分隔（如表头底部） |

**对比度约束**：
- 主要文字 vs 背景 ≥ **7:1**（WCAG AAA，Observability 屏要久看，标准比 AA 更高）。
- 次要文字 vs 背景 ≥ **4.5:1**。
- 边框 vs 背景 ≥ **1.5:1**（边框不算文字，但要看得见）。

### B.3 品牌主色 Indigo（Interaction 层）

> 这是整个产品**唯一**的非灰非状态色。Indigo 同时承担了 Grafana 的紫主调 + Linear 的中性现代感。

| Token | Light (`#`) | Dark (`#`) | 用途 |
| --- | --- | --- | --- |
| `--primary` | `4F46E5` | `818CF8` | 主操作按钮底、Active Tab、链接 |
| `--primary-hover` | `4338CA` | `A5B4FC` | Hover 态 |
| `--primary-foreground` | `FFFFFF` | `FFFFFF` | 主色之上的文字 |
| `--primary-subtle` | `EEF2FF` | `rgba(129,140,248,.15)` | 选中行背景、Subtle Button、Tag 背景 |
| `--primary-subtle-border` | `C7D2FE` | `rgba(129,140,248,.30)` | Subtle 容器的边框 |
| `--ring` | `rgba(79,70,229,.25)` | `rgba(129,140,248,.40)` | Focus 环 |

**主色使用白名单（这五处之外一律不允许用主色）**：

1. **主操作按钮**（每屏最多 1 个 `default` Button）。
2. **选中态**：选中的行、Active Tab、Active Sidebar 项的左侧 2px 竖条 + Subtle 背景。
3. **链接**：行内可点击的文本。
4. **Focus Ring**：键盘聚焦的 3px 环（不可去除）。
5. **品牌 Logo / 启动屏**。

**典型反例**：
- ❌ 在 Card Header 加一条紫色装饰横线 → 改为不加。
- ❌ 用主色画图表数据线 → 单序列允许、多序列不允许（用 chart palette）。
- ❌ 用主色当 Badge 装饰 → 改用灰色 Tag。

### B.4 语义状态色（Signal 层）—— Observability 的命脉

观测平台的状态色不是 5 个，是 **6 个** —— 默认的 `success / warning / error` 之外，必须额外区分 `running`（运行中，蓝色非紫）、`cancelled`（已取消，中性灰）、`pending`（等待中，灰带轮转）。

#### B.4.1 状态色板（双语义：状态文本 + Subtle 容器）

| 状态 | Token | Light Hex | Dark Hex | Subtle BG | Subtle Border | 何时使用 |
| --- | --- | --- | --- | --- | --- | --- |
| 🔵 Running | `--running` | `2563EB` | `60A5FA` | `EFF6FF` / `rgba(96,165,250,.12)` | `BFDBFE` / `rgba(96,165,250,.25)` | 任务运行中、流式输出中 |
| 🟢 Success | `--success` | `16A34A` | `4ADE80` | `F0FDF4` / `rgba(74,222,128,.12)` | `BBF7D0` / `rgba(74,222,128,.25)` | 完成、通过、健康 |
| 🟡 Warning | `--warning` | `D97706` | `FBBF24` | `FFFBEB` / `rgba(251,191,36,.12)` | `FDE68A` / `rgba(251,191,36,.25)` | 部分成功、需要注意、降级 |
| 🔴 Error | `--error` | `DC2626` | `F87171` | `FEF2F2` / `rgba(248,113,113,.12)` | `FECACA` / `rgba(248,113,113,.25)` | 失败、错误、不可用 |
| ⚫ Cancelled | `--cancelled` | `71717A` | `A1A1AA` | `F4F4F5` / `#27272A` | `D4D4D8` / `#3F3F46` | 已取消、跳过、中止 |
| ◯ Pending | `--pending` | `A1A1AA` | `71717A` | `FAFAFA` / `#18181B` | `E4E4E7` / `#27272A` | 等待中、队列中（伴随 spinner） |

> 蓝色 `Running` 选 **#2563EB**（Blue-600）而不是 `--primary` Indigo —— 这是有意为之：避免"运行中"和"主操作按钮"在同一屏里争抢用户注意力。

#### B.4.2 状态必须**三重编码**

颜色不可独立承担信息：

```tsx
// ✅ 颜色 + 图标 + 文案三件套
<StatusBadge status="failed">
  <XCircleIcon className="size-3.5" />
  <span>失败</span>
</StatusBadge>

// ❌ 只靠红色块
<div className="size-2 rounded-full bg-error" />
```

固定图标映射（lucide-react）：

| 状态 | 图标 |
| --- | --- |
| Running | `Loader2 animate-spin` |
| Success | `CheckCircle2` |
| Warning | `AlertTriangle` |
| Error | `XCircle` |
| Cancelled | `Ban` |
| Pending | `Clock` |
| Queued | `MoreHorizontal`（小圆点轮转） |

#### B.4.3 状态色"何时是 Solid 何时是 Subtle"

| 形态 | 视觉 | 适用 |
| --- | --- | --- |
| **Solid Dot** (8px 圆点) | 纯色填充 | 状态指示器、列表行首小标 |
| **Subtle Badge** (背景 subtle + 文字 solid + 1px border) | 浅色块 | StatusBadge、表格内状态列 |
| **Outline Badge** (透明底 + 1px solid border + 文字 solid) | 描边 | 详情页顶部主状态（更高强度） |
| **Solid Banner** (整条 subtle 底色 + 左侧 4px solid 边) | 横幅 | 全页错误 / 警告通知 |

不允许用 **整片纯色填充** 作为状态展示（视觉灾难）。

### B.5 类型标签（Tag）色板

类型标签 ≠ 状态徽章 —— 类型是"它是什么"，状态是"它现在怎样"。

类型标签**全部使用灰色 Tag**（除"AI / 模型"领域类标签外）。原因：避免视觉噪音。

| Tag | 用例 | 背景 | 文字 |
| --- | --- | --- | --- |
| 默认灰 Tag | `LLM` / `TOOL` / `AGENT` / `TASK` / 版本号 / 数据集名 | `--tag-gray-bg` | `--tag-gray-fg` |
| 紫 Tag | 仅用于"AI / Model / Provider"领域 | `--tag-purple-bg` | `--tag-purple-fg` |

模型供应商专用 `<ProviderBadge>`（带 16px 单色图标 + 名称）：

| Provider | 图标颜色 | 文字 |
| --- | --- | --- |
| OpenAI | `#00A67E` | OpenAI |
| Anthropic | `#D97706` | Anthropic |
| Google | `#4285F4` | Gemini |
| 国内厂商 | 灰阶 | 名称 |

> 这些颜色 **仅在 16px 图标内** 出现，外围的 Badge 容器仍是 `--tag-gray-bg`。

### B.6 图表配色（Chart Palette）

观测平台一定会画 N 条线 / N 个柱子，必须有专门的离散调色板。

#### B.6.1 离散色板（Categorical · 最多 8 色）

适用：多模型对比、多 Skill 趋势、多 Run 比较。色相按 30° 间隔取，亮度统一：

| 序号 | Light | Dark | 备注 |
| --- | --- | --- | --- |
| 1 | `#4F46E5` Indigo | `#818CF8` | 主色，默认第一序列 |
| 2 | `#0EA5E9` Sky | `#38BDF8` | |
| 3 | `#10B981` Emerald | `#34D399` | |
| 4 | `#F59E0B` Amber | `#FBBF24` | **🚫 仅 warning 语义**，详见下方红线 |
| 5 | `#EF4444` Red | `#F87171` | **🚫 仅 error 语义**，详见下方红线 |
| 6 | `#8B5CF6` Violet | `#A78BFA` | |
| 7 | `#EC4899` Pink | `#F472B6` | |
| 8 | `#14B8A6` Teal | `#2DD4BF` | |

落到 `src/lib/charts/palette.ts`，导出常量 `CHART_PALETTE`，禁止图表中硬编码十六进制。

> **🚫 红线 · 语义保留色**
>
> **Amber（#4）和 Red（#5）只能用于"警告 / 错误"语义**，不可作为类型 / 类别 / Span 类型的着色。
>
> 这是因为 Amber 在本项目中同时承担 `--warning`、"慢节点"（>60s）、"重试中"等状态色（详见 §B.4.1），Red 承担 `--error`。把它们再分配给一个**类型**（比如某个 Span 类型、某个模型、某种 Tool）会让用户产生强烈的"这条线 / 这个 Span 出问题了"的错觉。
>
> **合法用法**：当图表序列本身就在表达警告 / 错误（例如"错误率 over time"），用这两色是正确的；除此之外类型着色一律从其余 6 槽中挑。
>
> **典型反例与修正**：旧版 `LLM` Span 用 Amber，被读者误判为"LLM 出问题了"。当前为 Violet（详见 [`components.md`](./components.md) §2 "E.13 Trace / Trajectory 专用"，含 amber→teal→pink→violet 四次迭代的完整原因）。

#### B.6.2 顺序色板（Sequential · 用于热力图、密度图）

```
indigo-50  → indigo-100 → indigo-200 → indigo-400 → indigo-600 → indigo-800
```

#### B.6.3 双向色板（Diverging · 用于"提升 / 下降"差值）

```
绿色端 — 灰色中点 — 红色端
#16A34A → #71717A → #DC2626
```

例如"评估对比"的 Δ 值，正数走绿、负数走红、零附近灰。

#### B.6.4 图表元素

- 网格线：`--border` 1px **虚线** `dasharray: 2 4`，**不用**实线（实线压数据）。
- 坐标轴标签：`text-xs text-foreground-muted`。
- Tooltip：白底 / 暗底 + `shadow-sm` + `rounded-lg` + `tabular-nums`。
- 缺失数据：用空白而不是 0，并在图例上标"无数据"。

---

---

## 3. 字体与排版

### C.1 字体族

```css
--font-sans:  Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-mono:  "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
```

- 主字体 **Inter**（通过 `next/font/google` 引入，自托管，避免外部 CDN 延迟）。
- 等宽字体 **JetBrains Mono** 或回退 SFMono。
- 中文走系统字体回退（PingFang SC / 微软雅黑），不强制 Web Font。

### C.2 字号 scale（仅 7 档，不允许新增）

> ⚠️ **本项目对 Tailwind 默认 fontSize 做了向下一档的覆盖**，定义在 [`tailwind.config.ts`](../../tailwind.config.ts) 的 `theme.extend.fontSize`：
> - `text-xs` = 11/16 （Tailwind 默认 12/16）
> - `text-sm` = 12/18 （Tailwind 默认 14/20）
> - `text-base` = 14/20 （Tailwind 默认 16/24）
>
> **动机**：Observability 平台需要高信息密度（参考 Datadog / Grafana），把正文与辅助字号各下降一档可以在 1024–1440 屏宽下多塞 15-20% 的可视行数。`text-lg / text-xl / text-2xl / text-3xl` 沿用 Tailwind 默认，仅用于标题。

| 用途 | Tailwind class | 实际（项目 token） | 字重 | 行高 |
| --- | --- | --- | --- | --- |
| Display（仅 Login / 错误页） | `text-3xl` | 30/36 | 600 | tight |
| 页面标题 H1 | `text-2xl` | 24/32 | 600 | tight |
| 区块标题 H2 | `text-xl` | 20/28 | 600 | snug |
| 卡片标题 H3 | `text-base font-semibold` | **14/20** | 600 | snug |
| 正文 Body | `text-sm` | **12/18** | 400 | normal |
| 表格 / 辅助 Caption | `text-xs` | **11/16** | 500 | normal |
| Code / 数值 | `font-mono text-sm` | **12/18** | 400 | normal |

字重只允许 4 档：`400 / 500 / 600 / 700`。**禁止** `300 / 800 / 900` 等极端值。

**红线**：禁止使用 `text-[15px]` / `text-[13px]` 这种任意值字号。需要 14px 用 `text-base`，需要 12px 用 `text-sm`。如果设计稿要的字号不在 7 档之内，先回去和设计对齐——多半是设计稿越界，而不是 token 不够用。

### C.3 数值排版（Observability 关键）

所有指标、计数、耗时、Token 数、价格、比例必须：

1. 字体：`font-mono`。
2. 数字：`tabular-nums` —— 等宽数字，防止变化时抖动。
3. 对齐：表格内向**右对齐**。
4. 单位：与数值不同字号 / 字色 `text-xs text-foreground-muted`。
5. 大数字千分位：用 `Intl.NumberFormat`，不要 toFixed + 字符串拼接。

封装 `<MetricValue value={1234567} unit="tokens" format="compact">` → 显示 `1.23M tokens`。

### C.4 行宽

- 段落最大行宽 **72ch**（约 600px），避免长行难读。
- Code Block 不限宽，但提供横向滚动 + 一键复制。

---

---

## 4. 间距、圆角、阴影

### D.1 间距（8px 网格）

| 场景 | 间距 |
| --- | --- |
| 表单字段纵向 | `space-y-4` (16px) |
| 卡片之间 | `gap-4` (16px) |
| 卡片内分区 | `space-y-3` (12px) |
| 紧凑列表行 | `gap-2` (8px) |
| 内联图标与文字 | `gap-1.5` (6px) |
| Badge 内 padding | `px-2 py-0.5` (8×2) |

> 不允许出现 `gap-[7px]`、`p-[13px]` 这种非 4 倍数值。

### D.2 圆角

| Token | 值 | 用途 |
| --- | --- | --- |
| `--radius-sm` | 6px | Badge / Tag / Chip / Code inline |
| `--radius` | 8px | Input / Button / Select |
| `--radius-lg` | 10px | Card / Dialog / Popover |
| `rounded-full` | 9999px | Avatar / Status Dot |

观测平台不要用 `--radius-xl`（≥ 16px）—— 太柔，不专业。

### D.3 阴影（仅 3 档）

| Token | 用途 |
| --- | --- |
| `shadow-xs` | 默认 Card |
| `shadow-sm` | Hover、Dropdown、Popover、Toast |
| `shadow-lg` | Dialog、Sheet |

禁止自定义 box-shadow。

---

---

## 5. 动效

- 时长：`120ms` (微交互) / `200ms` (悬浮、打开关闭) / `300ms` (页面切换)。
- 曲线：统一 `cubic-bezier(0.16, 1, 0.3, 1)` (ease-out-expo)，Tailwind `ease-out`。
- 禁止 spring / 大幅 scale / 反弹。Observability 不需要"活泼"。
- `prefers-reduced-motion: reduce` 时全部降级为 0 时长。
- 复杂动画用 `framer-motion`，简单 hover/focus 用 CSS transition。

---

## 6. 响应式

| 断点 | 宽度 | 主要变化 |
| --- | --- | --- |
| `sm` | ≥ 640 | 移动适配（罕用） |
| `md` | ≥ 768 | Sidebar 折叠为图标 |
| `lg` | ≥ 1024 | 默认开发目标 |
| `xl` | ≥ 1280 | 多列 Dashboard |
| `2xl` | ≥ 1536 | 最大容器宽度生效 |

主产品定位是桌面端，但页面布局必须在 ≥ 1024 不破。


---

## 7. 国际化

- 所有面向用户的文案必须走 i18n，不允许写死中文 / 英文。
- 数字 / 时间格式走 `Intl.NumberFormat / Intl.DateTimeFormat`，禁止 toFixed + 字符串拼接。
- 时区：默认本地，详情页可显示 UTC + 本地双时区（Trace 跨时区调试场景）。

---

---

## 8. 可访问性（WCAG 2.1 AA / 部分 AAA）

观测屏会被长时间盯着看，可访问性要求高于通用产品：

1. **正文对比度 ≥ 7:1**（WCAG AAA）；标签 ≥ 4.5:1；图表数据线相邻系列必须 ≥ 3:1。
2. 所有交互元素 Tab 可达 + 可见 Focus 环（已通过 `focus-visible:ring-ring/50 ring-[3px]`）。
3. 仅靠颜色不能传达信息（状态 = 颜色 + 图标 + 文案三重编码）。
4. 表单错误用 `aria-invalid` + `aria-describedby`。
5. 弹窗 / 抽屉自动聚焦首个可聚焦元素，Esc 关闭，焦点回到触发器（Radix 已处理）。
6. 长内容区设置 `aria-live="polite"`。
7. 全站支持 `prefers-reduced-motion: reduce`（关闭所有 transition）。
8. 色盲友好：状态色使用图标 + 文案兜底；图表多序列使用 chart palette（已规避红绿混淆）。

---

---

## 9. 克制的科技感（Restrained Tech Feel）

> §0.1 + §0.2 已经规定了"哪里允许有个性"。本节规定**那些不算个性、但能让产品看起来"专业 / 技术 / 有质感"的 5 个细节**。它们与 §0.2 的 3 个锚点共同构成 Agent Insight 的视觉气质 —— 锚点是"声音"，本节是"音色"。
>
> **核心原则**：科技感不来自装饰、不来自动效、不来自渐变。科技感来自 ①1px hairline + 圆角阶梯的几何精度 ②等宽字体在合适场景的出场 ③暗底分层的空间秩序 ④微动效只在"状态改变"时出现 ⑤状态色饱和度的克制。

### P.1 背景点阵网格（仅限 3 处）

```css
/* 抽象为 utility：bg-dot-grid */
background-image: radial-gradient(var(--border) 1px, transparent 1px);
background-size: 16px 16px;
background-position: center center;
opacity: 0.5;  /* light */
opacity: 0.7;  /* dark */
```

- ✅ 允许出现：①`<EmptyState>` 卡片背景 ②`/login` 整页背景 ③`<PageContainer variant="canvas">` 画布的空白区
- ❌ 禁止出现：Dashboard、列表页、详情页、表单页、Sidebar、TopBar

**为什么**：点阵网格是 Observability / 开发者工具的视觉共识（Vercel、Linear、Tailwind、Stripe Dashboard），但**过度使用就变成廉价模板感**。只在"用户视线短暂经过"的空白处出现，让产品在某些瞬间"科技感拉满"，又不会构成持续噪音。

### P.2 AppTopBar 的 backdrop-blur（唯一允许 blur 的地方）

```tsx
<header className="sticky top-0 z-20 h-12
  bg-background/80 backdrop-blur-md
  border-b border-border">
```

- ✅ 仅 AppTopBar 一处使用 `backdrop-blur-md`
- ❌ Sidebar、Dialog、Sheet、Popover、Card、Toast 一律**禁止 backdrop-blur**

**为什么**：blur 是当代"高端感"信号，但也是性能杀手且容易过度。**只在最顶层、永远可见、面积最小**的元素使用 1 处，足够让用户感受到"有 Z 轴空间"，又不破坏 §0.1 第 4 条"稳态优先"。

### P.3 Skeleton Shimmer（统一一种）

```css
/* 抽象为 utility：animate-shimmer */
@keyframes shimmer {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}

.skeleton-shimmer {
  background: var(--background-secondary);
  position: relative;
  overflow: hidden;
}
.skeleton-shimmer::after {
  content: '';
  position: absolute; inset: 0;
  background: linear-gradient(
    90deg,
    transparent 0%,
    color-mix(in oklab, var(--foreground) 4%, transparent) 50%,
    transparent 100%
  );
  animation: shimmer 1.5s linear infinite;
}
```

- ✅ 所有 `<Skeleton>` **必须**使用这一种 shimmer
- ❌ 禁止 `animate-pulse`（透明度变化的旧 shadcn 默认）—— 视觉上像"出 bug 闪烁"，与运行态呼吸（§0.2 锚点 ①）会争抢用户注意力

**为什么**：shimmer 是"数据加载中"的国际语言，统一节奏后整个产品的"等待感"会一致。

### P.4 Focus Glow（仅主操作按钮）

```css
/* 默认 Button focus（所有 variant） */
.button:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--ring);   /* Ring 25% Indigo */
}

/* default variant 额外内描边（仅主操作） */
.button-default:focus-visible {
  box-shadow:
    0 0 0 3px var(--ring),
    inset 0 0 0 1px var(--primary);    /* 1px 主色内描边 */
}
```

- ✅ 仅 `Button variant="default"`（主操作）享有内描边升级
- ❌ 其他 variant、Input、Select、Tab 一律使用基础 3px ring，不加 glow

**为什么**：主操作是用户行为的"决断点"，多 1px 内描边的精度让"我马上要点这个"在视觉上更确定。其余位置不需要，加了反而打破"灰阶秩序"。

### P.5 状态色 Subtle 的暗色自适应

```css
/* 旧：所有暗色 Subtle 都写死 rgba */
--running-subtle: rgba(96, 165, 250, .12);

/* v1.3 新：所有 Subtle 用 color-mix 自动协调 */
--running-subtle: color-mix(in oklab, var(--running) 12%, transparent);
--success-subtle: color-mix(in oklab, var(--success) 12%, transparent);
--warning-subtle: color-mix(in oklab, var(--warning) 12%, transparent);
--error-subtle:   color-mix(in oklab, var(--error)   12%, transparent);
```

- ✅ 所有 `--*-subtle` Token 在 v1.3 起统一用 `color-mix(in oklab, ..., transparent)` 派生
- ✅ 暗色模式下主色变亮、subtle 自动跟随变化，不需要手动维护两套 hex
- ❌ 禁止组件内手写 `bg-blue-500/10` `bg-red-500/15` 等 Tailwind opacity 字面值

**为什么**：`oklab` 色空间下 12% 混合视觉上是真正的 12%（sRGB 的 12% 看起来更暗）。这是 v1.3 "暗色作主表达"（§0.1 第 10 条）的具体落地——一处定义，两套主题自动协调。

### P.6 不允许的"伪科技感"（CR 红线汇总）

| 反例 | 为什么不允许 | 正确做法 |
| --- | --- | --- |
| Card Header 加渐变横线 | 违反 §0.2 锚点②（渐变描边仅 3 处） | 改为不加，或改为 1px hairline 主色 border-l-2 |
| 数字加渐变文字色 | 违反 §0.1 第 2 条（颜色 = 语义） | 用 MetricValue 等宽对位，颜色保持 foreground |
| Sidebar 加噪点 / 玻璃拟态 | 违反 P.2（blur 仅 AppTopBar） | 改为 `--sidebar-bg` 比 background 略深，靠分层 |
| 数据线发光（drop-shadow + glow） | 违反 §0.1 第 3 条（数据是主角不是装饰） | 数据线 1.5px stroke，配高对比配色 |
| Hover 按钮加 scale(1.02) | 违反 §0.1 第 11 条（hover 不做位移 / 缩放） | hover 只做背景变深 8% |
| Toast 加左侧渐变条 | Sonner 默认即可，无需"特化" | 用 Sonner 默认样式 |
| 状态徽章背景做渐变 | 违反 §B.4.3（状态只有 4 种形态） | Subtle Badge 用 `--state-subtle` 纯色 |

---

---

## 10. Token 字典（索引）

实际值参见 [`src/app/globals.css`](../../src/app/globals.css)，本节不复述 hex。

- **禁止**在组件 / 页面里写硬编码颜色：`#xxxxxx`、`rgb(...)`、`rgba(...)`，包括 inline style 和 className 里的 `bg-[#xxx]`、`text-[#xxx]`。
- **禁止**用 Tailwind 调色板字面色（`text-gray-500` `bg-blue-500`），必须用 Token 化的语义类 (`text-foreground-muted`、`bg-primary`)。
- **禁止**复制现有 CSS class 然后改一个数值——要么改 Token，要么走 utility 类。
- 唯一例外：完全离散的品牌 / 营销视觉（如登录页插画），需在 PR 描述里说明。

## 1. 颜色 Token

设计原则（已写入 globals.css 注释）：**95% 灰阶 + 1 个主色（Indigo）+ 3 个语义状态色**。

### 1.1 中性灰阶

| Token | Light | Dark | 用途 |
| --- | --- | --- | --- |
| `--background` | `#FFFFFF` | `#09090B` | 页面底色 |
| `--background-secondary` | `#F4F4F5` | `#27272A` | 卡片底色 / 区分块 |
| `--background-tertiary` | `#F4F4F5` | `#27272A` | 嵌套区块 |
| `--card-bg` | `#FFFFFF` | `#18181B` | 卡片表面 |
| `--card-border` | `#E4E4E7` | `#27272A` | 卡片边框 |
| `--foreground` | `#18181B` | `#FAFAFA` | 主要文字 |
| `--foreground-secondary` | `#52525B` | `#A1A1AA` | 次要文字（label、辅助信息） |
| `--foreground-muted` | `#71717A` | `#71717A` | 三级文字（占位符、注释） |
| `--border` | `#E4E4E7` | `#27272A` | 通用 1px 边框 |
| `--border-dark` | `#D4D4D8` | `#3F3F46` | 强调边框、分割线 |

### 1.2 主色 Indigo（仅用于"可交互"语义）

> **只有以下场景才能用主色**：主操作按钮、选中态、链接、Active Tab、Focus Ring。其余一律用灰阶。

| Token | Light | Dark |
| --- | --- | --- |
| `--primary` | `#4F46E5` | `#818CF8` |
| `--primary-hover` | `#4338CA` | `#A5B4FC` |
| `--primary-foreground` | `#FFFFFF` | `#FFFFFF` |
| `--primary-subtle` | `#EEF2FF` | `rgba(129,140,248,.15)` |
| `--primary-subtle-border` | `#C7D2FE` | `rgba(129,140,248,.3)` |

### 1.3 语义状态色（只用于"状态描述"，不能用作装饰）

| 语义 | Token | 用例 |
| --- | --- | --- |
| 成功 | `--success` / `--success-subtle` / `--success-subtle-border` | 通过、运行成功、健康 |
| 警告 | `--warning` / `--warning-subtle` / `--warning-subtle-border` | 待处理、告警、风险 |
| 错误 | `--error` / `--error-subtle` / `--error-subtle-border` | 失败、不可用、删除确认 |

> 评分 / 指标卡里"绿色 = 高分、红色 = 低分"算作语义化使用，允许；
> 但**单纯为了好看**用蓝/紫/橙做装饰是**不允许**的。

> **🚫 红线 · 警告色 / 错误色不可挪用为"类型色"**
>
> 与 `--warning` 视觉相近的 **Amber / Orange / Yellow** 系（`bg-amber-*`、`text-amber-*` 等），与 `--error` 视觉相近的 **Red** 系（`bg-red-*`、`text-red-*` 等），**只能用于状态语义**（警告 / 错误 / 慢 / 重试 / 删除确认）。
>
> 严禁把它们分配给某个"类型 / 类别"维度上色，例如：
> - ❌ Trace 中 LLM Span 用 Amber — 用户会读成"这步在告警"
> - ❌ 模型筛选 chip 把 GPT-4 标成 Red — 用户会读成"这个模型出错了"
> - ❌ 表格中"Skill 类型 = scheduling"用 Amber 背景 — 用户会读成"这个 Skill 慢"
>
> 类型 / 类别着色必须从 Chart Palette 的"非语义槽位"里挑（详见本文件 §2 后续 "图表配色（Chart Palette）" 小节）：Indigo / Sky / Emerald / Violet / Pink / Teal。
>
> **唯一例外**：序列本身就在描述警告 / 错误（如"错误率 over time"折线、"P99 慢请求"柱状），此时用 Amber / Red 是对的。

### 1.4 状态标签（Tag/Badge）色板

| Token | 用途 |
| --- | --- |
| `--tag-gray-bg/fg` | 中性标签（类型、版本号） |
| `--tag-green-bg/fg` | 成功 / 通过 |
| `--tag-amber-bg/fg` | 进行中 / 警告 |
| `--tag-red-bg/fg` | 失败 / 错误 |
| `--tag-purple-bg/fg` | 仅用于"AI / 模型 / 智能体"领域类标签 |

### 10.2 Z-index 层级

| 层 | z-index | 用途 |
| --- | --- | --- |
| Base | 0 | 内容 |
| Sticky Header | 20 | 顶栏 |
| Dropdown / Popover | 40 | 下拉 |
| Sticky Sidebar | 30 | 侧栏 |
| Dialog Overlay | 50 | 弹窗遮罩 |
| Dialog Content | 51 | 弹窗内容 |
| Toast | 60 | 全局通知 |
| DevTools | 70 | 开发辅助 |

由 Radix Primitive 包装的组件已自动处理，**禁止**手写 `z-[9999]`。

### 10.3 Tailwind ↔ CSS Variable 映射

`tailwind.config.ts` 必须把上面所有 Token 暴露成 utility 类。建议命名：

```
bg-background, bg-card, bg-muted, bg-primary, bg-success, bg-warning, bg-destructive
text-foreground, text-foreground-secondary, text-foreground-muted, text-primary
border-border, border-border-strong, ring-ring
```

后续 PR 不允许出现 `bg-white`、`bg-zinc-50`、`text-gray-500`、`border-gray-200` 等"非 Token 化"的色名。
