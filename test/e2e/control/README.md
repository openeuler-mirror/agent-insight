# PR Webhook 本地联调与部署

当前目标仓库为 Git 配置实际解析的 origin：`gyctl/agent-insight`。119 已部署常驻接收器与真实执行器，PR !200 完成真实平台投递、UT + 001–005、自动评论及正文读回；006 按用户要求 NOT_RUN。001、002 通过，003–005 失败，UT 有单文件超时中断。接入成功不代表业务全通过；既有每日回归保持，尚未设置强制合入门禁。早期 !198、!199 为 probe 历史。

## 本地验证

```bash
node --test test/e2e/control/*.test.mjs
node test/e2e/run.mjs --all --mode mock --ut
```

集成测试真实启动本机 HTTP 接收端、SQLite 队列、子进程、微型 UT 和模拟的 PR HTTP 服务，验证签名到结果回写的完整协议。它不创建真实 PR，不向真实仓库发送评论。协议集成测试的微型项目不含业务驱动，六例为 BLOCKED；业务测试包现已提供六例的本地模型协议夹具，实际完成度以运行报告为准。

## 接收端

先用安全随机源生成至少 32 字符的签名密钥，保存于仓库外权限 600 的文件；将仓库凭证注入 `ATOMGIT_TOKEN`，不要放进命令行或仓库。

```bash
node test/e2e/control/serve.mjs \
  --repository gyctl/agent-insight \
  --state-dir /absolute/private/e2e-control \
  --secret-file /absolute/private/webhook-secret.txt \
  --host 127.0.0.1 --port 8787
```

接收端只有 `GET /healthz`、`POST /webhook` 两个控制服务路由，不是 Agent Insight 产品 API。只接受原始请求体的 `X-GitCode-Signature-256: sha256=...` HMAC-SHA256 签名；最大请求体 1 MiB。只允许配置的目标仓库与开放 PR，并用官方 API 再核对当前源提交。无匹配/过期事件忽略，错误签名拒绝，平台验证不可用返回 503 供平台重试。

按目标仓库、PR、源/目标 SHA 与模式去重；同 PR 新任务将旧的排队/运行任务标记 SUPERSEDED。关闭或更新 PR 的状态在开始执行与回写前再次查询。接收端不执行 PR 代码。

## 隔离执行器

先从可信工作树构建专用测试镜像；不要混入生产镜像。镜像安装 root 锁文件依赖及 Playwright，执行时验证锁文件一致。锁文件或 Prisma schema 变动需维护者重建镜像后再执行。构建沿用仓库 .npmrc 的 legacy-peer-deps 策略，不更改依赖版本。

```bash
docker build -f test/e2e/control/Dockerfile -t agent-insight-e2e-runner:local .
docker image inspect agent-insight-e2e-runner:local --format '{{.Id}}'
node test/e2e/control/worker.mjs \
  --state-dir /absolute/private/e2e-control \
  --image sha256:<上一步输出的完整镜像ID> \
  --key-file /absolute/private/deepseek.key
```

一次处理一个任务，串行运行。执行器通过公开 HTTPS Git URL 读取准确的源/目标 SHA，构建临时合并提交；不能合并则记录执行阻塞。PR 代码只在容器运行，不在宿主机运行。容器以普通用户执行，无仓库凭证、真实模型密钥或 Docker socket；工作容器只能访问本轮私有网络的模型转发器。转发器单独持有 DeepSeek 密钥，只接受限额内的模型请求。源码、控制脚本、依赖卷和本链路上一轮数据只读挂载；工作区使用独立 8 GiB ext4 临时磁盘，当前应用状态用 1 GiB tmpfs，Prisma 生成目录单独可写。控制端需 Linux root 与 loop mount 工具；至少留 12 GiB 空间才启动，导出失败保留受限磁盘，最多保留两份后阻塞新任务。应用 Node 堆在隔离容器内限制为 2560 MiB，仍通过标准开发启动脚本启动；容器限制为 2 CPU、7 GiB 内存、512 PID，使用 Docker init 回收子进程，全局串行执行以控制共享服务器负载。启动前要求宿主 MemAvailable 至少 8 GiB，否则报告阻塞，不挤占现有服务。控制端单独持有 API 凭证。Docker 关闭重复日志存储，控制端运行日志限制 64 MiB，截断后仍排空输出。

镜像尚未构建或执行条件不满足时，保留 BLOCKED/ERROR，不回退到宿主机执行。手动 PR 与每日入口默认真实六例；常驻 PR 接收器使用 `--mode real --profile core-five`，本轮只执行 001–005 与 UT，006 明确未执行。Mock 代码和显式入口保留。受限容器使用镜像预装的浏览器、Python wheel、ripgrep 与原生客户端依赖。FI 所需的 OpenCode plugin 1.18.4/1.14.39 使用构建时准备的离线 npm 缓存；RAS catalog 使用镜像内 Pydantic v2 虚拟环境。测试时不开放依赖下载网络。

当前 worker 使用互斥锁避免多个进程同时处理；异常退出后先确认锁文件中的 PID 已停止，再移除本服务自己的 `worker.lock` 后启动。遗留 RUNNING 任务记 INTERRUPTED，不自动伪造完成或重复运行。过期的运行中任务会保留原证据并禁止回写；当前不会立即强杀旧任务，最多消耗其剩余超时预算。

## 回写与报告

默认只生成本地报告。实际启用 `--publish` 时，将结果评论回该任务对应的 PR；用任务标记查重，再读回评论正文确认。每个源/目标版本一条评论。开始发布前再次确认 PR 仍开放且两个 SHA 未变；脏工作树报告不能冒充正式 PR 结果。

```bash
node test/e2e/control/worker.mjs \
  --state-dir /absolute/private/e2e-control \
  --image sha256:<完整镜像ID> --key-file /absolute/private/deepseek.key --publish \
  --report-base-url https://reports.example.invalid/agent-insight
```

报告地址是将来部署的示例，不能直接使用。只对外发布代码生成的 `report.html`、`report.json`、`summary.md`，不要公开状态目录、Git 工作树或 `private-worker.log`。API 凭证只从环境读入，curl 认证头通过权限 600 的临时配置传递，完成后清理。

PR 原生检查项、报告静态托管、邮件备用通知尚未接入；当前实现的是接收、单任务执行及 PR 评论链路。启用业务强制门禁前，需要六场景真实验收、镜像运行验证、专用 PR 及公网入口联调。probe 模式可独立验收控制流程；现阶段尚未启用强制合入门禁。

## 失败复现

容器退出前通过有大小上限的输出通道导出截图、Playwright trace、运行日志及单例报告，控制端保存在任务目录的 `private-evidence/`。每文件上限 8 MiB、总量 32 MiB、最多 1000 项；跳过符号链接、数据库和账号配置。超限文件列入 `manifest.json` 的 omitted，不能声称证据完整。该目录只供开发者受限访问，不能作为公开报告站点根目录。


- UT：仍执行 `npm test`，给 Node 测试进程注入 300 秒的单文件进程硬期限（包括断言结束后残留句柄），整体 30 分钟；单文件超时退出 124，Node 继续汇总其他文件并将该文件计为失败。查看 report 中完整性及计数，日志在受限 npm-test.log；缺汇总、超时不算 PASS。
- 单个业务场景：按相同源码、依赖锁和场景编号用新 runId 执行，保留原始失败。
- Webhook：查看投递 HTTP 状态与队列任务；签名失败 401、仓库/旧版本忽略 200、首次入队 202、重复事件 200。
- 回写失败：任务报告保留，delivery 文件不存在或未确认不能当作已通知；不会自动发送邮件。

官方协议参考：[Webhook](https://docs.gitcode.com/docs/help/home/org_project/webhook/web-hook/)、[PR 事件](https://docs.gitcode.com/en/docs/help/home/org_project/webhook/webhook-stepup/merge-request-events/)、[PR 评论](https://docs.gitcode.com/docs/apis/post-api-v-5-repos-owner-repo-pulls-number-comments/)。

## 历史本机 ARM64 容器验证边界（2026-11-04）

本地 107 项工具测试通过。专用 Linux ARM64 镜像已完成项目依赖和 Chromium 安装，但 OpenCode 2.1.4 安装校验失败；拆开安装与二进制校验的诊断构建在安装阶段等待 8 分钟仍无结果后中断。原因尚未确认，不能认定是产品缺陷。后续构建已加 300 秒安装上限。证据在 `exclude/core-e2e/image-diagnostic-20261104/`。

这是迁移到 119 x86_64 之前的本机记录，不代表当前服务器运行结果。该次本机容器未完成业务验收。证据导出与可写 Prisma 依赖修复目前只有本地工具测试覆盖。本机 002 的真实和 Mock 验证见上级指南；它们不代替容器验证。

## 真实模型与固定账号

接收端默认 `--mode real`；执行器额外传入 `--key-file /absolute/private/deepseek.key`。密钥不进入 PR 工作容器。模型转发器只允许 DeepSeek chat completions，单轮最多 500 次、有效期 3 小时；只记录计数，不记录密钥或对话。报告生成完全由代码完成。

无需 Webhook 的服务器验证命令：

```bash
node test/e2e/control/run-isolated.mjs \
  --source /absolute/trusted/source --image agent-insight-e2e-runner:local \
  --state-dir /absolute/private/control --key-file /absolute/private/deepseek.key \
  --run-id server-pr-unique-id --lane pr
```

完整运行默认执行六例和 UT。`--lane daily` 使用另一固定账号；`--case 001 --skip-ut` 仅用于环境预检，报告不能算完整通过。手动源码快照报告不冒充真实 PR 检查。

- PR：`test_e2e_pr@example.com`；每日：`test_e2e_daily@example.com`。每条链路有独立 SQLite 与 Trace 文件，产品正常用户数据不参与测试。
- 控制目录 `lane-data/<lane>/current.json` 指向上一轮状态；每次任务在临时副本执行。报告和身份校验后导出状态，并核对旧 Trace 内容未改变，才更新指针。每轮 `jobs/<runId>/private-state/` 快照保留，可回溯恢复。排除客户端/Python 运行时和 `.opencode-runtime` 下可离线重装的 node_modules，保留原生会话与业务数据。模型配置在新一轮重新选择有效的本轮配置。
- 状态传输最多 128 MiB、20000 文件、单文件 64 MiB；超限阻塞并保留原状态，不能自动删除历史。该上限需要随实际保留周期评估。
- 006 以本轮 ExperimentCase.fiRunId 绑定 FI 运行，并校验账号、客户端；复用账号时不会选取历史运行或要求全账号只有一条 FI。
- 固定账号不是公共线上账号。当前容器退出后应用停止；历史数据可在后续隔离启动中登录查看，报告列出本轮 Trace ID。尚未部署常驻的历史查询 UI。
- 外部静态站只发布汇总报告。`private-state/`、`private-evidence/` 与模型配置不得公开。


## 只验证 Webhook 与 PR 回写的 probe 模式

```bash
node test/e2e/control/serve.mjs --mode probe \
  --repository gyctl/agent-insight --state-dir /absolute/private/probe-control \
  --secret-file /absolute/private/webhook-secret.txt --host 127.0.0.1 --port 8787
node test/e2e/control/worker.mjs --state-dir /absolute/private/probe-control --probe-only --publish
```

接收器与 worker 均需从本机环境读取 ATOMGIT_TOKEN；不要把凭证放进命令行。worker 每次处理一条任务，可由受控调度器持续调用；本次联调使用临时后台 watcher 自动触发。probe 有独立队列身份，固定 Node 子进程只收到 PATH，不执行 PR 源码、UT、六个业务用例或模型调用，不需要测试镜像和模型密钥。--probe-only 遇到业务任务会拒绝执行。

探针报告只表示固定子进程结果。启用 --publish 后，评论发布和正文读回一致才生成 delivery.json；不能以本地 PASS 报告代替发布成功。真实 AtomGit 评论创建响应的 id 是讨论 ID，note_id 才是评论 ID，发布器通过 PR 评论列表核对 note_id 和完整正文。已有相同任务标记但正文不同会报错，避免误认成功。

投递审计只保留时间、方法、路径、事件类型、投递 ID 和 HTTP 状态；字段截断，单文件最多 1 MiB，保留一份轮转，总量约 2 MiB，不保存签名或凭证。真实 PR 更新事件支持 HMAC；平台 hooks/tests 在本次发送了不含有效签名的 Push Hook，被 401 拒绝，该测试事件不作为真实 PR 链路的验收证据。

origin [PR !198](https://atomgit.com/gyctl/agent-insight/merge_requests/198) 已收到真实 Merge Request Hook（202），自动完成入队、固定子进程、评论及正文读回。签名重放验证去重、旧 SHA 忽略和错误签名拒绝。完整记录见 [验证历史](../validation-history.md)。本次公网地址由临时 HTTPS 隧道提供，经 SSH 使用 119 的出站连接；119 直接入站 HTTP 探测超时。正式部署仍需常驻且可达的 HTTPS 入口和后台调度，不能依赖开发者电脑或临时域名。


## 119 常驻服务（当前部署）

- Webhook：`http://119.3.152.42:18880/webhook`，origin 仓已启用 PR 事件与 HMAC 签名。
- 健康检查：`http://119.3.152.42:18880/healthz`。
- 接收器：`agent-insight-pr-receiver.service`；后台队列：`agent-insight-pr-worker.service`，两者均 active/enabled，独立于开发者电脑。
- 程序、运行时和数据：`/mnt/sdc/gyc/agent-insight-pr-control/{source,runtime,state}`，由专用无登录用户 agent-insight-ci 执行；原 Node20 与其他应用服务不变。receiver 上限 256 MiB/25% CPU，worker 上限 1 GiB/50% CPU（可信 root 控制进程；接收器仍无特权）。

```bash
systemctl status agent-insight-pr-receiver.service agent-insight-pr-worker.service
journalctl -u agent-insight-pr-worker.service -n 30 --no-pager
curl http://127.0.0.1:18880/healthz
```

常驻 PR 升级配置为 `real/core-five`，001–005 和 UT 真实执行，006 NOT_RUN。接收器仍以无登录用户运行，可信控制 worker 需 root 执行 Docker 和 loop mount；PR 代码只在无特权容器中执行，模型密钥只进入转发器。原有 probe 队列和发布重试仍兼容。它串行处理队列，评论发布失败会退避重试发布，不重新执行已完成探针。进程停止后恢复死锁，拒绝替换活进程锁；从队列恢复缺失或截断报告，原子保存补偿确认记录。执行前状态查询失败以合法 FAIL/未执行报告回显，执行后查询失败保留实际执行结果，发布前再核对当前 PR SHA。

openEuler 当前 systemd-creds 未编译加密支持；凭据采用 Node AES-256-GCM 密封，根用户目录 0700、密文及解封密钥 0400。systemd LoadCredential 仅在启动时提供运行时材料，可信启动器把 PAT 解封到进程环境，不保存明文 PAT 到仓库或服务单元。HMAC 的临时明文仅在 /run 运行目录使用并移除；固定探针子进程仍只收到 PATH，不接触凭据。

实际 [PR !199](https://atomgit.com/gyctl/agent-insight/merge_requests/199) 的新建和重启后提交更新均由 119 完成，运行节点在评论中明确标注。本轮保留 Hook 和服务持续运行；没有重启共享服务器，只验证服务级重启和 enabled 配置。常驻入口目前使用用户已放行的 18880/HTTP 签名验证，后续可接 HTTPS 反向代理。上述 !199 记录仅证明 probe 链路；真实五例和 UT 的结果另见验证历史，不能因 probe 通过而算业务通过。


## 五例真实 PR 验收（2026-11-04）

[PR !200](https://atomgit.com/gyctl/agent-insight/merge_requests/200) 的源 `e3eb4ffcd50410911f9ebdbc0773d4df2de008b4` 向专用基线 `codex/e2e-validation-base-20261104` 合并，实际测试提交 `922e43a12bf8642d96cd8eeef64d82c3cf0b8c92`，工作树干净。任务 `baebd36a45d123b5ab2718b48ffaac0c` 完成，119 自动发布并读回评论 198303201。001、002 通过；003 静态评估界面等待超时，004 创建 Skill 数据库超时，005 基线实验详情 HTTP 500（服务日志 P1008/P2028）；后续未执行阶段不计通过，006 NOT_RUN。

UT 观测下限 4638：4608 通过、6 失败、24 跳过、0 取消；trace-datasets-integration.test.ts 在 300 秒期限被中断，不能称完整套件结束。DeepSeek 转发 51 次、完成 48、失败 3；报告由代码生成。100 份证据导出，无省略；无 OOM，内存达到限制并发生回收，数据库超时仍需区分代码并发与资源影响。固定账号历史校验通过，测试容器、私有网络、工作盘和锁均清理，服务与 Hook 保持启用。

本轮修复服务 PATH 缺少 /usr/sbin、源码哈希收集依赖未提交文件，以及停止清理宽限时间；154 项工具测试通过。可信调度器给 worker 90 秒清理，systemd KillMode=mixed、TimeoutStopSec=120s，避免重复 SIGTERM。原失败报告保留。结果评论已接通，正式分支还需包含统一入口且锁文件/schema 与镜像一致；本轮只验证专用基线，不表示旧 origin/master 的任意 PR 已能执行全部业务。


## 统一配置的控制端契约（本地实现，尚未部署）

接收器与 worker/daemon 必须读取同一份维护者审核、部署的 `test/e2e/config.json`，或通过相同 `--config /absolute/trusted/config.json` 指定文件。读取的是可信控制目录的配置，不读取 PR 工作树中的配置来决定门禁、密钥、网络或资源。仅修改 PR 内 config.json 不会改变服务器正在使用的规则。

控制端的旧 --mode、--profile core-five 只作兼容一致性检查；与配置文件不一致时接收器在调用 API/入队之前报错。切换 Mock 或调整场景请更新共享可信配置，并移除冲突的旧启动参数，不能只给 receiver 覆盖模式。任务身份包含配置哈希、场景及 UT 开关，worker 在执行前验证与本机可信文件一致；排队期间换了配置的旧任务会阻塞，保留原结果，不偷偷使用新参数执行。

PR 与每日同样读取各自 profile。指定 --key-file 仍可提供外部凭据文件；推荐在 model.key 配置环境或文件引用。真实 Key 只由可信控制端解析并只读挂载到独立 relay，PR 容器仅接收每轮临时令牌；relay 只接受配置指定的模型，并按配置限制请求数量、单请求和整轮寿命。Base URL/name/key、原生客户端及内部模型配置保持一致，支持兼容 Chat Completions 的自定义端点。报告记录原始可信配置，而不是把容器内部 relay URL 当作用户配置。

Mock 仍保留独立原生采集和页面验证；配置化 Mock 也会复制、导出本通道状态并校验账号及历史 Trace，避免切模式后丢失数据。无需真实模型密钥，工作容器无外网。配置不能豁免缺失的 Mock 适配或缺失的必需阶段；UT 被维护者配置禁用时明确 NOT_RUN，不算 UT 通过。

本轮只完成本地改造与测试，119 服务、现有 Hook、每日 timer 和 PR !200 均未更新。未来部署需要同步可信 runtime/shared 脚本及配置，确认环境中的凭据引用和 profile 一致，再单独执行服务器与真实 PR 验收。

## 临时 Mock PR 验证

使用独立维护者配置启用 mock 和六例，接收器与 worker 必须使用相同配置哈希，使用独立状态和固定 mock 测试账号。保留正式 real 配置，临时切换后恢复原入口；不更改每日服务。真实 PR 的 head/base SHA、Webhook 投递、队列任务和远端评论必须一致。测试镜像与依赖缓存预先存在时，计时不包含镜像构建；排队、checkout/准备、UT、六例以及回写各自统计。
