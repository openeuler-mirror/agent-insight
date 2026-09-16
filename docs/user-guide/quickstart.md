---
title: "830 平台安装说明"
description: "830 Linux Docker 镜像安装、产物位置、客户端接入、检查与备份升级。"
---

# Agent Insight 830 平台安装说明

> 更新日期：2026-09-16。服务端使用 Linux Docker 镜像交付；客户端安装指导只展示 Linux curl 接入命令。
>
> 本次问题修复对应 PR !402–!406、!408–!409。验收前应确认交付镜像包含所需修复，不能用旧镜像的版本和校验值代替本次交付清单。

## 1. 安装准备

准备一台已安装 Docker Engine 的 64 位 Linux 服务器，并确认：

- Docker 服务已启动，当前用户可以执行 Docker 命令。
- 宿主机访问端口可用，本文使用 `3000`。
- 数据目录所在磁盘有足够空间保存 Trace、评测数据和备份。
- 已收到镜像包及交付清单。清单应包含镜像文件名、固定镜像标签、CPU 架构、源码提交和镜像包 SHA-256。

查看服务器架构：

```bash
uname -m
```

| 服务器输出 | 镜像架构 |
| --- | --- |
| `x86_64` | `linux/amd64` |
| `aarch64` 或 `arm64` | `linux/arm64` |

将匹配架构的镜像包上传到服务器，后续命令均在服务器的 Bash 终端执行。

## 2. 校验并加载镜像

按交付清单填写以下变量；镜像标签必须是固定版本：

```bash
IMAGE_FILE='/path/to/交付的镜像包.tar.gz'
IMAGE='交付清单中的镜像名:固定版本'
IMAGE_SHA256='交付清单中的SHA256'
```

只有校验通过后才加载：

```bash
if printf '%s  %s\n' "$IMAGE_SHA256" "$IMAGE_FILE" | sha256sum -c -; then
  docker load -i "$IMAGE_FILE"
else
  echo '镜像包校验失败，请重新获取交付包。' >&2
  exit 1
fi
```

Docker 可直接加载 `docker save` 生成的 `.tar` 或其 `.tar.gz` 压缩包，无需手工解包。加载后核对镜像：

```bash
docker image inspect "$IMAGE" \
  --format 'os={{.Os}} arch={{.Architecture}} user={{.Config.User}} revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
```

确认 `os=linux`、架构与服务器匹配。源码提交应与交付清单一致；镜像没有 revision 标签时由交付方提供版本核对依据。

## 3. 准备持久化目录

本文使用宿主机 `/opt/agent-insight`，挂载到容器 `/data/agent-insight`。

先查询镜像运行用户的 uid/gid：

```bash
docker run --rm --entrypoint id "$IMAGE"
```

按实际输出创建目录。以下 `1000:1000` 仅适用于查询结果为 uid 1000、gid 1000 的镜像：

```bash
sudo install -d -m 750 -o 1000 -g 1000 /opt/agent-insight
```

使用已有数据前，先停止旧实例并完整备份。新旧实例不能同时使用同一个 SQLite 数据目录。

## 4. 启动平台

```bash
docker run -d \
  --name agent-insight \
  --restart unless-stopped \
  -p 3000:3000 \
  --mount type=bind,src=/opt/agent-insight,dst=/data/agent-insight \
  "$IMAGE"
```

首次启动初始化配置和 SQLite schema，然后启动镜像内已编译的服务。宿主机不需要安装 Node.js、npm 或源码。

如果宿主机 `3000` 已被占用，可将映射改为 `-p 3033:3000`，后续通过 `3033` 访问平台。

## 5. 安装产物和位置

| 产物 | 宿主机位置或查看方式 | 用途 |
| --- | --- | --- |
| 离线镜像包 | 上传时选择的路径 | 交付、校验和重新加载 |
| Docker 镜像及应用程序 | 由 Docker 管理；`docker image inspect` 查看 | 平台已编译程序和运行依赖 |
| 生效配置 | `/opt/agent-insight/.env` | 首次启动从镜像配置模板初始化 |
| SQLite 数据库 | `/opt/agent-insight/data/witty_insight.db` | Trace、账号及业务数据 |
| 数据目录内其他文件 | `/opt/agent-insight/data/` | 运行时生成的数据；备份时连同目录一起保存 |
| 服务日志 | `docker logs agent-insight` | 容器标准输出和标准错误 |
| 人工备份 | 备份命令指定的目录 | 升级前恢复依据 |

容器内对应路径为 `/data/agent-insight/.env` 和 `/data/agent-insight/data/witty_insight.db`。宿主机应查看挂载源 `/opt/agent-insight`。

SQLite 运行期间可能生成 `-wal`、`-shm` 文件，不要单独删除。日志通过 Docker 查看，不依赖宿主机 `server.log`。

## 6. 配置与安装检查

需要调整配置时，编辑宿主机生效文件并重启容器：

```bash
sudo vi /opt/agent-insight/.env
docker restart agent-insight
```

文件应仅允许运维人员和容器运行用户访问，并保持容器用户可读。数据库默认使用 SQLite；不要在本交付方式中设置 `DB_HOST`。

查看状态、日志和挂载：

```bash
docker ps -a --filter name=agent-insight
docker logs --tail 200 agent-insight
docker inspect agent-insight \
  --format 'status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
docker inspect agent-insight \
  --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
```

预期挂载包含 `/opt/agent-insight -> /data/agent-insight`。检查配置和数据库：

```bash
sudo ls -lah /opt/agent-insight/.env
sudo ls -lah /opt/agent-insight/data/witty_insight.db
curl -fsS -o /dev/null http://127.0.0.1:3000/
```

浏览器打开 `http://<服务器地址>:3000/trace`，登录后确认链路追踪页面可访问。容器显示 `healthy` 只说明 HTTP 健康检查通过，还应完成登录和页面检查。

## 7. Linux 客户端接入

本节在 **AcTrail 所在的 Linux 主机** 操作。该主机应已安装并运行 AcTrail，且官方 `otel-http` 插件可用。

1. 登录平台，进入“配置 → 安装指导”。页面仅包含接入命令和凭证/接入信息，不展示“相关文档”。
2. 确认当前账号及平台地址，复制页面生成的 **Linux** 命令。
3. 在 AcTrail 所在 Linux 终端执行。命令形态如下，实际地址和 API Key 以页面生成值为准：

```bash
curl -sSf "http://<平台地址>:3000/api/ingest/setup?key=<当前账号API_KEY>&yes=1&frameworks=actrail" | bash
```

4. 脚本配置上报插件后，在 AcTrail 中执行一次 Agent 任务。
5. 返回“运行观测 → 链路追踪”，查询本次任务并打开详情，核对节点及输入输出。

## 8. 日志与日常管理

```bash
docker logs --tail 200 agent-insight
docker logs -f agent-insight
docker stop agent-insight
docker start agent-insight
docker restart agent-insight
```

上述命令按实际需要单独执行。配置、数据库和运行数据保存在挂载目录，停止或重建容器不会自动删除这些文件。

## 9. 备份与升级

先停止平台，再对整个挂载目录备份：

```bash
docker stop agent-insight
BACKUP_FILE="/tmp/agent-insight-$(date +%Y%m%d-%H%M%S).tar.gz"
sudo tar -C /opt -czf "$BACKUP_FILE" agent-insight
```

将备份移交到可恢复的位置后，按第 2 节校验、加载新版镜像，并将 `IMAGE` 改为新固定标签。删除已停止的旧容器，再按第 4 节使用原挂载目录创建容器：

```bash
docker rm agent-insight
```

升级后重新完成第 6 节检查及本轮功能验收。schema 同步失败时先查看日志并保留数据与备份，由维护人员处理；不要用清空数据库的方式跳过失败。

## 10. 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 镜像包校验失败 | 核对文件和清单是否对应；重新获取镜像包后再次校验 |
| 容器启动后立即退出 | 查看 `docker logs`；核对架构、目录写权限、配置及数据库初始化错误 |
| 页面无法访问 | 查看容器状态、端口映射、服务器防火墙和 HTTP 响应 |
| 宿主机找不到 `/data/agent-insight` | 使用 `docker inspect` 查询挂载源，本文为 `/opt/agent-insight` |
| 客户端配置后没有 Trace | 核对插件加载结果、平台地址可达性、API Key 归属，以及是否实际执行了 Agent 任务 |
