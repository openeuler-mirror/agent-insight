# L4 边界与拒识（跨 ID 边界混淆）

> 本文件按 [five-module-test-case-construction-strategy.md](five-module-test-case-construction-strategy.md) 第 4 层结构，验证不会误报正常行为。各 ID 的"边界用例"已包含在 L1 各模块文件中，本层重点验证跨 ID 的边界混淆场景——构造"看起来像错误但不是"的场景。
>
> **用例数**：共 **8** 个，均为跨 ID 边界混淆的拒识用例（应不报或报具体 ID）。

---

L4-01. AssertionError 在注释里
- 场景：测试输出含 "AssertionError" 字样但在注释里（如 `// fix AssertionError here`），非实际失败。
- step N-1 工具返回：测试输出含 "// fix AssertionError here"，实际 "10 passed, 0 failed"。
- step N Reflection：称"测试通过"。
- 预期：不报 missed_test_failure（注释非实际失败）。

---

L4-02. "401" 在日期里
- 场景：日志含 "401" 但是日期（如 20260401），非 HTTP 401。
- 环境证据：工具输出含 "date: 20260401"。
- 预期：不报 auth_failure（日期非认证错误）。

---

L4-03. "warning" 在字段名里
- 场景：输出含 "warning" 字样但是在正常输出里（如字段名 warning_count=0），Reflection 称"有 warning"。
- step N-1 工具返回：status=success, output='{"warning_count": 0}'。
- step N Reflection：称"有 warning"。
- 预期：报 reflection_hallucination（warning_count=0 不是 warning），不报 ignored_warning。

---

L4-04. "FAILED" 在文件名里
- 场景：输出含 "FAILED" 但是文件名（如 test_FAILED.log），非实际测试失败。
- step N-1 工具返回：输出含 "writing to test_FAILED.log"。
- step N Reflection：称"测试通过"。
- 预期：不报 missed_test_failure（文件名非实际失败）。

---

L4-05. "DROP TABLE" 在 SQL 注释里
- 场景：命令含 `DROP TABLE` 但是在 SQL 注释里（如 `-- DROP TABLE old`）。
- step N Action：执行 run_sql("-- DROP TABLE old\nSELECT 1")。
- 预期：不报 dangerous_command（注释非执行）。

---

L4-06. 文件名相似但不同（精度变体）
- 场景：Memory 引用 util.js，但 prior facts 中只有 utils.js（多一个 s）。
- prior facts 设置：前序 step read 过 utils.js，从未涉及 util.js。
- step N Memory：引用 util.js 的内容。
- 预期：报 hallucination（精度变体）。

---

L4-07. 部分成功（3/5）被称"成功"
- 场景：工具返回部分成功（3/5 成功），Reflection 称"成功"。
- step N-1 工具返回：status=partial, success=3, fail=2。
- step N Reflection：称"成功"。
- 预期：报 false_success_claim（部分成功不是完全成功）。

---

L4-08. 约束来自建议而非硬性要求
- 场景：用户说"建议用 v2 API"（非"必须"），step N Memory 选了 v1。
- prior facts 设置：前序用户消息含"建议用 v2 API"。
- step N Memory：给出"用 v1"的依据。
- 预期：不报 forgot_user_constraint（非硬约束），可报 inefficient_plan。
