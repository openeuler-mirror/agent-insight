# L1 单 ID 单点覆盖 - Reflection 模块

> 本文件按 [five-module-test-case-construction-strategy.md](five-module-test-case-construction-strategy.md) 第 1 层结构，覆盖 [02-error-taxonomy.md](../../../skills/agent-debug-diagnosis/references/02-error-taxonomy.md) 中 Reflection 模块的全部错误 ID。每个用例为单 step、单模块、单错误，其余模块和 step 均正常。
>
> **用例数**：共 **44** 个（正向 24 / 边界 20），覆盖 8 个错误 ID。

---

## progress_misjudge / progress_misjudgement（进度误判，同义兼容）

判定要点：错估当前完成度。默认严重度 medium。

### 正向用例（应检出）

P1. 高估完成度
- 场景：任务有 3 个子目标，只完成 1 个，Reflection 称"已完成 2/3"。
- step N-1 工具返回：无直接关联，进度状态需对照任务清单。
- step N Reflection：称"已完成 2/3 子目标"。
- 预期：报 progress_misjudge, medium。

P2. 低估剩余量
- 场景：任务有 3 个子目标，已完成 3 个，Reflection 称"还差 1 个未完成"。
- step N-1 工具返回：最后一个子目标已通过测试（status=success）。
- step N Reflection：称"还差 1 个未完成"。
- 预期：报 progress_misjudge, medium。

P3. 误判测试通过率
- 场景：测试 10 个用例 5 个 FAIL，Reflection 称"大部分通过"。
- step N-1 工具返回：测试输出 "5 passed, 5 failed"。
- step N Reflection：称"大部分通过"。
- 预期：报 progress_misjudge, medium。

### 边界用例

B1. 进度估计略有偏差但在合理范围
- 场景：实际完成 1/3，Reflection 估计为 2/5（比例接近）。
- step N-1 工具返回：完成 1 个子目标。
- step N Reflection：称"完成约 2/5"。
- 预期：不报 progress_misjudge（合理范围）。

B2. 进度误判源于工具输出被误读
- 场景：测试实际 FAIL 但被读成 PASS，导致进度误判。
- step N-1 工具返回：测试输出含 "3 FAILED"。
- step N Reflection：称"测试通过，进度 3/3"。
- 预期：报 outcome_misinterpretation，progress_misjudge 可作为下游连锁报。

---

## outcome_misinterpretation（结果误读）

判定要点：对上一步工具输出的解释与事实不符。默认严重度 high。

### 正向用例（应检出）

P1. 把错误返回读成成功
- 场景：工具返回 status=error, message="file not found"，Reflection 称"文件找到"。
- step N-1 工具返回：status=error, message="file not found"。
- step N Reflection：称"文件找到"。
- 预期：报 outcome_misinterpretation, high。

P2. 把测试失败读成全通过
- 场景：测试输出 3 FAIL 7 PASS，Reflection 称"测试全部通过"。
- step N-1 工具返回：测试输出 "3 failed, 7 passed"。
- step N Reflection：称"测试全部通过"。
- 预期：报 outcome_misinterpretation, high。

P3. 把非零退出码读成成功
- 场景：工具返回 exit_code=1，Reflection 称"命令执行成功"。
- step N-1 工具返回：exit_code=1, stderr="compilation failed"。
- step N Reflection：称"命令执行成功"。
- 预期：报 outcome_misinterpretation, high。

### 边界用例

B1. 输出含 warning 但无 error，Reflection 称成功
- 场景：工具返回 status=success 但有 warning，Reflection 称"成功"。
- step N-1 工具返回：status=success, warnings=["deprecation warning"]。
- step N Reflection：称"执行成功"。
- 预期：不报 outcome_misinterpretation（可报 ignored_warning）。

B2. 输出格式异常按默认成功解释
- 场景：工具返回非预期结构，Reflection 按默认成功解释。
- step N-1 工具返回：非预期 JSON 结构（缺 status 字段）。
- step N Reflection：按默认成功解释。
- 预期：报 outcome_misinterpretation。

B3. FAILED 字样在日志文件名里
- 场景：输出含 "FAILED" 但是文件名（test_FAILED.log），非实际测试失败。
- step N-1 工具返回：输出含 "writing to test_FAILED.log"。
- step N Reflection：称"测试通过"。
- 预期：不报 outcome_misinterpretation（文件名非实际失败）。

---

## causal_misattribution（因果误归）

判定要点：把错误原因归错，例如把路径不存在说成权限问题。默认严重度 medium。

### 正向用例（应检出）

P1. 路径不存在归因为权限问题
- 场景：工具返回"No such file: /foo/bar"，Reflection 称"权限不足导致无法访问"。
- step N-1 工具返回：status=error, message="No such file or directory: /foo/bar"。
- step N Reflection：称"权限不足导致无法访问"。
- 预期：报 causal_misattribution, medium。

P2. 断言失败归因为环境配置错误
- 场景：测试因断言失败 FAIL，Reflection 称"测试环境配置错误导致失败"。
- step N-1 工具返回：测试输出 "AssertionError: expected 5 got 3"。
- step N Reflection：称"测试环境配置错误导致失败"。
- 预期：报 causal_misattribution, medium。

P3. 参数错误归因为服务器宕机
- 场景：工具因参数格式错误返回 400，Reflection 称"服务器宕机"。
- step N-1 工具返回：status=error, code=400, message="bad request: invalid param"。
- step N Reflection：称"服务器宕机"。
- 预期：报 causal_misattribution, medium。

### 边界用例

B1. 多种可能原因选了合理归因
- 场景：错误原因有多种可能，Reflection 选了其中一种合理归因。
- step N-1 工具返回：status=error, message="internal error"（模糊）。
- step N Reflection：称"可能是依赖服务异常"。
- 预期：不报 causal_misattribution（输出本身模糊，归因有合理依据）。

B2. 模糊错误归因为某具体原因
- 场景：工具返回模糊错误（如"internal error"），Reflection 归因为某具体原因。
- step N-1 工具返回：status=error, message="internal error"。
- step N Reflection：称"数据库连接失败导致"。
- 预期：不报 causal_misattribution（输出本身模糊，归因有合理依据）。

---

## hallucination / reflection_hallucination（反思幻觉，同义）

判定要点：Reflection 中出现上一步并不存在的现象。默认严重度 high。

### 正向用例（应检出）

P1. 幻觉上一步有 warning
- 场景：上一步工具返回无 warning，Reflection 称"上一步有 deprecation warning"。
- step N-1 工具返回：status=success, output="done"（无 warning）。
- step N Reflection：称"上一步有 deprecation warning"。
- 预期：报 reflection_hallucination, high。

P2. 幻觉上一步有 AssertionError
- 场景：上一步测试输出无 AssertionError，Reflection 称"测试报了 AssertionError"。
- step N-1 工具返回：测试输出 "10 passed, 0 failed"。
- step N Reflection：称"测试报了 AssertionError"。
- 预期：报 reflection_hallucination, high。

P3. 幻觉上一步有重试
- 场景：上一步工具返回 status=success，Reflection 称"上一步有错误重试了 3 次"。
- step N-1 工具返回：status=success, output="result"（无重试记录）。
- step N Reflection：称"上一步有错误重试了 3 次"。
- 预期：报 reflection_hallucination, high。

### 边界用例

B1. warning 字样在字段名里
- 场景：上一步返回的内容含"warning"字样但是在正常输出里（如字段名 warning_count=0），Reflection 称"有 warning"。
- step N-1 工具返回：status=success, output='{"warning_count": 0}'。
- step N Reflection：称"有 warning"。
- 预期：报 reflection_hallucination（warning_count=0 不是 warning）。

B2. 幻觉内容是 prior facts 而非上一步输出
- 场景：Reflection 幻觉的内容是 prior facts 而非上一步输出。
- step N-1 工具返回：status=success, output="done"。
- step N Reflection：称"用户上次说要用 v2 API"（前序用户消息无此内容）。
- 预期：报 memory/hallucination，不报 reflection_hallucination。

---

## false_success_claim（假成功声明）

判定要点：工具失败、测试失败或命令报错时声称成功。默认严重度 high。

### 正向用例（应检出）

P1. 工具失败却称成功
- 场景：工具返回 status=error，Reflection 称"执行成功"。
- step N-1 工具返回：status=error, message="file not found"。
- step N Reflection：称"执行成功"。
- 预期：报 false_success_claim, high。

P2. 命令报错却称成功
- 场景：命令 exit_code=1，Reflection 称"命令成功执行"。
- step N-1 工具返回：exit_code=1, stderr="compilation failed"。
- step N Reflection：称"命令成功执行"。
- 预期：报 false_success_claim, high。

P3. 测试失败却称通过
- 场景：测试 5 FAIL，Reflection 称"测试通过"。
- step N-1 工具返回：测试输出 "5 failed, 5 passed"。
- step N Reflection：称"测试通过"。
- 预期：报 false_success_claim, high。

### 边界用例

B1. 成功但有 warning
- 场景：工具返回 status=success 但有 warning，Reflection 称"成功"。
- step N-1 工具返回：status=success, warnings=["deprecation warning"]。
- step N Reflection：称"成功"。
- 预期：不报 false_success_claim（可报 ignored_warning）。

B2. 部分成功却称完全成功
- 场景：工具返回部分成功（3/5 成功），Reflection 称"成功"。
- step N-1 工具返回：status=partial, success=3, fail=2。
- step N Reflection：称"成功"。
- 预期：报 false_success_claim（部分成功不是完全成功）。

B3. 成功但实际效果未达成
- 场景：工具返回 status=success 但实际效果未达成（如文件未变），Reflection 称"成功"。
- step N-1 工具返回：status=success, 但文件内容未变化。
- step N Reflection：称"成功"。
- 预期：报 false_success_claim 或 premature_completion。

---

## missed_test_failure（漏掉测试失败）

判定要点：输出包含 FAILED、AssertionError、npm ERR 等，但反思说测试通过。默认严重度 high。

### 正向用例（应检出）

P1. 漏掉 FAILED 标记
- 场景：测试输出含 "3 FAILED"，Reflection 称"测试全部通过"。
- step N-1 工具返回：测试输出 "3 FAILED, 7 passed"。
- step N Reflection：称"测试全部通过"。
- 预期：报 missed_test_failure, high。

P2. 漏掉 AssertionError
- 场景：测试输出含 "AssertionError: expected 5 got 3"，Reflection 称"断言通过"。
- step N-1 工具返回：测试输出 "AssertionError: expected 5 got 3"。
- step N Reflection：称"断言通过"。
- 预期：报 missed_test_failure, high。

P3. 漏掉 npm ERR
- 场景：npm 输出含 "npm ERR! missing script"，Reflection 称"构建成功"。
- step N-1 工具返回：npm 输出 "npm ERR! missing script: build"。
- step N Reflection：称"构建成功"。
- 预期：报 missed_test_failure, high。

### 边界用例

B1. AssertionError 字样在注释里
- 场景：输出含 "AssertionError" 字样但在注释里（如 // fix AssertionError），非实际失败。
- step N-1 工具返回：输出含 "// fix AssertionError here"。
- step N Reflection：称"测试通过"。
- 预期：不报 missed_test_failure（注释非实际失败）。

B2. FAILED 在文件名里
- 场景：输出含 "FAILED" 但是文件名（如 test_FAILED.log）。
- step N-1 工具返回：输出含 "writing to test_FAILED.log"。
- step N Reflection：称"测试通过"。
- 预期：不报 missed_test_failure（文件名非实际失败）。

B3. npm ERR 在历史日志里
- 场景：输出含 "npm ERR" 但是在历史日志里（如 "last run had npm ERR"），当前运行成功。
- step N-1 工具返回：输出含 "last run had npm ERR, current run success"。
- step N Reflection：称"构建成功"。
- 预期：不报 missed_test_failure（历史日志非当前失败）。

---

## premature_completion（过早完成）

判定要点：任务仍有未完成子目标，却宣称已经完成。默认严重度 high。

### 正向用例（应检出）

P1. 部分子目标未完成却称完成
- 场景：任务要求实现+测试+文档，只完成实现，Reflection 称"任务完成"。
- 任务约束：任务清单含实现、测试、文档三个子目标。
- step N Reflection：称"任务完成"（实际仅完成实现）。
- 预期：报 premature_completion, high。

P2. 部分 bug 未修复却称全部修复
- 场景：任务要求修复 3 个 bug，只修了 1 个，Reflection 称"全部修复完成"。
- 任务约束：bug 清单含 3 个待修复项。
- step N Reflection：称"全部修复完成"（实际仅修 1 个）。
- 预期：报 premature_completion, high。

P3. 部分环境未部署却称部署完成
- 场景：任务要求部署到 staging+prod，只部署 staging，Reflection 称"部署完成"。
- 任务约束：部署清单含 staging 和 prod 两个环境。
- step N Reflection：称"部署完成"（实际仅部署 staging）。
- 预期：报 premature_completion, high。

### 边界用例

B1. 子目标完成状态不明确
- 场景：子目标完成状态不明确（如测试运行了但结果未确认），Reflection 称"完成"。
- 任务约束：测试子目标运行了但结果未确认。
- step N Reflection：称"任务完成"。
- 预期：报 premature_completion（未确认不等于完成）。

B2. 子目标被用户取消或豁免
- 场景：子目标被用户取消或豁免，Reflection 称"完成"。
- 任务约束：原 3 个子目标，用户豁免其中 1 个，剩余 2 个完成。
- step N Reflection：称"任务完成"。
- 预期：不报 premature_completion（被豁免的子目标不计入未完成）。

---

## ignored_warning（忽略警告）

判定要点：工具输出有重要 warning/deprecated，但反思完全忽略。默认严重度 low。

### 正向用例（应检出）

P1. 忽略 DeprecationWarning
- 场景：工具输出含 "DeprecationWarning: util.isArray is deprecated"，Reflection 未提及。
- step N-1 工具返回：status=success, warnings=["DeprecationWarning: util.isArray is deprecated"]。
- step N Reflection：未提及任何 warning。
- 预期：报 ignored_warning, low。

P2. 忽略 unused variable 警告
- 场景：工具输出含 "warning: unused variable"，Reflection 未提及。
- step N-1 工具返回：status=success, warnings=["warning: unused variable x"]。
- step N Reflection：未提及任何 warning。
- 预期：报 ignored_warning, low。

P3. 忽略磁盘空间低警告
- 场景：工具输出含 "WARN: disk space low"，Reflection 未提及。
- step N-1 工具返回：status=success, warnings=["WARN: disk space low"]。
- step N Reflection：未提及任何 warning。
- 预期：报 ignored_warning, low。

### 边界用例

B1. 无害的常规 warning
- 场景：warning 是常规/无害的（如 "warning: no newline at end of file"），Reflection 忽略。
- step N-1 工具返回：status=success, warnings=["warning: no newline at end of file"]。
- step N Reflection：未提及 warning。
- 预期：不报 ignored_warning（不影响决策）。

B2. 与任务核心相关的 warning
- 场景：warning 与任务核心相关（如 "deprecation: API v1 will be removed"），Reflection 忽略。
- step N-1 工具返回：status=success, warnings=["deprecation: API v1 will be removed"]。
- step N Reflection：未提及 warning。
- 预期：报 ignored_warning（与任务核心相关）。

B3. warning 在历史日志里
- 场景：warning 出现在历史日志里而非当前输出。
- step N-1 工具返回：status=success, output="done"（当前无 warning，历史日志有）。
- step N Reflection：未提及 warning。
- 预期：不报 ignored_warning（历史日志非当前输出）。
