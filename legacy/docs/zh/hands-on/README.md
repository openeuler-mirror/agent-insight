# Agent Insight 实战教程

> 定位：跟做教程，面向会使用命令行的开发者——手册查定义，教程跟操作；每篇围绕一个可复现任务，附步骤说明、界面截图与完成检查。

## 篇目

| 篇 | 标题 | 说明 | 状态 |
|---|---|---|---|
| 00 | [安装部署实战](./00-environment-setup.md) | 从零搭建环境到第一条 Trace：基础环境、服务端安装（npm / Docker）、模型注册、OpenCode 接入 | 已发布 |
| 01 | [链路追踪实战](./01-trace-observability.md) | 看懂一条真实 Trace：调用树、Token、耗时与关键交互 | 已发布 |
| 02 | [智能诊断实战](./02-intelligent-diagnosis.md) | 从 Trace 发起五维认知归因，核对证据与建议 | 已发布 |
| 03 | [设计评估实战](./03-design-evaluation.md) | 用四个自建评估器给 AET 生成的设计文档打分 | 已发布 |
| 04 | [Skill 优化实战](./04-skill-optimization.md) | 评测优化闭环（以需求分析 Skill 为例）：评测暴露短板 → 优化生成新版本 → 固定条件复测，从 0 分到 100 分 | 已发布 |

## 环境准备

首次搭建环境请先完成[安装部署实战](./00-environment-setup.md)。之后每次开始实践，按下面三步重新打开环境：

1. Windows 用户执行如下命令打开 Ubuntu；Mac 用户直接打开终端：

```
wsl -d Ubuntu-24.04
```

2. 启动 Agent Insight 服务：

```
npx agent-insight start
```

3. 重复步骤 1，打开另一个终端，启动 OpenCode：

```
cd "$HOME/work/opencode-practice"
opencode
```

开始前的三项确认：

- 已完成安装部署与接入，当前平台账号能看到本次运行的 Trace；
- 平台已配置可用模型并设为默认，设计评估实战的实验使用默认平台评测模型；
- 从链路追踪实战开始。它保存的 Trace 链接或编号，智能诊断与设计评估都要使用。

> **Warning**
> 实践期间保持设备唤醒、网络连接和 WSL 环境运行。不要在采集与实验执行过程中关闭 WSL 或重启电脑。

## 素材

- [AET 评测集](./assets/aet-evalset.json)：设计评估实战批量导入的理想输出评测集（1 条数据项，含 24 点需求输入与两份参考说明书正文）。

