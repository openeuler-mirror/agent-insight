# ClickHouse 存储支持设计

## 结论

ClickHouse 不能平替 SQLite 作为通用主库：它是列式 OLAP 存储，没有唯一约束、外键和跨表事务，单行更新要走异步 mutation；平台 93 张表、约 970 处 Prisma 调用、97 处 `$transaction`，全量适配的成本和语义风险都不可控，而且 Prisma 没有 ClickHouse connector。

因此采用**分层存储**：ClickHouse 只承载高频、追加为主的 Trace 数据面（Execution、ExecutionSkill、Session），元数据与控制面（Skill、评测、实验、Benchmark、可靠性、协作等）继续使用 SQLite，OpenGauss 部署方式保持不变。Trace 写入与观测查询是当前并发瓶颈所在，分层后能直接解决；其余写入频率低，无需引入列存。

本设计**不修改 Prisma schema**：ClickHouse 表由独立 DDL 脚本管理，Prisma 仍只负责 SQLite 元数据。新增 API 路由为零，现有 `/api/ingest/*`、`/api/observe/data` 通过适配层切换后端。

同时保留一个诚实的替代项：若真实规模只是「单机数万 Trace/天、列表 P95 秒级」，迁移到 PostgreSQL 并补索引与分区，成本远低于引入 ClickHouse。设计评审应先确认这一前提。

## 方案对比

| 方案 | 内容 | 代价 | 结论 |
|-|-|-|-|
| A 全量适配 | 为 93 张表实现 ClickHouse 版本，承接全部读写 | 语义不可等价（事务、唯一约束、单行更新）；约 970 处调用需逐一验证；回归成本极高 | 不采用 |
| B 分层数据面 | Trace 三张表进 ClickHouse，其余留 SQLite/OpenGauss | 需要跨库 hydrate 与能力降级；多实例时元数据仍需共享库 | **采用** |
| C 只读镜像 | SQLite 为主，定时/触发同步到 ClickHouse 供分析 | 写入并发瓶颈未解决，只增加一份数据与同步延迟 | 不采用（可作为未来分析扩展） |

## 数据面与表模型

进入 ClickHouse 的表按第一版范围固定为：`Execution`、`ExecutionSkill`、`Session`。`ExecutionTag`、`TraceEvaluation`、`RasAnomalyEvent`、`InfraMetricSample`、`PlatformUsageEvent` 留到后续阶段，避免第一版把跨库查询铺得过宽。

`Execution` 的 DDL 草案（其余列按 `prisma/schema.prisma` 一一映射，此处列关键结构）：

```sql
CREATE TABLE IF NOT EXISTS executions (
  id               String,
  taskId           Nullable(String),
  `query`          Nullable(String),
  framework        LowCardinality(Nullable(String)),
  timestamp        DateTime64(3, 'UTC'),
  lastIngestedAt   Nullable(DateTime64(3, 'UTC')),
  user             LowCardinality(String),
  isSubagent       UInt8,
  parentExecutionId Nullable(String),
  rootExecutionId  Nullable(String),
  agentName        LowCardinality(Nullable(String)),
  tokens           Nullable(Int64),
  inputTokens      Nullable(Int64),
  outputTokens     Nullable(Int64),
  cost             Nullable(Float64),
  latency          Nullable(Float64),
  finalResult      Nullable(String),
  -- 其余字段按 schema 映射：BigInt → Int64，Boolean → UInt8，JSON 字符串 → String
  _version         UInt64,
  _deleted         UInt8 DEFAULT 0,
  _deletedAt       Nullable(DateTime64(3, 'UTC')),
  _expireAt        DateTime64(3, 'UTC') DEFAULT toDateTime64('2100-01-01 00:00:00', 3, 'UTC'),
  INDEX idx_id id TYPE bloom_filter GRANULARITY 4
) ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (user, isSubagent, timestamp, id)
SETTINGS index_granularity = 8192;
```

- 键列不可为 `Nullable`：ClickHouse 默认禁止 Nullable 列进入 `ORDER BY` 与分区表达式（需显式 `allow_nullable_key=1`），按草案原样建表会在首次启动即失败。因此排序键涉及的 `user`、`isSubagent`、`timestamp`、`id` 一律用非空类型，缺值写 `''` / 纪元时间，由适配层在读写两侧做 `null ↔ ''` 映射；其余非键列保留 `Nullable`。`_expireAt` 同样取非空 `DateTime64`，默认值表示「永不过期」，避免 `TTL` 表达式落在 Nullable 列上而行为不确定。
- 排序键覆盖主列表访问路径「按 user + isSubagent 过滤、按 timestamp 倒序」，避免 OpenGauss 模式下全量取回再切片的老路；`PARTITION BY` 按月裁剪，时间范围查询只扫相关分区。
- 去重键就是排序键。`user`、`isSubagent`、`timestamp` 属于键列，适配层按「首写固定」处理：同一 id 再次 upsert 时先取旧行，沿用首次写入的键列，避免上游缺少 `timestamp` 时（`data-service.ts` 会回落到当前时间）每次上报都换键、产生重复行。显式归属迁移不改原地更新，而是写旧键墓碑 + 新键整行。
- `ReplacingMergeTree(_version)` 的合并是异步的，读路径统一要求 `FINAL`（或 `ORDER BY _version DESC LIMIT 1 BY id`），否则会读到历史版本。
- 删除采用墓碑（`_deleted=1`）而非 mutation：读路径恒带 `_deleted=0`，物理清理由低峰期 `ALTER TABLE ... DELETE` 完成，或由墓碑与对应原始行共用同一个 `_expireAt` 触发 TTL——两者必须同时消失（见部署与运维）。`deleteExecution` / `deleteExecutions` 需要先 `SELECT count()` 再加墓碑，保持现有「返回删除行数」的语义。
- 大字段（`query`、`finalResult`、`Session.interactions`）保持 `String` 存 JSON，依赖列存压缩；全文检索只能在后续阶段加 `tokenbf_v1` 跳数索引 + `hasToken`，第一版不做前后模糊 `LIKE`。

## 写入链路

- 新增进程内写队列：按表攒批，达到 500 行或 100 ms 即 flush；`INSERT` 使用 `async_insert=1, wait_for_async_insert=1`，**请求等待本批落盘后才返回**，保证「写后可读」，代价是单条 ingest 最多多等一个批次窗口。队列有上限，超限直接返回 503 触发客户端重试，不做无界缓冲。
- `_version` 取「毫秒时间戳 × 1000 + 进程内自增序号」，且只能由单一 `nextVersion()` 函数产出（在线写入、回填、补写、修复工具一律调用它，禁止各自定义单位），保证同一 id 后写覆盖前写；同一批内重复 id 只保留版本最高的一条。
- `upsertExecution` 直接追加整行新版本；`updateExecution` 在本进程内按 id 串行化：`FINAL` 读当前行 → 合并 patch → 追加新版本。第一版只保证**单实例写入**语义，多实例部署写入同一 id 需要外部串行化，这一点写进部署约束。
- 标签、评测结果等二次写入若只改非键列，同样走「读-改-写」；只有 `user` 走显式归属迁移路径，按墓碑 + 新行处理，`timestamp`/`isSubagent` 不随重新上报变化。
- 批量删除按 where 翻译成 `SELECT id` 后分片写墓碑，单次上限 10,000 条，超出分段执行并记录审计日志。

## 读链路

- `findExecutions` 目前只有 `where` / `orderBy` / `select`，没有分页参数，OpenGauss 因此只能在内存里切片。ClickHouse 版要么扩展接口签名，要么新增 `findExecutionPage(where, orderBy, skip, take)` 返回 `{ rows, total }`；接口改动需同步给 OpenGauss 一个等价实现（做不到就显式声明不支持，不再假装分页）。第一版保留 `LIMIT/OFFSET` 以维持现有分页语义，深分页与精确 `count()` 的代价在压测基线中量化，是否引入 keyset 由基线数据决定。
- `findExecutionById`、`findSessionByTaskId`：按 id 精确查，依赖 bloom filter 跳数索引与时间范围裁剪。
- `aggregateExecutionList`（列表统计）：改写为 ClickHouse 版聚合（`count` / `countIf` / `avg` / `sum`），保持 `execution-list-sql.ts` 现有的总数、失败数、平均延迟、工具错误率口径，不为快而换口径。`cost` 与 `status` 是读时计算列（按模型前缀匹配定价表、按生命周期阈值判定状态），ClickHouse SQL 必须复用同一表达式，否则排序和筛选结果会与 SQLite 分叉。
- 查询翻译只覆盖现有筛选实际用到的算子：`equals`、`in`/`notIn`、范围比较、`AND`/`OR`/`not`、时间区间、`contains`/`startsWith`（映射为 `positionCaseInsensitive`/`startsWithCaseInsensitive`，两者统一大小写不敏感，与 SQLite `LIKE` 默认行为对齐）；若某个算子无法保持同一大小写口径，必须写进降级矩阵显式声明差异，不得默默按大小写敏感实现。不支持的算子必须抛错并在接口层返回明确提示，禁止静默忽略筛选条件。
- 跨库 hydrate 保持现有「先取当前页 id，再按 id 批量补数据」的模式：标签、评测、Skill 版本从 SQLite 按 id 取；按标签/评测筛选走两段式（SQLite 先出 id 集合 → ClickHouse `id IN (...)`），集合过大时明确拒绝并提示缩小范围。

## 后端选择与能力降级

- 新增显式开关 `DB_TYPE=sqlite|opengauss|clickhouse`，缺省 `sqlite`。`DB_HOST` 保留为 OpenGauss 的兼容写法，校验必须是双向的：`DB_TYPE=opengauss` 必须同时设置 `DB_HOST`；`DB_TYPE=sqlite|clickhouse` 必须不设置 `DB_HOST`；`DB_HOST` 与 `DB_TYPE` 同时出现且不一致时启动失败。不猜测意图——否则「只设 `DB_TYPE=opengauss` 漏设 `DB_HOST`」会让能力查询认为当前是 OpenGauss、适配器却按 `DB_HOST` 为空走 SQLite，数据被静默写进本地文件。
- ClickHouse 连接变量：`CLICKHOUSE_URL`、`CLICKHOUSE_DATABASE`、`CLICKHOUSE_USER`、`CLICKHOUSE_PASSWORD`、`CLICKHOUSE_TLS`。`DB_TYPE=clickhouse` 时 `DATABASE_URL` 仍指向本地元数据 SQLite（默认运行根 `data/witty_insight.db`），元数据与 Trace 数据分别部署、分别备份。
- 新增 `src/lib/storage/backend.ts` 暴露后端与能力（如 `traceStore`、`supportsSystemTags`、`supportsCrossStoreFilter`），把 9 个文件里 22 处 `process.env.DB_HOST` 判断替换为能力查询；避免出现「换了库但某些能力按 OpenGauss 的口径被误关」。
- `DatabaseAdapter` 增加 `ClickHouseAdapter`；未实现的方法统一抛 `UnsupportedBackendError`，由 API 层转成 501 + 功能名。现有 `prisma.ts` 包装层里「返回 null + 告警」的分支必须一并改成抛错——静默空数据比报错更难排查。
- 降级矩阵（ClickHouse 模式第一版）：

| 能力 | SQLite | OpenGauss（现状） | ClickHouse（第一版） |
|-|-|-|-|
| Trace 写入/列表/详情/统计/删除 | 支持 | 支持（分页退化为内存） | 支持（下推分页） |
| Trace 标签展示 | 支持 | 降级 | 支持（跨库按页 hydrate） |
| 按标签/评测筛选 | 支持 | 降级 | 降级或两段式，超限拒绝 |
| Skill / 评测 / 实验 / Benchmark / 可靠性 | 支持 | 部分降级 | 继续走 SQLite，功能完整 |
| 系统标签、版本分析 | 支持 | 降级 | 继续走 SQLite，按能力开关决定 |

## 初始化、迁移与回滚

- 建表由 `scripts/init_clickhouse.ts` 幂等执行（`CREATE TABLE IF NOT EXISTS`），不经过 Prisma migrate；启动脚本在 `DB_TYPE=clickhouse` 时调用，失败即退出，不带着半套表启动。
- 存量回填：从 SQLite 按 `timestamp` 分页读取 Execution/ExecutionSkill/Session，批量写 ClickHouse；`_version` 由与在线写入相同的 `nextVersion()` 生成，基准取 `lastIngestedAt ?? timestamp` 的毫秒值（再乘 1000 并追加单调序号），保证回填与在线同量纲、重跑不会读到旧版本。按 id 抽样比对字段哈希、按时间范围比对行数，校验不通过不切换。
- 切换以配置为准：`DB_TYPE=clickhouse` 生效、回退即删除该变量。切换窗口建议短暂停写或开启双写；回滚后窗口内只写入 ClickHouse 的记录需要反向补写，补写工具与校验脚本与回填工具共用。
- 现有 SQLite 到 ClickHouse 的迁移不修改源库；Prisma schema 不变，回滚后 SQLite 结构无需迁移。

## 部署与运维

- 第一版要求 ClickHouse 以单节点部署（HTTP 接口），平台与 ClickHouse 同机或内网互通；多副本共享 Trace 数据时元数据库必须同时改为共享库，这一点单列为后续阶段，不在第一版承诺。
- Docker：`@clickhouse/client` 是纯 JS 依赖，可随默认镜像发布；`scripts/docker-entrypoint.sh` 允许 `DB_TYPE=clickhouse`，`DB_HOST` 报错逻辑保持不变。docker-compose 增加可选 profile 拉起 ClickHouse，不改变默认启动。
- 备份：Trace 数据用 ClickHouse 原生 `BACKUP`（或部署方选用的备份工具），元数据继续按现有 SQLite 流程；备份与恢复指南增加「两套存储需分别备份、恢复顺序为先元数据后 Trace」。
- 保留期：写入时计算 `_expireAt`，表级 `TTL _expireAt DELETE`。不提供「墓碑单独短 TTL」这一选项：墓碑必须与对应原始行同时物理清理——要么墓碑的 `_expireAt` 不早于其原始行（墓碑 TTL ≥ 数据保留期），要么两者统一走低峰期条件 `ALTER TABLE ... DELETE`。否则墓碑先于原始行被 TTL 清掉，`FINAL` 会读到已删除的旧行，表现为「已删除数据数天后复活」。契约测试覆盖「墓碑过期后读不到被删行」。现有运行缓存清理明确不覆盖业务表，本方案不改变该边界。
- 监控：应用侧暴露写队列深度、flush 延迟、失败重试次数；ClickHouse 侧关注 `system.parts` 合并、`system.query_log` 慢查询与单查询扫描行数，压测基线随开发计划交付。

## 风险

| 风险 | 影响 | 缓解 |
|-|-|-|
| 语义差异（无事务、异步合并、mutation 代价） | 读到旧版本、删除不即时 | 读写统一 `FINAL`、墓碑 + 条件 TTL、契约测试覆盖 |
| 查询翻译覆盖不全 | 筛选条件被忽略或报错 | 白名单算子 + 未支持即抛错 + 契约测试矩阵 |
| 键列可变的归属迁移 | 去重失效、出现重复行 | 键列不可变约束；变更走墓碑 + 新行，专项测试 |
| 单实例写入假设 | 多副本部署产生读改写竞态 | 文档限定第一版单写实例；多实例方案列为后续阶段 |
| 引入 ClickHouse 的运维成本 | 小规模部署收益为负 | 评审先确认规模前提；默认部署不引入 |
| 长期维护两套后端 | 测试与修复成本翻倍 | 能力开关收敛、契约测试、按阶段扩大表范围 |
