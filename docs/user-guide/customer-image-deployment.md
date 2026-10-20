---
title: "客户镜像部署指南"
description: "导入离线镜像，填写推理分析地址，使用 Docker Compose 启动平台。"
---

# Agent Insight 镜像部署指南

交付包包含 **`agent-insight-image.tar.gz` 和 `compose.yaml`**。用户只需导入镜像、填写推理分析地址、启动服务，不需要创建数据目录、修改目录权限或编写 `.env`。

> 本次交付为 **Linux ARM64（aarch64）** 镜像，适用于 ARM64 服务器。镜像包含已编译的服务端、前端静态资源和运行依赖，启动时无需编译或下载依赖。服务器需提前安装并启动 Docker，以及 Docker Compose v2；用户无需修改镜像标签。

## 1. 导入镜像（首次部署执行一次）

把交付的两个文件放在同一目录，进入该目录执行：

```bash
docker load -i agent-insight-image.tar.gz
```

看到 `Loaded image: agent-insight:dev-jh` 即表示导入成功。服务器需有足够空间存放镜像和后续 Trace 数据。

## 2. 在 Compose 中填写跳转地址

打开交付的 [compose.yaml](../../compose.yaml)，只修改这一行：

```yaml
AGENT_INSIGHT_INFERENCE_ANALYSIS_ORIGIN: "http://192.0.2.20:8080"
```

把示例 IP 和端口换成推理分析服务地址，保留 `http://` 或 `https://`。**只填协议、IP/域名和端口，不填路径。** 暂时没有分析服务时保留空字符串 `""`，平台仍可采集和查看 Trace。

这是用户浏览器访问的分析页面地址，不是模型 API 地址。远程部署不要填 `localhost`。平台会自动拼接：

```text
http://<分析服务IP>:<端口>/model-performance?GlobalTrackNO=<调用ID>
```

## 3. 启动并打开平台

在 `compose.yaml` 所在目录执行：

```bash
docker compose up -d
```

随后在浏览器打开 **`http://<平台服务器IP>:3000`**，按页面输入约定的邮箱账号。当前为受控内网使用的本地账号模式，不验证邮箱归属或密码。

平台会自动初始化配置、数据库和数据卷。可用下面的命令查看状态和日志：

```bash
docker compose ps
docker compose logs --tail 100 agent-insight
```

容器状态应逐步变为 `healthy`。确保服务器防火墙允许客户端访问 3000 端口；如果该端口已占用，把 Compose 中 `"3000:3000"` 的左侧改成空闲端口，并使用对应端口访问。

数据自动保存在 Docker 卷 **`agent-insight-customer-data`** 中，重建容器会继续使用这些数据。无需手工建目录或执行 `chmod` / `chown`；不要删除此数据卷或使用 `docker compose down -v`。

## 4. 接入 Agent，检查一次调用

1. 在平台进入 **客户端安装**，选择 OpenCode 或 Qoder。客户端需预先能正常使用 Agent，Linux/macOS 的 curl 安装流程要求 Node.js 20 或以上。
2. **按安装页提示先自行备份 Agent 配置**，然后把页面命令复制到 Agent 所在机器执行。安装会改写受支持的模型地址、Hook 和插件配置；当前不自动备份，也不提供自动卸载或回退。
3. 按提示重启 Agent，执行一次简单任务，例如“只回复 hello”。Qoder IDE / JetBrains 还需安装对应采集插件；下载失败时联系交付方，不要安装残留旧包。
4. 用安装时的同一账号打开 **链路追踪**，稍等并刷新，进入 Trace 检查 LLM 调用，再点击 **推理分析** 验证跳转。

模型 API 地址仍使用 Agent 原有配置，经客户端本地转发组件访问推理服务，**不用改成平台的 3000 端口**。客户端需要能访问平台、模型 API 及安装所需的软件包源；离线客户端需另行准备依赖。

推理服务需读取请求头 **`X-Agent-Insight-Call-Id`**，将该 ID 绑定到推理记录，并支持上述分析页面按 ID 查询。每个链接只传一个 ID；Trace 整体入口列出各次模型请求，LLM 节点入口列出该节点对应的请求。详见[推理服务接入说明](../developer-guide/inference-service-integration.md)。

当前 OpenCode 1.x / 2.x 的已适配模型接口、Qoder CN CLI 的自定义 OpenAI-compatible Provider 支持此关联流程。**Qoder 原生 IDE / JetBrains 可接入采集，但模型地址接管尚未完成，不能保证推理分析跳转。** Qoder 部分缺少响应标识的失败请求只能关联整条 Trace。

## 后续操作

修改跳转地址后，再执行一次下面的命令即可生效，不需要重新打镜像，也不需要编辑数据卷里的 `.env`：

```bash
docker compose up -d
```

仅执行 `docker compose restart` 不会应用 Compose 文件中的新环境变量。

暂停和恢复平台：

```bash
docker compose stop
docker compose up -d
```

升级时先备份数据卷，再导入新镜像，使用交付方配套的 Compose 执行 `docker compose up -d`。保留数据卷和同一部署名称，不要同时启动两个实例使用这份数据。
