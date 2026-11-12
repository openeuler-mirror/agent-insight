# 核心 E2E（001～005）

测试包供开发者和 CI 使用，不随生产 npm 包/镜像发布。报告由代码生成，不调用模型。PR 验证以远端准确提交为准，本地工作树报告单独标记。

## 目录

- `cases/001-setup`：准备、登录、模型、客户端。
- `cases/002-opencode-observation`：OpenCode 原生上报和页面观测。
- `cases/003-skill-lifecycle`：上传、生成、页面建数据集、实验生成 Trace、评测、诊断、优化、发布待验证版本、登记验证通过、显式激活与发布版复跑。
- `cases/004-trace-evaluation`：已有 Trace、无数据集评测、诊断、优化。
- `cases/005-fault-recovery`：故障注入、检测、中断回执、恢复；真实执行并如实保留失败。
- `shared/`：用例复用层，例如隔离应用启动、登录、客户端、模型连接/Mock、数据集操作、公共断言和报告汇总。单例及整轮执行都使用它，避免每个 case 重复维护相同流程。
- `control/`：自动执行控制层，例如 Webhook 验签、持久化队列、源码检出/合并、容器与生产编译、Real/Mock 分组、证据导出和 PR 评论回写。由 `serve.mjs` 接收事件、`worker.mjs` 执行任务；本机隔离整轮入口为 `run-isolated.mjs`。

`cases/` 回答“测什么”，`shared/` 回答“共同步骤怎么做”，`control/` 回答“什么时候跑、在哪跑、结果发到哪”。后二者不增加业务场景数量，它们的 `*.test.mjs` 校验测试工具本身，不是产品 UT。

当前编号连续为 001～005：原 005 数据集主路径已合入 003，原 006 故障恢复改为 005。新命令、配置和报告采用新编号，旧报告、Trace 和下文历史运行记录保留当时编号；原 006 的既有通过结果不能冒充改号后重新执行。外部可信配置需将 `cases` / `caseModes` 中的 006 改为 005；旧 005 数据集配置改用 003。历史 `core-five` 参数继续兼容原来的排除故障恢复范围（现为 001～004），完整五例请使用默认配置或 `--all`。

专用资源在相应 `cases/*/fixtures/` 下；复用的产品原始日志 `public/example/messages` 和内置 Skill 直接引用产品文件，避免副本漂移。单次临时运行的数据和证据位于 `exclude/core-e2e/<runId>/`，不提交。指定 `--lane pr|daily --state-dir /absolute/private/state` 时，使用固定的 `test_e2e_pr@example.com` 或 `test_e2e_daily@example.com` 账号，应用数据保存在各自独立目录；报告列出本轮新增 Trace，旧 Trace 保留且不计入本轮通过证据。原始日志与浏览器 trace 在受限 `private/`；不要将整个运行目录直接公开。

编号整理验证：222项测试工具检查通过，`--list`与PR/daily配置均为001～005。未重跑产品页面E2E。本机`npm test`未完整通过：观测汇总4746项、4524通过、197失败、23跳过、2取消，`evaluator-scoring-http.test.ts`触发180秒文件超时，计数仅为观测下限；未逐项归因，不能替代此前119隔离UT结果。日志位于`exclude/core-e2e/renumber-20261106/`。

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

`real` 用真实 DeepSeek 业务调用。`mock` 为五例提供本地 Chat Completions 协议夹具：原生探针、真实工具读取与写入、生成、评估、诊断及优化响应均在本地处理，真实 OpenCode、采集、数据库和页面继续执行，不使用真实模型密钥。未知请求拒绝并导致协议审计失败，不回退到真实模型。评分和语义判断是固定夹具，不证明模型质量；脚本真值、原生 Skill 绑定、输入保留、处置回执及必需阶段仍由原断言检查。UT 仍实际执行。默认执行001 Real，002/003/004/005 Mock。真实模型凭据仅在Real组需要。显式 `--mode mock|real` 覆盖所有已选例子的模式，005已包含在默认范围中。

每例独立执行，失败后继续其他场景；生成 `report.json`、`report.html`、`summary.md`，整体非通过退出 1。UT 独立记录完整性和中断，不将环境失败自动归类为产品缺陷。默认 UT 超时 30 分钟；可用 `--ut-timeout-ms` 调整。单例原始报告仍通过 `run-case.mjs` 生成，兼容旧 `tools/core-e2e/run.mjs` 命令。真实单例运行总预算 45 分钟。

当前本地工作树报告带 `dirtyWorkingTree`，不能冒充某个已提交 PR 的验证结果。按运行编号保留原始失败，不覆盖历史报告。未列入本轮执行的场景显示 NOT_RUN；阻塞、不完整和未执行均不计通过。

## 构建环境镜像

`control/Dockerfile` 预装项目锁文件依赖、Prisma Client、Playwright Chromium、Python、PowerShell 和 OpenCode 原生客户端。用于 Actions Job 时，可构建 amd64 镜像并将运行用户设为 root，以适配平台的 Job 初始化；独立隔离执行器仍使用默认 UID 1000。

```bash
docker buildx build --platform linux/amd64 \
  --file test/e2e/control/Dockerfile \
  --build-arg BASE_IMAGE=node:24-bookworm-slim \
  --build-arg DEBIAN_MIRROR=https://repo.huaweicloud.com \
  --build-arg RUNTIME_UID=0 \
  --tag agent-insight-e2e-env:local --load .
```

构建上下文通过 `control/Dockerfile.dockerignore` 限制为依赖清单及 Prisma schema。依赖锁文件或工具链变化后需重建镜像。Actions 每个非汇总 Job 按当前检出的 schema 生成 Prisma Client，schema 单独变化无需重建 Actions 环境镜像；独立 Docker 控制服务仍按其指南校验镜像中的 schema。上传 SWR 后可以在 Job 的 `container.image` 中引用固定版本或摘要；私有镜像需要另行配置 Runner 的拉取授权。

## GitCode Actions PR 门禁

入口为 [pr-e2e.yml](../../.atomgit/workflows/pr-e2e.yml)。目标为 `master` 的 PR 新建、更新和重开自动触发；普通 `pull_request` 只申请仓库和 PR 读取权限，不读取模型密钥，001～005 固定使用 Mock。真实编译、UT、客户端、浏览器和数据库仍执行。未配置 Actions 变量和密钥时，手动运行也默认五例全 Mock；需要 Real 时使用下列仓库配置。该覆盖仅作用于当前 Actions 运行，不修改 `config.json`，不改变既有本地、Webhook 或 daily 入口。

在项目设置 → Actions 密钥与变量中添加：

| 位置 | 名称 | 内容与默认行为 |
| --- | --- | --- |
| 仓库变量 | `E2E_CASE_MODES` | JSON 对象，例如 `{"001":"real","002":"mock","003":"mock","004":"mock","005":"mock"}`。只允许 `001`～`005` 和小写 `mock/real`；未填写的编号按 Mock，变量留空时五例全 Mock |
| 仓库变量 | `E2E_MODEL_BASE_URL` | 模型服务的 Base URL，例如 `https://model.example.com/v1`；不能含用户名、密码或查询参数 |
| 仓库变量 | `E2E_MODEL_NAME` | 模型服务实际支持的模型 ID |
| 仓库密钥 | `E2E_MODEL_API_KEY` | 模型 API Key，不能放入仓库变量或代码 |

存在 Real 例子时三项模型配置均须填写；Base URL 和模型名称在编译前校验，Key 只在对应 Real 用例 Job 启动时校验。五例全 Mock 不需要模型密钥。模型沿用当前测试包的 Chat Completions 协议和 `model.options`，不改变其余资源与超时配置。打开 Actions → PR Build UT E2E → Run workflow，选择包含该 workflow 的待验证分支后运行；变量更新后重新手动运行即可生效。重新运行旧的 PR 任务仍是 PR 全 Mock，不会切换为手动模型验证。

手动入口须先由默认分支上的 workflow 注册；只在 PR 分支新增文件时，平台可能显示流水线却不启用手动运行。注册后可选择包含该 workflow 的测试分支。驱动器及密钥条件兼容平台实际事件名 `Manual` 与 `workflow_dispatch`，两者均读取手动模式和模型配置。

驱动器在 Job 源码目录之外生成本轮配置快照，配置冻结后随编译制品传递，Key 只在 Real 用例 Job 内通过权限为 `0600` 的临时文件传给该用例，正常完成、测试失败或启动异常后移除；不把 Key 放进测试子进程环境变量、报告或制品。门禁独立读取执行前的配置快照，核对配置哈希、五例实际模式及完整 UT；不能把配置为 Real 却实际执行 Mock 的报告算作通过。报告包含模式、模型名称和 Base URL，不包含模型 Key。

流水线在社区 Kubernetes Job 中使用带日期版本标签的 SWR 构建环境镜像，创建独立源码快照，核对项目及 E2E 锁文件与镜像一致，复制预装依赖后，在编译、UT 和每例 Job 内分别按本次检出的 `prisma/schema.prisma` 生成 Prisma Client，再验证 Chromium 无头启动。生成过程使用隔离目录及数据库 URL，只生成代码，不执行迁移或连接业务数据库；源码指纹继续绑定本轮 schema。初始化会检查进程清理工具，当前已发布镜像缺少 `procps` 时自动补装。当前社区资源池拒绝 `image@sha256` 格式，因此使用 `node24-pw1.62.1-amd64-20261111` 标签，已发布标签须保持指向不变。此 Actions 入口要求该环境镜像保持公开并允许匿名拉取，不引用 `SWR_PULL_USERNAME` 或 `SWR_PULL_PASSWORD`；同仓及跨仓 Fork PR 均不需要镜像拉取密钥，保持普通 `pull_request` 触发。环境镜像仅预装工具链、公开依赖、依赖清单及 Prisma 结构文件，不能加入真实凭据或业务数据；PR 应用源码在 Job 中另行检出。总览显示 8 个独立 Job：生产编译 → UT → 001～005 → 汇总与门禁。生产编译只执行一次，压缩制品包含 `.next`、生成代码和清单；各测试 Job 下载后核对运行 ID、提交 SHA、源码指纹、配置哈希、压缩包哈希和 BUILD_ID，再复用编译结果。每例使用独立源码目录、账号状态与数据库，不继承其他用例数据库。编译失败时跳过 UT 和用例；UT 失败时五例仍继续，单例失败也不取消其他例。汇总始终尝试运行，缺失制品、异常退出、失败 Job、UT 不完整或必需阶段缺失均不能通过。更多 Job 会增加镜像准备、制品传输和排队开销，实际耗时以本轮运行记录为准。

本 workflow 使用正式仓 Runner 标签 `[self-hosted, openeuler, x86, cpu=8]` 和 amd64 环境镜像。测试副本使用其已获授权的 `[self-hosted, default, x86, cpu=4]` 时，需在副本中同步调整 `runs-on`；资源池共享授权不会随 Fork 自动继承。`runs-on` 数组使用固定标签，当前平台未正确展开其中的仓库条件表达式。Job 使用镜像预装的 npm 依赖、Playwright Chromium、Python 依赖和 PowerShell，补装 `procps` 时需要能访问 Debian 软件源。每轮使用新建的工作目录和 SQLite 状态，测试结束后由 Job 回收。每个测试 Job 独立复制预热 npm 缓存，并固定使用缓存对应的 npmjs registry 与离线模式，不能依赖前序 UT 写入的缓存。用例内部使用由完整运行 ID 派生的短编号，避免页面名称长度限制；公开报告仍保留完整 Actions 运行 ID。

编译、UT 与每例 Actions 阶段会给测试子进程注入独立的一次性归属标记，正常结束、异常退出及收到终止信号时执行本阶段的残留进程回收。清理先用 pidfd 固定进程身份，再通过 Linux `/proc` 精确核对标记并发送信号；不按进程名、工作目录或 `PPID=1` 全容器扫描终止，平台 Worker、控制进程和其他 Job 的进程不属于清理目标。阶段启动前检查内核与 Python 的 pidfd 支持；能力不可用、清理失败或仍有残留时阻塞阶段，不能按通过收尾。启动前以 PID 和启动时间记录既有进程的私有快照；遇到无法读取身份或环境的新进程时保留该进程并阻塞阶段，避免误杀 Worker，也避免把未能确认的残留计为零。JSON、HTML 和 Summary 记录清理状态、回收数及剩余数，不公开归属标记。UT Job 额外串行运行进程清理回归文件，避免不可读取环境的测试进程互相干扰，覆盖父进程强杀、另建进程组、退出期间再派生、取消以及无关 Worker 保留。平台直接强杀控制进程或销毁容器时，应用内 finally 无法执行，仍需要平台完成 Job 资源回收。

各阶段每 30 秒输出 `CI_PHASE_PROGRESS`，仅包含当前阶段、用例编号及最新步骤状态。容器或 Runner 被平台提前终止时，可据此定位最后执行阶段；只有这些进度输出不能认定测试通过，仍需完整报告及门禁结果。

隔离容器内的 Next 构建 worker 数及 UT 文件并发使用 `resources.cpus`（不足 1 核时按 1 个 worker）。这是测试执行预算，不依赖 Node 识别到的宿主机核数；共享 Runner 的 cgroup v1 环境可能显示宿主机全部 CPU，不能据此扩大并发。此限制不改变逐例 Real/Mock 配置，也不减少编译、UT 或 E2E 范围；非隔离本地入口保留原有并发行为。

005 的异常上报与原生中断回执可能异步到达。证据阶段最多等待 60 秒，须同时读到本轮同一会话的 thinking loop 检测及成功的原生中断回执，才继续核对原生输出、时间顺序和恢复结果。超时仅公开事件分类计数，原始载荷保存在受限目录。

失败阶段的公开报告附带应用错误分类、Prisma 错误码及编译后堆栈位置，不包含原始日志、SQL 参数或凭据。003 缺少候选验证关联时额外列出候选、输入与结果哈希的匹配情况；SQLite Worker 集成测试超时会记录最后的静态检查点。这些信息仅用于排错，不改变阶段断言或门禁结果。

Actions 当前按数据库重构安排临时设置 `E2E_SKIP_TRACE_DATASET_CONCURRENCY_UT=1`，只跳过 `trace-datasets-integration.test.ts` 中的 `real SQLite + Worker: publish, idempotency, isolation, failure, deletion and replay`；同文件的其余两项及其他 UT 继续执行。跳过计入 UT 汇总，并在 JSON、HTML 和 Markdown 报告列明用例及原因。普通本地 `npm test` 不设置该变量，仍执行此项；数据库运行时代码未作修改。恢复此项时移除 workflow 中的临时变量。

PR 自动检查从 PR 的“检查”标签进入，点击左侧流水线记录打开对应 Actions 运行；列表关联当前提交，旧提交的历史运行从 Actions 列表查找。手动运行也从 Actions 列表查看。运行详情的总览图显示 8 个 Job，点击失败节点或左侧同名 Job 可查看具体步骤和日志（查看日志需要登录）。每个 Job 完成后写入自己的 Summary，最终“汇总与门禁 summary”列出编译、UT、五例结果及 UT 失败用例；已登录用户可在“构建产物”下方查看，未登录时该区域不展示。“构建产物”中的 `pr-e2e` 是最终公开报告，包含 `summary.md`、`report.html`、`report.json`、配置快照和阶段结果；`e2e-result-*` 用于各阶段排错，`e2e-build` 用于跨 Job 复用编译结果。当前不自动回写 PR 评论。

已有 PR 重新触发时，若源分支已包含本版 workflow，可从“检查”打开运行详情，使用右上角“重新运行所有 Jobs”。[平台重跑说明](https://docs.gitcode.com/docs/help/home/org_project/pipeline/running-pipelines/rerun-failed-jobs/)规定重跑沿用原提交和原 workflow，不读取最新配置；本套多 Job 存在编译制品依赖，仅重跑失败 Job 的制品继承尚未实测，优先整轮重跑。旧 PR 尚未包含本次 CI 改动时，先将最新 `master` 同步到其源分支，再推送以触发 `pull_request.update`；普通 `pull_request` 读取源分支中的 workflow。手动 Run workflow 用于分支验证，当前未配置 `/retest` 评论触发。

失败时仍尝试上传 `report.json`、`report.html`、`summary.md` 并写入 Job Summary。`private-*`、原始浏览器记录、数据库和工作区磁盘不上传；环境准备阶段尚未生成报告时，查看失败步骤日志。平台强制超时/取消时不保证归档步骤能运行，任务仍不得视为通过。Actions Job 成功不等于已配置强制合入规则，需维护者在仓库规则中将该检查设为必需项。

本地检查：

```bash
node --test test/e2e/control/gitcode-gate.test.mjs
node --test test/e2e/shared/*.test.mjs test/e2e/cases/*/*.test.mjs test/e2e/control/*.test.mjs
```


社区的 [ComputingActionTest](https://gitcode.com/org/ComputingActionTest/repos) 是测试组织的仓库列表，不是单个测试仓库。若采用组织内 Fork 副本联调，应由社区指定或创建 Agent Insight 测试副本，并确认写入权限、Runner 资源池和镜像变量；在该副本中保留源码与测试包，提交 YAML 后新建/更新 PR 触发。只有 YAML 的空仓库无法调用本项目的相对路径脚本。测试副本调通后再迁回正式仓库，重新确认正式仓库的 Runner/变量和必需检查，Fork 标记本身不证明这些设置已经继承。

## PR Webhook

见 [本地联调与部署](control/README.md)。本地 HTTP 协议联调使用测试 PR 服务，并非真实 GitCode 事件；只有真实平台投递、精确提交执行及远端读回确认后才能宣称联调成功。

[历史独立真实验收](validation-history.md)记录 002—005 过去的完整验证；不与新运行拼接为整轮全通过。详细方案与旧编号历史记录仍在用户指定的外部方案目录。

## 2026-11-04 本地验证记录

- `migration-002-20261104-a-002`：迁移后真实 DeepSeek / OpenCode / 页面完整运行，002 的 7 个阶段通过。
- `mock-002-20261104-a-002`：本地模型协议夹具，真实客户端、采集和页面，7 个阶段通过。
- `local-pr-20261104-c`：统一入口实际执行 UT + Mock；UT 4648 项，4584 通过、41 失败、23 跳过、0 取消，完整结束；002 通过，其余五例 BLOCKED。失败仍需逐项区分环境与产品问题。
- 以上是本地工作树验证，不是已提交 PR 的正式检查；报告在仓根 `exclude/core-e2e/<runId>/report.html`。
- npm 打包预检没有包含测试目录、Playwright 或回归产物；生产镜像只核对排除规则，未重新构建生产镜像。


## 119 真实隔离验证（2026-11-04）

PR 完整轮 `119-pr-full-20261104-f` 与每日完整轮 `119-daily-full-20261104-b` 均已实际执行，001、002 通过，003—006 未完整通过；004 的后续单例补验仍失败。UT 单独统计，daily b 的单文件超时记执行不完整。最新记录和失败分类见 [验证历史](validation-history.md#119-独立容器全量验证2026-11-04)。131 项工具测试通过，不等于六例通过。固定账号、历史保留和容器退出已核验；该两轮脚本运行时尚未启用新 Webhook、远端评论或每日 timer；当前 PR 状态见下节。


## 当前 PR 常驻入口

119 已启用 `http://119.3.152.42:18880/webhook` 与自动队列，origin PR !199 已实测新建/更新自动回写。常驻服务仍沿用先前部署的 `real + core-five + UT` 配置（001–005）；该历史部署尚未切换到本地新测试包。当前本地--all选择001/002/003/004/005；接入结果以验证历史的真实 PR 记录为准。部署和状态检查见 [控制服务指南](control/README.md#119-常驻服务当前部署)。


真实 [PR !200](https://atomgit.com/gyctl/agent-insight/merge_requests/200) 最新任务 `baebd36a45d123b5ab2718b48ffaac0c`：001、002 PASS，003–005 FAIL，006 NOT_RUN；UT 4638 为中断后的观测下限（4608 通过、6 失败、24 跳过）。自动评论已读回确认，100 份允许的证据文件已导出，manifest 无超限省略，历史 Trace 保留；详细问题与基线见 [控制指南](control/README.md#五例真实-pr-验收2026-11-04)。


## 统一配置

`config.json` 是 PR 与每日测试的共同配置源。`defaults` 提供默认值，`profiles.pr`、`profiles.daily` 分别覆盖账号、模式、场景、模型、资源或超时。账号默认为原有两个 test 邮箱，数据空间仍为 pr/daily；默认001使用Real，002/003/004/005使用Mock，UT开启。当前 standalone 登录使用邮箱与产品分配的 API Key，不需要账号密码。

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

本地显式 --mode、--case、--all、--ut/--skip-ut、--key-file 等调试参数可覆盖对应配置，报告记录实际生效的脱敏快照和哈希。--all 显式选择001～005，默认配置也选择这五例；--case 005执行故障恢复，旧006编号被拒绝。切换 Mock 不会自动实现其他场景：活动场景提供协议适配；是否完整通过以对应运行报告为准，不回退到真实模型。

本轮本地验证已覆盖自定义 URL/模型名/非 sk Key 的真实原生客户端到本机 HTTP 请求、转发器的 URL 前缀和模型白名单、配置去重、账号保护、超时与慢清理。配置改造尚未部署到 119，未通过它重跑产品 UI 或付费模型业务；003 的既有未提交修正未在本轮发布。

003/004 的平台内部 Agent 与客户端使用同一模型选项、上下文/输出预算；平台 Agent 的工作区建在仓库之外，避免继承被测源码仓库的 Git/AGENTS 上下文。该设置由启动准备统一注入，报告记录实际 profile 和工作区。

切换模型时同时核对 `contextTokens` 与 `outputTokens`。部分服务把推理 Token 计入输出上限；诊断可能比普通探测需要更多输出预算。`finish=length` 表示回复被截断，仍按失败处理，应依据本轮用量调整可信模型配置后用新 runId 重跑，不能把部分回复计为完成。

测试端读取工作台会话状态时，仅对 `UND_ERR_SOCKET/ECONNRESET/EPIPE` 这类明确的连接关闭／重置重连一次，两个尝试共享原有 45 秒期限。日志记录脱敏路径、错误码及是否重连，不记录查询参数或凭据；HTTP 500、超时、取消、其他 GET 和所有写请求不自动重试，避免把产品失败隐藏在测试重跑中。

模型配置页面先等待当前账号的设置加载，再测试并保存模型及默认项；保存失败时检查请求账号归属，并在失败原因中保留脱敏后的服务端错误。活动场景的模型连接测试最多真实尝试 3 次，只重试服务端、网络、超时和限流错误，并逐次保存 `private/model-probe-attempts.json`。耗尽后标记阻塞；无效请求和未知错误直接失败。浏览器响应等待在失败清理时也会收尾，不让未处理的等待异常中断报告生成。

`resources.appHeapMiB` 同时约束隔离应用的 Node 启动进程和 Next.js 派生进程，避免开发启动脚本的固定堆设置绕过测试资源配置；它不等同于容器总内存限制。

`application.mode` 默认为 `production`：全局生产编译通过后初始化测试数据库，通过 `scripts/control-server.js` 启动生产服务，并为它与 Next 路由设置同一个独立空闲的指令分发端口。各例复用同轮 BUILD_ID，构建耗时单列在 productionBuild，不计入首例准备。编译日志位于 job/build/private-build/production-build.log，单进程本地入口位于 exclude/core-e2e/build-preflight/private/production-build.log。生产编译要求隔离容器，并校验本轮源码指纹及产物完整性。`dev` 保留用于调试，应用沿用 `scripts/develop_start.sh` 启动，统一门禁仍先做生产编译。资源配置 `resources.openFiles` 控制容器 nofile（默认1024，119配置16384）。模型Real/Mock与应用启动模式分别配置。


003/004 优化可能包含平台自验证和自动修复，测试端最多等待 15 分钟，并受整例 `caseMs` 截止约束。平台明确失败仍立即结束，不会因延长等待而视为成功；评分回落提示保留在原始证据中。

004 的步骤核验兼容正式流程的 `branches` 与 `conditionalGroups` 表达。只有实际脚本已成功输出有效非空 JSON，且正式流程明确存在互斥的错误输入分支时，该错误分支才允许列为不适用；所有核心动作仍必须覆盖，未执行分支不计通过。

004 重开实验时，先等待受保护页面完成登录恢复并显示实验内容，再执行刷新并重新断言；不以紧接 `goto` 的第二次导航代替正常刷新。快速连续刷新触发的登录恢复边界另见 Issue #359，不通过自动重新登录掩盖失败。

004 的事实核对按实际脚本 JSON 校验三个字段的脚本值与报告值；表格、列表、JSON 及标题说明均可，不以“核对：”等固定标题或标点判定通过。缺少任一字段对照、脚本值与报告值不一致、只有“已核对”声明均失败。

004 的四字段摘要 JSON 解析：允许纯 JSON 或成对 Markdown 行内代码包装；仍只允许一条摘要、一个合法 JSON 对象，四字段及真值断言不变。多条、缺失、无效 JSON、多行和不成对包装均失败。

## 五例 Mock 与 PR 计时

仓库默认逐例配置见下文；119常驻服务在显式部署前仍沿用其原可信配置。临时扩展验证应另建可信配置文件，同时清空caseModes并显式选择有效编号；有效编号为001～005；可配置cases缩小范围。不要把PR中的配置当作可信控制规则。Mock 容器使用预装离线客户端依赖、network none，不挂载模型密钥。

报告分别记录每例 startedAt/endedAt/durationMs、E2E 起止和总耗时、UT 起止和耗时。真实平台投递时间与评论时间用于计算 PR 等待及回写耗时。冷启动、依赖准备与用例执行分列；本地单例预检不能冒充 PR 触发结果。005 保留真实故障注入、重复输出、中断回执和恢复断言，mock 不掩盖 FI 生命周期缺陷。

## 逐例模式与合并场景

```json
{
  "mode": "mock",
  "cases": ["001", "002", "003", "004"],
  "caseModes": {"001": "mock", "002": "mock", "003": "mock", "004": "real", "005": "mock"}
}
```

放在defaults，或分别在profiles.pr/daily中覆盖；caseModes逐键继承，未列编号回退到mode。显式命令行--mode会清除逐例覆盖，用于整轮调试。mode的配置值仍只有real/mock，mixed是报告根据已选例子计算的结果。原005数据集的独立入口已合入003；005现为故障恢复。本例配置仅选001～004，所以配置005的模式不会启动它。

服务器隔离入口`control/run-isolated.mjs`与PR worker按模式分组：先Real组001，再Mock组002/003/004/005，整个运行持有同一执行锁，串行导出和继承同通道账号状态；pr和daily仍使用各自固定账号。每组使用独立容器和工作区，并复制同一份已校验编译产物，Mock组network none且不挂载真实模型凭据，Real组只获得短期代理凭据。UT只在首组运行一次，失败也会如实保留并继续业务验证。总截止时间在两组间共享；报告逐例标明模式，任何组缺失或历史保存失败都不能通过。每组资源、配置指纹、证据及原始报告保留在groups目录，顶层为合并结果。

本地run.mjs可按相同逐例模式调度，用于开发调试；网络和凭据隔离由服务器容器入口提供。混合模式由001检验真实模型连通性，其他用例使用本地模型协议夹具，003的Mock评分只证明业务流程与契约，不能宣称真实模型质量通过。

隔离容器默认启用应用与OpenCode的info级诊断日志，用于定位“原生任务已完成而工作台仍运行”等收尾问题；日志保存在本轮受限证据中，不改变普通用户日志设置。单次通过不代表偶发问题已经消失，失败尝试保留并独立记录。

## 当前混合模式隔离验收（2026-11-06）

`mixed-core-20261106-a`：001/002/合并003 Mock、004 Real全部通过；UT4711项，4686通过、0失败、25跳过，完整无中断。整轮约19分50秒，包含两组生产构建。005不重复执行，006暂停；证据归档在exclude/core-e2e/mixed-core-20261106。此轮为119源码快照验证，尚未部署到常驻Webhook/每日服务，也不是PR触发结果。

预验probe-c出现一次生成收尾超时，原始失败保留，原因未确认；随后通过不能作为该偶发问题已经消除的证据。完整结果与未覆盖边界以本轮coverage.md为准。

## 原005数据集资源清理与能力归属（历史编号）

003现在负责页面创建一题私有数据集、原题/独立参考答案与账号归属核对、实验生成Trace、评测、主诊断及锚点导航、优化与同题候选验证，并额外发布复跑。005旧场景、专用Python脚本和旧独立夹具测试已经删除；003所用日志真值及数据集业务哈希/归属断言分别位于shared/log-truth.mjs、shared/dataset-contract.mjs，对应负向测试保留。

原005统计“前五来源”并追加四字段摘要；003收敛为首要来源和三字段摘要，004仍验证四字段摘要。这是业务样例的收敛，不宣称003仍逐项验证旧005全部业务输出分支。原005历史报告和Trace不删除；新报告只列当前001～005五行，005代表故障恢复，不再生成数据集合并占位行。

004真实模型调用及耗时拆解见[cases/004-trace-evaluation/README.md](cases/004-trace-evaluation/README.md#真实模型调用与耗时)。

006最新单例Mock补验：fi554-006-mock-20261106-b基于upstream !554/e191afe4完整通过故障→检测→回执→原生中断→评测→页面→同客户端恢复→持久化。模型接口本地15次，外部0次；UT4664/4639通过/0失败/25跳过，完整无中断。E2E约3分25秒、含UT总约6分45秒。005清理与本轮报告见exclude/core-e2e/cleanup005-case006-20261106；首次时间顺序误报已修正，原始失败保留。该历史单例运行后，当前配置已将故障恢复加入默认PR/daily范围，现编号005。

## 生产编译与当前默认门禁

当前默认001 Real，002/003/004/005 Mock，PR与daily使用各自稳定测试账号。执行顺序：生产编译→UT一次→Real/Mock隔离分组。编译容器无网络、无模型密钥；任何编译失败直接返回FAIL，UT及所有场景NOT_RUN，报告保留错误和编译日志。环境准备或导出失败记为BLOCKED。

生产编译只执行一次，成功产物由源码内容指纹及BUILD_ID绑定，隔离分组从只读产物目录复制到各自工作区，启动前拒绝源码不一致、缺失产物和错误BUILD_ID。生产编译结果、耗时与日志位置写入JSON、HTML及PR评论。直接运行run.mjs也先编译，生产编译须处于隔离容器；推荐使用control/run-isolated.mjs。

PR评论由shared/suite.mjs模板及control/publish.mjs生成，通过AtomGit API创建并核对正文，无模型参与。模型只用于标记Real的业务测试。此配置的实现不等同于已更新119常驻服务，部署状态以最新运行记录为准。

当前配置隔离验收 `build-first-20261106-b`：生产编译2分18秒通过，UT4738项/4714通过/0失败/24跳过且完整；001 Real、002/004/006 Mock通过，003 Mock生成收尾超时，整轮FAIL。不得把该结果视为五例稳定全通过。287份证据无省略，历史保留、无OOM；未更新常驻PR/daily服务。

启动边界复核：单一模型分组修正执行器租约传递，直接run.mjs修正显式项目/运行ID/环境及日志路径。222项测试包检查通过，并在119以build-first-single-20261106-c实际完成生产编译和002 Mock单例；UT按单例补验配置未执行，总报告PARTIAL，不能替代五例整轮。该单例补验当时未修复B轮的003生成收尾失败。

最新整轮 `fix003-full-20261106-a`：003收尾竞态修复后，生产编译、完整UT以及001 Real、002/003/004/006 Mock均通过；003完整闭环约53秒，整轮约9分50秒。UT4740项/4716通过/0失败/24跳过，394份证据无省略。原失败B轮保留；本次为119隔离验证，常驻服务未切换。
