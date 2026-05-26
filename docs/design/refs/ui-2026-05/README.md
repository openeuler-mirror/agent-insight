# UI 整理 · 2026-05 参考资料

> 这是一批**外部产出的设计参考文件**，2026-05 期间为 Agent Insight 的术语提示、Header 重设计、统一导航与品牌识别准备的素材。
>
> ⚠️ **现状**：文件已就位但**尚未落地到代码**。落地方式请看 [`docs/design/brand.md`](../../brand.md) 与各文件自带的方案说明。

## 文件清单

| 文件 | 类型 | 摘要 |
| --- | --- | --- |
| [`agent-insight-glossary.md`](./agent-insight-glossary.md) | 文档 | 全平台**名词解释手册**，按页面（概览 / Agent 管理 / 运行观测 / 评测中心 / Skills / 配置）组织，~100 条术语，是 Tooltip / Popover / 抽屉的内容源。 |
| [`glossary-styles.html`](./glossary-styles.html) | 可交互原型 | **5 种术语提示样式候选**（虚线 Tooltip / 圆形角标 Popover / 内联折叠 / 侧边抽屉 / 边注），含组合推荐。 |
| [`header-redesign.html`](./header-redesign.html) | 可交互原型 | 评测任务 Header **A/B 重设计方案**，对比当前实现，含每个方案的设计决策注释。 |
| [`agent-insight-prototype-统一导航栏和skill选项.html`](./agent-insight-prototype-统一导航栏和skill选项.html) | 可交互原型 | 全站**统一导航 + Skill 选择器**原型，含 Sidebar 品牌区、Topbar、面包屑、Skill 切换。是品牌色与 32px 圆角 Logo 的视觉来源。 |
| [`industry-analysis.md`](./industry-analysis.md) | 调研 | **Langfuse / LangSmith** 在"评测任务（Experiment / Dataset Run）"上的设计对比，含最小数据模型建议。 |
| `screenshots/` | 截图 | 上游设计期的 19 张界面截图（评测 AB / 用例 / 触发 / 触发合规 + 时间序列 ScreenShot 系列）。 |

## 直接打开预览

所有 `.html` 文件都是**独立可交互**的（外链 Google Fonts / Tabler Icons CDN），双击即可在浏览器里看到实际效果。`agent-insight-prototype-...html` 内含 `JetBrains Mono` + `Noto Serif SC` + `Inter` 三套字体，需要联网。

## 这批文件**不**进 src/

- 这些是**设计交付物的快照**，本质是讨论用的产物，不是组件库。
- 真正写代码时按 [`docs/design/brand.md`](../../brand.md)、[`components.md`](../../components.md)、[`patterns.md`](../../patterns.md) 来——把这些 HTML 当 reference，不要复制 CSS 进 `src/components/`。
- 颜色 token 一律以 [`src/app/globals.css`](../../../../src/app/globals.css) 为准；参考文件里的 hex 仅作来源说明。
