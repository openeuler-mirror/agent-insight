# AgentDebug 与 Skills 分析并行化需求分析

## 背景

当前 AgentDebug 主诊断与 Skills 步骤核验共用 `AgentDebugReport.reportJson`：

- 主诊断结果以 `AgentDebugReportPayload` 存入 `reportJson`。
- Skills 分析结果嵌在 `reportJson.skillsAnalysis`。
- Skills 分析接口必须先读到完整主诊断报告，才能把结果合并回 `reportJson`。

这个链路让 Skills 分析无法与主诊断真正并行；它还会在并发写入时形成整份 JSON 覆盖风险。

## 目标

1. AgentDebug 主诊断与 Skills 分析可以在用户点击“启动智能诊断”或“重新诊断”后同时开始。
2. 两个分析结果互不阻塞：主诊断先完成就先展示主诊断，Skills 分析先完成或稍后完成就独立刷新 Skills 区块。
3. Skills 分析结果从新独立存储读取；不再读取旧的 `reportJson.skillsAnalysis`。
4. 如果新存储里没有可用 Skills 分析，前端按当前 trace 重新触发分析。
5. 后续故障追问上下文从独立 Skills 分析存储读取结果。

## 非目标

- 不迁移旧的 `reportJson.skillsAnalysis`。
- 不做旧数据 fallback。
- 不修改公共 trajectory evaluator 的输出 schema。
- 不改变 AgentDebug 主诊断报告的核心 payload 结构。

## 用户可见行为

- 启动诊断后，页面显示主诊断运行态，同时 Skills 区块可进入自己的运行态。
- 主诊断完成后，关键诊断发现立即显示，不等待 Skills 分析。
- Skills 分析完成后，只刷新 Skills 区块，不要求重新拉取或重写主诊断报告。
- 若 Skills 分析新表无结果，页面可重新生成，而不是显示旧嵌入数据。

## 风险

- 首次并行运行时，主诊断不会拿到同一轮仍在生成的 Skills 分析作为上下文；这与原有串行方案一致，因为原有方案也是主诊断先跑、Skills 后跑。
- 如果前端只改触发、不改轮询来源，Skills 区块仍会等主报告刷新，无法达到先完成先显示。
- 如果后端仍把 Skills 结果写回 `reportJson`，两个请求交错时仍可能发生整份 JSON 覆盖。

