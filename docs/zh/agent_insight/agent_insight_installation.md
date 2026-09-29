# 安装与维护

本文介绍在 openEuler 上通过 RPM 安装 Agent Insight，并使用 systemd 启动和管理服务。平台默认使用 SQLite 保存数据。

## 前提条件

- 已准备 x86_64 或 aarch64 架构的 openEuler 主机，并具有 sudo 权限。
- 已配置提供 `agent-insight` 及其依赖的软件源，或已取得适用于当前系统版本和 CPU 架构的 RPM 安装包。
- 依赖软件源可用。RPM 依赖包括 Node.js 20 或以上版本、OpenCode 1.14.39 或以上版本以及 OpenSSL 3，由 `dnf` 检查并安装；离线环境需预先准备这些依赖的 RPM 包或本地软件源。
- 服务端口可用，默认端口为 `3000`。远程访问时，客户端到服务器的访问路径应允许该端口。
- `/var/lib/agent-insight` 所在磁盘有足够空间保存 Trace、评测数据和备份。

AcTrail 和需要观测的业务 Agent 由用户在任务运行环境中准备。安装 Agent Insight RPM 不会完成这些客户端的部署与数据接入；服务启动后按[接入 Agent](./agent_insight_connection.md)配置。

## 安装 RPM

### 从软件源安装

先查看系统、架构和当前软件源提供的软件包：

```bash
cat /etc/openEuler-release
uname -m
dnf info agent-insight
```

确认可用包适配当前系统后，执行安装：

```bash
sudo dnf install agent-insight
rpm -q agent-insight
```

如果 `dnf info agent-insight` 未找到软件包，先向软件源提供方确认是否已提供该包，或使用下面的本地 RPM 安装方式。

### 从本地 RPM 安装

取得匹配系统版本和 CPU 架构的 RPM 后，在安装包所在目录执行以下命令，将文件名替换为实际包名：

```bash
sudo dnf install './agent-insight-<版本及发行号>.<架构>.rpm'
rpm -q agent-insight
```

`dnf` 同样需要从已配置的软件源解析并安装依赖。安装完成后即可启动服务。

## 启动和验证

安装完成后，启用开机启动并立即启动服务：

```bash
sudo systemctl enable --now agent-insight.service
sudo systemctl status agent-insight.service --no-pager
sudo journalctl -u agent-insight.service -n 100 --no-pager
```

首次启动会初始化数据库；后续启动会检查并同步数据结构。确认服务状态为 `active (running)` 后，检查 HTTP 访问：

```bash
curl -fsS -o /dev/null http://127.0.0.1:3000/
```

在浏览器打开 `http://<服务器地址>:3000/trace`，完成登录并确认可以打开 **链路追踪**。继续按[快速上手](./agent_insight_quickstart.md)配置模型和接入数据。

## 服务配置与文件位置

RPM 创建 `agent-insight` 系统用户和用户组，服务以该用户运行。默认文件位置如下：

| 内容 | 位置或查看方式 |
| --- | --- |
| 服务配置 | `/etc/agent-insight/agent-insight.env` |
| 数据根目录及服务用户 HOME | `/var/lib/agent-insight` |
| SQLite 数据库 | `/var/lib/agent-insight/data/witty_insight.db` |
| 服务端程序 | `/usr/lib/agent-insight` |
| systemd 服务单元 | `/usr/lib/systemd/system/agent-insight.service` |
| 服务日志 | `journalctl -u agent-insight.service` |

使用以下命令编辑配置：

```bash
sudoedit /etc/agent-insight/agent-insight.env
```

常用配置项如下：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `HOSTNAME` | `0.0.0.0` | 服务监听地址。 |
| `PORT` | `3000` | HTTP 服务端口。 |
| `AGENT_INSIGHT_DATA_DIR` | `/var/lib/agent-insight` | 数据根目录，数据库默认保存在其中的 `data` 子目录。 |
| `DATABASE_URL` | `file:/var/lib/agent-insight/data/witty_insight.db` | SQLite 数据库路径。 |

例如，将 `PORT=3000` 改为 `PORT=3033`，保存后执行：

```bash
sudo systemctl restart agent-insight.service
sudo systemctl status agent-insight.service --no-pager
curl -fsS -o /dev/null http://127.0.0.1:3033/
```

随后通过 3033 端口访问页面，已接入客户端也需更新平台地址。修改此配置文件后重启服务即可，无需修改服务单元。

建议保留默认数据目录。更换数据目录需要同时迁移数据、调整目录权限和数据库路径，并修改 systemd 的可写目录配置，仅修改一个环境变量不足以完成迁移。

## 日常管理

按需执行以下命令：

| 操作 | 命令 |
| --- | --- |
| 查看状态 | `sudo systemctl status agent-insight.service --no-pager` |
| 启动 | `sudo systemctl start agent-insight.service` |
| 停止 | `sudo systemctl stop agent-insight.service` |
| 重启 | `sudo systemctl restart agent-insight.service` |
| 查看最近日志 | `sudo journalctl -u agent-insight.service -n 200 --no-pager` |
| 持续查看日志 | `sudo journalctl -u agent-insight.service -f` |
| 取消开机启动 | `sudo systemctl disable agent-insight.service` |

## 备份与升级

### 备份

备份前停止服务，完整保存配置和数据根目录，避免只复制运行中的数据库主文件而遗漏 WAL 等文件：

```bash
sudo systemctl stop agent-insight.service
sudo install -d -m 700 /var/backups/agent-insight
BACKUP_FILE="/var/backups/agent-insight/agent-insight-$(date +%Y%m%d-%H%M%S).tar.gz"
sudo tar -C / -czf "$BACKUP_FILE" etc/agent-insight var/lib/agent-insight
sudo chmod 600 "$BACKUP_FILE"
sudo tar -tzf "$BACKUP_FILE" > /dev/null
```

确认备份命令成功后，可以继续升级；仅执行备份时，使用 `sudo systemctl start agent-insight.service` 恢复服务。备份包含平台配置和用户数据，应存放在受控位置。

### 升级

完成备份并确认服务已停止后，使用软件源中的新版本升级：

```bash
sudo dnf upgrade agent-insight
rpm -q agent-insight
```

使用本地 RPM 时，以新包执行 `sudo dnf install ./实际包名.rpm`。RPM 会保留已经修改的服务配置；升级后检查 `/etc/agent-insight` 下是否生成 `.rpmnew` 文件，并按新版本要求合并需要的配置。

启动服务，检查日志和页面：

```bash
sudo systemctl start agent-insight.service
sudo systemctl status agent-insight.service --no-pager
sudo journalctl -u agent-insight.service -n 200 --no-pager
```

确认历史 Trace 和评测数据可读，再执行一次客户端任务验证新数据上报。数据库结构同步失败时，保留原始数据和备份，按日志处理。

### 恢复备份

恢复时先停止服务，保留当前 `/etc/agent-insight` 和 `/var/lib/agent-insight` 目录，使用与备份兼容的 RPM 版本，将备份中的两个目录还原到原位置，并保留文件属主及权限。不要让运行中的服务继续写入待恢复的数据库，也不要把旧数据库与现有 WAL 文件混合。

还原后重新检测 Node.js 路径，再启动服务：

```bash
sudo /usr/libexec/agent-insight-node-setup
sudo systemctl start agent-insight.service
sudo systemctl status agent-insight.service --no-pager
sudo journalctl -u agent-insight.service -n 200 --no-pager
```

确认页面、历史数据及新任务上报正常后再结束恢复操作。

## 常见问题

| 现象 | 处理方法 |
| --- | --- |
| 软件源中找不到 `agent-insight` | 确认软件源已提供该包，或取得匹配系统和架构的本地 RPM。 |
| 安装提示缺少依赖 | 检查依赖软件源，确保能提供 RPM 要求的 Node.js、OpenCode 和 OpenSSL 等软件包；离线环境补齐相应 RPM。 |
| 服务启动失败 | 先查看 `systemctl status` 和 `journalctl`，根据首个错误处理。 |
| 提示服务用户无法使用 Node.js | 确认已安装符合要求的 Node.js，再执行 `sudo /usr/libexec/agent-insight-node-setup` 后重启服务。 |
| 本机可访问，其他机器无法访问 | 检查监听地址、访问端口、主机防火墙和网络访问规则。 |
| 端口已经占用 | 修改服务配置中的 `PORT`，重启后使用新端口访问。 |
| 提示数据库只读 | 核对 `/var/lib/agent-insight` 及 `data` 子目录属主、`agent-insight` 用户权限和磁盘状态。 |
| 数据库结构同步失败 | 保留数据和备份，按日志处理；不要通过清空数据库或忽略初始化失败继续启动。 |
