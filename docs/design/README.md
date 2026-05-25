# Agent Insight 设计与交互规范

> 本目录是 Agent Insight（仓库名 `witty-skill-insight`）的统一 **UI/UX 与交互规范**。
> 所有新页面、新组件、对存量页面的重构都必须遵守这里的标准；如确需偏离，必须在 PR 描述里写明原因并经设计/产品评审。
>
> **当前版本**：v2.0.0（2026-05-20）· 从 v1.4 的 7 文件结构精简为 4 文件 + 1 个 ROADMAP。

## 1. 文档结构

| 文档 | 性质 | 谁要看 |
| --- | --- | --- |
| [`foundations.md`](./foundations.md) | **基础视觉规则**：Token、颜色、字体、暗黑模式、动效、可访问性 | 设计、前端、Reviewer |
| [`components.md`](./components.md) | **组件契约**：强制复用清单、组件 API、PR 自查表、迁移对照 | 前端、Reviewer |
| [`patterns.md`](./patterns.md) | **页面骨架与交互行为**：6 类页面模板、长文本、表单、Wizard | 设计、产品、前端、QA |
| [`ROADMAP.md`](./ROADMAP.md) | **临时**：从当前代码到规范的差距与排期；落地后即删除项 | 前端、TL |

**Token 实际值**唯一事实来源 = [`src/app/globals.css`](../../src/app/globals.css) 的 `:root` / `[data-theme='dark']` 双声明块。文档只描述规则与索引，不复述 hex。

## 2. 阅读顺序

1. **第一次进入项目**：依次扫一遍 `foundations.md` → `components.md` → `patterns.md`（约 30 分钟）。
2. **写新页面**：先看 `patterns.md` 的 6 类页面模板和 PageHeader 锚定结构。
3. **写新组件**：先看 `components.md` §1 注册表，确认不是已存在组件的二次实现。
4. **改颜色 / 暗黑相关**：必看 `foundations.md` §1 的 5 条强制约束。
5. **提交 PR 前**：勾选 `components.md` §6 PR Reviewer 自查表。

## 3. 设计原则速记（15 条 · 写代码前默念）

> 前 11 条是"地基"——克制、规范、可对齐；后 4 条是"骨架与气质"——识别度、组件强制、暗黑作主表达、动效叙事。两组合起来才是 Agent Insight 的样子。

1. **一个产品只能有一种"按钮"。** 同一种语义的操作（主操作、次操作、危险操作）在所有页面长得必须一致。
2. **Token > Tailwind 字面值 > 硬编码。** 颜色、间距、圆角、阴影一律用 CSS variable 或 Tailwind token。
3. **反馈是非阻塞的。** 错误、成功、警告用 Toast（Sonner），不要再写 `alert()` / `confirm()`。
4. **空、加载、错误三态必须显式实现。** 不允许"页面卡住没反应"或"白屏"。
5. **可恢复的列表状态写进 URL。** 筛选、分页、Tab 用 `nuqs` 持久化，刷新和分享链接都不丢状态。
6. **危险操作必须二次确认。** 删除、释放、批量操作走统一 `ConfirmDialog`。
7. **键盘可达。** 所有交互控件必须可 Tab 聚焦、可 Enter/Space 触发，焦点环可见。
8. **长文本先截断、再让用户主动展开。** 列表 / 卡片 / 表格里**不允许**直接铺出长文本（详见 `patterns.md` §2）。
9. **同类页面长一样。** 全站只有 6 类页面布局模板（详见 `patterns.md` §1），不允许自创第 7 种。
10. **多步骤流程统一化。** 复杂流程走 Wizard 模式，必须有步骤状态、草稿、可回退、错误模板（详见 `patterns.md` §15）。
11. **全站铺满左对齐，禁止居中。** 任何页面在 Sidebar 右侧主区都必须 `w-full` 铺满；表单页通过"字段 `max-w-xl` 限宽 + 右侧辅助卡片"实现可读性。
12. **识别度只投放在 3 处。** 全产品只有三个允许"有个性"的视觉锚点（详见 `foundations.md` §0.2）：①运行态呼吸脉冲 ②AI 卡片渐变描边 ③等宽数字单位对位。
13. **一致性靠组件，不靠文档。** "同一功能 = 同一个物理组件"，任何页面自己写第二版直接打回（详见 `components.md` §1）。
14. **暗黑模式是品牌主表达。** Observability 用户大量在夜间盯屏。所有视觉决策**先在 dark 下成立**，再回推 light；任何 PR 不允许只在亮色下截图就合入。
15. **微动效只服务一种叙事："状态在改变"。** 全产品只允许 3 处动效：运行态呼吸、Toast 滑入、Tab 下划线滑动。

## 4. 参考的开源最佳实践

本规范主要参考以下开源/业界标杆并做了本地化裁剪：

- **shadcn/ui** —— 组件 API、变体、Token 命名（已在项目使用，需要全量普及）
- **Radix UI Primitives** —— 无样式可访问性原语（Dialog、Tooltip、Popover、Select 等）
- **Tailwind CSS v4** —— 间距 / 字号 / 色阶 scale；`@theme` + `@custom-variant dark` 主题机制
- **Vercel Geist Design System** —— 中性灰阶 + 单一强调色的视觉语言
- **Linear Method** —— 列表 / 详情 / 命令面板（cmdk）的交互范式
- **Untitled UI / Refactoring UI** —— 信息密度、对齐、留白
- **Nielsen Norman Group 10 Heuristics** —— 通用可用性原则
- **WAI-ARIA Authoring Practices** —— 可访问性
- **Sonner** —— Toast 反馈（已装包）
- **nuqs** —— URL state（已装包）
- **TanStack Table** —— 列表 / 表格交互模型
- **Langfuse / Posthog 开源前端** —— 同领域（LLM 观测）的视觉与信息架构参考

## 5. 维护与变更

- 文档采用 SemVer 标注：当前 **v2.0.0 (2026-05-20)**。
- 修订原则：先改 `foundations` / `components` / `patterns`，同步在 `ROADMAP` 标记差距。
- 重大变更（如换主色、换字体、调整栅格）需在 PR 中 @产品 & 设计评审通过后才能合入。
- **PR 强制门**：所有 UI 改动 PR **必须同时附 Light + Dark 两张截图**（见 `foundations.md` §1.2 第 5 条）。
