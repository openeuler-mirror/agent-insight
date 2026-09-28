# 安装与维护

本文介绍 Linux 主机上的源码、npm 安装包和 Docker 镜像部署，默认使用 SQLite 数据库。选择一种方式完成安装，再进行登录、模型注册和 Agent 接入。

## 前提条件

- 已准备 Linux 服务器，计划使用的端口可用。本文默认使用 `3000`。
- 数据目录有足够空间保存 Trace、评测数据和备份，并允许运行账号读写。
- 通过网络安装时，可以访问所需的源码、npm 依赖或镜像源；离线部署时，已取得匹配目标架构和源码版本的交付包。
- 执行升级前已停止旧实例并备份数据。

## 安装方式选择

Agent Insight 可以通过源码、npm 安装包或 Docker 镜像部署。本文的界面操作基于 830 分支提交 `732fceb203c29d427e0075468a4fb679dcd9fb41`；使用 npm 包或镜像时，必须确认该产物对应的源码版本。相同的版本号或 `latest` 标签不能证明包含本手册对应的功能。

| 方式 | 适用情况 | 需要准备 |
| --- | --- | --- |
| 源码部署 | 需要运行本文明确对应的 830 代码，或需要修改源代码 | Git、Node.js 和 npm |
| npm 安装包 | 已取得与目标源码版本对应的发布包 | Node.js、npm 和固定版本 npm 包或本地 `.tgz` 安装包 |
| Docker 镜像 | 使用预先构建的在线或离线镜像 | Docker、匹配服务器 CPU 架构的镜像、可写的持久化目录 |

对于源码和 npm 部署，建议准备 Node.js 22.13 或以上的 22.x 环境。客户端接入脚本检查 Node.js 主版本不低于 20。Docker 预构建镜像已包含服务端运行环境，宿主机无需另外安装 Node.js 或 npm。

## 从源码部署

在 Linux 主机准备 Git、Node.js 22.13 或以上的 22.x 版本和 npm。先确认版本：

```bash
git --version
node --version
npm --version
```

获取 830 分支，并固定到本手册对应的代码：

```bash
git clone --branch 830 --single-branch https://gitcode.com/openeuler/agent-insight.git
cd agent-insight
git checkout --detach 732fceb203c29d427e0075468a4fb679dcd9fb41
git rev-parse HEAD
```

安装依赖、构建并准备 standalone 运行文件：

```bash
npm ci
npm run build
node scripts/prepare-npm-package.js
```

`npm ci` 的安装后脚本会初始化当前用户的数据目录和 Prisma。生产构建后需准备静态资源，再通过本地 CLI 启动：

```bash
node bin/cli.js start --port 3000
node bin/cli.js status --port 3000
```

打开 `http://<服务器地址>:3000/trace`。默认文件位置为：

| 内容 | 默认位置 |
| --- | --- |
| 生效配置 | `~/.agent-insight/.env` |
| SQLite 数据库 | `~/.agent-insight/data/witty_insight.db` |
| CLI 启动的服务日志 | `~/.agent-insight/server.log` |

启动后修改配置时，编辑生效的 `.env` 文件；仓库里的 `.env.example` 是首次初始化模板，修改模板不会更新已有配置。

停止、重启和查看日志：

```bash
node bin/cli.js stop --port 3000
node bin/cli.js start --port 3000
tail -n 200 "$HOME/.agent-insight/server.log"
```

上面的管理命令按需分别执行。确保指定端口属于本实例。自定义数据目录的用户按实际目录查看日志和备份数据。

## 使用 npm 安装包部署

在空目录中安装与本手册代码匹配的固定版本包。由维护者提供的本地 `.tgz` 可按以下方式安装：

```bash
mkdir agent-insight-deploy
cd agent-insight-deploy
npm init -y
npm install /path/to/agent-insight-package.tgz
npx agent-insight start --port 3000
npx agent-insight status --port 3000
```

如果使用 npm 仓库中的包，将安装命令改为 `npm install agent-insight@<固定版本号>`，安装前核对发布说明中的对应源码。不要用 `npm install agent-insight@latest` 作为运行 830 分支的证明。

默认数据和配置位置与源码 CLI 部署相同。停止时执行：

```bash
npx agent-insight stop --port 3000
```

## 使用 Docker 镜像部署

### 准备镜像与数据目录

使用已安装 Docker Engine 的 64 位 Linux 主机。运行 `uname -m` 查看 CPU 架构：`x86_64` 对应 `linux/amd64`，`aarch64` 或 `arm64` 对应 `linux/arm64`。

获取与目标版本对应的镜像包及清单。清单至少应注明文件名、固定镜像标签、CPU 架构、源码提交和 SHA-256。按清单填写并校验：

```bash
IMAGE_FILE='/path/to/agent-insight-image.tar.gz'
IMAGE='镜像名:固定版本'
IMAGE_SHA256='交付清单中的SHA256'
if printf '%s  %s\n' "$IMAGE_SHA256" "$IMAGE_FILE" | sha256sum -c -; then
  docker load -i "$IMAGE_FILE"
else
  echo '镜像包校验失败，请重新获取镜像包。' >&2
  exit 1
fi
```

Docker 可直接加载由 `docker save` 生成的 `.tar` 或 `.tar.gz` 包。加载后核对架构和运行用户：

```bash
docker image inspect "$IMAGE" \
  --format 'os={{.Os}} arch={{.Architecture}} user={{.Config.User}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
docker run --rm --entrypoint id "$IMAGE"
```

本文把宿主机 `/opt/agent-insight` 挂载到容器 `/data/agent-insight`。根据上一条命令返回的 uid/gid 创建目录；下面示例适用于 uid=1000、gid=1000 的镜像：

```bash
sudo install -d -m 750 -o 1000 -g 1000 /opt/agent-insight
```

已有数据目录先停止旧实例并备份，避免两个实例同时使用同一个 SQLite 数据目录。

### 启动和检查

```bash
docker run -d \
  --name agent-insight \
  --restart unless-stopped \
  -p 3000:3000 \
  --mount type=bind,src=/opt/agent-insight,dst=/data/agent-insight \
  "$IMAGE"
docker logs --tail 200 agent-insight
docker inspect agent-insight \
  --format 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
```

默认生效配置为 `/opt/agent-insight/.env`，SQLite 数据库为 `/opt/agent-insight/data/witty_insight.db`。镜像的启动脚本使用 SQLite；该镜像不包含 OpenGauss 运行依赖，不能通过填写 `DB_HOST` 切换到 OpenGauss。

浏览器打开 `http://<服务器地址>:3000/trace`。容器健康检查通过后，还应完成登录、打开链路追踪并验证一次数据上报。

Docker 方式使用以下命令管理：

```bash
docker stop agent-insight
docker start agent-insight
docker restart agent-insight
docker logs -f agent-insight
```

命令按需单独执行。宿主机端口冲突时，可以把映射改成 `-p 3033:3000`，然后访问 3033 端口。

## 备份与维护

SQLite 部署在备份前停止服务，完整保存配置及数据目录，不能只复制运行中的数据库主文件而遗漏 WAL 等文件。

CLI 部署示例（先执行相应 stop 命令）：

```bash
BACKUP_FILE="/tmp/agent-insight-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -C "$HOME" -czf "$BACKUP_FILE" .agent-insight
```

Docker 部署示例：

```bash
docker stop agent-insight
BACKUP_FILE="/tmp/agent-insight-$(date +%Y%m%d-%H%M%S).tar.gz"
sudo tar -C /opt -czf "$BACKUP_FILE" agent-insight
```

升级后检查服务、数据库初始化和页面，并重新完成一次数据接入验证。schema 同步失败时保留原始数据和备份，按错误处理，不能通过清空数据库或直接接受数据损失来跳过失败。

## 结果验证

1. 在服务端执行 `curl -fsS -o /dev/null http://127.0.0.1:3000/`，确认 HTTP 可访问。
2. 在浏览器打开 `http://<服务器地址>:3000/trace`。
3. 完成登录，确认可以打开 **链路追踪**。
4. 接入 AcTrail 并执行一次任务，确认可以查看新产生的 Trace。

容器显示 `healthy` 或端口处于监听状态，只能说明服务已响应检查，仍需完成页面和数据上报验证。

## 常见问题

| 现象 | 处理方法 |
| --- | --- |
| 页面无法访问 | 检查服务进程或容器状态、访问端口、防火墙和服务日志。 |
| 端口已经占用 | 为本实例选择空闲端口；Docker 修改宿主机端口映射。 |
| 提示数据库只读 | 核对持久化目录属主、运行用户和目录权限。 |
| schema 同步失败 | 保留数据与备份，根据日志处理；不要直接清空数据库或忽略初始化失败。 |
| Docker 容器启动后退出 | 检查镜像架构、挂载权限、`DB_HOST` 配置和 `docker logs`。 |
| 宿主机找不到 `/data/agent-insight` | 该路径在容器内；执行 `docker inspect` 查询宿主机挂载源，本文为 `/opt/agent-insight`。 |
| npm 安装出现 Node.js engine 提示 | 核对运行环境与目标包依赖要求，源码安装建议使用 Node.js 22.13 或以上的 22.x 版本。 |
