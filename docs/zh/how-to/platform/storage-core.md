---
title: "启用隔离的 Storage Core Trace 链路"
description: "显式初始化、旧身份映射、原界面兼容与隔离 Trace 验证。"
---

# 启用隔离的 Storage Core Trace 链路

三种事务后端的独立容器、网络 SQLite 配置与源码接入示例见[分离部署操作指南](deploy-docker.md)。

项目自带的 [App 数据库连接配置](../../../../config/deployment/storage.ini) 可在两库启动后直接编辑。Docker 在 App 阶段读取它，源码安装可显式传入 `--config config/deployment/storage.ini`。原有私有 JSON 同样受支持。

## 唯一存储运行方式

应用现在固定通过 Storage Core 访问数据：SQLite、PostgreSQL、openGauss、MariaDB 选一种事务后端，ClickHouse 为必需的分析后端。当前结构基线是事务迁移 021（80 表）与 ClickHouse 004（19 表）。不设置旧模式变量也使用 Core；显式设置非 core 模式会拒绝启动。DATABASE_URL、DB_HOST 不再选择 Web 的业务存储，Web 不创建或访问旧 Session/Execution 库。

Web 启动前验证 Core 地址、私有控制器文件以及两个数据库的就绪状态。Core 启动及 /v1/health 校验事务版本和 ClickHouse 必需表/字段与读取权限。健康检查不能代替真实采集、索引和业务验收。ClickHouse 中断时不回落旧库；已接收的 Outbox 保留并重试。私有 Core 配置可设置 max_pending_ingest_batches（每 workspace，默认 256，范围 1–10000）；队列满时新采集返回 429/QUEUE_LIMIT，已接收请求的幂等重试仍返回原回执。

事务库保存权限、路由、控制状态、版本、回执与发布水位；Trace/Span/正文及各类分析事实由 ClickHouse 保存。字典规定的资产制品与可靠投递文件继续保留。旧数据库只作为显式离线迁移输入；正常启动不执行旧 Prisma db push，也不自动迁移或删除旧数据。构建期间生成 Prisma 历史 DTO 类型不连接业务数据库。

控制记录的创建和更新返回事务库提交后的值（包括 `updatedAt`），条件更新与重复回执使用同一版本。已授权记录不满足筛选条件时返回空结果；越权读取仍拒绝。静态 Skill 评估和反馈只读取控制记录，动态评估、Trace 与派生问题通过对应 Core 分析接口读取，禁止跨回旧 Execution 表。设备认证沿用请求绑定的 Core 连接，并在响应后校验连接目标未改变。

仪表盘和质量分析读取注册信息时使用同一已验证的 Core 事务上下文，报告的 Trace、轨迹评分和诊断数据只来自 Core 分析快照；缺少快照明确失败，不读取旧表。请求回调直接返回延迟查询时，身份范围持续到查询完成。Agent 删除成功后沿用原用量事件，拒绝或失败不计数。

部署专项已在三种事务库分别搭配 ClickHouse 的环境验证。原页面布局、Trace 服务端分页、Span 每批最多 50 条滚动追加及“加载中…”提示保持。


下文保留各迁移阶段的领域协议和历史验收说明。历史章节中的版本号表示该功能引入时的版本；当前部署统一要求事务 021、ClickHouse 004，不可按较早章节重新启用旧库或可选存储开关。全量业务回归仍在进行，专项通过不等于完成整项目验收。

## 配置数据库并一键安装

源码部署时，数据库由用户预先部署并维护。源码安装器只管理 Storage Core 与 Web，不下载、不安装、不启停 PostgreSQL/openGauss/MariaDB/ClickHouse。选择 SQLite 网络服务时填写 endpoint、token 和制品目录；已有文件模式填写 database 路径。运行架构始终为一种事务库＋ClickHouse，禁止回退旧单库。

准备 Node.js 22+、npm、Python（SQLite 使用 3.11+；固定关系库驱动使用 3.11–3.13）。先准备一种事务库和 ClickHouse 的独立数据库及凭据，然后在项目根目录选择样例：

```bash
cp config/storage.postgresql.example.json config/storage.local.json
# 文件 SQLite 使用 config/storage.sqlite.example.json
# 网络 SQLite 或 openGauss 使用 deploy/docker/ 下对应 JSON，改为宿主机可达的地址和路径
# MariaDB 使用 config/storage.mariadb.example.json
chmod 600 config/storage.local.json
# 编辑 storage.local.json，替换全部 YOUR_* 占位符
bash scripts/install.sh --check
bash scripts/install.sh
```

样例为合法 JSON，不支持注释。实际配置不会提交到 Git 或打进 npm、Docker、Next.js standalone。缺项、未知字段、占位符和非私有文件会在连接前拒绝。`--check` 只读，不建库、不建表、不创建运行目录；已有 Python 环境须包含相应驱动。首次安装自动准备固定 Python 依赖，校验连接与权限，初始化应用表，再启动 Core、构建并启动生产 Web。`--storage-only` 可只初始化存储；`--config /absolute/path/storage.local.json` 用于独立实例。`deploy_server.sh --apply` 是安装入口的兼容别名。

| 字段 | 填写方法 |
|---|---|
| `control.backend` | 必填：`sqlite`、`postgresql`、`opengauss` 或 `mariadb` |
| `control.database` | SQLite 文件模式必填；文件绝对路径或 `~/` 路径，相对路径以项目根目录解析；不得填写历史单库文件。制品位于文件旁的 `.artifacts` 目录 |
| `control.dsn` | 关系库必填。PG/openGauss 使用 `postgresql://用户名:密码@主机:端口/数据库`，MariaDB 使用 `mariadb://用户名:密码@主机:3306/数据库`。密码中的 `@:/#` 等须 URL 编码；示例 `p@ss` 写为 `p%40ss` |
| `control.schema` | PG/openGauss 必填，独立应用 schema，如 `agent_insight`；不能使用 public 或系统 schema |
| `control.endpoint/token` | 网络 SQLite 的 HTTP(S) 地址与服务令牌；与文件路径互斥 |
| `control.artifacts` | 网络 SQLite、PG、openGauss、MariaDB 必填，Core 账号可写的持久制品目录 |
| `clickhouse.endpoint` | 必填，HTTP(S) origin；通常 HTTP 8123、HTTPS 8443；不能填原生 TCP 9000，也不能在 URL 中放密码 |
| `clickhouse.database` | 必填，管理员预建的独立数据库，不能使用 system/default |
| `clickhouse.user/password` | 均须显式填写；只有数据库确实采用空密码时才填写空字符串，不能省略 password |
| `clickhouse.timeout` | 可选，默认 15 秒，范围 1–60 |
| `runtime.home` | 可选，默认 `~/.agent-insight`；仅存运行配置、内部密钥、日志和进程记录，不是用户维护的数据库配置源 |
| `runtime.corePort/webPort` | 可选，默认 4319/3000，不可相同；Web 可用 `--port` 或 `AGENT_INSIGHT_PORT` 临时覆盖 |

本机原生 Core 连接映射到本机的容器数据库时用 `127.0.0.1:映射端口`；远程服务填服务器域名。容器中的 localhost 指容器自身，必须填容器可达的服务名或主机地址。

PG 样例默认 TLS `sslmode=verify-full`，将 `sslrootcert` 换成 CA 绝对路径。仅在隔离本机测试明确改为 `sslmode=disable`。ClickHouse HTTPS 使用系统信任链，私有 CA 可通过 Python 的 `SSL_CERT_FILE` 指定；不关闭证书验证。PG `connect_timeout` 默认 10 秒，允许 1–60。诊断不会输出密码或完整 DSN。

初始化账号需要 PG 数据库 CONNECT、创建应用 schema 的 CREATE 权限（或预建 schema 的 USAGE/CREATE），以及应用表读写权限；ClickHouse 需要目标库 CREATE TABLE、SELECT、INSERT，运行时至少 SELECT/INSERT。初始化完成后可收回 DDL 权限，变更账号后重启应用。当前版本门槛为 PostgreSQL 16、ClickHouse 26.8，安装仍会验证实际表结构；高版本并不等于所有功能已验收。openGauss 部署专项使用 7.0.0-RC3 ARM64 镜像。

## 使用外部 MariaDB

由数据库管理员准备 MariaDB 11.4 或更高版本的独立事务库。示例库名为 `agent_insight`。Core 直接使用 DSN 路径中的库名。新库默认使用 `utf8mb4` 和 `utf8mb4_unicode_ci`。

```sql
CREATE DATABASE IF NOT EXISTS `agent_insight`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

管理员单独创建和授权业务账号。Core 运行账号需要目标库的 `SELECT, INSERT, UPDATE, DELETE`。首次建表和升级由迁移账号执行，还需目标库的 `CREATE, ALTER, INDEX, TRIGGER, REFERENCES`。触发器定义者需要保留执行触发器所需的权限。应用与迁移均使用预建数据库。

启用 binlog 时，迁移和运行连接使用 DBA 批准的 `ROW` 或 `MIXED` 格式。预检会拒绝与 `READ COMMITTED` 不兼容的 `STATEMENT`。当 `log_bin_trust_function_creators=OFF` 时，由具备 `SUPER` 的 DBA 账号执行包含触发器的首装或升级。业务账号仍只需上述读写权限。安装器在写入迁移标记前检查这些条件，保留实例的 binlog 和 SQL 模式设置。

1. 复制 `config/storage.mariadb.example.json`，填写 MariaDB DSN、ClickHouse 和持久制品目录。配置文件权限设为 `0600`。生产 DSN 使用 `sslmode=verify-full`，私有 CA 用 `sslrootcert` 指定。
2. 使用迁移账号执行 `bash scripts/install.sh --check` 和 `bash scripts/install.sh --storage-only`。之后用业务账号配置启动 Core 和 Web。在 OpenShift 中，把 DSN 放入 Core 侧的私有配置，按独立作业执行初始化。Web 通过 `AGENT_INSIGHT_STORAGE_CORE_URL` 访问 Core。
3. 验收时分别用迁移连接和业务连接执行 `SELECT @@GLOBAL.sql_mode, @@SESSION.sql_mode`。按集合核对以下模式，并执行登录、写入和查询 Trace。

```text
PIPES_AS_CONCAT,ANSI_QUOTES,IGNORE_SPACE,ORACLE,NO_KEY_OPTIONS,NO_TABLE_OPTIONS,NO_FIELD_OPTIONS,STRICT_TRANS_TABLES,NO_AUTO_CREATE_USER,SIMULTANEOUS_ASSIGNMENT
```

版本升级先停止写入，在维护窗口完成备份并演练恢复。用 `migration-plan` 查看待执行版本，用 `source-evidence` 记录源库，再通过 `migrate-relational` 提交备份清单。详见[迁移命令与恢复要求](../../reference/platform/storage-core.md#显式初始化与版本迁移)。

## 没有数据库服务时：独立 Docker 启动

准备 Node.js、Docker 和 Compose，先启动 Docker daemon。在项目根目录顺序执行：

```bash
bash scripts/start_postgresql.sh
bash scripts/start_clickhouse.sh
bash scripts/install.sh
```

两个数据库脚本独立于应用安装：默认 PostgreSQL 16 映射 `127.0.0.1:15432`，ClickHouse 26.8 映射 `127.0.0.1:18123`。Docker 根据目标架构选择镜像。第一次执行任一脚本时，若项目配置不存在，则生成包含随机密码的 `config/storage.local.json`（0600）；不打印密码，不覆盖已有配置。默认应用运行目录为 `~/.agent-insight-postgresql`，Core/Web 端口为 4319/3000。数据库使用独立命名卷，重复执行复用数据。配置缺失但数据卷仍存在时，必须恢复原配置，不能重新生成密码。

已有配置只允许显式本机回环连接；PostgreSQL 使用 `sslmode=disable`，数据库端口仅绑定回环。已有远程数据库不应运行这两个脚本，直接填写配置并安装应用。配置变更不会自动修改数据卷里的账号或密码；需要先由管理员完成迁移。

停止应用仍用 `bash scripts/stop.sh`。数据库需要独立停止：

```bash
bash scripts/start_postgresql.sh --stop
bash scripts/start_clickhouse.sh --stop
```

停止保留数据卷。三个入口均支持 `--config /absolute/path/storage.local.json`，自定义时须始终使用同一文件。不要使用 `docker compose down -v` 清理业务数据。这里的应用仍原生运行，只有数据库在容器内；下方旧全容器流程是 SQLite＋ClickHouse 联调入口，不是 PostgreSQL 的一键部署入口。

## 本机一键启动

```bash
bash scripts/start.sh                # Core + 生产 Web
bash scripts/develop_start.sh        # Core + 开发 Web
bash scripts/status.sh
bash scripts/stop.sh                 # 仅 Core/Web，数据库保持运行
```

二者共用项目配置，不同时运行两套 Web。重复安装复用已初始化结构和内部密钥；初始化意图记录支持失败后继续，但不会自动重置任何数据库。配置变化时先停止应用再启动。已有管理模式的 ClickHouse 程序、数据、配置和运行进程均保留，后续须由用户独立管理。

旧业务库、结构版本落后、未知表、不兼容字段、两侧数据状态不匹配均拦截。不要删除旧库来绕过拦截。先备份并按[升级与回滚](upgrade-and-rollback.md)迁移；安装器不承担历史数据转换。事务表与分析表沿用 Core 的版本化迁移 SQL（当前 020/004），不执行 Prisma db push。

## Docker 隔离联调

仓库根目录的 `docker-compose.storage-core.yml` 将原 Next.js 页面、Python Storage Core 和 ClickHouse 放在独立的 Compose 项目中。三个数据卷分别保存 Web 制品、新事务库及 ClickHouse 数据；Web 默认只发布到本机 `127.0.0.1:3000`（可用 AGENT_INSIGHT_PORT 覆盖），Storage Core 只监听共享网络命名空间内的 `127.0.0.1:4319`。本流程用于新数据链路验证，不导入默认业务库或执行生产切换。

在 Docker daemon 已启动的环境中，从仓库根目录运行：

```bash
export CLICKHOUSE_PASSWORD='为本次隔离环境设置的强密码'
docker compose -f docker-compose.storage-core.yml up -d --build
docker compose -f docker-compose.storage-core.yml ps
docker compose -f docker-compose.storage-core.yml logs --tail=100 storage-core
```

首次启动会在新卷中显式初始化 SQLite 001–021 与 ClickHouse 001–004，并生成私有 controller key 和服务配置。再次启动只校验已有版本、表集合和配置；需要升级或更换密码时，先备份并按显式迁移流程处理，不会重建已有库。使用原 `/login` 创建隔离用户后，通过 `/api/ingest/otel/v1/traces` 上报测试 Trace，并检查原 `/trace` 页面或 `/api/observe/data` 及 ClickHouse 对应事实。旧采集兼容接口返回接收结果，batch 回执仅适用于直接调用 Storage Core `/v1/ingest/otlp` 的流程。保留同一个 `CLICKHOUSE_PASSWORD` 才能重启已有卷。停止服务使用 `docker compose -f docker-compose.storage-core.yml down`；不要加 `-v`，以保留验收数据。

此 Compose 路径选择 SQLite 作为事务后端，仅证明该组合的隔离链路；PostgreSQL/openGauss、真实旧库迁移、生产容量与高可用仍需另行验证。容器内运行时初始化与原源码操作指南如下。

**产品兼容状态（2026-11-15）**：原登录、导航和前端页面保持重构前版本；本批通过服务端兼容旧Trace接口接入新存储。诊断会话、自身Trace及Trace报告按参考中的独立协议接管；Dataset版本/Trace回流/批量生成已按本页流程接管；实验/评测结果与DiagnosisRun逐项接管，当前覆盖及剩余Workbench/Benchmark等消费者以实施状态为准。仅在隔离目标验证，不用于生产切换。

正常业务请求仅访问 Core。配置缺失、权限不足和后端故障明确失败，不使用旧业务库或 JSON 文件兜底。

## 生成超大模拟 Trace

在已启动的本机 standalone 登录环境中运行以下脚本。它通过 Web 登录取得指定用户身份，再直接调用 Storage Core 的 OTLP 接口，每批等待 ClickHouse 回执为 `indexed`。此路径用于准备数据库测试数据，不覆盖 Web 采集兼容层的吞吐性能。

```bash
python3 scripts/simulate-large-trace.py \
  --username 'your-test-user@example.com' \
  --web-url http://127.0.0.1:3000 \
  --core-url http://127.0.0.1:4319 \
  --state-file /absolute/path/to/private/large-trace.json
```

默认创建一条 21,001 Span 的 Trace：1 个根节点、21,000 个 LLM 子节点，每条输出 1,024 个 ASCII 字符。输出及 Token 计数均为模拟值，不会调用真实模型。可用 `--spans`、`--batch-size`（默认 500）和 `--output-chars` 调整规模；每请求仍受 4 MiB / 4096 Span 限制。输出高度可压缩，不能据此推算真实模型数据的压缩率。

后台错误聚类跳过逐个 LLM 节点的完整历史输入拼接，避免大 Trace 的历史文本被平方级重复复制；错误输出与分类保持，详情调用仍保留默认历史内容。

状态文件保存 Trace ID、固定时间、逐批耗时和进度，不保存凭据。中断后用相同参数及状态文件重跑可续传，已完成批次不会重新创建；换一个状态文件才会生成新 Trace。结束时校验 Span 数与 owner，并打印原 `/trace?taskId=...` 页面链接。批次耗时包括 HTTP、事务提交、索引与轮询，不能当作纯 ClickHouse 查询延迟。测试数据保留供页面及数据库性能检查。 21,001 Span / 每条 1 KiB 输出的本机实测已通过核心索引与正文读回，但旧 `/api/observe/data` 对该 Trace 返回 413；页面入口 200 不代表列表和详情已支持此规模。

## 1. 准备独立目标

以下路径、端口、数据库名都是示例，须替换为本次专用目标。Python 需3.11+，ClickHouse需预先运行。事务后端可选SQLite、PG、openGauss；本流程用SQLite。原Prisma业务库不能直接传给core初始化/升级命令。

```bash
mkdir -m 700 -p /absolute/path/to/isolated-core
python3 -m services.storage init-sqlite --database /absolute/path/to/isolated-core/core.db
python3 -m services.storage migration-plan --backend sqlite --database /absolute/path/to/isolated-core/core.db
```

新库应用001–021，当前schema_version=21。已有已知前缀只校验，不自动升级；已有core目标须先备份并显式执行：

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
control = SQLiteControlStore(root / 'core.db')  # 上一步已显式初始化至021
facts = ClickHouseStore('http://127.0.0.1:8123',
    database='agent_insight_core_isolated', user='default',
    password=getpass.getpass('ClickHouse password (empty if configured): '))
facts.initialize_new_database()
facts.initialize_analytics_schema()
facts.initialize_infra_schema()
facts.initialize_semantic_usage_schema()
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

服务只绑定127.0.0.1。`GET http://127.0.0.1:4319/v1/health`报告schema_version、worker_enabled和有限错误类型，不提供凭据或正文；ready表示事务schema及ClickHouse必需结构/读取权限检查通过，仍需实际上报验证写入与索引。worker_enabled=false可用于暂停物化的隔离恢复测试，不会把accepted当indexed。

为 Next 设置独立 AGENT_INSIGHT_HOME 保存配置和制品，不需要 Prisma 壳库。通过项目 develop_start.sh 启动开发服务；已有业务数据请按离线迁移流程处理。

```bash
AGENT_INSIGHT_HOME=/absolute/path/to/isolated-web \
AGENT_INSIGHT_PORT=4320 \
AGENT_INSIGHT_BIND_HOST=127.0.0.1 \
AGENT_INSIGHT_STORAGE_CORE_URL=http://127.0.0.1:4319 \
AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE=/absolute/path/to/isolated-core/identity-mapping.json \
AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=/absolute/path/to/isolated-core/controller-key \
bash scripts/develop_start.sh
```

`AGENT_INSIGHT_BIND_HOST=127.0.0.1`让本机开发服务只接受本机连接；不设置时启动脚本沿用原来的全网卡监听。其余变量均为服务端配置，变更后重启Next；旧`NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE`仅作为服务端兼容别名，不再控制前端。loopback origin不能包含路径、查询或凭据。Next和存储进程需共享可达网络命名空间。

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

进入原`/trace`，列表、筛选、打标及详情继续使用旧DTO。原列表按页请求 Trace；打开详情先请求最多 50 条轻量 Span，在原列表滚动接近底部时再请求下一批，直到加载完。已加载结构追加展示，正文仍按点击加载；加载提示仅显示“加载中…”。普通OTLP结构不读正文，点击后才按固定interaction索引及payload_revision装载单Span正文，正文section每页最多4块。

原Trace bundle导入/导出保持v1格式及执行树/旧ID，导入最多50MiB/500个execution。全树先校验，冲突ID及嵌套引用一并重映射；成功仅在全部batch indexed后返回。`Idempotency-Key`可用于同一次导入恢复，不能复用给不同内容。导出及完整会话响应上限128MiB。原Langfuse页面直接消费完整nodes，因此兼容读取需要其完整正文；该特例不能计入普通OTLP的懒加载证明。未覆盖的业务能力及失败边界见实施状态。

观测批次按 workspace/Trace 保序；退避中的批次不阻塞独立 Trace，最多执行 5 次。前序最终失败时，同 Trace 后继标记 DEPENDENCY_FAILED，需在前序恢复成功后逐批恢复。Dataset/评测等领域仍使用各自类型的投递领取。每128 Span批量写正文，先chunks、后manifests，再Span及Trace摘要，重复写依赖相同版本收敛。这是可靠性基线，尚未完成1000在线采集端混合读写压测、分片日志或HA认证。当前浏览器验收状态以[实施状态](../../../../design/platform/analytical-transactional-storage/implementation-status.md)为准。

停止时对自己启动的服务使用Ctrl-C/SIGTERM，保留数据库、制品目录和私有配置；不要用全局进程清理命令影响其他worktree。

## 全量测试的隔离前提

存储专项与应用`npm run test`是不同门槛。应用全量须在专用HOME、AGENT_INSIGHT_HOME与SQLite目标运行，清除继承的 DB_* 和日常 Core 地址及凭据，使用测试自己的隔离 Core 配置；不得指向日常业务库。测试中新增/修复的数据库用例复用`createIsolatedDatabase`，仅历史样本建立临时 schema，并通过 test/helpers/historical-prisma.ts 访问；运行代码仍使用 Core，结束断开连接并恢复环境；隔离helper也清除继承的关系库配置，并固定空DB_HOST防止dotenv重新选择远端。

完整环境包括可用的Node LTS、Python的PyYAML/pydantic2、PowerShell7，以及Trae采集器编译产物。先用已安装、验证过的运行时，在该次测试进程设置PATH、PYTHON、AGENT_INSIGHT_FI_PYTHON、AGENT_INSIGHT_RAS_PYTHON；不要通过全局改配置或安装未获授权的依赖消除错误。PowerShell解析也使用临时HOME，避免宿主缓存/配置影响。Trae编译可使用仓库已有esbuild执行原compile参数，构建JS不代表完成VSIX打包或IDE验收。

准备旧Prisma路径的全量用例时，只对新建的隔离SQLite文件执行`prisma db push --skip-generate`；不能将此命令用于core.db。HTTP测试在失败路径也必须关闭连接，不能让清理SQL错误阻止server.close。缺依赖、缺schema和固定sleep抖动分别报告，不通过跳过或延长无限等待冒充业务验证通过。完整测试计数与平台跳过范围以实施状态为准。


## 验证诊断链路

先在隔离目标备份并显式升级至015；不要把演示配置指向旧Prisma数据库或默认业务库。已有原登录Key的私有映射凭据需要read/write用于追问、execute用于报告、delete用于原有删除操作，仍受Trace owner/组角色约束。仅write采集Key不能作为页面账号。

1. 用原账号登录，打开一条已授权Trace，再进入原故障诊断页。GET历史即使为空也应有已授权Trace，存储异常不能显示成“没有会话”。
2. 发起追问，观察原ready/text/tool/reasoning/done事件；在Trace列表查到`fault-diagnosis-agent`自身运行，按原上游session ID打开，核对工具输入/输出与失败状态。
3. 刷新页面、重启隔离存储服务后确认完整消息仍在。继续对话保持同一上游；显式新对话保留历史。成员无法读取他人私人Trace，组管理员可读组内历史，但跨actor续用已有上游当前返回409，需新建自己的对话。
4. 通过原AgentDebug/SkillsAnalysis入口运行报告并重新载入。强制重跑或删除期间，旧后台任务不得覆盖当前结果；停用账号或删除Trace后，不再返回正文。

验收必须注明是否调用真实模型。隔离fixture Agent可以验证真实SQLite/PG/openGauss事务、ClickHouse、HTTP/SSE及页面历史恢复，但不代表真实LLM诊断质量；最新实际覆盖见实施状态。旧诊断会话/报告不会自动导入，原数据与备份保留。

按原流程登录即可；诊断请求沿用同一个Key，退出和账号切换行为保持原样。


## 验证数据集链路（008/009）

新目标初始化到015；已有隔离core目标先停写，使用新的备份路径和CLI显式迁移至15，同时保留制品目录。迁移工具核对旧表内容，不能以Prisma db push替代，也不能直接指向原业务SQLite。

在原登录和侧栏进入「评测数据集」：新建→单个添加→编辑样例→新增字段，刷新后检查原值。另从Trace回流样例并重复追加，确认去重；使用两个草稿制造陈旧提交，确认409且先前修改保留。页面没有新增版本控件，版本摘要通过参考页所列查询接口读取。

先通过原OTLP入口上报，再在「基于Trace生成」选择有授权数据的Agent和时间窗，检查进度、发布样例、取消及删除回执。重启隔离Next/存储服务后，重新以原actor查看进度；活动旧租约须先到期，随后新epoch恢复。发布完成任务的取消返回冲突，删除仍需独立权限。未改实验/Benchmark消费者不应被视为本页验收的一部分。


## 实验链路隔离验证（010–014）

先停止目标写入，保留事务库备份与完整制品目录，显式迁移至015再启动；服务拒绝带pending migration启动。不要修改历史SQL绕过checksum。013→014只追加表，012→013修正空证据约束时保留全部历史行、索引及不可变触发器。

私有身份映射之外配置`AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE`，由可信配置过程生成随机64位hex并以0600保存；Next与helper使用同一文件，不能复用登录Key。原页面无需新增配置或交互。按创建实验→运行→结果详情→人工0分→评论→重评验证，分别核验OLTP回执、CH published与旧表无影子写入。再验证来源撤权、旧fence晚回、取消清理未确认和精确网络重试。Workbench/Benchmark使用同一原入口，具体可验收分支见实施状态。


## 旧数据迁移前的只读计划

先对已保留的一致性隔离副本执行`plan-legacy --database /absolute/path/to/isolated-legacy.db --source-id stable-source`；显式owner映射、预算、状态与隐私契约见[存储参考](../../reference/platform/storage-core.md#只读语义计划不执行导入)。报告可安全诊断但不替代原始备份/导出；活动WAL不能只复制主文件。当前只支持SQLite源，不支持导出目录输入，所有计划仍blocked且不执行导入。现阶段不在生产停写、迁移、修改凭据或切换连接串。

## 优化点回调与价格模型列表

core模式下，原优化点GET和完成优化后的resolve PATCH携带当前登录Key。新派生问题通过typed解决注解处理，旧static/feedback问题仍在原控制域；混合请求预检后分别提交，两域失败可重试但不是跨库原子事务。未提供threadId时，公开关联仍为null，机器评测内容不变。相同显式操作键恢复core回执；普通新请求按新增解决计数，混合响应是core该操作计数加本次旧静态新写计数，不保证整次HTTP数字精确重放。

价格GET的observed模型来自当前IAM授权Trace范围；组管理员只扩展至其授权组，不因旧部署管理员名看到其他空间。内置/自定义价格、货币、排序和界面保留；价格PUT配置控制域规则未在本批迁移。两个页面无需新登录或前端布局变更，退出/切换账号使用现有Key状态。Dashboard/Fleet/Task/Quality统计使用015/CH002统一授权摘要；其就绪、预算及容量限制见参考。OTLP logs/metrics/spool、Skill/Agent剩余动态消费者及旧库全量apply仍在依赖清单内，不能把本批统计接通视为全量切换。


## 统计消费者的隔离验收（015 / CH002）

已有 core 目标先停写、备份事务库及制品目录，显式迁移015；CH使用同一隔离数据库显式执行 `initialize_analytics_schema()`，历史001不改写。配置真实账号和私有控制器后，启动原 `bash scripts/develop_start.sh`。后台按已验证账号预热统计；首次打开仍未就绪时，原apiFetch会仅对明确的索引中标记自动重试，超过预算则返回实际错误，不能把503当作空库。

按原页面检查 Dashboard、Fleet 趋势/排行/Agent/可靠性、Quality Agent列表/执行记录/报告以及Task统计。用另一普通账号与伪造user参数验证隔离，组管理员范围由真实IAM决定；检查原生Agent无注册行时的平台筛选、当前0分评测、未解决Issue与当前诊断、真实RAS anomaly/action_result。新RAS采集POST要求write API Key，可以write-only；读统计要求read。

只在专用数据库验证，不指向默认业务库或生产库。第一版按原功能的HTTP、界面与全套测试验收；万级 Span 已采用 50 条滚动分页；增量水位及千级并发容量尚未完成验证。旧库96模型计划仍不apply。


Skill与Agent动态查询验收：沿用原`/skills`和`/agents`页面，确认列表统计、版本趋势和完整执行输出，包含空结果、0值和无Session历史执行。原静态配置与注册记录继续保留；仅调用统计来自授权新存储。旧登录名映射到不同IAM规范用户名时，也应只发现本人的Agent。此片不迁移Skill runs/logs、Agent删除或资产配置写操作，此阶段的历史验收不代表当前全领域回归通过；当前运行时已禁止旧控制数据库访问。


## 019 控制数据接入后的验收边界

隔离目标显式升级到019后，使用原登录和原页面。浏览器继续使用当前已有API key；请求封装为原控制API补实际凭据，不能仅靠body/query user访问。SDK、采集和设备继续使用各自已有凭据；新存储配置缺失或授权失败明确返回错误，不读取旧事务库兜底。原standalone登录、组织登录、IDaaS及设置掩码恢复规则分别保留，不增加登录UI。

原Skill版本/文件、配置、客户端、Workbench/优化/生成会话及调试结果走新控制仓储。需要沿原流程集中验收列表→详情→文件→保存、安装→心跳→命令ACK→配置/部署回执、会话SSE→候选/复测/发布，以及Agent删除与Trace/诊断来源生命周期。4个TSX只接请求传输导入及runtime动态header；页面布局、文案、交互和原功能不改。本批快速专项/类型结果不等于这些完整验收已完成。

保留旧库及文件，历史数据由显式迁移器按owner导入。HISTORY_FENCE_VERSION=1允许保留running/pending等原状态的惰性历史记录；活动任务、未消费安装token和旧设备凭据不会恢复执行权或鉴权能力。未知owner、缺附件和来源/目标冲突仍须报告并阻断，不能用删除状态或伪造终态掩盖。暂不切生产。


### 原生用户不需要额外后台映射

在原界面创建原生User并配置个人模型后，后台从新库持久User及其真实当前API凭据恢复，服务重启不要求手写identity文件。旧wi凭据迁移仍使用原私有映射文件；错误/歧义映射不会被猜测或静默替换。保持core controller私有文件配置正确，不能把key发到浏览器来代替该机制。

上报端只需原write权限；后台自动分析另验同owner当前execute。只读、撤销/过期凭据或仅可查看别人Trace的管理员不能借恢复使用别人的模型。当前原界面不变，完整自动分析与重启验收使用隔离目标，不切生产。


## 020 隔离验收与显式旧库导入

当前隔离目标使用事务schema021和CH004。新库初始化与既有目标备份升级必须分别使用对应CLI；不要对原业务库执行Prisma db push。继续使用原登录和页面，原default项目归属不增加前端项目选择流程。

先对一致的旧SQLite副本执行export-legacy，再使用独立的plan-legacy-import、apply-legacy-import及verify-legacy-import。每步明确指定导出目录、稳定source ID、owner绑定及隔离目标配置；apply/verify另外提供当前actor凭据和migration ID。原plan-legacy仍是严格只读清点工具，它自身没有apply，不与新语义导入命令混用。

先解决计划中的owner、附件及来源/目标冲突；按原receipt重复apply恢复pending，等待实际CH indexed后再verify。不要把第一轮“接收成功但pending”当作迁移完成。完成后再次apply应只重放、无新增，核对源字节/内容未变、原历史状态可读且未产生执行命令。47条样本演练只覆盖对应样本，不替代客户真实全库计划；不切生产。

### 超大 Trace 按需读取

`/trace` 使用原表格、统计卡片、筛选项和页码控件。默认时间排序的普通列表在 ClickHouse 执行 LIMIT/OFFSET，仅对当前页补充元数据；复杂筛选仍使用既有兼容查询，返回当前页，统计独立加载。

Core 详情打开时返回最多 50 个 Span 结构，向下滚动到已加载内容末尾时，继续每批追加最多 50 条。内容不足以滚动时，可点击「继续加载更多调用」。原 Span 树、工具栏和正文面板保持。请求期间仅显示“加载中…”，结束后隐藏；不显示已加载数量/总数。节点统计仍基于已加载部分。Span 以时间和稳定 ID 排序，游标绑定权限、Trace 与修订；修订变化返回 409，需要刷新。点击节点按 Span ID 读取正文。较小的旧格式 Trace 保留原兼容转换，在服务端还原后按批返回。

此前按 500 条分批时，已校验 21,001 Span 共 43 批无重复、无遗漏，并在 Chrome 原树中验证追加到 1,500 条。全局搜索、全量分析及复杂来源的超大 Trace 尚需进一步验收，不能将本次结果视为这些路径均通过。

## Trace 列表连接与查询复用

PostgreSQL Storage Core 默认使用进程级公共连接池。登录后的请求借用连接，事务结束后归还；退出浏览器不关闭公共连接，也不自动撤销供其他客户端使用的 API Key。读事务仍为 `REPEATABLE READ READ ONLY`，异常连接淘汰后按需补建。SQLite、openGauss 和 ClickHouse HTTP 传输保持原连接模式。

普通 Trace 列表在数据库分页后批量补充当前页信息；普通统计和框架、来源、Agent 选项在数据库聚合。评估结果覆盖、历史来源、高级筛选及无法等价表达的字段会明确退回兼容路径，可能仍需遍历记录。根 Span 属性只在摘要需要执行元数据时读取，不加载全部子 Span。详情首次及后续每批最多 50 个结构 Span。

可在现有 Core 配置中分别设置 `control.connection_pool.enabled=false` 或 `trace_list_optimization.enabled=false`，重启服务后关闭连接池或查询优化；无需重导数据。不要通过增加超时掩盖数据库不可用。默认池上限为每个 runtime 16 条，空闲保留基线为 2；多个实例的总连接预算需共同考虑。


<a id="recover-ingest"></a>
## 失败采集批次恢复

先解决 ClickHouse、制品或其他失败根因，再查询批次状态。自动执行最多 5 次；普通重复上报不会重新开启失败任务。本机运维命令读取现有私有 Core 配置和当前有效的写凭据文件（0600、非符号链接），不接受命令行明文凭据：

```bash
python3 -m services.storage recover-ingest \
  --config /private/core.json \
  --credential-file /private/ingest-token.txt \
  --workspace example-workspace \
  --batch example-batch \
  --request-key example-recovery-1
```

操作者须有该空间及所有相关 Trace 的当前写权限。成功会登记恢复历史、开启新一轮最多 5 次执行并复用原始包/冻结计划，不修改旧版本。相同恢复键幂等返回，活动批次不能被其他键重置。服务继续运行时也通过现有事务锁协调，旧 worker 的执行令牌无法提交新轮次。

`DEPENDENCY_FAILED` 后继须等前序变为 indexed 后逐批恢复；已删除或正在删除的 Trace、已有后来准备版本的历史批次拒绝恢复，避免恢复覆盖较新内容。永久非法输入原样恢复仍会失败，此命令不编辑数据或跳过校验。恢复计入现有待采集队列容量。恢复前检查源数据仍在；查询批次回执确认最终结果，不以命令成功作为已索引证明。

本功能要求事务迁移 021（SQLite / PostgreSQL / openGauss），ClickHouse 仍为 004。升级前停写、备份事务库及制品目录，按上文显式迁移；旧程序不识别 021。回退应停止服务并恢复配套备份，同时处理升级后新增数据，不能只把程序切回旧版或清零尝试次数。容量配置与状态字段见[参考](../../reference/platform/storage-core.md#core-请求容量与采集重试021)。
