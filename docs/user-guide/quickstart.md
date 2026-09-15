---
title: "5 分钟上手"
description: "登录看板、注册模型、通过 AcTrail 完成接入，并在 UI 中看到第一条链路。"
---

# 5 分钟上手

本指南带你用最短路径跑通 Agent Insight 的第一条完整闭环：完成基础配置、通过 AcTrail 接入 Agent，并在平台里看到真实链路。

完成后你会得到：

- 一份可用的模型配置
- 一套可用的 AcTrail 上报配置
- 一条真实上报并可查看详情的 Trace

> **Note**
> 本页更贴近当前项目的真实使用流程，默认你已经部署好了 Agent Insight 服务端，
> 并可以访问看板地址，例如 `http://localhost:3000` 或你的自托管域名。

## 前置条件

- 你可以访问 Agent Insight 看板
- 你拥有一个可用的模型 API Key，例如 OpenAI、DeepSeek 或其他兼容供应商
- 你有一个已安装 AcTrail 的 Linux / WSL Agent 运行环境
- 如果要走代码集成路径，准备好 Python 3.9+ 或 Node.js 18+

---

## Docker 部署服务端（830 转测交付）

**830 服务端对外仅通过 Docker 镜像交付。** 使用交付清单中的固定镜像名、版本（或摘要）、目标架构以及离线包 SHA256。本文中的尖括号内容都是待替换占位，不代表已发布镜像。宿主机需要可用的 Docker Engine、对应架构支持及未被占用的 3000 端口；无需另外安装服务端 Node.js 或 npm 包。

### 1. 获取固定版本镜像

在线和离线方式任选一种。以下命令在同一终端按顺序执行，并先替换变量中的占位内容。

**在线拉取：**

```bash
AI_IMAGE='<交付清单中的镜像名>:<固定版本>'
docker pull "$AI_IMAGE"
docker image inspect --format 'ID={{.Id}} Platform={{.Os}}/{{.Architecture}}' "$AI_IMAGE"
```

核对镜像版本、摘要（交付清单提供时）和架构；`linux/amd64` 对应 x86_64，`linux/arm64` 对应 aarch64。仅使用清单实际提供的架构，不能由本文推断某版本已发布多架构。

**离线校验并导入：**

```bash
AI_IMAGE='<交付清单中的镜像名>:<固定版本>'
AI_ARCHIVE='agent-insight-830-image.tar'
AI_EXPECTED_SHA256='<交付清单中的64位SHA256>'
if ! printf '%s  %s\n' "$AI_EXPECTED_SHA256" "$AI_ARCHIVE" | sha256sum -c -; then
  echo '镜像包校验失败，请核对交付清单并重新获取文件。' >&2
  exit 1
fi
docker load -i "$AI_ARCHIVE"
docker image inspect --format 'ID={{.Id}} Platform={{.Os}}/{{.Architecture}}' "$AI_IMAGE"
```

将 `AI_ARCHIVE` 改为实际离线包文件名。导入后镜像名、tag 和架构必须与交付清单一致；不要把其他旧 tag 当作本次交付版本。

### 2. 准备持久化目录和权限

在首次启动前查询镜像默认运行用户的 uid/gid，再创建宿主机目录。使用 `--entrypoint id` 只查询身份，不运行服务启动脚本。

```bash
AI_UID=$(docker run --rm --entrypoint id "$AI_IMAGE" -u)
AI_GID=$(docker run --rm --entrypoint id "$AI_IMAGE" -g)
sudo mkdir -p /opt/agent-insight
sudo chown "$AI_UID:$AI_GID" /opt/agent-insight
sudo chmod 750 /opt/agent-insight
```

仓库 `Dockerfile` 使用 `USER node`，但交付镜像的实际 uid/gid 以上述查询为准。已有数据目录时，先备份并检查子目录、数据库及 WAL 文件是否可由该用户写入，再按需要修正属主；不要对整个目录开放所有用户写权限。

### 3. 启动和检查

```bash
docker run -d \
  --name agent-insight \
  --restart unless-stopped \
  -p 3000:3000 \
  -v /opt/agent-insight:/data/agent-insight \
  "$AI_IMAGE"
docker ps -a --filter name=agent-insight
docker logs --tail 200 agent-insight
docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' agent-insight
curl -i http://127.0.0.1:3000/
```

容器名已存在时先检查现有实例，再按升级流程处理。正常启动后在浏览器访问 `http://<服务端地址>:3000`；`curl` 返回页面或跳转只能证明 HTTP 可达，还应登录看板检查核心操作。Agent 接入命令仍在实际运行 Agent 的机器上执行。

根据当前 `Dockerfile` 和 `scripts/docker-entrypoint.sh`，首次启动会：

1. 创建 `/data/agent-insight/data`。
2. 持久化 `.env` 不存在且包内 `.env.example` 存在时，复制生成 `/data/agent-insight/.env`；以后启动保留并加载该配置文件。
3. 将默认 SQLite 地址定位到 `/data/agent-insight/data/witty_insight.db`，通过 `scripts/db_push.sh` 同步 schema；失败会中止启动。
4. 执行 `npx prisma generate` 生成 Prisma Client。
5. 运行镜像中的 `.next/standalone/server.js`，默认模式不在启动时重新编译源码。

当前镜像是 **SQLite-first**。如果环境变量或持久化 `.env` 中设置了非空 `DB_HOST`，入口脚本会拒绝启动；不能据此直接接入 OpenGauss。`.env` 会作为 shell 配置加载，修改时保持合法语法并保护其中的密钥；首次生成后可在宿主机执行 `sudo chmod 600 /opt/agent-insight/.env`。修改持久化配置后重启容器生效；不要修改 `AGENT_INSIGHT_DATA_DIR` 来绕过现有挂载目录。

### 4. 安装后的产物

下表以宿主机 `/opt/agent-insight` 挂载到容器 `/data/agent-insight`、使用默认 SQLite 配置为准：

| 产物 | 容器位置 | 宿主机位置 / 生命周期 |
|---|---|---|
| 持久化配置 | `/data/agent-insight/.env` | `/opt/agent-insight/.env`，保留挂载目录时保留；首次有模板时生成 |
| 默认 SQLite 数据库 | `/data/agent-insight/data/witty_insight.db` | `/opt/agent-insight/data/witty_insight.db`；运行时可能有同目录 `-wal`、`-shm` 文件 |
| 应用运行数据 | `/data/agent-insight/data/` | `/opt/agent-insight/data/`；附件、评测等子目录按实际使用生成，并非安装后全部立即存在 |
| 服务代码及预编译入口 | `/app/node_modules/agent-insight/.next/standalone/server.js` | 镜像 / 容器内；不落入宿主机数据目录，替换镜像时更新 |
| Prisma Client | `/app/node_modules/.prisma` 等镜像依赖目录 | 启动生成于容器内，不属于数据库备份；确切依赖布局以交付镜像为准 |
| 源码构建目录 | `/app/source` | 仅维护者源码模式使用；默认不持久化 |
| 服务启动和运行日志 | 进程标准输出 / 标准错误 | 使用 `docker logs agent-insight`；由 Docker 日志驱动管理，不承诺在持久化目录生成固定 `server.log` |

删除容器不会删除上述宿主机挂载目录；镜像本身不包含你的运行数据。备份应覆盖完整的 `/opt/agent-insight`，包括 `.env` 和数据库相关文件。不要把运行中单独复制的 `.db` 文件当作一致性备份；可以停服务后备份完整目录。

### 5. 服务管理与升级

```bash
docker ps -a --filter name=agent-insight
docker logs --tail 200 agent-insight
docker restart agent-insight
docker stop agent-insight
docker start agent-insight
```

`Dockerfile` 的健康检查参数为：

| 参数 | 值 |
|---|---|
| interval | 30 秒 |
| timeout | 5 秒 |
| start-period | 600 秒 |
| retries | 3 次 |

健康检查访问容器内 `/`，HTTP 状态码小于 500 即判通过；它不是完整业务验收。`start-period` 是启动宽限期，不表示每次都需等待 600 秒。

升级前先按步骤 1 获取并核对新的固定镜像。停止当前容器后备份挂载目录，再替换容器并复用同一目录：

```bash
docker stop agent-insight
AI_BACKUP="/opt/agent-insight-backup-$(date +%Y%m%d-%H%M%S).tar"
if ! sudo tar -C /opt -cf "$AI_BACKUP" agent-insight; then
  echo '备份失败，保留旧容器并先排查。' >&2
  exit 1
fi
sudo chmod 600 "$AI_BACKUP"
# 确认备份成功后，删除旧容器；不删除 /opt/agent-insight。
docker rm agent-insight
# 将 AI_IMAGE 设为已核验的新固定镜像，再执行步骤 3 的 docker run。
```

新容器启动会再次同步 schema。回退旧镜像前需要核对 schema 兼容性；必要时同时恢复升级前备份。不要让两个容器同时使用这份 SQLite 数据目录。

常见故障：

- `unable to open database file` / `attempt to write a readonly database`：检查挂载路径，以及实际容器 uid/gid 对目录和已有数据库文件的写权限。
- `DB_HOST` 相关拒绝启动：检查容器环境和 `/opt/agent-insight/.env`，按当前 SQLite 交付配置修正。
- 持续 `starting` / `unhealthy`：检查 `docker logs`、数据库初始化错误与端口；源码构建需要额外时间和资源。

### 6. 维护者可选：Docker 源码挂载模式

以下用于维护者验证指定源码，不是替代 830 固定镜像的对外交付流程。准备好已核对的 `830` 源码目录 `/srv/agent-insight`、与源码依赖匹配的固定镜像和独立测试数据目录；同名容器须先按维护计划处理。

```bash
docker run -d \
  --name agent-insight-source-test \
  --restart unless-stopped \
  -p 3001:3000 \
  -e AGENT_INSIGHT_SOURCE_DIR=/src \
  -v /srv/agent-insight:/src:ro \
  -v /opt/agent-insight-source-test:/data/agent-insight \
  "$AI_IMAGE"
```

首次启动前按步骤 2 的权限方式准备 `/opt/agent-insight-source-test`。`AGENT_INSIGHT_SOURCE_DIR` 必须由 `-e` 或 Compose 环境传入，写进持久化 `.env` 不生效。入口先校验 `/src/package.json` 和 `/src/prisma/schema.prisma`，把源码复制到 `/app/source`，复用镜像依赖，初始化数据库后执行 `npm run build`，再查找实际 standalone 入口启动。宿主机源码保持只读。

源码依赖变化时必须重建匹配镜像；路径错误会退出，不会回退镜像内置代码。源码模式重启会重新构建，服务在构建期间不可用；重建容器后，未挂载的 `/app/source` 缓存不保留。构建方法见维护者专用的 [Docker 测试构建](./docker-testing) 和 [Docker 镜像发布](../developer-guide/docker-image-release.md)。RPM 构建指南保留作维护资料，不作为本次交付安装选项。

---

## 推荐路径

对于大多数用户，建议按下面顺序操作：

1. 登录看板并进入当前 Workspace
2. 在 **模型注册** 中先配置模型
3. 在 **安装指导** 中完成 AcTrail 接入
4. 触发一次真实执行
5. 在 **链路追踪** 中确认第一条 Trace

> **Tip**
> 如果你是开发者，且希望直接在代码里手工埋点，可以直接查看文末的
> “可选：通过 SDK 直接接入” 一节。

---

## 步骤一：登录并确认 Workspace

1. 打开你的 Agent Insight 看板地址。

   <p align="center">
     <img src="../images/home.png" alt="Agent Insight 看板首页" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
   </p>

2. 完成登录，进入默认 Workspace。
3. 确认左侧导航中可以看到以下模块：
   - **链路追踪**
   - **评测中心**
   - **模型注册**
   - **安装指导**

> **Tip**
> 如果你同时维护开发、预发和生产环境，建议为不同环境分别创建独立 Agent，
> 后续看 Trace 和做评测时会更清晰。

---

## 步骤二：注册第一个模型

进入侧边栏 **配置 → 模型注册**，完成一个可用模型的配置：

1. 点击 **注册首个模型** 或新增模型
2. 选择模型供应商
3. 填入 API Key 与必要的 Endpoint
4. 点击 **测试连接并保存**

   <p align="center">
     <img src="../images/llm.png" alt="Agent Insight 模型注册页面" style="width: 100%; max-width: 1040px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
   </p>

完成后，你的 Workspace 就具备了后续执行生成、诊断、评测等能力所需的模型依赖。

> **Warning**
> 如果模型连接失败，先不要继续后续步骤。很多分析、评测和 Skill 流程都依赖模型可用。

---

## 步骤三：按安装指导完成接入

进入 **配置 → 安装指导**，按页面提示完成接入。

按下面步骤完成 AcTrail 接入：

1. 先安装并启动 AcTrail，确认官方 `otel-http` 插件可用。
2. 在页面复制 **Linux / WSL** 命令。

3. 在 AcTrail 实际运行的 Linux / WSL 环境执行命令。Windows 用户应先进入对应 WSL 发行版。
4. 脚本会生成 `~/.agent-insight/actrail/otel-http.config.toml`，把平台地址和当前用户 API Key 配给 AcTrail 官方 `otel-http` 插件，并持久化加载 `agent-insight.otel-http` 实例。
5. 继续使用原来的启动方式运行 Agent：

   ```bash
   sudo actrailctl launch --name <名称> -- <Agent 命令>
   ```

如果 AcTrail 使用非默认配置或插件目录，可在运行脚本前分别设置 `ACTRAIL_OPERATOR_CONFIG`、`ACTRAIL_PLUGIN_DIR`。

---

## 步骤四：验证生成的 Trace

完成安装或配置后，按下面两步验证是否已生成 Trace。

1. 使用 `sudo actrailctl launch --name <名称> -- <Agent 命令>` 发起一次真实 Agent 执行。

2. 回到平台，进入 **运行观测 → 链路追踪**，确认是否出现新的 Trace。

   <p align="center">
     <img src="../images/example_trace.png" alt="链路追踪中的 Trace 示例" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
   </p>

验证时优先确认这些信息：

- 列表里出现新的 Trace 记录
- 能看到执行状态、耗时、Token 等基本指标
- 点进详情后，可以看到 Trace 树和各个 Span
- 如果流程中使用了工具或子 Agent，也能看到对应节点

第一次验证时，不需要追求数据很完整，先确认“**有数据、能展开、能看懂主要步骤**”即可。

确认生成 Trace 后，你就已经完成了平台配置和 AcTrail 接入验证。

> **Warning**
> 如果 30 秒后仍然看不到数据，按下面顺序排查：
>
> 1. 检查 `actraild plugin status --instance agent-insight.otel-http` 的状态
> 2. 确认客户端到服务端的网络是否通顺
> 3. 是否选中了正确的 Workspace
> 4. Agent 使用的 API Key / 配置是否来自当前 Agent
>
> 仍无法解决时，可继续参考 [常见问题](./faq)。

## 继续阅读

- 想先看产品整体结构 → [Agent Insight](./home)
- 想补齐基础配置 → [模型注册](./settings/model-registry) / [安装指导](./settings/access-control)
- 想理解平台核心名词 → [核心概念](./concepts)
- 想继续排查和分析线上执行 → [运行观测](./observability/index)
- 想建立第一套离线评测 → [评测中心](./evaluation/index)
- 想沉淀可复用能力 → [Skills 能力](./skills/index)
