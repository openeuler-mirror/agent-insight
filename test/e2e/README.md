# 核心 E2E（保留原编号）

测试包供开发者和 CI 使用，不随生产 npm 包/镜像发布。报告由代码生成，不调用模型。PR 验证以远端准确提交为准，本地工作树报告单独标记。

## 目录

- `cases/001-setup`：准备、登录、模型、客户端。
- `cases/002-opencode-observation`：OpenCode 原生上报和页面观测。
- `cases/003-skill-lifecycle`：上传、生成、页面建数据集、实验生成 Trace、评测、诊断、优化、发布复跑。
- `cases/004-trace-evaluation`：已有 Trace、无数据集评测、诊断、优化。
- `005`：编号退役，主路径并入003；旧目录和独立入口已删除，历史报告编号保留。
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

`real` 用真实 DeepSeek 业务调用。`mock` 为六例提供本地 Chat Completions 协议夹具：原生探针、真实工具读取与写入、生成、评估、诊断及优化响应均在本地处理，真实 OpenCode、采集、数据库和页面继续执行，不使用真实模型密钥。未知请求拒绝并导致协议审计失败，不回退到真实模型。评分和语义判断是固定夹具，不证明模型质量；脚本真值、原生 Skill 绑定、输入保留、处置回执及必需阶段仍由原断言检查。UT 仍实际执行。默认执行001 Real，002/003/004/006 Mock；005已并入003。真实模型凭据仅在Real组需要。显式 `--mode mock|real` 覆盖所有已选例子的模式，006已包含在默认范围中。

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

119 已启用 `http://119.3.152.42:18880/webhook` 与自动队列，origin PR !199 已实测新建/更新自动回写。常驻服务仍沿用先前部署的 `real + core-five + UT` 配置（001–005）；该历史部署尚未切换到本地新测试包。当前本地--all只选001/002/003/004/006；接入结果以验证历史的真实 PR 记录为准。部署和状态检查见 [控制服务指南](control/README.md#119-常驻服务当前部署)。


真实 [PR !200](https://atomgit.com/gyctl/agent-insight/merge_requests/200) 最新任务 `baebd36a45d123b5ab2718b48ffaac0c`：001、002 PASS，003–005 FAIL，006 NOT_RUN；UT 4638 为中断后的观测下限（4608 通过、6 失败、24 跳过）。自动评论已读回确认，100 份允许的证据文件已导出，manifest 无超限省略，历史 Trace 保留；详细问题与基线见 [控制指南](control/README.md#五例真实-pr-验收2026-11-04)。


## 统一配置

`config.json` 是 PR 与每日测试的共同配置源。`defaults` 提供默认值，`profiles.pr`、`profiles.daily` 分别覆盖账号、模式、场景、模型、资源或超时。账号默认为原有两个 test 邮箱，数据空间仍为 pr/daily；默认001使用Real，002/合并003/004/006使用Mock，UT开启；005不重复执行。当前 standalone 登录使用邮箱与产品分配的 API Key，不需要账号密码。

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

本地显式 --mode、--case、--all、--ut/--skip-ut、--key-file 等调试参数可覆盖对应配置，报告记录实际生效的脱敏快照和哈希。--all 显式选择未合并的五个编号（包含006），默认配置也选择这五例；005不再可执行，--case 005或将005放入cases都会明确拒绝并提示改用003。切换 Mock 不会自动实现其他场景：活动场景提供协议适配；是否完整通过以对应运行报告为准，不回退到真实模型。

本轮本地验证已覆盖自定义 URL/模型名/非 sk Key 的真实原生客户端到本机 HTTP 请求、转发器的 URL 前缀和模型白名单、配置去重、账号保护、超时与慢清理。配置改造尚未部署到 119，未通过它重跑产品 UI 或付费模型业务；003 的既有未提交修正未在本轮发布。

003/004 的平台内部 Agent 与客户端使用同一模型选项、上下文/输出预算；平台 Agent 的工作区建在仓库之外，避免继承被测源码仓库的 Git/AGENTS 上下文。该设置由启动准备统一注入，报告记录实际 profile 和工作区。

切换模型时同时核对 `contextTokens` 与 `outputTokens`。部分服务把推理 Token 计入输出上限；诊断可能比普通探测需要更多输出预算。`finish=length` 表示回复被截断，仍按失败处理，应依据本轮用量调整可信模型配置后用新 runId 重跑，不能把部分回复计为完成。

测试端读取工作台会话状态时，仅对 `UND_ERR_SOCKET/ECONNRESET/EPIPE` 这类明确的连接关闭／重置重连一次，两个尝试共享原有 45 秒期限。日志记录脱敏路径、错误码及是否重连，不记录查询参数或凭据；HTTP 500、超时、取消、其他 GET 和所有写请求不自动重试，避免把产品失败隐藏在测试重跑中。

活动场景的模型连接测试最多真实尝试 3 次，只重试服务端、网络、超时和限流错误，并逐次保存 `private/model-probe-attempts.json`。耗尽后标记阻塞；无效请求和未知错误直接失败。浏览器响应等待在失败清理时也会收尾，不让未处理的等待异常中断报告生成。

`resources.appHeapMiB` 同时约束隔离应用的 Node 启动进程和 Next.js 派生进程，避免开发启动脚本的固定堆设置绕过测试资源配置；它不等同于容器总内存限制。

`application.mode` 默认为 `production`：全局生产编译通过后初始化测试数据库，通过 `scripts/control-server.js` 启动生产服务，并为它与 Next 路由设置同一个独立空闲的指令分发端口。各例复用同轮 BUILD_ID，构建耗时单列在 productionBuild，不计入首例准备。编译日志位于 job/build/private-build/production-build.log，单进程本地入口位于 exclude/core-e2e/build-preflight/private/production-build.log。生产编译要求隔离容器，并校验本轮源码指纹及产物完整性。`dev` 保留用于调试，应用沿用 `scripts/develop_start.sh` 启动，统一门禁仍先做生产编译。资源配置 `resources.openFiles` 控制容器 nofile（默认1024，119配置16384）。模型Real/Mock与应用启动模式分别配置。


003/004 优化可能包含平台自验证和自动修复，测试端最多等待 15 分钟，并受整例 `caseMs` 截止约束。平台明确失败仍立即结束，不会因延长等待而视为成功；评分回落提示保留在原始证据中。

004 的步骤核验兼容正式流程的 `branches` 与 `conditionalGroups` 表达。只有实际脚本已成功输出有效非空 JSON，且正式流程明确存在互斥的错误输入分支时，该错误分支才允许列为不适用；所有核心动作仍必须覆盖，未执行分支不计通过。

004 重开实验时，先等待受保护页面完成登录恢复并显示实验内容，再执行刷新并重新断言；不以紧接 `goto` 的第二次导航代替正常刷新。快速连续刷新触发的登录恢复边界另见 Issue #359，不通过自动重新登录掩盖失败。

004 的事实核对按实际脚本 JSON 校验三个字段的脚本值与报告值；表格、列表、JSON 及标题说明均可，不以“核对：”等固定标题或标点判定通过。缺少任一字段对照、脚本值与报告值不一致、只有“已核对”声明均失败。

004 的四字段摘要 JSON 解析：允许纯 JSON 或成对 Markdown 行内代码包装；仍只允许一条摘要、一个合法 JSON 对象，四字段及真值断言不变。多条、缺失、无效 JSON、多行和不成对包装均失败。

## 六例 Mock 与 PR 计时

仓库默认逐例配置见下文；119常驻服务在显式部署前仍沿用其原可信配置。临时扩展验证应另建可信配置文件，同时清空caseModes并显式选择有效编号；005已退役，006只在明确单独验证时选择。不要把PR中的配置当作可信控制规则。Mock 容器使用预装离线客户端依赖、network none，不挂载模型密钥。

报告分别记录每例 startedAt/endedAt/durationMs、E2E 起止和总耗时、UT 起止和耗时。真实平台投递时间与评论时间用于计算 PR 等待及回写耗时。冷启动、依赖准备与用例执行分列；本地单例预检不能冒充 PR 触发结果。006 保留真实故障注入、重复输出、中断回执和恢复断言，mock 不掩盖 FI 生命周期缺陷。

## 逐例模式与合并场景

```json
{
  "mode": "mock",
  "cases": ["001", "002", "003", "004"],
  "caseModes": {"001": "mock", "002": "mock", "003": "mock", "004": "real", "006": "mock"}
}
```

放在defaults，或分别在profiles.pr/daily中覆盖；caseModes逐键继承，未列编号回退到mode。显式命令行--mode会清除逐例覆盖，用于整轮调试。mode的配置值仍只有real/mock，mixed是报告根据已选例子计算的结果。005的旧目录、专用脚本和独立调度入口已删除；通用校验迁到shared，编号仅用于历史报告；006未出现在cases中，所以配置其模式不会启动它。

服务器隔离入口`control/run-isolated.mjs`与PR worker按模式分组：先Real组001，再Mock组002/003/004/006，整个运行持有同一执行锁，串行导出和继承同通道账号状态；pr和daily仍使用各自固定账号。每组使用独立容器和工作区，并复制同一份已校验编译产物，Mock组network none且不挂载真实模型凭据，Real组只获得短期代理凭据。UT只在首组运行一次，失败也会如实保留并继续业务验证。总截止时间在两组间共享；报告逐例标明模式，任何组缺失或历史保存失败都不能通过。每组资源、配置指纹、证据及原始报告保留在groups目录，顶层为合并结果。

本地run.mjs可按相同逐例模式调度，用于开发调试；网络和凭据隔离由服务器容器入口提供。混合模式由001检验真实模型连通性，其他用例使用本地模型协议夹具，003的Mock评分只证明业务流程与契约，不能宣称真实模型质量通过。

隔离容器默认启用应用与OpenCode的info级诊断日志，用于定位“原生任务已完成而工作台仍运行”等收尾问题；日志保存在本轮受限证据中，不改变普通用户日志设置。单次通过不代表偶发问题已经消失，失败尝试保留并独立记录。

## 当前混合模式隔离验收（2026-11-06）

`mixed-core-20261106-a`：001/002/合并003 Mock、004 Real全部通过；UT4711项，4686通过、0失败、25跳过，完整无中断。整轮约19分50秒，包含两组生产构建。005不重复执行，006暂停；证据归档在exclude/core-e2e/mixed-core-20261106。此轮为119源码快照验证，尚未部署到常驻Webhook/每日服务，也不是PR触发结果。

预验probe-c出现一次生成收尾超时，原始失败保留，原因未确认；随后通过不能作为该偶发问题已经消除的证据。完整结果与未覆盖边界以本轮coverage.md为准。

## 005资源清理与能力归属

003现在负责页面创建一题私有数据集、原题/独立参考答案与账号归属核对、实验生成Trace、评测、主诊断及锚点导航、优化与同题候选验证，并额外发布复跑。005旧场景、专用Python脚本和旧独立夹具测试已经删除；003所用日志真值及数据集业务哈希/归属断言分别位于shared/log-truth.mjs、shared/dataset-contract.mjs，对应负向测试保留。

原005统计“前五来源”并追加四字段摘要；003收敛为首要来源和三字段摘要，004仍验证四字段摘要。这是业务样例的收敛，不宣称003仍逐项验证旧005全部业务输出分支。原005历史报告和Trace不删除；报告继续保留005已合并状态，编号不重排。

004真实模型调用及耗时拆解见[cases/004-trace-evaluation/README.md](cases/004-trace-evaluation/README.md#真实模型调用与耗时)。

006最新单例Mock补验：fi554-006-mock-20261106-b基于upstream !554/e191afe4完整通过故障→检测→回执→原生中断→评测→页面→同客户端恢复→持久化。模型接口本地15次，外部0次；UT4664/4639通过/0失败/25跳过，完整无中断。E2E约3分25秒、含UT总约6分45秒。005清理与本轮报告见exclude/core-e2e/cleanup005-case006-20261106；首次时间顺序误报已修正，原始失败保留。该历史单例运行后，当前配置已将006加入默认PR/daily范围。

## 生产编译与当前默认门禁

当前默认001 Real，002/合并003/004/006 Mock，PR与daily使用各自稳定测试账号。执行顺序：生产编译→UT一次→Real/Mock隔离分组。编译容器无网络、无模型密钥；任何编译失败直接返回FAIL，UT及所有场景NOT_RUN，报告保留错误和编译日志。环境准备或导出失败记为BLOCKED。

生产编译只执行一次，成功产物由源码内容指纹及BUILD_ID绑定，隔离分组从只读产物目录复制到各自工作区，启动前拒绝源码不一致、缺失产物和错误BUILD_ID。生产编译结果、耗时与日志位置写入JSON、HTML及PR评论。直接运行run.mjs也先编译，生产编译须处于隔离容器；推荐使用control/run-isolated.mjs。

PR评论由shared/suite.mjs模板及control/publish.mjs生成，通过AtomGit API创建并核对正文，无模型参与。模型只用于标记Real的业务测试。此配置的实现不等同于已更新119常驻服务，部署状态以最新运行记录为准。

当前配置隔离验收 `build-first-20261106-b`：生产编译2分18秒通过，UT4738项/4714通过/0失败/24跳过且完整；001 Real、002/004/006 Mock通过，003 Mock生成收尾超时，整轮FAIL。不得把该结果视为五例稳定全通过。287份证据无省略，历史保留、无OOM；未更新常驻PR/daily服务。

启动边界复核：单一模型分组修正执行器租约传递，直接run.mjs修正显式项目/运行ID/环境及日志路径。222项测试包检查通过，并在119以build-first-single-20261106-c实际完成生产编译和002 Mock单例；UT按单例补验配置未执行，总报告PARTIAL，不能替代五例整轮。该单例补验当时未修复B轮的003生成收尾失败。

最新整轮 `fix003-full-20261106-a`：003收尾竞态修复后，生产编译、完整UT以及001 Real、002/003/004/006 Mock均通过；003完整闭环约53秒，整轮约9分50秒。UT4740项/4716通过/0失败/24跳过，394份证据无省略。原失败B轮保留；本次为119隔离验证，常驻服务未切换。
