# L6 Phase 0 系统风险预检

> 本文件按 [five-module-test-case-construction-strategy.md](five-module-test-case-construction-strategy.md) 第 6 层结构，验证 [03-phase-analysis.md](../../../skills/agent-debug-diagnosis/references/03-phase-analysis.md) Phase 0 的预检规则。Phase 0 用于在进入逐 step 诊断前识别系统性风险，避免在系统级故障下做无意义的认知诊断。
>
> **用例数**：共 **4** 个（正向 4），验证系统风险的检出。

---

L6-01. 连续 401 认证失败（正向）
- 场景：连续多次 401 认证失败（如连续 3 步工具返回 401），属系统性认证问题。
- 环境证据：step N-2 工具返回 401，step N-1 工具返回 401，step N 工具返回 401。
- 预期：报 system/auth_failure（系统性认证故障，非单次偶发）。

---

L6-02. 上下文溢出（正向）
- 场景：上下文溢出（模型返回 context length exceeded），属系统性上下文超限。
- 环境证据：模型返回 status=error, message="context length exceeded 128k tokens"。
- 预期：报 system/context_overflow（系统性上下文超限）。

---

L6-03. 工具系统性不可用（正向）
- 场景：工具系统性不可用（连续多步工具执行均返回 error），属系统性工具故障。
- 环境证据：step N-2 工具返回 error，step N-1 工具返回 error，step N 工具返回 error（不同工具均失败）。
- 预期：报 system/tool_execution_error（系统性工具不可用）。

---

L6-04. 早期用户取消（正向）
- 场景：早期用户取消（任务前期用户主动中断 session），属系统性中断。
- 环境证据：step 3 用户点击停止按钮，session 被取消。
- 预期：报 system/user_aborted（早期系统性中断，后续 step 无需诊断）。


