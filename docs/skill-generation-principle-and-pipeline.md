# Skill 生成：工作原理、流水线与能力边界

> 适用版本：平台内置「Skill 生成」特性（`skill-generator-agent`，见 `src/lib/skill-generator-opencode-bridge.ts:47`）
> 撰写日期：2026-06-27
> 关联设计：内置 skill `skills/skill-generator/SKILL.md`。
> 配套文档：[Skill 优化](skill-optimization-principle-and-closed-loop.md)（本特性的下游——生成出来的 skill 之后由优化链路迭代）。

---

## TL;DR

- **平台「Skill 生成」是一条「对话驱动 + 单 agent 写文件 + 脚本自校验」的流水线**：用户在 web 端用自然语言（或上传文档/URL）描述需求，后端把内置 `skill-generator` skill 当作 agent 的指令，挂一个会写文件的 opencode agent，让它走「文档预处理 → 场景识别 → 加载规范 → 执行场景工作流 → 验证输出」五步，把 `SKILL.md` / `scripts/` / `references/` 实际写进工作目录，最后 `validate_skill.sh` 自检合规。
- **真正决定「怎么生成」的是内置 skill，不是后端代码**：后端只做加载 skill、把辅助资源挂进工作目录、把 agent 产生的消息转发给前端这类杂活；生成什么、走哪个场景、写哪些文件，全由 `skills/skill-generator/`（一份 ~112 行的 SKILL.md + 几个场景模块和模板）里的工作流决定。
- **生产是「单 agent 自校验」**：当前 chat 路由跑的是**一个** opencode agent（跑内置 `skill-generator` skill），校验只到 `validate_skill.sh`（结构合规）。
- **三条能力边界**（详见 §四）：① 生成时**不碰数据集**（`agent_datasets` 不被读写，行为级评测要等下游优化链路补）；② 有一个 **mock（演示）开关**，开启时回放固定 demo、不调 LLM，真生成要关掉它；③ 校验**只到结构**（`validate_skill.sh` 查 frontmatter/行数/目录，不验「这 skill 真能解决问题」）。

---

## 〇、读者须知：你是谁 & 前置概念

**这篇写给谁**：想搞懂这条流水线**怎么实现**的工程师。只想**用它生成 skill** 的话，跳到 [§五 使用者视角](#五使用者视角一次生成长什么样)。

**先认识几个贯穿全文的词**（前几个与 [Skill 优化文档](skill-optimization-principle-and-closed-loop.md) 共用，那里有更全的术语表）：

| 概念 | 一句话 |
| --- | --- |
| **opencode** | 开源 agent 运行时（server 形态），平台用它跑「会读写文件、调工具的 LLM agent」。生成 agent 就是一个 opencode 会话。 |
| **`runGeneralAgent`** | 平台对 opencode 的统一封装：给指令 + 任务 + skill + 模型配置，起/复用会话、跑完返回事件流。 |
| **workspace（cwd）** | 每个会话一个**隔离沙箱**目录，agent 只能在里面读写、读不到仓库源码（这是 §1.2 要把资源挂进来的根本原因）。 |
| **VFS / `vfs_patch` / SSE** | VFS=工作目录文件快照（路径→内容）；后端扫出来后用 `vfs_patch` 这个 **SSE**（服务端→浏览器单向流式）事件推给前端渲染。 |
| **Agent Skill** | 给 AI agent 动态加载的「指令目录」（遵循 agentskills.io 标准）：一个 `SKILL.md` + 可选 `scripts/` `references/`。**本特性生成的产物就是这种目录**。 |
| **渐进式加载 (Progressive Disclosure)** | Agent Skill 的核心机制：agent 先只读 `name`+`description`(~100 tokens) 决定要不要激活；激活后才读 SKILL.md 主体(<500 行)；再按需懒加载 scripts/references。**生成出来的 skill 也被要求遵守这套结构**，好让它将来被加载时省 token。 |

**这篇在整条链路的位置**（生成是最左端，产物向右流入评估、优化）：

```text
[Skill 生成 ← 本文]          [发布]              [评估]                  [Skill 优化]
对话/文档 → 单 opencode  →  成为平台一个   →   静态/动态/trace/   →   收敛问题 → 改写 →
agent 写出 skill 目录        有版本的 skill     反馈 四种评估           自验证 → 新版本
(本文)                                          → 产出问题清单        (见 skill-optimization doc)
```

---

## 一、平台 Skill 生成现在是怎么跑的

### 1.1 端到端流程（工程视角）

触发入口 `POST /api/skill-generator/chat`（`src/app/api/skill-generator/chat/route.ts`），SSE 流式。整条链路：

```text
【阶段 1 · 前端发起】
   POST /api/skill-generator/chat
   { message, user, threadId, files(当前VFS), modelId?, webSearchEnabled?, mock }
   ├─ mock 开（演示模式） → 回放 src/mock/skills/vmcore-analysis-generate/ 下的固定文件
   │                        逐个 emit tool_call/tool_result/vfs_patch，不调 LLM（见 §4.2）
   └─ mock 关（真生成）   → streamSkillGeneratorOpencode()   （下面阶段 2）

【阶段 2 · 准备环境】  streamSkillGeneratorOpencode()  (src/lib/skill-generator-opencode-bridge.ts)
   2.1 ensureSessionWorkspace(user, threadId)        → 每 session 一个隔离沙箱 cwd
   2.2 prepareSkillGeneratorSystemPrompt():
       - loadFileBasedSkillPrompt('skill-generator')  → 把内置 SKILL.md 全文当作 agent 的指令
       - mountFileBasedSkillResources()               → 把 references/ scripts/ templates/
                                                         挂到 cwd 的 ./.skill-generator/(只读)
       - listAttachments()                            → 把 ./uploads/ 下附件清单拼进指令
       - 套「运行环境约束」meta：路径翻译规则 + 一串「严禁」(见 1.2)
   2.3 getOpencodeServerGeneration(user)              → 取/拉起 per-user opencode 子进程

【阶段 3 · 跑生成 agent】  (跑内置 skill-generator skill 的五步工作流，见 §二)
   3.x withBackgroundOpencodeSlot(runGeneralAgent())
       read 文档 → 判场景 → 读规范+场景模块 → write SKILL.md/scripts/references → validate_skill.sh

【阶段 4 · 翻译事件 + 落库】  (bridge 把 opencode 事件翻成前端协议)
   text / thinking / tool_call / tool_result / vfs_patch(扫工作目录真实文件) / download / done
   → blocks + 最终 VFS 落库 (SkillGeneratorMessage.blocks / SkillGeneratorSession.files)

【阶段 5 · 产物消费】
   GET /api/skill-generator/download/[sessionId]      → 找 SKILL.md、定 skill 目录前缀、打 zip
```

关键点：**后端代码只做「搭桥」的杂活**——加载内置 skill、把它的辅助资源挂进 agent 的工作目录、把 agent 产生的消息转发给前端；真正决定「生成什么、怎么生成」的逻辑全在内置 skill 的工作流里（§二）。

### 1.2 资源挂载：为什么要 `./.skill-generator/` 这层

前提：agent 的工作目录是个**隔离沙箱**（§〇），它读不到仓库里的 `skills/skill-generator/references/`。而内置 `SKILL.md` 是按**通用 Agent Skills 标准**写的，里面引用 `references/skill-template.md`、`scripts/validate_skill.sh`、`templates/fault-diagnosis/...` 这些**裸相对路径**——agent 跑到「加载 references/skill-template.md」时会在沙箱里找不到文件而卡死。

所以 bridge 把内置 skill 的辅助资源挂到沙箱的 `./.skill-generator/` 子目录（只读），并在指令里给一套**路径翻译规则**：

```text
SKILL.md 里写的           agent 实际要读的
  references/xxx     →     ./.skill-generator/references/xxx
  scripts/xxx        →     ./.skill-generator/scripts/xxx
  templates/xxx      →     ./.skill-generator/templates/xxx

而 agent 生成的新 skill 文件 → 写到沙箱根（./SKILL.md, ./scripts/, ./references/）
```

并配套三条硬「严禁」：禁推任何绝对路径（在沙箱不存在，read 会永久卡）、禁去掉 `./.skill-generator/` 前缀读裸路径、禁写入挂载目录。还显式「**不要调用 `skill` 工具**」——屏蔽 opencode 自动发现的全局 skill（典型如 `using-superpowers`：opencode 生态里一个 description 写着「对话开始必先调我」的全局 skill，不屏蔽的话 agent 会白白花一轮 LLM 去加载它）。

---

## 二、内置 skill 的五步工作流（真正的生成逻辑）

`skills/skill-generator/SKILL.md` 定义了生成 agent 的核心指令——一个**场景分支 + 渐进式加载**的工作流：

```text
用户输入（自然语言 + 可选 文档/URL/附件）
        │
        ▼
Step 1 · 文档预处理（仅当提供了文档）
   ├─ 情况A：文档已在 ./uploads/（外层预处理过，二进制已转 .txt）→ 直接 read .txt
   └─ 情况B：对话里给了路径/URL → uv run scripts/parse_doc.py <src> -o /tmp/extracted_doc.md
        │
        ▼
Step 2 · 场景识别（综合用户意图 + 文档内容，判断进哪个场景）
   ┌────────────────────────────────────┬────────────────────────────────────┐
   │ 故障诊断场景                          │ 通用场景                              │
   │ 信号：故障/排查/告警/OOM/宕机/         │ 信号：指定主题/通用需求/              │
   │      失效模型/故障模式…               │      直接描述 skill 内容              │
   │ → references/scenarios/              │ → references/scenarios/             │
   │     fault-diagnosis.md              │     general.md                      │
   └────────────────────────────────────┴────────────────────────────────────┘
        （两者都判不准时：向用户确认「这文档是故障排查相关，还是其他类型？」）
        │
        ▼
Step 3 · 加载规范和场景模块（顺序固定）
   1) 先读 references/skill-template.md   ← 标准输出规范（frontmatter/章节/约束）
   2) 再读上一步选中的场景模块             ← 该场景的完整工作流
        │
        ▼
Step 4 · 执行场景工作流（禁止跳步、禁止提前生成）
   按场景模块的步骤产 SKILL.md / scripts/ / references/
   （故障诊断场景另用 templates/fault-diagnosis/ 的决策树/目录结构/质量扫描规则）
        │
        ▼
Step 5 · 验证输出
   bash scripts/validate_skill.sh <生成的skill目录>
   ├─ 全 ✅ → 告知完成 + 输出路径
   ├─ 有 ❌（如缺 frontmatter 必填字段、SKILL.md 超 500 行）→ 逐项修正 → 重验，直到通过
   └─ 只有 ⚠️（如行数接近上限、references/ 为空等非致命项）→ 告知警告，询问是否补充
```

故障诊断是被特别加厚的场景：`templates/fault-diagnosis/` 下有 `triage_prompt.md`（排查决策树生成 prompt）、`output_structure.md`（产出目录规范）、`quality_scan.md`（故障模式质量扫描规则），`_lib.sh` 的辅助函数在生成时**内联**进各脚本而非复制进产出目录。

---

## 三、产物与落地

- **生成产物**：写在沙箱真实磁盘目录 `~/.agent_insight/agent_workspaces/<userSlug>/<sessionTag>/` 下的 `SKILL.md` + `scripts/*` + `references/*`（`ensureSessionWorkspace`，`src/lib/engine/general-agent/workspace.ts:45`）。bridge 每次文件变动 `scanWorkspaceFiles` 扫成 VFS 推给前端；**VFS 里的 key 用 `/workspace/<rel>` 形式**（只是给前端的统一路径前缀，不是磁盘真实路径，别混淆）。
- **会话持久化**：`SkillGeneratorSession`（id/user/title/files JSON VFS）+ `SkillGeneratorMessage`（role/content/blocks JSON）。前端刷新靠 `GET /sessions` 重放 blocks + 还原 VFS。
- **下载**：`GET /api/skill-generator/download/[sessionId]`——从 session.files 找 `SKILL.md`、推断 skill 目录前缀、用 archiver 打成扁平 zip。
- **纳入平台**：要让生成的 skill 进入平台（之后被评估、被优化），走 skills 上传/发布链路（`/api/skills/*`）。

---

## 四、能力边界与已知缺口

### 4.1 生成时完全不碰数据集

生成链路**不读写 `agent_datasets`**。所以「生成即带评测集 / 把测试作者前移到生成」是空愿景：相关的 `skill-gen-draft` 源是占位、未接线。现实是**数据集多由用户事后手建**，行为级评测要等 skill 进入下游优化/评估链路（见 [Skill 优化文档](skill-optimization-principle-and-closed-loop.md) 的行为门，它依赖该 skill 的评测集）才发生。真正的关键触发点是「dataset-edit」这个 seam，而不是生成时刻。

### 4.2 演示（mock）模式 vs 真生成

chat 路由有一个 `mock`（演示）开关：开启时回放 `src/mock/skills/vmcore-analysis-generate/` 的固定 demo、不调 LLM——好处是没配模型也能看到完整的事件流与产物形态。真生成要把它关掉（`mock:false`）。读这条链路时别把演示回放误当真实生成行为；调试「生成不对」时先确认走的是不是演示模式。

### 4.3 校验只到「结构合规」，不到「真能解决问题」

生产路径的唯一把关是 `validate_skill.sh`：查 YAML frontmatter、行数、目录结构。它**不验**生成的 skill 在真实任务上有没有用——没有「真跑任务打分」的评测接进生产。「这 skill 会不会被正确激活、激活后能不能答对」要等它进入下游评估/优化链路才被检验。

---

## 五、使用者视角：一次生成长什么样

如果你是**要生成 skill 的用户**：

1. **入口**：进 skill 生成页（聊天式界面）。
2. **给输入**：用自然语言说要做什么（「生成一个排查磁盘故障的 skill」），或**上传文档/给 URL**（故障案例、操作手册、PDF 都行），或两者都给。
3. **看实时流**：agent 在读你的文档、判断场景（故障诊断 vs 通用）、读规范、然后**逐个 write** 出 `SKILL.md` / `scripts/` / `references/`，最后跑 `validate_skill.sh` 自检。
4. **拿产物**：右侧文件区能看到生成的文件；点下载得到一个 zip。
5. **要纳入平台**：把生成的 skill 走上传/发布，它才会成为平台里一个有版本的 skill、之后能被评估和优化。

**排查小抄**：

| 现象 | 看这里 |
| --- | --- |
| 生成出来像「录像」、内容固定 | 走了演示（mock）模式（§4.2）；真生成要关掉 mock |
| agent 读某个文件卡死不动 | 八成是路径问题——它去读裸 `references/xxx` 或绝对路径了（§1.2），而非 `./.skill-generator/...` |
| 生成完没有评测分 | 正常——生成链路不跑评测（§4.3）；要评测得先发布、再走评估链路 |
| 校验一直 ❌ | 看 `validate_skill.sh` 报的具体项（缺 frontmatter 字段 / SKILL.md 超 500 行 / 目录缺失） |

---

## 附录：关键文件索引

| 作用 | 路径 |
| --- | --- |
| 触发入口（chat SSE，含 mock 分支） | `src/app/api/skill-generator/chat/route.ts` |
| 后端胶水（指令准备 + 资源挂载 + 事件翻译） | `src/lib/skill-generator-opencode-bridge.ts` |
| 指令准备 + 路径翻译规则 | `src/lib/skill-generator-opencode-bridge.ts:66` |
| 沙箱工作目录解析（真实磁盘路径） | `src/lib/engine/general-agent/workspace.ts:45` |
| per-user opencode 进程管理 | `src/lib/engine/skill-generation/opencode-agent-cli/opencode-manager.ts` |
| opencode 事件协议（client） | `src/lib/engine/skill-generation/opencode-agent-cli/opencode-client.ts` |
| 附件清单 | `src/lib/skill-generator/attachments.ts` |
| 会话创建/列表 | `src/app/api/skill-generator/sessions/route.ts` |
| 产物下载（zip） | `src/app/api/skill-generator/download/[sessionId]/route.ts` |
| 前端页面 | `src/app/(main)/skill-generator/page.tsx` |
| **内置 skill 主文档** | `skills/skill-generator/SKILL.md` |
| 标准输出规范 | `skills/skill-generator/references/skill-template.md` |
| 场景模块 | `skills/skill-generator/references/scenarios/{fault-diagnosis,general}.md` |
| 故障诊断模板 | `skills/skill-generator/templates/fault-diagnosis/` |
| 合规校验脚本 | `skills/skill-generator/scripts/validate_skill.sh` |
| 文档解析脚本 | `skills/skill-generator/scripts/parse_doc.py` |
