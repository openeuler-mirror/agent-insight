# 验收协议

本页定义 Skill 自身的记录和检查输出，不替代[平台架构与代码导航](benchmark-protocol.md)或目标项目的现行协议。结构化格式见 `assets/schemas/`；模板必须按实际源码、环境和授权修改。配置中的检查命令会执行程序，冻结前先阅读命令及包装脚本。

## 计划与输入冻结

从 `assets/templates/acceptance-plan.json` 复制到包外。空 `argv` 会得到 `blocked`，不是通过。填写：

- `benchmarkKey`：目标 `benchmarks/<key>` 的实际 key。
- `scope`：填写按[目标协议选样要求](benchmark-protocol.md#7-验收与维护)确定的声明范围与 Case ID，选取依据及范围调整记录在验证矩阵中；真实试验用 `mode: live`，合成夹具用 `fixture`。Fixture 无论检查结果如何均不能得到接入 `accepted`。
- `source`：官方入口、固定代码/数据 revision、split、许可证与全量数。Case ID 是试验子集，不能伪装成全量认证。
- `baselineInputs`：影响官方评分的调用脚本、规则、参数、冻结提交与数据锁。不要把验收说明、动态事实索引或无关协议材料纳入官方基线。目录先生成按文件排序的摘要清单，再把清单及验证清单的检查程序纳入输入；大型数据由 source 检查重新核对锁中的摘要。
- `implementationInputs`：接入包以外参与实现或验收的文件，例如执行配置、协议校验器、检查包装脚本、专项测试。接入包目录整体和包内验收程序/Schema 自动计算摘要；包外相关依赖无论是否被 Git 跟踪都须显式列入。Git HEAD 和全仓差异仅作背景记录，不用于判定验收失效。
- `analysisInputs`：引用已有接入方案，可由一份文件覆盖分析、能力查询、样本选择和设计依据；Agent 审阅内容，程序核对文件。直接引用文件，不另做阶段登记。
- `baseline`：独立官方评分命令。由 `stage: evaluation` 的真实服务结果直接对照基线。函数级排错交给接入专项测试，不设第二个评分入口。所有评分使用同一批冻结提交，不重新调用 Agent 生成回答。包装器只转换官方输出格式，不能替代权威算法，也不能复用待验证 Adapter 生成预期。
- `tolerances`：指标名到绝对容差，默认 `{}` 表示完全一致。Judge/随机过程先在冻结输入中记录模型、Prompt、参数和重复次数，再约定容差；不能失败后直接放宽。
- `checks`：保留来源、可见性、真实运行、回归四类必需记录，Catalog 由 CLI 自动增加。记录类别不等于脚本数量；可复用同一驱动的不同操作、已有测试与夹具。默认模板以 `interface-contracts` 承担必要专项，以 `stage: delivery` 的 `regression` 承担交付前默认回归；如一条命令已有两者有效覆盖，可合并为前置检查并移除重复 delivery 项。

模板提供官方输入、相关实现和一份方案的示例引用；按实际目标补齐或替换。当前源码的关键合同与必要适配直接记录在方案；影响实现的协议源码、校验桥接和部署指纹列入 implementationInputs。CLI 只校验本次显式输入的摘要，不判断协议语义或自动寻找遗漏依赖，也不要求匹配 Skill 发布时的版本。相关输入变化后重新审阅，按影响更新计划或重测；只有影响官方评分的输入变化才需重新执行官方基线。不能只更新报告中的 HEAD。

命令为 `argv` 数组，无隐式 shell。使用 `{repo}`、`{run}`、`{attempt}`、`{output}`、`{skill}` 替换路径；`{attempt}` 是该检查独有目录，`{output}` 为其中的 `result.json`。每条命令显式设置 `cwd` 和 `timeoutSeconds`；可配置 `maxLogBytes`（默认 8 MiB）与 `terminationGraceSeconds`（默认 5 秒）。命令日志超限只截断保存并在报告标记，不终止任务；正式评测证据须另行完整保存，不能用截断日志替代。超时/取消仍失败或阻塞，强杀不证明清理成功；凭据从已有环境或引用读取，不放进参数、计划或报告。

不依赖评分基线的数据解析、Schema 和准备工作可先推进；verify 要求已有有效官方基线。`freeze` 执行独立官方评分并保存基线、计划、文件摘要和日志。官方失败、缺少覆盖或输入在执行期间变化时不能激活基线。实现接入后执行 `verify`，所有新尝试另建目录；重新冻结须 `--reason`，保留旧基线与旧结果。若仅验收计划变化而官方命令、来源、Case 范围、输入及原始证据均未变，freeze 保存新计划并引用旧官方结果，不再次执行评分。

## 检查依赖与输入有效性

验证顺序、覆盖与例外统一见 [live-validation.md](live-validation.md)。本页只定义程序需要的声明与校验：`interface-contracts` 使用 `stage: interfaces`，`evaluation-service` 使用 `stage: evaluation`，`runtime` 对应完整用户链路。测试合并不改变逻辑记录的依赖要求。

计划通过 `dependsOn` 声明逻辑记录的依赖，只引用前面的检查或 workflow/catalog。接口和评分阶段保留原有校验要求：评分阶段必须返回结构化 check 并依赖接口检查，runtime 必须直接或间接依赖所有必需非 runtime、非 delivery 检查。`stage: delivery` 只允许必需 regression，须位于其依赖的 runtime 后；它不阻塞该次真实运行，但仍是 accepted 的必需条件。合并命令或共用驱动不能省略证据、归属或版本校验。

verify 在同一次 attempt 内执行每个检查一次，按传递依赖核对结果；依赖 fail/blocked/skipped 或不存在时，下游记为 blocked 并列出原因，不启动其命令。进入依赖检查前还核对前置证据摘要、基线及实现输入快照，变化时阻止后续。父检查真实失败仍保留 fail，不被下游 blocked 覆盖。CLI 不发现接口，也不认证部署版本；将部署指纹锁/实际配置引用纳入 implementationInputs，实际操作前核对服务版本及环境与该锁一致，锁文件变化会使旧前置结果失效。

验证矩阵随计划冻结，实际结果另存；驱动、专项测试、适用配置与脱敏部署指纹加入 implementationInputs，凭据不入快照。首例执行与完整链路可引用同一真实证据，逐 Case 关联与摘要检查由 verify 完成。

## 评分输出

官方和接入包装器均把以下格式写入 `{output}`，原生结果另外保留在 `{attempt}`。`kind` 为样本用途标签，不强制类别或数量。Agent 应按官方行为和修改风险选择有区分力的样本，在方案中说明正常判分及关键失败风险如何覆盖，不为凑类别制造无意义场景；`id` 是提交样本 ID，`caseId` 是数据集 Case ID。

```json
{
  "schemaVersion": "benchmark-onboarding-scores/v1",
  "benchmarkKey": "example",
  "cases": [
    {
      "id": "case-1-correct",
      "caseId": "case-1",
      "kind": "correct",
      "submissionDigest": "sha256:替换为真实提交的64位十六进制摘要",
      "status": "completed",
      "metrics": { "passed": true, "score": 1 }
    }
  ],
  "aggregate": { "accuracy": 1 }
}
```

上例只展示评分结构，覆盖是否充分由 Agent 根据官方行为审阅。`kind` 可使用 correct、incorrect 等有明确含义的标签；`status` 为 `completed / invalid / infrastructure_error`。指标值仅允许有限数值和布尔值。两边样本 ID 集合、Case、kind、提交摘要、状态及指标集合必须一致；逐项比较；只有官方存在且本次声明的聚合口径适用时才提供 aggregate，两边是否提供及其内容必须一致。不得制造聚合值或把未知数量补零。任何基础设施错误都会使评分检查失败，不能因为两边都报错就算一致。

## 检查输出

`resultMode: check` 的程序读取实际数据或调用现有入口，将结果写到 `{output}`：

```json
{
  "schemaVersion": "benchmark-onboarding-check/v1",
  "status": "pass",
  "evidence": ["raw-query.json"],
  "facts": {}
}
```

`pass` 必须引用本次检查目录内的独立普通文件，不能只引用 `result.json`。其余状态为 `fail / blocked / skipped`，须有 `reason`。执行退出非零、结构不合法或缺少输出都不能通过。仅 `regression` 可使用 `resultMode: exit-code`，直接复用现有测试命令，以退出码和原始日志为证据。

各类检查的真实内容由接入实现提供，不能用 `echo pass` 或手写 JSON 代替：

| 类别 | 必需内容 |
|---|---|
| source | 验证数据锁、许可证/访问条件，并按 [数据集安装验收](live-validation.md#数据集安装验收必检) 核对实际文件内容、持久化记录及二者一致性、重复导入和失败恢复；明确安装范围、真实/模拟证据及替代存储依据 |
| visibility | 构造正负样例，验证隐藏字段不进入 Agent 输入、目录投影及公开产物，并按任务要求观察实际网络/文件策略 |
| runtime | 驱动先核对本地检查与固定提交评分前置，再从环境检查/准备及创建入口运行 L3；观察实际数据安装、Agent 执行、提交上传、Evaluator 判定、Evidence 与清理；适用时加入重评、反馈、超时/取消/恢复检查 |
| regression | 新增接入专项、协议回归及目标仓库要求的测试；已有失败单独记录，必需回归未过不能写完整验收通过 |

stage: evaluation 的检查必须包含 `facts.mode: live`、`facts.submissionSource: frozen` 和 `facts.serviceEvidence` 中的 request/terminal/result 三个文件引用，均属于顶层 evidence；顶层 evidenceDigests 核对所有文件摘要。它们分别保存实际评分请求、业务终态和结果回传/查询记录，不能只存健康响应或声称已回传的布尔值。用冻结提交启动评分验证，不调用 Agent；该次服务调用必须使用与官方基线相同的冻结提交（覆盖同一批样本），驱动将实际响应转换为 scores/v1 文件，用 `facts.scoresFile` 引用，并将该文件列入 evidence 和 evidenceDigests。例如：

```json
{
  "mode": "live",
  "submissionSource": "frozen",
  "scoresFile": "service-scores.json",
  "serviceEvidence": {"request": "request.json", "terminal": "terminal.json", "result": "response.json"}
}
```

verify 自动从本次激活基线取得 official scoresFile，并在此分段内复用 compareScores 比较样本 ID、Case ID、kind、提交摘要、状态、逐项指标和聚合指标，沿用计划 tolerances；比较摘要记录为 scoreComparison。缺少标准结果文件、缺样本、基础设施错误、摘要/状态/指标不同均不能放行，后续 runtime 由依赖检查阻止。不能用接入评分函数或官方预期值填充服务结果；驱动只转换实际返回内容，保留原响应及转换依据供审阅。

此处只读取已保存的服务结果和冻结基线，不重新调用服务、官方 Harness 或模型。评分服务对照属于 evaluation-service，不新增独立检查项。函数验证由已有专项测试承担，不另设独立评分阶段，不重复提交相同评分任务。一次服务验证只覆盖了部分样本时，不能把它冒充完整对照；应在冻结计划时统一本次小样本范围，不临时补跑模型或放宽覆盖要求。仅缺少环境或服务入口时返回 blocked；确实无法拆分的 Benchmark 应先与用户对齐耦合验证设计，不静默省略该必需门禁。

运行检查还必须返回 `facts.mode: live`、与计划一致的 `facts.caseIds`，以及 `facts.steps` 中的 `dataset / execution / submission / evaluation / evidence / cleanup`。每一步包含 `status: pass`、非空 `reference`（实际数据集、任务、Artifact、评测或资源检查的记录引用），以及非空 `evidence` 数组，引用顶层 evidence 中已声明的相对文件名。运行检查还必须提供：

- 顶层 `evidenceDigests`：每个 evidence 文件名到 `sha256:<64位十六进制>` 的映射。摘要基于保存的文件字节计算；在采集、复用和交付边界核对，不为采证重新启动任务。
- `facts.cases`：与计划 Case 集合一致、无重复的逐 Case 记录。每项包括 `requestId`（完整验收关联的任务登记）、`caseId`、`runId`、`evaluationId`、`evaluatedRunId`、`submissionFile`、`submissionDigest`、`evaluatedSubmissionDigest`、`executionEvidence`、`evaluationEvidence`。
- `evaluatedRunId` 来自实际评分记录关联，须等于本 Case 的 runId；两项 submissionDigest 须相等并与 submissionFile 的实际字节摘要一致。执行和评分证据字段同样引用顶层 evidence 中的文件。评分端没有直接提供摘要时，驱动从实际评分输入读取字节计算，不能直接复制待比较值。

例如逐 Case 记录的形状为（占位值不能直接通过校验）：

```json
{
  "requestId": "recorded-request-id", "caseId": "case-1", "runId": "actual-run-id", "evaluationId": "actual-evaluation-id",
  "evaluatedRunId": "actual-run-id", "submissionFile": "case-1/submission.bin",
  "submissionDigest": "sha256:实际提交摘要", "evaluatedSubmissionDigest": "sha256:实际评分输入摘要",
  "executionEvidence": "case-1/execution.json", "evaluationEvidence": "case-1/evaluation.json"
}
```

将实际调用已有的响应和提交保存为文件，避免保存整份 trace 或反复请求相同数据。原始查询如何映射到上述字段和跨阶段断言，由目标专用驱动实现并接受审阅。公共程序核对文件、摘要和声明字段的对应关系，不解析任意目标 API，也不能证明原始响应没有伪造。结果须满足当前合同，不自动迁移旧格式。业务未通过的 Case 仍可以完成正确的执行评测链路；不得把业务分数当成基础设施检查状态。

脚本校验结构、退出码、范围和摘要，不对调用者伪造的原始证据提供真实性认证。宿主必须审阅检查实现并使用真实查询；机器摘要不能证明 `live` 声明真实。也不要从通用 Doctor 返回健康就推定本次 Benchmark 已通过。

## 评测产物核对

`stage: evaluation` 和 `category: runtime` 的通过结果必须提供 `facts.artifactChecks`。这组字段合入已有检查，不新增评分、模型调用或独立阶段。检查程序读取已保存文件进行本地比较，并将核对摘要写入 `artifactComparison`。

| 字段 | 含义与约束 |
|---|---|
| `caseId`、`evaluationId`、`submissionDigest` | 本次实际 Case、评测轮次和提交；runtime 与 facts.cases 对应，评分服务与 scoresFile 每条样本对应 |
| `sampleId` | 仅评分服务使用，对应 scoresFile 的样本 id；本次声明的冻结提交均需核对，不只挑选成功记录 |
| `outputMode` | `files` 为官方实际文件，`return` 为官方接口返回记录（含布尔值/标量），`none` 为该状态按官方合同没有输出 |
| `sourceEvidence` | 本次官方调用、返回或输出目录实际清单的原始记录引用；不能由平台上传清单反推 |
| `platformEvidence` | 本次实际平台附件列表/查询响应引用，覆盖声明的全部附件，不只挑一条成功记录 |
| `mappingEvidence` | 对应版本官方文档确定的证据范围、程序核实或补充、差异处置与排除项，以及实际生产者、官方写出位置/返回函数、到附件的变换与来源/展示名称、原始响应到核对字段的映射依据；复用确认单、既有专项结果或分析材料的受控副本 |
| `outputs` | 本次官方原始输出集合，逐项 `{name, source, file}`；files 仅收 official-file，return 仅收 official-return；name 为原文件名及相对目录，file 为保存在检查目录的原始字节 |
| `attachments` | 实际平台附件集合，逐项 `{artifactId, name, source, file, sha256, sizeBytes}`；file 保存实际下载字节，摘要/大小来自实际平台记录 |
| `absenceReason` | outputMode 为 none 时必填，结合本次原始调用记录及 mappingEvidence 说明确无输出；不能用 none 隐藏遗失文件 |

所有引用及每项 `file` 必须列入顶层 evidence 和 evidenceDigests，路径位于当前检查目录。可以复用同一份原始查询或映射材料，不要求每个字段另造文件。官方文件名称、数量和结构不设固定值；`source` 分别使用 `official-file`、`official-return`、`runtime-output`、`platform`，与目标真实响应的来源映射一致。

程序核对：

- 记录完整覆盖当前评分样本或 runtime Case，提交与评测身份一致；缺项或混用旧轮次不能通过。
- 原始输出逐件在平台存在，原名、相对目录、来源和字节一致；源文件与下载文件不得引用同一个物理文件冒充对照。
- 平台附件 ID/名称无重复，返回摘要与大小匹配实际下载；必要的额外 runtime-output/platform 附件可保留，但不计入官方原始输出覆盖；不得将接入层报告、来源元数据或平台日志冒充原件。
- 官方文件/返回记录不能为空；确无输出仅在 none 有实现依据、本次记录且无伪造原生附件时适用。
- 漏文件、改名/压平目录、摘要代替原件、来源不明、未声明的附件或摘要/大小不符阻止通过。必要的敏感信息处理或名称限制先与目标协议对齐；不能通过更新 file 或声明 none 把变化伪装为原件一致，未解决时保留 fail/blocked。

`facts.artifactPresentation` 另记 `{status: "pass", evidence: "实际页面验证记录"}` 或 `{status: "not_checked", reason: "未验证范围或用户决定"}`。页面证据也列入顶层 evidence；只下载文件不能声明页面通过。多 Case 驱动保留逐例页面记录，任一未覆盖时汇总为 not_checked。页面是否为声明范围的必需条件仍遵从目标协议和用户约定，不能用本字段放宽必需项。最终 Markdown 检查表直接显示已核对产物数量、评测数量和页面是否验证，避免只有 JSON 中有范围说明。

这些机器检查只证明所保存材料之间的对应关系，不能认证原始查询真实性、判断所有官方报告语义，或证明序列化没有在采集前丢弃字段。宿主仍须沿 mappingEvidence 审阅官方调用 → 实际写出/返回 → 上传附件的生产者和变换，以及对应专项测试。返回值只忠实序列化，不增补字段；来源说明置于映射材料。没有官方报告就明确说明，不补造报告；必要的接入层附件在来源和展示名称上均不得标成官方产物；平台采集清单、kind 标签和哈希不能替代该判断。旧历史记录可查看；缺少上述材料的记录不能直接用于新版通过结论，应先复查有效原件补证，缺条件保留待办。

## 结论的证据范围

最终声明须与验证矩阵中的实际用户入口及必需步骤对应，说明各步骤由静态检查、隔离测试、固定提交评分或真实运行覆盖。仅后续 API 成功时列明未覆盖的准备与交互步骤，不能宣称完整用户路径通过。官方数据量、安装范围、执行支持范围和本次小样本范围分别说明；失败、缺证据和清理未知不能写为通过。

公共 CLI 核对结构、摘要和显式依赖；宿主仍须审阅真实查询与断言、核对覆盖范围。原始证据不足时补查或保留待办，不以健康响应、文件存在或自报 pass 替代业务依据。

## 结果与恢复

任务可由已有入口或宿主分步完成，不强制编写驱动；使用原有事件记录，在 submit 前保存稳定请求及 :cleanup 待办，恢复先 query、完成或异常后核对清理。明确拒绝且合同证明未创建任务时，可凭原始响应登记 failed 与无需清理，规则见 usage.md；网络未知仍保留阻塞。完整 verify 对每个 runtime Case 的 requestId 关联任务 runId 和 :cleanup，要求两者 completed；清理失败/未知继续阻止新任务。具体回调合同见 usage.md，不强制目标平台采用固定 REST 路径。

`accepted` 要求声明范围内全部必需检查通过、真实模式、证据与输入未变化、无状态未知或在途平台任务。输入/证据失效等限制仍得到 `needs_action`；无这些限制时，必需检查的确定性 `fail` 得到 `failed`，即使其下游因此 blocked；仅有 `blocked` 或必需 `skipped` 得到 `needs_action`；显式取消得到 `cancelled`。程序退出码与报告共同使用：`0` 为验收通过（或 freeze 基线成功），`1` 为检查失败，`2` 为缺条件或调用错误，`130` 为取消。

`report` 会重新检查相关实现、验收程序、基线和证据摘要；不得直接读取旧报告宣称新代码通过。输入清单由 Agent 按实际依赖审阅，不能为复用旧结果删掉已知依赖。无关文档或模板的改动不自动使官方基线失效；实际采用的生成代码及相关配置变化仍须按影响重测。修复阶段先按影响运行专项检查，通过后再发起正式 verify。正式验收仍核对全部必需前置，不直接把旧通过状态写入新 attempt。运行记录支持再次调用续接，不会自行唤醒宿主。检查命令可使用 usage.md 的 recordedOperation 复查原始操作；每次仍生成当前断言和证据，不缓存旧检查结论。输入范围由驱动声明并审阅，原始记录只证明所引用的旧操作，当前部署身份和任务/清理状态必须重新核对。
