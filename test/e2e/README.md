# 核心六场景 E2E

测试包供开发者和 CI 使用，不随生产 npm 包/镜像发布。报告由代码生成，不调用模型。PR 验证以远端准确提交为准，本地工作树报告单独标记。

## 目录

- `cases/001-setup`：准备、登录、模型、客户端。
- `cases/002-opencode-observation`：OpenCode 原生上报和页面观测。
- `cases/003-skill-lifecycle`：上传、生成、评测、优化、发布。
- `cases/004-trace-evaluation`：已有 Trace、无数据集评测、诊断、优化。
- `cases/005-dataset-evaluation`：页面建集、生成 Trace、评测、诊断、优化。
- `cases/006-fault-recovery`：故障注入、检测、中断回执、恢复；真实执行并如实保留失败。
- `shared`：隔离环境、登录、客户端、公共断言、报告与套件工具测试。
- `control`：Webhook 接收、持久化队列、隔离执行及 PR 评论回写。

专用资源在相应 `cases/*/fixtures/` 下；复用的产品原始日志 `public/example/messages` 和内置 Skill 直接引用产品文件，避免副本漂移。单次临时运行的数据和证据位于 `exclude/core-e2e/<runId>/`，不提交。指定 `--lane pr|daily --state-dir /absolute/private/state` 时，使用固定的 `test_e2e_pr@example.com` 或 `test_e2e_daily@example.com` 账号，应用数据保存在各自独立目录；报告列出本轮新增 Trace，旧 Trace 保留且不计入本轮通过证据。原始日志与浏览器 trace 在受限 `private/`；不要将整个运行目录直接公开。

## 运行

先安装项目依赖。测试使用支持 `node:sqlite` 和 TypeScript 类型剥离的 Node；当前本地验证 Node 23.10.0，Linux 测试镜像采用 Node 24。浏览器和原生客户端使用独立依赖。

```bash
node test/e2e/run.mjs --prepare
node test/e2e/run.mjs --list
node --test test/e2e/shared/*.test.mjs test/e2e/cases/*/*.test.mjs test/e2e/control/*.test.mjs
node test/e2e/run.mjs --case 002 --mode real --key-file /absolute/path/to/deepseek-key.txt
node test/e2e/run.mjs --all --mode real --ut --key-file /absolute/path/to/deepseek-key.txt
node test/e2e/run.mjs --profile core-five --mode real --ut --key-file /absolute/path/to/deepseek-key.txt
node test/e2e/run.mjs --case 002 --mode mock --skip-ut
node test/e2e/run.mjs --all --mode mock --ut
```

`real` 用真实 DeepSeek 业务调用。`mock` 为六例提供本地 Chat Completions 协议夹具：原生探针、真实工具读取与写入、生成、评估、诊断及优化响应均在本地处理，真实 OpenCode、采集、数据库和页面继续执行，不使用真实模型密钥。未知请求拒绝并导致协议审计失败，不回退到真实模型。评分和语义判断是固定夹具，不证明模型质量；脚本真值、原生 Skill 绑定、输入保留、处置回执及必需阶段仍由原断言检查。UT 仍实际执行。统一入口默认 `real`，必须提供密钥文件；显式 `--mode mock` 保留原行为。真实 006 也会执行，现有 FI 中断回执缺陷不豁免、不改判通过。

每例独立执行，失败后继续其他场景；生成 `report.json`、`report.html`、`summary.md`，整体非通过退出 1。UT 独立记录完整性和中断，不将环境失败自动归类为产品缺陷。默认 UT 超时 30 分钟；可用 `--ut-timeout-ms` 调整。单例原始报告仍通过 `run-case.mjs` 生成，兼容旧 `tools/core-e2e/run.mjs` 命令。真实单例运行总预算 45 分钟。

当前本地工作树报告带 `dirtyWorkingTree`，不能冒充某个已提交 PR 的验证结果。按运行编号保留原始失败，不覆盖历史报告。未列入本轮执行的场景显示 NOT_RUN；阻塞、不完整和未执行均不计通过。

## PR Webhook

见 [本地联调与部署](control/README.md)。本地 HTTP 协议联调使用测试 PR 服务，并非真实 GitCode 事件；只有真实平台投递、精确提交执行及远端读回确认后才能宣称联调成功。

[历史独立真实验收](validation-history.md)记录 002—005 过去的完整验证；不与新运行拼接为六例全通过。六例详细方案仍在用户指定的外部方案目录。

## 2026-11-04 本地验证记录

- `migration-002-20261104-a-002`：迁移后真实 DeepSeek / OpenCode / 页面完整运行，002 的 7 个阶段通过。
- `mock-002-20261104-a-002`：本地模型协议夹具，真实客户端、采集和页面，7 个阶段通过。
- `local-pr-20261104-c`：统一入口实际执行 UT + Mock；UT 4648 项，4584 通过、41 失败、23 跳过、0 取消，完整结束；002 通过，其余五例 BLOCKED。失败仍需逐项区分环境与产品问题。
- 以上是本地工作树验证，不是已提交 PR 的正式检查；报告在仓根 `exclude/core-e2e/<runId>/report.html`。
- npm 打包预检没有包含测试目录、Playwright 或回归产物；生产镜像只核对排除规则，未重新构建生产镜像。


## 119 真实隔离验证（2026-11-04）

PR 完整轮 `119-pr-full-20261104-f` 与每日完整轮 `119-daily-full-20261104-b` 均已实际执行，001、002 通过，003—006 未完整通过；004 的后续单例补验仍失败。UT 单独统计，daily b 的单文件超时记执行不完整。最新记录和失败分类见 [验证历史](validation-history.md#119-独立容器全量验证2026-11-04)。131 项工具测试通过，不等于六例通过。固定账号、历史保留和容器退出已核验；该两轮脚本运行时尚未启用新 Webhook、远端评论或每日 timer；当前 PR 状态见下节。


## 当前 PR 常驻入口

119 已启用 `http://119.3.152.42:18880/webhook` 与自动队列，origin PR !199 已实测新建/更新自动回写。当前接入目标为 `real + core-five + UT`：001–005 使用真实 DeepSeek，006 按用户要求 NOT_RUN。手工 `--all` 仍保留六例，Mock 入口不变；接入结果以验证历史的真实 PR 记录为准。部署和状态检查见 [控制服务指南](control/README.md#119-常驻服务当前部署)。


真实 [PR !200](https://atomgit.com/gyctl/agent-insight/merge_requests/200) 最新任务 `baebd36a45d123b5ab2718b48ffaac0c`：001、002 PASS，003–005 FAIL，006 NOT_RUN；UT 4638 为中断后的观测下限（4608 通过、6 失败、24 跳过）。自动评论已读回确认，100 份允许的证据文件已导出，manifest 无超限省略，历史 Trace 保留；详细问题与基线见 [控制指南](control/README.md#五例真实-pr-验收2026-11-04)。


## 统一配置

`config.json` 是 PR 与每日测试的共同配置源。`defaults` 提供默认值，`profiles.pr`、`profiles.daily` 分别覆盖账号、模式、场景、模型、资源或超时。账号默认为原有两个 test 邮箱，数据空间仍为 pr/daily；默认真实模型、001–005、UT 开启，006 未执行。当前 standalone 登录使用邮箱与产品分配的 API Key，不需要账号密码。

```bash
export E2E_MODEL_KEY_FILE=/absolute/private/model.key
node test/e2e/run.mjs --check-config --profile pr
node test/e2e/run.mjs --config test/e2e/config.json --profile pr
node test/e2e/run.mjs --config test/e2e/config.json --profile daily
```

`--check-config` 只校验并打印无密钥值的配置快照，不检查凭据是否存在、不发起模型请求。长期保存 Trace 时，设置 storage.stateRootEnv 指向的环境变量（默认 E2E_STATE_ROOT），或使用 `--state-dir /absolute/private/state`；两组数据分别位于其 pr/daily 子目录。未提供状态目录的本机运行仍隔离在单次报告目录，不会自动接入用户正常应用数据库。更改账号时，旧数据标记或记录不一致会阻塞；需要新状态根目录或另行明确迁移，原数据不会被自动删除。

模型配置示例（替换 config.json 对应 model 段）：

```json
{
  "baseUrl": "https://gateway.example/v1",
  "modelName": "your-model-name",
  "key": { "env": "E2E_MODEL_KEY" },
  "options": {}
}
```

上述片段可放到 profiles.pr.model 或 profiles.daily.model，未列字段继承 defaults.model。支持 OpenAI Chat Completions 兼容端点，Base URL 的路径前缀会保留。Key 可引用 `{ "env": "E2E_MODEL_KEY" }`、`{ "fileEnv": "E2E_MODEL_KEY_FILE" }` 或 `{ "file": "/absolute/private/model.key" }`；配置文件不接受明文 Key。外部文件既支持单行任意格式 Key，也兼容旧文件中唯一一个 sk- Key 的说明文本。环境变量值必须是单一 Key。不得使用仓库或 Webhook 凭据作为模型 Key。新 Key 不再要求 sk- 前缀。默认 options 为 DeepSeek 禁用 thinking；其他兼容模型可覆盖为 `{}`。

CPU/内存/PID、工作盘、空闲磁盘、宿主保留内存与应用堆由 resources 设置。CPU/内存/磁盘等上限由隔离容器执行，本机直接运行不声称已施加 Docker 上限。concurrentRuns 当前只支持 1，填写其他值会拒绝执行，不会伪装并发已实现。timeouts 包括 UT、单文件 UT、单例、整轮、模型请求与清理宽限；整轮/单例到期后停止启动后续任务，另留 cleanupGraceMs 清理已启动进程。报告存储可配置 storage.reportsDir，但限定在 exclude/core-e2e 及其子目录，防止与普通用户数据混用。

本地显式 --mode、--case、--all、--ut/--skip-ut、--key-file 等调试参数可覆盖对应配置，报告记录实际生效的脱敏快照和哈希。--all 仍明确执行六例，默认配置入口只选五例。切换 Mock 不会自动实现其他场景：六例均提供协议适配；是否完整通过以对应运行报告为准，不回退到真实模型。

本轮本地验证已覆盖自定义 URL/模型名/非 sk Key 的真实原生客户端到本机 HTTP 请求、转发器的 URL 前缀和模型白名单、配置去重、账号保护、超时与慢清理。配置改造尚未部署到 119，未通过它重跑产品 UI 或付费模型业务；003 的既有未提交修正未在本轮发布。

003–005 的平台内部 Agent 与客户端使用同一模型选项、上下文/输出预算；平台 Agent 的工作区建在仓库之外，避免继承被测源码仓库的 Git/AGENTS 上下文。该设置由启动准备统一注入，报告记录实际 profile 和工作区。

004 的步骤核验兼容正式流程的 `branches` 与 `conditionalGroups` 表达。只有实际脚本已成功输出有效非空 JSON，且正式流程明确存在互斥的错误输入分支时，该错误分支才允许列为不适用；所有核心动作仍必须覆盖，未执行分支不计通过。

004 重开实验时，先等待受保护页面完成登录恢复并显示实验内容，再执行刷新并重新断言；不以紧接 `goto` 的第二次导航代替正常刷新。快速连续刷新触发的登录恢复边界另见 Issue #359，不通过自动重新登录掩盖失败。

004 的事实核对按实际脚本 JSON 校验三个字段的脚本值与报告值；表格、列表、JSON 及标题说明均可，不以“核对：”等固定标题或标点判定通过。缺少任一字段对照、脚本值与报告值不一致、只有“已核对”声明均失败。

004/005 共用摘要 JSON 解析：允许纯 JSON 或成对 Markdown 行内代码包装；仍只允许一条摘要、一个合法 JSON 对象，四字段及真值断言不变。多条、缺失、无效 JSON、多行和不成对包装均失败。

## 六例 Mock 与 PR 计时

正式配置默认仍为真实模型、001–005。临时验证应另建可信配置文件，将 mode 设为 mock、cases 设为全部六个编号，使用独立的固定 mock 账号和状态根目录；不要把 PR 中的配置当作可信控制规则。Mock 容器使用预装离线客户端依赖、network none，不挂载模型密钥。

报告分别记录每例 startedAt/endedAt/durationMs、E2E 起止和总耗时、UT 起止和耗时。真实平台投递时间与评论时间用于计算 PR 等待及回写耗时。冷启动、依赖准备与用例执行分列；本地单例预检不能冒充 PR 触发结果。006 保留真实故障注入、重复输出、中断回执和恢复断言，mock 不掩盖 FI 生命周期缺陷。
