# Skill 优化：工作原理、闭环验证机制与能力边界

> 适用版本：平台内置「Skill 优化」特性（`skill-optimizer-chat` agent，见 `src/lib/skill-opt-bridge.ts:34`）
> 撰写日期：2026-06-27
> 关联设计：`docs/plans/2026-05-08-skill-opt-chat-backend-design.md`（chat 后端）、`docs/plans/2026-06-10-skill-issue-merge-conflict-plan-design.md`（归并算子）、`.spike/skill-opt-closed-loop/` 与 `.spike/skill-opt-self-verify/`（自验证闭环实验，结论汇总见 `IDEAS.md` 行 A1）。
> 配套文档：[Skill 生成](skill-generation-principle-and-pipeline.md)（本特性的上游——skill 是先被生成出来的）。

---

## TL;DR

- **平台「Skill 优化」是一条「issue 驱动 + agent 改写 + 多门自验证」的闭环流水线**：把评估器产出的问题（`SkillIssue`）喂给一个会编辑文件的优化 agent，让它在隔离工作目录里 read-then-edit 现有 `SKILL.md` / `scripts/` / `references/`，改完后**自动跑几道把关**，发现变差就让 agent 修（repair），通过才允许用户确认（Accept）成新版本。
- **三条核心机制**：① **归并算子（merge operator）**——把几十上百条同义/冲突的问题合并去重、按出现频次排序成「本轮核心」+ 长尾沉淀，避免逐条打补丁；② **编辑范围约束（edit-scope guard）**——用代码（而非提示词）防止优化器误删/大改基线脚本；③ **自验证闭环（self-verify）**——结构门 → 脚本真值门 → 行为门三道把关 + repair，专治「代码跑得通却答错」的事故。
- **闭环的定位**：把关用「改完不能比改前差」作判据，所以闭环的承诺是「**把确凿的变差挡在确认之前**」，而不是「保证每轮都更好」。质量上限受**评测集完整度**约束——没有评测集，行为门只能跳过（见 §五）。

---

## 总览：一张图看懂闭环

整条优化是一个不断转圈的闭环——**评估发现问题 → 收敛成计划 → agent 改写 + 自动把关 → 用户拍板 → 落新版本 → 新版本再被评估**：

```text
   评估发现问题             收敛成计划              agent 改写 + 自动把关          用户拍板
 (评估器产出问题清单) → (归并算子去重 / 排序) → (改 SKILL.md / 脚本 → 三道门) → (看 diff → Accept)
        ▲                                                                         │
        └──────────────  落成新版本 → 新版本自动重新评估，又发现新问题  ──────────────┘
```

图里的「三道门」是改完后自动跑的三层把关，由浅入深：

- **结构门**——改完的文件能不能跑（引用的脚本都在、能编译）。
- **脚本真值门**——脚本算出来的数（年份 / 计数 / IP 等）对不对（拿评测集里的标准答案核对）。
- **行为门**——拿几道题让新版本真跑一遍、和旧版本比分，确认没变差。

三道门的细节见 [§四](#四自验证闭环结构门--脚本真值门--行为门--repair)。

---

## 〇、读者须知：你是谁 & 5 个前置概念

**这篇写给谁**：想搞懂这条流水线**怎么实现**的工程师（要去改它、或要排查它）。如果你只是想**用它优化自己的 skill**，直接跳到 [§六 使用者视角](#六使用者视角一次优化长什么样)。

**先认识 5 个贯穿全文的词**（不懂这几个，后面全是悬空的）：

| 概念 | 一句话 |
| --- | --- |
| **opencode** | 一个开源的 agent 运行时（server 形态），平台用它来跑「会读写文件、调工具的 LLM agent」。优化 agent 就是一个 opencode 会话。 |
| **`runGeneralAgent`** | 平台对 opencode 的统一封装（`src/lib/engine/general-agent/`）：给它指令 + 任务 + 一个 skill + 模型配置，它起/复用一个 opencode 会话、把 skill 部署进 agent 的工作目录、跑完返回结果与事件流。 |
| **workspace（cwd）** | 每个会话一个**隔离**的工作目录（agent 的「当前目录」），agent 只能在里面读写。优化时先把 skill 基线文件拷进来，agent 在这 read-then-edit。 |
| **VFS / `vfs_patch`** | VFS = workspace 当前文件的快照（路径→内容）。后端扫描 workspace 得到它，通过名为 `vfs_patch` 的 **SSE**（服务端到浏览器的单向流式推送）事件推给前端渲染 diff。 |
| **`SkillIssue`** | 评估器发现的一条「这个 skill 哪里不好」的记录——整条优化链的**输入**。一条问题带：来源（静态/动态/trace/反馈）、严重度、所属维度、摘要、证据、可选的「改进建议」、累计出现次数。 |

> 一个 skill 有多个整数版本（v1、v2…）+ 一个「当前生效版本」指针，文件落在 `data/storage/skills/<id>/v<N>/`；优化产出的新版本号 = 当前生效版本 + 1。

---

## 一、平台 Skill 优化现在是怎么跑的

### 1.1 端到端流程（工程视角）

触发入口是 `POST /api/skill-opt/chat`（`src/app/api/skill-opt/chat/route.ts`），SSE 流式返回。下图按「**阶段（粗体）→ 该阶段做的事**」两级缩进，编号即时序：

```text
【阶段 1 · 前端发起】
   POST /api/skill-opt/chat
   { user, threadId(=SkillOptSession.id), skillName, baseVersion,
     checkedIssues[] 或 planId, userFeedback, modelId? }
   └─ 若带 planId：从 DB 载入已归并的 plan items（status draft→confirmed）

【阶段 2 · workspace 准备】  streamSkillOptOpencode()  (src/lib/skill-opt-bridge.ts:87)
   2.1 ensureSessionWorkspace(user, threadId)        → 每 session 一个隔离 cwd
   2.2 resolveAuthoritativeStorageDir()              → 按 skill.id + SkillVersion.assetPath
                                                        定位「权威基线目录」(与被测基线同一份)
   2.3 ensureSkillFilesInWorkspace()                 → 把 v<baseVersion> 文件预填进 cwd
   2.4 scanWorkspaceFiles() → baselineVfs            → 留存基线快照(edit-scope guard 要用)
   2.5 send('vfs_patch', baselineVfs)                → diff 立刻能渲染基线(即便 agent 还没改)

【阶段 3 · 跑优化 agent】
   3.1 buildSkillOptSystemPrompt()                   → 把问题 / 计划 / 反馈结构化注入(见 1.2)
   3.2 withBackgroundOpencodeSlot(runGeneralAgent()) → agent: read → 思考 → edit → 收尾报告
                                                        displayOnly=true：前台交互式，
                                                        不占后台批量评测的并发名额

【阶段 4 · 收尾把关】  (agent 跑完后，bridge 在同一函数里顺序追加)
   4.1 enforceEditScope()                            → 误删基线文件就还原 + 发 warning(见 §三)
   4.2 runSelfVerification() 循环 ≤ VERIFY_REPAIR_K  → 结构门→脚本真值门→行为门(见 §四)
        ├─ 通过 → send('verify_ok')
        └─ 不通过且有 repair 额度 → 把失败拼成指令，喂回同一 agent 会话让它再改 → 回到 4.2
   4.3 send('vfs_patch' 最终态) + send('done')

【阶段 5 · 用户确认 → 落版本】
   5.1 前端用最终 VFS 拼草稿：POST …/iterations            → SkillOptIteration(draftNumber++)
   5.2 用户在 diff 页 review → Accept：
       POST …/iterations/[n]/apply                        → 落盘 v<N+1>/ + createSkillVersion
                                                            + activeVersion++
       └─ fire-and-forget：parseSkillFlow() + runStaticEvaluation()（新版本立即重新体检）
```

关键点：**编辑逻辑全在「优化 agent」里**（它读文件、改文件、写收尾报告），bridge 只负责喂输入、串 SSE、跑把关 / 落版本。「门」是 bridge 在 agent 收尾后**追加**的外部把关——agent 一开始并不知道有门；只有 repair 时，门的失败被翻译成新指令再喂回它（见 §四，这一步消解了「agent 到底知不知道门」的疑问）。

### 1.2 优化 agent 看到什么：结构化注入的指令

agent 的指令由 `buildSkillOptSystemPrompt`（`src/lib/engine/general-agent/skill-opt-prompt.ts:49`）构造，三段式：

- **角色 + 环境**：「你是 Skill 优化助手，cwd 是现成的 skill 包，read-then-edit，别新建副本」。
- **用户输入**：两种互斥注入路径——
  - **平铺问题**（无计划）：按严重度排序的问题列表（id / 维度 / 摘要 / 证据 / 改进建议），并要求 agent 把同类问题**合并**处理。
  - **归并计划**（有计划）：core/reference 分组的条目，每条带「目标文件 + 锚点原文 + 建议修改」，要求 agent **按条执行、锚点最小编辑、不再二次合并**。
- **工作流程 + 修改细则**：探索 → 必须 edit/write（「只读不写不是合格输出」）→ 固定模板的「修改总结」（小节标题字面量固定，前端按它定位「已解决 / 暂未处理」）。修改细则里写死了几条防回归纪律：保护既有脚本、就地编辑、写盘前禁止声明完成、定量正确性（年份必须解析自日志、禁止用当前系统年份顶替）。

光靠指令里的这些纪律并不保险——模型不一定照做。真正保证不出错的是它改完之后那两道自动把关：**编辑范围约束**（§三，挡住误删/大改）和**自验证**（§四，挡住改错/改差）。

---

## 二、归并算子：把「一堆问题」收敛成「一张可执行计划」

入口 `POST /api/skill-opt/plan`（`src/app/api/skill-opt/plan/route.ts`），异步：建一条 `status=running` 的计划立即返回，后台跑 `runMergeOperator`（`src/lib/engine/skill-opt/merge-operator.ts`），前端轮询等 `status=draft`。

**为什么需要它**：一个 skill 跑几十次评估后会累积**几十上百条**问题，其中大量同义（「描述太长」被 N 次评估各报一遍）、部分互相冲突（两条建议把同一段改成相反方向）。直接平铺给优化 agent → 它逐条打补丁 → SKILL.md 越改越臃肿、互相打架。归并算子在改写前先做语义收敛：

```text
未解决的问题清单        (按「同类」聚合 + 累计出现次数求和)
        │
        ▼  分批 (batchSize≈30，避免一次塞太多)
  ┌─ batch 1 ─┐  ┌─ batch 2 ─┐  ...  ┌─ batch N ─┐      ← 每批一次 LLM 调用：
  │ 语义去重   │  │ 语义去重   │       │ 语义去重   │        · 合并同义问题
  │ 冲突检测   │  │ 冲突检测   │       │ 冲突检测   │        · 标记互斥/矛盾编辑
  └─────┬─────┘  └─────┬─────┘       └─────┬─────┘
        └──────────────┴── 逐层向上归并 ──┘                ← batch 太多时，把各批结果
                       │  (每层再一次 LLM 调用，                 当成新输入再归并一层，
                       │   直到收敛成一组)                       像树一样自底向上合并
                       ▼  三路路由 + 按出现频次排序 + core 名额(默认 4)
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
     core(≤4)      reference        backlog
   本轮必做       写入 references/   暂不处理
   注锚点+建议     长尾沉淀          (留待下轮)
```

> 关于「逐层向上归并」：当问题多到要分很多批时，单批 LLM 只看到本批、批间的重复消不掉，所以把各批的输出当成新一轮输入**再归并一层**，必要时重复多层——这就是上图「逐层向上」的含义（不是一次合并，也不是固定两层）。

三个设计要点（详见 `2026-06-10-skill-issue-merge-conflict-plan-design.md`）：

- **按出现频次排优先级**：累计出现越多的问题越优先进 core；core 有名额上限（默认 4 条/轮——经验值，控制单轮改动面，避免一次改太多互相干扰），其余降级 reference/backlog。
- **锚点最小编辑**：每条计划带「目标文件 + 锚点原文」，让 agent 定位到具体段落做最小改动，不整段/整文件重写。
- **冲突仲裁**：检出矛盾编辑的条目会被标成「冲突」，计划停在草稿态等用户裁决后才继续。

---

## 三、编辑范围约束：用代码防回归，不靠提示词

**为什么需要这道约束**：优化器有时会把一个本来能正确运行的脚本整删、或整段重写——这种「大刀阔斧」往往得不偿失（损失的正确逻辑远多于修好的那点）。所以在 agent 收尾后，`enforceEditScope`（`src/lib/engine/skill-opt/edit-scope-guard.ts`，调用点 `src/lib/skill-opt-bridge.ts:365`）会自动兜底：基线里有、改完没了的文件，直接从快照还原并提示用户；改动行数过大时也告警。可用 `SKILL_OPT_NO_PROTECT=1` 关闭。

**为什么用代码、不写进提示词**：实测中观察到，即便指令里明写「别删脚本」，能力较强的模型在「整体重写更省事」的诱惑下仍会无视、把基线脚本删掉重写（实验记录见 `IDEAS.md` 行 A1 与 spike `.spike/skill-opt-self-verify/`）。所以这条红线用代码在 agent 收尾后强制执行，而不是寄望模型自觉——这是本特性反复出现的设计取向：**确定性的红线放代码，启发式的偏好放提示词**。

---

## 四、自验证闭环：结构门 → 脚本真值门 → 行为门 → repair

这是平台优化的关键一环。如果改完直接落版本、从不校验对不对，就会出「代码跑得通却答错」的事故。举个例子：优化器改了脚本后，脚本看上去能正常运行、也不报错，却把日志里的年份算错了——本该从日志解析出 2005，结果输出成了今年。代码层面一切正常，但答案是错的。这种「跑得通但答错」，开环链路根本发现不了。

`runSelfVerification`（`src/lib/engine/skill-opt/self-verify.ts:229`）在 agent 收尾后、用户确认之前自动跑三道门（由 `src/lib/skill-opt-bridge.ts:382` 的 repair 循环驱动），按「成本由低到高」排列：

```text
候选 bundle（agent 改完的 SKILL.md + scripts + references）
        │
        ▼
① 结构门  verifyStructure()                            （self-verify-structural.ts）
   · 改完的文件能不能跑：SKILL.md 引用的脚本/参考文件都在？py_compile / node --check 过？
   FAIL → 直接 reject + repair（确定性、零成本，不跑 agent）
        │ pass
        ▼
①.5 脚本真值门  verifyScriptTruth()                    （仅当能派生断言 + 有真实日志样本）
   · 脚本算出来的全局量对不对：独立 reviewer LLM 从评测集真值推断「年份/计数/IP 应该是多少」，
     跑候选脚本对真实日志 → 逐字比对
   FAIL → reject + repair，不烧昂贵的行为门
   动机：只看 agent 最终输出的行为门，会被 agent「兜住」坏脚本而误放行
        │ pass
        ▼
② 行为门  verifyBehavioral()
   · 拿几道题让新旧两版各真跑一遍、比分：
       base = 在原版本上跑，cand = 在改完的版本上跑
       每次 = runGeneralAgent 真答一道题 → judgeAnswer 对照标准答案打 0-100 分
   · 判据：新版本均分 ≥ 旧版本即过；掉分的题进 regressions 供 repair 参考
   · 成本封顶：最多量 maxCases(默认 5) 题 + 预算软门，到顶提前停（行为门最贵，真跑 agent）
        │
        ▼
  通过？
   ├─ 是 → send('verify_ok')，收尾
   └─ 否 → 还有 repair 额度(VERIFY_REPAIR_K，默认 1)？
            ├─ 有 → 把失败拼成指令 → 喂回【同一个 agent 会话】
            │        → agent 重新 edit 出【新候选】→ 拿新候选回到 ①（不是重验旧的，不会死循环）
            └─ 无 → 保留当前结果 + warning，交用户裁决（不阻断确认）
```

几个刻意的设计选择：

- **门的顺序按「成本递增」排**：确定性、零成本的结构门 / 脚本真值门先跑、先挡确凿的坏；最贵的行为门（真跑 agent + 打分）最后跑、且有题数 + 预算双封顶。
- **脚本真值门的「应该是多少」由独立的 reviewer LLM 从评测集推断**，而不是看「当前脚本输出里有没有这个数」——避免把真 bug 当正常。
- **把关失败默认「非阻断」**：行为门基建异常（真跑/打分报错）按跳过处理；自验证整体异常也不阻断确认。可用 `SKILL_OPT_NO_VERIFY=1` 整体关。

---

## 五、能力边界与已知缺口

### 5.1 优化质量上限 = 评测集完整度

行为门、脚本真值门都依赖该 skill 的评测集（带标准答案）。**没有评测集 → 行为门跳过**（`self-verify.ts:272`），自验证退化成「只有结构门」——能挡「引用了不存在的脚本 / 编译不过」，挡不住「编译过但答错」。而现状是**评测集多由用户事后手建、生成链路不自动产评测集**，所以冷启动的新 skill 往往没有行为门保护。

### 5.2 行为门是抽样，不是全量

为控成本，行为门只量 `maxCases`（默认 5）道题，且有预算软门会提前停。覆盖不到的题上的回归不会被这轮抓住。缓解靠「本次改的问题相关题优先 + 补几道无关题抓附带损害」的选样策略，但本质仍是抽样，存在漏检窗口。

### 5.3 「不变差」判据的取舍

把关判据是「新版本不低于旧版本」而非「必须更高」。这是刻意的：打分单次有噪、题量有限，强行要求「必须提升」会把噪声当回归、把正常波动误杀。代价是：闭环**保证「不悄悄变坏」，但不替这轮优化背书「一定更好」**——它把确凿的变差（删脚本、年份算错）挡在确认之前，最终「这版到底好不好」仍由用户在 diff 页拍板。

### 5.4 定量正确性仍有覆盖盲区

脚本真值门只在「能从评测集派生出断言 + 评测集里有真实日志路径」时才触发；派生不出断言的 skill（非诊断类、无日志输入）这道门是空的，只能靠行为门间接覆盖。

---

## 六、使用者视角：一次优化长什么样

如果你是**要优化自己 skill 的用户**（不关心实现），一次优化大致是这样：

1. **入口**：进某个 skill 某个版本的优化页（路由形如 `/skill-opt/<skill 名>/<版本号>`）。
2. **给输入**（任选）：
   - 勾选评估器列出的问题（想修哪些勾哪些）；
   - 或先点「生成优化计划」，让系统把一堆问题**去重排序**成几条核心 + 长尾，再按计划改（问题很多时推荐）；
   - 或直接打字提诉求（如「description 太长帮我精简」）。
3. **点开始**，然后看实时流：agent 在读哪个文件、改了什么、它的思考，接着是**自验证进度**（会显示新旧版本的比分）。
4. **看 diff**：跑完出现改动前后对比。
5. **拍板**：满意点 **Accept**（落成新版本）；不满意直接在对话里说「再把 X 改成 Y」，它复用同一会话继续改。

**耗时预期**：完整一轮可能 **>10 分钟**——agent 是多轮 read→edit，行为门还要真跑几道题打分。看到「卡着不动」先想想是不是在跑行为门。

**排查小抄**：

| 现象 | 看这里 |
| --- | --- |
| 跑很久没动静 | 多半在行为门真跑题；或后端 opencode 会话就绪超时 |
| 自验证总是跳过行为门 | 这个 skill 没有评测集（§5.1），先去建评测集 |
| 优化器删了我的脚本 | 编辑范围约束会自动还原并提示（§三）；没还原就看是否设了 `SKILL_OPT_NO_PROTECT=1` |
| 想临时关掉某道门做实验 | `SKILL_OPT_NO_VERIFY=1`（关自验证）/ `SKILL_OPT_NO_PROTECT=1`（关编辑范围约束）/ `SKILL_OPT_MAX_CHANGED_LINES`（行数预算） |

---

## 附录：关键文件索引

| 作用 | 路径 |
| --- | --- |
| 触发入口（chat SSE） | `src/app/api/skill-opt/chat/route.ts` |
| 归并算子入口（plan，异步） | `src/app/api/skill-opt/plan/route.ts` |
| 草稿持久化 | `src/app/api/skill-opt/sessions/[id]/iterations/route.ts` |
| Accept → 落版本 | `src/app/api/skill-opt/sessions/[id]/iterations/[draftNumber]/apply/route.ts` |
| 后端编排（bridge） | `src/lib/skill-opt-bridge.ts:87`（主流程）、`:365`（guard）、`:382`（自验证+repair） |
| 优化 agent 指令构造 | `src/lib/engine/general-agent/skill-opt-prompt.ts:49` |
| 权威基线目录解析 | `src/lib/skill-opt-bridge.ts:479` |
| workspace 预填（纯 fs） | `src/lib/skill-opt-storage.ts` |
| 归并算子实现 | `src/lib/engine/skill-opt/merge-operator.ts` |
| 编辑范围约束 | `src/lib/engine/skill-opt/edit-scope-guard.ts` |
| 自验证编排（结构+行为门） | `src/lib/engine/skill-opt/self-verify.ts:229` |
| 结构门 / 脚本真值门 | `src/lib/engine/skill-opt/self-verify-structural.ts` |
| 脚本真值断言派生（reviewer） | `src/lib/engine/skill-opt/self-verify-derive.ts` |
| skill 解析（user>global，版本回退） | `src/lib/engine/general-agent/skill-resolver.ts` |
| 动态问题派生 | `src/lib/engine/evaluation/derive-skill-opt-points.ts` |
| 静态评估（apply 后重跑） | `src/lib/engine/skill-issues/static-evaluator/index.ts` |
| 前端优化页 | `src/app/(main)/skill-opt/[name]/[version]/page.tsx` |
| 归并 plan 设计文档 | `docs/plans/2026-06-10-skill-issue-merge-conflict-plan-design.md` |
| chat 后端设计文档 | `docs/plans/2026-05-08-skill-opt-chat-backend-design.md` |
