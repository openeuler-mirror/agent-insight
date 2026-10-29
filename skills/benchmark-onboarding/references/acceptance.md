# 验收协议

本页定义 Skill 自身的记录和检查输出，不替代[平台接入协议快照](benchmark-protocol.md)或目标项目的现行协议。结构化格式见 `assets/schemas/`；模板必须按实际源码、环境和授权修改。配置中的检查命令会执行程序，冻结前先阅读命令及包装脚本。

## 计划与输入冻结

从 `assets/templates/acceptance-plan.json` 复制到包外。空 `argv` 会得到 `blocked`，不是通过。填写：

- `benchmarkKey`：目标 `benchmarks/<key>` 的实际 key。
- `scope`：本次声明范围、Case ID；真实试验用 `mode: live`，合成夹具用 `fixture`。Fixture 无论检查结果如何均不能得到接入 `accepted`。
- `source`：官方入口、固定代码/数据 revision、split、许可证与全量数。Case ID 是试验子集，不能伪装成全量认证。
- `baselineInputs`：官方调用脚本、评分规则、冻结提交与数据锁、所读协议等不可变输入文件。目录先生成按文件排序的摘要清单，再把清单及验证清单的检查程序纳入输入；大型数据由 source 检查重新核对锁中的摘要。
- `implementationInputs`：接入包以外参与实现或验收的文件，例如执行配置、协议校验器、检查包装脚本、专项测试。接入包目录整体、Git HEAD、已跟踪文件差异和 Skill 内容已自动计算摘要；未跟踪的包外依赖必须显式列入。
- `baseline` / `candidate`：官方与接入评分命令；都接收同一批冻结提交，不重新运行被测 Agent 生成回答来做评分对照。包装器只转换官方输出格式，不能替代权威算法，也不能复用待验证 Adapter 生成预期。
- `tolerances`：指标名到绝对容差，默认 `{}` 表示完全一致。Judge/随机过程先在冻结输入中记录模型、Prompt、参数和重复次数，再约定容差；不能失败后直接放宽。
- `checks`：来源、可见性、真实运行、回归四类，每类至少一个必需检查。目录 Catalog 与评分对照由 CLI 自动增加。

模板已列入包内协议说明、来源清单、包外 `protocol-check.json` / `protocol-review.json` 及核心目标协议路径；按实际目标补齐或替换路径。协议核对记录不能保留 `unreviewed`，差异需逐项说明；`source` 检查应重新核对实际目标协议摘要和处置记录。CLI 只校验显式输入的摘要，不会替宿主判断协议语义或自动找到遗漏的传递依赖。目标协议文件变化后重新审阅并冻结，不能只更新报告中的 HEAD。

命令为 `argv` 数组，无隐式 shell。使用 `{repo}`、`{run}`、`{attempt}`、`{output}`、`{skill}` 替换路径；`{attempt}` 是该检查独有目录，`{output}` 为其中的 `result.json`。每条命令显式设置 `cwd` 和 `timeoutSeconds`；凭据从已有环境或引用读取，不放进参数、计划或报告。

`freeze` 执行官方评分并保存基线、计划、文件摘要和日志。官方失败、缺少覆盖或输入在执行期间变化时不能激活基线。实现接入后执行 `verify`，所有新尝试另建目录；重新冻结须 `--reason`，保留旧基线与旧结果。

## 分层验证与计划

分层操作见 [live-validation.md](live-validation.md)。先生成并执行 L1 接口测试，再验证 L2 执行/评分段，最后从实际用户入口运行 L3。模板中的 `interface-contracts` 为回归检查类别，`runtime` 由本次生成的驱动程序执行前置核对与真实链路；模板的空命令会阻塞。通用 CLI 不根据命令排序推导业务依赖，驱动程序必须在前置失败时停止后续，保留各层结果、真实证据和未执行原因。

将包外 `validation-matrix.md` 与本指引纳入冻结输入，实际结果独立写入各次检查目录；生成的驱动程序、配置和专项测试加入实现输入。L1 夹具不算真实运行；L2 不能独立时事先记录语义理由与耦合验证方案。单纯缺环境、能力或权限不是语义不适用，必需项不能改为可选后宣称通过。

## 评分输出

官方和接入包装器均把以下格式写入 `{output}`，原生结果另外保留在 `{attempt}`。四种 `kind` 均须覆盖，可以在同一 Case 上构造不同提交；`id` 是提交样本 ID，`caseId` 是数据集 Case ID。

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

上例只展示一条记录，不构成完整可通过样例。`kind` 为 `correct / incorrect / invalid / boundary`；`status` 为 `completed / invalid / infrastructure_error`。指标值仅允许有限数值和布尔值。两边样本 ID 集合、Case、kind、提交摘要、状态及指标集合必须一致；逐项和聚合分别比较。任何基础设施错误都会使评分检查失败，不能因为两边都报错就算一致。

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
| runtime | 驱动先核对依赖的 L1/L2，再从创建/启动入口运行 L3；观察实际数据安装、Agent 执行、提交上传、Evaluator 判定、Evidence 与清理；适用时加入重评、反馈、超时/取消/恢复检查 |
| regression | 新增接入专项、协议回归及目标仓库要求的测试；已有失败单独记录，必需回归未过不能写完整验收通过 |

运行检查还必须返回 `facts.mode: live`、与计划一致的 `facts.caseIds`，以及 `facts.steps` 中的 `dataset / execution / submission / evaluation / evidence / cleanup`。每一步包含 `status: pass` 和非空 `reference`（实际数据集、任务、Artifact、评测或资源检查的记录引用）。把对应平台查询结果保存到 `evidence` 文件。业务未通过的 Case 仍可以完成正确的执行评测链路；不得把业务分数当成基础设施检查状态。

脚本校验结构、退出码、范围和摘要，不对调用者伪造的原始证据提供真实性认证。宿主必须审阅检查实现并使用真实查询；机器摘要不能证明 `live` 声明真实。也不要从通用 Doctor 返回健康就推定本次 Benchmark 已通过。

## 结果与恢复

`accepted` 要求声明范围内全部必需检查通过、真实模式、证据与输入未变化、无状态未知或在途平台任务。任何 `blocked` 或必需 `skipped` 得到 `needs_action`；确定性检查失败得到 `failed`；显式取消得到 `cancelled`。程序退出码与报告共同使用：`0` 为验收通过（或 freeze 基线成功），`1` 为检查失败，`2` 为缺条件或调用错误，`130` 为取消。

`report` 会重新检查当前代码、Skill、基线和证据摘要；不得直接读取旧报告宣称新代码通过。源数据、协议、官方配置或模板变化后更新分析并重新冻结；修改实现后重新验收。运行记录支持再次调用续接，不会自行唤醒宿主。
