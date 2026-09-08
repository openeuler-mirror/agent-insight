# Benchmark 前端最小接入开发计划

> 高保真：`http://127.0.0.1:8067/SWE-bench实验流程-高保真.html`。
> 原则：复用现有实验列表、四步向导、实验详情和通用 API；不再开发独立 Benchmark 前端流程。

## 1. 本期范围

本期只增加以下能力：

1. 预先导入一个 `SWE-bench Verified` 数据集，并在现有评测数据集页面和实验向导中展示，导入到数据库中，放在810@123.com账号下面就行，不要和内置数据集搞混了；
2. 在现有评估器中心增加 `SWE-bench Official Harness` 预置评估器说明；实际执行仍由独立评测服务完成；
3. 选择 Benchmark 数据集后，只允许“生成 Trace”，禁用“选择已有 Trace”和监听模式；
4. Benchmark 不限定 OpenCode。沿用普通实验的 Agent/客户端轮询与选择逻辑，使用所选 Agent 对应的兼容执行目标；
5. Benchmark 除自动绑定 Official Harness 外，仍可添加普通评估器；依赖 `reference_output` 的评估器必须禁用；
6. 所有实验列表行增加“同配置实验”和“复用评测配置”。

不在本期开发：独立 Benchmark 向导/详情路由、同基线趋势、Case 列表的 Trace/耗时增强、Patch 下载、SWE-bench Lite，以及新的并发策略。现有 Case 重跑和单项重评能力必须保留，并适配 Benchmark 内部执行链路。Benchmark Case 只在现有详情页内增加专属结果渲染。

## 2. 页面线框与逻辑对应

```text
实验列表
└─ 实验行 …… [A 同配置实验] [B 复用评测配置]

新建实验（沿用现有四步向导）
├─ ① 实验设计
│  ├─ Agent：沿用普通 Agent 候选轮询                         [C]
│  └─ 数据集：普通数据集 + SWE-bench Verified               [D]
├─ ② Trace 来源
│  ├─ 生成 Trace：可用
│  └─ 选择已有 Trace / 监听：Benchmark 数据集下禁用          [E]
├─ ③ 预期答案
│  └─ 展示“官方测试契约已内置、不会暴露给 Agent”，不可编辑    [F]
└─ ④ 评估器与执行
   ├─ SWE-bench Official Harness：自动勾选、不可取消          [G]
   ├─ 不依赖参考答案的普通评估器：可选
   └─ 依赖 reference_output 的评估器：置灰并说明原因          [H]

实验详情
├─ 继续使用现有通用容器、汇总和 Case 列表
└─ Case 详情（沿用现有路由）
   ├─ 任务输入                                                [I]
   ├─ 参考答案：SWE-bench 官方测试契约，只读且内容隐藏         [J]
   ├─ 实际输出：model.patch 名称与摘要                         [K]
   ├─ 结果评测：Official Harness 判定、测试通过数和证据         [L]
   ├─ 轨迹评测：展示本次选择的普通轨迹评估器结果               [M]
   └─ 沿用普通实验操作：[N 重跑 Case] / [N 单项重评]
```

- `[A]` 由服务端复制冻结配置，创建新实验后立即调用现有运行接口，并跳转新实验详情页；
- `[B]` 打开现有新建向导并预填原实验配置，用户修改后才创建实验；
- `[C]` 继续轮询 `GET /api/experiments/agents`，不新增 OpenCode 专用选择器；
- `[D]` 继续读取 `GET /api/agent-datasets`，根据 `datasetKind=benchmark` 切换约束；
- `[E]` 仅当所选数据集的 `datasetKind=benchmark` 时，前端禁用“选择已有 Trace”和监听模式，并清空此前选择的已有 Trace；普通数据集保持原有能力。服务端创建 Benchmark 实验时再次校验 `traceSource=generate`；
- `[F]` 官方测试契约属于 Benchmark 私有数据，不转换成普通 `referenceOutput`；
- `[G]` Official Harness 的结果继续落入通用 `ExperimentEvalResult`；
- `[H]` 复用现有评估器 `requires` 门控，并增加 Benchmark 服务端校验；
- `[I]` 使用 Benchmark Case 的公开 `problemStatement`；
- `[J]` 只展示契约说明，不返回 Gold Patch、测试 Patch、脚本或测试名单；
- `[K]` 从当前 Case 的 `BenchmarkArtifact` 返回 `model.patch` 元数据，不返回文件正文；
- `[L]` 把 Official Harness 的 `pass/fail` 映射为 `Resolved/Unresolved`，从现有评分点展示 `FAIL_TO_PASS`、`PASS_TO_PASS` 的 `passed/total`；
- `[M]` 继续按现有 `res/traj` 分类展示补充评估器；未选择轨迹评估器时显示空状态；
- `[N]` 继续调用现有通用重试接口；“重跑 Case”重新执行 Agent 并重新评测，“单项重评”复用当前 Trace 或 Patch，只重跑对应评估器。

## 3. 逐区域后端就绪度

| 区域 | 当前已有能力 | 仍需开发 |
|---|---|---|
| A/B：复制与复用 | `Experiment` 已有 `configSnapshotJson` 和 `sourceExperimentId` | 普通全局实验也要完整冻结配置；现有 `POST /api/experiments` 增加同配置复制模式；详情响应增加标准化 `reusableConfig` |
| C：Agent/执行目标 | `GET /api/experiments/agents` 已合并历史 Agent 与在线客户端，并轮询刷新；平台是动态值 | 在同一响应的 target 上补 `supportsBenchmark` 与不可用原因；不能硬编码 OpenCode，也不新增 Benchmark target API 给前端 |
| D：数据集 | 导入器已同时创建 `AgentEvalDataset` 公共投影和 `BenchmarkDataset` 私有数据，二者有一对一关联 | `DatasetKind`、存储归一化和页面支持 `benchmark`；公共投影补齐向导需要的 `input/instanceId/repo`；导入数据只读 |
| E：Trace 来源 | 普通向导已有“生成/已有 Trace”和客户端执行逻辑；Benchmark 执行器会返回 `traceId` | Benchmark 数据集强制生成 Trace；创建接口拒绝已有 Trace；执行成功后把已入库 Trace 绑定回 `ExperimentCase` |
| F：参考答案 | Adapter 已把公开任务与私有测试契约分离，私有字段不会发送给 Agent | 第三步仅显示契约说明；保持 `referenceOutput=null`，禁止编辑、导入或伪造普通参考答案 |
| G/H：评估器 | 通用预置/自建评估器、依赖门控和评测引擎已存在；Official Harness 已通过评测服务执行并写 `ExperimentEvalResult` | 把 Official Harness 登记到现有评估器目录；Benchmark 创建时自动绑定；调度非参考答案普通评估器；统一实验终态判断 |
| 列表/实验详情 | `GET /api/experiments`、`GET /api/experiments/{id}` 已覆盖通用列表、聚合、分页 Case 和评估器结果 | 复用原接口和页面；补 Official Harness 名称/说明映射和列表操作，不新增 Benchmark 实验详情路由 |
| Benchmark Case 详情 | 现有 Case 详情已经有“任务输入/预期输出/实际输出”和“结果评测/轨迹评测”框架；Official 结果已有 `verdict/summary/points/evidence` | 在现有详情响应补安全的 Benchmark 展示字段；按高保真渲染官方契约、Patch 摘要、Resolved 判定、两组测试通过数和证据摘要 |
| Case 重跑/重评 | 普通实验已有 Case 重跑接口和单个结果重评接口，页面已有对应操作 | 在两个通用接口内部识别 Benchmark：重跑时重新执行 Agent、生成 Trace/Patch 并重跑全部评估器；Official 重评时复用最新 Patch，仅重新调用评测服务 |

## 4. API 方案

前端继续使用原接口：

```http
GET  /api/agent-datasets?view=summary
GET  /api/agent-datasets/{id}?view=items
GET  /api/experiments/agents
POST /api/experiments
POST /api/experiments/{id}/run
GET  /api/experiments
GET  /api/experiments/{id}
POST /api/experiments/{id}/cases/{caseId}/retry
POST /api/experiments/{id}/results/{resultId}/retry
```

### 4.1 数据集和执行目标

扩展现有数据集响应：

```json
{
  "id": "aeds_...",
  "name": "SWE-bench Verified",
  "datasetKind": "benchmark",
  "caseCount": 500,
  "readOnly": true,
  "benchmark": { "adapterKey": "swe-bench", "status": "ready" }
}
```

浏览器只拿 `AgentEvalDataset.id` 和公开 Case。创建实验时，服务端通过 `agentEvalDatasetId` 找到对应 `BenchmarkDataset`，不让前端接触私有测试字段或第二套数据集 ID。

`GET /api/experiments/agents` 在现有 target 上补充：

```json
{
  "workerId": "client_id",
  "platform": "opencode-or-other-platform",
  "supportsGenericTrace": true,
  "supportsBenchmark": true,
  "benchmarkUnavailableReason": null
}
```

`supportsBenchmark` 由服务端根据客户端在线状态、`RUN_BENCHMARK_CASE` 控制能力、工作区/Patch 能力和 `agent-runtime/{platform}/v1` 计算；前端只展示和门控，不配置执行器地址。

### 4.2 创建和运行

仍调用 `POST /api/experiments`。请求沿用普通向导字段，并补充统一的数据集引用：

```json
{
  "name": "SWE-bench Verified 实验",
  "agentName": "selected-agent",
  "datasetId": "aeds_...",
  "datasetCaseIds": ["bdc_..."],
  "traceSource": "generate",
  "evaluatorIds": ["benchmark:swe-bench", "preset-agent-trace-quality"],
  "executionTarget": {
    "workerId": "client_id",
    "platform": "registered-platform",
    "model": "optional-model"
  }
}
```

服务端按数据集类型选择内部创建逻辑，并自行写入 `scope=benchmark`、冻结公开/私有 Case 关联和自动补入 Official Harness。前端不再构造 `scope=benchmark` 分支请求，也不调用 `/api/benchmark/v1/datasets`、`execution-targets` 或 `experiments` 查询接口。

创建成功后仍调用 `POST /api/experiments/{id}/run`。该路由内部可以按 `scope` 分发普通引擎或 Benchmark 调度器，但对前端保持同一契约。

### 4.3 Benchmark Case 详情

仍使用：

```http
GET /api/experiments/{id}?caseId={caseId}
```

在通用 Case 对象上增加可选的公开展示字段；普通实验不返回该字段：

```json
{
  "benchmark": {
    "externalCaseId": "sympy__sympy-20590",
    "repo": "sympy/sympy",
    "reference": {
      "kind": "official-test-contract",
      "description": "测试内容和 Gold Patch 对 Agent 隐藏，仅供评测服务判定"
    },
    "submission": {
      "name": "model.patch",
      "sha256": "sha256:..."
    },
    "evidenceArtifacts": [
      { "name": "report.json", "kind": "report", "sha256": "sha256:..." },
      { "name": "harness.log", "kind": "log", "sha256": "sha256:..." }
    ]
  }
}
```

Official Harness 的结论和测试计数不重复造字段，继续读取通用结果行：

```text
evaluatorId = benchmark:swe-bench
verdict     = pass | fail              → Resolved | Unresolved
points[FAIL_TO_PASS].evidence           → passed / total
points[PASS_TO_PASS].evidence           → passed / total
summary                                  → 卡片结论
```

前端只按 `evaluatorId` 使用专属卡片样式，其余结果继续走现有通用评估器卡片。响应不得包含 Artifact 存储路径、文件正文或私有测试契约。

### 4.4 Case 重跑与单项重评

不增加 Benchmark 专属接口，沿用普通实验的两个操作：

```http
POST /api/experiments/{id}/cases/{caseId}/retry
POST /api/experiments/{id}/results/{resultId}/retry
```

- **重跑 Case**：普通实验现有逻辑会重新生成 Trace 并再次评测。Benchmark 分支需重新执行 Agent，产出新的 Trace 和 `model.patch`，再运行 Official Harness 及本次实验选择的普通评估器；
- **单项重评**：普通评估器继续复用当前 Case 绑定的 Trace、输入和输出；Official Harness 则复用该 Case 最新有效的 `model.patch`，只重新调用评测服务，不重新执行 Agent；
- Official Harness 是异步任务，接口入队后返回 `running`，前端继续轮询现有实验详情；通过新的 `attemptNo` 记录本次评测，防止重复点击并保留重评关系；本期重评采用全局单任务串行，默认并发数固定为 `1`。

### 4.5 同配置实验与复用评测配置

不增加 Benchmark 专属接口：

```http
POST /api/experiments
Content-Type: application/json

{
  "createMode": "same-config",
  "sourceExperimentId": "exp_source"
}
```

服务端校验归属并从冻结快照复制配置，写入 `sourceExperimentId`，返回新实验 ID。前端随后调用现有 `/run` 并跳转详情页。不能由浏览器读取后再回传“完整配置”，避免篡改 Benchmark 私有关联或复制到失效客户端。

`GET /api/experiments/{id}` 增加不含私有数据的 `reusableConfig`。点击“复用评测配置”后进入：

```text
/experiments/new?reuseFrom={sourceExperimentId}
```

向导预填数据集、Case、Trace 来源、Agent、执行目标、模型和评估器；用户可以修改。若最终选择 Benchmark 数据集，Official Harness 仍不可取消且已有 Trace 仍不可选。旧实验缺少完整快照时，只预填可可靠恢复的字段，并在页面明确提示缺失项。

### 4.6 为什么仍保留 `/api/benchmark/v1/*`

执行器进度回调、Artifact 上传、评测服务接单/回调继续保留 `/api/benchmark/v1/*`。这些是机器间协议，包含签名、幂等和私有评测数据，不属于浏览器 API。现有 `/api/benchmark/v1/experiments/{id}` 不再作为新前端依赖；本期无需为删除它扩大改动面。

## 5. 前后端开发内容

### 5.1 前端

1. 数据集中心识别 `benchmark`，展示“系统导入/只读”说明（不标记为内置数据集），禁用编辑、删除和 Trace 回流；
2. 现有四步向导增加基于 `datasetKind` 的条件行为，不创建新的 Benchmark Wizard；
3. Step 2 使用普通 Agent 与 target 列表，仅筛选 `supportsBenchmark=true` 的执行目标；禁用已有 Trace 和监听；
4. Step 3 显示官方测试契约说明，不显示或编辑隐藏答案；
5. Step 4 自动选择 Official Harness，同时展示所有通过现有门控的普通评估器；
6. 实验列表增加两个操作按钮，并阻止按钮点击冒泡到详情行；
7. 实验详情继续使用现有页面和 Case 列表，不增加趋势图、Trace 数和耗时列；
8. 现有 Case 详情根据 `case.benchmark` 切换顶部三块内容，并为 `benchmark:swe-bench` 渲染高保真 Official Harness 卡片；普通结果/轨迹评估器继续用现有卡片；
9. 保留现有“重跑 Case”和单个结果“重评”入口，不增加 Benchmark 专属按钮或页面；Official 重评提交后按现有详情轮询刷新状态。

### 5.2 后端

1. 扩展 `DatasetKind` 与现有数据集读接口，保证 Benchmark 公共投影可被普通向导直接消费；
2. 导入 `SWE-bench Verified` 时生成兼容的公共 Case：`input=problemStatement`，`values` 保留 `instanceId/repo/baseCommit/version`，私有测试契约只留在 `BenchmarkDatasetCase.privatePayloadJson`；
3. 为导入数据增加 API 级只读校验，不能只靠按钮置灰；
4. 在现有 Agent 查询中合并 Benchmark 可执行性，所选 `agentName` 必须与 target 上报的 agent 一致，平台不做厂商白名单；
5. 统一 `POST /api/experiments` 输入，由服务端根据数据集类型调用内部 Benchmark 创建逻辑；
6. Benchmark 执行回传 `traceId` 后等待对应 `Execution` 入库，回填 `ExperimentCase.executionId/taskId/actualOutput`；
7. Official Harness 继续走评测服务；其他已选评估器复用通用 `evaluateEvalExperimentCase()`，且排除 `benchmark:*`；
8. 实验只有在所有 Case 的 Official Harness 和补充评估器均进入终态后才结束；任一链路失败要形成对应结果行和可读错误；
9. 扩展现有实验详情查询，按实验与 Case 归属关联 Benchmark Case、Patch 和评测证据，只返回白名单展示字段；
10. 在现有 Case 重跑和结果重评接口内增加 Benchmark 分支，分别完成 Agent 全链路重跑和基于最新 Patch 的 Official Harness 异步单项重评；
11. 所有实验创建时统一写完整 `configSnapshotJson`，并实现 `same-config` 复制和 `reusableConfig` 读取。

## 6. 单阶段实施顺序

1. 数据集类型、公共投影、预导入与只读保护；
2. Official Harness 评估器目录项与参考答案门控；
3. 通用 Agent target 增加 Benchmark 兼容信息；
4. 在原四步向导内接入 Benchmark 条件行为；
5. 打通 Official Harness 与普通评估器共同执行、绑定和终态汇总；
6. 全量实验配置快照、同配置实验、复用评测配置；
7. 适配通用 Case 重跑与单项重评；
8. 列表、通用实验详情和 Benchmark Case 专属结果卡片；
9. 使用 `810@123.com` 验收账号完成端到端验证。

## 7. 验收标准

1. `810@123.com` 可在现有数据集页面看到只读的 SWE-bench Verified；浏览器响应不含 `goldPatch/testPatch/eval_script` 和测试名称列表，`FAIL_TO_PASS/PASS_TO_PASS` 只返回 `passed/total` 汇总；
2. 新建实验仍是原四步界面；选择 Benchmark 数据集后已有 Trace 和监听不可用；
3. Agent 候选来自现有轮询接口，可使用任意已上报且兼容 Benchmark 的平台/Agent，不硬编码 OpenCode；
4. Official Harness 自动选中且不可取消；不依赖参考答案的普通评估器可选，依赖参考答案的预置和自建评估器均不可提交；
5. 创建、运行、列表和详情只使用通用实验接口；浏览器不依赖 `/api/benchmark/v1/experiments*`；
6. Official Harness 与普通评估器结果都显示在现有实验详情中，实验不会在补充评估器未结束时提前完成；
7. Benchmark Case 详情按高保真展示官方契约、Patch 摘要、Resolved/Unresolved、`FAIL_TO_PASS`、`PASS_TO_PASS` 和证据摘要；不暴露私有测试数据；
8. 未选择轨迹评估器时显示空状态；选择后仍在“轨迹评测”区域使用普通评估器卡片；
9. Benchmark Case 可沿用普通实验入口重跑；重跑会产生新的 Trace/Patch，并重新执行 Official Harness 和已选普通评估器；
10. Official Harness 可复用最新有效 Patch 单独重评，普通评估器可复用当前 Trace 单独重评，两者都不会重新执行无关链路；
11. “同配置实验”一次点击创建并启动新实验，跳转新详情；原实验不变且新实验记录 `sourceExperimentId`；
12. “复用评测配置”进入可编辑向导并正确预填，未点击开始前不创建实验；
13. 普通数据集、普通实验、可靠性实验和已有评估器行为不回归。
