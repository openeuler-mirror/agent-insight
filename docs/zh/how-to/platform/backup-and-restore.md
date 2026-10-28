---
title: "备份与恢复"
description: "自管部署的停机备份、独立目录恢复与验证边界。"
---

本指南说明自管 Agent Insight 的停机备份与恢复。默认 SQLite 部署可以备份运行目录；使用外部数据库、外部配置目录或独立客户端时，需要同时备份对应存储。平台目前没有统一的 `backup` / `restore` CLI 命令。

## 确认备份范围

| 对象 | 默认位置或查找方式 | 处理方式 |
| --- | --- | --- |
| 平台运行根 | `AGENT_INSIGHT_HOME`；默认 `~/.agent-insight` | 备份整个目录，保留目录结构和权限 |
| 平台配置 | 运行根下的 `.env` | 随运行根备份，包含密钥，应限制访问 |
| SQLite | 默认 `data/witty_insight.db`；显式 `DATABASE_URL` 可改变位置 | 在所有写入停止后备份；不能只复制正在写入的主数据库文件 |
| 业务文件、Trace 缓存与消费状态 | 运行根下的 `data/` 等目录 | 与数据库一起备份；不要把消费检查点和待消费数据随意拆开恢复 |
| Benchmark 配置 | 安装目录的 `config/benchmark/` 或 `AGENT_INSIGHT_CONFIG_DIR` | 另存本地覆盖配置，记录原路径 |
| 外部数据库、挂载目录与符号链接目标 | 根据实际部署配置核对 | 使用数据库原生的一致性备份工具，另外备份目录；下面的 tar 示例不覆盖这些内容 |
| 独立采集器、RAS/FI 客户端、Evaluator | 各主机自己的配置和存储 | 在各主机单独备份；平台目录不包含所有客户端状态 |

同时记录平台版本、源码提交或镜像摘要、部署方式和实际运行用户。恢复程序版本与数据版本应成对保留。变量含义见[运行配置参考](../../reference/platform/configuration.md)。

## 停机备份（macOS / Linux，SQLite）

1. 暂停新实验、评测和写入请求，等待任务结束，或通过原有任务入口取消并确认退出。
2. 停止平台服务，以及会写入同一运行目录的采集器、后台 worker 和独立客户端。使用 npm CLI 启动的平台可执行 `agent-insight stop --port 3000`，端口按实际配置替换；Docker、systemd 等部署使用原部署工具停止。仅停止平台不等于所有独立进程都已停止。
3. 确认没有进程继续写入，再执行下面的备份。示例要求数据库位于运行根内；外部数据库或存储另行处理。

```bash
# 改为部署时使用的绝对路径。
insight_home="${AGENT_INSIGHT_HOME:-$HOME/.agent-insight}"
umask 077
# 新建备份目录必须位于运行根之外。
backup_dir="$(mktemp -d "$HOME/agent-insight-backup.XXXXXX")"
tar -czf "$backup_dir/runtime.tar.gz" -C "$insight_home" .
tar -tzf "$backup_dir/runtime.tar.gz" >/dev/null
printf '备份位置：%s\n' "$backup_dir/runtime.tar.gz"
```

逐条确认命令成功后再继续。归档能列出内容只说明归档可读，不能替代恢复演练。离线复制会保留目录中的 SQLite 辅助文件，不要在备份前手动删除 `-wal`、`-shm` 或消费检查点。归档可能含模型密钥、用户信息和 Trace 内容，不应上传到公开仓库。

## 恢复到新目录

先使用与备份匹配的程序版本。原运行目录留存，不直接覆盖；下面示例只提取你自己生成并核对过的备份。

```bash
umask 077
backup_file="/absolute/path/to/runtime.tar.gz"
restored_home="$(mktemp -d "$HOME/agent-insight-restore.XXXXXX")"
tar -tzf "$backup_file" >/dev/null
tar -xzf "$backup_file" -C "$restored_home"
printf '恢复目录：%s\n' "$restored_home"
```

启动前核对恢复目录的 `.env` 和部署环境：

- 若 `DATABASE_URL` 写的是旧数据库绝对路径，改为恢复后的路径，例如 `file:/absolute/restore/path/data/witty_insight.db`；默认 SQLite 配置可以留空。也检查启动命令中是否仍覆盖旧 `DATABASE_URL`。
- 外部数据库先恢复到独立实例或数据库，并更新连接配置；复制运行根不会恢复外部数据库。
- 核对配置目录、挂载点、符号链接、文件属主和权限。不要启动两个实例共享同一运行根，也不要手动删除锁文件来强行启动。
- 试恢复时先隔离外部采集、执行客户端与真实模型调用，避免自动重试或后台任务影响现网。

对 npm CLI 部署，完成核对后可在新端口试启动：

```bash
AGENT_INSIGHT_HOME="$restored_home" agent-insight start --port 3100
```

源码部署使用匹配版本的 `scripts/start.sh`，Docker 部署把恢复目录绑定到容器内的运行根。恢复 SQLite 后先验证登录、历史 Trace、实验记录与附件，再按部署方式切换端口、入口和客户端连接。确认恢复有效后再决定原数据的保留周期。

## 验证与限制

恢复验证至少包括：服务启动无数据库错误、原有用户可登录、抽样历史 Trace 和实验可打开、附件可读取，以及重新启用采集后新数据可见。检查恢复目录内的实际数据库发生了预期更新，避免误连旧库。

本指南提供操作步骤，不代表已在你的生产环境完成恢复演练；外部数据库、Windows 服务和容器挂载需按实际部署验证。升级时的版本与数据配套要求见[升级与回滚](./upgrade-and-rollback.md)。
