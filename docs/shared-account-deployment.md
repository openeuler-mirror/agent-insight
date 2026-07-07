# Agent-insight 共享账户接入说明

> 面向：把 Agent-insight 部署给一个团队共用的运维/接入方。
> 目标：一批用户各自在自己电脑上用 opencode，数据**统一上报到一个公共账户**——用户侧**零配置、无需 API key**，只在 opencode 安装脚本里加一行命令即可。
> 适用版本：包含「无 key 默认归属 + 免交互安装」的镜像（最新 master 构建）。

---

## 一、整体三步

1. **运维**：部署平台服务（容器）+ 配置公共账户名。
2. **运维**：在你们的 opencode 部署脚本里加一行免交互安装命令。
3. **用户**：跑一次 opencode 部署脚本 → 之后 opencode 数据自动进公共账户；查看时用公共账户名登录平台。

---

## 二、第一步：部署平台 + 配公共账户（运维）

### 2.1 关键环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `AGENT_INSIGHT_DEFAULT_INGEST_USER` | ✅ | 公共账户名。**没带 key 的上报统一归到它。** 用普通邮箱式字符串，如 `team-shared@yourcorp.com` |

> ⚠️ **别用 `admin` / `anonymous`**——它们是平台内部服务占位账号，有归属重挪逻辑，真实数据放进去会被搬走。
> 账户**不用预建**，第一次有人用它登录平台时会自动创建。

### 2.2 容器启动（示例，以你们镜像实际编排为准）

```bash
docker run -d \
  -e AGENT_INSIGHT_DEFAULT_INGEST_USER=team-shared@yourcorp.com \
  -p 3000:3000 \
  -v /data/agent-insight:<平台数据目录，含 DB 与 spool> \
  <你们的镜像>
```

- **端口**：默认 3000（以镜像暴露为准），用户上报和访问都用这个地址。
- **数据持久化**：默认 SQLite，**必须挂持久卷**，否则容器重启数据全丢（用 OpenGauss 则按镜像文档配 `DB_HOST` 等）。
- **改 env 要重启容器**才生效。

### 2.3 安全（重要）

无 key = **任何能连到这个地址的人都能往公共账户写数据**（这是"免配置"的代价）。
👉 **务必内网 / 网关后部署，不要把这个地址直接暴露到公网。**

---

## 三、第二步：opencode 安装脚本加一行（运维）

在你们的 opencode 部署脚本末尾加一行（按用户系统选，或都放）：

```bash
# macOS / Linux
curl -sSf "http://<平台地址>:3000/api/ingest/setup?yes=1&nokey=1" | bash
```

```powershell
# Windows (PowerShell)
iex (irm "http://<平台地址>:3000/api/ingest/setup?yes=1&nokey=1")
```

`<平台地址>` 换成第一步部署的实际 IP/域名。

**参数含义**

- `yes=1`：**全程免交互**（不弹"选框架 / 输 key / 确认地址"），默认只装 opencode 组件。
- `nokey=1`：**强制无 key**（并清掉本机可能残留的旧 key），数据归到公共账户。

**客户端前置依赖**：运行安装命令的机器需 **Node.js ≥ 20、opencode、curl**（Windows 用内置 `irm`）——你们的 opencode 部署脚本里应已装好前两个。

---

## 四、第三步：用户使用 + 查看

- **用户（零配置）**：装完正常用即可：

  ```bash
  opencode run "帮我分析下这个项目"
  ```

  数据会在会话结束 / 空闲时自动上报到公共账户。

- **查看**：浏览器打开 `http://<平台地址>:3000`，用**公共账户名**（如 `team-shared@yourcorp.com`）登录 →「链路追踪」就能看到所有人上报的执行记录。

---

## 五、部署验收（smoke test）

```bash
# 1) 服务端：无 key 直发应返回 200（400 = 镜像不是最新 / 没配 env）
curl -sS -X POST "http://<平台地址>:3000/api/ingest/upload" \
  -H 'content-type: application/json' \
  -d '{"task_id":"smoke-1","framework":"opencode","query":"部署验收"}' -w '\n%{http_code}\n'

# 2) 客户端：装 + 跑一个任务（Windows 用 iex (irm ...)）
curl -sSf "http://<平台地址>:3000/api/ingest/setup?yes=1&nokey=1" | bash
opencode run "hello"

# 3) 浏览器用公共账户名登录 →「链路追踪」应看到上面两条
```

---

## 六、注意事项 / 已知限制

1. **只上报"安装之后"的数据**：装 / 重装那一刻起产生的 opencode 会话才会上传，**安装之前的历史不补传**（这是切账号防串的机制）。
2. **无 key = 开放写入**：见 2.3，务必内网部署。
3. **单账户规模**：所有人的数据都堆在一个账户里，量很大（几万~十万+ 条）后列表页会变慢，建议定期归档（读路径优化在规划中）。
4. **无法按人区分归属**：共享账户下数据混在一起（这正是"共享账户"的语义）。若个别人需要独立账户，给他单独配 key 装即可（用带 key 的安装方式）。

---

## 七、排障（看不到数据时按顺序查）

| 现象 | 排查 |
|---|---|
| 验收①返回 **400** | 镜像非最新 master 构建 / 没配 `AGENT_INSIGHT_DEFAULT_INGEST_USER` → 重建镜像 + 配 env + 重启 |
| 上报 **401** | 客户端带了一个无效 key。检查 `~/.agent-insight/.env` 的 `AGENT_INSIGHT_API_KEY` 是否残留；用 `nokey=1` 重装可清掉 |
| 200 但登录看不到 | 登录用的账号名与 `AGENT_INSIGHT_DEFAULT_INGEST_USER` 不一致（注意大小写）；或数据在"安装时间门"之前被跳过（跑个新任务） |
| 客户端没上传 | 看 `~/.agent-insight/logs/opencode_uploader.log`：`main.skip missingConfig` 说明缺 host；正常应有 `postJson.response status=200` |
| Windows 装完卡住（安装阶段） | 确认用的是 `iex (irm "...?yes=1&nokey=1")`，且镜像含 PowerShell 非交互（最新 master 构建） |
| **opencode desktop 打不开 / 一直"本地连接中"** | **离线/内网**特有，是 opencode 自身 bug（强装联网依赖超时）。见下方「八、离线/内网修复」，跑一次 `opencode-offline-fix.ps1` 即可 |

---

## 八、离线 / 内网：opencode desktop 打不开（"本地连接中"）

**现象**：离线或内网机器上，opencode desktop 装了插件后打不开、卡在"本地连接中"，大部分时间连不上本地服务（偶尔能开）。

**原因**（opencode 自身已知 bug，非本平台）：opencode 启动时会 `bun add --force` 安装一个 npm 上根本不存在的 `@opencode-ai/plugin@local`。联网机器能秒拿到"无此版本"的应答、放行；但**离线/内网**（bun 走不了系统代理）连不上 registry → 每次卡在 ~60s 网络超时并反复重试 → 本地服务起不来。

**解法**：下发一个独立的修复脚本，把 bun 的 registry 请求改成"**秒失败**"（复刻联网时"秒放行"的效果），opencode 即可正常启动、插件照常上报。

```powershell
# 1) 从平台下载（注意：脚本带参数，不能 irm | iex，要下成文件再跑）
irm "http://<平台地址>:3000/api/setup/opencode-offline-fix" -OutFile opencode-offline-fix.ps1

# 2) 运行（自动检测能否直连 npm，够不到才应用）
powershell -ExecutionPolicy Bypass -File .\opencode-offline-fix.ps1

# 3) 彻底退出并重开 opencode desktop
```

**要点**

- **自动检测**：脚本先直连测 `registry.npmjs.org:443`；能直连说明不会卡，会自动跳过、不改动。
- **可恢复**：`powershell -ExecutionPolicy Bypass -File .\opencode-offline-fix.ps1 -Restore` 一键还原（应用前会备份原 `~/.npmrc`）。
- **内网有 npm 镜像**：加 `-Registry "http://你的镜像/"`，用镜像替代默认死地址，这样该机**真包仍可正常安装**。
- **强制应用**：透明代理等极端情况检测可能误判，可加 `-Force`。
- **影响**：默认会把该机 npm registry 指到一个"死地址"，让联网装包立即失败——离线机本来就装不了，无实际损失；若该机还要正常用 npm，请用 `-Registry` 指到内网镜像。
