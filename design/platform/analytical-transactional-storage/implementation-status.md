# 首批核心实现与验证边界

日期：2026-11-12（首批工作始于 2026-11-11）。以下为已执行结果；总体架构目标仍见 phase1/phase2，不能以本批结果宣称完整重构或生产切换完成。

## 基线与分支

- 已 fetch `upstream/master`，以 `298d1d5b10ab3ab67a955b41a1665b0cd4d26b54` 建独立分支 `codex/storage-core-refactor`。
- 工作区 `/Users/guoyichen/.codex/worktrees/storage-core-refactor/agent-insight_2026`；旧工作区设计和其他工作不变。
- 最新本地同步基线为96个 Prisma model；[旧库设计](legacy-migration-design.md)逐个分类。

## 已交付

1. [字段字典](core-table-dictionary.md)：21张事务表、13张CH表，共34张核心物理表。含4张新增基础表，不是把此前59张逻辑目录全部实现。
2. `services/storage/schema/`：SQLite、PostgreSQL、openGauss、ClickHouse四套核心DDL及机器字段目录，完整字段/类型/NULL/default/PK/FK/unique/check/index/不可变规则。
3. `services/storage/control.py`：独立SQLite控制仓库。初始化拒绝旧Prisma库，schema checksum校验，WAL/FULL、租户/资产约束、版本依赖封存、草稿和alias CAS、冻结RunPlan、任务领取/续租/fence/取消、实际制品hash验证，以及结果回执与Outbox同事务提交。
4. `services/storage/clickhouse.py`：标准库HTTP事实访问。受控canonical Span批量写、最新态后筛选、结构分页/单Span读取、多section正文共享bundle revision、正文块与最终manifest、逐块和整段完整性验证、4MiB编码请求上限。
5. `services/storage/legacy.py`：只读一致性清点/导出/验证，包含活跃WAL、physical columns与类型、重复行、确定性hash和私有输出；阻断损坏/FK问题/不完整或被修改的导出。
6. `python3 -m services.storage`：schema输出、显式新SQLite目标初始化、inspect/export/verify入口；stdout无原始行、schema SQL或默认值字面值。中英公开参考已同步。

## 已执行验证

| 层次 | 结果 | 证明范围 |
| --- | --- | --- |
| Python核心全套 | **70通过、0失败、0跳过**，启用显式PG/CH测试目标，ResourceWarning作为错误 | 合同、真实SQLite、只读迁移、CLI、PG DDL合同和CH链路 |
| PostgreSQL | 15.19，Linux ARM64 `postgres:15-alpine` 临时容器 | 核心DDL、封存/冻结/复合归属等约束；不证明业务PG运行适配已实现 |
| ClickHouse | 25.8.12.129 official build，macOS ARM64隔离单实例 | 13表建表、旧失败→新成功筛选、租户隔离、bundle/正文读取、revision范围和10,000 Span分页/单点查询 |
| 代码与文档 | compileall、git diff --check、新文件尾空格、链接/代码围栏与34表目录覆盖检查通过 | 静态完整性；不代替功能和容量测试 |
| 既有应用 `npm run test` | 正确初始化隔离DB后的完整运行：**5,242通过、43失败、24跳过，共5,309** | 全量未通过，不能声称全量回归成功 |

Python专项细分：contracts 4、control 11、CH验证9、CH真库5、CLI2、legacy22、schema17（包含PG真库1），合计70。真实数据库的测试目标是本任务创建的隔离实例，不是客户或默认运行库。

应用全量首次尝试因新测试库未创建而产生无效环境失败，未用作最终结果。重新创建/初始化隔离库后完整运行184秒，得到上表最终结果；无超时。失败涉及既有UI结构断言、注册示例、FI/RAS契约、脚本/VSIX构建产物和Windows构建约束等；未逐项归因或修复。`git diff --exit-code HEAD -- src test prisma package.json package-lock.json agent_ras agent_fault_injection` 为0，即这些既有应用源文件和入口未改；这不是一次额外的clean-master对照压测，不报告“新增失败为0”的推断。

本批未启动Next dev server，未进行浏览器验证、真实模型/官方Benchmark Harness运行、千级混合压测、Linux ClickHouse/HA/openGauss认证。

## 可重复命令

```bash
python3 -W error::ResourceWarning -m unittest discover -s services/storage/tests -v
STORAGE_TEST_PG_CONTAINER=your-isolated-pg-container python3 -m unittest discover -s services/storage/tests -p test_schema.py -v
STORAGE_TEST_CLICKHOUSE_URL=http://127.0.0.1:your-test-port python3 -m unittest discover -s services/storage/tests -p test_clickhouse_integration.py -v
```

不指定真库变量时对应项目明确跳过，不能复述为70项全部真库通过。CH测试会在显式目标创建并删除随机测试数据库，PG测试使用事务临时Schema回滚；仅指向隔离测试实例。

本机CH验证二进制来自固定发布资产 `ClickHouse/ClickHouse v25.8.12.129-lts / clickhouse-macos-aarch64`，SHA-256 `541b149c0b73c44524cf3aff38541697736de266b36b6233811451a7922ee588`，下载后与发布元数据摘要核对。未将移动master构建或分段内容不一致的下载用于验证。复现生产版本还需在目标Linux拓扑独立认证。

## 后续工作与尚未完成项

- 账号密码、用户分组与组管理员全组数据读取：已补IAM表和权限/迁移规则设计，尚未实现认证和请求授权层；不计入34张物理表及70项测试。

- PG/openGauss业务运行适配、安装/迁移Runner与实际发行版能力认证。
- 完整Durable Event Log/实体所有者、重复修订冲突隔离、Outbox自动投递和可靠checkpoint。
- 固定Trace快照、Dataset异步发布、Evaluator/Benchmark协议、评分事实选择和其余领域业务接管。
- 旧库逐字段语义转换与目标apply、增量变更/DELETE追平、影子读、停写切换和反向增量回退。当前导出不是已完成迁移。
- 权限/删除屏障/pin/保留期、索引/汇总重建，以及千级在线混合负载、故障和备份恢复验收。

`write_spans`目前要求上游已提供可信完整canonical版本；同一逻辑key+revision不同内容的冲突还需物化器隔离。CH多请求写入可能部分成功，调用方必须用稳定版本重放并在全部成功前不推进checkpoint。当前默认应用存储没有接管，不应该把这批DDL或CLI直接应用到现有业务数据库。
