# 使用与命令

## 加载完整包

使用宿主现有 Skill 机制加载整个 `benchmark-onboarding/` 目录，保留 `scripts/`、`references/`、`assets/`、`tests/`。脚本只依赖 Node.js 20+、Git 和目标项目本来需要的程序；不安装 npm 包、不创建工作流配置。不要仅复制 `SKILL.md`。

文件与命令执行权限由宿主提供。包内测试覆盖脚本机制，不代表 OpenCode/Codex 已完成真实 Benchmark 验收；只有实际完成某宿主、版本和任务的试验后，才能声明该兼容范围。终止进程组的路径按 POSIX 实现；Windows 原生进程树清理未验证，优先在 Linux/WSL 环境执行长任务。

用户请求示例：

```text
请使用 benchmark-onboarding。
Agent Insight 项目地址：<代码仓库 URL 或本地目录>
Benchmark 来源：<官方仓库或数据集地址>
按官方规则接入并验收；沿用项目约束，不能确定的关键条件请明确列出。
```

## 创建运行

以下变量设为本次实际路径或地址；不覆盖 `HOME`、`CODEX_HOME` 等宿主变量。

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" init \
  --project "$PROJECT_ADDRESS" --repo "$TARGET_REPO" --source "$BENCHMARK_SOURCE" \
  --run-root "$RUN_ROOT"
```

`--repo` 是已定位的工作副本根目录，`--project` 是用户提供的地址。默认运行根目录是 `~/.agent-insight/data/benchmark-onboarding/`；平台有自定义数据位置时查询后用 `--run-root` 指定。可用 `--id` 指定小写字母/数字/连字符的 runId，重复初始化相同 ID 与目标只回读记录，不重置预算。

新任务默认 `budget: {}`，不设置整个接入任务的总次数或总时长上限，正常开发、冻结和验收不需要申请“增加预算”。只有用户明确指定总限制时，才传入 `--max-attempts`（1～100）或 `--max-seconds`（1～604800），两项可独立设置；缺省字段表示没有该项限制。

计数和耗时仍写入报告作为统计：总尝试数包括基线冻结记录（含复用）和完整验收轮次，不按每条检查累加；它不是模型调用数或费用。显式设置总时长时，从初始化开始计墙钟时间，等待用户和退出宿主也计入，不因恢复而归零。费用、模型调用次数、日历截止时间由能计量这些指标的执行端或专用驱动落实，不能用上述计数近似后宣称已执行这些限制。

每条命令始终受计划中的 `timeoutSeconds` 约束；如设置了总时长，再取单次超时与剩余总时长的较小值。命令日志默认保存最多 8 MiB，可用 maxLogBytes 调整；超出只标记 logTruncated 并停止保存后续日志，不终止命令。正式证据须独立完整保存。超时/取消后默认留 5 秒退出宽限，可用 terminationGraceSeconds 调整；强杀后仍需查询清理状态。CLI 不自动重试，生成的驱动须按接口幂等合同设置有限重试和轮询期限；同类失败达到上限或持续无进展时先诊断，关键条件拿不准时与用户交流。

## 保存分析并冻结基线

沿 [架构与代码导航](benchmark-protocol.md) 阅读目标项目当前相关源码、校验器及测试，将关键合同、实际使用的源码位置和必要适配写入已有接入方案。路径移动时检索符号；不与 Skill 发布时的 commit 或文件摘要比较，不另建协议差异核对单。

影响实现的目标协议和校验代码列入 implementationInputs，影响官方评分的输入才列入 baselineInputs。保留本次工作副本版本、官方来源版本和实际输入摘要，供验收追溯。输入变化后按影响复查；只有官方评分输入改变才重跑官方评分。计划调整使用后面的 --reason 流程，输入不变时自动引用已有官方结果。

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" freeze --run "$RUN_DIR" --plan "$PLAN_FILE"
```

将已有接入方案路径列入 plan.analysisInputs，程序核对引用文件，Agent 审阅内容。按 [acceptance.md](acceptance.md) 配置命令；verify 须在有效官方基线冻结后执行。

`freeze` 成功只表示官方基线可用，不表示接入通过。更新基线或验收计划时显式给出原因：

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" freeze --run "$RUN_DIR" --plan "$PLAN_FILE" --reason "$CHANGE_REASON"
```

## 实现、验收与报告

默认计划保留独立的来源、可见性、评分和 runtime 记录，但可引用已有测试、CLI 或同次分步操作的证据；`interface-contracts` 承担必要专项，默认回归可由 runtime 后的 `stage: delivery` 承担；已有一次有效命令同时覆盖两者时合并执行，移除重复项。开发和修复阶段先用专项命令验证受影响项，准备就绪后再正式 verify；本 CLI 不自动跨 attempt 复用通过状态。

验收顺序与覆盖按 [live-validation.md](live-validation.md) 执行；L2 执行随首例 L3 采证。测试矩阵保存到 `$RUN_DIR/validation-matrix.md` 后随基线冻结，结果另存。模板提供必需的 `interface-contracts`、`evaluation-service` 和 `runtime` 检查，分别填已有接口测试、真实评分入口及真实链路检查/结果适配命令；外层超时覆盖内部工作及预留清理。CLI 按 dependsOn 核对前置结果、证据与当前输入，驱动继续核对真实部署及内部业务步骤。CLI 不自动发现目标 API 或轮询平台，也不推导未声明的依赖。

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" verify --run "$RUN_DIR"
node "$SKILL_ROOT/scripts/onboard.cjs" report --run "$RUN_DIR"
```

`verify` 调用目标仓库 `scripts/benchmark/generate-catalog.cjs` 的 `loadPackageForOnboarding` 校验实际接入包，不生成 Catalog 文件。该入口要求可执行接入声明环境准备模块；仅导入已有提交且显式声明 `executor.supported: false` 的接入豁免。普通 `loadPackage` 保留历史包构建兼容，不能替代新接入校验。目标版本缺少严格入口时，按其规范核对协议差异，可在 plan.catalog 配置同 command 结构的等价桥接，调用该版本严格校验并向 {output} 写入 {status: "pass", key, digest}；桥接及实际校验依赖列入 implementationInputs，说明等价依据，不要求目标项目为 Skill 改导出名；不能静默退回兼容加载后报告通过。具体入口与字段以当前源码为准，必要适配直接记录在接入方案。

需要更新 Catalog 供平台运行时，由宿主按目标仓库现行命令执行；此动作不由只读 Catalog 检查隐式完成。Doctor/Smoke 和平台接口也由冻结计划中的包装程序按目标版本调用，CLI 不假设部署地址或凭据。

每次尝试写入 `attempts/<编号>/`；官方调用保存在 `baselines/<编号>/`。命令日志、原生输出及声明的独立证据会记录文件摘要。最终报告为 `reports/report.json` 和 `reports/report.md`，包含范围、全部检查、预算和历史尝试引用。保护运行目录中的隐藏测试和原始证据，发布前只导出脱敏摘要；不要把整个运行目录放进 Skill 包或 Git。

检查结果和实现快照须满足当前合同；不自动迁移旧格式或改写历史记录。

## 复用已有验收结果

优先直接调用已有测试或 CLI；也可由宿主按正常部署 API 分步执行并保存证据、任务和清理登记。无需先生成完整驱动或向项目添加公共测试入口。

已有入口能输出 check 时直接使用；否则只在运行目录补必要的纯结果转换，不提供额外驱动模板或执行循环。独立原始证据应保存/复制到本次 attempt，保留原身份、版本和摘要；路径相对 attempt，不得引用 result.json 自身。相关适配代码加入 implementationInputs，verify 继续核对实际提交、评分、证据、版本及任务/清理登记，不继承旧 pass。同一 Case 不为不同层级重复执行。

开发时复用接入专项测试检查转换和断言，必要时直接调用 checks.cjs 的 inspectCheck 核对已有结果，不额外建立预校验 CLI 或新的必需步骤。该函数只读所引用的材料；完整 verify/report 负责当前版本、依赖和任务登记，最终结论不能仅凭本地断言。

## 中断、平台任务与预算

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" resume --run "$RUN_DIR"
```

`status` 与 `resume` 都只读，返回当前检查结论、记录阶段、预算、在途任务和摘要失效原因；不会自动执行模型、重提交平台任务或跳过失败阶段。阶段记录不是自动调度器。宿主恢复后先查询上次命令进程、平台任务与资源，再决定下一步。

在创建外部平台任务前先保存稳定请求 ID：

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" job --run "$RUN_DIR" --request-id "$REQUEST_ID" --state unknown
```

收到返回后保存同一个请求对应的平台 ID；终态需保存查询结果文件：

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" job --run "$RUN_DIR" --request-id "$REQUEST_ID" --platform-id "$PLATFORM_JOB_ID" --state running
node "$SKILL_ROOT/scripts/onboard.cjs" job --run "$RUN_DIR" --request-id "$REQUEST_ID" --platform-id "$PLATFORM_JOB_ID" --state completed --evidence "$JOB_QUERY_FILE"
```

状态还可为 `failed`、`cancelled`。请求结果未知且平台不提供可核对的幂等标识时，保留 `unknown` 并求助，不直接重发。

验收命令内部创建平台任务时，必须先成功执行包内记录程序，再提交请求：

```bash
node "$SKILL_ROOT/scripts/record-job.cjs" --request-id "$REQUEST_ID" --state unknown
# 通过目标平台已发现的接口提交，并使用同一请求标识；成功后记录返回 ID。
node "$SKILL_ROOT/scripts/record-job.cjs" --request-id "$REQUEST_ID" --platform-id "$PLATFORM_JOB_ID" --state running
node "$SKILL_ROOT/scripts/record-job.cjs" --request-id "$REQUEST_ID" --platform-id "$PLATFORM_JOB_ID" --state completed --evidence "$JOB_QUERY_FILE"
```

验收进程自动设置 `BENCHMARK_ONBOARDING_JOB_JOURNAL`，记录程序向当前命令的 `platform-jobs/` 写入独立事件与查询证据，不修改持锁的 `run.json`。同一包装程序按顺序调用；记录失败就停止，不继续提交。报告、续接及下一次验收会读回这些事件，未知任务会阻止重跑。即使主进程未回写就退出，仍能恢复请求标识；宿主查询后用 `onboard.cjs job` 补记终态，已导入的旧事件不会覆盖它。不要在验收子进程里递归调用持仓库锁的主 CLI。未按此协议记录的平台调用无法由公共脚本自动发现。

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" stop --run "$RUN_DIR" --status needs_action --reason "$BLOCK_REASON"
node "$SKILL_ROOT/scripts/onboard.cjs" stop --run "$RUN_DIR" --status cancelled --reason "$CANCEL_REASON"
```

`stop` 只改变接入记录，不会代替平台取消任务或回收容器；仍需通过现有平台生命周期处理并记录结果。停止原因会出现在报告和续接结果中；旧的通过结果不能覆盖新发现的阻塞条件，完成新的冻结或验收调用后才重新计算结论。同一工作副本的 CLI 写操作有进程锁，另有活动 runId 防止混写。异常退出留下 `.lock` 时先核对锁记录的主机和 PID，再处理；不要仅因等待时间长就移除锁。

仅在用户明确指定或调整总限制时，才使用以下命令；它不是常规接入步骤：

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" budget --run "$RUN_DIR" --max-attempts 8 --max-seconds 7200 --reason "$AUTHORIZED_BUDGET_CHANGE"
```

解除指定限制使用 `unlimited`，未传入的另一项保持原值：

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" budget --run "$RUN_DIR" \
  --max-attempts unlimited --max-seconds unlimited --reason "$AUTHORIZED_BUDGET_CHANGE"
```

该命令保留旧预算、新预算与原因，既有尝试数和开始时间不重置，至少传入一项限制。旧版 run.json 的数值上限继续生效，不推断其来自旧默认值还是用户指定值；用户决定解除后再执行上述命令，不直接改历史记录。验收程序或 Schema 变化会要求用新程序复查，纯说明改动不自动失效；不为补格式重复执行 Agent。已取消运行不续跑，另建任务并明确继承的参考资料。

## 驱动中的任务包装

已有平台操作需脚本包装时，可 import scripts/tracked-job.cjs；runtime 和独立评分检查均可使用，不要求生成专用驱动。它是本地函数，不是后台工作流。trackedJob 参数为 run、caseId、operation、inputDigest、submit/query/cleanup、可选 mapState 及下述期限；journal 默认由 runCommand 注入。inputDigest 使用 C.snapshotDigest(C.codeSnapshot(...))，相关部署版本锁列入 implementationInputs。

- submit({requestId, caseId, signal})：按目标实际幂等合同提交，返回 `{platformId}`。wrapper 在调用前已将稳定 requestId、绑定输入及 `requestId:cleanup` 待办写入现有日志；结果未知时保留 unknown，不自动重试提交。
- query({requestId, platformId, caseId, signal})：只做一次查询并返回；恢复时先调用（unknown 可仅凭 requestId 查询）。返回 `{platformId, state, evidence, ...业务结果}`，evidence 是实际查询的 JSON 文件路径。完成过的同一任务也只查询，不重提；已确认的清理不重复执行。
- cleanup({requestId, platformId, caseId, observed, signal})：在已知平台 ID 时由 finally 调用，必要时取消/等待并核对资源，返回 `{platformId, state, taskEvidence, evidence}`；state 须为可映射的实际任务终态，taskEvidence 为任务查询文件，evidence 为清理查询文件。可复用已有终态响应，不为采证重复请求。wrapper 分别登记任务终态和 :cleanup 完成。

state 可返回平台原始状态，由 mapState(rawState) 转换成包内 unknown/running/completed/failed/cancelled；原始状态同时保存在 rawState 和查询证据。没有 mapState 时只接受同名内部状态；不识别的状态立即报适配缺失并保留 unknown，不能默认当作 running。映射由 Agent 查目标项目状态定义实现，不能在 Skill 中穷举平台状态。trackedJob 使用 waitForJob 在每次查询后立即映射并登记，仅 running 会继续轮询；unknown 和未适配状态停止，失败/取消终态立即返回并进入清理。query 不得内部循环，否则无法观察中间状态；旧查询回调须迁移为单次请求。业务低分不等于基础设施 failed。手动 job/record-job 可用 --raw-state 保留原值。

期限参数（毫秒）：timeoutMs 默认 120000 为查询阶段上限，requestTimeoutMs 默认 10000 为单次提交/查询上限，pollIntervalMs 默认 1000，cleanupTimeoutMs 默认 10000。按目标接口调整，外层命令期限须覆盖提交、查询及清理。回调把 signal 传给 fetch 等底层请求。包装器到期中止等待并发出取消信号；忽略信号的回调不能被强制停止，须保留未知状态并核对实际任务，不能因本地超时推断远端不存在。异常退出未运行 finally 时，预先保存的 unknown/清理待办用于恢复；清理失败仍为 unknown，不能以“清理失败任务已结束”为由允许新提交。平台无法按 requestId 找回结果未知的提交时，保留阻塞并与用户处理，不猜测不存在。

requestId 由 runId、caseId、operation 和 inputDigest 计算。同一次输入恢复不会重新 submit；输入变化且旧任务/清理尚未确认时，包装器拒绝新任务。初始事件证据保存上述绑定，修复代码后需先用旧绑定查询/清理，再以新输入创建新请求，不能把旧结果冒充新版本验收。已失败/取消且完成清理的任务不会自动重跑；确需新执行时使用新的 operation（如显式重试序号），记录重试原因和旧 requestId 引用。不能借更换 operation 绕过未确认的任务/清理。`:cleanup` 是复用实际平台 ID 的资源检查记录，不是第二个真实平台任务，不新增服务任务或模型执行。

runtime 的 facts.cases 必须包含 wrapper 返回的 requestId（手动使用原 job/record-job 协议也可以，但须同样记录任务与 :cleanup）。完整 verify 关联 runId，要求两项登记均 completed 且证据完好；仅有 runtime 自报成功、jobs 为空不能通过。不要在子进程递归调用持锁的 onboard.cjs。

### 独立评分查询与确定性拒绝

独立评分检查无需套 runtime 模板；已有脚本需要等待时，直接复用同一等待函数，query 只查询一次，mapState 依据目标项目定义，不写“其余都算 running”：

```js
const { waitForJob } = require(path.join(skill, 'scripts/tracked-job.cjs'))
const terminal = await waitForJob({
  query: ({ signal }) => queryEvaluationOnce({ evaluationId, signal }),
  mapState: mapEvaluationState,
  timeoutMs: 120000, requestTimeoutMs: 10000, pollIntervalMs: 1000,
  onObservation: saveObservedResponse,
})
if (terminal.state !== 'completed') throw new Error(`评分终态：${terminal.rawState}`)
```

queryEvaluationOnce、mapEvaluationState 和 saveObservedResponse 是已有接口的薄适配点；最后一个只同步保存本地响应，不执行额外网络等待。waitForJob 不提交任务或清理资源，独立调用者仍须保留 finally 清理及任务登记。未适配状态立即失败，查询一直不返回也受单次请求期限约束。

submit 只有在实际接口合同保证“本次请求被拒绝且未创建任务/资源”时，才能返回 `{ rejected: true, evidence }`。evidence 为 JSON 路径，内容包含：

```json
{
  "requestId": "本次稳定请求标识",
  "taskCreated": false,
  "contract": "所核对的接口拒绝分支及其无副作用保证",
  "response": { "status": 400, "body": { "code": "实际业务拒绝码" } }
}
```

包装器记录任务 failed、`:cleanup` completed，二者 `notCreated: true` 且无平台 ID；不会调用 query/cleanup，也不会原样重提。相同操作再次调用只报告已拒绝；修复原因并记录依据后，用新的 operation 显式重试。拒绝登记后若中断，下次恢复会补齐无需清理登记。已有平台 ID 时禁止声明未创建任务。

不能仅凭 HTTP 4xx/5xx、代理错误、网络异常或超时声明 rejected；例如重复请求冲突可能对应已有任务。证据缺失、身份不符或结果未知时仍保留 unknown，先查原任务。确定性拒绝返回结构；其余异常正常抛出，不通过异常名称推测是否创建了任务。

宿主分步操作或修复旧 unknown 时，可使用原有 `onboard.cjs job` / `record-job.cjs`，为任务 `--state failed` 及对应 `:cleanup --state completed` 分别附加 `--not-created true --evidence <拒绝证据路径>`，不传 platform-id。必须满足同一证据合同，不能伪造平台 ID 解除阻塞。

## 原始操作记录与复查

需要跨 attempt 修复转换或断言时，驱动使用 `scripts/recorded-operation.cjs` 的 `recordedOperation`；普通一次成功的流程无需额外建立记录层。它不自动跳过 verify 的检查，也不认证平台证据真实性。

```javascript
const { recordedOperation, copyRecordedEvidence } = require(`${skill}/scripts/recorded-operation.cjs`)
const record = await recordedOperation({
  directory: `${run}/recorded/execution-case-1`,
  identity: { project: repo, benchmarkKey, operation: 'execution', caseId },
  inputs: executionInputFiles,
  execute: async () => {
    // 调用已有 trackedJob/目标入口并完成原始采集；不在这里转换报告。
    const observed = await executeAndCollect()
    return { value: observed.rawResponse, files: observed.rawFiles }
  },
  validate: async ({ value, files, reused }) => {
    // 每次核对实际部署/输入绑定、任务终态与清理；不重新提交任务。
    await assertCurrentIdentityAndCleanup(value, files, reused)
    return true
  },
})
const copied = copyRecordedEvidence(record, attempt)
// 使用当前转换逻辑从 record.value/copy 后的原始文件生成本次 check。
// copied.evidence 含清单及原始文件，须加入顶层 evidence 并计算摘要；
// copied.files 与原 rawFiles 顺序相同，业务引用改指向本次相对路径。
```

上述回调是目标接口适配点，不是已实现的函数。需要时从 scripts/recorded-operation.cjs 导入 recordedOperation 和 copyRecordedEvidence；纯结果转换不执行或重放平台任务。执行与评分应分别记录，修评分时可复用真实提交而不复用旧评分。

- `inputs` 为非空绝对文件路径清单：覆盖该操作的 Case/数据、指令、实际执行或评分代码及依赖、配置、冻结提交和脱敏部署版本锁。目录使用按序文件摘要清单并核对实际内容。操作源代码应与纯转换代码分开；无法证明某改动仅影响转换时，保守地把该文件纳入操作输入。不能为使旧记录通过而缩减清单或更新旧摘要。`identity` 至少含 project、benchmarkKey、operation，并加入 Case、任务语义、模型等必要身份；不要放凭据。
- 首次调用先保存 pending，再执行一次并复制原始文件；原始采集成功后保存 completed，随后调用 validate。completed 仅表示采集结束，不等于任务成功或验收通过。因此断言/转换修复后可重新核对同一原始结果。
- 已有 completed 记录先核对身份、输入、原始结果和文件摘要，再运行当前 validate；不调用 execute。validate 必须核对真实终态、清理和当前部署锁，返回 true 才能使用。执行失败或过期结果不能靠转换改成成功。
- pending、身份变化、输入变化、文件损坏或核对不通过均报错，不自动重新执行。pending 时用已有任务包装查询/清理并恢复原始采集；保留旧记录，在任务已收敛且有明确重试原因后才为新的操作创建记录目录。不得改 pending 为 completed 或用新目录绕过未知任务。
- 收集函数、评分函数等业务代码变化时，对应输入会拒绝复用；新评分记录可使用已核对的原提交。已有 operation 的输入在执行或验证期间变化也会阻止返回。
- 每次 verify 继续校验当前相关实现快照、官方基线、所有必需检查和任务登记。复用清单与原始文件复制进本次证据目录，但保留旧任务/版本身份；不复制旧 pass 或冒充一次新执行。生成/校验仍应遵从 inspectCheck。

## 交付回归顺序

默认计划将接口专项放在评分与 runtime 之前，将默认回归声明为 `stage: delivery` 并依赖 runtime。delivery 是必需 regression：真实链路失败时阻止下游，收尾回归失败时阻止 accepted。项目要求前置或公共改动影响执行基础时，去掉 delivery 标记并放回前置依赖；已有一次测试涵盖专项和默认回归时保留一次有效执行，删除重复的收尾检查。

## 包维护

```bash
bash "$SKILL_ROOT/scripts/test.sh"
```

包内测试验证工具机制，不代表真实 Benchmark 已验收。仅支持当前结果合同及带 verifierDigest 的实现快照；不保留旧摘要算法、驱动模板或迁移分支。历史文件可留作审计，缺字段的记录不能直接用于通过结论。重新验收前先核对在途任务及清理；格式不兼容不能成为重复提交的理由。

评分服务及 runtime 的 check 须包含 [评测产物核对](acceptance.md#评测产物核对)字段。有效原件按 recordedOperation 的输入、版本和归属规则复查，不为补报告重复执行 Agent；页面覆盖单独记录。
