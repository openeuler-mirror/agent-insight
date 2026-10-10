# Agent FI：本机安装过程详解

> **读者**：需要理解「执行 FI setup curl 后，用户机器上发生了什么」的使用者与排障者。  
> **范围**：本机 **FI Client / Worker** 的安装、落盘与常驻进程；不含故障 Skill 内容与服务端 Judge 算法。  
> **真源**：[`src/app/api/fault-injection/setup/route.ts`](../../../src/app/api/fault-injection/setup/route.ts)、[`scripts/install-fault-injection.js`](../../../scripts/install-fault-injection.js)、[`scripts/fi-worker.js`](../../../scripts/fi-worker.js)。  
> **产品操作**：[user-guide/observability/fault-injection.md](../../user-guide/observability/fault-injection.md)。

---

## 1. 一句话

FI 安装命令在用户本机启用 **FI Client**：把 Python 包 `agent_fault_injection` 装好、写好 Worker 配置，并（默认）**后台常驻** `fi-worker`。Worker 向远程 Insight **心跳 / claim / 回传 collect-result**；真正注入由本机 CLI 驱动 OpenCode / xiaoO。**服务端**负责任务编排与 Judge，不在用户机跑注入算法。

旧 Worker 启动时优先读取正式客户端 `~/.agent-insight/client/config.json`，未安装正式客户端时才读取或创建 `~/.agent-insight/client.json`，并在心跳中携带稳定 `clientId`。它与 OpenCode uploader 共用身份优先级；`workerId` 仍只标识 Worker 实例。该变化不新增安装项或进程。

```mermaid
flowchart TB
  subgraph remote ["Insight 服务端（可远程）"]
    UI["故障注入 UI<br/>/agent-ras/fault-injection/*"]
    SetupAPI["GET /api/fault-injection/setup?key=…"]
    FIAPI["/api/fault-injection/*<br/>heartbeat · claim · collect-result"]
    DB[(Prisma)]
    Judge["服务端 Judge"]
  end
  subgraph userHost ["用户本机 · 与被测 Agent 同机"]
    Curl["curl …/setup \| bash"]
    Installer["install-fault-injection.js --start"]
    Pip["managed venv<br/>venv/bin/python -m pip install"]
    Cfg["~/.agent-insight/fault-injection/"]
    Worker["fi-worker.js<br/>· 后台 daemon"]
    CLI["managed venv python<br/>-I -m agent_fault_injection.cli"]
    Agents["opencode / xiaoo"]
  end
  UI -->|"无 Worker 时展示安装命令"| Curl
  Curl --> SetupAPI
  SetupAPI -->|"返回 bash"| Curl
  Curl --> Installer
  Installer --> Pip
  Installer --> Cfg
  Installer --> Worker
  Worker -->|"heartbeat / claim"| FIAPI
  Worker --> CLI --> Agents
  Worker -->|"collect-result"| FIAPI
  FIAPI --> DB --> Judge
```

---

## 2. 入口命令对照

| 入口 | 典型命令 | 何时用 |
|------|----------|--------|
| **新建任务页提示** | 页面生成的 `curl -fsSL "$HOST/api/fault-injection/setup?key=$API_KEY" \| bash` | 无在线 Worker；**以页面命令为准** |
| **手动等价** | 同上，自行替换 `$HOST` / `$API_KEY` | 脚本化部署 |
| **仓内 / 已有 npm 包** | `npx agent-insight install-fault-injection --start` | 开发机或已装 CLI |
| **仅检查** | `npx agent-insight install-fault-injection --check` | 不启 Worker，校验包与 apiKey |
| **前台排障** | `… --start --foreground` 或 env `AGENT_INSIGHT_FI_WORKER_FOREGROUND=1` | 日志打在终端 |

与 RAS / 观测安装指导的区别：

| | FI setup（本文） | 看板 `/api/setup` |
|--|------------------|-------------------|
| URL | `/api/fault-injection/setup` | `/api/ingest/setup`（rewrite `/api/setup`） |
| 目标 | FI Worker 常驻 | 观测插件 +（条件）RAS |
| 是否交互勾选框架 | 否 | 是 |
| 是否依赖 RAS | **否** | RAS 为可选附加 |

---

## 3. 本机前置条件清单

| 项 | 要求 | 不满足时 |
|----|------|----------|
| Node.js | 可执行 `node`（Worker 与安装器） | setup 脚本直接 exit |
| Python 3 | Python 3.11+ 在 PATH，且标准库支持 `venv` | FI 安装跳过/失败；常驻客户端仍可上线 |
| pip | 只要求新建 venv 内自带 pip；不读取或写入系统 `site-packages` | FI managed runtime 安装中断 |
| 网络 | 本机能访问 Insight `$HOST`（HTTP）；若走 `npx` 还需访问 npm | npx / 心跳失败 |
| API Key | **当前登录账号**的 Key（Worker 按用户隔离） | 心跳无人认领 / 页面仍显示无 Worker |
| 被测平台 | 本机已装 **OpenCode** 和/或 **xiaoO**（与 Worker **同机**） | inventory 空，向导无法选平台/模型 |
| 写权限 | `~/.agent-insight/fault-injection/` | 无法写 config / pid / log |

**安装面选择（重要）**

| 场景 | 怎么装 | `packageRoot` |
|------|--------|----------------|
| **日常使用** | `curl …/api/fault-injection/setup?key=… \| bash`，或空目录 `npx agent-insight install-fault-injection --start` | 复制到 `~/.agent-insight/fault-injection/runtimes/<id>/package`，安装到同目录 `venv`，与 checkout 解耦 |
| **只开发 FI 引擎** | 在仓根跑 `node scripts/install-fault-injection.js --start` | 仍使用 managed venv，但以 `-e` 绑定当前 checkout（搬迁/清空工作树后需重装） |

常用环境变量：

| 变量 | 作用 |
|------|------|
| `AGENT_INSIGHT_HOST` | Insight 基址（写入 config，Worker 请求用） |
| `AGENT_INSIGHT_API_KEY` | Worker 鉴权头 |
| `AGENT_INSIGHT_FI_WORKER_ID` | 可选覆盖 workerId |
| `AGENT_INSIGHT_FI_PACKAGE_ROOT` | 可选覆盖 packageRoot（install 启动 Worker 时会写入） |
| `AGENT_INSIGHT_FI_WORKER_FOREGROUND=1` | 前台跑 Worker |
| `AGENT_FI_BOOTSTRAP_PYTHON` / `PYTHON` | 选择创建 managed venv 的 Python 3.11+；不会作为 pip 安装目标 |
| `AGENT_FI_PYTHON` | 高级运行时覆盖；正常安装由 `config.json.python` 固化 managed venv 绝对路径 |

---

## 4. curl 端到端时序

```mermaid
sequenceDiagram
  participant U as 用户终端
  participant S as Insight setup API
  participant N as npx / 本地仓
  participant I as install-fault-injection.js
  participant W as fi-worker.js
  participant A as Insight FI API

  U->>S: GET /api/fault-injection/setup?key=…
  S-->>U: text/x-shellscript（内嵌 HOST、KEY）
  U->>U: 检查 node
  U->>U: export AGENT_INSIGHT_HOST / API_KEY
  alt cwd 是含 scripts/ 与 agent_fault_injection/ 的仓
    U->>I: node ./scripts/install-fault-injection.js --start
  else 普通机器
    U->>N: mktemp + cd tmp && npx --yes agent-insight install-fault-injection --start
  end
  I->>I: resolveBootstrapPython（仅校验 3.11+ / venv）
  I->>I: 计算 package + Python 指纹，创建 runtimes/id/venv
  I->>I: 仅用 venv/bin/python -m pip install
  I->>I: python -I 验证后 writeConfig（python/runtimeRoot/packageRoot）
  I->>W: spawn detached fi-worker.js
  W->>A: heartbeat（inventory）
  Note over U: 打印 pid / 日志路径后可关终端
  U->>U: 刷新新建任务页 → Worker 在线
```

---

## 5. setup 路由返回的 bash 逐步说明

实现：[`src/app/api/fault-injection/setup/route.ts`](../../../src/app/api/fault-injection/setup/route.ts)。

| 步 | 脚本行为 | 说明 |
|----|----------|------|
| 1 | `set -euo pipefail` | 任一步失败即退出 |
| 2 | 打印 `host=$HOST` | HOST 来自请求的 `protocol://host` |
| 3 | 检查 `node` | 缺则 stderr 报错退出；Python 由 managed runtime 安装器按版本与 `venv` 能力探测 |
| 4 | `export AGENT_INSIGHT_HOST` / `AGENT_INSIGHT_API_KEY` | KEY 来自 query `key` |
| 5a | 若 `./scripts/install-fault-injection.js` 且 `./agent_fault_injection` 存在 | **本地仓路径**（开发常见） |
| 5b | 否则 | `mktemp` 空目录 + `npx --yes agent-insight install-fault-injection --start`（避免在包内 cwd 触发错误的 `file:` 解析，尤其 WSL `/mnt/*`） |
| 6 | 提示后台已跑、可关终端；换 Key 会重启 Worker | 同 Key/host 再跑则保留进程 |

缺少 `key` 时 API 直接 **400**，不会返回可执行脚本。

---

## 6. `install-fault-injection.js` 逐步说明

实现：[`scripts/install-fault-injection.js`](../../../scripts/install-fault-injection.js)。

```mermaid
flowchart TD
  A[run] --> B[ensureDirs]
  B --> C[resolve bootstrap Python]
  C --> D[创建版本化 managed venv]
  D -->|仓内开发| E[venv pip install -e checkout]
  D -->|日常/npx| F[复制 package + venv pip install]
  E --> G[python -I 验证]
  F --> G
  G --> H[writeConfig]
  H --> I{--start?}
  I -->|否| J[打印手动启动提示]
  I -->|是| K[startWorkerDaemon]
  K --> L{已有存活 pid?}
  L -->|凭证与 runtime 相同| M[复用进程]
  L -->|变更或不可读| N[停旧进程]
  N --> O[detached spawn fi-worker.js]
  O --> P[写 worker.pid · 追加 worker.log]
  P --> Q[2.5s 后确认仍存活]
```

> `--check` 只读检查 config/`packageRoot`/import/apiKey，不改安装态。

### 6.1 目录

一律在：

```text
~/.agent-insight/fault-injection/
├── config.json
├── current.json        # 当前 managed runtime 清单
├── runtimes/<id>/
│   ├── install.json
│   ├── package/        # 日常安装的固化源码
│   └── venv/           # FI 唯一 Python 运行环境
├── worker.pid          # --start 后
├── worker.log
├── artifacts/          # Run 本机产物
└── workspaces/         # 隔离 workspace 基目录
```

### 6.2 `config.json` 字段

| 字段 | 含义 | 来源 |
|------|------|------|
| `insightBaseUrl` | Insight 根 URL（无尾 `/`） | `AGENT_INSIGHT_HOST` 或保留旧值，默认 `http://127.0.0.1:3000` |
| `apiKey` | Worker 鉴权 | `AGENT_INSIGHT_API_KEY` 或保留旧值 |
| `workerId` | 稳定 Worker 标识 | 首次生成 `fi-worker-<hostname>-<hex>`，之后保留 |
| `maxParallel` | 并行 Run 上限 | 默认 5 |
| `pollIntervalMs` | 轮询间隔 | 默认 2000 |
| `artifactsDir` | 产物目录 | 默认 `…/artifacts` |
| `workspaceBase` | workspace 基路径 | 默认 `…/workspaces` |
| `packageRoot` | `agent_fault_injection` 安装源 | 日常为 `runtimes/<id>/package`；开发模式为 checkout |
| `python` | FI CLI 解释器 | `runtimes/<id>/venv/bin/python` 的绝对路径 |
| `runtimeRoot` / `runtimeMode` | managed runtime 元数据 | 版本化目录；当前模式固定为 `managed-venv` |

### 6.3 Python 包解析顺序

`resolvePackageRoot()`：

1. `cwd/agent_fault_injection`（含 `pyproject.toml` 或 `setup.py`）  
2. 否则 `scripts/../agent_fault_injection`（npm 包或仓内布局）  

安装器不会要求系统 Python 能 import FI 包。它创建版本化 managed venv，并以
`<venv>/bin/python -I` 验证包只能从该隔离环境导入；失败时应重跑 setup，不要手工执行全局 pip。

### 6.4 Worker 进程生命周期

- **日志**：`~/.agent-insight/fault-injection/worker.log`（追加）  
- **PID 文件**：`worker.pid`  
- **凭证变更检测**（Linux/WSL）：读 `/proc/<pid>/environ` 中的 `AGENT_INSIGHT_API_KEY` / `AGENT_INSIGHT_HOST`；与目标不一致则重启  
- **停止**：`kill $(cat ~/.agent-insight/fault-injection/worker.pid)`  
- **前台**：`--foreground` 时 stdio 继承当前终端，不写 detached  

---

## 7. Worker 跑起来之后（安装后的稳态）

`fi-worker.js` 不在「安装」脚本里展开全部业务，但理解安装结果需要知道它做什么：

```mermaid
flowchart LR
  HB[heartbeat + inventory] --> Claim[claim queued runs]
  Claim --> Run["spawn CLI<br/>fiPython -I -m agent_fault_injection.cli"]
  Run --> Collect[collect-result 上传]
  Collect --> HB
```

- **inventory**：Worker 启动时用配置中的 managed `fiPython` 跑 `-I -m agent_fault_injection.cli platform inventory --json`，把本机真实 agents/models 经 heartbeat 上报。无 Worker 时 Insight health/platforms 只返回安装引导，**不**静默填假目录。
- **claim**：领取 `queued` 任务，在隔离 workspace 注入并采集。
- **collect-result**：回传 markers / `faultActivated` / Trace ID，由 **Insight 服务端 Judge** 评判（本机不再跑产品 Judge）。**不**写 `Session.interactions`，**不**合成 `RasAnomalyEvent`。
- **不**启动 RAS；若宿主已挂 RAS，那是安装指导 / `install-ras` 的结果，与 FI 任务解耦。

本机排障产物（权威仍在 Prisma）：

```text
~/.agent-insight/fault-injection/artifacts/<runId>/
```

禁止把仓库根当作 `workspaceBase`。

---

## 8. 数据从哪里来

| 数据 / 产物 | 来源 |
|-------------|------|
| setup 脚本 | Insight 动态生成（内嵌当前请求的 Host + Key） |
| `install-fault-injection.js` / `fi-worker.js` | **本地仓** 或 **`npx agent-insight`** 包内 `scripts/` |
| `agent_fault_injection` Python 树 | 同上包内目录；日常复制到版本化 runtime，开发模式 editable 安装到 managed venv |
| 故障 Skill / catalog | Python 包内 `fault_inject/skills/` 等（随包） |
| API Key / Host | setup query → env → `config.json` |
| Agent / Model 列表 | Worker 启动后对本机平台做 inventory，经 heartbeat 上报 Insight |
| Judge 结论 | **仅服务端**；不从本机上传包直读为权威 |

```mermaid
flowchart LR
  subgraph sources ["数据来源"]
    InsightSetup["Insight setup HTTP"]
    NpmOrRepo["npx agent-insight 或本地 clone"]
    ManagedPip["FI managed venv pip"]
    LocalAgents["本机 opencode/xiaoo"]
  end
  subgraph sinks ["本机落盘 / 进程"]
    FiDir["~/.agent-insight/fault-injection/"]
    Worker["fi-worker 常驻"]
  end
  InsightSetup --> FiDir
  NpmOrRepo --> FiDir
  ManagedPip --> FiDir
  FiDir --> Worker
  LocalAgents -->|"inventory"| Worker
```

---

## 9. 验收与排障

### 验收

```bash
# 安装检查
npx agent-insight install-fault-injection --check

# 进程与日志
cat ~/.agent-insight/fault-injection/worker.pid
ps -p "$(cat ~/.agent-insight/fault-injection/worker.pid)" -o pid,cmd
tail -n 50 ~/.agent-insight/fault-injection/worker.log

# UI：打开 /agent-ras/fault-injection/tasks/new ，平台应可选
```

### 常见失败

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| setup 400 | 未带 `key=` | 使用当前账号 API Key |
| `Node.js is required` / `python3 is required` | PATH 缺工具 | 安装 Node 20+、Python3 |
| `npx install failed` | 网络或 registry；或在错误 cwd | 检查 npm；或在仓根用本地 installer 分支 |
| Worker 启动后立即退出 | Key/Host 错、依赖缺；或 `packageRoot` 失效 | 看 `worker.log` 尾部；`--foreground` 复现；重跑 setup |
| `managed FI Python is not configured` / `packageRoot missing` | 旧配置未迁移、managed runtime 被移动，或开发 checkout 已迁移 | 查 `config.json` 与 `current.json`；用 **curl setup / 空目录 npx** 重装，不要手工向系统 Python 安装 |
| `externally-managed-environment` | 运行了旧安装器或手工对系统 Python 执行 pip；新安装器不会走该路径 | 确认服务端下发最新 client bundle 后重跑 setup；不要使用 `--break-system-packages` |
| 页面仍无 Worker | Key 属于别的用户；防火墙挡心跳；Worker 未起 | 确认 Key；本机 curl Insight；查 pid |
| 有 Worker 但平台空 | 本机未装 OpenCode/xiaoO 或不在 PATH | 同机安装并保证 inventory 能枚举 |
| OpenCode `plugin-ready` 超时 | 评测 workspace 缺插件 / `lib/` / `.opencode/package.json` | Adapter 会拷齐；布局见 [OpenCode 适配 §4.2](../designs/modules/opencode-platform-adaptation.md)（`rewrite-*.ts` 在 **`lib/`**，不要放进 `plugins/`） |
| 换账号后任务不对人 | 旧 Worker 仍用旧 Key | 用新 Key 重跑 setup（应自动重启） |
| 搬迁 git 工作树后 run 全失败 | 曾用仓内 `-e` 安装，editable / packageRoot 仍指旧路径 | 重跑 setup（稳定副本）或在新仓根重装 |

---

## 10. 与 RAS / 观测的边界（安装面）

| | FI（本文） | RAS | 观测采集 |
|--|-----------|-----|----------|
| curl | `/api/fault-injection/setup` | 多经 `/api/setup` 条件触发，或 `install-ras` | `/api/setup` |
| 常驻进程 | **是**（fi-worker） | 否（inproc） | 视框架（uploader/watcher） |
| 装 RAS？ | 否 | 是 | 否（可同一次脚本顺带） |
| 文档 | 本文 | [RAS 本机安装过程](../../agent-ras/guides/local-install-process.md) | developer-guide / user-guide 各平台页 |

完整链路 ⓪ 与 FI 解耦：日常 Trace **不是** FI collect。

| 平台 | 日常 ⓪ | FI 怎么挂上（不冲掉观测 / RAS） |
|------|---------|--------------------------------|
| OpenCode | Insight 观测插件 upload（系统侧） | 只写评测 workspace `.opencode/plugins/` + `lib/`；宿主按系统 + workspace **分层叠加**，不必改 `~/.config/opencode` |
| xiaoO | `node scripts/xiaoo-trace-collector/install.js`（`install-ras` 装 hooker 后也会自动调用） | 临时 `XIAOO_CONFIG` **保留**用户 `[hooker].plugins`（含 RAS + collector）再 append FI；见 [xiaoO 适配 §4.1](../designs/modules/xiaoo-platform-adaptation.md) |

建议顺序：先装观测 +（可选）RAS，再单独 curl FI setup。`/agent-ras/trace` 以 Execution / 真 RAS 为准，FI **不再**为注入激活合成 `RasAnomalyEvent`。

---

## 11. 源码与延伸阅读

| 文件 | 说明 |
|------|------|
| [`src/app/api/fault-injection/setup/route.ts`](../../../src/app/api/fault-injection/setup/route.ts) | curl 安装脚本 |
| [`scripts/install-fault-injection.js`](../../../scripts/install-fault-injection.js) | 目录、config、managed venv 安装、启停 Worker |
| [`scripts/fi-worker.js`](../../../scripts/fi-worker.js) | 心跳 / claim / CLI / collect |
| [`bin/cli.js`](../../../bin/cli.js) | `install-fault-injection` / `fi-worker` 子命令 |
| [getting-started.md](getting-started.md) | 最短启用 |
| [user-guide · 故障注入](../../user-guide/observability/fault-injection.md) | 向导、停止、冒烟与本地 CLI |
