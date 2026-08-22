# L5 脚本静态 vs LLM 语义分工

> 本文件按 [five-module-test-case-construction-strategy.md](five-module-test-case-construction-strategy.md) 第 5 层结构，验证 [02-error-taxonomy.md](../../../skills/agent-debug-diagnosis/references/02-error-taxonomy.md) 末尾的分工规则——Action/System 优先信脚本，Memory/Reflection/Planning/`tool_misuse` 靠 LLM。构造分工边界用例，确保脚本信号足够时 LLM 不改写，脚本无信号时 LLM 能语义判断。
>
> **用例数**：共 **10** 个（脚本静态 5 / LLM 语义 5），覆盖分工边界两侧。

---

L5-01. Action/nonexistent_path - 脚本静态
- 场景：Action 调用 read 返回 "No such file"，脚本信号足够，LLM 不应改写。
- step N Action：调用 read(file_path="/foo/bar.js")，返回 "No such file or directory"。
- 预期：脚本检测到路径不存在证据，报 nonexistent_path；LLM 不改写为 parameter_error 或其他。

---

L5-02. Action/dangerous_command - 脚本静态
- 场景：Action 执行 `rm -rf /`，脚本检测高危命令，LLM 不应改写。
- step N Action：执行 run_command("rm -rf /")。
- 预期：脚本检测到高危命令，报 dangerous_command；LLM 不改写为 unsafe_destructive_action 或其他。

---

L5-03. Action/format_error - 脚本静态
- 场景：工具入参类型错误（file_path=123），脚本检测 schema 不符，LLM 不应改写。
- step N Action：调用 edit(file_path=123)（应为 string）。
- 预期：脚本检测到 schema 不符，报 format_error；LLM 不改写为 parameter_error 或其他。

---

L5-04. Action/parameter_error - 脚本静态
- 场景：Action 调用 run_command("npm run build") 但项目无 build 脚本，脚本检测参数错误，LLM 不应改写。
- step N Action：执行 run_command("npm run build")，返回 "missing script: build"。
- 预期：脚本检测到参数错误，报 parameter_error；LLM 不改写为 nonexistent_path 或其他。

---

L5-05. Action/redundant_call - 脚本静态
- 场景：连续 3 次 read 相同文件，脚本检测重复调用，LLM 不应改写。
- step N-2 Action：调用 read(file_path="/foo/bar.js")。
- step N-1 Action：调用 read(file_path="/foo/bar.js")。
- step N Action：调用 read(file_path="/foo/bar.js")。
- 预期：脚本检测到重复调用，报 redundant_call；LLM 不改写为其他。

---

L5-06. Action/tool_misuse - LLM 语义
- 场景：任务只需找某函数定义位置，Action 却 read 整个 10000 行文件，脚本无信号，LLM 判断"工具能跑但不合适"。
- step N Action：调用 read(file_path="/large/file.js")（10000 行，只需找函数位置），返回 status=success。
- 预期：脚本无信号（工具正常执行），LLM 判断工具选择不合适，报 tool_misuse。

---

L5-07. Memory/hallucination - LLM 语义
- 场景：step N Memory 引用"用户要求用 v2"，前序用户消息无此内容，脚本无信号，LLM 对照 prior facts 判断。
- prior facts 设置：前序用户消息仅涉及 v1 API 讨论。
- step N Memory：引用"用户要求用 v2"。
- 预期：脚本无信号（无静态错误），LLM 对照 prior facts 判断，报 hallucination。

---

L5-08. Reflection/outcome_misinterpretation - LLM 语义
- 场景：工具返回 status=error，Reflection 称"执行成功"，脚本无信号，LLM 对照工具输出判断。
- step N-1 工具返回：status=error, message="file not found"。
- step N Reflection：称"执行成功"。
- 预期：脚本无信号（无静态错误），LLM 对照工具输出判断，报 outcome_misinterpretation。

---

L5-09. Planning/over_engineering - LLM 语义
- 场景：任务是改一个 typo，Planning 计划"重构整个文件并引入 ESLint"，脚本无信号，LLM 判断复杂度是否合理。
- 任务约束：任务要求改一个 typo。
- step N Planning：计划"重构整个文件并引入 ESLint"。
- 预期：脚本无信号（无静态错误），LLM 判断复杂度不合理，报 over_engineering。

---

L5-10. Memory/forgot_user_constraint - LLM 语义
- 场景：用户说"不要用 root 用户"，step N Memory 给出"用 root 执行"的依据，脚本无信号，LLM 对照用户消息历史判断。
- prior facts 设置：前序用户消息含"不要用 root 用户"。
- step N Memory：给出"用 root 执行"的依据，未提及用户约束。
- 预期：脚本无信号（无静态错误），LLM 对照用户消息历史判断，报 forgot_user_constraint。
