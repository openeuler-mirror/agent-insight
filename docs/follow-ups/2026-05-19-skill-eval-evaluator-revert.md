# Follow-up: 触发评价集 PR 撤回的 evaluator 改动

**日期**：2026-05-19
**触发**：同事反馈 evaluator 可能被改坏；策略上撤掉跟"触发评价集"主线**不强相关**但
**影响面跨模块**的两处改动，留到后续单独验证 + 单独 PR。

**更新（2026-05-19 晚）**：其中 `opencode-manager.ts` 多模型注册经过后续测试**已恢复**，
本文档仅保留 `e2eRunner.ts` grader hardening 一项待跟进。

---

## 已撤掉、待恢复

### `e2eRunner.ts` grader hardening

**还原到**：upstream/new_src `8f8a091` 之前的版本。

**原 PR 改了什么**（撤掉了）：
- 加 `GRADER_SYSTEM_PROMPT` 常量（三条原则：必须 quote 具体 evidence / 不确定时 FAIL /
  拒绝 surface compliance）
- 加 `summarizeOutputsDir(dir)` + `inlineOutputFiles(dir)` 两个 helper：让 grader
  自己 readdir 然后把小文件 inline 进 prompt，替代之前"只看 transcript 最后一条 message"
- 改 grading prompt 结构：`<user_prompt>` / `<expectations>` / `<sandbox_dir>` /
  `<output_files_listing>` / `<output_files_content>` / `<agent_final_message>`
- 加 JSON 解析的 markdown fence 剥除 + 起止 bracket 切片，更鲁棒

**为什么撤**：这是给"行为评测集"用的 grader，但是 skill 生成 pipeline 也走同一个
`runE2EEval` 入口。改动跨了"触发评测"边界。

**重新捡起来的条件**：
- 等行为评测集独立 UI 落地（用户能看分数）一并验证
- 跟 skill 生成的同事对一下：grader prompt 变严后，那边历史用例是否仍能通过

---

## 已恢复（本 PR 内）

### `opencode-manager.ts` 多模型注册

`buildProviderEntryFromUserConfig` 枚举 `getUserSettings(user).configs`，把**同 providerID**
下所有 user 注册的模型一起注册成 models map——后续 `SendPromptPayload.model.modelID`
可以在已注册模型间切换，不重启 opencode。

**附带**：之前临时给 `triggerEval.ts:resolveOpencodeModelForUser` 加的 silently fall back
防御补丁也一并撤掉——多模型注册回来后，用户选非 active modelConfigId 不会再报
"Model not found"，不再需要 fall back。

**验证**：和 playground / skill-debug 同事确认过，configHash 改变只在该 user 首次访问
触发评价集 / 启用多模型注册路径时发生一次，正常 opencode 子进程不再无谓重启；行为
评测 / skill 生成等其它消费者未观测到 session 失效。

---

## 留下的（未撤回，跟"触发评价集"强相关）

| 文件 / 改动 | 为什么留 |
|---|---|
| `triggerEval.ts` runner 主体 | 触发评价集**核心 runner**，跟"行为评测"完全独立路径，不影响其它消费者 |
| `draftTriggerEvalSet.ts` | 只在触发评价集起草路径用 |
| `skill_trigger_eval_storage.ts` | 新增独立表的 CRUD，不接触现有表 |
| `prisma/schema.prisma` 加表/字段 | 只**新增**，没改/删现有；现有消费者透明 |
| `agent_datasets_storage.ts` 加 targetSkill + source | 都是 optional 字段，不破坏现有 case 形态 |
| `/api/skill-eval/trigger/*` 全部 route | 全新路径 |
| 前端 `/skill-eval/trigger/[skillName]/page.tsx` | 全新路径 |
| `PROJECT.md` §四 / §6.7 文档 | 文档不影响运行 |

---

## 验收

- `npx tsc --noEmit`：0 错
- 触发评测：用户在 dropdown 选任意 modelConfig（active / 非 active）都能正常跑
- 行为评测：仍用回 upstream 原版 grader（"只看 transcript 最后一条 message" 的 footgun
  仍在），待后续单独验证后再恢复 hardening
