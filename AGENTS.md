# AGENTS.md

本文件是 **agent-insight** 仓库给 AI 编码助手（Claude Code / Codex / Cursor 等）的协作约束。所有 agent 在本仓库改动前都应先读这里。人类协作者也可参考。

> 项目简介：Agent Skill 评估与观测平台 —— 量化评估 Skills 在 Agent 上的实际运行效果。
> 技术栈：Next.js (App Router) + Prisma + TypeScript + Tailwind。
> 本地默认数据目录：`~/.agent-insight/data`；默认 SQLite 数据库：`~/.agent-insight/data/witty_insight.db`。WSL 场景下对应 `\\wsl.localhost\<发行版>\home\<user>\.agent-insight\data`。

***

## 1. 分支与 PR 流程

协作依赖**两个 remote**（按角色，不按名字）：

- **fork remote** —— 个人 fork，日常 push 目标。形如 `<your-username>/agent-insight`。
- **team remote** —— 团队合并管理仓 `gyctl/witty-skill-insight`，主合并分支 **`new_src`**。`master` 由 `new_src` 周期性合入。

> ⚠️ remote 名因人而异。常见配置是 `origin` = fork、`upstream` = team，但直接 clone 团队仓的人可能反过来。**第一次操作前跑** **`git remote -v`** **确认实际名称**，下文一律用"fork remote / team remote"指代角色。必须和用户确定好是否需要拉远端代码仓，以及确认代码仓名称后再执行自动拉代码、自动提pr的操作。

**默认流程**：

1. 从 team remote 的 `new_src` 起新分支（或基于它 rebase）。
2. 推到 fork remote 的 `<feature-branch>`。
3. 提 PR（gitcode 称 MR），target = **team remote (`gyctl/witty-skill-insight`) 的** **`new_src`**。

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

仓库托管在 **gitcode**，不是 GitHub —— **不要用** **`gh`**。

push 前先 `git remote -v` 确认 fork remote 的实际名（不要假设是 `origin`），然后 `git push -u <fork-remote> <branch>`。输出里会有 MR 创建链接，连同建议的 PR 标题/描述转发给用户。

⚠️ gitcode MR 页面默认 target 是个人 fork 的 master，**必须手动改成 team remote (`gyctl/witty-skill-insight`) 的** **`new_src`** —— 回复里要提醒用户这一步。

## 4. 何时先聊一下再动手

两个层级：

- **必须写设计文档**：涉及数据模型变更（Prisma schema）或新增 API 路由。落到 [`docs/design/<topic>/`](docs/design/)（按 `phase1 需求分析 / phase2 需求设计 / phase3 开发计划` 组织），并在 [需求清单](docs/design/README.md) 追加一行，对齐后再动手。**Agent RAS 相关需求**写到 [`docs/agent-ras/design/<topic>/`](docs/agent-ras/design/)，并在 [`docs/agent-ras/design/README.md`](docs/agent-ras/design/README.md) 与全仓 [需求清单](docs/design/README.md) 同步登记。
- **先讲思路对齐**（不一定写文档）：实现路径有多种合理选择、跨多个模块、需要引入新抽象、或自己感到"这事不止改几行"—— 先简述方案 + 列 trade-off，等用户确认再写代码。用户也会主动说"这是大需求"作为信号。

小改动（bug fix、文案、单文件局部调整）直接动手，事后说明即可。

**改完功能后，必须同步刷新对应指南。** `docs/` 下有两套面向读者的文档，功能变更只要波及它们就要连带更新，别让读者读到过期信息：

- 改动影响**用户能感知的东西**（新功能 / 交互或流程变化 / 新增配置项 / 概念或术语调整）→ 更新 [`docs/user-guide/`](docs/user-guide/) 对应页。
- 改动影响**架构 / 模块 / API 与契约 / 数据流 / 扩展方式** → 更新 [`docs/developer-guide/`](docs/developer-guide/) 对应页（先看 [`INDEX.md`](docs/developer-guide/INDEX.md) 找页；该指南带 provenance commit，更新后按其 “How to update” 把 commit 顺手推到当前 HEAD）。
- 两边都影响就两边都改。判断口径很简单：**别人照旧文档去操作 / 理解会被带偏，就必须改。**

## 5. 改动验证

完工前默认先跑测试：

1. **跑测试**：`npm run test`（执行 `test/**/*.test.ts`）。
2. **询问是否需要跑 dev 并验证 UI**：不要默认执行 `bash scripts/develop_start.sh`。先询问用户是否需要启动 dev server 并走一遍 golden path + 至少一个边界 case；仅在用户确认后执行。
   - 如果 agent 自带浏览器自动化能力（Claude Code 的 `preview_*` MCP、Cursor browser MCP 等），用户确认后优先自己跑完，附截图/快照/console 错误给用户。
   - 未执行浏览器验证时，明确告诉用户"未在浏览器中验证"，不要默认声称成功。

类型检查 / lint 验证的是代码正确性，不是功能正确性。

## 6. 项目内部约定

### 设计系统：用共享令牌，别再造局部色板

前端视觉规范见 [`docs/developer-guide/08-design-system.md`](docs/developer-guide/08-design-system.md)，机器可读令牌见 [`docs/developer-guide/design-tokens.json`](docs/developer-guide/design-tokens.json)。**唯一真源是** [`src/app/globals.css`](src/app/globals.css) 的 `:root` / `[data-theme='dark']`（中性灰阶 + 单一 indigo 主色 + 3 个语义状态色）。

- 写新样式一律引用共享令牌（`var(--foreground*)` / `--color-*` / `--radius-*` / `--primary` …），优先复用 [`ui/*`](src/components/ui) 组件与 `globals.css` 里的 `.ai-*` 工具类。
- **不要新建** `--<feature>-*` 局部色板（历史遗留的 `--sk-*` / `--ev-*` / `--sa-*` / `--gh-*` 是设计漂移，正在收敛，别再加）。主色只用于交互态，不要拿来做装饰。
- 改了令牌或视觉规范 → 同步 `08-design-system.md` 与 `design-tokens.json`。

### Skill 用 `name` 而非 `id` 做对外 key

- 前端路由：`/skill-opt/[name]/[version]` 走 name。
- 新 API 路径用 `:name`（如 `/api/skills/:name/...`），不要用 `:id`。
- DB 里仍有 `id` 字段，只在内部使用。
- 代价：skill 重命名会断 URL —— 接受这个代价，rename 本来就该是大动作。

## 7. 仓库的非标准目录

标准 Next.js 结构（`src/app` / `src/components` / `src/lib` / `prisma/`）按常规理解即可。下列是项目特有的：

- `skills/` —— 内置 Skill 定义，每个 skill 一个子目录，含 `SKILL.md`。
- `docs/developer-guide/` —— 面向开发者 / LLM 的架构与契约指南（入口 [`INDEX.md`](docs/developer-guide/INDEX.md)）；`docs/user-guide/` —— 面向使用者的操作指南；`docs/design/` —— 需求 / 设计文档（见 [需求清单](docs/design/README.md)）。
- `docs/agent-ras/` —— Agent RAS 文档统一入口（架构、需求设计、专题、参考与示例）；源码在仓根 `agent_ras/`。
- `features/` —— 单 feature 的设计草稿（比 plan 更轻量）。
- `scripts/develop_start.sh` —— 验证流程要用，不要换别的方式启 dev server。

## 8. 代码风格（仅列反默认项）

- **文件路径在沟通中** 用 markdown link 格式：`[name](relative/path:line)`，方便用户点击。
- **注释默认不写**。只在 WHY 不明显时加一行（隐藏约束、反直觉的 workaround）。不要写"做了什么"或"给 X 调用方用"这种会过期的注释。
- **不要主动创建文档文件**（`*.md` / README），除非用户明确要求。

## 9. 默认禁止 / 需要确认的操作

未经用户授权不要：

- 推送到任何远端、创建/合并 PR、关闭 issue。
- 修改 CI、`package.json` 的 scripts、`.env*`。
- 升级/降级依赖、删除依赖。
- 删除文件、目录、分支。
- 改 git config。

读取、跑测试、本地 dev、改 src 下的代码都可以自由进行。

***

如发现本文档与实际开发流程不一致，**改文档** 比"默默偏离"好。改完在 PR 描述里说明即可。
