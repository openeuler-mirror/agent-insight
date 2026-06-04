# Framework 适配器注册表 — 开发计划（SDD）
版本：v0.2
最后更新：2026-06-04

> 文档类型：Phase3 开发计划 ｜ 关联 [Phase1](phase1-requirements-analysis.md) / [Phase2](phase2-requirements-design.md) ｜ base_commit：c47829a（master_0530）
> 类型：行为保持型重构 ｜ 工作量：Low-Medium

---

## 导读（工程师先看这段）

**这份文档是干活清单** —— 六个任务 T1~T6,每个都带:改哪些文件、要做什么、不许做什么、怎么算过。

**当前进度**(随做随勾):

| 任务 | 内容 | 状态 |
|-|-|-|
| T1 | golden 基线:钉死现状,当重构的"标准答案" | ✅ 完成 (5/5 绿) |
| T2 | 建注册表骨架(纯新增,不碰旧代码) | ✅ 完成 (15/15 绿) |
| T3 | dispatcher 改走注册表(第一次碰旧代码) | ⬜ 待做 |
| T4 | upload/rejudge/proxy 三处调用点收敛 | ⬜ 待做 |
| T5 | claude 归一化切 data-service 一处 | ⬜ 待做 |
| T6 | 全量验证 + 边界核查 | ⬜ 待做 |

**跑测试**(项目在 WSL,Windows 侧直接跑会撞 esbuild 平台二进制;固定用这条):
```
wsl -d ubuntu-22.04 bash -lc '. ~/.nvm/nvm.sh; nvm use 22.17.1; cd /opt/src/agent-insight && node --import tsx --test test/framework-adapter-golden.test.ts test/framework-adapter-registry.test.ts'
```

**怎么改才安全**(每个任务通用):改一处 → 立刻跑上面两个 golden/registry 测试 → 绿了再改下一处。任何一处变红 = 行为被改坏,停下查。

**测试放哪 / 源码放哪**:测试放 `test/`(runner 只扫 `test/**/*.test.ts`),adapter 源码放 `src/lib/ingest/adapters/`。

**术语**(簇/D-0x/AC-0x)见 [Phase1 导读速查表](phase1-requirements-analysis.md);`dispatcher` = `data-service.ts:476` 那个按框架挑 skill 抽取函数的调度函数。

---

## §1 范围

只做第一刀:簇 A(skill 抽取) + C(claude 归一化) + I(框架名值域)。已拍板决策 D-01/02/03 见 [Phase1 §4](phase1-requirements-analysis.md)。**不碰** F/G/B/D/E(见 Phase1 §3)。

## §2 任务清单

### Wave 1 — 打地基（不碰旧代码，零回归风险）

- [x] **T1 golden 基线（先于一切搬迁）** — `test/framework-adapter-golden.test.ts` + `test/fixtures/framework-skill-fixtures.ts`
  - **做什么**:给 opencode/claude/openclaw 各造一组覆盖全分支的样本(skill / load_skill / task 展开 / 去重 / 非法名拒绝 / 只认 assistant 消息 / 错误块类型忽略),把现有 `extractSkillsWithVersionsFrom*Session` 和 `normalizeClaudeCodeInteractionsForStorage` 的输出钉成常量断言。样本和期望放同一个文件,T2 复用同一份期望。
  - **为什么先做**:这是重构的"标准答案"。后面每搬一处,都拿它对——结果一变就立刻知道改坏了。
  - **不许做**:不改任何被测函数。
  - **结果**:✅ 5/5 PASS,基线对现状成立(AC-01)。

- [x] **T2 建注册表骨架** — `src/lib/ingest/adapters/{types,registry,opencode,claude,openclaw,hermes}.ts` + `test/framework-adapter-registry.test.ts`
  - **做什么**:按 [Phase2 §2/§3](phase2-requirements-design.md) 落契约 + 注册表 + 4 个 adapter。adapter 里**不写逻辑,只把现有函数挂上去**(`extractSkills: extractSkillsWithVersionsFromOpencodeSession`)。
  - **怎么证等价**:测试用**引用相等**断言(`adapter.extractSkills === 现有函数`)—— 数学上证明是"挂现有函数"而非"重写",不可能漂移。
  - **微调**:`InvokedSkill` 从 `interaction-utils`(叶子)导入,不从 `data-service`,免得把 DB 依赖拖进适配层。`resolveFrameworkId` 遇到不认识的框架**原样返回**,不塌缩成 'unknown'。
  - **不许做**:adapter 内访问 DB/网络;删或改被挂的原函数。✓ 都满足。
  - **结果**:✅ 15/15 PASS。别名命中同一对象✓、输出==golden✓、引用相等✓(AC-01/AC-04)。

### Wave 2 — 把旧调用点切到注册表（每切一处，立刻跑测试）

- [ ] **T3 dispatcher 改走注册表** — `data-service.ts:476`
  - **做什么**:把 `extractInvokedSkillsFromSessionInteractions` 函数体换成一行:
    `return getAdapter(framework).extractSkills?.(normalizeInteractions(interactions)) ?? null`
  - **怎么验**:跑 golden/registry 两测试全绿;三框架结果不变、未知框架仍返回 null(AC-01/AC-03)。
  - **风险**:这是第一次碰旧代码,但因 T2 已用引用相等证等价、golden 守着,风险极低。

- [ ] **T4 三处调用点收敛** — `upload/route.ts:167,292`、`rejudge/route.ts:61`、`proxy/end/route.ts:82,138,311`
  - **做什么**:三处全改调 T3 的 dispatcher。具体:删掉 upload 里两段重复 if/else;删掉 proxy/end **自己抄的那份函数体**;rejudge 改调 dispatcher 时**顺手补回它漏掉的 openclaw**。
  - **怎么验**:rejudge 现在能抽出 openclaw 的 skill 了(AC-02);upload/proxy 行为不变(AC-01)。
  - **不许做**:不改那三个被挂函数的实现体。

- [ ] **T5 claude 归一化切 data-service 一处** — `data-service.ts:1556/1566/1575`
  - **做什么**:这三处 `framework === 'claudecode'` 的判断,换成 `getAdapter(fw).normalizeForStorage?.(x) ?? x`。
  - **本轮只切这一处**(D-03):其余 4 处(fault/stream:193、observe/agent-debug:118、observe/session:26、claude-otel/aggregator:476)**留 TODO 注释,先不动**——下一轮再迁。
  - **怎么验**:claude/claudecode 入库归一化结果不退化(AC-04)。

### Wave FINAL — 收尾验证

- [ ] **T6 全量验证 + 边界核查**
  - golden/registry 全绿;`lint` / 类型检查 / `npm test` 全过。
  - **grep 核查没越界**:全代码库没有**新增**的裸 `framework === 'claude'` 判存量(会漏 claudecode);Phase1 §3 那六块(F/G/B/D/E + 既有框架逻辑)的 git diff 与本轮无关;没有 schema 迁移。
  - opencode/claude/openclaw 既有相关测试(如 `test/agent-registration.test.ts`)回归全过。

## §3 执行顺序

```
T1(基线) ──┬─→ T2(骨架) ──→ T3(dispatcher) ──→ T4(三处调用点) ──┐
           │                              └──→ T5(claude 归一化一处) ──┤
           └────────────────────────────────────────────────────────┴─→ T6(验证)
关键路径: T1 → T2 → T3 → T4/T5 → T6  （T4 与 T5 可并行）
```

## §4 提交方式

- Wave 1+2 合一个 commit:`refactor(ingest): introduce FrameworkAdapter registry; unify skill extraction & claude normalization`
- commit message 里单独点一句:rejudge 补回 openclaw 是附带修的 bug。

## §5 和 hermes 那条线怎么配合

- **互不阻塞**,可并行。唯一交界:框架清单别各搞一套——hermes 线会新建 `frameworks.ts`,本线有 `listFrameworks()`,谁先落地另一方并进去,最终只留一个出处。
- hermes 的 skill 抽取(`extractSkillsWithVersionsFromHermesSession`)写好后,只需在 `hermes.ts` 的 `extractSkills` 挂上它,就自动接入注册表,**不用再碰 dispatcher**。

## §6 全程红线（Must NOT）

- 不重写任何被挂函数的实现体(只搬归属)。
- 不动 `role === 'opencode'`(簇 F)、platform 接线(簇 G)、saveExecutionRecord 派生/门(簇 B)、生命周期(簇 D)、UI 延迟换算(簇 E)。
- 不迁移存量数据、不改 schema、不新增任何裸 `=== 'claude'` 判存量值。
