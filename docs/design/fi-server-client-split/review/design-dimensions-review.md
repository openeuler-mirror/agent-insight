# 设计评审（修订后）— 合理性 / 可行性 / 可维护性 / 可用性

> 初评：[design-feasibility-review.md](./design-feasibility-review.md)（gate: conditionally passed, score 71）  
> 修订：已将 Key Attentions 与 ERROR 项写入 [phase2-requirements-design.md](../phase2-requirements-design.md) §1.2 D-004/D-005、§4、§5.3–5.4、§6、§8.5  
> 日期：2026-08-05

## 总评

**结论：条件通过 → 修订后建议视为「可进入 phase3」**（仍建议 phase3 开头用验收清单核对本节四维）。

拓扑（远程任务元数据 + 本机 Worker + 服务端 Judge）与 Insight / agent-ras 一致，主风险已在设计层钉死契约，不再是「推倒重来」级问题。

## 四维评分（修订后）

| 维度 | 初评 | 修订后 | 说明 |
|------|------|--------|------|
| 合理性 | 80 | **88** | D-001～005 闭合；否决双路径 spawn / 浏览器直连合理 |
| 可行性 | 60 | **82** | Workspace 本机化、dry-run stub、sweep 触发点、claim 防双领已写清 |
| 可维护性 | 75 | **84** | 单路径执行 + engine 单一归属；入口闭包含 rerun/health/faults |
| 可用性 | 68 | **78** | curl/npx 对齐 RAS；无 Worker 引导与 keep-alive 预期已写；常驻仍是产品税 |

**综合分（修订后）**：约 **83**（四维平均）。

## 分项摘要

### 合理性
- 问题诊断准确：现网 `queue`/`engine` 同机 spawn 与远程 Insight 冲突。
- 与 agent-ras「本机安装 + HTTP」同构；FI 因实验生命周期选择常驻 Worker 有依据。

### 可行性
- 复用 CLI / Judge / Prisma 扩展，技术债可控。
- 已补：跨机 workspace、dry-run 零进程、服务端 sweep、stop 竞态、原子 claim。
- 残留实现风险：SQLite `updateMany` 选行策略、安装器从「仅 pip」扩到 Worker 的工作量——属 phase3 范围，非设计空洞。

### 可维护性
- 删除服务端 spawn 避免双实现；faults catalog 明确留服务端包内。
- 冻结 catalog / Judge / RAS bridge 语义，变更面可控。

### 可用性
- 安装心智与 RAS 对齐；UI 无 Worker 须硬提示（设计已要求）。
- 代价：用户须保持 Worker 运行；MVP 不强制 systemd，需文档与 UI 说清。

## Gate（修订后）

- grade: **conditionally passed**（初评）→ 文档修订后视为 **ready for phase3**（实现前仍按 §8.5 清单核对）
- passed: true
- 阻塞开发的设计 ERROR：已关闭（以 phase2 现行文为准）

## 建议的下一步

1. 用户确认 phase2（尤其 D-004/D-005 与 Stop 规则）。
2. 撰写 `phase3-development-plan.md` 后开工。
3. 实现期 E2E：Next + Worker 双进程；dry-run 仅测服务端 stub。
