# Benchmark 前端开发计划

> 范围：在现有“实验”页面上接入 SWE-bench 高保真流程，包括实验列表、新建向导、实验详情和 Case 详情。  
> 高保真：`其他文件/SWE-bench实验流程-高保真.html`。  
> 后端基础：Benchmark 创建、Executor、Official Harness、结果归一化和证据下载已经实现；本计划只补齐前端对接所需的调度、读取模型和操作接口。

## 1. 交付范围

第一版必须打通：

```text
OpenCode + SWE-bench Verified + 生成 Trace/Patch
  → Official Harness
  → Resolve Rate / Case 结果 / 证据展示
```

首版暂不开放 Claude Code、SWE-bench Lite、历史 Trace/Patch 复评和补充评估器；这些能力没有完整后端链路，放在后续阶段。

## 2. 页面与接口映射

```text
实验列表
├─ [A] 元信息、Case 数、Official Evaluator、Resolve Rate
└─ [B] 同配置实验、复用评测配置

新建实验
├─ [C] 数据集、Agent
├─ [D] 执行主机、模型、Case
├─ [E] 官方测试契约覆盖情况
└─ [F] Official Harness 与补充评估器

实验详情
├─ [G] 五阶段进度
├─ [H] Resolve Rate、评估器结果
├─ [I] 同基线趋势
└─ [J] Case 列表

Case 详情
├─ [K] 问题、Patch、Trace
├─ [L] Resolved、FAIL_TO_PASS、PASS_TO_PASS
└─ [M] report.json、harness.log、重试
```

| 区域 | 当前接口/数据 | 开发结论 |
|---|---|---|
| A | `GET /api/experiments` 已返回名称、Agent、状态、Case/评估器数量、分数和分页 | 前端增加 `scope=benchmark` 展示分支；Benchmark 分数明确按 Resolve Rate 展示 |
| B | 已有 `configSnapshotJson`、`sourceExperimentId`，无复制命令 | 新增复制和复用配置接口 |
| C/D | 创建接口已支持 `datasetId/clientId/platform/agent/model/caseIds` | 新增 Benchmark 数据集和兼容执行目标查询接口 |
| E | Adapter 已隔离 public/private 数据 | 返回“Official test contract 已就绪”，禁止返回 Gold Patch/Test Patch |
| F | Official Harness 已绑定；补充评估器未串联 | 首版仅 Official；后续接普通 `ExperimentEvalResult` |
| G/J | Run/Evaluation 已保存 status、progress、timestamps | 扩展 Benchmark 详情 API，由后端映射为页面阶段，不让前端解释内部状态 |
| H/L/M | 已有 Resolve Rate、native metrics 和评测证据下载 | 扩展元信息和 Case 详情；新增用户侧 Patch 下载接口 |
| I | 已有数据集 hash 和冻结 Case 集合 | 新增同基线趋势查询 |

## 3. P0：补齐多 Case 调度

当前 `startBenchmarkExperiment()` 只派发第一个 pending Case；执行或评测终态回调没有继续派发下一条。多 Case 页面开发前必须增加统一推进函数：

```text
advanceBenchmarkExperiment(experimentId)
  ├─ 存在 active Run → 返回
  ├─ 存在 pending Run → 原子 claim，生成 Outbox 并派发
  ├─ 全部 Run 终态 → Experiment/Binding 置为 done
  └─ 存在可恢复 Outbox → 使用原 runId 和 digest 幂等重发
```

调用位置：

1. 实验首次启动；
2. Agent 执行成功、失败或提交非法后；
3. Official Harness 完成、失败或归一化失败后；
4. 服务启动恢复；
5. Case 重试后。

执行失败的 Case 也必须进入终态计数并推进下一条，不能让整个实验永久停在 running。

## 4. 页面读取接口

### 4.1 数据集与 Case

```http
GET /api/benchmark/v1/datasets
GET /api/benchmark/v1/datasets/{datasetId}/cases?page=1&pageSize=20&search=
```

```json
{
  "items": [{
    "id": "benchmark_dataset_id",
    "name": "SWE-bench Verified",
    "adapterKey": "swe-bench",
    "caseCount": 500,
    "contentHash": "sha256:...",
    "status": "ready"
  }]
}
```

Case 响应只包含 `caseId/instanceId/repo/problemStatement` 等公开字段，并返回：

```json
{
  "expectedAnswer": {
    "kind": "official-test-contract",
    "ready": true,
    "visibleToAgent": false
  }
}
```

不直接复用 `/api/agent-datasets`：它返回的是 `AgentEvalDataset.id`，而 Benchmark 创建需要 `BenchmarkDataset.id`；现有 `DatasetKind` 也尚未识别 `benchmark`。

### 4.2 执行目标

```http
GET /api/benchmark/v1/execution-targets?datasetId={datasetId}
```

响应按 Adapter Manifest 过滤在线、健康且能力齐全的客户端：

```json
{
  "items": [{
    "clientId": "client_id",
    "hostname": "gpu-worker-07",
    "ip": "10.20.3.17",
    "compatible": true,
    "platforms": [{
      "id": "opencode",
      "agents": ["build"],
      "models": ["gpt-5.2-codex"]
    }],
    "missingCapabilities": []
  }]
}
```

第一版只返回具备 `git-workspace/v1`、`agent-runtime/opencode/v1`、`git-patch/v1` 的目标。前端不得使用普通 Agent 列表推测 Benchmark 可执行性。

### 4.3 实验详情

扩展现有接口：

```http
GET /api/benchmark/v1/experiments/{experimentId}?page=1&pageSize=20&status=&verdict=
```

新增 `meta`、`pipeline` 和 Case 展示字段：

```json
{
  "meta": {
    "name": "OpenCode · SWE-bench Verified",
    "agent": "OpenCode",
    "model": "gpt-5.2-codex",
    "dataset": { "name": "SWE-bench Verified", "contentHash": "sha256:..." },
    "createdAt": "..."
  },
  "pipeline": {
    "currentPhase": "official_evaluating",
    "phases": [
      { "key": "prepare", "status": "done" },
      { "key": "agent", "status": "done" },
      { "key": "upload", "status": "done" },
      { "key": "official", "status": "running" },
      { "key": "aggregate", "status": "pending" }
    ]
  }
}
```

新增服务端 `BenchmarkPhaseMapper`，统一把 Run、Outbox、Evaluation 和 progress stage 映射为五阶段状态、失败原因和时间；前端只渲染标准化结果。

### 4.4 Case 详情与产物

```http
GET /api/benchmark/v1/experiments/{experimentId}/cases/{caseId}
GET /api/benchmark/v1/experiments/{experimentId}/cases/{caseId}/artifacts/{artifactId}/content
```

详情返回公开任务、Official test contract 描述、Patch 摘要、Trace ID、执行耗时、Official 结果和证据。Patch 下载接口按用户、实验、Case、Artifact 四层校验归属；现有评测服务专用 Artifact 接口不能直接暴露给浏览器。

## 5. 写操作接口

### 5.1 创建与启动

沿用：

```http
POST /api/experiments
POST /api/experiments/{id}/run
```

前端创建请求使用 `scope=benchmark`，传入 `BenchmarkDataset.id`、显式 Case ID、`clientId`、OpenCode Agent 和模型。服务端继续负责冻结数据集 hash、Case 顺序和运行配置。

### 5.2 同配置与复用配置

```http
POST /api/benchmark/v1/experiments/{id}/clones
GET  /api/benchmark/v1/experiments/{id}/reuse-template
```

- `clones`：复制完整冻结配置，生成新实验，写入 `sourceExperimentId`，默认立即启动；
- `reuse-template`：锁定数据集 hash、Case 和 Official Harness，允许重新选择 Agent、客户端、模型和后续补充评估器。

### 5.3 重试

```http
POST /api/benchmark/v1/experiments/{id}/cases/{caseId}/retries
{ "mode": "execution" }

POST /api/benchmark/v1/experiments/{id}/cases/{caseId}/retries
{ "mode": "evaluation" }
```

- `execution` 创建新的 Case Run 和 Patch；
- `evaluation` 复用原 Patch，只创建新的 Evaluation；
- `resolved=false` 是合法结果，不自动重试；
- 重试记录使用已有 `retryOfRunId/retryOfEvaluationId`。实现时建议为 `BenchmarkCaseRun` 增加 `attemptNo` 和 `(experimentCaseId, attemptNo)` 唯一约束。

### 5.4 同基线趋势

```http
GET /api/benchmark/v1/experiments/{id}/trend
```

比较基线固定为：

```text
adapterKey + datasetContentHash + 有序 Case ID 集合 + Official Evaluator key/version
```

Agent、模型和执行机器允许不同。基线指纹先冻结到 `configSnapshotJson`；数据量需要索引时再提升为独立字段。

## 6. 前端改造

1. 实验列表读取 `scope`，Benchmark 行显示 Resolve Rate，并增加“同配置实验/复用评测配置”；
2. 新建向导增加 Benchmark 分支，复用现有四步布局，不把 Benchmark 数据转换成普通实验 Case；
3. Step 1 使用 Benchmark 数据集接口，Step 2 使用兼容执行目标和公开 Case 接口；
4. Step 3 只展示 Official test contract 覆盖状态，不允许编辑或读取隐藏答案；
5. Step 4 首版固定选中 Official Harness，补充评估器置灰并说明未开放；
6. 实验详情按 `scope=benchmark` 调用 Benchmark 详情接口并轮询；
7. Case 详情渲染 Patch、Trace、Official 指标和证据，失败时按后端返回的 `allowedActions` 显示重跑或重评。

涉及页面：

```text
src/app/(main)/experiments/page.tsx
src/app/(main)/experiments/new/page.tsx
src/app/(main)/experiments/[id]/page.tsx
src/app/(main)/experiments/[id]/cases/[caseId]/page.tsx
```

新增 UI 必须复用 `src/components/ui`、`.ai-*` 工具类和 `globals.css` 设计令牌，不新增 Benchmark 局部色板。

## 7. 开发阶段

### Phase 1：可运行 MVP

1. 多 Case 自动推进与恢复；
2. 数据集、公开 Case、兼容执行目标 API；
3. Benchmark 实验/Case 详情读模型和 Patch 下载；
4. 列表、四步向导、实验详情、Case 详情前端分流；
5. OpenCode + Verified + Official Harness 端到端验收。

### Phase 2：操作闭环

1. Case 重跑和 Official 重评；
2. 同配置实验和复用评测配置；
3. 同基线趋势；
4. 评测服务 readiness 和明确失败提示。

### Phase 3：扩展能力

1. 已有 Trace/Patch 复评；
2. 任务完成度、轨迹质量、忠实度等补充评估器；
3. Claude Code Runtime；
4. SWE-bench Lite 导入；
5. Verified 500 并发策略。

## 8. 验收

1. 选择 2 个 Verified Case 后自动依次完成，不停在 1/2；
2. 服务重启后从原 Outbox/Run 恢复，不重复创建运行；
3. 所有浏览器响应均不含 `goldPatch/testPatch/eval_script` 等隐藏字段；
4. Resolve Rate 固定以选中 Case 总数为分母，未完成 Case 不被悄悄排除；
5. Case 可查看 Patch 摘要、Trace、FAIL_TO_PASS、PASS_TO_PASS 和证据；
6. 执行失败、提交非法、评测服务不可用、Harness 失败分别显示正确阶段和允许操作；
7. 普通实验列表、向导和详情流程不受 Benchmark 分流影响；
8. 运行 `npm run test`，并启动 dev server 验证一条成功 golden path 和至少一个失败边界 Case。

实现完成后同步更新 `docs/user-guide/` 的实验流程和 `docs/developer-guide/` 的 API、数据流与前端路由说明。
