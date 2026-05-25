# AGENTS.md

本文件是 **agent-insight** 仓库给 AI 编码助手（Claude Code / Codex / Cursor 等）的协作约束。所有 agent 在本仓库改动前都应先读这里。人类协作者也可参考。

> 项目简介：Agent Skill 评估与观测平台 —— 量化评估 Skills 在 Agent 上的实际运行效果。
> 技术栈：Next.js (App Router) + Prisma + TypeScript + Tailwind。

---

## 1. 分支与 PR 流程

协作依赖**两个 remote**（按角色，不按名字）：

- **fork remote** —— 个人 fork，日常 push 目标。形如 `<your-username>/agent-insight`。
- **team remote** —— 团队合并管理仓 `gyctl/witty-skill-insight`，主合并分支 **`new_src`**。`master` 由 `new_src` 周期性合入。

> ⚠️ remote 名因人而异。常见配置是 `origin` = fork、`upstream` = team，但直接 clone 团队仓的人可能反过来。**第一次操作前跑 `git remote -v` 确认实际名称**，下文一律用"fork remote / team remote"指代角色。

**默认流程**：

1. 从 team remote 的 `new_src` 起新分支（或基于它 rebase）。
2. 推到 fork remote 的 `<feature-branch>`。
3. 提 PR（gitcode 称 MR），target = **team remote (`gyctl/witty-skill-insight`) 的 `new_src`**。

**禁止**：

- 直接推 team remote 的 `new_src` 或 `master`。
- 绕过 `new_src` 直接合 `master`。
- 未经用户授权执行 `push --force`、`reset --hard`、删分支等破坏性操作。

## 2. Commit 规范

使用 **Conventional Commits** 前缀：`feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `chore:` / `perf:` / `style:`。

- subject 可中文；保持一行简述 + 可选 body。
- 一次 commit 聚焦一件事；不要把无关改动捎带进同一个 commit。
- **除非用户明确要求**，不要用 `--amend` / `--no-verify`。pre-commit 失败就修问题、重新 stage、新建 commit。

## 3. Commit + Push（gitcode 提示）

仓库托管在 **gitcode**，不是 GitHub —— **不要用 `gh`**。

push 前先 `git remote -v` 确认 fork remote 的实际名（不要假设是 `origin`），然后 `git push -u <fork-remote> <branch>`。输出里会有 MR 创建链接，连同建议的 PR 标题/描述转发给用户。

⚠️ gitcode MR 页面默认 target 是个人 fork 的 master，**必须手动改成 team remote (`gyctl/witty-skill-insight`) 的 `new_src`** —— 回复里要提醒用户这一步。

## 4. 何时先聊一下再动手

两个层级：

- **必须写 Plan 文档**：涉及数据模型变更（Prisma schema）或新增 API 路由。落到 `docs/plans/YYYY-MM-DD-<topic>-design.md`，对齐后再动手。
- **先讲思路对齐**（不一定写文档）：实现路径有多种合理选择、跨多个模块、需要引入新抽象、或自己感到"这事不止改几行"—— 先简述方案 + 列 trade-off，等用户确认再写代码。用户也会主动说"这是大需求"作为信号。

小改动（bug fix、文案、单文件局部调整）直接动手，事后说明即可。

**大改动落地后，同步更新 [docs/PROJECT.md](docs/PROJECT.md)**（架构 / 模块边界 / 关键术语 / 数据模型变化）—— 这是最权威的内部文档，不要让它过期。

## 5. 改动验证

完工前两步都要做：

1. **跑测试**：`npm run test`（执行 `test/**/*.test.ts`）。
2. **跑 dev 并验证 UI**：`bash scripts/restart_dev.sh` 起 dev server，走一遍 golden path + 至少一个边界 case。
   - 如果 agent 自带浏览器自动化能力（Claude Code 的 `preview_*` MCP、Cursor browser MCP 等），优先自己跑完，附截图/快照/console 错误给用户。
   - 没有此能力时，明确告诉用户"未在浏览器中验证"，不要默认声称成功 —— 让用户决定是否自己点一下。

类型检查 / lint 验证的是代码正确性，不是功能正确性。

## 6. UI / 用户交互开发：先对齐 `docs/design`，再写代码

任何**修改前端页面、组件、交互、视觉**的改动，都必须**先**与 [`docs/design/`](docs/design/) 下的规范对齐——这是产品视觉与交互一致性的硬约束，违反直接打回。

**规范分布**：

- [`docs/design/README.md`](docs/design/README.md) —— 15 条设计原则 + 索引。
- [`docs/design/foundations.md`](docs/design/foundations.md) —— Token、颜色、暗黑模式、动效、可访问性。
- [`docs/design/components.md`](docs/design/components.md) —— 强制复用组件清单 + PR 自查表。
- [`docs/design/patterns.md`](docs/design/patterns.md) —— 6 类页面模板、长文本、表单、Wizard、键盘可达。
- [`docs/design/ROADMAP.md`](docs/design/ROADMAP.md) —— 当前代码与规范的差距 + 排期（落地即删条目）。
- [`src/app/globals.css`](src/app/globals.css) —— Token 的**唯一事实来源**（`:root` / `[data-theme='dark']` 双声明）。

**工作流**（**先看规范 → 不满足先改规范 → 再写代码**）：

1. **动手前先查**：在上述文件里搜对应组件 / 关键词（Cmd-F "Button"、"暗黑"、"长文本"…），按规范写代码。
2. **遇到矛盾或未覆盖**：**不要在代码里"先这样做"再补文档**。先和用户对齐方案，更新 `docs/design/` 对应文件（或在 `ROADMAP.md` 登记差距），再写代码。
3. **PR 前自查**：勾选 `docs/design/components.md` §6 + `.github/pull_request_template.md` 中的"双截图门"和"暗黑特殊核验"。
4. **Light + Dark 两张截图**：任何 UI 改动 PR 必须同时附亮色与暗色截图，仅截一种**直接打回**。

**红线（不要试探）**：

- ❌ 自己写 Button / 状态徽章 / EmptyState / ErrorState / MetricValue —— 一律走 `src/components/` 下的封装。
- ❌ 在组件里写 `#xxxxxx` / `rgba(...)` / `bg-[#...]` / `dark:` Tailwind 前缀 —— 走 token + `:root` / `[data-theme='dark']` 双模式 CSS variable。
- ❌ 自管 `mx-auto + max-w-*` 居中页面 —— 用 `<PageContainer>`，左对齐铺满。
- ❌ `window.alert` / `window.confirm` —— 用 `sonner` toast 或 `<ConfirmDialog>`。
- ❌ 在 Card Header 加渐变、Hover 加发光 / 缩放 —— 全产品只有 3 处允许"视觉个性"（详见 `foundations.md` §0.2）。

## 7. 项目内部约定

### Skill 用 `name` 而非 `id` 做对外 key

- 前端路由：`/skill-opt/[name]/[version]` 走 name。
- 新 API 路径用 `:name`（如 `/api/skills/:name/...`），不要用 `:id`。
- DB 里仍有 `id` 字段，只在内部使用。
- 代价：skill 重命名会断 URL —— 接受这个代价，rename 本来就该是大动作。

## 8. 仓库的非标准目录

标准 Next.js 结构（`src/app` / `src/components` / `src/lib` / `prisma/`）按常规理解即可。下列是项目特有的：

- `skills/` —— 内置 Skill 定义，每个 skill 一个子目录，含 `SKILL.md`。
- `docs/PROJECT.md` / `docs/Agent_Insight_Design_Document.md` —— 最权威的内部架构文档。
- `features/` —— 单 feature 的设计草稿（比 plan 更轻量）。
- `scripts/restart_dev.sh` —— 验证流程要用，不要换别的方式启 dev server。

## 9. 代码风格（仅列反默认项）

- **文件路径在沟通中** 用 markdown link 格式：`[name](relative/path:line)`，方便用户点击。
- **注释默认不写**。只在 WHY 不明显时加一行（隐藏约束、反直觉的 workaround）。不要写"做了什么"或"给 X 调用方用"这种会过期的注释。
- **不要主动创建文档文件**（`*.md` / README），除非用户明确要求。

## 10. 默认禁止 / 需要确认的操作

未经用户授权不要：

- 推送到任何远端、创建/合并 PR、关闭 issue。
- 修改 CI、`package.json` 的 scripts、`.env*`。
- 升级/降级依赖、删除依赖。
- 删除文件、目录、分支。
- 改 git config。

读取、跑测试、本地 dev、改 src 下的代码都可以自由进行。

---

如发现本文档与实际开发流程不一致，**改文档** 比"默默偏离"好。改完在 PR 描述里说明即可。
