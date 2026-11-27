# L1 单 ID 单点覆盖 - System 模块

> 本文件按 [five-module-test-case-construction-strategy.md](five-module-test-case-construction-strategy.md) 第 1 层结构，覆盖 [02-error-taxonomy.md](../../../skills/agent-debug-diagnosis/references/02-error-taxonomy.md) 中 System 模块的全部错误 ID。每个用例为单 step、单模块、单错误，其余模块和 step 均正常。System 是外部证据，不能自动说明 Agent 的认知模块出错。
>
> **用例数**：共 **47** 个（正向 26 / 边界 21），覆盖 9 个错误 ID。

---

## step_limit（步数限制）

判定要点：session 或任务步数触达限制。默认严重度 medium。

### 正向用例（应检出）

P1. session 步数达到上限
- 场景：session 步数达到上限（如 100 步），系统返回 step_limit 错误。
- 环境证据：系统返回 "step_limit_exceeded: max 100 steps reached"。
- 预期：报 step_limit, medium。

P2. 任务配置 max_steps=50，第 51 步被拒
- 场景：任务配置 max_steps=50，第 51 步被系统拒绝。
- 环境证据：系统返回 "step_limit_exceeded: max 50 steps reached at step 51"。
- 预期：报 step_limit, medium。

### 边界用例

B1. 步数触达限制但系统自动续期
- 场景：步数触达限制但系统自动续期（无错误返回）。
- 环境证据：当前 step=100，max_steps=100，系统自动续期到 200。
- 预期：不报 step_limit（已续期）。

B2. 步数触达限制源于 Agent 陷入循环
- 场景：步数触达限制源于 Agent 陷入循环。
- 环境证据：系统返回 step_limit，且 trace 显示连续重复动作。
- 预期：报 step_limit + trajectory detector（循环导致步数耗尽）。

---

## tool_execution_error（工具执行错误）

判定要点：工具或外部环境返回错误。默认严重度 medium。

### 正向用例（应检出）

P1. 工具返回 internal error
- 场景：工具执行返回 status=error, message="internal error"。
- 环境证据：工具返回 status=error, message="internal error"。
- 预期：报 tool_execution_error, medium。

P2. 工具超时
- 场景：工具执行超时返回 timeout。
- 环境证据：工具返回 status=error, message="timeout after 60s"。
- 预期：报 tool_execution_error, medium。

P3. 工具返回 connection refused
- 场景：工具执行返回 status=error, message="connection refused"。
- 环境证据：工具返回 status=error, message="connection refused"。
- 预期：报 tool_execution_error, medium。

### 边界用例

B1. 工具返回错误但源于参数错误
- 场景：工具返回错误但源于参数错误。
- 环境证据：工具返回 status=error, message="invalid param: file_path empty"。
- 预期：报 parameter_error，不报 tool_execution_error。

B2. 工具返回错误但源于认证失败
- 场景：工具返回错误但源于认证失败。
- 环境证据：工具返回 status=error, code=401, message="Unauthorized"。
- 预期：报 auth_failure，不报 tool_execution_error。

B3. Agent 参数无误（纯环境问题）
- 场景：工具返回错误但 Agent 参数无误（纯环境问题）。
- 环境证据：工具返回 status=error, message="network unreachable"，参数正确。
- 预期：报 tool_execution_error（环境侧错误）。

---

## llm_limit（模型输出限制）

判定要点：输出长度、token 或模型限制。默认严重度 medium。

### 正向用例（应检出）

P1. 输出被截断（max_tokens）
- 场景：模型输出被截断（max_tokens 触达）。
- 环境证据：模型返回 finish_reason="length"（max_tokens 触达）。
- 预期：报 llm_limit, medium。

P2. 模型返回 rate limit exceeded
- 场景：模型返回 "rate limit exceeded"。
- 环境证据：模型返回 status=error, message="rate limit exceeded"。
- 预期：报 llm_limit, medium。

P3. 模型返回 context length exceeded
- 场景：模型返回 "context length exceeded"。
- 环境证据：模型返回 status=error, message="context length exceeded"。
- 预期：报 llm_limit, medium。

### 边界用例

B1. 输出被截断但语义完整
- 场景：输出被截断但语义完整（截断在空白处）。
- 环境证据：模型返回 finish_reason="length"，但截断在段落末尾。
- 预期：不报 llm_limit（语义完整）。

B2. context length exceeded 也属于 context_overflow
- 场景：context length exceeded 也属于 context_overflow。
- 环境证据：模型返回 status=error, message="context length exceeded"。
- 预期：报 context_overflow（更具体），llm_limit 可补充。

---

## environment_error（环境错误）

判定要点：沙箱、网络、文件系统、依赖环境异常。默认严重度 medium。

### 正向用例（应检出）

P1. 沙箱无网络访问
- 场景：沙箱无网络访问，工具返回 "network unreachable"。
- 环境证据：工具返回 status=error, message="network unreachable"。
- 预期：报 environment_error, medium。

P2. 文件系统只读
- 场景：文件系统只读，edit 返回 "read-only file system"。
- 环境证据：工具返回 status=error, message="read-only file system"。
- 预期：报 environment_error, medium。

P3. 依赖缺失
- 场景：依赖缺失，工具返回 "Module not found: express"。
- 环境证据：工具返回 status=error, message="Module not found: express"。
- 预期：报 environment_error, medium。

### 边界用例

B1. 网络错误但 Agent 参数无误
- 场景：网络错误但 Agent 参数无误（纯环境问题）。
- 环境证据：工具返回 status=error, message="network unreachable"，参数正确。
- 预期：报 environment_error。

B2. 依赖缺失源于 Agent 未安装
- 场景：依赖缺失源于 Agent 未安装（应在计划中处理）。
- 环境证据：工具返回 status=error, message="Module not found: mymodule"（Agent 自定义模块）。
- 预期：报 impossible_action 或 tool_execution_error，不报 environment_error。

---

## context_overflow（上下文溢出）

判定要点：模型或 agent 上下文超限。默认严重度 high。

### 正向用例（应检出）

P1. 模型返回 context length exceeded 128k
- 场景：模型返回 "context length exceeded 128k tokens"。
- 环境证据：模型返回 status=error, message="context length exceeded 128k tokens"。
- 预期：报 context_overflow, high。

P2. Agent 上下文超限，系统强制 compaction
- 场景：Agent 上下文超限，系统强制 compaction。
- 环境证据：系统日志显示 "context overflow, forced compaction"。
- 预期：报 context_overflow, high。

P3. 模型返回 maximum context window reached
- 场景：模型返回 "maximum context window reached"。
- 环境证据：模型返回 status=error, message="maximum context window reached"。
- 预期：报 context_overflow, high。

### 边界用例

B1. 超限但系统自动 compaction 后继续
- 场景：上下文超限但系统自动 compaction 后继续。
- 环境证据：系统日志显示 "context overflow, auto compaction, continue"。
- 预期：不报 context_overflow（已恢复），可记为 resource-runaway 信号。

B2. 超限导致输出截断
- 场景：上下文超限导致输出截断。
- 环境证据：模型返回 status=error, message="context length exceeded" + finish_reason="length"。
- 预期：报 context_overflow + llm_limit。

---

## user_aborted（用户中断）

判定要点：用户或系统主动取消。默认严重度 medium。

### 正向用例（应检出）

P1. 用户点击"停止"按钮
- 场景：用户点击"停止"按钮，session 被取消。
- 环境证据：系统日志显示 "user clicked stop button, session aborted"。
- 预期：报 user_aborted, medium。

P2. 系统超时自动取消任务
- 场景：系统超时自动取消任务。
- 环境证据：系统日志显示 "session timeout, auto abort"。
- 预期：报 user_aborted, medium。

P3. 用户 Ctrl+C 中断命令
- 场景：用户 Ctrl+C 中断命令。
- 环境证据：工具返回 status=error, message="interrupted by user (Ctrl+C)"。
- 预期：报 user_aborted, medium。

### 边界用例

B1. 用户取消但任务已接近完成
- 场景：用户取消但任务已接近完成（如 95%）。
- 环境证据：用户点击停止，任务进度 95%。
- 预期：报 user_aborted（仍属中断）。

B2. 系统因 step_limit 自动取消
- 场景：系统因 step_limit 自动取消。
- 环境证据：系统日志显示 "step_limit reached, auto abort"。
- 预期：报 step_limit，不报 user_aborted。

---

## auth_failure（认证失败）

判定要点：token、权限、认证配置失败。默认严重度 high。

### 正向用例（应检出）

P1. 工具返回 401 Unauthorized
- 场景：工具返回 "401 Unauthorized"。
- 环境证据：工具返回 status=error, code=401, message="Unauthorized"。
- 预期：报 auth_failure, high。

P2. 工具返回 403 Forbidden
- 场景：工具返回 "403 Forbidden: insufficient permissions"。
- 环境证据：工具返回 status=error, code=403, message="Forbidden: insufficient permissions"。
- 预期：报 auth_failure, high。

P3. 工具返回 invalid API key
- 场景：工具返回 "invalid API key"。
- 环境证据：工具返回 status=error, message="invalid API key"。
- 预期：报 auth_failure, high。

### 边界用例

B1. 日志含 "401" 但是日期
- 场景：日志含 "401" 但是日期（如 20260401）或文件名。
- 环境证据：工具输出含 "date: 20260401"。
- 预期：不报 auth_failure。

B2. 业务日志含 "login failed"
- 场景：业务日志含 "login failed"（被诊断对象的事件，非诊断工具自身）。
- 环境证据：工具输出含 "user login failed"（业务事件）。
- 预期：不报 auth_failure（业务事件非系统认证）。

B3. 单次 401 后 refresh_token 成功
- 场景：单次 401 后 refresh_token 成功。
- 环境证据：工具首次返回 401，随后 refresh_token 后返回 200。
- 预期：不报 auth_failure（已恢复），可报 retry-storm 信号。

---

## schema_violation（结构输出违规）

判定要点：结构化输出不符合约束。默认严重度 medium。

### 正向用例（应检出）

P1. 应输出 JSON 实际输出自然语言
- 场景：模型应输出 JSON `{"result": string}`，实际输出自然语言。
- 环境证据：模型输出 "task completed successfully"（非 JSON）。
- 预期：报 schema_violation, medium。

P2. 枚举值超出范围
- 场景：模型应输出 `{"status": "success"|"failure"}`，实际输出 `{"status": "maybe"}`。
- 环境证据：模型输出 `{"status": "maybe"}`（非允许值）。
- 预期：报 schema_violation, medium。

P3. 类型不符（应数组实际对象）
- 场景：模型应输出数组，实际输出对象。
- 环境证据：模型输出 `{"items": [...]}`（应直接为数组）。
- 预期：报 schema_violation, medium。

### 边界用例

B1. 输出符合 schema 但字段值语义错误
- 场景：输出符合 schema 但字段值语义错误。
- 环境证据：模型输出 `{"status": "success"}` 但实际失败。
- 预期：不报 schema_violation（可报其他模块错误）。

B2. 输出符合 schema 但多余字段
- 场景：输出符合 schema 但多余字段。
- 环境证据：模型输出 `{"status": "success", "extra": "ignored"}`。
- 预期：不报 schema_violation（多余字段不违规）。

---

## step_timeout（单步超时）

判定要点：单个 step 耗时超过阈值。默认严重度 low。

### 正向用例（应检出）

P1. step 耗时 120s，阈值 60s
- 场景：单个 step 耗时 120s，阈值 60s。
- 环境证据：step 时长=120s，阈值=60s。
- 预期：报 step_timeout, low。

P2. step 耗时 300s，阈值 120s
- 场景：单个 step 耗时 300s，阈值 120s。
- 环境证据：step 时长=300s，阈值=120s。
- 预期：报 step_timeout, low。

P3. step 耗时 600s，阈值 300s
- 场景：单个 step 耗时 600s，阈值 300s。
- 环境证据：step 时长=600s，阈值=300s。
- 预期：报 step_timeout, low。

### 边界用例

B1. step 耗时接近阈值但未超
- 场景：step 耗时接近阈值但未超（如 59s vs 60s）。
- 环境证据：step 时长=59s，阈值=60s。
- 预期：不报 step_timeout。

B2. step 耗时超阈值但源于工具正常慢
- 场景：step 耗时超阈值但源于工具正常慢（如大文件 read）。
- 环境证据：step 时长=120s，阈值=60s，工具是大文件 read。
- 预期：报 step_timeout（超阈值即报，原因另判）。

B3. step 耗时超阈值但系统自动续期
- 场景：step 耗时超阈值但系统自动续期。
- 环境证据：step 时长=120s，阈值=60s，系统自动续期。
- 预期：不报 step_timeout（未实际超时）。
