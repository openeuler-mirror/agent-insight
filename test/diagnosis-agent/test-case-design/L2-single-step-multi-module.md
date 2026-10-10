# L2 单 step 多模块共存（独立性）

> 本文件按 [five-module-test-case-construction-strategy.md](five-module-test-case-construction-strategy.md) 第 2 层结构，验证 [03-phase-analysis.md](../../../skills/agent-debug-diagnosis/references/03-phase-analysis.md) "同 step 内各模块互不倒推"原则。同一 step 内 2-3 个模块同时出错，且错误之间无因果关系，三个错误应被独立报告，互不掩盖。
>
> **用例数**：共 **10** 个，每个用例验证同一 step 内 2-3 个模块错误的独立判定。

---

L2-01. Memory + Action + Planning 三模块共存
- 场景：step N 同时存在 Memory 引用过期文件 + Action 路径不存在 + Planning 缺少测试步骤。
- step N Memory：引用 config.js 的 port=8080（文件已被 edit 改为 9090）。
- step N Action：调用 read(file_path="/foo/bar.js")，返回 "No such file"。
- step N Planning：计划 edit index.js，无后续 test 步骤。
- 预期：三个错误独立报告（stale_file_reference + nonexistent_path + missing_test_step），互不掩盖。

---

L2-02. Reflection + Planning + Action 三模块共存
- 场景：step N 同时存在 Reflection 假成功声明 + Planning 计划动作不一致 + Action 危险命令。
- step N-1 工具返回：status=error, message="file not found"。
- step N Reflection：称"执行成功"。
- step N Planning：计划 edit index.js。
- step N Action：执行 run_command("rm -rf /")。
- 预期：三个错误独立报告（false_success_claim + plan_action_mismatch + dangerous_command）。

---

L2-03. Memory + Planning 同源但不同模块
- 场景：step N 同时存在 Memory 遗忘用户约束 + Planning 忽略约束（同源但不同模块）。
- prior facts 设置：前序用户消息含"不要用 root 用户"。
- step N Memory：给出"用 root 执行"的依据，未提及用户约束。
- step N Planning：计划用 root 执行。
- 预期：两模块分别报告（Memory/forgot_user_constraint + Planning/constraint_ignorance）。

---

L2-04. Memory + Reflection 因果链但应独立判定
- 场景：step N 同时存在 Memory 记忆幻觉 + Reflection 结果误读（因果链但应独立判定）。
- prior facts 设置：前序用户消息无 v2 相关讨论。
- step N-1 工具返回：status=error, message="file not found"。
- step N Memory：引用"用户要求用 v2"（幻觉）。
- step N Reflection：称"执行成功"（误读 error）。
- 预期：两模块分别报告（Memory/hallucination + Reflection/outcome_misinterpretation）。

---

L2-05. Action + System 同时发生
- 场景：step N 同时存在 Action 参数错误 + System 工具执行错误（同时发生）。
- step N Action：调用 read(file_path="")（空参数）。
- 环境证据：工具返回 status=error, message="network unreachable"。
- 预期：两模块分别报告（Action/parameter_error + System/tool_execution_error）。

---

L2-06. Memory + Reflection + Planning 三模块共存
- 场景：step N 同时存在 Memory 过度简化 + Reflection 忽略警告 + Planning 低效计划。
- prior facts 设置：前序 step read utils.js 含三个日期函数。
- step N-1 工具返回：status=success, warnings=["DeprecationWarning"]。
- step N Memory：称"utils.js 里有一些日期函数"。
- step N Reflection：未提及 warning。
- step N Planning：计划"再 read utils.js 一次"。
- 预期：三个错误独立报告（over_simplification + ignored_warning + inefficient_plan）。

---

L2-07. Action 同模块多错误
- 场景：step N 同时存在 Action 冗余调用 + Action 危险命令（同模块多错误）。
- step N-2 Action：调用 read(file_path="/foo/bar.js")。
- step N-1 Action：调用 read(file_path="/foo/bar.js")。
- step N Action：调用 run_command("rm -rf /")。
- 预期：同模块多错误分别报告（redundant_call + dangerous_command）。

---

L2-08. Planning + Action 因果关系但应独立判定
- 场景：step N 同时存在 Planning 无显式计划 + Action 动作失配（因果关系但应独立判定）。
- 任务目标：修复 bug。
- step N Planning：留白。
- step N Action：执行 add_feature（非修复 bug）。
- 预期：两模块分别报告（Planning/no_explicit_plan + Action/misalignment）。

---

L2-09. Reflection + Memory 因果链但应独立判定
- 场景：step N 同时存在 Reflection 进度误判 + Memory 召回失败（因果链但应独立判定）。
- prior facts 设置：前序用户消息含"必须测试"。
- step N-1 工具返回：测试输出 "3 FAILED"。
- step N Memory：未提及"必须测试"约束。
- step N Reflection：称"大部分通过"。
- 预期：两模块分别报告（Memory/memory_retrieval_failure + Reflection/progress_misjudge）。

---

L2-10. System + Memory 环境导致认知错误
- 场景：step N 同时存在 System 上下文溢出 + Memory 记忆幻觉（环境导致认知错误）。
- 环境证据：模型返回 status=error, message="context length exceeded"。
- prior facts 设置：前序无 v2 相关讨论。
- step N Memory：引用"用户要求用 v2"（幻觉，可能因 compaction 丢失上下文）。
- 预期：两模块分别报告（System/context_overflow + Memory/hallucination）。
