---
title: "用 Docker 部署服务端"
description: "一键部署、按文件分步启动 ClickHouse 与事务库、配置和启动项目、复用已有数据库。"
keywords: ["Agent Insight", "Docker", "服务部署", "容器配置"]
changefreq: "monthly"
---

从这里选择操作步骤：[脚本分两步启动](#split) · [用分步脚本逐个启动服务](#manual-compose) · [已有两库，只安装项目](#existing-databases)。

## 三容器部署

在仓库根目录执行。部署机需要 Python 3、Docker Engine 和 Compose v2（支持 `up --wait`）。首次从源码构建项目镜像，需能下载基础镜像及构建依赖。默认启动 PostgreSQL 16、ClickHouse 26.8 和项目三个容器，项目内运行 Web 和 Storage Core。数据库各自独占命名卷，Core 通过网络端口访问它们。

```bash
bash scripts/deploy-docker.sh up
# 新实例选择其他事务库时，任选其一
bash scripts/deploy-docker.sh up --transaction opengauss --instance-dir ~/insight-og
bash scripts/deploy-docker.sh up --transaction sqlite --instance-dir ~/insight-sqlite
```

默认 Web 地址为 `http://127.0.0.1:3000`。默认实例目录为 `~/.agent-insight-docker`，保存私有实例凭据；App 从项目的 [storage.ini](../../../../config/deployment/storage.ini) 读取连接配置。重复启动使用同一目录，升级本地构建的镜像使用 `up --build`。同机部署多个实例时，首次启动前通过 `WEB_HOST_PORT`、`CH_HOST_PORT` 和所选库的 `PG_HOST_PORT`、`OG_HOST_PORT` 或 `SQLITE_HOST_PORT` 指定空闲端口。端口和镜像选择随实例记录保存。跨主机连接时，可在首次启动前将 `DB_BIND_ADDRESS` 设为数据库主机的内网地址，项目配置填写该地址和发布端口。Web 默认只允许本机访问，通过 `WEB_BIND_ADDRESS` 可绑定到指定网卡。

<a id="manual-compose"></a>

## 分步安装：一次启动一个服务

在项目父目录执行 `cd agent-insight`。如果终端已经在仓库根目录，直接从第 1 步开始。需要 Docker Engine、支持 `up --wait` 的 Compose v2 和 Python 3。

分步脚本使用单独的实例，默认 Web 端口为 **13000**，可与默认端口 3000 的一键实例同时运行。常用参数集中在 [deploy-step.sh](../../../../scripts/deploy-step.sh) 开头。默认事务库是 PostgreSQL；如需 openGauss 或 SQLite，在**首次运行前**将脚本中 `transaction` 的默认值改为 `opengauss` 或 `sqlite`。端口已被占用时也在这里调整。脚本会保存首次使用的端口和凭据，重新打开终端也可以接着执行下一步。

| 步骤 | 在项目根目录执行 | 完成后 |
|---|---|---|
| 1. 启动 ClickHouse | `bash scripts/deploy-step.sh clickhouse` | 数据库健康检查通过，保存实例凭据；此步骤不读取 App 配置 |
| 2. 启动事务库 | `bash scripts/deploy-step.sh transaction` | 所选事务库健康检查通过，此时两个数据库可用 |
| 可选：调整 App 连接 | `vi config/deployment/storage.ini` | 直接编辑文件，按每项下面的中文注释填写；默认部署可跳过 |
| 3. 启动项目 | `bash scripts/deploy-step.sh app` | Web 读取当前 INI，连接两库，输出访问地址 |
| 4. 查看结果 | `bash scripts/deploy-step.sh status` | 三个容器均显示 `healthy`，可访问 [登录页](http://127.0.0.1:13000/login) |

[storage.ini](../../../../config/deployment/storage.ini) 随项目提供。默认的 `@instance` 表示使用本实例选定的事务库和已保存的凭据。以 PostgreSQL 为例，App 用 `postgres:5432` 和 `http://clickhouse:8123` 访问两库。若在两库启动后修改 INI，再执行 `bash scripts/deploy-step.sh app` 即可重新加载。配置生效值有变化时会重新创建项目容器，请为正在服务的实例安排重启时间。修改 App 的密码字段只影响登录所使用的凭据。填写实际密码后的文件只保留在部署机，备份时与私有实例记录和卷一并保存。

只停止这套分步实例，执行：

```bash
bash scripts/deploy-step.sh stop
```

再次使用时，按顺序重复前 3 条命令即可复用数据。如果此前用手工 Compose 命令建立了实例，继续用原项目名管理原数据卷；本脚本创建独立实例。四份独立数据库 Compose 文件和连接模板均可在[部署目录](../../../../deploy/docker/)查看。

<a id="split"></a>

## 复用原来的一键实例

若要对原先用 `deploy-docker.sh up` 创建的实例分阶段启动，使用原启动器。对已经停止的实例，第一条启动两个数据库，第二条启动项目。原实例正在运行时执行 `db` 会保留运行中的 Web。

```bash
bash scripts/deploy-docker.sh db
bash scripts/deploy-docker.sh app
bash scripts/deploy-docker.sh status
```

<a id="existing-databases"></a>

## 已有两套数据库服务：只安装项目

直接编辑 [config/deployment/storage.ini](../../../../config/deployment/storage.ini)。独立部署的数据库由管理员提供账号、实际地址、端口和库名。以下操作从仓库根目录执行。

1. 打开 `vi config/deployment/storage.ini`，把 `[transaction]` 的 `backend` 改为 `postgresql`、`opengauss` 或 `sqlite`。
2. 在所选后端的同名段中填写主机、端口、库名、用户、实际密码和 schema。SQLite 服务填写 `endpoint` 和 `token`。在 `[clickhouse]` 段填写 HTTP(S) 地址、库名、用户和密码。密码原样填写，包括 `@`、`#` 或 `%`。外部账号请用实际凭据替换 `@instance`。
3. 运行 `bash scripts/deploy-step.sh app`，再用 `bash scripts/deploy-step.sh status` 查看项目状态。全新的 App 独立实例只启动项目容器。已有数据的实例若需换库，按[升级与回滚](upgrade-and-rollback.md)迁移，或为独立数据源使用新的实例目录。

跨容器网络或跨主机填写 App 可达的 DNS/IP 和发布端口；容器里的 localhost 指容器自身。远程数据库使用对应的 TLS 选项，私有 CA 需挂载到 App 可读的路径。保留旧 JSON 工作流的部署可继续使用 `bash scripts/deploy-docker.sh app --config 私有配置路径`。

**源码部署**使用宿主机可达的地址及真实凭据（例如脚本默认分步数据库在同机的 PostgreSQL 和 ClickHouse 端口为 25432 和 28123）。准备 [Storage Core 所需的运行环境与驱动](storage-core.md) 后，可用同一份 INI 执行：

```bash
bash scripts/install.sh --check --config config/deployment/storage.ini
bash scripts/install.sh --config config/deployment/storage.ini
bash scripts/status.sh --config config/deployment/storage.ini
```

源码 INI 使用默认运行目录 `~/.agent-insight` 和 Web/Core 端口 3000/4319。已有自定义运行目录、端口或高级选项的 JSON 配置可沿用原命令。

## 后端设置与维护

- **PostgreSQL / openGauss** 使用 `control.dsn`、独立 `schema` 和持久 `artifacts` 目录。示例账号供独立实例初始化使用；对接生产环境时提供专用业务账号。openGauss 可通过 `OPENGAUSS_IMAGE` 指定镜像。一键入口优先复用本地的 `opengauss:7.0.0-RC3`。首次缺少镜像时，按 Docker 服务端架构下载官方 7.0.0-RC3 归档并导入，需要可用的临时磁盘空间。直接使用独立 Compose 文件时可设置 `OPENGAUSS_IMAGE=opengauss:7.0.0-RC3` 复用同一镜像。[社区容器镜像指南](https://docs.opengauss.org/zh/docs/7.0.0-RC3/installation_guide/installing_the_container_image.html)
- **SQLite 服务** 使用 `control.endpoint`、`token` 和 `artifacts`，外接时客户端与服务使用同一高熵令牌（至少 24 个可打印 ASCII 字符）。单独启动服务设置 `SQLITE_TOKEN`。事务绑定同一 HTTP 连接，断连回滚。跨机时使用 TLS，可将服务端证书与密钥只读挂载至容器并设置 `SQLITE_TLS_CERT`、`SQLITE_TLS_KEY`；客户端用 `https://` 和受信 CA。使用 Compose 覆盖文件将证书环境变量传给服务，并设置容器内的 `SQLITE_HEALTH_ENDPOINT` 为与证书匹配的 HTTPS 地址；私有 CA 使用 `SSL_CERT_FILE`。备份时可在 SQLite 容器内执行 `python3 -m services.storage.sqlite_server --backup /var/lib/insight-sqlite/backup.db`，目标必须是新文件。现有 `control.database` 本地文件配置依然适用。
- **ClickHouse** 始终配置 `clickhouse.endpoint/database/user/password`，服务端口使用 HTTP(S)。项目容器默认 `runtime.home=/data/agent-insight`、`runtime.webPort=3000`，通过宿主端口映射调整外部访问端口。
- **运行与恢复**。整体实例用 `status` 检查状态、`stop` 停止服务；只停项目使用该实例的 Compose 项目名和 `stop app`。升级前成套备份数据库卷、应用制品卷及私有配置目录。恢复前先对齐数据库与制品版本。登录后向 Web 上报一条测试 Trace 并查回，用于业务验收。

<details>
<summary>历史单容器镜像与源码挂载（仅适用于对应历史版本）</summary>

### 用法一：在线拉取 Docker Hub 镜像

```bash
docker pull karaggagent/agent-insight:latest

mkdir -p ~/.agent-insight/data
chmod -R 777 ~/.agent-insight

docker stop agent-insight 2>/dev/null || true
docker rm agent-insight 2>/dev/null || true

docker run -d \
  --name agent-insight \
  --restart unless-stopped \
  -p 3000:3000 \
  -v ~/.agent-insight:/data/agent-insight \
  karaggagent/agent-insight:latest

curl -i http://localhost:3000/
```

这条命令会把容器内的 `/data/agent-insight` 挂到服务器宿主机当前用户的 `~/.agent-insight`。SQLite 数据库、Skill 附件、评测运行时文件都会写入该目录下的 `data/`，容器重启、删除、重拉镜像后仍可复用。默认数据库路径是：

```text
~/.agent-insight/data/witty_insight.db
```

### 用法二：离线导入 `.tar` 镜像

如果服务器无法访问 Docker Hub，可以先拿到离线镜像包，例如 `agent-insight-0.5.0-image.tar`，再导入运行：

```bash
docker load -i agent-insight-0.5.0-image.tar
docker images | grep agent-insight

mkdir -p ~/.agent-insight/data
chmod -R 777 ~/.agent-insight

docker stop agent-insight 2>/dev/null || true
docker rm agent-insight 2>/dev/null || true

docker run -d \
  --name agent-insight \
  --restart unless-stopped \
  -p 3000:3000 \
  -v ~/.agent-insight:/data/agent-insight \
  karaggagent/agent-insight:0.5.0

curl -i http://localhost:3000/
```

如果 `docker load` 输出的镜像 tag 不是 `karaggagent/agent-insight:0.5.0`，请以 `docker images | grep agent-insight` 看到的实际镜像名为准。

如果你不想直接挂宿主机目录，也可以使用 Docker volume：

```bash
docker run -d \
  --name agent-insight \
  --restart unless-stopped \
  -p 3000:3000 \
  -v agent-insight-data:/data/agent-insight \
  karaggagent/agent-insight:latest
```

如果生产环境需要锁定版本号，可以把 `latest` 换成固定版本，例如 `0.5.0`：

```bash
docker pull karaggagent/agent-insight:0.5.0
docker stop agent-insight
docker rm agent-insight
docker run -d \
  --name agent-insight \
  --restart unless-stopped \
  -p 3000:3000 \
  -v ~/.agent-insight:/data/agent-insight \
  karaggagent/agent-insight:0.5.0
```

服务器上用哪个用户运行 Docker，就会挂载哪个用户的 home 目录。升级到新版本时，保留同一个挂载目录即可，容器数据不会随镜像更新丢失。

### 用法三：挂载源码运行，代码更新后重启即可生效

适用于服务器要跟着最新代码跑的场景：不用每次改代码都重新发 npm 包、重新打镜像，`git pull` 之后重启容器即可生效。

给容器加一个 `AGENT_INSIGHT_SOURCE_DIR` 环境变量，指向挂载进来的源码目录：

```bash
git clone https://gitcode.com/openeuler/agent-insight.git /srv/agent-insight

# 数据目录要在首次启动前建好并交给容器内的 node 用户(uid 1000),否则 prisma 建表会报
# "attempt to write a readonly database"——容器自动创建的挂载目录属主是 root。
mkdir -p ~/.agent-insight/data
chown -R 1000:1000 ~/.agent-insight

docker run -d \
  --name agent-insight \
  --restart unless-stopped \
  -p 3000:3000 \
  -e AGENT_INSIGHT_SOURCE_DIR=/src \
  -v /srv/agent-insight:/src:ro \
  -v ~/.agent-insight:/data/agent-insight \
  karaggagent/agent-insight:latest
```

对应的 compose 写法（`compose.yaml`），镜像构建也可以一并交给 compose：

```yaml
services:
  agent-insight:
    image: agent-insight:src
    build:
      context: /srv/agent-insight              # 用源码仓库根目录的 Dockerfile 构建
      args:
        AGENT_INSIGHT_VERSION: "0.5.4"         # 镜像内预装依赖对应的 npm 版本
    container_name: agent-insight
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      AGENT_INSIGHT_SOURCE_DIR: /src
      NODE_OPTIONS: --max-old-space-size=2048  # 小内存机器上防止构建被 OOM kill
    volumes:
      - /srv/agent-insight:/src:ro             # 源码，只读
      - ${HOME}/.agent-insight:/data/agent-insight
      - agent-insight-build:/app/source        # 构建目录，让缓存跨容器重建保留

volumes:
  agent-insight-build:
```

更新代码的流程：

```bash
cd /srv/agent-insight && git pull
docker compose restart agent-insight   # 非 compose 场景：docker restart agent-insight
docker compose logs -f agent-insight   # 看到 "Building from source..." 到构建结束即可
```

注意用 `restart` 而不是 `up -d`：容器配置没变时 `up -d` 什么都不做，不会触发重新构建。只有改了 `package.json` 依赖、需要连镜像一起重建时才用 `docker compose up -d --build`。

离线服务器也可以通过源码 ZIP 更新。更新脚本的帮助、进度与错误提示使用英文，避免服务器终端中文乱码。先把现有 Compose 的源码挂载改为 `${SOURCE_RELEASE:?SOURCE_RELEASE is required}:/src:ro`，保留 `AGENT_INSIGHT_SOURCE_DIR=/src` 和原有数据挂载。将 `scripts/update-source.sh` 放到服务器，修改顶部 `DEFAULT_COMPOSE_FILE`（默认 `/srv/agent-insight/compose.yml`），然后执行：

```bash
bash update-source.sh --zip /path/to/agent-insight.zip
# 临时覆盖 Compose 路径；RELEASES_DIR 可覆盖解压目录（默认 /srv/agent-insight/releases）
RELEASES_DIR=/srv/agent-insight/releases bash update-source.sh \
  --zip /path/to/agent-insight.zip --compose /srv/agent-insight/compose.yml
```

脚本需要宿主机安装 Bash、Python 3 和 Docker Compose v2，并具有解压目录和 Docker 的操作权限。它会解压到新的版本目录，自动识别网页 ZIP 的外层目录，导出 `SOURCE_RELEASE`，然后执行与手动更新相同的 `docker compose -f <配置文件> up -d --force-recreate --pull never --no-build`。它不额外校验 Compose 的源码挂载，也不等待健康检查；命令返回后应用可能仍在构建，请查看日志并检查页面与业务功能。Compose 中的源码挂载仍需引用 `SOURCE_RELEASE`；若路径写死，导出的变量不会改变挂载位置。使用管理原容器的同一份 Compose 和项目名（自定义项目名可通过 `COMPOSE_PROJECT_NAME` 传入）。脚本不拉取或构建镜像，不清理旧版本目录。失败时保留源码并输出错误；不会自动备份或回滚数据库。脚本内导出的 `SOURCE_RELEASE` 不会保存到调用者的终端，后续单独执行 Compose 时需先设置脚本输出的源码路径。

ZIP 更新前请备份数据库，并确认新分支的依赖、数据库 schema 和升级逻辑兼容现有部署。依赖变更仍需更新镜像。入口脚本会执行数据库准备脚本和 schema 同步，即使本次 schema 文件没变，也不能把 ZIP 更新视为绝不会修改数据库；修改源码中的 `docker-entrypoint.sh` 也不会替换镜像已安装的入口脚本。

需要了解的行为：

- **不配置 `AGENT_INSIGHT_SOURCE_DIR` 时行为与之前完全一致**，容器直接运行镜像里打好的 `agent-insight` npm 包。
- 配置之后，容器启动时会把源码复制到容器内的 `/app/source`（跳过 `node_modules`、`.next`、`.git`、`data/`、`exclude/`），再依次执行 `prisma db push`、`prisma generate`、`npm run build`，最后和默认模式一样由控制网关加载 standalone 服务。宿主机源码目录以只读挂载即可，不会被写入构建产物，也不需要迁就容器里 `node` 用户的属主。
- 依赖用的是镜像预装的那一份（含 `tailwindcss`、`typescript` 等构建期依赖），源码目录不需要 `npm install`。**因此源码改了 `package.json` 新增依赖或调整精确锁定版本时，必须重新构建镜像**；启动时会检查缺失依赖和精确版本不匹配，列出问题并直接退出，不再仅告警。版本范围声明不等同于完整的兼容性验证。
- 首次启动是冷构建，需要几分钟；构建期间端口还没起，容器健康状态显示 `health: starting` 属正常。之后重启会保留 `.next/cache` 走增量构建；容器被删掉重建时，只有像上面那样给 `/app/source` 挂了 volume 才保得住缓存。
- 构建期间服务不可用（分钟级）。不能停机的话，先用另一个端口起一份新容器验证通过，再切端口或流量。
- 路径写错（拼错、忘了挂 volume、误填宿主机路径）时容器会**直接报错退出，不会静默回退到镜像内置版本**。配了 `restart: unless-stopped` 就表现为反复重启，`docker logs` 里第一行就是原因。校验在复制源码之前完成，失败时数据目录和上一次的构建缓存都不受影响。
- 数据目录属主必须是容器里的 uid 1000，且要在**首次启动前**准备好——目录由 Docker 自动创建时属主是 root，`prisma db push` 会报 `attempt to write a readonly database`。
- 这个变量必须通过容器环境变量传入（`-e` 或 compose `environment`），写进 `~/.agent-insight/.env` 不生效——entrypoint 在读取该文件之前就要决定跑哪份代码。

如果容器启动后访问不到 `3000`，先看容器状态和日志：

```bash
docker ps -a --filter name=agent-insight
docker logs --tail=200 agent-insight
curl -i http://127.0.0.1:3000/
```

常见的 `unable to open database file` 通常是宿主机挂载目录不存在或权限不足。确认目录已创建，并且容器内的 `node` 用户可以写入 `/data/agent-insight/data`。

如果你需要自己构建镜像，可以直接用仓库根目录的 `Dockerfile`。镜像默认从 npm 拉取 `agent-insight@latest`，不会把源码复制进镜像：

```bash
docker build --pull --no-cache -t agent-insight:npm-latest .
docker run -d --name agent-insight -p 3000:3000 -v agent-insight-data:/data/agent-insight agent-insight:npm-latest
curl -i http://localhost:3000/
```

需要固定某个 npm 版本时：

```bash
docker build --pull --build-arg AGENT_INSIGHT_VERSION=0.5.0 -t agent-insight:0.5.0 .
```

如果你只是想在服务器上快速验证本地改动，不想每次都先发布 npm 包，可以用上面的[用法三：挂载源码运行](#用法三挂载源码运行代码更新后重启即可生效)，或走“`npm pack` + 上传 `.tgz` + Docker 缓存构建”的测试流程，见 [Docker 测试构建](../../how-to/platform/docker-testing.md)。

容器只负责运行 Agent Insight 服务端。OpenCode、Claude Code、OpenClaw、LangChain 等框架的接入命令仍应在对应 Agent 实际运行的机器或容器里执行。当前仓库里的这份 `Dockerfile` 走 **SQLite 优先** 路线，不内置 OpenGauss 运行时依赖。

OpenCode 接入命令还会在 Agent 所在机器使用与服务端匹配的 Agent Insight 包版本执行
`install-ras`，把 Agent RAS runtime 安装到 `~/.agent-insight/ras/runtime/`。
安装脚本通过隔离的 npm cache 只下载发布 `.tgz`，不会用 `npx` 临时安装整套看板依赖；
安装完成后还会只读预检 RAS 事件接收地址，提前完成源码开发服务的路由编译并验证当前
API Key。预检失败会明确告警，但不会阻断普通链路插件和看板服务。
容器化部署看板时，不要在看板容器内安装 OpenCode RAS 插件；插件必须和 OpenCode
位于同一运行环境。

如果你要使用 `opencode-live` 触发分析、轨迹评测等会由服务端**本机拉起 opencode** 的能力，请确保当前 `Dockerfile` 构建出的镜像完整保留 npm 依赖，并让容器能够访问模型提供商网络；这些评测不会复用外部宿主机上另开的 opencode 进程。

</details>

## UBI9/OpenShift 镜像

完整步骤见[在 OpenShift 上部署服务端](./deploy-openshift.md)，包括项目权限、镜像准备、PVC/SCC、HTTPS Route、Developer Sandbox 构建、业务验收与排障。

需要 UBI9、完整 DNF 及客户派生补丁构建能力时，使用从源码制作的独立 `Dockerfile.openshift` 镜像，构建及补丁验收步骤见[镜像发布](./release-docker-image.md#构建-ubi9openshift-交付候选)。它与通用 Docker Hub 镜像是不同的交付入口。

UBI9 候选按预构建方式运行，不支持 `AGENT_INSIGHT_SOURCE_DIR` 运行时源码挂载；代码升级请重新构建镜像。

更新后的共享 Docker 入口通过控制网关同时承载应用 HTTP 和 WebSocket 控制通道。控制指令分发端口默认为应用端口加一，只绑定容器内回环地址，无需额外暴露。升级后还需更新并重启已安装的客户端，客户端脚本不会随服务端镜像替换自动更新。公网验收应覆盖 WSS 正常连接及降级长轮询；任务下发后断连、缺少 ACK 也应有明确的超时结果，不能只检查首页健康状态。

部署模板为 [`deploy/openshift.yaml`](../../../../deploy/openshift.yaml)。先替换示例镜像为可访问的交付镜像或 digest，确认节点架构、PVC 大小和默认 StorageClass，再执行：

```bash
oc apply -n <项目名称> -f deploy/openshift.yaml
oc rollout status -n <项目名称> deployment/agent-insight
oc get -n <项目名称> route/agent-insight
```

镜像默认 UID 0 供派生构建继承；在 OpenShift 运行时使用目标 SCC 分配的非 root UID，不设置固定 `runAsUser`，也不申请 `anyuid` 或特权。Pod 可设置 `runAsNonRoot: true`、`allowPrivilegeEscalation: false`、`capabilities.drop: [ALL]` 和 `seccompProfile.type: RuntimeDefault`。先按单副本部署，并使用 `Recreate` 更新策略，避免两个实例同时访问同一运行根。部署前确认集群节点架构、项目配额及实际使用的 SCC。

将 PVC 挂到 `/data/agent-insight`，按存储类型核验 SCC 分配的组权限和 SQLite 文件锁；模型凭据通过 Secret/外部配置提供。镜像已将 HOME 和 XDG 目录放入运行根，Prisma 初始化需要写入镜像内预留目录，因此当前不声明支持只读根文件系统。OpenShift 探针需要在工作负载中配置，Docker HEALTHCHECK 不会自动转换为探针。通过 Service/Route 发布端口 3000，并验证 HTTPS、SSE、WebSocket 和网关超时。

先执行镜像验证，再在真实 OpenShift 环境验证非 root UID/SCC、PVC 重建持久化、登录、Trace、评测和优化。基础镜像迁移、Docker 启动成功或漏洞扫描结果不能相互替代。备份、升级和恢复仍遵循[升级与回滚](./upgrade-and-rollback.md)，不能只回退镜像而忽略数据库结构变化。


---


完成部署后继续[首次接入教程](../../tutorial/platform/01-quick-start.md)。升级前先阅读[升级与回滚](./upgrade-and-rollback.md)。

[English](../../../en/how-to/platform/deploy-docker.md)
