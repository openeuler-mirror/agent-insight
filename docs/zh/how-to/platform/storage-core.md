---
title: "启用隔离的 Storage Core Trace 链路"
description: "显式初始化、私有服务配置、密码登录、OTLP 接收及分页 Trace 验证。"
---

# 启用隔离的 Storage Core Trace 链路

当前新增模式只接管 Trace 采集、列表、Span 和正文。它使用独立 IAM 密码账号、事务库及 ClickHouse。未设置模式开关时保留原路径；启用后配置缺失、认证失败或后端故障会明确报错，不回落旧库。完整契约见[参考](../../reference/platform/storage-core.md)，开发/验收状态见[实施状态](../../../../design/platform/analytical-transactional-storage/implementation-status.md)。

## 1. 准备独立目标

以下路径、端口、数据库名都是示例，须替换为本次专用目标。Python 需3.11+，ClickHouse需预先运行。事务后端可选SQLite、PG、openGauss；本流程用SQLite。原Prisma业务库不能直接传给core初始化/升级命令。

```bash
mkdir -m 700 -p /absolute/path/to/isolated-core
python3 -m services.storage init-sqlite --database /absolute/path/to/isolated-core/core.db
python3 -m services.storage migration-plan --backend sqlite --database /absolute/path/to/isolated-core/core.db
```

新库应用001–004，当前schema_version=4。已有已知前缀只校验，不自动升级；已有core目标须先备份并显式执行：

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
control = SQLiteControlStore(root / 'core.db')  # 上一步已显式初始化至004
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
private_json(root / 'trace-service.json', {
    'control': {'backend': 'sqlite', 'database': str(root / 'core.db')},
    'clickhouse': {'endpoint': facts.endpoint, 'database': facts.database,
                  'user': facts.user, 'password': facts.password},
    'cursor_secret_hex': secrets.token_hex(32),
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
NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE=core \
AGENT_INSIGHT_STORAGE_CORE_URL=http://127.0.0.1:4319 \
bash scripts/develop_start.sh
```

部署时也可在该独立运行根的`.env`配置同名变量。`NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE`参与前端构建，变更后重新构建/重启；bridge URL为仅服务端使用的显式loopback origin，不含路径、查询或URL凭据。不同主机/容器必须让Next和loopback服务具备同一可达网络命名空间；不能把远端域名填入当前仅回环桥接契约。

浏览器打开`http://127.0.0.1:4320/login`，使用上一步IAM账号密码。core会话由Next设置独立HttpOnly、SameSite=Strict Cookie，名称按后端origin区分；HTTPS加Secure，登录/退出校验同源Origin。浏览器JS不保存会话token。旧用户名自动注册、旧Key和旧localStorage不能登录新IAM；清除模式开关并重建后恢复旧模式选择，不会自动搬迁两边数据。

## 4. 上报并区分接收与索引

采集端使用固定workspace的`api_`凭据，不能用Web会话替代HTTP采集凭据。按已配置的采集器安全方式加载`collector.json`，将目标指向`/api/ingest/otel/v1/traces`，携带`Authorization: Bearer …`及可选`X-Workspace-Id`、`Idempotency-Key`。不要把token粘进URL或可记录的命令参数。

入口支持OTLP JSON/protobuf及gzip，解码后的JSON最大4MiB、4096个**完成Span**，归一化展开总预算64MiB。后端loopback端口只收JSON。默认来源为`otlp`，不同service.name的同一原生Trace仍聚合；service.name仅显示。需要明确来源隔离时使用resource属性`agent_insight.source_namespace`。同源修订用Span属性`agent_insight.revision`，默认为1；同版本不同内容进入失败，不能改包内容重用receipt key。

OTLP成功响应仍为空JSON对象/空protobuf；`X-Storage-Batch-Id`与`X-Storage-State`报告回执。accepted只代表私有原始制品fsync及控制事务提交。用同一采集凭据查询`GET /v1/batches/<batch_id>?workspace_id=default`，或Next的`/api/observe/session?action=batch&batch_id=…&workspace_id=default`；write-only凭据只能查看本人回执。只有indexed代表所有sink完成；failed需检查回执错误，不按成功重传不同内容。

## 5. 按页检查 Trace

进入`/trace`，列表默认50条；Span结构默认/最多200条；正文每页默认/最多4块，每块最多256KiB。选择一个Span后才按该行payload_revision读取input/output；不会先加载整个Trace JSON或全部万级Span。不存在的section返回available=false，不当作损坏。列表筛选和游标绑定当前权限；成员撤销、组/项目停用后旧请求不得继续获得数据。

当前单队列以全局最早事件强序处理；早期重试会阻挡后续事件。每128 Span批量写正文，先chunks、后manifests，再Span及Trace摘要，重复写依赖相同版本收敛。这是可靠性基线，尚未完成1000在线采集端混合读写压测、分片日志或HA认证。当前浏览器验收状态以[实施状态](../../../../design/platform/analytical-transactional-storage/implementation-status.md)为准。

停止时对自己启动的服务使用Ctrl-C/SIGTERM，保留数据库、制品目录和私有配置；不要用全局进程清理命令影响其他worktree。
