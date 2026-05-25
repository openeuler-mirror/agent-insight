# Design ROADMAP — 当前代码到规范的差距与排期

> **本文件是临时性差距清单**：记录"当前代码"与 `foundations.md` / `components.md` / `patterns.md` 中规则之间的差距，以及修复计划。
> **一旦清单清零，本文件直接删除**——不要让它变成历史档案，那是 `git log` 的工作。
>
> 每条建议带：**Owner / Sprint / 状态**。状态变 `done` 后**立即从本文件移除**（不要留"已完成"区）。
>
> 当前版本：v1.0（2026-05-20）。合并自先前的两份 optimization 文档（已删除）。

---

## 0. 现状摘要（2026-05-20 复盘）

- ✅ **Token 双 SOT 已消除**：`globals.css` 是唯一颜色 SOT，文档不再复述 hex。
- ✅ **Shadow / Overlay Token 已补**：`--overlay-bg` / `--shadow-primary` / `--shadow-primary-lg` / `--shadow-error` 双模式声明已就绪。
- ✅ **`globals.css` 内 8 处硬编码 rgba 已清理**：全部走 token。
- 🟡 **组件内仍有 37 处 `dark:` 前缀** 散落在 9 个文件，违反 §1.2 第 3 条（详见 P0-D 项）。
- 🟡 **组件内仍有 5 处 `bg-[#xxx]` 字面色**（详见 P0-D 项）。
- 🟡 **三个识别锚点组件仅 StatusBadge 部分落地**，AiCard / MetricValue 尚未抽取。
- 🟡 **Legacy `.ai-btn-*` / `.btn-primary` / `.skill-card` 等 CSS 类**仍被部分页面引用，未走 `<Button>` / `<Card>` 封装。

---

## P0 · 紧迫期（2026-05-20 ~ 2026-06-03）

### P0-A · 三个识别锚点组件落地（DNA · 不落地等于产品没有 DNA）

- **Owner**：前端 TL · **Sprint**：1 · **状态**：todo
- 落地 `src/components/feedback/StatusBadge.tsx`（running 呼吸态）。
- 落地 `src/components/feedback/AiCard.tsx`（Indigo→Pink 渐变描边）。
- 落地 `src/components/text/MetricValue.tsx`（等宽数字 + 单位 + baseline）。
- 三个组件落地后，扫一遍所有用到"状态徽章 / KPI 数值 / AI 卡片"的页面，强制替换。

### P0-B · 收口按钮系统

- **Owner**：前端 · **Sprint**：1 · **状态**：todo
- 全站搜 `className=".*btn.*"` / `.ai-btn-*` / `<button class=`，逐一替换为 `<Button variant="default|secondary|outline|ghost|destructive|link">`。
- `button.tsx` 的 `brand` 变体降级为 `@deprecated`，新代码禁用；存量每个 Sprint 至少清 5 处。
- 验收：每屏只有 ≤ 1 个 `variant="default"` 主按钮。

### P0-C · 干掉 `alert()` / `confirm()`

- **Owner**：前端 · **Sprint**：1 · **状态**：todo
- 全站搜 `window.alert` / `window.confirm` / 自实现 Modal 提示，替换：
  - 反馈类 → `sonner` 的 `toast.success / toast.error / toast.info`。
  - 二次确认类 → `<ConfirmDialog variant="destructive">`。
- ESLint 规则：`no-restricted-globals: ["error", "alert", "confirm"]`。

### P0-D · 组件内残留的 `dark:` 与 `bg-[#xxx]` 清零

- **Owner**：前端 · **Sprint**：1 · **状态**：todo
- 当前 37 处 `dark:` 前缀（9 个文件） + 5 处 `bg-[#xxx]` 字面色。
- 命令：`grep -rn "dark:\|bg-\[#\|text-\[#" src/` 出清单。
- 每处违规：先确认是不是缺 token，缺就先加 token 到 `globals.css`，再删 `dark:`。
- 完成后加 ESLint 规则禁止再现。

### P0-E · 统一页面容器 · 全站左对齐铺满，禁止居中

- **Owner**：前端 · **Sprint**：1 · **状态**：todo
- 全站搜 `mx-auto` + `max-w-*` 居中页面，替换为 `<PageContainer>`。
- 表单页：表单字段用 `max-w-xl`，**但容器本身仍铺满**（左对齐，不居中）。
- 参考：`patterns.md` §1 模板 3（表单 / 设置 / 帮助引导）。

---

## P1 · 关键期（2026-06-03 ~ 2026-07-01）

### P1-A · 统一 Dialog / Confirm

- **Owner**：前端 · **Sprint**：2 · **状态**：todo
- 所有 Modal 走 `@radix-ui/react-dialog` + 项目封装。
- 新建 `<ConfirmDialog>`：默认含"输入名称确认"（destructive 场景）。
- 删除所有 `position: fixed` 自实现遮罩。

### P1-B · Loading / Empty / Error 三态组件强制

- **Owner**：前端 · **Sprint**：2 · **状态**：todo
- 建 `<EmptyState icon title description action>`。
- 建 `<ErrorState title description onRetry>`。
- 所有列表 / 详情 Tab / Dashboard 替换为这两个组件 + Skeleton。

### P1-C · 表单收口

- **Owner**：前端 · **Sprint**：2 · **状态**：todo
- 所有表单走 `react-hook-form` + `zod` + `<Form>` 包裹。
- 错误信息位置统一在字段下方 `text-destructive text-xs`。
- 离开拦截：`useBlocker` + `<ConfirmDialog>`。

### P1-D · URL 状态接入 nuqs

- **Owner**：前端 · **Sprint**：2 · **状态**：todo
- 所有列表的筛选 / 分页 / Tab / 视图切换 → `useQueryState`。
- 验收：刷新 / 分享链接、状态完整恢复。

---

## P2 · 体验提升期（2026-07-01 ~ 2026-08-05）

### P2-A · DataTable 统一封装

- **Owner**：前端 · **Sprint**：3-4 · **状态**：todo
- 基于 TanStack Table 封装 `<DataTable>`，参数：`columns / data / density / sortable / selectable / onRowClick`。
- 删除所有页面自管 `<table>` 实现。
- 行高跟随 density（Comfort 48 / Compact 36 / Dense 28）。

### P2-B · Card / Layout 规整

- **Owner**：前端 · **Sprint**：3 · **状态**：todo
- 删除 `.ai-card` / `.skill-card` / `.ai-stat` 等 legacy CSS 类。
- 所有 Card 走 `<Card><CardHeader/><CardContent/><CardFooter/></Card>`。

### P2-C · 图标统一

- **Owner**：前端 · **Sprint**：3 · **状态**：todo
- 全站搜 emoji 图标 + 内联 SVG，替换为 `lucide-react`。
- 尺寸只用 `size-3.5 / size-4 / size-5`。
- 删除其它图标库依赖（Heroicons / Tabler / 自写 SVG，业务插画除外）。

### P2-D · 命令面板 Cmd+K

- **Owner**：前端 · **Sprint**：4 · **状态**：proposed
- 基于 `cmdk` 加全局快捷命令面板（参考 Linear / Vercel）。

---

## P3 · 视觉打磨期（2026-08-05 ~ 2026-09-02）

### P3-A · 字体接入

- **Owner**：前端 · **Sprint**：5 · **状态**：todo
- 落地 Inter 字体（`next/font/google`），数值/代码用 `SF Mono` / `JetBrains Mono`。
- 确保所有 metric / count / duration 走 `tabular-nums + font-mono`。

### P3-B · 暗色模式回归测试

- **Owner**：QA + 前端 · **Sprint**：5 · **状态**：todo
- 全站每个页面手动过一遍 dark 模式，截图比对。
- 用 `@axe-core/playwright` 做对比度自动校验。
- 修复所有暗色下对比度 < 4.5:1 的元素。

### P3-C · 微交互节奏

- **Owner**：前端 · **Sprint**：5 · **状态**：todo
- 统一 transition：`120ms` 微交互 / `200ms` Hover / `300ms` 页面切换。
- 曲线 `cubic-bezier(0.16, 1, 0.3, 1)`（ease-out-expo）。
- 全站搜 spring / 大 scale / 旋转，删除。

---

## P4 · 长期治理（持续）

### P4-A · Storybook（可选但推荐）

- **Owner**：前端 TL · **状态**：proposed
- 引入 Storybook 8，所有 `src/components/ui/*` 至少一个 story。
- CR 时用 Storybook URL 验证组件。

### P4-B · 视觉回归测试

- **Owner**：QA · **状态**：proposed
- Chromatic 或 Loki，覆盖 5 大主页面 + 双主题。

### P4-C · Lint 规则增强

- **Owner**：前端 TL · **状态**：todo
- ESLint 规则：
  - `no-restricted-globals: alert, confirm`
  - 自定义规则：禁止 `dark:` Tailwind 前缀
  - 自定义规则：禁止 `bg-[#`、`text-[#`、`border-[#`、`shadow-[`
  - 自定义规则：禁止 `mx-auto` 与 `max-w-*` 同时出现在页面根容器

---

## 页面级交互改造（按模块）

> 每条 PR 落地后立即从本文件删除。

### 全局优化（先做这些，其余受益）

- [ ] 安装 + 启用 `nuqs`（所有列表筛选 / 分页 / Tab）
- [ ] 全局 `<Toaster>` 接入 `sonner`，位置右下
- [ ] 全局快捷键管理（`useHotkeys`）
- [ ] 全局路由 Loading（Next.js App Router 自带）

### Dashboard（`/dashboard`）

- [ ] 替换 Card 为 `<Card>` 封装
- [ ] KPI 数值走 `<MetricValue>`
- [ ] 图表线条暗黑下变亮 1 档

### Skills 模块（`/skills` / `/skill-detail/[id]` / `/skill-history` / `/skill-release` / `/skill-debug` / `/skill-opt`）

- [ ] 列表走 `<DataTable>`
- [ ] 状态徽章走 `<StatusBadge>`
- [ ] 详情页 Tab 走 `<Tabs underline>` + URL 持久化
- [ ] Skill 推理输出卡片用 `<AiCard>`

### Evaluation 模块（`/eval` / `/eval/run/[runId]` / `/eval/trajectory`）

- [ ] 评测列表统一 `<DataTable>`
- [ ] Trajectory 用 Compact 密度
- [ ] AI 自动评分卡片用 `<AiCard>`

### Dataset 模块（`/dataset` / `/dataset/[id]` / `/evaluation/[id]`）

- [ ] 列表走 `<DataTable>` + URL 状态
- [ ] 详情页 metadata 用 `<MetricValue>` + `<IdChip>`

### Trace / Metrics / Quality

- [ ] Trace Span 颜色按类型，状态用 `<StatusBadge>`
- [ ] 流式 Span 卡片用 `<AiCard>`
- [ ] Metrics 数值列右对齐 + `tabular-nums`

### Playground / Chat (`/playground`)

- [ ] 输入框走 `<Textarea>` 封装
- [ ] 消息气泡区分 user / assistant / tool 状态色 + 图标

### Settings 系列（`/modelconfig` / `/accessconfig` / `/optapi` / `/memory` / `/fault` / `/security`）

- [ ] 表单全部走 `react-hook-form + zod`
- [ ] 左对齐 + 字段 `max-w-xl`
- [ ] 删除所有自管 padding

### 登录 / 错误页（`/login` / `error.tsx` / `not-found.tsx`）

- [ ] 登录页左对齐，不居中
- [ ] 错误页用 `<ErrorState>` 三段式

---

## 度量（每月跟一次）

- `grep -rc "dark:" src/ | wc -l` —— 目标降到 0
- `grep -rc "bg-\[#\|text-\[#" src/ | wc -l` —— 目标降到 0
- `grep -rc "\.ai-btn-\|\.btn-primary\|\.skill-card" src/ | wc -l` —— 目标降到 0
- `grep -rc "window\.\(alert\|confirm\)" src/ | wc -l` —— 目标降到 0
- `grep -rc "mx-auto.*max-w-\|max-w-.*mx-auto" src/app/(main) | wc -l` —— 目标降到 0
