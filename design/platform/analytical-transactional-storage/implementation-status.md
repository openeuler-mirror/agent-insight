# 存储核心、IAM 与三库适配实施状态

日期：2026-11-12。当前已完成001核心基础和本批IAM/002/统一授权/三事务库合同；整体重构及现有Web接管仍在实施中。总体目标见phase1/phase2，本批执行范围见[phase5](phase5-iam-adapters-plan.md)。

## 基线与交付

- 工作分支`codex/storage-core-refactor`基于已同步的`upstream/master`：`298d1d5b10ab3ab67a955b41a1665b0cd4d26b54`，旧库基线96个Prisma模型。
- `001_core.sql`四套原始字节均保持不变；新增SQLite/PG/openGauss三套`002_iam.sql`与机器字段目录。
- 当前物理核心为 **31张事务表+13张CH表=44张**：001原34张，002新增10张IAM表。完整字段/类型/约束/索引见[字典](core-table-dictionary.md)。这不是原59张逻辑目录的全部实现。
- `services/storage/control.py`、`relational.py`共享资产/发布/草稿/别名、RunPlan、任务lease/fence/取消、结果回执与Outbox原子性。PG/openGauss写锁粒度为正确性基线，尚未完成千级混合容量优化。
- `iam.py`实现稳定主体、密码派生、会话/API凭据、用户组/成员CAS/最后Owner保护、空间归属、资源归属与显式共享/撤销。组管理员全组读取，普通成员本人/共享，viewer只读；无隐式平台管理员。
- `authorized.py`统一校验元数据/列表/Span/正文/聚合/有界制品下载。CH读取和下载前后重新校验权限；慢I/O与密码派生不占写事务。私有评测gold不通过普通制品端口开放。
- `clickhouse.py`保持最新态后筛选、结构分页/单点、多section正文bundle、分块/hash和有界请求；新增范围绑定聚合、删除屏障及Token未知覆盖度。未知总数返回null，并提供已知和/缺失数量，不冒充完整零值。
- `migrations.py`与CLI实现已知连续前缀、checksum、显式迁移计划及原子升级。SQLite备份后锁源重核；服务端先取迁移表锁再建立快照，绑定备份源身份/历史/全部托管表内容证据。DDL不得自行提交事务。
- `legacy.py`继续提供只读原始清点/导出/验证，保留活跃WAL、类型、物理列、重复行和摘要；不执行96模型的语义转换或旧库目标导入。

## 最终验证

| 层次 | 实际结果 | 证明范围 |
|---|---|---|
| 存储Python全套 | **192通过、0失败、0跳过，49.397秒**；ResourceWarning作为错误 | 同时启用SQLite、PG、openGauss兼容测试连接和CH，包括DDL、迁移、IAM、三后端授权和跨库业务链路 |
| PostgreSQL | 15.19，ARM64 `postgres:15-alpine`隔离容器；固定psycopg2-binary2.9.10 | 真实控制/只读快照/并发领取/Outbox、001→002保留、故障回滚及备份屏障；多Owner并发在RC/RR下均保护最后有效Owner |
| openGauss原生认证 | **31通过、0失败、0跳过，27.177秒** | 7.0.0 build2397a86f、PG兼容模式；Linux ARM64/Python3.11.13、官方psycopg2/libpq2.9，原生SHA256认证；IAM12+授权7+CH闭环3+业务/迁移9 |
| ClickHouse | 25.8.12.129 official build，macOS ARM64隔离实例 | 13表、最新态、正文完整性、每后端万Span分页/单点/跨空间统计、撤权和删除屏障；未知/混合/真实零Token覆盖度 |
| 独立审查 | 已修复发现的授权/迁移竞态，并执行回归 | 下载期间撤权、分析删除屏障、时钟回退撤销、迁移等待写入者后的旧快照、顶层COMMIT与失败迁移回滚 |
| 既有应用`npm run test` | **5241通过、44失败、24跳过，共5309；760.676秒** | 全量未通过；未将该结果写成完整应用验收成功 |

192项细分：授权门面7、PG/OG授权合同38、CLI2、CH单元10/真库6、通用合同4、SQLite控制11、IAM12、IAMDDL15、旧库导出22、迁移17、关系库22、核心DDL17、三后端CH闭环9。原生31项为在另一驱动/运行环境执行的同一组合同，不加算成223个独立测试。

本批应用全量使用新建隔离`AGENT_INSIGHT_HOME`及Prisma测试库。与上次70项存储基础交付时的全量结果（5242/43/24）相比，本轮增加一项Dify安装fixture子进程超时（status=null）；其余失败名称相同，涉及既有UI/FI/RAS/构建平台等。本轮未修改`src/`、`test/`、`prisma/`、`package.json`、lockfile或RAS/FI模块；未做clean-master对照，不宣称新增失败为0。未启动Next dev，**未在浏览器中验证**。

### 本次证据

- Python最终日志：`/var/folders/8s/r6t1yc991fq4xdx422ccr29h0000gn/T/storage-iam-final-63stwx41/python-suite.log`。
- 原生openGauss日志、已测源码指纹及环境记录：`/var/folders/8s/r6t1yc991fq4xdx422ccr29h0000gn/T/agent-insight-opengauss-env-rgbg5yn9/`中的`native-matrix-final.log`、`native-tested-files-final.json`、`environment-evidence.json`。最终已测代码指纹与仓库一致。
- 应用全量日志：`/var/folders/8s/r6t1yc991fq4xdx422ccr29h0000gn/T/storage-iam-npm-804gb9xj/npm-test.log`。
- openGauss官方服务端归档SHA256：`e3a71a23a84871293f2c43d27044e01a169699ba65b19c1766c802b4d10a50c5`，已与官方校验文件核对。官方Python归档测量摘要`92c027718f2a5917e9eea6c2d26dba6e2ee53e0394a8c1ebf0ae6e6e9250aae7`仅为本次下载指纹，未获得单独发布的checksum，不声称完成发布摘要核验。
- CH固定官方发布资产SHA256：`541b149c0b73c44524cf3aff38541697736de266b36b6233811451a7922ee588`。

这些路径是本机临时证据，凭据另存在私有文件，未提交。原生openGauss与macOS普通psycopg2-binary的SHA256握手不兼容；主机兼容MD5 fixture仅辅助跑合同，不能作为生产配置建议。

## 数据保留与适用边界

1. 本批没有连接或迁移默认业务库，没有将旧数据自动归组，也没有覆盖旧备份。所有真实读写验证均使用本任务新建的隔离实例/数据库/schema。
2. 已有001初始化不隐式升级，基础控制操作仍可使用已知前缀；IAM要求显式迁移002。SQLite迁移保留私有一致性备份，事务失败回滚；PG/openGauss真实测试确认001行、release/run和原marker保留。
3. 服务端外部dump的恢复核验由运维完成，工具只验证文件hash、源证据及操作声明。测试中的备份fixture不等于真实生产dump恢复验收。
4. 新建IAM基础库不等于现有Web已经支持账号密码登录。Web入口、Cookie/CSRF、限流、账号恢复与既有外部身份迁移仍待接入。
5. 普通成员聚合为显式授权Trace集合，每空间最多1000根；删除屏障每空间最多1000根，查询总绑定参数最多4096。超出拒绝，后续须实现可扩展ACL/删除字典；制品下载暂限16MiB。
6. 组/空间转移、历史归属和旧用户映射仍需显式迁移清单，未映射空间保持隔离。现有业务写入口接管时必须同事务建立资源归属。

## 下一批

- 接入Durable Event Log、Outbox可靠投递、entity materializer与重放/冲突隔离，形成采集到CH可查询的可靠链路。
- 固定Trace快照、Dataset/Evaluator/Skill/Agent/Benchmark多版本发布与运行闭环，之后逐领域接管现有API。
- 旧模型逐字段转换、目标apply、增量/DELETE追平、影子读、停写切换及回退；当前原始导出不是迁移完成。
- Web身份/请求门面接入、规模化ACL/删除投影、保留期/pin/索引重建。
- 控制写锁细化、1000在线采集端混合读写压测、故障/HA及目标部署发行版恢复验收。

原首批70项结果已由当前192项专项取代；原全量失败证据与总体设计仍保留，不将本批测试外推为完整重构/生产切换完成。
