# Design System & Frontend Style

> 对 Agent-Insight 前端的逆向设计审计。配套阅读 [06-frontend.md](06-frontend.md)（它讲的是路由与组件接线）。本页讲的是**视觉语言**：设计令牌、排版、控件尺寸，以及一份带漂移检测的 UI/UX 审计。
> 令牌的单一真源：[`src/app/globals.css`](../../src/app/globals.css)（`:root` + `[data-theme='dark']`）。机器可读的导出：[design-tokens.json](design-tokens.json)（W3C Design Tokens 格式）。
> 方法：对 582 个含样式的文件做静态分析。下文每个值都可追溯到源码；置信度低的条目已标注。对比度依据 WCAG 2.1 计算。

## 1. Design language

一种 **"95% 灰阶 + 1 个强调色 + 3 个状态色"** 的信息密集型美学——代码内注释明确点出了它的渊源：*"Langfuse / Linear / Vercel 中性灰阶范式"*（[globals.css:89](../../src/app/globals.css)）。特征：

- **克制。** 近乎单色的 Zinc 灰阶承载结构；唯一的靛蓝强调色（`#4F46E5`）仅保留给交互状态（选中、链接、主按钮）——明确*不*用于装饰。
- **密度。** 字号阶梯有意设定为**比 Tailwind 默认值低一级**（`--text-base: 14px`，正文 `13px`），以营造数据看板/可观测性的观感（[globals.css:78](../../src/app/globals.css)）。
- **安静的表面。** 扁平的白色卡片、1px 发丝边框（`#E4E4E7`），以及极低不透明度的阴影（`rgba(0,0,0,0.04)`）。层级靠边框 + 几乎看不见的阴影来传达，而非厚重的投影。
- **数据用等宽。** 等宽字体（JetBrains Mono / `ui-monospace`）用于 ID、指标、tokens/cost/latency 徽章——这是 Langfuse 的标志性做法。

**技术栈**（来自 [package.json](../../package.json)、`scan_stack.py`）：

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router) + React 19 |
| CSS | Tailwind CSS 4（globals.css 中的 `@theme`，无 `tailwind.config`）+ 纯 CSS 文件 |
| Primitives | Radix UI（`@radix-ui/react-*`）+ shadcn/ui 模式（[`ui/*`](../../src/components/ui) 中的 `cva` + `clsx` + `tailwind-merge`） |
| Icons | `lucide-react` |
| Motion | `framer-motion` |
| Charts | `recharts`；图/流程图：`@xyflow/react` + `@dagrejs/dagre` |
| Theming | 在 `<html data-theme>` 上的 `next-themes` 风格属性切换（[theme-context.tsx](../../src/lib/client/theme-context.tsx)） |

> 注意：`scan_stack` 报告 `shadcn_signal: false`（无 `components.json`），但 `ui/*` 组件明显源自 shadcn（cva 变体、`data-slot`、Radix `Slot`）。可视为"没有 CLI 的 shadcn"。

## 2. Color system

三层模型（原始 → 语义）。亮色主题为权威；暗色主题在 `[data-theme='dark']` 下覆写同名语义令牌。

**语义角色**（亮色）：

| Role | Token | Value | Contrast on bg |
|---|---|---|---|
| 页面背景 | `--background` | `#ffffff` | — |
| 细微填充 | `--background-secondary` | `#F4F4F5` | — |
| 主文本 | `--foreground` | `#18181B` | **17.7:1**（AAA） |
| 次文本 | `--foreground-secondary` | `#52525B` | **7.7:1**（AAA） |
| 弱化文本 | `--foreground-muted` | `#71717A` | **4.83:1**（AA 正常 ✓，AAA ✗） |
| 边框 | `--border` / `--card-border` | `#E4E4E7` | — |
| **强调色（主色）** | `--primary` | `#4F46E5` | 白字配主色 **6.29:1**（AA ✓） |
| Success | `--success` | `#16A34A` | 作为白底文本 3.3:1——文本请使用 `*-text` 标签色 |
| Warning | `--warning` | `#D97706` | 3.19:1——仅用于填充/图标，不用于正文 |
| Error | `--error` | `#DC2626` | — |

状态表面遵循一致的 `{subtle-bg, subtle-border, text}` 三元组（例如琥珀色标签 `#92400E` 配 `#FFFBEB` = **6.84:1** ✓；红色标签 **5.91:1** ✓；绿色标签 **4.79:1** ✓）。暗色主题将强调色提亮为 `#818CF8`，并把状态色切换为 `400` 级色相，配以半透明填充。

## 3. Typography

- **字族**：sans = `Inter`（通过 `--font-inter`）配系统兜底；mono = `ui-monospace, SFMono-Regular, ...`。`font-feature-settings: 'cv02','cv03','cv04','cv11'` 启用 Inter 的风格替代字形。
- **阶梯**（规范值，来自 `@theme`）：`xs 11/16`、`sm 12/18`、`base 14/20`；body 元素为 `13px / 1.5`。标题：`h1` 1.5rem/600，区块标题约 0.9375rem/600。
- **字重**：500（medium）是主力（267 处使用），600（semibold，298）用于标题/强调，700（155）。400 相对少见——UI 偏向中等偏重的字重，这是密集型看板的典型特征。
- **字距**：全局 `-0.01em`（紧）；大写引导标签和表头使用 `+0.04em`。
- **行高**：正文 1.5；散文段落 1.55–1.65；紧凑 UI 行约 1.2–1.4。都在合理区间内。

## 4. Spacing, radius, elevation

- **间距**：4px 基准网格。最常用的步长为 8 / 10 / 6 / 12 / 4 / 14px。`10px` 和 `14px`（相对于纯 8px 阶梯属于偏离网格）经常出现——这是有意的密度选择，但也是轻微的网格一致性偏差。
- **圆角**：规范值 `sm 6px / md 8px / lg 10px`（`--radius-*`）。shadcn 组件使用 `rounded-md`。
- **阴影**：三个规范层级（`--shadow-sm/md/lg`），外加用于卡片的靛蓝色调悬停阴影。整体设计上非常克制。
- **布局**：内容最大宽度 `1600px`（`.dashboard-container`）；侧栏 + 顶栏外壳通过 `shell/AppSidebar` + `AppTopBar` 实现（见 [06-frontend.md](06-frontend.md)）。

## 5. Components & control sizing

可复用的原始组件位于 [`src/components/ui/*`](../../src/components/ui)（button、input、badge、card、dialog、select、switch、tooltip、popover、dropdown-menu、…）。实测的控件尺寸：

| Control | Size | Source |
|---|---|---|
| Button（default） | 高 **36px**（`h-9`）、`px-4`、`text-sm`、`font-medium`、`rounded-md` | [button.tsx:25](../../src/components/ui/button.tsx) |
| Button sm / lg | 32px / 40px | [button.tsx:26](../../src/components/ui/button.tsx) |
| Button variants | default · destructive · outline · secondary · ghost · link · **brand**（`#2F6868`） | button.tsx |
| Input | 高 **36px**（`h-9`）、`px-3`、`rounded-md` | [input.tsx:11](../../src/components/ui/input.tsx) |
| Badge | `rounded-full`、`px-2.5 py-0.5`、`text-xs`、`font-semibold` | [badge.tsx:7](../../src/components/ui/badge.tsx) |
| 默认图标 | 16px（`size-4`） | button.tsx |
| 焦点环 | `ring-[3px]`（shadcn）/ `0 0 0 2px var(--ring)`（自定义 CSS） | mixed |

原始组件上的状态覆盖良好——`hover`、`focus-visible`、`disabled`、`aria-invalid` 都在 cva 变体中得到处理。

## 6. UI/UX audit

| Principle | Verdict | Evidence |
|---|---|---|
| 视觉层级 | ✅ 良好 | 清晰的文本分层体系（primary/secondary/muted）、medium/semibold 字重阶梯 |
| 色彩对比度（WCAG AA） | ✅ 大体达标 | 文本分层 4.8–17.7:1；**注意**：`success`/`warning` 作为白底*文本*时低于 4.5:1——作为填充/图标没问题，标签请用 `*-text` 变体 |
| 触控目标 | ⚠️ 提示 | 36px 控件满足 WCAG 2.1 AA（24px），但未达 iOS 44pt / Material 48dp。对桌面优先的看板可接受；若增加移动/平板界面应重新审视 |
| 焦点可见性 | ✅ 良好 | 按钮、输入框、卡片、自定义 `.ai-*` 控件上都有 `focus-visible` 焦点环 |
| 暗色模式 | ✅ 完整 | 对每个语义令牌都有完整的 `[data-theme='dark']` 覆写 |
| 间距系统 | ⚠️ 轻微漂移 | 4px 网格，但频繁出现偏离网格的 10/14px，以及一长串一次性的零散值 |
| 一致性 / 漂移 | ❌ 需关注 | 见 §7 |

## 7. Design drift (the main risk)

原始信号扫描标记出在规范的 globals.css 令牌集**之外**存在大量漂移：

| Metric | Count | Healthy? |
|---|---|---|
| 不同颜色数 | **739** | ❌（目标：约 30–40 个的令牌化调色板） |
| 不同字号数 | **59** | ❌（目标 ≤ 约 12） |
| 不同圆角数 | 47 | ❌ |
| 不同阴影数 | 110 | ❌ |

根因：在治理良好的 `globals.css` 体系之外，**许多页面在本地 CSS 文件里另起了一套并行的、硬编码的令牌命名空间**——例如 `--sk-*`（[skill-opt.css](../../src/app/(main)/skill-opt/skill-opt.css)）、`--ev-*`（eval）、`--sa-*`（[skill-analysis.css](../../src/app/(main)/skill-eval/skill-analysis.css)）、`--gh-*`、`--stage-*`，外加单字母别名（`--c/--cs/--cl`）。其中数个在新名字下重新定义了*相同*的靛蓝/zinc 值，还有一些引入了调色板外的色相（例如 `#2F6868` 品牌按钮、青绿/紫色的阶段色、`Songti SC`、`Instrument Serif` 这类衬线展示字体）。

**解读：** *预期*的设计系统（globals.css + `.ai-*` 工具类）是连贯且文档完善的。漂移集中在那些自己长出了一套微型系统、而非消费共享令牌的功能页面上。这是收益最高的清理目标。

**建议**
1. 将 [`src/app/globals.css`](../../src/app/globals.css) 的 `:root` + [design-tokens.json](design-tokens.json) 视为单一真源。
2. 新的功能 CSS 必须引用共享的 `--color-*` / `--foreground-*` / `--radius-*` 令牌——**不要**定义新的 `--<feature>-*` 调色板。
3. 把现有的 `--sk-*` / `--ev-*` / `--sa-*` / `--gh-*` 别名映射回规范令牌，然后删除重复项（许多已经是规范令牌的 `var()` 别名——那些是轻松可得的成果）。
4. 优先使用 `ui/*` 原始组件和 `.ai-*` 工具类，而不是每个页面各自重做按钮/卡片。

> 想要运行时精确的值（级联/CSS-in-JS 后的计算样式）？对运行中的开发服务器跑提取器的 Mode B（Playwright）——本次审计仅为静态分析（Mode A）。
