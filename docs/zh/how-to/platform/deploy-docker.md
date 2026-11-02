---
title: "用 Docker 部署服务端"
description: "在线镜像、离线导入、源码挂载与持久化运行目录。"
---

如果你还没有部署看板，可以直接拉取已发布的 Docker 镜像。`karaggagent/agent-insight` 已发布多架构镜像，`x86_64` 服务器会自动拉取 `linux/amd64`，`aarch64` 服务器会自动拉取 `linux/arm64`。

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
- 配置之后，容器启动时会把源码复制到容器内的 `/app/source`（跳过 `node_modules`、`.next`、`.git`、`data/`、`exclude/`），再依次执行 `prisma db push`、`prisma generate`、`npm run build`，最后和默认模式一样跑 `node .next/standalone/server.js`。宿主机源码目录以只读挂载即可，不会被写入构建产物，也不需要迁就容器里 `node` 用户的属主。
- 依赖用的是镜像预装的那一份（含 `tailwindcss`、`typescript` 等构建期依赖），源码目录不需要 `npm install`。**因此源码改了 `package.json` 新增依赖时必须重新构建镜像**；启动日志会打印镜像里缺失的依赖清单作为告警。
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

---


完成部署后继续[首次接入教程](../../tutorial/platform/01-quick-start.md)。升级前先阅读[升级与回滚](./upgrade-and-rollback.md)。
