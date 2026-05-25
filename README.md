<p align="center">
  <a href="https://gitcode.com/openeuler/witty-skill-insight">
    <strong style="font-size: 6em;">Skill-insight</strong>
  </a>
</p>
<p align="center">让 Agent 的 Skill 从"能用"到"好用"——基于执行过程数据，实现 Skill 生成、评测与优化的全生命周期闭环</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@witty-ai/skill-insight"><img alt="npm" src="https://img.shields.io/npm/v/@witty-ai/skill-insight?style=flat-square" /></a>
  <a href="https://gitcode.com/openeuler/witty-skill-insight/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/npm/l/@witty-ai/skill-insight?style=flat-square" /></a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> |
  <a href="README_en.md">English</a>
</p>

[![Skill-insight Dashboard](docs/images/dashboard_main.png)](https://gitcode.com/openeuler/witty-skill-insight)

---

## 为什么需要 Skill-insight

Skill 正在成为 Agent 落地的关键载体，但实际使用中普遍面临三个问题：

- **Skill 越多越不好用**：相似文档生成大量冗余 Skill，研究表明 Skill 超过 40-50 个后召回率从 95% 骤降至 30% 以下
- **执行过程看不见**：评测只看"任务是否完成"，即使结果正确也可能跳过了关键步骤，埋下隐患
- **优化靠猜测**：没有执行数据支撑，只能基于结果反复试错，无法定位具体瓶颈

Skill-insight 正是为了解决这些问题而生。

## 核心能力

### 🔨 Skill 生成 — 一句话生成，批量去重

- 支持一句话快速生成 Skill
- 批量生成时自动去冗余、合相似、抽模式，减少 Skill 膨胀
- 支持从 Markdown、PDF、目录、URL 等多种数据源输入

### 📊 多维评测与执行追溯

- 覆盖效果（准确率、Skill 召回率、Skill 提升率）、效率（时延、调用次数）、成本（Token、模型费用、CPSR）等多维指标
- 自动生成执行流程图，与 Skill 预期流程逐步对比，标识偏离、冗余与跳过
- 支持从 Skill、框架、模型、任务四个维度交叉对比分析
- 更多指标详见 [指标详解](docs/metrics.md)

### 🔄 数据驱动的 Skill 自优化

- 基于评测归因结果，自动定位 Skill 缺陷并针对性修补
- 区分 Skill 设计问题与模型能力问题，避免"改错方向"
- 形成 **评测 → 归因 → 优化 → 再评测** 的持续改进闭环

## 支持框架

| Agent 框架    | 采集方式 |
| :---------- | :--- |
| OpenCode    | 原生插件 |
| Claude Code | 日志旁路 |
| OpenClaw    | 日志旁路 |

## 安装 （Node.js 版本必须 ≥ v20.x）

```bash
# 一键安装
npx @witty-ai/skill-insight install
```

> [!TIP]
> 安装完成后在 `http://localhost:3000` 访问看板，默认账号 `admin`。

### 源码安装

```bash
git clone https://gitcode.com/openeuler/witty-skill-insight.git
cd witty-skill-insight
npm install

# 开发模式
bash scripts/restart_dev.sh

# 生产模式
bash scripts/restart.sh

# 配置数据上报路径
curl -sSf http://<IP>:<PORT>/api/setup | bash
```

### 开发 mock 数据（可选）

新 dev 想直接看到 `/skill-opt` 页面有 skill 列表 + 优化点列表，可以注入一份 mock
数据。不依赖真实评估器或 trace 数据，本地开发联调用。

```bash
# 注入 mock 数据：3 个 skill + 5 个优化点
# （pdf-extractor / doc-summarizer / chart-gen，全部 source='static'）
npm run seed:skill-opt

# 清理 mock 数据（cascade 删 SkillVersion / Evaluation / SkillIssue）
npm run clean:skill-opt
```

数据归属 `user='skill-insight@huawei.com'`（项目默认登录账号）；脚本幂等，重跑安全。
脚本头部注释里有详细说明。

## 快速上手

以下以 OpenCode 为例，演示完整的生成 → 评测 → 优化流程。

**前置条件**：已完成 Skill-insight 平台安装和 OpenCode 安装。

### 第一步：安装 Skill 工具包

```bash
npx skills add https://gitcode.com/openeuler/witty-skill-insight.git
```

### 第二步：生成 Skill

在 OpenCode 终端输入：

```
根据案例文档 Docker应用卡顿故障案例.pdf 生成一个 Skill
```

### 第三步：执行任务

将生成的 Skill 放在 OpenCode 的 Skill 目录下，执行任务：

```
我在本机部署的docker应用有时会卡顿，使用相关技能帮我分析下原因，并给出分析报告
```

### 第四步：查看观测结果

任务执行完毕后，点击 OpenCode 终端页面右上角 Skill insight 卡片中的**查看详情**，跳转到平台查看执行详情。

### 第五步：深度评测（可选）

如需使用准确率、Skill 召回率、失败归因等深度评测能力：

1. 在平台主页面点击左上角 **⚙️ Eval Config**，添加评测模型配置（支持 DeepSeek / OpenAI / Anthropic / 自定义）
2. 点击右上角 **数据集管理**，配置用户问题、预期答案、预期使用的 Skill

### 第六步：优化 Skill

在 OpenCode 终端输入：

```
/si-optimizer <待优化的Skill路径>
```

优化完成后，Skill 会自动加载到 OpenCode 的 Skill 目录下。重启 OpenCode 后再次执行同一任务，即可在平台对比优化前后的效果差异。

## 文档

详细使用指南见 [docs/guide](docs/guide/) 目录。

## 贡献

贡献代码前，请先签署 [CLA](https://clasign.osinfra.cn/sign/6983225bdcbb19710248ccf0)，再参考 [代码贡献指引](https://www.openeuler.org/zh/community/contribution/detail#_4-2-代码类贡献) 提交代码。

---

**加入社区** [Issue](https://atomgit.com/openeuler/witty-skill-insight/issues) | <intelligence@openeuler.org>
