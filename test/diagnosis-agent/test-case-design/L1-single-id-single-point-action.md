# L1 单 ID 单点覆盖 - Action 模块

> 本文件按 [five-module-test-case-construction-strategy.md](five-module-test-case-construction-strategy.md) 第 1 层结构，覆盖 [02-error-taxonomy.md](../../../skills/agent-debug-diagnosis/references/02-error-taxonomy.md) 中 Action 模块的全部错误 ID。每个用例为单 step、单模块、单错误，其余模块和 step 均正常。
>
> **用例数**：共 **51** 个（正向 28 / 边界 23），覆盖 9 个错误 ID。

---

## misalignment（动作失配）

判定要点：与计划或任务目标明显不一致。默认严重度 high。

### 正向用例（应检出）

P1. Action 与任务目标不一致
- 场景：任务目标"修复 bug"，Action 执行了"添加新功能"。
- step N Action：执行 add_feature 代码（非修复 bug）。
- 预期：报 misalignment, high。

P2. Action 与 Planning 计划不一致
- 场景：Planning 计划 edit index.js，Action 执行了 deploy。
- step N Planning：计划 edit index.js。
- step N Action：执行 deploy。
- 预期：报 misalignment, high。

P3. Action 与任务目标相反
- 场景：任务目标"读取配置"，Action 执行了删除文件。
- step N Action：执行 rm config.js。
- 预期：报 misalignment, high。

### 边界用例

B1. Action 与目标间接相关
- 场景：Action 与目标间接相关（如为目标做准备）。
- 任务目标：修复 bug。
- step N Action：执行 read index.js（为修复 bug 做准备）。
- 预期：不报 misalignment。

B2. Planning 留白，Action 与任务目标一致
- 场景：Planning 留白，Action 与任务目标一致。
- step N Planning：留白。
- step N Action：执行 edit index.js（与任务目标一致）。
- 预期：不报 misalignment（可报 no_explicit_plan）。

---

## invalid_action（无效动作）

判定要点：工具不存在、命令不可用、动作无法执行。默认严重度 high。

### 正向用例（应检出）

P1. 调用不存在的工具
- 场景：Action 调用工具 `query_db`，但工具清单无此工具。
- step N Action：调用 query_db（工具清单无此工具）。
- 预期：报 invalid_action, high。

P2. 执行不存在的命令
- 场景：Action 执行命令 `tree`，但环境无此命令（command not found）。
- step N Action：执行 run_command("tree")，返回 "command not found"。
- 预期：报 invalid_action, high。

P3. 调用工具的无效方法
- 场景：Action 调用工具的无效方法（如 tool.not_exist_method）。
- step N Action：调用 tool.not_exist_method。
- 预期：报 invalid_action, high。

### 边界用例

B1. 工具存在但参数错误导致无法执行
- 场景：工具存在但参数错误导致无法执行。
- step N Action：调用 read(file_path="")（空参数）。
- 预期：报 parameter_error，不报 invalid_action。

B2. 命令存在但权限不足导致无法执行
- 场景：命令存在但权限不足导致无法执行。
- step N Action：执行 run_command("sudo rm /root/file")，返回 "permission denied"。
- 预期：报 system/auth_failure 或 environment_error，不报 invalid_action。

---

## format_error（格式错误）

判定要点：工具入参或返回结构不符合 schema。默认严重度 medium。

### 正向用例（应检出）

P1. 入参类型错误
- 场景：工具入参应为 JSON 对象，实际传入字符串。
- step N Action：调用 edit(changes="string instead of array")。
- 预期：报 format_error, medium。

P2. 入参缺少必填字段
- 场景：工具入参缺少必填字段（如 edit 缺 file_path）。
- step N Action：调用 edit(changes=[...])（无 file_path）。
- 预期：报 format_error, medium。

P3. 入参字段类型错误
- 场景：工具入参类型错误（如 file_path 应为 string 实际传 int）。
- step N Action：调用 edit(file_path=123)。
- 预期：报 format_error, medium。

### 边界用例

B1. 入参有多余字段但工具忽略
- 场景：入参有多余字段但工具忽略冗余字段后正常执行。
- step N Action：调用 edit(file_path="/src/index.js", changes=[...], extra="ignored")。
- 预期：不报 format_error。

B2. 入参字段值语义错误但格式正确
- 场景：入参字段值虽然合法但语义错误（如 file_path="/etc/passwd" 格式对但目标错）。
- step N Action：调用 edit(file_path="/etc/passwd")。
- 预期：报 parameter_error 或 wrong_file_target，不报 format_error。

---

## parameter_error（参数错误）

判定要点：参数、命令、路径、选项选择不当导致失败。默认严重度 medium。

### 正向用例（应检出）

P1. 路径参数不存在
- 场景：Action 调用 edit(file_path="/foo/bar.js") 但路径不存在。
- step N Action：调用 edit(file_path="/foo/bar.js")，返回 "No such file"。
- 预期：报 parameter_error, medium。

P2. 命令脚本不存在
- 场景：Action 调用 run_command(cmd="npm run build") 但项目无 build 脚本。
- step N Action：执行 run_command("npm run build")，返回 "missing script: build"。
- 预期：报 parameter_error, medium。

P3. 空查询参数
- 场景：Action 调用 search(query="") 空查询。
- step N Action：调用 search(query="")。
- 预期：报 parameter_error, medium。

### 边界用例

B1. 路径不存在导致失败
- 场景：路径不存在导致失败。
- step N Action：调用 read(file_path="/foo/bar.js")，返回 "No such file"。
- 预期：报 nonexistent_path（更具体），parameter_error 可作补充。

B2. 参数格式错误导致失败
- 场景：参数格式错误导致失败。
- step N Action：调用 edit(file_path=123)（类型错误）。
- 预期：报 format_error，不报 parameter_error。

B3. 参数正确但环境问题导致失败
- 场景：参数正确但环境问题导致失败。
- step N Action：调用 read(file_path="/src/index.js")，返回 "network unreachable"。
- 预期：报 system/tool_execution_error，不报 parameter_error。

---

## nonexistent_path（路径不存在）

判定要点：输出包含 No such file、not found 等路径不存在证据。默认严重度 medium。

### 正向用例（应检出）

P1. read 不存在的文件
- 场景：Action 执行 read("/foo/bar.js")，返回 "No such file or directory"。
- step N Action：调用 read(file_path="/foo/bar.js")，返回 "No such file or directory"。
- 预期：报 nonexistent_path, medium。

P2. ls 不存在的目录
- 场景：Action 执行 run_command("ls /nonexistent")，返回 "No such file or directory"。
- step N Action：执行 run_command("ls /nonexistent")，返回 "No such file or directory"。
- 预期：报 nonexistent_path, medium。

P3. edit 不存在的路径
- 场景：Action 执行 edit("/missing/path/file.js")，返回 "not found"。
- step N Action：调用 edit(file_path="/missing/path/file.js")，返回 "not found"。
- 预期：报 nonexistent_path, medium。

### 边界用例

B1. not found 非路径相关
- 场景：输出含 "not found" 但非路径相关（如 "function not found"）。
- step N Action：执行 run_command("npm run foo")，返回 "function not found"。
- 预期：不报 nonexistent_path。

B2. 权限问题被报为 not found
- 场景：路径不存在因权限问题被系统报为 not found（实为无权限）。
- step N Action：调用 read(file_path="/root/secret")，返回 "No such file"（实为无权限）。
- 预期：报 system/auth_failure 或 environment_error。

B3. 路径不存在但有 fallback
- 场景：路径不存在但 Action 有 fallback 逻辑（如 try-catch 后创建文件）。
- step N Action：调用 read(file_path="/foo/bar.js")，返回 "No such file"，随后自动创建。
- 预期：报 nonexistent_path（输出含证据，即使有 fallback）。

---

## wrong_diff_anchor（编辑锚点错误）

判定要点：edit/apply_patch 锚点不匹配真实文件内容。默认严重度 high。

### 正向用例（应检出）

P1. edit 锚点不存在
- 场景：Action 调用 edit(anchor="function foo() {", ...) 但文件中无此行。
- step N Action：调用 edit(anchor="function foo() {", ...)，返回 "anchor not found"。
- 预期：报 wrong_diff_anchor, high。

P2. apply_patch context 不匹配
- 场景：Action 调用 apply_patch(context="old_code", new="new_code") 但 context 不匹配。
- step N Action：调用 apply_patch(context="old_code", new="new_code")，返回 "context mismatch"。
- 预期：报 wrong_diff_anchor, high。

P3. edit 行号超出范围
- 场景：Action 调用 edit(anchor=行号 50) 但文件只有 30 行。
- step N Action：调用 edit(line=50, ...)，返回 "line out of range"。
- 预期：报 wrong_diff_anchor, high。

### 边界用例

B1. 锚点部分匹配（大小写不同）
- 场景：锚点部分匹配（如大小写不同但语义相同）。
- step N Action：调用 edit(anchor="Function Foo() {", ...)，文件含 "function foo() {"。
- 预期：报 wrong_diff_anchor（严格匹配）。

B2. 锚点匹配但文件已被前序 step 修改
- 场景：锚点匹配但文件已被前序 step 修改（锚点针对旧内容）。
- step N Action：调用 edit(anchor="old_line", ...)，但前序 step 已修改该行。
- 预期：报 wrong_diff_anchor（锚点过期）。

---

## dangerous_command（危险命令）

判定要点：命令包含 rm -rf /、DROP TABLE、push --force 等高危操作。默认严重度 high。

### 正向用例（应检出）

P1. rm -rf /
- 场景：Action 执行 `rm -rf /`。
- step N Action：执行 run_command("rm -rf /")。
- 预期：报 dangerous_command, high。

P2. DROP TABLE
- 场景：Action 执行 `DROP TABLE users`。
- step N Action：执行 run_sql("DROP TABLE users")。
- 预期：报 dangerous_command, high。

P3. git push --force origin main
- 场景：Action 执行 `git push --force origin main`。
- step N Action：执行 run_command("git push --force origin main")。
- 预期：报 dangerous_command, high。

P4. chmod -R 777 /
- 场景：Action 执行 `chmod -R 777 /`。
- step N Action：执行 run_command("chmod -R 777 /")。
- 预期：报 dangerous_command, high。

### 边界用例

B1. DROP TABLE 在 SQL 注释里
- 场景：命令含 `DROP TABLE` 但是在 SQL 注释里（如 `-- DROP TABLE old`）。
- step N Action：执行 run_sql("-- DROP TABLE old\nSELECT 1")。
- 预期：不报 dangerous_command（注释非执行）。

B2. rm -rf 有前缀保护
- 场景：`rm -rf` 但目标目录有前缀保护（如 `rm -rf /workspace/build`）。
- step N Action：执行 run_command("rm -rf /workspace/build")。
- 预期：不报 dangerous_command。

B3. DROP TABLE 临时表
- 场景：`DROP TABLE` 临时表（如 `DROP TABLE temp_cache`）。
- step N Action：执行 run_sql("DROP TABLE temp_cache")。
- 预期：报 dangerous_command（仍属高危）或判定为安全（视配置）。

---

## redundant_call（冗余调用）

判定要点：短窗口内同样工具同样参数反复调用三次及以上。默认严重度 low。

### 正向用例（应检出）

P1. 连续 3 次 read 同一文件
- 场景：连续 3 次 read("/foo/bar.js")，参数完全相同。
- step N-2 Action：调用 read(file_path="/foo/bar.js")。
- step N-1 Action：调用 read(file_path="/foo/bar.js")。
- step N Action：调用 read(file_path="/foo/bar.js")。
- 预期：报 redundant_call, low。

P2. 连续 4 次 ls /tmp
- 场景：连续 4 次 run_command("ls /tmp")。
- step N-3 到 step N Action：连续 4 次执行 run_command("ls /tmp")。
- 预期：报 redundant_call, low。

P3. 连续 3 次 search 同一 query
- 场景：连续 3 次 search(query="foo")。
- step N-2 到 step N Action：连续 3 次调用 search(query="foo")。
- 预期：报 redundant_call, low。

### 边界用例

B1. 3 次相同调用但中间有其他动作
- 场景：连续 3 次相同调用但中间有其他动作间隔（非"短窗口"）。
- step N-4 Action：调用 read(file_path="/foo/bar.js")。
- step N-3 Action：执行 edit（其他动作）。
- step N-2 Action：调用 read(file_path="/foo/bar.js")。
- step N Action：调用 read(file_path="/foo/bar.js")。
- 预期：不报 redundant_call（非短窗口）。

B2. 3 次相同调用但每次返回不同结果
- 场景：连续 3 次相同调用但每次返回不同结果（如轮询）。
- step N-2 到 step N Action：连续 3 次调用 read(file_path="/foo/bar.js")，每次返回不同内容。
- 预期：不报 redundant_call（结果变化说明非冗余）。

B3. 首次失败后重试
- 场景：连续 3 次相同调用但首次失败后重试。
- step N-2 Action：调用 read(file_path="/foo/bar.js")，返回 error。
- step N-1 Action：调用 read(file_path="/foo/bar.js")，返回 error。
- step N Action：调用 read(file_path="/foo/bar.js")，返回 success。
- 预期：报 retry-storm（如有该 detector），redundant_call 可补充。

---

## tool_misuse（工具误用）

判定要点：工具能执行但选择明显不合适，例如该搜索却读全文。默认严重度 medium。

### 正向用例（应检出）

P1. 该搜索却 read 全文
- 场景：任务只需找某函数定义位置，Action 却 read 整个 10000 行文件。
- step N Action：调用 read(file_path="/large/file.js")（10000 行，只需找函数位置）。
- 预期：报 tool_misuse, medium。

P2. 该检查单行却 grep 全目录 + read 每个结果
- 场景：任务只需检查某行，Action 却 grep 全目录然后 read 每个结果。
- step N Action：调用 grep(pattern="foo") + read 每个命中文件。
- 预期：报 tool_misuse, medium。

P3. 该用 edit 却用 cat + 手动拼接
- 场景：任务需要修改文件，Action 却用 cat 查看后手动拼接（应用 edit）。
- step N Action：执行 run_command("cat file.js") + 手动拼接内容。
- 预期：报 tool_misuse, medium。

### 边界用例

B1. read 小文件（50 行）
- 场景：read 整个文件因为文件只有 50 行（小文件 read 合理）。
- step N Action：调用 read(file_path="/small/file.js")（50 行）。
- 预期：不报 tool_misuse。

B2. grep query 不精确导致漏结果
- 场景：用 grep 但 query 不精确导致漏结果。
- step N Action：调用 grep(pattern="fo")（query 不精确）。
- 预期：报 parameter_error，不报 tool_misuse。

B3. 任务需要全文理解
- 场景：任务需要全文理解，read 全文合理。
- step N Action：调用 read(file_path="/large/file.js")（任务需要理解全文）。
- 预期：不报 tool_misuse。
