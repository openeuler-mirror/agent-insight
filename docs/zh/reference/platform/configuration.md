---
title: "运行配置参考"
description: "平台运行目录、端口、数据库、模型与评测配置入口。"
---

本页集中说明平台运行目录、端口、数据库与常用配置入口。各独立客户端和 Evaluator 是不同进程，平台的 `.env` 不会自动应用到它们。完整候选项以所安装版本随附的 `.env.example` 为准；不要把历史文档中的变量直接复制到当前部署。

## 配置文件与优先级

平台先从启动环境确定 `AGENT_INSIGHT_HOME`，默认是当前运行用户的 `~/.agent-insight`，然后读取该目录下的 `.env`。`AGENT_INSIGHT_HOME` 应在启动命令、systemd 或 Docker 环境中指定，不能靠运行根内的 `.env` 选择运行根自身。

通过 npm CLI 启动时，平台端口优先级为 `--port`、进程环境 `AGENT_INSIGHT_PORT`、运行根 `.env`、默认 `3000`；SQLite 地址优先使用进程环境中的 `DATABASE_URL`，其次为运行根 `.env`，空值使用默认路径。源码 `scripts/start.sh` 也保留这些显式启动覆盖。其他配置按各读取点处理，不把这一顺序泛化成所有独立服务的统一约定。

`.env.example` 是模板。首次启动可据此创建运行配置；修改模板不会改变已存在的运行根 `.env`。平台配置修改后通常需重启，前端构建变量还需重新构建。热更新例外见下方评测配置。

## 核心变量

| 变量 | 作用与默认值 | 设置位置与注意事项 |
| --- | --- | --- |
| `AGENT_INSIGHT_HOME` | 平台运行根，默认 `~/.agent-insight` | 启动环境；建议绝对路径，包含 `.env` 和 `data/`，不等于仓库目录 |
| `AGENT_INSIGHT_PORT` | 平台 HTTP 端口，默认 `3000` | 平台配置或启动环境；整数 `1`～`65535`，`--port` 可覆盖 |
| `DATABASE_URL` | SQLite 地址；空值默认运行根下 `data/witty_insight.db` | 平台配置或启动环境；显式 SQLite 地址使用 `file:/绝对路径`，迁移运行根时检查旧绝对路径 |
| `DB_HOST` | 可选 OpenGauss 主机，无默认值 | 仅在采用该数据库部署方案时设置；与端口、库名和凭据一起核对 |
| `DB_PORT` | OpenGauss 端口 | 建议显式设置：平台默认 `5432`，初始化脚本默认 `26000`，需与实例一致 |
| `DB_NAME` / `DB_USER` / `DB_PASSWORD` | OpenGauss 库名、用户、密码；模板说明默认库名 `postgres`、用户 `omm`，密码无默认值 | 仅在实际部署配置保存凭据；不能通过复制 SQLite 文件完成该数据库备份 |
| `AGENT_INSIGHT_CONFIG_DIR` | Benchmark 配置目录；空值使用安装目录的 `config/benchmark/` | 指定时使用绝对路径；不是平台运行根，也不替代运行根 `.env` |
| `NEXT_PUBLIC_URL_PREFIX` | 前端 URL 前缀 | 按部署要求设置；改动后需重新构建前端，仅重启服务不够 |

旧 `AGENT_INSIGHT_DATA_DIR` 已移除，应改名为 `AGENT_INSIGHT_HOME` 并保留原根路径。旧通用 `PORT` 已移除，按进程改用平台或 Evaluator 专用端口变量。

## 模型与客户端

默认模型使用 `DEFAULT_MODEL_<N>_<FIELD>` 连续编号，从 `1` 开始；某组缺少 `NAME`、`PROVIDER` 或 `API_KEY` 时，不再读取后续组。建议同时明确填写 `BASE_URL` 和 `MODEL`，不要假定各调用路径会按提供商自动选择相同默认地址。由环境定义的模型在界面中只读，界面新增模型仍按[模型注册](../../how-to/platform/settings/model-registry.md)处理。

客户端的服务地址、API Key 和安装配置见[客户端安装](../../how-to/platform/settings/access-control.md)。每台客户端有自己的运行环境；不要把多台机器的运行根映射为同一个共享目录。需要多个平台实例时，每个实例使用独立运行根、数据库和端口。

## 评测服务与业务配置

| 配置 | 范围 | 生效方式 |
| --- | --- | --- |
| `AGENT_INSIGHT_EVALUATOR_PORT` | Evaluator 端口或部署脚本的宿主机映射端口，默认 `3001` | 独立服务配置；Docker 的容器内监听端口需按对应部署文件核对，不能直接等同宿主机端口 |
| `AGENT_INSIGHT_BENCHMARK_EVALUATOR_BASE_URL` | 平台连接独立 Evaluator 的基础地址，默认空 | 平台启动兜底配置；本机示例 `http://127.0.0.1:3001` |
| `AGENT_INSIGHT_BENCHMARK_EVALUATOR_ALLOW_INSECURE_HTTP` | 是否允许非回环 HTTP，默认 `true` | 依赖部署网络隔离；设为 `false` 时非回环地址要求 HTTPS |
| `AGENT_INSIGHT_BENCHMARK_EXECUTOR_CALLBACK_BASE_URL` | 旧版本地执行器回调地址覆盖，默认空 | 默认从请求地址推导；不要用于替代独立 Evaluator 地址 |
| `data/config/benchmark-evaluator.env` | 平台运行根下的上述三项评测连接配置 | 可在运行后热更新，无需重启平台 |
| `platform.yaml` / `platform.local.yaml` | Benchmark 配置目录中的默认业务配置与本机覆盖 | 数据来源、自动导入等以此配置为准，详见 Benchmark 部署指南 |

SWE-bench 和 ZSoft 的自动导入可分别通过对应 `dataset.autoImport` 配置关闭。旧数据来源环境变量不应替代当前 YAML 配置。服务启动、依赖与联通检查见[Benchmark 通用服务部署](../../how-to/evaluation/benchmarks/deploy-services.md)。

## 运维入口

- [常见问题](../../how-to/platform/faq.md)：路径、权限、端口及启动问题。
- [备份与恢复](../../how-to/platform/backup-and-restore.md)：平台、外部存储和客户端的备份边界。
- [升级与回滚](../../how-to/platform/upgrade-and-rollback.md)：安装时数据库同步和版本配套要求。

本页未穷举所有采集器、性能与诊断参数；应使用对应功能指南以及当前安装版本的配置模板，不要把未列出解释为已废弃。

[English](../../../en/reference/platform/configuration.md)
