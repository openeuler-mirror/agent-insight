# 存储核心、IAM、default项目与三库适配实施状态

日期：2026-11-12。当前已完成001核心基础、IAM/002/统一授权/三事务库合同与003 default项目预留；整体重构及现有Web接管仍在实施中。总体目标见phase1/phase2，IAM批次范围见[phase5](phase5-iam-adapters-plan.md)，default追加范围见[开发计划](phase3-development-plan.md)。

## 基线与交付

- 工作分支`codex/storage-core-refactor`基于已同步的`upstream/master`：`298d1d5b10ab3ab67a955b41a1665b0cd4d26b54`，旧库基线96个Prisma模型。
- `001_core.sql`四套原始字节均保持不变；新增SQLite/PG/openGauss三套`002_iam.sql`、`003_projects.sql`与机器字段目录。
- 当前物理核心为 **33张事务表+13张CH表=46张**：001原34张，002新增10张IAM表，003新增项目目录与workspace归属2张表。完整字段/类型/约束/索引见[字典](core-table-dictionary.md)。这不是原59张逻辑目录的全部实现。
- `services/storage/control.py`、`relational.py`共享资产/发布/草稿/别名、RunPlan、任务lease/fence/取消、结果回执与Outbox原子性。PG/openGauss写锁粒度为正确性基线，尚未完成千级混合容量优化。
- `iam.py`实现稳定主体、密码派生、会话/API凭据、用户组/成员CAS/最后Owner保护、空间归属、资源归属与显式共享/撤销。组管理员全组读取，普通成员本人/共享，viewer只读；无隐式平台管理员。
- `authorized.py`统一校验元数据/列表/Span/正文/聚合/有界制品下载。CH读取和下载前后重新校验权限；慢I/O与密码派生不占写事务。私有评测gold不通过普通制品端口开放。
- `clickhouse.py`保持最新态后筛选、结构分页/单点、多section正文bundle、分块/hash和有界请求；新增范围绑定聚合、删除屏障及Token未知覆盖度。未知总数返回null，并提供已知和/缺失数量，不冒充完整零值。
- `migrations.py`与CLI实现已知连续前缀、checksum、显式迁移计划及原子升级。SQLite备份后锁源重核；服务端先取迁移表锁再建立快照，绑定备份源身份/历史/全部托管表内容证据。DDL不得自行提交事务。
- `legacy.py`继续提供只读原始清点/导出/验证，保留活跃WAL、类型、物理列、重复行和摘要；不执行96模型的语义转换或旧库目标导入。

## 003 default项目预留

- 新增`projects`与`project_workspaces`；新目标初始化应用001+002+003。001/002原始字节保持不变，旧目标需显式备份/核验证据后迁移。
- 003为全部既有workspace补default归属，原ID（包括既有非规范ID）逐字保留，不重写业务/CH行，不生成IAM账号、成员、Owner或ACL。新workspace及default映射同事务提交。
- `projects.py`提供稳定default标识、不可变ProjectContext和有界解析。未指定项目兼容default；显式空字符串、空白、其他项目拒绝，未绑定/停用项目失败关闭。
- AccessScope、workspace grant、列表/聚合元信息和scope指纹带project_id；同default不扩大现有workspace/资源权限。项目禁用后仍能撤销本人会话/Key，认证与项目授权分别检查。
- 当前仅新存储库预留default，现有Next.js/Prisma、已部署客户端和业务运行库未切换。项目UI、Owner/邀请/多项目成员及切换上报流程属于后续增量，不因目录存在就视为已实现。

### 本批验证记录

- 默认专项命令（未配置外部数据库变量）：**执行240个测试条目，141通过、99明确跳过、0失败**，15.547秒。跳过的是外部引擎合同，不能写成240项全通过。
- 迁移/关系库/CLI专测：**57通过、0跳过**，186.335秒，含真实PG/openGauss各14条控制合同。结果记录在子任务工具输出，未独立保存原始日志；不将工具摘要当作恢复演练证明。
- PG最终复验：**43通过、0跳过**，25.953秒，包含真实PG项目授权/CH闭环29、PG DDL约束4、SQLite/目录检查10；采用最后的注销修复代码。日志为`/var/folders/8s/r6t1yc991fq4xdx422ccr29h0000gn/T/storage-projects-pg-kovx7agl/pg-scope-ddl.log`。
- 原生openGauss官方Linux ARM64/Python3.11 SHA256：**43通过、0跳过**，804.600秒；IAM16、授权10、真实CH闭环3、控制/迁移14。此次执行受资源竞争影响，不作为吞吐基准。
- native额外003 Schema事务探针验证5类旧workspace ID逐字保留（首尾空白、空ID、600字符、C0、C1），无隐式IAM授权，另有9项预期约束拒绝；探针全部回滚。
- 所有46表主键/排序键及显式UK/IDX清单与目录/DDL核对，8张Mermaid图解析和实际渲染通过。修改文件链接、代码围栏、空白和Python编译检查通过。
- 应用`npm run test`本轮约1056秒后因长期无新输出停止，日志空闲约862秒；**未完成**，不统计完整通过/失败数。此前44项失败仅属于下方历史基线。本轮未修改现有应用源码/Prisma/依赖/脚本。
- 预先启动的旧版全套专项和原生42项在最后注销边界修复后作废/中止，最终结果不使用它们；只采用本节明确标注的最终代码验证。

证据：默认专项`/var/folders/8s/r6t1yc991fq4xdx422ccr29h0000gn/T/storage-projects-units-z64ank1t/python-units.log`；原生最终日志/源码指纹为已有OG证据目录中的`native-project-final43.log`、`native-project-final43-evidence.json`、`native-project-tested-files-final43.json`；当前代码与已测代码指纹一致。应用不完整日志与停止记录为`/var/folders/8s/r6t1yc991fq4xdx422ccr29h0000gn/T/storage-projects-npm-_tju0g4e/npm-test.log`、`interruption.json`。应用未在浏览器中验证，本批仅对文档图示做无头渲染检查。

## IAM/002批次验证（历史基线）

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

原首批70项结果及IAM/002批次192项专项作为历史证据保留；default项目增量另行记录。原全量失败证据与总体设计仍保留，不将本批测试外推为完整重构/生产切换完成。
