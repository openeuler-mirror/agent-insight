# AGENTS.md

本分支按[前后端重构方案](design/platform/frontend-backend-separation/Agent-Insight前后端重构方案.md)搭建新平台。提交和评审必须遵守[模块接口与依赖规则](docs/zh/how-to/platform/refactor-module-boundaries.md)。

## 目录与迁移

- 新页面、REST 入口、设备客户端分别归入 `apps/web/`、`apps/server/` 和 `apps/client/`。业务接口和实现归入 `packages/core/`，可替换实现按类型登记在 `extensions/`。
- `legacy/` 供对照旧实现。迁入某项能力时，在目标模块定义契约，把调用、实现和对应测试一起迁入。新代码的运行时导入、类型导入和构建路径均不得指向 `legacy/`。
- 新 API 和数据模型的设计登记在 [design/](design/README.md)。开发或部署方式发生变化时同步更新 [docs/](docs/README.md)。有多种合理的跨模块方案时，先对齐职责边界。
- 类型契约用 TypeScript 5.9.3 执行 `tsc -p tsconfig.contracts.json`。单元测试放 `test/UT/`，系统测试直接放 `test/ST/`。功能迁入时增加对应验证，注明实际覆盖范围。

## 1. 分支与 PR 流程

当前仓库协作依赖两个固定 remote：

- **`origin`** —— 分支推送仓 `gyctl/agent-insight`，日常 feature branch push 目标。
- **`upstream`** —— 上游合并仓 `openeuler/agent-insight`，MR 默认目标分支 **`master`**。

> ⚠️ 第一次操作前仍须运行 `git remote -v` 核对实际配置；如果本地 remote 与上述约定不一致，以实际 URL 和用户确认结果为准。必须和用户确定是否需要拉取远端代码、目标仓库和目标分支后，再执行自动拉代码或自动提 MR。

**默认流程**：

1. 从 `upstream/master` 起新分支（或基于它 rebase）。
2. 推到 `origin` 的 `<feature-branch>`。
3. 提 PR（GitCode 称 MR），target = **`upstream` (`openeuler/agent-insight`) 的 `master`**。

**禁止**：

- 直接推 `upstream/master`。
- 未经用户授权执行 `push --force`、`reset --hard`、删分支等破坏性操作。

## 2. Commit 规范

使用 **Conventional Commits** 前缀：`feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `chore:` / `perf:` / `style:`。

- subject 可中文；保持一行简述 + 可选 body。
- 一次 commit 聚焦一件事；不要把无关改动捎带进同一个 commit。
- **除非用户明确要求**，不要用 `--amend` / `--no-verify`。pre-commit 失败就修问题、重新 stage、新建 commit。

## 3. Commit + Push（gitcode 提示）

仓库托管在 **gitcode**，不是 GitHub —— **不要用** **`gh`**。

push 前先 `git remote -v` 确认 `origin` 仍指向 `gyctl/agent-insight`，然后 `git push -u origin <branch>`。输出里会有 MR 创建链接，连同建议的 PR 标题/描述转发给用户。

⚠️ GitCode MR 页面默认 target 可能仍是源仓的 `master`，创建时必须确认 base repository 为 `openeuler/agent-insight`、base branch 为 `master`。

## 9. 默认禁止 / 需要确认的操作

未经用户授权不要：

- 推送到任何远端、创建/合并 PR、关闭 issue。
- 修改 CI、`package.json` 的 scripts、除 `.env.example` 外的 `.env*`；`.env.example` 可随功能配置契约同步修改，但只允许提交通用变量名、说明以及空值或虚构示例，禁止写入真实密钥、内部域名、账号或其他部署敏感信息。
- 升级/降级依赖、删除依赖。
- 删除文件、目录、分支。
- 改 git config。
