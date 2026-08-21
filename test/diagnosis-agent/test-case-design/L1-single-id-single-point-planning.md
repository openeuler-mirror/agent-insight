# L1 单 ID 单点覆盖 - Planning 模块

> 本文件按 [five-module-test-case-construction-strategy.md](five-module-test-case-construction-strategy.md) 第 1 层结构，覆盖 [02-error-taxonomy.md](../../../skills/agent-debug-diagnosis/references/02-error-taxonomy.md) 中 Planning 模块的全部错误 ID。每个用例为单 step、单模块、单错误，其余模块和 step 均正常。
>
> **用例数**：共 **50** 个（正向 28 / 边界 22），覆盖 9 个错误 ID。

---

## constraint_ignorance（忽略约束）

判定要点：计划违反用户、系统、环境或任务约束。默认严重度 high。

### 正向用例（应检出）

P1. 违反用户约束
- 场景：用户约束"不要修改 config.js"，Planning 计划 edit config.js。
- 任务约束：用户消息含"不要修改 config.js"。
- step N Planning：计划 edit config.js。
- 预期：报 constraint_ignorance, high。

P2. 违反系统约束
- 场景：系统约束"禁止 rm -rf"，Planning 计划执行 rm -rf /tmp/*。
- 任务约束：系统配置含"禁止 rm -rf"。
- step N Planning：计划执行 rm -rf /tmp/*。
- 预期：报 constraint_ignorance, high。

P3. 违反环境约束
- 场景：环境约束"Windows 系统"，Planning 计划用 Unix 命令。
- 任务约束：环境为 Windows。
- step N Planning：计划用 Unix 命令（如 ls/grep）。
- 预期：报 constraint_ignorance, high。

P4. 违反任务约束
- 场景：任务约束"必须先测试再部署"，Planning 计划先部署。
- 任务约束：任务清单含"先测试再部署"顺序约束。
- step N Planning：计划先部署再测试。
- 预期：报 constraint_ignorance, high。

### 边界用例

B1. 约束来自建议而非硬性要求
- 场景：约束来自建议（"建议用 v2"），Planning 选了 v1。
- 任务约束：用户消息含"建议用 v2"（非"必须"）。
- step N Planning：计划用 v1。
- 预期：不报 constraint_ignorance（可报 inefficient_plan）。

B2. 约束已被前序 step 满足
- 场景：约束已被前序 step 满足，Planning 不再重复满足。
- 任务约束：用户约束"必须测试"，前序 step 已执行 test。
- step N Planning：不再计划 test。
- 预期：不报 constraint_ignorance（约束已满足）。

B3. 约束来源不明确
- 场景：约束来源不明确（非用户/系统/环境/任务），Planning 未遵守。
- 任务约束：无明确来源的约束。
- step N Planning：未遵守该约束。
- 预期：不报 constraint_ignorance（约束来源不可验证）。

---

## impossible_action（不可能动作）

判定要点：计划依赖不存在的工具、资源或能力。默认严重度 medium。

### 正向用例（应检出）

P1. 计划调用不存在的工具
- 场景：Planning 计划调用 `query_db` 工具，但工具清单无此工具（只有 run_sql）。
- 任务约束：工具清单含 run_sql、read、edit 等，无 query_db。
- step N Planning：计划调用 query_db。
- 预期：报 impossible_action, medium。

P2. 计划访问未部署的资源
- 场景：Planning 计划访问 Redis，但环境中未部署 Redis。
- 任务约束：环境无 Redis。
- step N Planning：计划访问 Redis。
- 预期：报 impossible_action, medium。

P3. 计划读取无权限的文件
- 场景：Planning 计划读取 /root/.ssh/id_rsa，但无权限且环境禁止。
- 任务约束：环境禁止访问 /root/ 目录。
- step N Planning：计划读取 /root/.ssh/id_rsa。
- 预期：报 impossible_action, medium。

### 边界用例

B1. 工具存在但当前不可用
- 场景：工具存在但当前不可用（如网络中断导致 API 不可达）。
- 任务约束：工具清单含 api_call，但当前网络中断。
- step N Planning：计划调用 api_call。
- 预期：报 system/tool_execution_error，不报 impossible_action。

B2. 条件依赖（非确定计划）
- 场景：Planning 称"如果有的话用 Redis"（条件依赖，非确定计划）。
- 任务约束：环境可能有 Redis。
- step N Planning：计划"如果有的话用 Redis"。
- 预期：不报 impossible_action（条件依赖非确定计划）。

B3. 工具存在但需要权限提升
- 场景：工具存在但需要权限提升，Planning 计划调用。
- 任务约束：工具清单含 admin_tool，需要 sudo。
- step N Planning：计划调用 admin_tool。
- 预期：不报 impossible_action（可报 constraint_ignorance 如权限受限）。

---

## inefficient_plan（低效计划）

判定要点：已有信息足够却继续重复无效探索。默认严重度 low。

### 正向用例（应检出）

P1. 已知文件路径仍计划搜索
- 场景：prior facts 已含目标文件路径，Planning 仍计划"先搜索文件位置"。
- 任务约束：prior facts 含目标文件路径 /src/index.js。
- step N Planning：计划"先搜索 /src/index.js 的位置"。
- 预期：报 inefficient_plan, low。

P2. 已知测试通过仍计划重新测试
- 场景：prior facts 已含测试结果 PASS，Planning 仍计划"重新运行测试确认"。
- 任务约束：prior facts 含测试 PASS。
- step N Planning：计划"重新运行测试"。
- 预期：报 inefficient_plan, low。

P3. 已 read 文件仍计划再 read
- 场景：前序已 read 文件得到完整内容，Planning 仍计划"再 read 一次"。
- 任务约束：前序 step 已 read config.js。
- step N Planning：计划"再 read config.js"。
- 预期：报 inefficient_plan, low。

### 边界用例

B1. 重复探索是为了验证
- 场景：重复探索是为了验证（如修改后重新测试），不是无效。
- 任务约束：前序 step edit 了代码文件。
- step N Planning：计划"重新运行测试"。
- 预期：不报 inefficient_plan（验证非无效）。

B2. 重复探索源于 prior facts 未被召回
- 场景：重复探索源于 prior facts 未被召回。
- 任务约束：prior facts 含文件路径，但 Memory 未召回。
- step N Planning：计划"搜索文件位置"（因 Memory 未召回）。
- 预期：报 memory_retrieval_failure，不报 inefficient_plan。

---

## wrong_file_target（目标文件错误）

判定要点：计划修改或读取的目标与任务意图、prior facts 不一致。默认严重度 high。

### 正向用例（应检出）

P1. 修改文件与任务意图不一致
- 场景：任务要求修改 src/index.js，Planning 计划 edit dist/index.js。
- 任务约束：任务要求修改 src/index.js。
- step N Planning：计划 edit dist/index.js。
- 预期：报 wrong_file_target, high。

P2. 修改文件与 prior facts 不一致
- 场景：prior facts 表明 bug 在 utils.js，Planning 计划修改 config.js。
- 任务约束：prior facts 含"bug 在 utils.js"。
- step N Planning：计划 edit config.js。
- 预期：报 wrong_file_target, high。

P3. 读取配置与任务意图不一致
- 场景：任务要求读取生产配置，Planning 计划 read 测试配置。
- 任务约束：任务要求读取生产配置。
- step N Planning：计划 read 测试配置。
- 预期：报 wrong_file_target, high。

### 边界用例

B1. 文件名相似但不同
- 场景：文件名相似但不同（如 src/utils.js vs src/util.js），Planning 选错。
- 任务约束：prior facts 含 src/utils.js。
- step N Planning：计划 edit src/util.js。
- 预期：报 wrong_file_target。

B2. 任务意图模糊，Planning 选择合理
- 场景：任务意图模糊（如"优化代码"），Planning 选择与 prior facts 不完全一致但合理。
- 任务约束：任务要求"优化代码"，未指定文件。
- step N Planning：基于 prior facts 选择合理文件。
- 预期：不报 wrong_file_target。

---

## missing_test_step（缺少验证步骤）

判定要点：修改代码后计划不包含测试或验证。默认严重度 medium。

### 正向用例（应检出）

P1. edit 代码无后续 test 步骤
- 场景：Planning 计划 edit 代码文件，无后续 test 步骤。
- 任务约束：无特殊约束。
- step N Planning：计划 edit index.js，无 test 步骤。
- 预期：报 missing_test_step, medium。

P2. apply_patch 无验证步骤
- 场景：Planning 计划 apply_patch，无验证步骤。
- 任务约束：无特殊约束。
- step N Planning：计划 apply_patch，无验证步骤。
- 预期：报 missing_test_step, medium。

P3. 修改配置无 reload/verify 步骤
- 场景：Planning 计划修改配置文件，无 reload/verify 步骤。
- 任务约束：无特殊约束。
- step N Planning：计划 edit config.js，无 reload/verify 步骤。
- 预期：报 missing_test_step, medium。

### 边界用例

B1. 修改的是文档/注释，无需测试
- 场景：修改的是文档/注释，无需测试。
- 任务约束：无特殊约束。
- step N Planning：计划 edit README.md。
- 预期：不报 missing_test_step（文档无需测试）。

B2. 修改后计划用 lint/type-check 替代 test
- 场景：修改后计划用 lint/type-check 替代 test。
- 任务约束：无特殊约束。
- step N Planning：计划 edit index.js + lint。
- 预期：不报 missing_test_step（lint 也是验证手段）。

B3. 修改后计划手动验证
- 场景：修改后计划手动验证（如 read 检查）而非 test。
- 任务约束：无特殊约束。
- step N Planning：计划 edit index.js + read 检查。
- 预期：不报 missing_test_step（有验证即可）。

---

## over_engineering（过度工程）

判定要点：简单问题引入不必要重构、框架或复杂方案。默认严重度 medium。

### 正向用例（应检出）

P1. 改 typo 却计划重构整个文件
- 场景：任务是改一个 typo，Planning 计划"重构整个文件并引入 ESLint"。
- 任务约束：任务要求改一个 typo。
- step N Planning：计划"重构整个文件并引入 ESLint"。
- 预期：报 over_engineering, medium。

P2. 加字段却计划迁移到 ORM
- 场景：任务是加一个字段，Planning 计划"迁移到 ORM 框架"。
- 任务约束：任务要求加一个字段。
- step N Planning：计划"迁移到 ORM 框架"。
- 预期：报 over_engineering, medium。

P3. 修 bug 却计划重写模块
- 场景：任务是修一个 bug，Planning 计划"重写模块并加 5 层抽象"。
- 任务约束：任务要求修一个 bug。
- step N Planning：计划"重写模块并加 5 层抽象"。
- 预期：报 over_engineering, medium。

### 边界用例

B1. 引入框架但有性能/可维护性必要
- 场景：引入框架但确实有性能/可维护性必要。
- 任务约束：任务要求高性能。
- step N Planning：计划引入性能优化框架。
- 预期：不报 over_engineering。

B2. 引入的复杂度源于用户要求
- 场景：引入的复杂度源于用户要求（"要可扩展"）。
- 任务约束：用户要求"要可扩展"。
- step N Planning：计划引入扩展性框架。
- 预期：不报 over_engineering。

---

## no_explicit_plan（无显式计划）

判定要点：同 step 有写入/破坏性动作，但 Planning 留白。默认严重度 medium。

### 正向用例（应检出）

P1. edit 文件但 Planning 为空
- 场景：step N 的 Action 执行 edit 文件，但 Planning 模块为空。
- 任务约束：无特殊约束。
- step N Planning：留白。
- step N Action：执行 edit index.js。
- 预期：报 no_explicit_plan, medium。

P2. rm 命令但 Planning 留白
- 场景：step N 的 Action 执行 rm 命令，Planning 留白。
- 任务约束：无特殊约束。
- step N Planning：留白。
- step N Action：执行 rm /tmp/old。
- 预期：报 no_explicit_plan, medium。

P3. DROP TABLE 但 Planning 留白
- 场景：step N 的 Action 执行 DROP TABLE，Planning 留白。
- 任务约束：无特殊约束。
- step N Planning：留白。
- step N Action：执行 DROP TABLE temp。
- 预期：报 no_explicit_plan, medium。

### 边界用例

B1. mkdir 但 Planning 留白
- 场景：step N 的 Action 执行 mkdir（创建目录，轻度破坏性），Planning 留白。
- 任务约束：无特殊约束。
- step N Planning：留白。
- step N Action：执行 mkdir /tmp/new。
- 预期：报 no_explicit_plan（创建也算状态变更）。

B2. Planning 有计划但过于简略
- 场景：Planning 有计划但过于简略（如"修改文件"无细节）。
- 任务约束：无特殊约束。
- step N Planning：计划"修改文件"。
- step N Action：执行 edit index.js。
- 预期：不报 no_explicit_plan（有显式计划即可）。

---

## plan_action_mismatch（计划动作不一致）

判定要点：计划说做 A，实际 Action 做 B。默认严重度 high。

### 正向用例（应检出）

P1. 计划 edit A 但 Action edit B
- 场景：Planning 计划 edit index.js，Action 实际 edit config.js。
- 任务约束：无特殊约束。
- step N Planning：计划 edit index.js。
- step N Action：执行 edit config.js。
- 预期：报 plan_action_mismatch, high。

P2. 计划 test 但 Action build
- 场景：Planning 计划运行 test，Action 实际运行 build。
- 任务约束：无特殊约束。
- step N Planning：计划运行 test。
- step N Action：执行 run_command("npm run build")。
- 预期：报 plan_action_mismatch, high。

P3. 计划 read A 但 Action read B
- 场景：Planning 计划 read 文件 A，Action 实际 read 文件 B。
- 任务约束：无特殊约束。
- step N Planning：计划 read index.js。
- step N Action：执行 read config.js。
- 预期：报 plan_action_mismatch, high。

### 边界用例

B1. edit 范围部分重叠
- 场景：Planning 计划 edit 文件 A 第 10-20 行，Action 实际 edit 第 15-25 行（部分重叠）。
- 任务约束：无特殊约束。
- step N Planning：计划 edit index.js 第 10-20 行。
- step N Action：执行 edit index.js 第 15-25 行。
- 预期：报 plan_action_mismatch（范围不一致）。

B2. 计划含选择项
- 场景：Planning 计划"测试或 lint"，Action 执行 lint。
- 任务约束：无特殊约束。
- step N Planning：计划"测试或 lint"。
- step N Action：执行 lint。
- 预期：不报 plan_action_mismatch（计划含选择项）。

---

## unsafe_destructive_action（不安全破坏动作）

判定要点：计划或动作包含高风险命令且无人工确认。默认严重度 high。

### 正向用例（应检出）

P1. rm -rf / 无确认
- 场景：Action 执行 `rm -rf /`，无人工确认。
- 任务约束：无特殊约束。
- step N Action：执行 rm -rf /，无确认记录。
- 预期：报 unsafe_destructive_action, high。

P2. DROP TABLE users 无确认
- 场景：Action 执行 `DROP TABLE users`，无人工确认。
- 任务约束：无特殊约束。
- step N Action：执行 DROP TABLE users，无确认记录。
- 预期：报 unsafe_destructive_action, high。

P3. git push --force 无确认
- 场景：Action 执行 `git push --force`，无人工确认。
- 任务约束：无特殊约束。
- step N Action：执行 git push --force，无确认记录。
- 预期：报 unsafe_destructive_action, high。

### 边界用例

B1. rm -rf /tmp/* 通配符
- 场景：Action 执行 `rm -rf /tmp/*`（通配符但有目录限制）。
- 任务约束：无特殊约束。
- step N Action：执行 rm -rf /tmp/*。
- 预期：报 unsafe_destructive_action（通配符有风险）。

B2. DROP TABLE 临时表
- 场景：Action 执行 `DROP TABLE test_temp`（临时表）。
- 任务约束：无特殊约束。
- step N Action：执行 DROP TABLE test_temp。
- 预期：不报 unsafe_destructive_action（临时表非生产数据）。

B3. git push --force 到 feature 分支
- 场景：Action 执行 `git push --force` 到 feature 分支（非 main）。
- 任务约束：无特殊约束。
- step N Action：执行 git push --force origin feature。
- 预期：报 unsafe_destructive_action（force push 本身高危）。
