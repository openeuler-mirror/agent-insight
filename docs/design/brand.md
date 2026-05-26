# Brand & 应用指南 — Logo / 品牌色 / 参考素材落地

> **本文是 v2.0.0 设计规范的补充章节**（与 `foundations.md` / `components.md` / `patterns.md` 平级）。
>
> **解决什么**：①给项目一个明确的"品牌识别"——Logo、Wordmark、品牌色、字体；②说明 2026-05 这批外部 UI 整理参考资料（术语手册、Tooltip 样式、Header 重设计、统一导航原型、业界调研）**怎么用**。
>
> **目前状态（2026-05-26）**：Logo 资源已放入 [`public/brand/`](../../public/brand/)、参考资料已放入 [`docs/design/refs/ui-2026-05/`](./refs/ui-2026-05/)，**应用尚未开始**。下面给出落地路径与排期建议。
>
> **原则与红线**：本文的所有规则必须与 [`foundations.md`](./foundations.md) 兼容——尤其 §0.2 "三个识别锚点"、§B.3 "主色 Indigo 白名单"、§9 "克制的科技感"。如有冲突，**以 foundations.md 为准**。

---

## 0. 一句话品牌定位

> **Agent Insight ——「让 Agent 的运行过程可被凝视」。**

- 品牌名：**Agent Insight**（中文不译；正文中可写"Agent Insight 平台"）。
- 副标 / Powered-by：**by Skill-insight**（与 sidebar 当前文案保持一致，详见 [`AppSidebar.tsx:230`](../../src/components/shell/AppSidebar.tsx)）。
- 视觉气质：冷静、高密度、强信号、可凝视（与 `foundations.md` §0 一致）。

---

## 1. Logo 资源

### 1.1 资产清单

文件位于 [`public/brand/`](../../public/brand/)：

| 文件 | viewBox | 用途 |
| --- | --- | --- |
| `logo-mark.svg` | 32×32 | **主 Logo 标记**。带 135° 渐变的圆角方块 + 白色 `Ai` 字母。 |
| `logo-mark-mono.svg` | 32×32 | **单色版**。`fill="currentColor"`，由调用方决定颜色——用于深色按钮内、报表单色场景。 |
| `logo-wordmark.svg` | 200×32 | **横版 Logo + Wordmark**。给 Login 页、Marketing、Footer、PDF 报表头。 |
| `favicon.svg` | 32×32 | **小尺寸优化版**。字母略大、圆角略大，为 16/24/32px favicon 而设计。 |

### 1.2 颜色定义（与 foundations.md 对齐）

主 Logo 的渐变在 SVG 内部定义：

```
#6366F1  →  #3730A3     /* Indigo-500  →  Indigo-800 · 135° */
```

设计决策：

- **不直接用 `--primary` 渐变到 `--primary-hover`**——`#4F46E5 → #4338CA` 色差太小，渲染到 32px 内几乎看不出渐变。
- **不抄参考原型里的 `#6c5ce7 → #4a3cb8`**——这是来源原型的随手值；统一在 Tailwind Indigo 色阶上（项目已用 Indigo），便于未来与 chart palette / `--primary` 协调。
- **暗黑下不另做版本**：渐变 `#6366F1 → #3730A3` 在 light/dark 两套表面（`#FFFFFF` / `#18181B`）上对比度均 ≥ 7:1。
- **`logo-mark-mono.svg` 用 `currentColor`**——遇到不能放渐变的位置（譬如全黑导出、印刷品），让调用方传 `color`。

### 1.3 尺寸 & 留白

| 场景 | 尺寸 | 最小 clear-space |
| --- | --- | --- |
| Sidebar 顶部品牌区 | 26–28px | `marginRight: 9px` 至 wordmark 文字 |
| Login / Splash | 48–64px | 周围至少留 logo 高度 50% 的空白 |
| Topbar / Modal 头部 | 20–24px | `marginRight: 8px` |
| Favicon | 16 / 32 / 48px | n/a（已在 SVG 内置 padding） |

最小可用尺寸：**16px**（favicon）。低于 16px 不要再缩——会看不清字母 `Ai`，改用纯色方块或省略 Logo。

### 1.4 Do / Don't

- ✅ 优先用 `logo-mark.svg`（渐变版），让品牌色出现一次。
- ✅ 单色场景用 `logo-mark-mono.svg`，颜色由父元素 `color` 决定。
- ✅ Logo 与 wordmark 同框时用 `logo-wordmark.svg`，不要拼两个 SVG。
- ❌ 不要拉伸或裁切 viewBox。
- ❌ 不要在 Logo 上叠加图标、文字、徽章。
- ❌ 不要换字体（字母 `Ai` 是 Inter 700）或改字间距。
- ❌ 不要把渐变改成其他色相——主色就是 Indigo，参考 `foundations.md` §B.3。

### 1.5 关于现有 `AppSidebar` 的差异

[`src/components/shell/AppSidebar.tsx:217-228`](../../src/components/shell/AppSidebar.tsx) 当前用的是 **26×26 纯 `--primary` 底色 + 4 笔白色 SVG 线条**（"星芒"形态），不是 Logo 资产里的 `Ai` 字母。

**保留还是替换？** 这是落地阶段的产品决策，本文不强行规定。两种走法都合规：

1. **替换为 `logo-mark.svg`**：与 `public/brand/` 资产一致，渐变作为品牌一致性的小型投放。注意——`foundations.md` §0.2 把"渐变"列在 AI 卡片描边一处；Logo 是品牌识别，**不算违反**（品牌识别本身是允许的视觉个性来源）。
2. **保留星芒线条**：把它从 inline SVG 重构为 `public/brand/logo-mark-line.svg`，与 `logo-mark.svg` 并列作为 "另一种"标识——但同一时间产品上**只能选一个**主标。

推荐 1，理由：参考原型与设计共识一致都是 `Ai` 字母 + 渐变；现有星芒是开发期占位。

---

## 2. 品牌色与 Token 映射

**唯一事实来源仍是 [`globals.css`](../../src/app/globals.css)**——本节不引入任何新 token。

| 用途 | 应该用 | 不应该用 |
| --- | --- | --- |
| Logo 渐变 stops | SVG 内部硬编码 `#6366F1 / #3730A3`（已固化在 4 个 SVG 文件） | 在 CSS 里硬编码同样的 hex；不要把 Logo 的渐变拆出来当任何 UI 元素的背景 |
| Logo 占位（旧版） | `var(--primary)` | `bg-indigo-500` / `bg-[#4F46E5]` |
| 用到品牌"紫"的任何 UI 处 | `var(--primary)` / `var(--primary-subtle)` | 重新定义 `--brand-*` 系列 token |

**为什么不再加 `--brand-*` token：** 项目已有 `--primary` 作主色 Token；新加 `--brand-500 / --brand-700` 等会与 `--primary / --primary-hover` 冲突，并违反 `foundations.md` §B.3"主色 Indigo 是产品唯一非灰非状态色"。Logo 的渐变是**视觉个性**而不是**Token 体系**，**只在 4 个 SVG 文件里出现**，不进 CSS 变量。

---

## 3. 参考素材落地路线

[`docs/design/refs/ui-2026-05/`](./refs/ui-2026-05/) 下有 5 个参考文件 + 19 张截图。下面给每一份**该怎么用**。

### 3.1 名词解释手册 → 提示内容源

文件：[`agent-insight-glossary.md`](./refs/ui-2026-05/agent-insight-glossary.md)

- 这是 **Tooltip / Popover / 抽屉内容的事实源**——~100 条术语按 12 个页面分章。
- **应用方式**：迁移到 i18n key 树。建议路径 `src/locales/zh/glossary.ts`（与现有 `src/locales/zh.ts` 并列），按章节名建二级 key：

  ```ts
  // src/locales/zh/glossary.ts
  export const glossary = {
    overview: {
      'p95-latency': '所有请求按耗时排序后第 95 百分位的耗时，反映长尾体验。',
      'agent-status': '运行中 / 异常 / 空闲 三态，由心跳与最近一次执行结果共同判定。',
      // ...
    },
    observability: {
      trace: '一次完整任务执行从入口到结束的全部调用记录，由若干 Span 组成。',
      // ...
    },
  };
  ```

- **英文版**：暂时只有中文。落地时按 `foundations.md` §7 国际化要求出英文 key（评测页对外用户主要中文，可后置）。
- **谁负责更新**：每次引入新术语或改名（如改"主 Agent"叫法），必须**同步改 glossary md**和 i18n key——以代码层为准，md 文件作为可读副本。

### 3.2 五种术语提示样式 → 选定 + 命名 + 落组件

文件：[`glossary-styles.html`](./refs/ui-2026-05/glossary-styles.html)

5 个候选 + 设计稿自带的"组合推荐"已经给了答案。**落地配方**：

| 样式 | 用在哪里（产品决策） | 落到哪个组件（推荐文件） |
| --- | --- | --- |
| ① 虚线 Tooltip | 表头、卡片标题、列表内的字段（每屏 ≥ 6 处） | `src/components/text/TermTooltip.tsx`，包装 Radix Tooltip + 虚线 underline 样式 |
| ② 圆形角标 + Popover | 概览页 / 智能诊断的指标数字旁、关键标签旁 | `src/components/text/TermPopover.tsx`，包装 Radix Popover + 左侧主色色条 |
| ③ 内联折叠 | **暂不实现**——除非未来做新手引导/教学页 | — |
| ④ 侧边抽屉 | 10–20 个核心概念（Skill / Trace / A/B 测试 / Evaluator / 链路状态…） | `src/components/text/TermDrawer.tsx`，包装 Radix Dialog 右侧抽屉变体 |
| ⑤ 边注 | **暂不实现**——产品里没有"长文档"页 | — |

**与 foundations.md 的兼容性确认**：

- 5 种样式里 ②的"左侧色条 popover"用了 `--primary` border-left——这就是 §0.2 锚点①的 hairline 用法，**合规**。
- ④抽屉里的 chip-related tag 是 `--primary-subtle` 底色——属于"链接 / Subtle Tag"范畴，**合规**。
- 不要把 ⑤ 边注用紫色当装饰——参考稿里用的是 `var(--green)`，落地时改成 `--foreground-muted` 灰色批注，避免引入第二个语义色。

### 3.3 Header 重设计 → 评测任务页骨架

文件：[`header-redesign.html`](./refs/ui-2026-05/header-redesign.html)

- 对应页面：`src/app/(main)/skill-eval/...`（评测任务详情）。当前实现的问题在文件末尾的"当前实现的问题"已经列出（信息层级混乱、主体被次要化、动作缺乏分组、"评测任务"前缀冗余）。
- **推荐方案 A**（紧凑单行）。理由：Header 总高 110px，与项目其他页面 PageHeader 高度一致；动作降级为 icon button 符合 `components.md` 里"每屏只有 1 个主操作"原则。
- **不推荐方案 B**（双层分离）虽然 skill 切换器更显眼，但与 `patterns.md` 的 PageHeader 模板冲突——会在评测页**独有**双层 header，破坏"同类页面长一样"（设计原则 §9）。
- **如果将来真的需要常驻 Skill 切换器**：把它放到 `AppTopBar`，不要放到页面级 header（与 PageHeader 模板的兼容方式）。

### 3.4 统一导航 + Skill 选项原型 → 视觉对齐参考

文件：[`agent-insight-prototype-统一导航栏和skill选项.html`](./refs/ui-2026-05/agent-insight-prototype-统一导航栏和skill选项.html)

- 这份原型是 **Logo 渐变**与 **Skill 切换 chip 形态**的视觉来源。
- **不要照抄它的 CSS 进 src/**——它用了独立 token 命名（`--brand-500` / `--text-1` / `--sp-4` 等），与项目 `globals.css` 体系不兼容。当作"美术参考"看，不当"组件库"用。
- **可以照抄的细节**：
  - Sidebar 顶部 brand 区的布局（28px mark + 14px 名 + 11px tagline），已在 `AppSidebar.tsx` 实现。
  - nav-item 7px×12px padding + 6px border-radius + 主色 subtle active 态——已与 `globals.css` 等价。
- **不要照抄的细节**：
  - 自定义的 `--shadow-sm/--shadow-md`——项目用 `--shadow-xs/sm/lg` 三档。
  - 自定义间距 `--sp-1..10`——项目用 Tailwind 8px 网格。

### 3.5 业界调研 → 数据模型对齐

文件：[`industry-analysis.md`](./refs/ui-2026-05/industry-analysis.md)

- 内容：Langfuse / LangSmith 在"评测任务（Experiment / Dataset Run）"上的对照。
- **落地影响**：评测中心的 schema 命名应当对齐两家共识——`Dataset / DatasetItem / Experiment(Run) / RunItem / Score`。当前 `src/lib/evaluation-task-manager.ts` 与 prisma schema 已部分对齐；新功能（譬如 `num_repetitions` 重复轮次）按这份文档落即可。
- **不是 UI 文档**——它的作用是给产品 / 后端在 PRD 阶段引用，不进 UI 规范。

### 3.6 截图集合 → 设计评审证据

目录：[`refs/ui-2026-05/screenshots/`](./refs/ui-2026-05/screenshots/)（19 张 PNG）

- 评测 AB / 用例 / 触发 / 触发合规 4 张是各维度页面的设计稿目标态；ScreenShot_ 系列是过程截图。
- **用途**：PR 评审时贴对比图；不作为最终视觉规范——规范见 `foundations.md` + 这批 SVG/HTML。

---

## 4. 应用排期（建议 · 非强制）

| 阶段 | 内容 | 工作量估算 | 依赖 |
| --- | --- | --- | --- |
| **P0 · 立即** | 把 `AppSidebar` 顶部占位星芒换成 `logo-mark.svg`；在 `src/app/layout.tsx` 引用 `favicon.svg` | 0.5 天 | 无 |
| **P0 · 立即** | 把 [`docs/design/README.md`](./README.md) 的文档表更新（已在本 PR 完成）  | — | 无 |
| **P1 · 一周内** | 落地术语提示样式 ① `TermTooltip` + ② `TermPopover`；先覆盖"概览页"指标 | 1.5 天 | 3.1 i18n key 树先迁完 |
| **P1 · 一周内** | 评测任务 Header 按方案 A 重做 | 1 天 | 与产品确认 skill 切换器位置 |
| **P2 · 两周内** | 落地术语样式 ④ `TermDrawer`，覆盖 10–20 个核心概念 | 2 天 | TermPopover 通过 review |
| **P3 · 视需要** | 生成 `favicon.ico`（多尺寸 PNG 合成） | 0.5 天 | logo 终稿无改动 |

P0 后**才**修改 [`docs/design/foundations.md`](./foundations.md) 把 Logo 相关规则正式合入 §0；在此之前本文档作为"过渡章节"存在。

---

## 5. PR 自查表（应用阶段使用）

落地任意一项时，PR 描述里勾选：

- [ ] Logo 改动同时附 **Light + Dark 两张截图**（与 `foundations.md` §1.2 第 5 条对齐）。
- [ ] 没有把 `#6366F1` / `#3730A3` 复制到 `globals.css`——这两个色只允许出现在 `public/brand/*.svg`。
- [ ] 没有引入新的 `--brand-*` token。
- [ ] 引用 SVG 用 `next/image` 或 `<Image>` + `priority`，**不要**直接 inline base64。
- [ ] 替换占位 Logo 时，旧的 inline `<svg>` 代码已**删除**（不是注释掉）。
- [ ] 引入术语提示组件时，文案来自 i18n key 而**不是**硬编码字符串。
