# 服务端 Judge

- 实现：`src/lib/fault-injection/judge.ts`
- 模型：用户 `getActiveConfig`
- 输入：`summarizeTrace(interactions)` + `injectionEvidence` + fault 元数据
- 输出：`outcome` × `faultContainmentStatus`（合法组合同原 OpenCodeFaultJudge）
- 时机：采集成功后；支持 `rejudge`；未配模型 → `judge_skipped`
