---
title: "启用隔离的 Storage Core Trace 链路"
description: "显式初始化、旧身份映射、原界面兼容与隔离 Trace 验证。"
---

# 启用隔离的 Storage Core Trace 链路

**产品兼容状态（2026-11-14）**：原登录、导航和前端页面保持重构前版本；本批通过服务端兼容旧Trace接口接入新存储。诊断会话、自身Trace及Trace报告按参考中的独立协议接管；Dataset版本/Trace回流/批量生成已按本页流程接管；实验/评测结果与DiagnosisRun逐项接管，当前覆盖及剩余Workbench/Benchmark等消费者以实施状态为准。仅在隔离目标验证，不用于生产切换。

模式开关只影响服务端。Trace接口使用当前IAM权限，配置缺失、身份未映射或后端故障明确失败，不回落旧Trace库。其他领域仍有既有数据路径，当前不是全产品切库。完整契约见[参考](../../reference/platform/storage-core.md)，实际覆盖见[实施状态](../../../../design/platform/analytical-transactional-storage/implementation-status.md)。

## 1. 准备独立目标

以下路径、端口、数据库名都是示例，须替换为本次专用目标。Python 需3.11+，ClickHouse需预先运行。事务后端可选SQLite、PG、openGauss；本流程用SQLite。原Prisma业务库不能直接传给core初始化/升级命令。

```bash
mkdir -m 700 -p /absolute/path/to/isolated-core
python3 -m services.storage init-sqlite --database /absolute/path/to/isolated-core/core.db
python3 -m services.storage migration-plan --backend sqlite --database /absolute/path/to/isolated-core/core.db
```

新库应用001–014，当前schema_version=14。已有已知前缀只校验，不自动升级；已有core目标须先备份并显式执行：

```bash
python3 -m services.storage migrate-sqlite \
  --database /absolute/path/to/isolated-core/core.db \
  --backup /absolute/path/to/isolated-core/new-before-upgrade.db
```

备份必须为新文件；不覆盖既有备份。关系库的`init-relational`/`migrate-relational`、私有DSN文件及外部备份证据见[参考](../../reference/platform/storage-core.md#显式初始化与版本迁移)。服务启动不会建表、创建CH数据库或隐式升级。

## 2. 首次配置账号、CH 和私有配置文件

在仓库根目录，用可信运维环境执行下例一次。目标CH数据库必须是不存在的新库；账号/空间名称为本地示例，密码交互输入，不进入命令行。账号恢复、邀请与多项目管理不在此流程内。

```python
import getpass
import json
import os
import secrets
from pathlib import Path
from services.storage.control import SQLiteControlStore
from services.storage.iam import IAMStore
from services.storage.clickhouse import ClickHouseStore

root = Path('/absolute/path/to/isolated-core')
control = SQLiteControlStore(root / 'core.db')  # 上一步已显式初始化至014
facts = ClickHouseStore('http://127.0.0.1:8123',
    database='agent_insight_core_isolated', user='default',
    password=getpass.getpass('ClickHouse password (empty if configured): '))
facts.initialize_new_database()
iam = IAMStore(control)
iam.create_principal('operator', 'operator', 'Operator')
password = getpass.getpass('New IAM password (15..1024 characters): ')
iam.set_password('operator', password)
control.create_workspace('default', 'Default workspace')
iam.bind_workspace('default', principal_id='operator')
session = iam.login('operator', password)
try:
    collector = iam.issue_api_credential(session, 'default', ['write'])
finally:
    iam.revoke_credential(session)

def private_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as target:
        json.dump(value, target, ensure_ascii=False)

private_json(root / 'collector.json', {'token': collector})
with os.fdopen(os.open(root / 'controller-key', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
    stream.write(secrets.token_hex(32))
private_json(root / 'trace-service.json', {
    'control': {'backend': 'sqlite', 'database': str(root / 'core.db')},
    'clickhouse': {'endpoint': facts.endpoint, 'database': facts.database,
                  'user': facts.user, 'password': facts.password},
    'cursor_secret_hex': secrets.token_hex(32),
    'controller_key_file': str(root / 'controller-key'),
    'default_workspace': 'default', 'port': 4319, 'worker_enabled': True,
})
```

`trace-service.json`必须为私有普通文件（0600，不是symlink），保留cursor_secret_hex可保持同配置下的游标签名；不要把密码、collector.json或此文件提交仓库。SQLite正文/计划制品位于`core.db.artifacts/`，备份恢复须同时保留该目录。PG/openGauss的control配置改为`backend`、`dsn`、`schema`、`artifacts`四字段，完整DSN只放私有文件；需匹配目标认证的驱动，不能把macOS普通PG wheel当作openGauss原生认证驱动。

## 3. 启动服务和 Next 桥接

```bash
python3 -m services.storage.trace_service --config /absolute/path/to/isolated-core/trace-service.json
```

服务只绑定127.0.0.1。`GET http://127.0.0.1:4319/v1/health`报告schema_version、worker_enabled和有限错误类型，不提供凭据或正文；ready仅表示服务/控制schema可用，仍需实际上报验证CH。worker_enabled=false可用于暂停物化的隔离恢复测试，不会把accepted当indexed。

为Next另建独立`AGENT_INSIGHT_HOME`和Prisma壳库；**不要把DATABASE_URL指向core.db**。现有其他页面/启动脚本仍可能初始化壳库。确认端口可用及当前worktree的.next归属后：

```bash
AGENT_INSIGHT_HOME=/absolute/path/to/isolated-web \
DATABASE_URL=file:/absolute/path/to/isolated-web/data/legacy-shell.db \
AGENT_INSIGHT_PORT=4320 \
AGENT_INSIGHT_TRACE_STORAGE=core \
AGENT_INSIGHT_STORAGE_CORE_URL=http://127.0.0.1:4319 \
AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE=/absolute/path/to/isolated-core/identity-mapping.json \
AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=/absolute/path/to/isolated-core/controller-key \
bash scripts/develop_start.sh
```

以上均为服务端变量，变更后重启Next；旧`NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE`仅作为服务端兼容别名，不再控制前端。loopback origin不能包含路径、查询或凭据。Next和存储进程需共享可达网络命名空间。

浏览器继续使用原`/login`及现有Key。配置端必须先核验既有身份，再建立明确的旧Key→IAM主体/空间绑定；不按payload.user、同名账号或邮箱域自动推断。`AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE`指定绝对路径的0600普通JSON文件，格式如下（全部为占位值）：

```json
{
  "version": 1,
  "core_origin": "http://127.0.0.1:4319",
  "bindings": [{
    "legacy_api_key_sha256": "REPLACE_WITH_SHA256_OF_VERIFIED_LEGACY_KEY",
    "legacy_username": "existing-user",
    "principal_id": "operator",
    "workspace_id": "default",
    "credential": "REPLACE_WITH_PRIVATE_WORKSPACE_READ_WRITE_DELETE_API_CREDENTIAL"
  }]
}
```

该credential由可信配置端通过`issue_api_credential(session,'default',['read','write','execute','delete'])`签发，不能使用前述write-only采集Key代替页面读取凭据。映射文件含明文代理凭据，只能保存在私有运行目录；服务端先验证旧Key，再校验代理凭据当前principal、workspace及权限，不能仅凭Key摘要跳过认证。此兼容配置是隔离验证手段，未来统一身份迁移仍须显式映射、轮换与撤权。

## 4. 上报并区分接收与索引

采集端使用固定workspace的`api_`凭据，不能用Web会话替代HTTP采集凭据。按已配置的采集器安全方式加载`collector.json`，将目标指向`/api/ingest/otel/v1/traces`，携带`Authorization: Bearer …`及可选`X-Workspace-Id`、`Idempotency-Key`。不要把token粘进URL或可记录的命令参数。

入口支持OTLP JSON/protobuf及gzip，解码后的JSON最大4MiB、4096个**完成Span**，归一化展开总预算64MiB。后端loopback端口只收JSON。默认来源为`otlp`，不同service.name的同一原生Trace仍聚合；service.name仅显示。需要明确来源隔离时使用resource属性`agent_insight.source_namespace`。同源修订用Span属性`agent_insight.revision`，默认为1；同版本不同内容进入失败，不能改包内容重用receipt key。

OTLP成功响应仍为空JSON对象/空protobuf；`X-Storage-Batch-Id`与`X-Storage-State`报告回执。accepted只代表私有原始制品fsync及控制事务提交。用同一采集凭据查询`GET /v1/batches/<batch_id>?workspace_id=default`，；write-only凭据只能查看本人回执。只有indexed代表所有sink完成；failed需检查回执错误，不按成功重传不同内容。

## 5. 按页检查 Trace

进入原`/trace`，列表、筛选、打标及详情继续使用旧DTO。兼容层逐页读取CH结构（每次最多200 Span），为原执行链路返回完整轻量结构，最多100000 Span/16MiB；这会读取全部结构，不能声称结构也仅按点击读取。普通OTLP结构不读正文，点击后才按固定interaction索引及payload_revision装载单Span正文，正文section每页最多4块。

原Trace bundle导入/导出保持v1格式及执行树/旧ID，导入最多50MiB/500个execution。全树先校验，冲突ID及嵌套引用一并重映射；成功仅在全部batch indexed后返回。`Idempotency-Key`可用于同一次导入恢复，不能复用给不同内容。导出及完整会话响应上限128MiB。原Langfuse页面直接消费完整nodes，因此兼容读取需要其完整正文；该特例不能计入普通OTLP的懒加载证明。未覆盖的业务能力及失败边界见实施状态。

当前观测事件流按最早事件强序处理；早期观测重试会阻挡该流的后续事件，Dataset/评测等领域使用各自类型的投递领取。每128 Span批量写正文，先chunks、后manifests，再Span及Trace摘要，重复写依赖相同版本收敛。这是可靠性基线，尚未完成1000在线采集端混合读写压测、分片日志或HA认证。当前浏览器验收状态以[实施状态](../../../../design/platform/analytical-transactional-storage/implementation-status.md)为准。

停止时对自己启动的服务使用Ctrl-C/SIGTERM，保留数据库、制品目录和私有配置；不要用全局进程清理命令影响其他worktree。

## 全量测试的隔离前提

存储专项与应用`npm run test`是不同门槛。应用全量须在专用HOME、AGENT_INSIGHT_HOME与SQLite目标运行，清除DB_*及core模式配置；不得指向日常业务库。测试中新增/修复的数据库用例复用`createIsolatedDatabase`，先建临时schema再导入Prisma，结束断开连接并恢复环境；隔离helper也清除继承的关系库配置，并固定空DB_HOST防止dotenv重新选择远端。

完整环境包括可用的Node LTS、Python的PyYAML/pydantic2、PowerShell7，以及Trae采集器编译产物。先用已安装、验证过的运行时，在该次测试进程设置PATH、PYTHON、AGENT_INSIGHT_FI_PYTHON、AGENT_INSIGHT_RAS_PYTHON；不要通过全局改配置或安装未获授权的依赖消除错误。PowerShell解析也使用临时HOME，避免宿主缓存/配置影响。Trae编译可使用仓库已有esbuild执行原compile参数，构建JS不代表完成VSIX打包或IDE验收。

准备旧Prisma路径的全量用例时，只对新建的隔离SQLite文件执行`prisma db push --skip-generate`；不能将此命令用于core.db。HTTP测试在失败路径也必须关闭连接，不能让清理SQL错误阻止server.close。缺依赖、缺schema和固定sleep抖动分别报告，不通过跳过或延长无限等待冒充业务验证通过。完整测试计数与平台跳过范围以实施状态为准。


## 验证诊断链路

先在隔离目标备份并显式升级至014；不要把演示配置指向旧Prisma数据库或默认业务库。已有原登录Key的私有映射凭据需要read/write用于追问、execute用于报告、delete用于原有删除操作，仍受Trace owner/组角色约束。仅write采集Key不能作为页面账号。

1. 用原账号登录，打开一条已授权Trace，再进入原故障诊断页。GET历史即使为空也应有已授权Trace，存储异常不能显示成“没有会话”。
2. 发起追问，观察原ready/text/tool/reasoning/done事件；在Trace列表查到`fault-diagnosis-agent`自身运行，按原上游session ID打开，核对工具输入/输出与失败状态。
3. 刷新页面、重启隔离存储服务后确认完整消息仍在。继续对话保持同一上游；显式新对话保留历史。成员无法读取他人私人Trace，组管理员可读组内历史，但跨actor续用已有上游当前返回409，需新建自己的对话。
4. 通过原AgentDebug/SkillsAnalysis入口运行报告并重新载入。强制重跑或删除期间，旧后台任务不得覆盖当前结果；停用账号或删除Trace后，不再返回正文。

验收必须注明是否调用真实模型。隔离fixture Agent可以验证真实SQLite/PG/openGauss事务、ClickHouse、HTTP/SSE及页面历史恢复，但不代表真实LLM诊断质量；最新实际覆盖见实施状态。旧诊断会话/报告不会自动导入，原数据与备份保留。

按原流程登录即可；诊断请求沿用同一个Key，退出和账号切换行为保持原样。


## 验证数据集链路（008/009）

新目标初始化到014；已有隔离core目标先停写，使用新的备份路径和CLI显式迁移至14，同时保留制品目录。迁移工具核对旧表内容，不能以Prisma db push替代，也不能直接指向原业务SQLite。

在原登录和侧栏进入「评测数据集」：新建→单个添加→编辑样例→新增字段，刷新后检查原值。另从Trace回流样例并重复追加，确认去重；使用两个草稿制造陈旧提交，确认409且先前修改保留。页面没有新增版本控件，版本摘要通过参考页所列查询接口读取。

先通过原OTLP入口上报，再在「基于Trace生成」选择有授权数据的Agent和时间窗，检查进度、发布样例、取消及删除回执。重启隔离Next/存储服务后，重新以原actor查看进度；活动旧租约须先到期，随后新epoch恢复。发布完成任务的取消返回冲突，删除仍需独立权限。未改实验/Benchmark消费者不应被视为本页验收的一部分。


## 实验链路隔离验证（010–014）

先停止目标写入，保留事务库备份与完整制品目录，显式迁移至014再启动；服务拒绝带pending migration启动。不要修改历史SQL绕过checksum。013→014只追加表，012→013修正空证据约束时保留全部历史行、索引及不可变触发器。

私有身份映射之外配置`AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE`，由可信配置过程生成随机64位hex并以0600保存；Next与helper使用同一文件，不能复用登录Key。原页面无需新增配置或交互。按创建实验→运行→结果详情→人工0分→评论→重评验证，分别核验OLTP回执、CH published与旧表无影子写入。再验证来源撤权、旧fence晚回、取消清理未确认和精确网络重试。Workbench/Benchmark使用同一原入口，具体可验收分支见实施状态。


## 旧数据迁移前的只读计划

先对已保留的一致性隔离副本执行`plan-legacy --database /absolute/path/to/isolated-legacy.db --source-id stable-source`；显式owner映射、预算、状态与隐私契约见[存储参考](../../reference/platform/storage-core.md#只读语义计划不执行导入)。报告可安全诊断但不替代原始备份/导出；活动WAL不能只复制主文件。当前只支持SQLite源，不支持导出目录输入，所有计划仍blocked且不执行导入。现阶段不在生产停写、迁移、修改凭据或切换连接串。

## 优化点回调与价格模型列表

core模式下，原优化点GET和完成优化后的resolve PATCH携带当前登录Key。新派生问题通过typed解决注解处理，旧static/feedback问题仍在原控制域；混合请求预检后分别提交，两域失败可重试但不是跨库原子事务。未提供threadId时，公开关联仍为null，机器评测内容不变。相同显式操作键恢复core回执；普通新请求按新增解决计数，混合响应是core该操作计数加本次旧静态新写计数，不保证整次HTTP数字精确重放。

价格GET的observed模型来自当前IAM授权Trace范围；组管理员只扩展至其授权组，不因旧部署管理员名看到其他空间。内置/自定义价格、货币、排序和界面保留；价格PUT配置控制域规则未在本批迁移。两个页面无需新登录或前端布局变更，退出/切换账号使用现有Key状态。Dashboard/Fleet/Quality等剩余统计和OTLP logs/metrics/spool仍在依赖清单内，不能把模型列表接通视为这些功能已经迁移。
