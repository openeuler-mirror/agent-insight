# 文档目录迁移实施计划

**目标：** 将现有公开文档迁入 `docs/zh/<类别>/<领域>/`，内部设计迁入仓根 `design/<领域>/`；保留全部历史资料，整理缺口与待用户决定的过期候选。

**结构：** 公开文档采用 tutorial、how-to、reference、explanation 四类及原设计的六个业务领域。迁移本轮按主要用途归类，不翻译或重写正文；混合主题、缺少英文和内容过时单独登记。英文目录提供明确标注的待补齐导航，不冒充已有译文。

**工具：** Git、Python 路径映射与引用校验、现有 Node/TypeScript 测试、npm 打包清单检查。

## 1. 基线与映射

- 基于当前已验证的许可分支建立独立本地分支，不拉取、不推送。
- 保存全部受跟踪 `docs/` 文件、原始内容摘要及现有导航和链接基线。
- 为每个文件生成唯一旧路径—新路径映射；图片、HTML、第三方 bundle 和设计验证脚本都保留。
- 将映射保存为本目录的 `path-map.json`，迁移时禁止覆盖现有目标文件。

## 2. 迁移与引用适配

- 按映射移动文件；更新 Markdown/HTML 相对引用、仓内路径及文档站路径。
- 更新 `docs/docs.json`、根 README、`AGENTS.md` 和许可材料中指向第三方文件的路径。
- 同步 `package.json` 的 files（不改 scripts/依赖）、`Dockerfile.local.dockerignore`、`scripts/prepare-npm-package.js`、LlamaIndex archive 文档读取路径和相关测试。
- 保留独立评估服务和平台内置评估的职责边界，不迁移产品源码模块。

## 3. 导航与审查清单

- 建立 `docs/README.md`、中文四类导航和英文待补齐入口；站点导航只指向实际文档。
- 内部设计、旧原型及归档资料按用途归位，原始正文和资源不删除。
- 在 `migration-review.md` 列出缺失内容、混合主题、疑似过期项及证据；不根据日期或标题自动判废。
- 保存完整迁移清单，并记录迁移前已存在的坏链接，区分新增问题。

## 4. 验证与交付

- 校验所有原文件都有目标、二进制/第三方代码内容不变、无覆盖或丢失。
- 校验文档链接及 HTML 本地资源的迁移前后目标、站点导航有效性、旧路径残留。
- 运行 `node --import tsx --test test/llamaindex-setup.test.ts test/agent-debug-capability-presentation.test.ts` 验证文档读取与打包路径。
- 在隔离数据目录和当前 schema 数据库中运行 `npm run test`，与本次迁移前基线对比失败项。
- 运行 `npm pack --dry-run --ignore-scripts --json` 核对迁移后的采集器文档仍进入 npm 包。
- 不启动 dev server；本轮文档迁移无页面业务改动，交付时明确未做浏览器验证。
- 交付本地修改和审查清单，不自动提交或推送，也不清理任何候选文档。

## 5. 维护者确认后的资料清理与更新

- 首次迁移完成后，维护者明确授权删除待审清单第 1、2、3、4 项：SDK 片段、环境片段、退役 Dashboard 档案、重复的用户 HTML 概览。
- 第 5、6 项开发者 HTML 和 830 RPM 指南暂时保留，第三方资源及其许可材料不随文档删除。
- 第 7–15 项按当前源码更新说明；历史问题与现行行为分开，缺失的测量依据明确标记，业务代码、依赖、接口和配置逻辑保持不变。
- 与本阶段开始时的文件摘要比较，确认仅指定四项删除；检查本地引用与活动导航，验证 LlamaIndex ZIP README、standalone 文档复制及 npm 包清单，并运行隔离全量测试。
- 首次迁移路径映射和测试证据保留为历史记录，清理结果写入 migration-review.md 及 verification.json 的 approvedCleanup；不自动提交或推送。

## 6. 提交前审查补充

- 合入明确目标 upstream/master 的最新示例数据脱敏提交，保留其脚本与数据清理。
- 为迁出的根 design 同步 Next 文件追踪排除和 prepack 清理规则；用真实 standalone 目录验证排除内部设计而不删除源码、运行文件和许可材料。
- 完成独立审查与同步后全量验证，结果记录到 verification.json 的 submissionValidation。
