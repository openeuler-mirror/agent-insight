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
  --run-root "$RUN_ROOT" --max-attempts 5 --max-seconds 3600
```

`--repo` 是已定位的工作副本根目录，`--project` 是用户提供的地址。默认运行根目录是 `~/.agent-insight/data/benchmark-onboarding/`；平台有自定义数据位置时查询后用 `--run-root` 指定。可用 `--id` 指定小写字母/数字/连字符的 runId，重复初始化相同 ID 与目标只回读记录，不重置预算。

总尝试数包括官方基线调用和完整验收轮次，不按每条检查累加。总耗时从初始化开始计墙钟时间，退出宿主后也不归零。运行中的每条命令受单项及剩余总耗时约束，日志最多 8 MiB；超时、日志超限与非零退出分别留证据。

## 保存分析并冻结基线

初始化后先阅读 [协议快照](benchmark-protocol.md)，把与目标版本的核对结果存到运行目录：

```bash
node "$SKILL_ROOT/scripts/protocol-check.cjs" "$TARGET_REPO" > "$RUN_DIR/protocol-check.json"
```

该命令只读 Git 身份和文件，不执行目标模块，不拉代码，也不查询部署。退出码 `0` / `match` 表示来源清单覆盖的文件一致；`2` / `review_required` 表示内容变化或路径缺失，需读目标文件、检索新路径并说明差异；`1` / `error` 表示输入、包内完整性或 Git 查询错误。不要在返回 `2` 后自动刷新快照或当作接入失败，先完成语义核对。HEAD 不同但文件相同可得到 `match`；所有结果都不证明动态能力可用。

复制 [协议核对模板](../assets/templates/protocol-review.json) 为 `$RUN_DIR/protocol-review.json`，记录目标 HEAD、所读源文件及其摘要。处置完成后将 `resolution` 设为 `reviewed` 或 `needs_action`；无差异时 `differences` 为 `[]`，有差异时逐项填写依据、模板适配或公共缺口，不能保留 `unreviewed`。把记录关联到 capabilities/design 阶段材料，并按 [discovery.md](discovery.md) 继续查询实际能力。

验收计划必须包含这些记录、包内快照/清单及实际读取的目标协议文件。核对清单未覆盖的扩展也应补入；若路径移动，调整本次计划和模板，而不是强制目标仓库恢复旧路径。包内来源清单标明基准 Git commit；本版尚未提交的规范补充通过清单中单独声明的工作副本摘要与指南补丁记录，核对按其修改后字节比较。其他工作副本差异仍需阅读和记录，不能只修改清单以消除提示。记录更新后旧基线失效，按后面的 `--reason` 流程重新冻结。

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" checkpoint --run "$RUN_DIR" --stage analysis --evidence "$ANALYSIS_FILE"
node "$SKILL_ROOT/scripts/onboard.cjs" checkpoint --run "$RUN_DIR" --stage capabilities --evidence "$CAPABILITY_FILE"
node "$SKILL_ROOT/scripts/onboard.cjs" checkpoint --run "$RUN_DIR" --stage design --evidence "$DESIGN_FILE"
node "$SKILL_ROOT/scripts/onboard.cjs" freeze --run "$RUN_DIR" --plan "$PLAN_FILE"
```

阶段材料按独立编号复制到 `analysis/` 并记录摘要；原始记录不会被覆盖。支持的阶段还有 `discovery` 和 `implementation`，后者要求已冻结有效基线。按 [acceptance.md](acceptance.md) 配置命令，官方评分调用必须先于接入实现。

`freeze` 成功只表示官方基线可用，不表示接入通过。更新基线或验收计划时显式给出原因：

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" freeze --run "$RUN_DIR" --plan "$PLAN_FILE" --reason "$CHANGE_REASON"
```

## 实现、验收与报告

先按 [live-validation.md](live-validation.md) 生成分层测试及本次驱动，并实际完成 L1 接口和所需 L2 分段验证。测试矩阵保存到 `$RUN_DIR/validation-matrix.md` 后随基线冻结，结果另存。模板提供必需的 `interface-contracts` 和 `runtime` 检查：前者填本次 L1 测试命令，后者填本次驱动的实际 argv；外层超时覆盖内部工作及预留清理。驱动负责确认前置结果仍有效再进入 L3，CLI 不自动发现目标 API、轮询平台或从一条命令失败推导业务依赖。

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" verify --run "$RUN_DIR"
node "$SKILL_ROOT/scripts/onboard.cjs" report --run "$RUN_DIR"
```

`verify` 调用目标仓库 `scripts/benchmark/generate-catalog.cjs` 的 `loadPackage` 校验实际接入包，不生成 Catalog 文件。若目标版本已改变这个入口，按其规范调整检查桥接并重新验证；不能跳过契约检查。

需要更新 Catalog 供平台运行时，由宿主按目标仓库现行命令执行；此动作不由只读 Catalog 检查隐式完成。Doctor/Smoke 和平台接口也由冻结计划中的包装程序按目标版本调用，CLI 不假设部署地址或凭据。

每次尝试写入 `attempts/<编号>/`；官方调用保存在 `baselines/<编号>/`。命令日志、原生输出及声明的独立证据会记录文件摘要。最终报告为 `reports/report.json` 和 `reports/report.md`，包含范围、全部检查、预算和历史尝试引用。保护运行目录中的隐藏测试和原始证据，发布前只导出脱敏摘要；不要把整个运行目录放进 Skill 包或 Git。

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

只有用户调整预算后，才能记录新的总上限：

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" budget --run "$RUN_DIR" --max-attempts 8 --max-seconds 7200 --reason "$AUTHORIZED_BUDGET_CHANGE"
```

该命令保留旧预算与原因，既有尝试数和开始时间不重置。已取消运行不续跑，另建任务并明确继承的参考资料。

## 独立验证与三类试验

```bash
bash "$SKILL_ROOT/scripts/test.sh"
```

测试使用合成仓库与合成评分程序验证工具行为，包含错误判分、旧证据、未配置检查、预算和包迁移；不冒充 Benchmark 官方试验。发布真实兼容声明前还需要：T1 固定回答的独立评分、T2 EdgeBench 反馈迭代、T3 Terminal-Bench 状态验证。按实际可访问的版本选样、固定预算，并保留全部尝试和未解决问题。
