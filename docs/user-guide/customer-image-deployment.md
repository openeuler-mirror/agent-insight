---
title: "客户镜像部署指南"
description: "导入离线镜像，填写推理分析地址，选择 Docker Compose 或 docker run 启动平台。"
---

# Agent Insight 镜像部署指南

交付包包含 **`agent-insight-image.tar.gz` 和 `compose.yaml`**。用户只需导入镜像、填写推理分析地址、启动服务，不需要创建数据目录、修改目录权限或编写 `.env`。

> 本次交付为 **Linux ARM64（aarch64）** 镜像，适用于 ARM64 服务器。镜像包含已编译的服务端、前端静态资源和运行依赖，启动时无需编译或下载依赖。服务器需提前安装并启动 Docker，**Compose 为可选工具**；用户无需修改镜像标签。Docker 18.09 等旧版本需在目标机器验证镜像导入和启动。

## 1. 导入镜像（首次部署执行一次）

把交付的两个文件放在同一目录，进入该目录执行：

```bash
docker load -i agent-insight-image.tar.gz
```

看到 `Loaded image: agent-insight:dev-jh` 即表示导入成功。服务器需有足够空间存放镜像和后续 Trace 数据。

## 2. 选择启动方式，填写跳转地址

下面两种方式任选一种，**不要同时启动两个实例使用同一数据卷**。把所选方式中的示例地址 `http://192.0.2.20:8080` 换成推理分析服务地址，保留 `http://` 或 `https://`。**只填协议、IP/域名和端口，不填路径。** 暂时没有分析服务时将地址设为空字符串 `""`，平台仍可采集和查看 Trace。

这是用户浏览器访问的分析页面地址，不是模型 API 地址。远程部署不要填 `localhost`。平台会自动拼接：

```text
http://<分析服务IP>:<端口>/model-performance?GlobalTrackNO=<调用ID>
```

### 方式 A：已安装 Docker Compose v2

执行 `docker compose version` 能显示版本时，使用本方式。打开交付的 `compose.yaml`，只修改这一行：

```yaml
AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN: "http://192.0.2.20:8080"
```

在 `compose.yaml` 所在目录启动并查看状态、日志：

```bash
docker compose up -d
docker compose ps
docker compose logs --tail 100 agent-insight
```

### 方式 B：未安装 Compose，直接使用 Docker

无需安装 Compose，也无需修改 `compose.yaml`。首次启动执行：

```bash
docker run -d \
  --name agent-insight \
  --restart unless-stopped \
  --stop-timeout 60 \
  -p 3000:3000 \
  -e AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN="http://192.0.2.20:8080" \
  -v agent-insight-customer-data:/data/agent-insight \
  --log-driver json-file \
  --log-opt max-size=20m \
  --log-opt max-file=5 \
  agent-insight:dev-jh
```

查看状态和日志：

```bash
docker ps --filter name=agent-insight
docker logs --tail 100 agent-insight
```

只有旧版 `docker-compose` 命令时，也可使用方式 B；不要直接把本指南的 `docker compose` 命令替换成旧命令使用。

## 3. 打开平台

在浏览器打开 **`http://<平台服务器IP>:3000`**，按页面输入约定的邮箱账号。当前为受控内网使用的本地账号模式，不验证邮箱归属或密码。

两种启动方式都会自动初始化配置、数据库和数据卷，容器状态应逐步变为 `healthy`。确保服务器防火墙允许客户端访问 3000 端口；如果该端口已占用，把 Compose 或 `docker run` 中 `3000:3000` 的左侧改成空闲端口，并使用对应端口访问。

数据自动保存在 Docker 卷 **`agent-insight-customer-data`** 中，重建容器会继续使用这些数据。无需手工建目录或执行 `chmod` / `chown`；不要删除此数据卷或使用 `docker compose down -v`。

## 4. 接入 Agent，检查一次调用

1. 在平台进入 **客户端安装**，选择 OpenCode 或 Qoder。客户端需预先能正常使用 Agent，Linux/macOS 的 curl 安装流程要求 Node.js 20 或以上。
2. **按安装页提示先自行备份 Agent 配置**，然后把页面命令复制到 Agent 所在机器执行。采集安装会更新 Hook 和插件配置，不改写模型地址，也不提供自动卸载或回退。
3. 需要推理分析关联时，在 Agent 项目目录执行安装页“启用 / 同步模型转发”命令。默认 OpenCode 命令如下；Qoder CN CLI 将末尾参数换成 `qoder`，自定义安装目录使用安装完成时打印的命令。

```sh
sh ~/.agent-insight/model-proxy.sh opencode
```

命令先自动备份模型配置并打印位置，再登记原始上游、改写地址。`original.jsonc` 保留首次原件，`latest.jsonc` 同步用户后续修改并保留原始上游地址。新增 Provider 后重跑同一命令。脚本复用客户端 Node.js 20+，不会自动安装 Node；找不到兼容版本时停止，不修改模型配置。

4. 按提示重启 Agent，执行一次简单任务，例如“只回复 hello”。Qoder IDE / JetBrains 还需安装对应采集插件；下载失败时联系交付方，不要安装残留旧包。
5. 用安装时的同一账号打开 **链路追踪**，稍等并刷新，进入 Trace 检查 LLM 调用，再点击 **推理分析** 验证跳转。

模型 API 地址仍使用 Agent 原有配置，经客户端本地转发组件访问推理服务，**不用改成平台的 3000 端口**。客户端需要能访问平台、模型 API 及安装所需的软件包源；离线客户端需另行准备依赖。

推理服务需读取请求头 **`X-Agent-Insight-Call-Id`**，将该 ID 绑定到推理记录，并支持上述分析页面按 ID 查询。每个链接只传一个 ID；Trace 整体入口列出各次模型请求，LLM 节点入口列出该节点对应的请求。详见[推理服务接入说明](../developer-guide/inference-service-integration.md)。

当前 OpenCode 1.x / 2.x 的已适配模型接口、Qoder CN CLI 的自定义 OpenAI-compatible Provider 支持此关联流程。**Qoder 原生 IDE / JetBrains 可接入采集，但模型地址接管尚未完成，不能保证推理分析跳转。** Qoder 部分缺少响应标识的失败请求只能关联整条 Trace。

## 后续操作

### 使用 Compose 部署

修改 `compose.yaml` 中的跳转地址后，执行下面的命令重建容器即可生效，不需要重新打镜像，也不需要编辑数据卷里的 `.env`：

```bash
docker compose up -d
```

仅执行 `docker compose restart` 不会应用 Compose 文件中的新环境变量。

暂停和恢复平台：

```bash
docker compose stop
docker compose up -d
```

### 使用 docker run 部署

暂停和恢复平台：

```bash
docker stop agent-insight
docker start agent-insight
```

修改跳转地址时，先停止并移除旧容器：

```bash
docker stop agent-insight
docker rm agent-insight
```

然后修改方式 B 的 `-e AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN`，重新执行整条 `docker run` 命令。**保留相同的 `-v agent-insight-customer-data:/data/agent-insight`**，已有配置和 Trace 数据会继续使用；上述命令只移除容器，不删除命名卷。仅执行 `docker restart` 不会更新环境变量。

### 升级镜像

先备份数据卷，再用 `docker load -i` 导入交付的新镜像。使用 Compose 时执行 `docker compose up -d`；使用 `docker run` 时，按上面的步骤停止、移除旧容器，再用新镜像执行方式 B 的启动命令。镜像标签以本次交付说明为准，保留原数据卷，不要同时启动两个实例使用这份数据。

已有客户端需重新执行新平台安装页提供的采集安装命令，才能获得本版 Shell 入口及插件更新；仅升级平台镜像不会更新客户端文件。需要新增或同步模型转发时，再执行上述显式命令。
