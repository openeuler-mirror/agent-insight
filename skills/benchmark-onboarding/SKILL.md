---
name: benchmark-onboarding
description: >
  根据用户提供的 Agent Insight 项目地址和 Benchmark 官方仓库或数据集来源，自动分析接入协议与官方评分代码，
  编写 Benchmark 接入实现，并调用包内脚本完成官方评分对照、验收记录、有限重试和中文交付报告。
  用于新增 Benchmark 接入或续接已有接入任务；仅查询 Benchmark 网址、运行已有实验或生成 Skill 测试集时不使用。
metadata:
  version: "0.3.2"
---

# Benchmark 自动接入

## 概述

输入是 Agent Insight 项目地址和 Benchmark 来源。宿主编码 Agent 负责分析、实现和调用检查；包内程序负责保存记录、固定基线、比较结果和汇总验收。
所有命令使用 Node.js 20+ 与 Git；运行产物放在 Skill 包外。包内携带有来源和版本的稳定接入协议快照，目标仓库仍是协议唯一权威；动态能力通过查询目标代码和部署获取。

## 核心指令

### 全程适用：必要决策与用户沟通

自动接入允许在开发和验收过程中与用户讨论。先查询目标项目、官方资料和已有决策；能据此确定的常规实现自行推进，关键事项仍无法判断时及时交流，不猜测后继续。

- 需要讨论的典型情况：官方版本或数据范围有歧义、评分语义存在冲突、多个方案对成本/隔离/维护有实质差异、目标协议缺能力需公共扩展，以及部署权限、执行资源或预算不足。是否需要确认取决于本次不确定性和影响，不把这些类别变成每次必问的清单。
- 提问说明已查到的事实、仍缺什么、为什么影响下一步，给出可行选项、取舍和推荐方案；有关联的问题合并询问。先准备权限范围内可完成的分析和可审阅结果，再请求必要决策，不只抛出“怎么办”。
- 用户已经确认的选择和授权持续有效；条件未变不重复询问。可逆、低影响且不改变验收语义的实现细节可说明假设后推进。关键决策待答时暂停依赖它的步骤，继续独立工作；未回复不视为同意，不自行扩大范围或降低验收标准。
- 在包外对应阶段记录中保存问题、选项、用户结论、适用范围及受影响步骤。决定改变已冻结的输入/计划时说明原因并重新冻结；续接时读取这些决策，避免重复讨论。缺少必要决策或条件时如实报告待处理，不标记为已验收。

### 1. 定位项目与创建记录

先读 [接入协议快照](references/benchmark-protocol.md) 了解架构、接口和数据边界，再按 [discovery.md](references/discovery.md) 核对项目地址、工作副本、协作约束与目标协议。获取代码、切分支、发布等操作遵循已有授权，不默认当前目录就是目标项目。
将 `SKILL_ROOT`、`PROJECT_ADDRESS`、`TARGET_REPO`、`BENCHMARK_SOURCE` 设置为本次实际值；它们是普通 shell 变量，不覆盖宿主系统配置。

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" init --project "$PROJECT_ADDRESS" --repo "$TARGET_REPO" --source "$BENCHMARK_SOURCE"
```

保存输出的 `directory` 为 `RUN_DIR`。用户指定继续某次任务时先运行 `resume --run "$RUN_DIR"`；核对记录、预算和在途任务后再继续，不因重启而重置预算或重复提交。

运行 `node "$SKILL_ROOT/scripts/protocol-check.cjs" "$TARGET_REPO"`，按 [usage.md](references/usage.md) 保存结果，并填写包外的 [协议核对记录](assets/templates/protocol-review.json)。差异必须对照目标版本说明和处置后才能套用模板；`match` 只表示快照所列文件一致，仍须查询实际能力和部署。普通运行不更新包内快照来消除差异。

### 2. 分析与冻结

追踪官方执行、反馈、提交和评分代码，给出执行/评测可拆分性、隔离要求及能力查询依据。使用 [接入确认单模板](assets/templates/integration-plan.md.tmpl) 记录分析，并按 [usage.md](references/usage.md) 保存 analysis、capabilities、design 三份阶段产物。
依据 [acceptance.md](references/acceptance.md) 填写 [验收计划模板](assets/templates/acceptance-plan.json)：冻结包内协议版本、目标协议源码及差异处置记录，以及 Benchmark 版本、样本、正确/错误/非法/边界提交、预算及判分容差。调用官方评分程序保存基线，成功后再生成接入实现。

按 [分层真实验证指引](references/live-validation.md) 查询每阶段的实际 API/CLI 和身份合同，填写包外[验证矩阵](assets/templates/validation-matrix.md.tmpl)，确定 L1 接口契约、L2 执行/评分真实分段、L3 完整端到端的依赖、断言、等待、证据及清理；将计划纳入冻结输入。不要把接口接受响应或独立分段成功当作端到端通过。

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" freeze --run "$RUN_DIR" --plan "$PLAN_FILE"
```

### 3. 实现与验收

在已匹配的目标仓库生成 `benchmarks/<key>/`、测试及指南。按协议核对结论调整 [Adapter 骨架](assets/templates/adapter.ts.tmpl) 的导入、方法签名与数据映射，实现全部业务 Hook；模板不会提供伪造的通过结果。复用目标 Catalog、协议测试及官方 Harness；检查桥接不兼容时单独记录包维护变更，公共缺口按仓库设计流程处理。
在已授权范围内自动实现和修复；影响方案或验收的关键不确定事项按上述沟通规则与用户确认。每轮检查读取真实输出，不能修改官方基线或放宽阈值来消除失败。

生成本次专用测试驱动，先执行 L1、再执行所需 L2，保留各层独立结果；`runtime` 命令在核对依赖结果与版本后，从创建/启动入口执行 L3。驱动实现有界轮询、跨阶段身份/摘要核对和异常清理，实际执行器与 Evaluator 自行回调。`verify` 负责调用与汇总，不自动发现接口或推导业务依赖；前置失败时由驱动停止后续。证据与边界场景按上述指引保存后再计算最终结论。

数据集按 [真实验证指引中的数据集安装验收](references/live-validation.md) 生成 `source` 检查：读取实际文件内容和持久化记录、核对转换后一致性，并验证重复导入与失败恢复。按目标存储实现查询，不固定数据库表或文件路径；缺证据不得通过，L2/L3 执行前核对本次安装检查结果。

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" verify --run "$RUN_DIR"
```

### 4. 交付或续接

根据检查失败分类修复，受剩余尝试与总耗时预算约束。源码或配置变化后重新验收；基线变化须说明原因并重新冻结。平台提交前记录稳定请求标识，返回后记录任务 ID：宿主用 `job`，验收子进程用 [record-job.cjs](scripts/record-job.cjs)，详见 [usage.md](references/usage.md)。中断后先查平台任务状态，不能直接重发。

```bash
node "$SKILL_ROOT/scripts/onboard.cjs" report --run "$RUN_DIR"
```

只有报告为 `accepted` 才能声明本次冻结范围验收通过。Fixture、缺少真实链路、未查询的在途任务、证据缺失和旧版本结果均不能代替验收。输出接入代码位置、中文报告、真实验证范围与剩余问题；Skill 本身不提供后台唤醒，也不省略 Benchmark 所需 Docker 或沙箱。

## 参考文件说明

- [benchmark-protocol.md](references/benchmark-protocol.md)：有版本和来源的稳定接入协议；[来源清单](references/benchmark-protocol.sources.json)记录固定 commit 和文件摘要。
- [discovery.md](references/discovery.md)：项目定位、官方源码分析与能力查询。
- [acceptance.md](references/acceptance.md)：计划、评分和检查输出约定，真实证据要求。
- [live-validation.md](references/live-validation.md)：接口契约、分段真实集成、端到端操作与驱动程序要求；[验证矩阵模板](assets/templates/validation-matrix.md.tmpl)用于冻结本次计划。
- [usage.md](references/usage.md)：完整 CLI、预算、续接与包独立验证。
- [assets/templates/](assets/templates/)：接入确认单、Adapter、验收计划和报告模板；[assets/schemas/](assets/schemas/)：包内 JSON 格式。
- [scripts/test.sh](scripts/test.sh)：在独立目录运行包内测试；不是 Benchmark 真实链路认证。
