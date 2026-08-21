# DeepSeek Harness Evaluation, Diagnosis, and Skill Optimization Demo Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在当前 Mac 的 DeepSeek Harness 功能分支实例中，完成一条具有真实缺陷证据的 Trace 观测、评测、诊断、Skill 优化、同条件复跑和回归闭环，并产出带关键截图的最终用户案例文档。

**Architecture:** 使用隔离的 Harness 项目承载固定代码、官方基线 Skill 和独立 Python Oracle；每次执行创建新 Harness Session 并通过现有 OTel 插件上报到当前 Agent Insight 实例。Agent Insight 用已有 Trace 创建单组实验，以任务完成度和轨迹质量两个预置评估器判定结果与过程，再运行 AgentDebug/Skills Analysis 形成可执行 Skill 问题，生成并发布候选 v1，显式同步回 Harness 后以相同输入复跑。所有成功结论必须同时得到 Trace、评测、Oracle 和回归证据支持。

**Tech Stack:** DeepSeek Harness `@deepseek-ai/dsh` upstream master build、Agent Insight Next.js API/UI、SQLite/Prisma、OTel Session Telemetry、DeepSeek Official `deepseek-v4-flash`、Python 3 Oracle、Markdown、Chromium 浏览器截图。

---

## 固定路径与运行变量

- Agent Insight worktree：`/Users/guoyichen/.config/superpowers/worktrees/agent-insight_2026/deepseek-harness-observability`
- 来源资产：`/Users/guoyichen/work/2026/Agent-insight/场景案例/aet-security-evaluation-reproduction`
- 隔离运行根目录：`/private/tmp/agent-insight-dsh-security-demo`
- Harness 项目：`/private/tmp/agent-insight-dsh-security-demo/project`
- 内部证据目录：`/private/tmp/agent-insight-dsh-security-demo/evidence`
- 平台地址：`http://127.0.0.1:3100`
- 平台账号：`deepseek-harness-e2e@local.test`
- 宣传文档：`/Users/guoyichen/work/2026/Agent-insight/场景案例/deepseek-harness-security-audit-case.md`
- 截图目录：`/Users/guoyichen/work/2026/Agent-insight/场景案例/deepseek-harness-security-audit-case-assets`

不得在命令、日志、截图或 Markdown 中输出模型密钥。在线 Harness 命令只在进程环境中映射已经存在的密钥变量，不使用 `env`、`set`、`ps e` 或调试回显。

### Task 1: 冻结隔离项目、来源和 Oracle

**Files:**
- Read: `/Users/guoyichen/work/2026/Agent-insight/场景案例/aet-security-evaluation-reproduction/workspace/edge_cases.py`
- Read: `/Users/guoyichen/work/2026/Agent-insight/场景案例/aet-security-evaluation-reproduction/workspace/app.py`
- Read: `/Users/guoyichen/work/2026/Agent-insight/场景案例/aet-security-evaluation-reproduction/workspace/.opencode/skills/aet-checking-security/**`
- Read: `/Users/guoyichen/work/2026/Agent-insight/场景案例/aet-security-evaluation-reproduction/oracle/verify_edge_cases.py`
- Create: `/private/tmp/agent-insight-dsh-security-demo/project/**`
- Create: `/private/tmp/agent-insight-dsh-security-demo/evidence/manifest.txt`
- Create: `/private/tmp/agent-insight-dsh-security-demo/evidence/oracle-baseline.txt`

**Step 1: 验证服务、Harness 和固定模型**

Run:

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' \
  'http://127.0.0.1:3100/api/skills?user=deepseek-harness-e2e%40local.test'
/Users/guoyichen/.npm-global/bin/dsh --version
curl -fsS 'http://127.0.0.1:3100/api/eval/settings?user=deepseek-harness-e2e%40local.test' \
  | jq '{activeConfigId, autoEvaluationEnabled, configs: [.configs[] | {id, name, provider, model, baseUrlPresent: ((.baseUrl // "") | length > 0), apiKeyPresent: ((.apiKey // "") | length > 0)}]}'
```

Expected: 平台 API 返回 HTTP 200；DSH 为 upstream master 安装得到的 `0.1.0-rc.8` 或当前已验证 commit 对应版本；模型响应只确认 active provider/model 和密钥是否存在，不打印密钥字段。

**Step 2: 创建隔离项目并转换 Skill 发现目录**

先创建明确的临时根目录，再复制 `edge_cases.py`、`app.py` 和完整 Skill bundle；将 Skill 放到：

```text
/private/tmp/agent-insight-dsh-security-demo/project/.dsh/skills/aet-checking-security/SKILL.md
```

不要修改来源目录和基线 Skill 内容。

**Step 3: 记录固定来源哈希**

Run:

```bash
shasum -a 256 \
  /private/tmp/agent-insight-dsh-security-demo/project/edge_cases.py \
  /private/tmp/agent-insight-dsh-security-demo/project/app.py \
  /private/tmp/agent-insight-dsh-security-demo/project/.dsh/skills/aet-checking-security/SKILL.md \
  /Users/guoyichen/work/2026/Agent-insight/场景案例/aet-security-evaluation-reproduction/oracle/verify_edge_cases.py
```

Expected: 基线 `SKILL.md` SHA-256 为 `843473858408ef837356c123d8c49c901475e93c58145eb5e0f9481b847339b4`；将哈希、DSH 版本、模型、Python 版本、时间和来源 commit `63565d4ae73e0e3b31c4057666b8170e3ae2e5d9` 写入 `manifest.txt`。

**Step 4: 独立运行 Oracle**

Run:

```bash
cd /private/tmp/agent-insight-dsh-security-demo/project
python3 /Users/guoyichen/work/2026/Agent-insight/场景案例/aet-security-evaluation-reproduction/oracle/verify_edge_cases.py
```

Expected evidence includes:

```text
unsafe_prefix_allows=True
path_relative_allows=False
outside_created=False
inside_created=True
```

保存原始输出，不根据模型答案改 Oracle。

**Step 5: 确认项目未被预检命令修改**

再次计算 `edge_cases.py`、`app.py` 和基线 Skill 哈希，与 manifest 对齐。

### Task 2: 在 Agent Insight 登记基线 Skill 和固定数据集

**Files:**
- Read: `/Users/guoyichen/work/2026/Agent-insight/场景案例/aet-security-evaluation-reproduction/evaluation/baseline-query.txt`
- Read: `/Users/guoyichen/work/2026/Agent-insight/场景案例/aet-security-evaluation-reproduction/evaluation/regression-query.txt`
- Create: `/private/tmp/agent-insight-dsh-security-demo/evidence/dataset-request.json`
- Create: `/private/tmp/agent-insight-dsh-security-demo/evidence/platform-objects.json`

**Step 1: 上传与 Harness 一致的基线 Skill**

使用 `POST /api/skills/upload`，multipart 中按完整 bundle 重复传递 `files` 和相对 `paths`，`user=deepseek-harness-e2e@local.test`。记录返回的 `skillId` 和 v0，并通过技能版本文件 API 逐个比对哈希。

Expected: 平台 active version 为 v0；平台 `SKILL.md` 与 Harness 本地基线 SHA-256 完全一致。

**Step 2: 创建固定数据集**

使用 `POST /api/agent-datasets` 创建两个 Case：

- 主 Case：固定 baseline query，Expected Output 明确三项关键判断：裸字符串路径前缀相邻目录绕过、`Path.relative_to` 正确拒绝、ZIP 结论必须由实际 Python 版本运行证据支持。
- 回归 Case：固定 regression query，Expected Output 明确 SQL 注入、命令注入、安全参数化查询及行级证据。

请求包含 `targetAgent=deepseek-harness`、`targetSkill=aet-checking-security` 和可识别的演示标签。

**Step 3: 核对关键观点缓存**

读取数据集详情，确认主 Case 的 `rootCauseMeta.status=ready` 且关键观点语义与三项 Expected Output 对齐。若模型提取合并、遗漏或歪曲关键点，停止正式运行，修订 Expected Output 的结构表达后重新创建数据集；不得到实验阶段再临时改评分点。

### Task 3: 执行三次真实缺陷预检

**Files:**
- Create: `/private/tmp/agent-insight-dsh-security-demo/evidence/preflight-1.txt`
- Create: `/private/tmp/agent-insight-dsh-security-demo/evidence/preflight-2.txt`
- Create: `/private/tmp/agent-insight-dsh-security-demo/evidence/preflight-3.txt`
- Create: `/private/tmp/agent-insight-dsh-security-demo/evidence/preflight-verdict.md`

**Step 1: 冻结输入**

读取 baseline query 并记录其 SHA-256。三次预检必须使用同一模型、项目、权限、Skill、代码和 query，每次都启动全新 Session。

**Step 2: 逐次运行 Harness**

从隔离项目目录执行：

```bash
DEEPSEEK_API_KEY="$ANTHROPIC_AUTH_TOKEN" \
DEEPSEEK_BASE_URL='https://api.deepseek.com' \
/Users/guoyichen/.npm-global/bin/dsh --profile headless "$(<固定的 baseline-query 文件>)"
```

每次记录 Harness stdout、root Session ID 和结束状态。不要并发执行三次，以免 Trace/证据映射混淆。

**Step 3: 验证每条预检 Trace 有效**

轮询 Agent Insight Execution API，逐条确认：

- `framework=deepseek-harness`；
- 模型为 `deepseek-v4-flash`；
- System Prompt 非空；
- 真实调用 `aet-checking-security` Skill；
- 读取 `edge_cases.py`；
- 任务正常结束且目标文件哈希未变化。

缺任一项则该次无效，另开新 Session 补足，不计入三次。

**Step 4: 以 Oracle 对答案逐项预检**

对每次最终答案标记三项 `covered/partial/missing/wrong`，引用原答案原文和 Oracle 输出。至少 2/3 次在同一 Oracle 支持的关键点上出现 `missing/wrong`，才冻结为正式 Case。

Expected: 形成可复核的 `preflight-verdict.md`，明确稳定漏检点和入选理由。

**Step 5: 执行真实缺陷门**

如果三次均正确，不进入 Task 4；保留证据并换另一个真实边界 Case，重新执行 Task 1–3。禁止修改 Skill、query 或 Expected Output 来制造失败。

### Task 4: 运行正式基线 Trace 和双评估器实验

**Files:**
- Create: `/private/tmp/agent-insight-dsh-security-demo/evidence/baseline-run.txt`
- Modify: `/private/tmp/agent-insight-dsh-security-demo/evidence/platform-objects.json`

**Step 1: 新建正式基线 Session**

使用冻结输入再运行一次 Harness；记录新的 Session ID、最终答案和项目哈希。预检 Session 不替代正式基线。

**Step 2: 创建已有 Trace 实验**

调用 `POST /api/experiments`：

```json
{
  "user": "deepseek-harness-e2e@local.test",
  "name": "DeepSeek Harness 安全审计基线",
  "type": "single",
  "agentName": "deepseek-harness",
  "evaluatorIds": [
    "preset-agent-task-completion",
    "preset-agent-trace-quality"
  ],
  "cases": [
    {
      "executionId": "<formal-baseline-execution-id>",
      "taskId": "<formal-baseline-session-id>",
      "input": "<frozen-query>",
      "actualOutput": "<trace-final-answer>",
      "referenceOutput": "<fixed-expected-output>",
      "evaluatorContext": "<dataset case context>"
    }
  ]
}
```

记录 experiment ID 和 case ID。

**Step 3: 启动并轮询实验**

调用 `POST /api/experiments/<id>/run?user=deepseek-harness-e2e%40local.test`，body `{}`。轮询实验详情直至 `completed` 或明确失败。

**Step 4: 验证评测确实发现问题**

Expected:

- 任务完成度逐项结果与 Oracle 对齐，至少一个稳定漏检点为 `missing/wrong`；
- 轨迹质量包含 Skill 调用、目标文件读取、证据命令和缺失动作分析；
- 分数为真实连续结果，允许 `33/67` 等中间分，不要求 0 分；
- 结果中存在实际回答证据、Trace 根因阶段、Skill 归因或改进建议。

若评估器与 Oracle 冲突，停止并记录冲突，不进入宣传闭环。

### Task 5: 运行智能诊断与 Skills Analysis

**Files:**
- Create: `/private/tmp/agent-insight-dsh-security-demo/evidence/agent-debug.json`
- Create: `/private/tmp/agent-insight-dsh-security-demo/evidence/skills-analysis.json`

**Step 1: 启动 AgentDebug**

调用：

```text
POST /api/observe/executions/<execution-id>/agent-debug
{"user":"deepseek-harness-e2e@local.test","force":true}
```

Expected: HTTP 202 或可复用的已完成结果。轮询 GET 同一路径直至 `done` 或 `failed`。

**Step 2: 启动 Skills Analysis**

调用：

```text
POST /api/observe/executions/<execution-id>/agent-debug/skills-analysis
{"user":"deepseek-harness-e2e@local.test","force":true}
```

轮询 GET 同一路径直至 `skillsAnalysis.status=done`。

**Step 3: 验证诊断质量**

必须同时存在：真实 Trace 节点/输出引用、根因阶段、是否归因 Skill 的理由、可落到具体文件或规则的建议。确认由任务完成度/轨迹评测派生的 SkillIssue 已绑定 `aet-checking-security`；记录 issue ID。

如只输出泛化建议或没有证据引用，保留失败结果并重查 Trace/评测上下文，不把它写成成功诊断。

### Task 6: 生成、审查并发布候选 Skill v1

**Files:**
- Create: `/private/tmp/agent-insight-dsh-security-demo/evidence/skill-v1-diff.patch`
- Create: `/private/tmp/agent-insight-dsh-security-demo/evidence/skill-v1-manifest.txt`

**Step 1: 创建 Skill 优化会话**

调用 `POST /api/skill-opt/sessions`，body 包含平台用户、`skillName=aet-checking-security`、`baseVersion=0` 和平台 v0 全量文件。记录 session ID。

**Step 2: 使用真实模型生成候选**

调用 SSE `POST /api/skill-opt/chat`，传入：

- `threadId`；
- `checkedIssues` 中的真实 issue ID、严重度、证据和改进建议；
- `baselineFiles` 为平台 v0 全量文件；
- `modelId` 为已激活的 DeepSeek 模型；
- `mock=false`；
- `userFeedback` 要求补足可利用性验证、路径边界和版本相关运行证据，同时保持既有 SQL/命令注入能力。

保存 SSE 完成状态和最终 VFS；禁止使用 mock 输出充当正式优化结果。

**Step 3: 保存 iteration 并审查 Diff**

调用 `POST /api/skill-opt/sessions/<id>/iterations` 保存全量候选文件和已解决 issue ID。生成 v0→草稿 Diff，人工核对：

- 仅修改 Skill bundle；
- 没有写入 Case 答案或具体目标文件路径；
- 增加的是可泛化的路径边界、运行时证据和版本判断规则；
- 原有安全审计阶段未被删除。

不符合则继续同一优化会话修订，不能发布。

**Step 4: 发布候选 v1**

调用 `POST /api/skill-opt/sessions/<id>/iterations/<draft-number>/apply`，body `{"user":"deepseek-harness-e2e@local.test"}`。

Expected: `success=true`、next version 为 v1、active version=v1，结构自验证通过。下载平台 v1 bundle，记录每个文件 SHA-256。

### Task 7: 显式应用 v1 并复跑主 Case 与回归 Case

**Files:**
- Modify: `/private/tmp/agent-insight-dsh-security-demo/project/.dsh/skills/aet-checking-security/**`
- Create: `/private/tmp/agent-insight-dsh-security-demo/evidence/optimized-main-run.txt`
- Create: `/private/tmp/agent-insight-dsh-security-demo/evidence/optimized-regression-run.txt`

**Step 1: 将平台 v1 应用到 Harness**

先备份隔离项目中的 v0，然后用平台下载的 v1 替换 `.dsh/skills/aet-checking-security/`。逐文件比对 Harness v1 与平台 v1 SHA-256；不得修改目标代码、query、Expected Output 或 Oracle。

**Step 2: 同条件复跑主 Case**

新建 Harness Session，使用完全相同的 baseline query。验证新 Trace 调用 v1 对应 Skill、读取相同代码并收集新规则要求的证据。

**Step 3: 用相同评估器复评**

创建新的已有 Trace 实验，评估器仍为 `preset-agent-task-completion` 和 `preset-agent-trace-quality`，Expected Output 和关键观点不变。

Expected: 三项任务完成度全部通过或达到与 Oracle 一致的满分结果，轨迹包含所需证据收集；若只提升分数但 Oracle 仍不通过，视为失败。

**Step 4: 运行回归 Case**

新建 Harness Session，执行固定 regression query，并以同样方式创建/运行回归实验。

Expected: 正确识别 SQL 注入和命令注入，正确认可参数化查询，并给出代码行证据；已有能力不退化。

**Step 5: 冻结对比结果**

在 `platform-objects.json` 记录 v0/v1 Trace、experiment、case、diagnosis、Skill、issue 和优化 session ID；在内部证据中形成包含分数、Oracle、轨迹和回归的对比表。

### Task 8: 捕获六张关键产品截图

**Files:**
- Create: `/Users/guoyichen/work/2026/Agent-insight/场景案例/deepseek-harness-security-audit-case-assets/01-trace-overview.png`
- Create: `/Users/guoyichen/work/2026/Agent-insight/场景案例/deepseek-harness-security-audit-case-assets/02-baseline-trajectory.png`
- Create: `/Users/guoyichen/work/2026/Agent-insight/场景案例/deepseek-harness-security-audit-case-assets/03-baseline-evaluation.png`
- Create: `/Users/guoyichen/work/2026/Agent-insight/场景案例/deepseek-harness-security-audit-case-assets/04-diagnosis.png`
- Create: `/Users/guoyichen/work/2026/Agent-insight/场景案例/deepseek-harness-security-audit-case-assets/05-skill-diff.png`
- Create: `/Users/guoyichen/work/2026/Agent-insight/场景案例/deepseek-harness-security-audit-case-assets/06-before-after.png`

**Step 1: 使用浏览器 Skill 打开本地实例**

使用固定桌面 viewport 和平台账号，从真实 Trace、实验、诊断和 Skill 优化页面截图。不得用拼接假 UI 替代产品页面。

**Step 2: 检查截图信息**

六张图依次显示：Trace 总览、基线轨迹、基线评测、诊断、v0→v1 Diff、优化前后与回归结果。保留必要 ID/版本/分数；隐藏 API Key、模型密钥、无关用户历史和不必要的绝对私密路径。

**Step 3: 逐图视觉验收**

确认字体清晰、无加载骨架/报错弹窗、关键卡片完整、截图尺寸一致；不合格页面重新截取。

### Task 9: 编写面向最终用户的案例宣传文档

**Files:**
- Create: `/Users/guoyichen/work/2026/Agent-insight/场景案例/deepseek-harness-security-audit-case.md`

**Step 1: 按用户视角组织内容**

正文结构：业务问题、接入后的可见证据、基线运行、评测发现、智能诊断、候选 Skill、同条件复跑、前后对比、能力边界。

**Step 2: 嵌入六张相对路径截图**

使用 `./deepseek-harness-security-audit-case-assets/<name>.png`，每张图前后写清楚读图重点和对应证据。

**Step 3: 控制宣传口径**

正文不专门介绍 AET 项目；统一称“代码安全审计 Skill”“基线 v0”“优化 v1”。不得宣称平台自动把 Skill 推回 Harness，明确展示“应用候选 Skill”步骤。只写已经实际验证的能力、分数和结果。

### Task 10: 最终证据审计、测试和工作日志

**Files:**
- Verify: `/private/tmp/agent-insight-dsh-security-demo/evidence/**`
- Verify: `/Users/guoyichen/work/2026/Agent-insight/场景案例/deepseek-harness-security-audit-case.md`
- Modify: `/Users/guoyichen/work/2026/8月/daily_work.md`

**Step 1: 运行证据一致性检查**

核对所有 Session/Execution/Experiment/Skill version ID 可打开，v0/v1 哈希与平台一致，Oracle 输出未变化，Markdown 中每个数值都能追到保存的 JSON 或页面。

**Step 2: 验证文档和图片**

Run:

```bash
test -f /Users/guoyichen/work/2026/Agent-insight/场景案例/deepseek-harness-security-audit-case.md
find /Users/guoyichen/work/2026/Agent-insight/场景案例/deepseek-harness-security-audit-case-assets -type f -name '*.png' | wc -l
```

Expected: Markdown 存在、PNG 恰好六张；逐一验证图片可解码且文档相对链接存在。

**Step 3: 若代码因现场阻塞发生修改，运行分层验证**

仅当闭环执行暴露并修复产品代码问题时，先运行对应 focused tests，再运行相关 build target；记录已覆盖与未覆盖的平台边界。若没有产品代码修改，不把文档/运行成功误写成完整代码回归。

**Step 4: 更新工作日志**

在 `/Users/guoyichen/work/2026/8月/daily_work.md` 的 `## 2026-08-21` 下追加一条简洁完成项，概括 DeepSeek Harness 观测、评测、诊断、Skill 优化闭环和案例文档结果；不写排查过程。

**Step 5: 最终交付**

向用户提供：案例 Markdown 本地链接、六张截图目录、基线和优化 Trace 链接、实验链接、Skill v0/v1 页面以及已验证/未验证边界。若任一硬门未满足，交付真实部分结果和阻塞证据，不包装为闭环成功。
