# L1 单 ID 单点覆盖 - Memory 模块

> 本文件按 [five-module-test-case-construction-strategy.md](five-module-test-case-construction-strategy.md) 第 1 层结构，覆盖 [02-error-taxonomy.md](../../../skills/agent-debug-diagnosis/references/02-error-taxonomy.md) 中 Memory 模块的全部错误 ID。每个用例为单 step、单模块、单错误，其余模块和 step 均正常。
>
> **用例数**：共 **37** 个（正向 19 / 边界 18），覆盖 6 个错误 ID。

---

## hallucination（记忆幻觉）

判定要点：引用了 prior facts 中不存在的**事实、文件、路径、用户要求**。默认严重度 high。

### 正向用例（应检出）

P1. 引用不存在的文件
- 场景：step N 的 Memory 称"根据 /foo/bar.js 的内容"，但前序 step 从未读取过该文件。
- prior facts 设置：前序 step 无任何对 /foo/bar.js 的 read 操作。
- step N Memory：引用 /foo/bar.js 的内容作为决策依据。
- 预期：报 hallucination, high。

P2. 引用不存在的路径
- 场景：step N 的 Memory 称"日志输出到 /var/log/app.log"，但前序 step 从未涉及该路径。
- prior facts 设置：前序 step 无任何涉及 /var/log/app.log 的操作。
- step N Memory：引用路径 /var/log/app.log。
- 预期：报 hallucination, high。

P3. 引用不存在的事实
- 场景：step N 的 Memory 称"用户上次说要用 v2 API"，但前序用户消息只讨论过 v1。
- prior facts 设置：前序用户消息仅涉及 v1 API 讨论。
- step N Memory：引用"用户要求用 v2"这一事实。
- 预期：报 hallucination, high。

P4. 引用不存在的用户要求
- 场景：step N 的 Memory 称"用户要求支持中文输出"，但用户消息历史无任何语言要求。
- prior facts 设置：前序用户消息无语言相关要求。
- step N Memory：引用"用户要求中文输出"。
- 预期：报 hallucination, high。

### 边界用例

B1. 引用旧版本文件内容（文件曾读过但已过期）
- 场景：step N 的 Memory 引用文件 config.js 旧内容（port=8080），但该文件已被 edit 改为 9090。
- prior facts 设置：前序 step read config.js 得 port=8080，随后 edit 改为 9090。
- step N Memory：引用 config.js 的 port=8080。
- 预期：不报 hallucination（属 stale_file_reference）。

B2. 把多个事实压成模糊总结
- 场景：step N 的 Memory 称"utils.js 里有一些日期函数"，实际 prior facts 含三个具体函数（formatDate/parseDate/calcDate）。
- prior facts 设置：前序 step read utils.js 得到三个日期函数定义。
- step N Memory：引用"utils.js 里有一些日期函数"。
- 预期：不报 hallucination（属 over_simplification）。

B3. 引用通用世界知识（非 prior facts 但非幻觉）
- 场景：step N 的 Memory 称"React 是一个 UI 框架"——这是通用知识，不是 prior facts 但也不是幻觉。
- prior facts 设置：前序 step 无任何 React 相关操作。
- step N Memory：引用"React 是 UI 框架"。
- 预期：不报 hallucination（世界知识不构成 hallucination，除非被用作决策依据且与 prior facts 冲突）。

B4. 引用拼写相似但不同的文件名
- 场景：step N 的 Memory 引用 util.js，但 prior facts 中只有 utils.js（多一个 s）。
- prior facts 设置：前序 step read 过 utils.js，从未涉及 util.js。
- step N Memory：引用 util.js 的内容。
- 预期：报 hallucination（精度变体）。

B5. prior facts 为空，Memory 只引用当前用户输入
- 场景：step N 是第一步，无前序 step，Memory 仅引用当前用户消息内容。
- prior facts 设置：无前序 step，prior facts 为空。
- step N Memory：引用当前用户消息。
- 预期：不报 hallucination。

B6. 基于 prior facts 的合理语义推断
- 场景：step N 的 Memory 称"服务监听 8080"，prior facts 中配置文件 port=8080。
- prior facts 设置：前序 step read config.js 得 port=8080。
- step N Memory：推断"服务监听 8080"。
- 预期：不报 hallucination（合理推断）。

---

## memory_retrieval_failure（召回失败）

判定要点：prior facts 中有关键事实，但 Memory 未召回，导致后续判断缺依据。默认严重度 medium。

### 正向用例（应检出）

P1. 未召回用户硬约束导致 Planning 违背
- 场景：用户明确说"不要用 root 用户"，step N Memory 未召回该约束，Planning 据此计划用 root 执行。
- prior facts 设置：前序用户消息含"不要用 root 用户"。
- step N Memory：未提及 root 约束，直接给出"用 root 执行"的依据。
- 预期：报 memory_retrieval_failure, medium。

P2. 未召回前序配置事实导致 Planning 选错
- 场景：前序 step 读取配置得 port=8080，step N Memory 未召回，Planning 据此选了 3000。
- prior facts 设置：前序 step read config.js 得 port=8080。
- step N Memory：未提及 port=8080，给出"port=3000"的依据。
- 预期：报 memory_retrieval_failure, medium。

P3. 未召回前序错误码导致 Reflection 误判
- 场景：前序工具返回 429（限流），step N Memory 未召回该事实，Reflection 据此误判为成功。
- prior facts 设置：前序 step 工具返回 status=error, code=429。
- step N Memory：未提及 429，称"上一步正常"。
- 预期：报 memory_retrieval_failure, medium。

### 边界用例

B1. 关键事实存在但当前决策不依赖
- 场景：prior facts 含"不要用 root"，但当前 step 决策不涉及用户权限，Memory 未召回。
- prior facts 设置：前序用户消息含"不要用 root 用户"。
- step N Memory：未提及 root 约束，但当前 Planning 是读取文件不涉及权限。
- 预期：不报 memory_retrieval_failure（未导致后续判断缺依据）。

B2. 召回了但表述模糊
- 场景：prior facts 含用户约束"必须支持中文和英文"，Memory 召回了但表述为"用户提过某种语言限制"。
- prior facts 设置：前序用户消息含"必须支持中文和英文"。
- step N Memory：引用"用户提过某种语言限制"。
- 预期：报 over_simplification，不报 memory_retrieval_failure（已召回，只是表述模糊）。

---

## over_simplification（过度简化）

判定要点：把多个关键事实压缩成模糊总结，丢掉会影响决策的细节。默认严重度 low。

### 正向用例（应检出）

P1. 压缩多个函数定义丢失具体名称
- 场景：prior facts 含三个日期函数（formatDate/parseDate/calcDate），Memory 称"utils.js 里有一些日期函数"。
- prior facts 设置：前序 step read utils.js 得到三个日期函数定义。
- step N Memory：引用"utils.js 里有一些日期函数"。
- 预期：报 over_simplification, low。

P2. 压缩多语种要求丢失具体语种
- 场景：prior facts 含用户约束"必须支持中文和英文"，Memory 称"用户要求支持多语言"。
- prior facts 设置：前序用户消息含"必须支持中文和英文"。
- step N Memory：引用"用户要求支持多语言"。
- 预期：报 over_simplification, low。

P3. 压缩限流细节丢失 retry-after
- 场景：prior facts 含错误返回 429 含"retry-after: 60"，Memory 称"上一步被限流了"。
- prior facts 设置：前序工具返回 status=error, code=429, message="retry-after: 60"。
- step N Memory：引用"上一步被限流了"。
- 预期：报 over_simplification, low。

### 边界用例

B1. 压缩丢失的细节不影响当前决策
- 场景：Memory 丢了函数名但当前 step 不调用该函数。
- prior facts 设置：前序 step read utils.js 含 formatDate 函数。
- step N Memory：称"utils.js 里有日期函数"，但当前 step 是修改 config.js。
- 预期：不报 over_simplification（不影响当前决策）。

B2. 压缩导致关键事实被虚构
- 场景：Memory 称"utils.js 里有日期函数"，但实际文件里没有日期函数。
- prior facts 设置：前序 step read utils.js 无任何日期函数。
- step N Memory：称"utils.js 里有日期函数"。
- 预期：报 hallucination，不报 over_simplification。

---

## hallucinated_file_content（幻觉文件内容）

判定要点：声称看过某文件内容，但本 session 没有读取过对应内容。默认严重度 high。

### 正向用例（应检出）

P1. 声称看过从未 read 的文件
- 场景：step N Memory 称"看过 config.js，里面 port=8080"，本 session 从未 read 过 config.js。
- prior facts 设置：本 session 无任何对 config.js 的 read 记录。
- step N Memory：引用 config.js 的内容 port=8080。
- 预期：报 hallucinated_file_content, high。

P2. 引用从未 read 的文件首行内容
- 场景：step N Memory 称"utils.js 第一行是 import React"，本 session 从未 read 该文件。
- prior facts 设置：本 session 无任何对 utils.js 的 read 记录。
- step N Memory：引用 utils.js 第一行内容。
- 预期：报 hallucinated_file_content, high。

P3. 引用从未 read 的文件具体行号内容
- 场景：step N Memory 引用某文件第 50 行的具体代码，但本 session 无该文件的 read 记录。
- prior facts 设置：本 session 无该文件的 read 记录。
- step N Memory：引用文件第 50 行内容。
- 预期：报 hallucinated_file_content, high。

### 边界用例

B1. 引用文件被 edit 后的旧内容
- 场景：前序 read 过文件但之后被 edit 修改，Memory 引用的是旧内容。
- prior facts 设置：前序 step read config.js 得 port=8080，随后 edit 改为 9090。
- step N Memory：引用 config.js 的 port=8080。
- 预期：报 stale_file_reference，不报 hallucinated_file_content。

B2. 引用从未 read 的文件 B 的内容
- 场景：前序 read 过文件 A，Memory 引用文件 B 的内容（B 从未被 read）。
- prior facts 设置：前序 step read 过文件 A，无文件 B 的 read 记录。
- step N Memory：引用文件 B 的内容。
- 预期：报 hallucinated_file_content（文件引用错误）。

B3. 通过 ls 获取过文件名但引用文件内容
- 场景：前序通过 ls 获取过文件名列表（非内容），Memory 引用文件内容。
- prior facts 设置：前序 step 有 ls 命令列出文件名，无 read 记录。
- step N Memory：引用某文件的具体内容。
- 预期：报 hallucinated_file_content（ls 不等于 read 内容）。

---

## stale_file_reference（旧版本引用）

判定要点：文件已被修改后仍引用旧内容。默认严重度 medium。

### 正向用例（应检出）

P1. 引用被 edit 修改后的旧配置值
- 场景：前序 read config.js 得 port=8080，随后 edit 改为 9090，step N Memory 仍引用 8080。
- prior facts 设置：前序 step read config.js 得 port=8080，随后 edit 改为 9090。
- step N Memory：引用 config.js 的 port=8080。
- 预期：报 stale_file_reference, medium。

P2. 引用被 edit 删除的旧函数
- 场景：前序 read utils.js 含 calcHash 函数，随后 edit 删除该函数，step N Memory 仍引用 calcHash。
- prior facts 设置：前序 step read utils.js 含 calcHash，随后 edit 删除 calcHash。
- step N Memory：引用 utils.js 的 calcHash 函数。
- 预期：报 stale_file_reference, medium。

P3. 引用被 edit 修改后的旧依赖列表
- 场景：前序 read package.json 得 deps=[lodash]，随后 edit 加入 react，step N Memory 仍称 deps=[lodash]。
- prior facts 设置：前序 step read package.json 得 deps=[lodash]，随后 edit 加入 react。
- step N Memory：引用 package.json 的 deps=[lodash]。
- 预期：报 stale_file_reference, medium。

### 边界用例

B1. 旧内容与新内容在决策点上无差异
- 场景：前序 read 文件，文件被修改，Memory 引用旧内容，但旧内容与新内容在当前决策点上无差异。
- prior facts 设置：前序 step read config.js，文件被 edit 但 port 字段未变（仍是 8080）。
- step N Memory：引用 config.js 的 port=8080。
- 预期：不报 stale_file_reference（未导致错误决策）。

B2. 旧内容本身就从未被 read 过
- 场景：文件被修改，Memory 引用旧内容，但旧内容本身就从未被 read 过。
- prior facts 设置：无 config.js 的 read 记录。
- step N Memory：引用 config.js 的旧内容 port=8080。
- 预期：报 hallucinated_file_content，不报 stale_file_reference。

---

## forgot_user_constraint（遗忘用户约束）

判定要点：用户明确说过"必须/不要"，后续 Memory 未承认或违背。默认严重度 high。

### 正向用例（应检出）

P1. 违背"不要"类约束
- 场景：用户说"不要用 root 用户"，step N Memory 计划用 root 执行。
- prior facts 设置：前序用户消息含"不要用 root 用户"。
- step N Memory：给出"用 root 执行"的依据，未提及用户约束。
- 预期：报 forgot_user_constraint, high。

P2. 违背"必须"类约束
- 场景：用户说"必须支持中文"，step N Memory 计划只输出英文。
- prior facts 设置：前序用户消息含"必须支持中文"。
- step N Memory：给出"只输出英文"的依据，未提及中文约束。
- 预期：报 forgot_user_constraint, high。

P3. 违背"不要修改"类约束
- 场景：用户说"不要修改 config.js"，step N Memory 计划 edit config.js。
- prior facts 设置：前序用户消息含"不要修改 config.js"。
- step N Memory：给出"edit config.js"的依据，未提及修改约束。
- 预期：报 forgot_user_constraint, high。

### 边界用例

B1. 约束来自建议而非硬性要求
- 场景：用户说"建议用 v2 API"（非"必须"），step N Memory 选了 v1。
- prior facts 设置：前序用户消息含"建议用 v2 API"。
- step N Memory：给出"用 v1"的依据。
- 预期：不报 forgot_user_constraint（非硬约束），可报 inefficient_plan。

B2. Memory 召回了约束但 Planning 仍违背
- 场景：用户说"不要用 root"，step N Memory 召回了约束，但 Planning 模块仍计划用 root。
- prior facts 设置：前序用户消息含"不要用 root 用户"。
- step N Memory：引用"用户要求不要用 root"；step N Planning：计划用 root 执行。
- 预期：报 planning/constraint_ignorance，Memory 模块不报 forgot_user_constraint。

B3. 约束已被前序 step 满足
- 场景：用户约束"必须测试"且前序已测试，step N Memory 未再提及。
- prior facts 设置：前序用户消息含"必须测试"，前序 step 已执行 test。
- step N Memory：未提及测试约束（因已满足）。
- 预期：不报 forgot_user_constraint（约束已满足，无需重复承认）。
