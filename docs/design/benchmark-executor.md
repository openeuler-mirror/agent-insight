# Benchmark 执行器后端设计

> 范围：高保真步骤 04～07——接收任务、运行 Agent、上传 Artifact、本地清理、回传终态。  
> 不包含前端、Agent Insight 的 Case 拆分/任务构造、`validateSubmission()`、评测服务和 Harness。  
> 前序设计：[Benchmark Agent 执行前服务端设计](benchmark-agent-pre-execution.md)；溯源：[高保真源码](../../评测服务文档/Benchmark统一接口设计-SWE-bench示例.html)。

状态：步骤 04～07 后端已实现并通过客户端控制通道测试；步骤 01～07 已使用本地 SWE-bench Verified 真实 Case 串联验证；真实 OpenCode generate-only Smoke 已通过。

## 1. 结论

执行器不另起一套 Agent 执行实现，而是在现有 `agent-insight-client` 常驻进程中增加 Benchmark 白名单指令和编排层：

```text
RUN_BENCHMARK_CASE（现有 WSS / HTTPS long-poll）
  → 校验 requestDigest、TaskEnvelope 和回调 Run 路径
  → 持久化 runId 后回 COMMAND_STATUS accepted
  → BenchmarkExecutionRunner
       → WorkspaceProvider.prepare()
       → PolicyEnforcer.apply()
       → AgentRuntime.run()                 # 复用现有 OpenCode 执行内核
       → ArtifactCollector.collect()
       → POST Agent Insight /artifacts
       → CleanupManager.cleanup()
       → POST Agent Insight /runs/{runId}/complete
```

同一个 systemd/launchd 服务继续负责心跳、能力上报、WSS/long-poll 指令和故障注入；Benchmark 与原有任务共享一个本地执行槽。客户端不启动 Benchmark HTTP listener，也不需要配置入站地址。第一阶段并发固定为 1。

## 2. 高保真调用顺序

| 步骤 | 调用 | 执行器处理 | 成功后状态 |
|-|-|-|-|
| 04 | Agent Insight `RUN_BENCHMARK_CASE` | 沿用设备控制通道鉴权，校验协议并按 `runId + requestDigest` 持久化 | 回执 accepted，后台开始运行 |
| 05 | 执行器 `POST /api/benchmark/v1/artifacts` | 上传本地收集的受控文件；SWE-bench 为 `model.patch` | 保存 `artifactId`，上传失败只重传文件 |
| 06 | 本地 `CleanupManager.cleanup()` | 终止残余进程、撤销临时策略、删除工作区 | 保存 cleanup facts，并保留 `state.json` 中待回传信息 |
| 07 | 执行器 `POST /api/benchmark/v1/runs/{runId}/complete` | 回传 Agent facts、Trace、Artifact ID 和 cleanup | 本地运行进入终态；后续由平台校验提交物 |

进度回调 `POST /api/benchmark/v1/runs/{runId}/progress` 可发生在 04～07 之间，但不改变上述主顺序。

## 3. 复用现有执行方式

| 现有能力 | 处理方式 |
|-|-|
| `scripts/reliability-client.cjs` 常驻进程、安装、保活、心跳、能力发现 | 直接复用；新增白名单指令处理，不开放入站 listener |
| `runExperimentCase()` / `buildExperimentCaseInvocation()` | 直接作为共享 OpenCode 执行内核；Benchmark 通过现有 `runExperimentCase()` 传入独立 `cwd`，子进程同步设置 `PWD=cwd` |
| OpenCode `run --format json`、stdin 传 prompt、`--agent/--model` | 直接复用 |
| 解析 OpenCode JSON 输出取得 Trace ID | 直接复用；禁止按输入文本猜测 Trace |
| detached 进程组、超时 `SIGTERM → SIGKILL` | 直接复用 |
| `reliabilitySlotHeld` / `fiBusy` | 收敛成一个 `ExecutionSlot`，统一约束普通实验、Benchmark 和 FI 的互斥 |
| `handledCommands` 内存去重 | 只负责 commandId 去重；Benchmark 仍用磁盘中的 `runId + requestDigest` 保证重启幂等 |
| 当前固定 `workspaceBase` 作为 Agent cwd | 改为每个 `runId` 独立的 prepared workspace |
| 原命令回执 `COMMAND_STATUS` | 复用作接单回执；执行进度、Artifact 和 complete 继续走 Benchmark 回调 API |

现有 `RUN_EXPERIMENT_CASE` 行为不变；Benchmark 复用同一个 `runExperimentCase()`，只增加内部 `cwd` 入参，远端普通指令仍不允许指定任意目录。

## 4. 目录设计

```text
packages/benchmark-protocol/
  src/
    contracts.ts                    # AgentTaskEnvelope、dispatch request/response
    executor-contracts.ts           # 执行请求、进度与终态 DTO
  schemas/
    agent-task.schema.json

services/executor/
  src/
    index.cjs                       # Runner、通用能力注册表和声明式执行计划

scripts/
  reliability-client.cjs            # 仍是唯一守护进程入口
  install-ras-client.js             # 把 executor 源码复制到已安装 runtime/executor

src/app/api/benchmark/v1/
  artifacts/route.ts
  runs/[runId]/progress/route.ts
  runs/[runId]/complete/route.ts

test/
  benchmark-executor-api.test.ts    # 04～07 与 01～07 的控制通道及回调 API 验收
```

用户机器只运行一个 `agent-insight-client` 服务。`services/executor` 是无第三方运行时依赖的 CommonJS 源码边界，安装时复制到 `~/.agent-insight/client/runtime/executor/index.cjs`，由常驻客户端直接加载。

安装命令仍只需要平台地址和一次性 Token。客户端安装后主动连接平台并上报 `RUN_BENCHMARK_CASE`、Workspace、Agent Runtime 和 Patch Collector 能力；平台根据 `clientId + platform + agent` 动态选择，不保存执行器 URL。

## 5. 跨进程协议

`schemaVersion` 和能力名中的 `/v1` 只表示协议兼容，不建立 Benchmark、数据集或评估器业务版本。

```ts
type BenchmarkExecutionRequest = {
  runId: string
  requestDigest: `sha256:${string}`
  task: AgentTaskEnvelope
  callbackBaseUrl: string
  timeoutSeconds: number
}

type AgentTaskEnvelope = {
  schemaVersion: 'agent-task/v1'
  benchmark: { key: string }
  context: { runId: string; experimentId: string; caseId: string }
  task: { instruction: string; benchmarkPayload: JsonValue }
  workspace: {
    provider: 'git'
    repository: string
    revision: string
  }
  policy: {
    workspaceWrite: 'allow'
    hiddenDataAccess: 'deny'
    network: 'client-default' | 'deny'
  }
  submission: { requiredArtifacts: ArtifactContract[] }
  agentConfig: {
    platform: string
    agent: string
    model?: string
    timeoutSeconds: number
  }
}
```

相较前序服务端实现，`agentConfig.agentRef` 改成结构化的 `platform + agent`，因为现有执行内核本来就以这两个字段选择本地可执行文件和 Agent。解析展示字符串不能留给执行器猜测；实验创建 API 和服务端 Adapter 要同步调整。

请求摘要仍按以下四项 canonical JSON 计算，不把 `requestDigest` 自身放进摘要：

```ts
sha256({ runId, task, callbackBaseUrl, timeoutSeconds })
```

## 6. 声明式能力编排

执行器没有 Benchmark 专属 Profile，也不读取 `benchmarkPayload` 拼接 Prompt。Agent Insight 的 `BenchmarkAdapter.buildAgentTask()` 已经生成完整 `task.instruction`；执行器只校验统一信封并按信封中的能力 ID 组装执行计划。因此新增一个复用 Git、OpenCode 和 Git Patch 的 Benchmark 时，执行器代码保持不变。

```ts
type ExecutionPlan = {
  workspaceProvider: WorkspaceProvider
  agentRuntime: AgentRuntime
  artifactCollectors: Array<{
    contract: ArtifactContract
    collector: ArtifactCollector
  }>
}

function buildExecutionPlan(task: AgentTaskEnvelope): ExecutionPlan {
  return {
    workspaceProvider: workspaceProviders.get(task.workspace.provider),
    agentRuntime: agentRuntimes.get(task.agentConfig.platform),
    artifactCollectors: task.submission.requiredArtifacts.map((contract) => ({
      contract,
      collector: artifactCollectors.get(contract.collector),
    })),
  }
}
```

三个 Registry 分别以 `task.workspace.provider`、`task.agentConfig.platform` 和 `artifact.collector` 为 key；注册重复 key 或下发未知能力都立即失败。能力 readiness 汇总为 `/health` 的 `capabilities`，供 Agent Insight 在下发前匹配。

通用能力接口保持 Benchmark 无关：

```ts
interface WorkspaceProvider {
  prepare(spec: WorkspaceSpec, context: RunContext): Promise<PreparedWorkspace>
}

interface PolicyEnforcer {
  apply(spec: PolicySpec, context: RunContext): Promise<AppliedPolicy>
  release(policy: AppliedPolicy): Promise<void>
}

interface AgentRuntime {
  run(input: AgentRunRequest, context: RunContext): Promise<AgentRunFacts>
}

interface ArtifactCollector {
  collect(contract: ArtifactContract, context: CollectContext): Promise<LocalArtifact>
}

interface CleanupManager {
  cleanup(context: CleanupContext): Promise<CleanupReport>
}
```

当前安装 Catalog 提供 `git` Workspace、`opencode` Agent Runtime 和 `git-patch/v1` Artifact Collector。SWE-bench Adapter 只声明并复用这些能力；执行器既没有 `swe-bench` import，也不会接收 `patch/test_patch/FAIL_TO_PASS/PASS_TO_PASS` 或运行 Harness。Runner 会逐个收集、上传所有必需 Artifact，并把每个 Artifact 的本地/已上传状态分别持久化，重启后只补传未完成项。

## 7. 本地执行细节

### 7.1 Git 工作区

- 目录固定为 `~/.agent-insight/client/workspaces/benchmark/{runId}`，请求不能指定本地路径；
- 只接受协议校验通过的 GitHub HTTPS 仓库和完整 commit SHA；
- 使用固定 Git 子命令初始化、fetch、detached checkout，禁用 hooks，不执行数据集中的命令；
- checkout 后核对 `HEAD === baseCommit`；失败回报 `WORKSPACE_PREPARE_FAILED`；
- 后续可以增加只读 bare mirror 缓存，但每个 Run 的工作树必须隔离。

### 7.2 OpenCode Runtime

从现有 `runExperimentCase()` 复用：本地解析可执行文件、`opencode run --format json --agent ...`、stdin prompt、模型参数、关联环境变量、Trace ID 提取、超时和进程组终止。变化只有两点：`cwd` 使用 prepared workspace 且子进程 `PWD` 与其一致，输入直接使用 Adapter 已完成渲染的 `task.instruction`。`PWD` 不能继承 Agent Insight 守护进程的启动目录，否则 OpenCode 工具可能在错误仓库中执行。

当前本机执行无法真正隔离“模型 API 网络”和“Agent 工具网络”。因此第一阶段只声明并接受 `network=client-default`；收到 `network=deny` 时返回 `POLICY_UNSUPPORTED`，不能虚假声称已隔离。正式网络隔离后续应增加独立 sandbox capability，可参考 OpenHands 的 Runtime/Sandbox 分层，但不复制其整套 Agent 实现。

### 7.3 `model.patch`

Agent 结束后，无论进程退出码是否为 0，都先尝试收集工作树；是否成功提交以必需 Artifact 是否有效为准，退出码原样写入 facts。

`GitPatchCollector` 使用无 shell 的固定参数执行 `git add -A`，再执行 `git diff --cached --binary --full-index <baseCommit>`。两条命令都使用 Git pathspec 排除协议保留产物路径 `model.patch`：Agent 只需修改工作树，最终 Artifact 由执行器生成，不能把 Agent 自行写出的同名文件递归收入补丁。校验：HEAD 基线一致、无绝对/越界路径、内容非空、大小不超过 10 MiB。OpenHands 的 SWE-bench 运行器同样在 Agent 结束后从基线 commit 收集 Git diff；这里仅借鉴这一边界，实际命令和数据模型仍由 Agent Insight 控制。

## 8. 控制指令与平台回调

### 8.1 接收任务

Benchmark 使用控制总线白名单 action `RUN_BENCHMARK_CASE`。WSS 可用时直接推送，不可用时由客户端现有 HTTPS 长轮询领取；两条通道共用设备凭据、`commandId` 和 `COMMAND_STATUS`。

```json
{
  "type": "COMMAND",
  "commandId": "cmd_001",
  "action": "RUN_BENCHMARK_CASE",
  "payload": {
    "request": {
      "runId": "erun_001",
      "requestDigest": "sha256:...",
      "task": {},
      "callbackBaseUrl": "https://agent-insight.example.com/api/benchmark/v1/runs/erun_001",
      "timeoutSeconds": 1800
    }
  }
}
```

客户端先回 `RECEIVED`，本地 Runner 完成协议校验与持久化后回 `RUNNING(state=ACCEPTED)` 和 `SUCCEEDED`。同 `runId + digest` 不重复运行；同 `runId` 不同 digest 返回 `RUN_ID_CONFLICT`；共享执行槽忙时返回 `CLIENT_BUSY`，平台延迟后用同一请求重发。能力与健康继续通过客户端原有心跳上报，不另设执行器 health URL。

### 8.2 平台回调

请求中的 `callbackBaseUrl` 是当前 Run 资源：`{executorCallbackOrigin}/api/benchmark/v1/runs/{runId}`。执行器只能调用 `${callbackBaseUrl}/progress` 和 `${callbackBaseUrl}/complete`；Artifact 固定上传到客户端已配置的平台基址。客户端校验 HTTP(S) 协议、无凭证/query/fragment 且路径中的 `runId` 精确匹配；允许回调 origin 与安装时控制地址不同，以支持专用 `AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL`。所有回调复用现有 `deviceCredential + x-agent-insight-client-id`，平台再校验 Run 确实属于该 `clientId`。

成功终态：

```json
{
  "kind": "execution",
  "status": "succeeded",
  "artifacts": [{
    "artifactId": "bart_001",
    "name": "model.patch",
    "sha256": "sha256:..."
  }],
  "runFacts": {
    "platform": "opencode",
    "agent": "build",
    "traceId": "trace_001",
    "exitCode": 0,
    "startedAt": "...",
    "finishedAt": "..."
  },
  "cleanup": { "status": "succeeded" }
}
```

## 9. 鉴权、持久化与恢复

不新增一套执行器鉴权或明文平台密钥。任务沿用客户端控制通道的 `ReliabilityClientCredential` 认证；客户端回调继续使用本机 `deviceCredential + clientId`。服务端 Outbox 记录 `commandId`，本地 Runner 再用 `runId + requestDigest` 做磁盘幂等。

本地状态：

```text
~/.agent-insight/client/benchmark-runs/{runId}/
  request.json          # 原始请求与 digest，0600
  state.json            # 阶段、Agent facts、本地/已上传 Artifact、待回传终态
  artifacts/model.patch
```

所有状态以临时文件 + fsync + rename 原子替换。守护进程重启时：

- `accepted` 且从未启动：可以继续执行；
- `preparing/agent_running/collecting/uploading/cleaning` 等非终态执行阶段：清理残余工作区，标记 `EXECUTOR_RESTARTED`，不得自动重跑 Agent；
- Artifact 已落本地但上传/终态回调未完成：只重放 `state.json` 中的待上传或待完成数据，不再运行 Agent；
- terminal：同 digest 重发只返回终态摘要；
- terminal：本阶段保留本地摘要和 Artifact；TTL 回收策略后续实现。

## 10. 实现与测试结果

1. 扩展 `benchmark-protocol`：结构化 `agentConfig`、execution request/response、progress/complete Schema；
2. 复用现有 `runExperimentCase()` 的 OpenCode invocation、Trace 提取和进程组超时能力，并允许 Benchmark 内部传入独立 `cwd`；
3. 实现 `FileRunStore` 和可由客户端指令直接调用的幂等接单入口；
4. 实现通用能力注册表、固定 Runner 和共享单执行槽；
5. 实现 Git workspace、Git patch collector、Artifact/回调重放状态和 cleanup；
6. 删除 Benchmark Profile，改为 `WorkspaceProviderRegistry`、`AgentRuntimeRegistry`、`ArtifactCollectorRegistry` 和多 Artifact 声明式编排；
7. 更新 client bundle 和安装器，使守护进程无需额外参数即可加载 Runner、上报能力并接收 `RUN_BENCHMARK_CASE`；
8. 补 Agent Insight 的 Artifact、progress、complete 接口，再进行端到端联调。

已完成的自动化测试覆盖控制指令接单、Runner 和真实回调 API：

- 04～07：控制通道鉴权、接单回执、磁盘幂等、digest 冲突、busy、真实 Git Patch 收集、Artifact/progress/complete 回调和工作区清理；
- 01～07：从本地 Verified Parquet 通过官方 loader 读取 500 个真实 Case，选取真实 Case 经创建实验、客户端控制指令、执行器、Artifact 和 complete 到达 `submitted`；
- 隔离：下发信封不包含 gold patch、测试补丁或目标测试字段；
- 回归：协议、SWE-bench Adapter、官方数据导入和原下发测试通过。
- 真实模型：`deepseek/deepseek-v4-flash` 执行 `pallets__flask-5014`，Run `erun_56961f9212164183917ef336686cd7d6` 到达 `submitted`，OpenCode Session/Trace 为 `ses_f95811fa1ffe4L45GPP9wnDCVX`；核心实现与官方 gold patch 一致，Artifact 与官方隐藏测试补丁共同应用后，本地等价环境运行目标测试得到 `60 passed`。

`test/benchmark-executor-api.test.ts` 默认使用隔离库；设置 `BENCHMARK_TEST_DATABASE_PATH` 时直接使用指定的现有 SQLite。本轮已在 `~/.agent-insight/data/witty_insight.db` 上完成 04～07 和 01～07 验收，测试记录按本轮唯一 user/client 精确清理，业务数据不参与清理。

后续仍需补更细的进程重启/回调断网故障注入测试。生成出的真实 Artifact 已继续进入 Docker 化评测 Controller，并在其启动的官方 ARM64 `pallets__flask-5014` Case 容器中完成步骤 09～13 冒烟；另已完成真实 OpenCode 到结果查询的 01～13 串联。该结果不代表 x86_64 Linux 正式判分验收完成。

真实 OpenCode + 一个 SWE-bench Case 作为人工 Smoke，会产生调用成本，因此保留为显式脚本而不放进默认单元测试。执行器默认测试不运行 SWE-bench Harness；Harness 由评测服务的显式 Docker 测试覆盖。本阶段不做前端、不实现多任务并发和网络 sandbox。

执行器阶段不需要再下载数据集：接口测试直接复用已导入的 `~/.agent-insight/data/imports/swe-bench-verified/test.parquet` 和 `~/.agent-insight/vendor/SWE-bench`。官方仓库是 Case 字段、`base_commit` 与后续 Harness 语义的第一依据；OpenHands 仅辅助参考“Agent 结束后从基线 commit 收集 diff”的边界。
