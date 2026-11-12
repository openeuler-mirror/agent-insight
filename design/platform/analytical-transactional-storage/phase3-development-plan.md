# 分析与事务存储完整重构 — 开发与验收路线

日期：2026-11-11。此为整体实施路线；用户已授权并启动首批核心实现，当前范围与验证见 [实施状态](implementation-status.md)，不表示全部阶段完成；不含未经 PoC 校准的人日或上线日期承诺。依赖 [需求分析](phase1-requirements-analysis.md) 与 [目标设计](phase2-requirements-design.md) 完成评审。

## 1. 实施组织与门禁

采用契约 → 真数据库垂直链路 → 各领域实现 → 历史迁移 → 混合负载 → 切换的顺序。功能可并行建设，但共享身份、版本、删除、输入快照和结果口径先确定。不能以只建新表、只接通数据库或只通过 HTTP 接收作为交付。

不在本轮直接修改 Prisma schema、运行配置、依赖或运行数据。设计批准后，每个实施批次提交相应的独立实现计划、测试和当前行为指南；先验收一条真实闭环，再扩展覆盖。

## 2. 目标代码边界

与 Python 后端迁移方向对齐的目标模块如下。这是职责建议，不表示当前目录已经存在；语言迁移可分开执行，现有 TS 桥接期实现同一协议。

```text
backend/
  contracts/                 # wire Schema、ID/精度/过滤/错误契约
  domains/
    identity/ assets/ datasets/ runs/ observations/ reviews/
    reliability/ optimization/ collaboration/
  ports/
    transactions/ facts/ event_log/ artifacts/ clock/
  adapters/
    oltp/postgresql/ opengauss/ sqlite/
    clickhouse/ event_log/ artifacts/
  workers/
    normalize/ materialize/ publish/ outbox/ snapshot/ cleanup/
  migrations/
    control/postgresql/ opengauss/ sqlite/
    analytics/clickhouse/
  tests/
    contracts/ adapters/ integration/ recovery/ performance/

evaluation-service/          # 单独服务/仓库，自己的事务与事实 namespace
  contracts/ orchestration/ plugins/ adapters/ tests/
```

公共模块仅含稳定契约与必要基础能力，插件、业务 SQL、Benchmark harness 不能放入通用 utils。平台与评测服务无源码内部 import/共享数据库 Session。迁移目录按后端分开，事件 Schema 和物化规则也单独版本化。

当前需要接管的入口至少包括：

| 当前入口 | 目标接管职责 |
| --- | --- |
| `src/lib/storage/{data-service,db-interface,prisma,execution-list-sql}.ts` | 业务 port、事务/事实适配器和统一 Filter AST |
| `src/lib/ingest/otel*`、各 framework adapter | 稳定事件信封、可靠接收、Span 映射和归一化版本 |
| `src/app/api/observe/{data,session}/route.ts` | 摘要列表、真正的 Span/正文分页 |
| `src/server/trace-datasets/source-reader.ts` | 不可变 Trace 输入快照，不再 SQLite JSON1 读取 |
| `src/lib/trace-tags.ts` | 注释事务权威、CH 投影和删除一致性 |
| `src/app/api/experiments/` | 固定 RunPlan、attempt、结果和人工裁决 |
| `src/lib/evaluators/` | 评估器 release、输入能力、指标 Schema 和结果事实 |
| `src/lib/benchmark/`、`packages/benchmark-protocol/`、`services/evaluator/` | 版本化插件与独立服务协议；保持公私数据边界 |
| 工作台/诊断/优化/RAS/FI/Goal Plus/协作/用量路径 | 各领域控制/事实分离，不能只改 Trace 页面 |

实施盘点须搜索并登记全部直接 ORM、raw SQL、文件缓存与删除入口；当前入口清单是起点，不是宣称已盘点所有调用点。

## 3. 分阶段交付

### P0：契约、依赖与容量基线

- 冻结 workspace/资源 ID、时间/金额精度、缺失、revision/epoch、错误类别、Filter AST、Schema 兼容、访问域与版本发布契约。
- 对实际部署版本生成旧模型逐字段映射，分类为控制表、事实、制品、废弃且有理由的字段；保留数量、ID 和 hash 对照。
- 核对既有 Python/独立评测服务方案及本次扩大边界；确定各服务写入所有者。
- 建立设备/版本清单和 phase1 的 R1000 负载生成规则，记录平均与 P95/P99 载荷；建立原 SQLite 基线，仅用于比较，不作为目标容量证明。
- 冻结生产/Local 两种 durable-ack 定义、日志/ArtifactStore 容量与拒绝策略。

门禁：规范化数据包与三后端能力矩阵可审阅，所有核心不变量有对应验收用例；未取得实机版本前不得写“openGauss 与 PG 完全兼容”。

### P1：三事务适配器与 ClickHouse 真库 PoC

- 每个事务后端建立独立迁移、连接池、健康/版本探测和事务 port。
- 测唯一性、CAS 草稿编辑、资产发布、outbox 原子性、并行领取、续租、取消和 stale fence；SQLite 使用同主机短事务。
- 在真实 CH 执行核心 DDL，校验 Nullable、时间精度、Decimal/UInt64、分区与替换身份；验证 FINAL/argMax 与删除语义。
- 校准客户端同步批量与异步插入策略、复制/读取目标、水位、断电/进程故障恢复边界。

门禁：三个真实事务后端各通过相同合同测试，并各完成“资产发布 → 任务领取 → Outbox → CH 事实查询”链路。Mock/协议握手不能替代该证据。

### P2：完整 Trace 垂直链路

- 接收信封、持久日志、幂等/冲突隔离、稳定实体分区和 canonical merge。
- 实现正文先行写入、Span 当前态、Trace 摘要、关系、索引水位和恢复 checkpoint。
- 结构/Span/正文 API、虚拟树/时间窗、分块读取和异步导出；保留原始映射、单位与完整内容。
- 实现不可变快照：水位固定、节点 manifest、正文引用、发布与中止回收。
- 首个真实采集框架覆盖 root/child Agent、LLM、Tool、重复、迟到及超长正文，再推广到其余框架。

门禁：10,000 Span 冷读与持续追加场景可用；数据库查询字节、API 内存和响应体证明单节点读取未加载完整 Trace。完整导出节点数、正文 hash、父子映射一致。100,000 Span 完成压力边界测试。

### P3：资产与数据集多版本

- 实现独立资产身份、CAS 草稿、分支、release、依赖图、alias 和内容包。
- Skill/Agent/Evaluator/Dataset/Benchmark 五类 Schema，依赖发布检查、输入能力与 manifest fingerprint。
- Dataset 样本修订、草稿 patch、成员清单构建、public/private 分域、异步发布。
- UI/接口提供差异、分支、版本选择和回滚 alias；不在历史版本差异中泄露凭据。

门禁：两个用户并发编辑冲突显式呈现；同名同版不同内容拒绝；别名回滚不改变已启动实验；改数据集/评估器/Agent 后历史 RunPlan hash 和样本内容不变。

### P4：评测与 Benchmark 可扩展闭环

- 运行计划、Case/评估 attempt、fence、幂等回执、有效尝试选择、取消和独立结果发布。
- 评估结果/指标/证据进入 CH；人工裁决独立历史与选择策略；报表显示 coverage、分母、缺失/失败/取消。
- 独立评测服务支持无平台固定输入；平台无评测服务仍支持观测。
- 至少接入一种真实 Benchmark（如已具备官方 Harness 的 SWE-bench 形态）和一种不同指标形态的评测包，分别固定包/数据/环境/归一化版本。
- 扩展评估器输入为 final_answer、selected_spans/full_trace 等，超限明确分段/拒绝策略。

门禁：重试、重评、人工修正与迟到回调不重复统计；Agent 无法取得 private gold；新增普通 Benchmark/指标不修改核心表；真实 Harness 和真实模型结果与模拟测试分别报告。

### P5：其余领域与分析投影

- 接管标签、诊断、优化、Skill 工作台、RAS/FI、Goal Plus、协作、基础设施与用量。
- 保留 FI 环境回收、Goal 候选采纳、凭据撤销、命令 ACK 等事务语义；历史消息/事件和遥测进入 CH。
- Filter AST、字段注册、索引预算、常用查询投影、可重算 rollup generation、精确/近似标识和资源配额。
- 删除屏障、固定引用/pin、过期清理、原始日志与物理对象生命周期。

门禁：没有常用查询逐条回 OLTP 读取百万 Trace 的路径；没有继续读取旧 Execution/Session 的隐式后门；当前状态、热统计与恢复引用均有明确所有者。

### P6：历史迁移、三后端切换与恢复

- 为真实部署基线生成完整迁移清单及字段转换器，旧数据只读保留；未知值/损坏记录隔离，不静默跳过。
- 转换 Trace/节点/正文，构建历史 release/snapshot 与有效评分选择，记录 legacy ID 映射。
- 全量回填、受控增量追平、影子读对比、单写切换、备份恢复和反向增量回退。
- 验证事务后端六个有向组合：PG↔openGauss、PG↔SQLite、openGauss↔SQLite；超出 SQLite 部署容量时先校验并拒绝迁移，不承诺同等性能。

门禁：逐域行数/逻辑实体数、全部必要内容摘要、权限、关系、选择结果和聚合对照；切换后新写入可恢复，旧 owner 无法继续完成任务；CH 路由与资产 ID 稳定。

### P7：混合负载、故障与发布

- 执行 R1000 常态 24h、高吞吐 1h、突发 5min、大 Trace、重型分析、评测并行混合，禁止仅单项峰值相加推断整体容量。
- 完成故障矩阵、备份恢复、限流与积压恢复；冻结实测容量、拓扑、RPO/RTO、留存与部署档位。
- 更新中英文安装/配置、三事务后端选型与切换、数据保留/导出、版本管理、Benchmark 扩展、运维排障和开发契约指南。实现尚未完成时不能把目标行为写成公开现状。

门禁：所有目标档位有报告；未达标的负载或数据库发行版明确列缺口，不能“已接通”替代“已认证”。浏览器验证按仓库要求在用户确认后启动指定 dev 脚本；本设计轮不启动 dev。

## 4. 必须覆盖的正确性与故障矩阵

| 测试 | 必须成立 |
| --- | --- |
| 同 event_id 同内容重复、重启重放 | 逻辑实体和指标不重复 |
| 同 event_id 不同内容 | 冲突被隔离，可定位原始包 |
| 两消费者并行合并、所有者切换 | 不丢另一方字段；恢复后再处理新事件 |
| 在线与历史回填 revision | 同一量纲、明确 epoch；旧数据不覆盖新状态 |
| 旧 Span 失败→新版本成功 | 按失败筛选不命中旧失败行 |
| 累计 Token 100→150，后续重试 | 有效总数 150，不能 250/300 |
| 正文写一半、Span 更新前后宕机 | 不返回虚假完整正文，可恢复并核对 hash |
| CH 某表成功、另一表超时 | checkpoint 不越过未完成批次，重试安全 |
| 数据写入但 ACK 丢失 | 客户端/Worker 重试不产生重复有效结果 |
| 接收日志/CH/对象存储分别故障 | 符合 durable-ack 定义，超出配额明确拒绝 |
| Replica 查询落后 | 响应标明 indexing/水位，不能假装已读己之写 |
| 物理合并后按旧 revision 查询 | 不错误声称恢复快照；冻结输入仍能完整读取 |
| Trace 持续追加时固定评测输入 | run 使用的 snapshot hash 和正文不变 |
| 发布百万样本中断/同时编辑 | 不发布半成品，重试同内容幂等；CAS 冲突 |
| 修改 Agent/Skill/Evaluator/Dataset alias | 已启动 run 的依赖不改变 |
| 旧 owner 回调成功/取消竞争 | 只允许合法 fence 完成；终态不复活 |
| 重试、人工裁决、模型失败、缺失评分 | 机器历史保留，分母/coverage/缺失语义正确 |
| 多评估器多指标 | 不把一 Case 计为多个 Case |
| Benchmark 版本/Schema 不兼容 | 运行前拒绝并给明确缺口 |
| 工作区越权/猜测正文 ID | Trace/Span/正文/快照均拒绝，gold 独立隔离 |
| 删除后旧日志、隔离队列重放 | 删除屏障生效，不重新显示已删内容 |
| pin 与保留期、强制删除 | 普通 TTL 保留必要输入；强制删除标记不可重现 |
| CH 分片扩容/日志重分区 | locator/epoch 正确，旧 Trace 仍可读，修订不倒退 |
| 外部模型同名版本变化 | 留实际调用元数据，不伪称逐字可复现 |
| 大正文搜索跨块/中文/大小写 | 搜索语义和详情版本一致 |
| 事务库切换后回退 | 包含切换后写入，不只恢复旧连接串 |

## 5. 验收证据分层

1. 静态/类型/合同测试：证明接口约束和代码路径，不证明数据库行为。
2. 三真实 OLTP + CH 测试：证明指定版本上的约束、精度、事务和查询一致性。
3. 故障注入与备份恢复：证明约定故障模型内的恢复能力，不外推任意介质故障零丢失。
4. 接近真实样本的混合压测：报告每一负载、硬件、冷热、P95/P99、错误、积压、扫描和内存，证明容量边界。
5. 浏览器/真实采集端/真实评测：分别验证交互、实际数据链路和模型/Harness；记录实际覆盖与缺口。
6. 迁移影子读与回退演练：证明该部署数据可切换，不以合成样本代替用户存量数据核对。

测试命令随目标代码建立后固定。当前仓库 `npm run test` 是旧 TypeScript 回归入口；不能用其通过推断新 Python/三数据库/CH 架构已通过。只修改设计文档时验证链接、结构和一致性，不运行与改动无关的运行时全量测试。

## 6. 设计评审需要确认的事项

已确认：ClickHouse 分析库；PG/openGauss/SQLite 可选事务库；不复用旧表；千级为 1,000 在线采集端混合读写。

推荐并写入目标设计：不可变资产版本与输入快照、Span 与正文独立保存、任务控制和评分事实分离、可靠日志、分档部署及受控迁移切换。具体数据库发行版、日志产品/硬件、留存与 SLO 候选值在 PoC 前冻结。确认设计后再编写可直接执行的逐任务代码计划，不在本设计轮提交运行时代码。

## 追加批次：default项目兼容预留（2026-11-12）

已获用户授权按default收口，沿用独立分支与显式隔离数据库，不接入项目UI。

1. `schema/{sqlite,postgresql,opengauss}/003_projects.sql`、`project-catalog.json`、`tests/test_projects.py`：先写默认目录、历史workspace回填、FK/不可变和跨后端合同，再生成两表增量；保持001/002字节不变。
2. `control.py`、`relational.py`、迁移/关系库测试：新workspace与default映射同事务；旧001/002核心不隐式升级；source_evidence随已应用版本纳入项目目录。验证002→003备份/回滚、业务及IAM行保留，再跑PG/openGauss。
3. `projects.py`、`iam.py`、`authorized.py`、IAM/授权测试：保留稳定default标识与不可变上下文；拒绝未知项目、停用项目、缺失归属；Scope/指纹携带project_id；验证同default不扩大权限、旧调用仍兼容。
4. 更新字段字典/关系总览、实施状态和中英参考。执行`python3 -W error::ResourceWarning -m unittest discover -s services/storage/tests -v`，分别记录真库和明确跳过项；目标环境可用时运行官方原生SHA驱动合同。执行现有应用`npm run test`并保留失败边界。仅文档完成不能替代代码验证。
5. 本地提交并保留运行库与旧备份；不自动创建真实项目Owner、不为用户更换上传目标。完整项目成员/邀请留待后续增量设计。

本批执行结果：默认专项141通过/99外部引擎项明确跳过；另有迁移/关系库57项、PG最终43项和原生openGauss最终43项全部通过，覆盖存在重叠，不加总为独立用例数。应用全量本轮停滞中止，未作为通过。详见[实施状态](implementation-status.md#003-default项目预留)。
