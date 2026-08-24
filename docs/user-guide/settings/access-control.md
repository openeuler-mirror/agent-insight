---
title: "客户端安装"
description: "生成客户端接入命令并获取当前账号 API Key"
---

# 客户端安装

客户端安装用于生成客户端接入命令、提供当前账号的接入凭证，并明确平台地址与上报路径，是运行数据能否进入 Agent Insight 的关键配置页面。

> **Note**
> Agent 已完成登记、模型已完成注册，但链路追踪仍无数据时，通常应优先检查安装命令、API Key 归属与上报地址配置。

页面不会直接信任浏览器保存的历史登录信息。进入平台后会先向当前服务刷新账号和 API Key，
刷新完成前不生成可复制的一键安装命令；因此服务重建、数据库切换或平台地址变化后，无需先
手工退出登录，但必须重新打开本页并复制一条新命令。

## 功能定位

客户端安装承担四项核心职责：

- 按目标操作系统生成可直接执行的接入命令
- 提供当前账号对应的 API Key
- 展示服务端地址与上报路径等接入参数
- 为链路采集与数据归属提供统一入口
- 选择 OpenCode 时，在 Agent 主机安装普通观测插件与同进程 Agent RAS

## 页面结构

客户端安装页面通常由四个功能区组成：

1. **常驻客户端区（Agent RAS）**
   生成带一次性令牌的安装命令，安装独立常驻客户端服务。
2. **安装命令区**
   按操作系统展示一键接入命令。
3. **凭证与接入信息区**
   展示当前 API Key、账号信息、平台地址与上报路径。
4. **相关文档区**
   提供 API Key、客户端接入与常见问题的辅助说明入口。

### 常驻客户端区（Agent RAS）

与下方的 Trace 采集器安装是两件不同的事：

| | Trace 采集器 | 常驻客户端 |
|---|---|---|
| 作用 | 上报运行数据 | 接收配置下发、执行受控任务 |
| 形态 | 随 Agent 平台运行 | 独立常驻进程 |
| 守护 | 无 | systemd / launchd 自动重启 |
| 凭证 | 账号 API Key | 设备凭证（一机一把，可单独撤销） |
| 支持平台 | 全部 | 仅 Linux 与 macOS |

点击「生成安装命令」后会得到一条带一次性令牌的命令，**令牌 10 分钟内有效且只能使用一次**；过期或已被使用时需重新生成。

> **Note**
> 安装 Trace 采集器（`/api/ingest/setup`）时会**顺带注册常驻客户端**，本机随即出现在「客户端配置」页。
> 该步骤失败只告警不中断 —— Trace 采集照常工作，只是本机暂时无法在配置页管理；
> 届时按下方命令单独安装即可。
> 注册步骤默认安装当前 Insight 服务端随附的客户端版本，不会被执行命令目录中的旧项目副本覆盖；
> 重跑命令会刷新注册与设备凭证，并按机器标识复用原有客户端记录。

安装完成后客户端会：

- 注册为系统服务，崩溃后由操作系统自动拉起，不随 Agent 平台启停
- 主动建立出站 WSS 控制连接（不监听任何入站端口）
- 自动发现本机 IP、Agent 平台、可用模型并上报
- **同时纳管故障注入能力** —— 本机会一并出现在「实验」与「故障注入」页面，
  无需再单独执行 FI Worker 的安装命令

> **Note**
> 该命令默认会一并安装故障注入组件。若本机没有可用的 Python 环境，安装会跳过这一步并给出提示，
> **客户端仍然正常上线**：实验页能看到本机，只是标记「FI 未就绪」并说明原因（如缺 python3）。
> 装好 Python 后重跑同一条命令即可补齐。
>
> 在 Homebrew / Debian 等「受管控 Python」环境下（PEP 668），全局安装会被系统拒绝，
> 安装器会自动改用独立虚拟环境重试，无需手工处理。

客户端只接受固定动作白名单（配置写入、运行实验 Case 等），服务端**不能**下发任意命令、任意文件路径或任意下载地址。

> **Note**
> 未安装 Python 或故障注入组件的主机同样可以正常上线，只是「故障注入能力」显示为不可用，不影响配置下发与观测。

### 安装命令区

安装命令区通常包含：

- **Linux / macOS 命令**：用于 Bash 环境的一键接入
- **Windows PowerShell 命令**：用于 PowerShell 环境的一键接入
- **Langfuse Python SDK 环境变量**：用于已经接入 Langfuse Python SDK 或 LangChain CallbackHandler 的项目
- **复制按钮**：用于复制对应平台命令
- **说明提示区**：说明命令执行后通常需要输入 API Key，并完成后续初始化

### 凭证与接入信息区

凭证与接入信息区通常包含：

- **当前 API Key 面板**：展示当前账号的接入凭证，并提供复制能力
- **接入信息面板**：展示邮箱、平台地址、API Key 状态与上报路径
- **相关文档面板**：提供 API Key、客户端配置和常见问题说明入口

<p align="center">
  <img src="../../images/config/client_config.png" alt="客户端安装页" style="width: 100%; max-width: 1120px; height: auto; border: 1px solid #e5e7eb; border-radius: 12px; background: #ffffff;" />
</p>

该页面的核心目标是完成“命令生成、凭证提供、地址确认、接入执行”这一最短闭环。

## 关键配置项说明

| 配置项 | 说明 |
| --- | --- |
| **安装命令** | 按目标操作系统生成的接入脚本入口，用于初始化客户端配置。 |
| **API Key** | 当前账号的接入凭证，用于绑定上报身份与数据归属。 |
| **平台地址** | Agent Insight 服务端地址，客户端通过该地址上报执行数据。 |
| **上报路径** | 平台接收链路数据的接口路径，用于确认客户端上报目标。 |
| **当前账号** | 当前登录态对应的用户身份，用于确认数据归属是否正确。 |
| **API Key 状态** | 当前凭证的展示状态，用于辅助判断是否需要重新复制或更新。 |
| **Langfuse 环境变量** | 将已有 Langfuse 上报目标重定向到 Agent Insight；`LANGFUSE_PUBLIC_KEY` 填当前 Agent Insight 用户名，`LANGFUSE_SECRET_KEY` 填该用户的 Agent Insight API Key，二者不对应时平台会拒绝上报；`session_id` 继续按 Langfuse 原语义作为跨 trace 会话归组字段。 |

## API Key 归属机制

API Key 决定客户端上报数据的身份归属与接入上下文。错误的 API Key 或错误的登录态通常会导致：

- 数据归属到其他账号
- 当前 Workspace 无法看到对应 Trace
- 客户端执行正常，但平台侧表现为“未接入”或“无数据”

> **Warning**
> 账号或平台地址切换后，应重新打开本页并复制新命令，不要复用浏览器历史、聊天记录或终端历史中的旧命令。
> `/api/ingest/setup` 会在下发脚本前校验命令中的 API Key；Key 不属于当前服务时返回 401，
> `curl -f` / `irm` 不会继续执行安装脚本。

## 操作流程

### 流程一：首次接入客户端

1. 在 [Agent 概览](../agent-management) 中完成目标 Agent 登记。
2. 进入 **客户端安装** 页面。
3. 在安装命令区选择目标操作系统。
4. 复制对应的一键接入命令。
5. 在目标 Agent 所在运行环境执行该命令。
6. 脚本写入当前账号 API Key；选择 OpenCode 时同时安装普通观测插件和 Agent RAS。
7. 触发一次最小执行。
8. 在 [链路追踪](../observability/view-traces) 中确认首条 Trace 是否生成。

接入脚本会绑定生成它的 Agent Insight 服务端版本，不直接跟随 npm `latest`。因此普通
Trace 与 RAS 事件来自同一套客户端组件，并使用同一个账号 API Key。OpenCode 尚未安装时
也可以先执行接入命令；配置和插件会预先落位，之后安装 OpenCode 即可加载。之后重启
Agent Insight 只会同步平台地址；已写入的客户端 API Key 不会被内部 `admin` Key 覆盖。

OpenCode uploader 优先复用 `~/.agent-insight/client/config.json` 中的 `clientId` 和设备凭据，把 Trace 关联到已注册客户端。设备凭据只会发回签发它的协议、域名与端口；切换 Host 时 uploader 只使用当前 API Key，不会把旧平台的设备凭据带到新平台。每次重新执行一键接入都会按本机指纹复用客户端记录并换发设备凭据，因而同一 Host 服务重建后也不会继续沿用数据库中已不存在的旧凭据。服务端同时收到 API Key 与设备凭据时，任一有效即可完成上报；失效的那份不会用于客户端绑定，两份都有效但属于不同账号时仍会返回 403。正式客户端未安装成功时仍可使用兼容 `~/.agent-insight/client.json` 上传 Trace，但该文件中的自报 ID 不建立可信客户端绑定。链路追踪列表提供默认隐藏的 **IP** 列。Agent Insight 直接部署在公网 `IP:3000` 时，带有效 API Key 或设备凭证的 OpenCode uploader 无需额外配置：外部电脑运行 OpenCode，显示这台电脑访问服务端时的公网出口 IP；服务端本机运行 OpenCode 并通过自身公网地址上报，显示该服务端公网 IP。没有有效 API Key 或设备凭证的未认证上传不建立这项可信 IP 绑定，显示 `—`。hostname 和本地网卡 IP 只作为历史排障快照。这里没有新增插件或后台进程。完整部署矩阵、代理配置要求和查看步骤见 [链路追踪](../observability/view-traces) 中的“OpenCode Trace 公网 IP”。

### 流程二：重新部署或迁移客户端

1. 进入 **客户端安装** 页面。
2. 等待当前账号、API Key 与平台地址显示为已就绪。
3. 重新复制当前操作系统对应命令。
4. 在新的运行环境执行初始化命令。
5. 脚本校验当前 API Key，并为本机重新换发该 Host 的设备凭据。
6. 触发一次验证执行并观察链路数据是否恢复。

### 流程三：接入已有 Langfuse Python SDK 项目

适用于项目代码已经使用 Langfuse Python SDK、LangChain CallbackHandler 或兼容的 Langfuse OTLP 上报方式。

1. 进入 **客户端安装** 页面。
2. 复制 **Langfuse Python SDK** 区域中的环境变量。
3. 在目标项目运行环境中设置这些变量。
4. 重新运行一次真实 agent 请求。
5. 在 [链路追踪](../observability/view-traces) 中确认是否出现新的 Trace。

Agent Insight 会按 Langfuse traceId 生成执行记录；Langfuse `session_id` 只是跨 trace 的会话归组字段，不参与生成 Agent Insight 执行 ID。Langfuse 兼容上报会校验 `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`：public key 必须是 Agent Insight 用户名，secret key 必须是该用户的 Agent Insight API Key。

### 流程四：接入 Pi Agent

Pi Agent 采集器以 `@earendil-works/pi-coding-agent` 0.82.1 为最低基线，并接受后续
语义化版本；Node.js 要求 22.19.0 或更高版本，Linux/macOS 还需提供 `unzip`。在运行 Pi
的终端执行：

```bash
export AGENT_INSIGHT_API_KEY="<当前账号 API Key>"
installer="$(mktemp)"
curl --fail --show-error --location --proto '=https' --tlsv1.2 \
  "https://<Agent Insight 地址>/api/ingest/setup/pi-agent" --output "$installer"
sed -n '1,160p' "$installer"  # 先检查下载的脚本内容
sh "$installer"
rm -f "$installer"
```

生产部署请使用受信任证书的 HTTPS 地址；下载完成后先检查脚本内容，再执行。

安装脚本从当前 Agent Insight 服务下载一个包含固定 allowlist 内容的
`pi-agent-bundle.zip`，先与脚本内嵌的 SHA-256 对比，校验通过后才解压并执行安装；旧的
逐文件下载路径仅为已保存的旧脚本保留兼容，新脚本不再使用。该摘要可以发现传输损坏或版本
错配，但不是独立代码签名。安装完成
后文件位于 `~/.agent-insight/collectors/`，并执行 `pi install` 与 self-check。API Key 只写入
权限为 `0600` 的本地 `config.json`，不会出现在资产下载 URL 中；上传前会脱敏 API Key、
常见密钥赋值文本以及本机绝对路径。

手工安装时可直接把 `pi-agent` package 和相邻的 `shared/trace-transport.cjs` 放入
`~/.agent-insight/collectors/`，创建同样的 `config.json`，再执行：

```bash
pi install "$HOME/.agent-insight/collectors/pi-agent"
node "$HOME/.agent-insight/collectors/pi-agent/scripts/self-check.cjs"
```

普通卸载保留本地 spool。`--purge` 只删除当前 API Key 对应的 Pi spool；删除所有 Pi
spool 必须显式追加 `--purge-all --yes`：

```bash
node "$HOME/.agent-insight/collectors/pi-agent/scripts/uninstall.cjs"
```

### 流程五：排查“无数据上报”

1. 回到客户端安装页确认当前账号、API Key 与平台地址。
2. 确认执行命令的机器就是目标 Agent 实际运行环境。
3. 确认客户端已完成至少一次真实执行。
4. 确认服务端地址与上报路径可达。
5. 进入链路追踪确认是否已有新 Trace 写入。

### 流程五：接入 Codex CLI 与 VS Code-family 编辑器

1. 确认目标机器安装了兼容的 Codex CLI、Node.js 20 或更高版本。
2. 以当前 Agent Insight API Key 和服务端地址运行 Codex setup 命令。
3. 启动 Codex，运行 `/hooks`，逐项核对 Agent Insight handler 的绝对路径并选择
   Trust。安装器不会代替 Codex 写入信任状态。
4. 退出并重新启动 Codex，运行
   `node ~/.agent-insight/collectors/codex/self-check.cjs`。
5. 对 IDE 场景，确认 `openeuler.agent-insight-codex-trace` 已通过 VSIX 安装到 VS Code、
   Cursor 或 Windsurf。
6. 触发一次最小 Codex 任务，在链路追踪中确认 Agent、Tool 和 LLM 节点。

Codex setup 不把 API Key写入 Hook command。凭据和 relay install secret 只保存在权限受限的
collector config 中。若 `config.toml` 已配置非空 `[otel]` exporter，setup 会保留原配置并
报告 `otel_conflict`；在明确选择 exporter 策略前，原生 Token/TTFT 数据不会进入 relay。
安装载荷由 Agent Insight 服务端以单个 ZIP 提供；安装脚本会在解压和执行前核对内嵌的
SHA-256。摘要不匹配时安装立即停止，不会运行包内的 `install.cjs`。

编辑器 Settings 中的 `cloudAgentId` 是用户手工关联值，事件会标记 `source=user`。只有
Codex 原生 OTel 真正提供 `auth.agent_id` 或 `auth.task_id` 时，平台才把它计为自动 Cloud
关联证据。

## 维护建议

### 环境隔离

开发、测试、生产环境建议分别完成独立接入，并为 Agent 使用清晰的环境命名，避免接入配置混用。

### 凭证复核

涉及账号切换、客户端重装、环境迁移时，建议重新复制 API Key，而不是复用历史命令或旧凭证。

### 接入验证最小闭环

每次接入完成后，建议立即执行一次最小请求，并在链路追踪中确认首条 Trace 是否成功生成，以缩短排障路径。

## 常见异常

### 命令执行成功，但平台中没有 Trace

常见原因包括：

- 执行环境不是目标 Agent 的实际运行环境
- API Key 错误、过期或归属错误
- 平台地址不可达
- 客户端尚未产生真实执行
- 上报路径配置异常

### 页面中的 API Key 与预期不一致

页面会在恢复历史登录态时从当前服务刷新 API Key。若刷新后仍与预期不一致，说明当前平台地址、
账号或服务端数据库不是预期环境；请先确认浏览器地址和页面账号，不要通过反复退出登录掩盖环境错配。

## 下一步

- 完成 Agent 资产登记： [Agent 概览](../agent-management)
- 验证链路是否成功上报： [链路追踪](../observability/view-traces)
- 继续完成整体接入流程： [5 分钟上手](../quickstart)
- 配置后续模型能力： [模型注册](./model-registry)
