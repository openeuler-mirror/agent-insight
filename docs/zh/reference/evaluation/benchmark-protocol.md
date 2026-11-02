---
title: "独立 Benchmark 评测协议"
description: "平台与独立 Evaluator 的派发、幂等、取消及结果归一化边界。"
---

独立 Evaluator 服务运行官方 Benchmark 评判。它与平台内置 LLM Judge 的[输出契约](./evaluator-output.md)是不同层次；部署步骤见 [Benchmark 服务安装](../../how-to/evaluation/benchmarks/deploy-services.md)。本页供接入开发者查字段，不建议普通用户手工派发正式任务。

## 派发接口

`POST /api/v1/evaluations` 位于独立 Evaluator 地址，健康检查为 `GET /health`。普通派发必须包含：

| 字段 | 约定 |
| --- | --- |
| `runId` | `1`～`160` 位字母、数字、下划线或短横线；须与 `evaluationJob.evaluationId` 相等 |
| `requestDigest` | `sha256:` 加 64 位十六进制；由除自身外的派发对象规范化 JSON 计算 |
| `evaluationJob` | 下表中的 `benchmark-evaluation/v1` Job |
| `platformBaseUrl` | 无 URL 凭证、query 或 fragment 的 HTTP(S) 地址 |
| `callbackBaseUrl` | 与平台同源，路径匹配该平台的 `/api/benchmark/v1/evaluations/:runId` |
| `timeoutSeconds` | `1`～`86400` 的整数，与 Job 的 limits 中超时相等 |

请求头 `x-agent-insight-request-digest` 必须等于摘要，`Idempotency-Key` 必须等于 `runId`。摘要校验用于一致性与幂等，不是身份认证；服务使用既有受控网络部署边界，不应把端口或取消接口直接当作公开匿名管理服务。

成功为 `202`：`{ runId, requestDigest, status: "accepted", state }`。相同 `runId` 和相同摘要可复用已有任务；相同 ID、不同摘要返回 `409 RUN_ID_CONFLICT`。受理不等于 Harness 成功完成。

## Job 和结果

| Job 字段 | 内容 |
| --- | --- |
| `protocolVersion` | 固定 `benchmark-evaluation/v1` |
| `evaluationId` / `executionRunId` | 评判运行 ID 与原执行运行 ID，不能互换 |
| `context` | `experimentId/caseId/datasetContentHash` |
| `benchmark.key` / `evaluator.key` | 数据集协议和评判器注册键 |
| `artifacts` | 每项含 `artifactId/executionRunId/name/mediaType/sha256/sizeBytes`，用于校验原始提交 |
| `payload` | 由具体 Benchmark Adapter 定义，不能用通用空对象替代 |
| `limits` | `timeoutSeconds/cpu/memoryMiB` |

服务进度阶段包含 `downloading_artifacts/preparing_runtime/resolving_image/running_harness/collecting_evidence/uploading_evidence/cleaning`；这些是评判进度，不是平台实验终态。

完成消息包含 `status`（`completed/submission_invalid/failed`）、`rawResult`、`evidenceArtifactIds`、`runtimeFacts`、`cleanup`，失败可带 `{ code, message, retryable }`。平台通过 Adapter 的 `normalizeResult()` 生成统一结果：`status: done|failed`、`summary`、可空 `score`、`verdict?`、`points`、`evidence`、`nativeMetrics` 和可选 `primaryMetric`。不要直接用原始 Harness 字段渲染所有 Benchmark。

`primaryMetric.aggregation` 为 `boolean-rate` 或 `mean`；原始通过率、布尔成功和 `0～100` 展示分数应分别保留含义，不能只凭展示分数推断官方成绩。容器退出、证据上传和资源清理状态也需分别核对。

## 取消与错误

同一 `POST /api/v1/evaluations` 接收 `{ operation: "cancel", runId, requestDigest }`，使用原任务摘要。返回 `202` 和取消状态；已有任务摘要不符为 `409`，缺摘要为 `422 CANCEL_INVALID`。未知但格式合法的运行 ID 可以先记录取消，阻止晚到的派发；取消受理不代表对应进程和容器已经退出。

| 错误 | HTTP 状态 / 含义 |
| --- | --- |
| `EVALUATION_REQUEST_INVALID` | `400`，派发对象或字段无效 |
| `CALLBACK_URL_FORBIDDEN` | `403`，回调目标与该平台任务不匹配 |
| `RUN_ID_CONFLICT` | `409`，同一运行 ID 摘要不同 |
| `SERVICE_BUSY` | `409`，容量不足；响应可标识 `retryable: true` |
| `REQUEST_DIGEST_MISMATCH` | `422`，对象摘要、请求头或幂等键不匹配 |

服务错误对象为 `{ error: { code, message, retryable } }`。网络不确定时保留同一请求和幂等身份；调整任务内容后应生成新任务，不伪造旧摘要。

## 实现依据

- [派发与 EvaluationJob 类型](https://gitcode.com/openeuler/agent-insight/blob/master/packages/benchmark-protocol/src/evaluation-contracts.ts)
- [进度、完成和归一化类型](https://gitcode.com/openeuler/agent-insight/blob/master/packages/benchmark-protocol/src/evaluator-contracts.ts)
- [服务端校验与处理](https://gitcode.com/openeuler/agent-insight/blob/master/services/evaluator/src/service.cjs)

[English](../../../en/reference/evaluation/benchmark-protocol.md)
