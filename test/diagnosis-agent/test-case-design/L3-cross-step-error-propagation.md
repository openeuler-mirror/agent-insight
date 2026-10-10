# L3 跨 step 错误传播（时序）

> 本文件按 [five-module-test-case-construction-strategy.md](five-module-test-case-construction-strategy.md) 第 3 层结构，验证 priorWindow 稳定性和错误沿时序的因果传递。错误 A 在 step N 产生，错误 B 在 step N+1 因 A 而发生（但系统应独立判定 B，不倒推 A），三个错误应分别在各自 step 被识别，priorWindow 不应回溯改写。
>
> **用例数**：共 **5** 个，每个用例验证一条跨 step 传播链（含 3 个错误节点）。

---

L3-01. Memory → Reflection → Planning 传播链
- 场景：step N Memory 引用过期文件 → step N+1 Reflection 基于过期文件做结果误读 → step N+2 Planning 基于误读制定错误计划。
- step N Memory：引用 config.js 的 port=8080（文件已被 edit 改为 9090）。
- step N+1 Reflection：基于 port=8080 误读工具返回（称"服务在 8080 正常"，实际 9090）。
- step N+2 Planning：基于"8080 正常"制定错误计划（如计划重启 8080 端口的服务）。
- 预期：三个错误分别在各自 step 被识别（stale_file_reference + outcome_misinterpretation + wrong_file_target），priorWindow 不回溯改写。

---

L3-02. Memory → Planning → Action 传播链
- 场景：step N Memory 遗忘用户约束 → step N+1 Planning 忽略约束 → step N+2 Action 执行违背约束的操作。
- prior facts 设置：前序用户消息含"不要用 root 用户"。
- step N Memory：给出"用 root 执行"的依据，未提及用户约束。
- step N+1 Planning：计划用 root 执行。
- step N+2 Action：执行 run_command("sudo rm /root/file")。
- 预期：三个错误分别报告（forgot_user_constraint + constraint_ignorance + misalignment），不倒推。

---

L3-03. Action → Reflection → Planning 传播链
- 场景：step N Action 路径不存在 → step N+1 Reflection 误读结果（称成功）→ step N+2 Planning 基于假成功制定后续计划。
- step N Action：调用 read(file_path="/foo/bar.js")，返回 "No such file"。
- step N+1 Reflection：称"文件读取成功"（误读 error）。
- step N+2 Planning：基于"读取成功"计划后续 edit /foo/bar.js。
- 预期：三个错误分别报告（nonexistent_path + outcome_misinterpretation + wrong_file_target）。

---

L3-04. System → Action → Reflection 传播链
- 场景：step N System 认证失败 → step N+1 Action 重试（冗余调用）→ step N+2 Reflection 假成功声明（误以为恢复）。
- step N 环境证据：工具返回 status=error, code=401。
- step N+1 Action：连续 3 次重试相同调用（冗余）。
- step N+2 Reflection：称"上一步执行成功"（误读，实际仍 401）。
- 预期：三个错误分别报告（auth_failure + redundant_call + false_success_claim）。

---

L3-05. Memory → Planning → Action 幻觉传播链
- 场景：step N Memory 记忆幻觉 → step N+1 Planning 基于幻觉制定计划 → step N+2 Action 执行基于幻觉的计划。
- prior facts 设置：前序无 v2 相关讨论。
- step N Memory：引用"用户要求用 v2"（幻觉）。
- step N+1 Planning：基于"用户要求用 v2"计划迁移到 v2 API。
- step N+2 Action：执行 v2 API 迁移操作。
- 预期：三个错误分别报告（hallucination + misalignment + misalignment），Memory 错误不因后续 Planning/Action 执行而消失。
