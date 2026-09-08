---
title: "常见问题"
description: "高频问题集中解答"
---

# 常见问题

这里汇总了用户第一次接入、日常使用和问题排查时最常遇到的高频问题。

> **Note**
> 如果你是第一次使用，建议先看 [5 分钟上手](./quickstart)；
> 如果你已经开始接入或排障，再回到本页查具体问题会更高效。

## 接入与登录

### 为什么我已经完成接入，但链路追踪里还是没有数据？

优先按下面顺序检查：

1. 当前 Workspace 是否正确
2. Agent 使用的 API Key 是否来自当前账号 / 当前 Workspace
3. 安装指导里的命令是否真的在目标运行环境执行过
4. Agent 是否已经实际产生过一次执行
5. 服务端地址和网络连通性是否正常

如果你最近切换过账号，尤其要注意是否复制了旧的 API Key。

### 为什么数据跑到别的账号或别的 Workspace 了？

最常见原因是：

- 客户端使用了旧的 API Key
- 复制安装命令前没有刷新当前登录状态
- 不同环境复用了错误配置

这类问题优先从 [安装指导](./settings/access-control) 和当前 API Key 归属检查起。

### 为什么已经有 Trace，但 Agent 管理里看起来没有对应 Agent？

通常说明这个对象还是**未注册 Agent**：

- 数据已经上报
- 但尚未在 [Agent 管理](./agent-management) 中正式登记

这种情况不是不能用，但会影响资产治理和理解成本，建议尽快补登记。

## 运行观测

### 为什么执行没报错，但结果明显不对？

这通常属于**效果偏差类问题**，不一定会以异常状态直接暴露。

建议这样排查：

1. 在 [链路追踪](./observability/view-traces) 找到对应样本
2. 看关键 Span 的输入输出
3. 必要时进入 [智能诊断](./observability/diagnosis)
4. 将高频问题转成数据集做回归验证

### 多 Agent 场景下，为什么我看到的 Trace 很乱？

先使用主 Agent / 子 Agent 范围筛选：

- 先只看主 Agent，理解整体入口流程
- 再看子 Agent，定位派生任务细节

如果一上来就把所有层级混在一起看，很容易误判根因。

### 什么情况下先看链路追踪，什么情况下先看智能诊断？

- **先看链路追踪**：当你需要理解原始执行过程
- **先看智能诊断**：当你已经确认样本有问题，想快速得到归因方向

最常见路径是先 Trace，后诊断。

## 评估与实验

### 为什么我的评测结果很奇怪？

结果异常不一定意味着目标对象有问题，也可能是：

- 数据集样本设计不合理
- 参考答案不清晰
- 评估器过严、过松或不匹配当前任务

建议同时回看：

- [评测数据集](./evaluation/datasets)
- [评估器](./evaluation/evaluators)
- [实验详情与 Case 结果](./evaluation/experiments#查看实验详情)

### 第一次评测应该准备多少样本？

建议从 5 到 20 条高价值样本开始即可。重点是：

- 代表核心场景
- 包含典型失败
- 能支撑真实决策

不要一开始就追求大规模。

### 为什么我修完问题后，仍然不确定是否真的变好了？

这通常说明你还没有稳定的回归集。

推荐做法：

1. 从真实 Trace 里提炼高价值样本
2. 建立数据集
3. 配好评估器
4. 在修改前后跑同一批样本对比

## Skills

### 什么情况下值得把能力沉淀成 Skill？

当一个能力满足下面任意几条时，通常就值得沉淀：

- 会反复用到
- 触发条件相对明确
- 希望被多个 Agent 复用
- 希望独立分析和优化

### 为什么我的 Skill 总是误触发或不触发？

优先在 [Skill 评估与实验](./skills/evaluation/overview) 中检查：

- 触发分析结果
- 静态质量评估是否存在结构性问题
- 是否有边界样本覆盖不足

### 生成出来的 Skill 可以直接长期使用吗？

通常不建议。

更推荐：

1. 先生成初稿
2. 确认结构与边界
3. 发布后在 Skill 实验中验证效果
4. 根据证据进入优化会话生成候选版本

## 使用建议

### 我应该先看哪个模块？

按你的目标选择：

- 想先接入平台： [5 分钟上手](./quickstart)
- 想看真实执行： [运行观测](./observability/index)
- 想做离线验证： [评估与实验](./evaluation/index)
- 想沉淀和优化能力： [Skill 工作台](./skills/index)

### 为什么文档里经常强调“先看真实样本，再做评测”？

因为平台最强的闭环之一就是：

`真实运行问题 → Trace → 数据集 → 评测 → 优化`

如果跳过真实样本，后面的评测很容易变成脱离业务的“空跑”。

## 数据归档与恢复

### 怎样归档指定时间之前的历史数据？

SQLite 部署可以使用仓库内置的 `scripts/db_archive.sh`。默认读取
`~/.agent-insight/data/witty_insight.db`，也可以用 `--database` 指定数据库文件。
脚本可以单独复制到服务器运行，不依赖仓库、Node.js 或 `package.json`；服务器只需提供
`bash`、`sqlite3`、`gzip`，以及 `sha256sum` 或 `shasum`。

先预览将被选中的数据：

```bash
bash scripts/db_archive.sh create \
  --scope traces \
  --user 'alice' \
  --before '2026-01-01T00:00:00+08:00' \
  --output /data/agent-insight-archive \
  --dry-run
```

确认后执行归档。归档文件完成校验后，脚本会默认事务性删除源数据：

```bash
bash scripts/db_archive.sh create \
  --scope traces \
  --user 'alice' \
  --before '2026-01-01T00:00:00+08:00' \
  --output /data/agent-insight-archive
```

如果只想导出副本、不删除数据库数据，必须明确传入 `--keep-source`：

```bash
bash scripts/db_archive.sh create \
  --scope traces \
  --user 'alice' \
  --before '2026-01-01T00:00:00+08:00' \
  --output /data/agent-insight-archive \
  --keep-source
```

`traces` 提供 `--user` 时，只从 `Execution.user` 与指定账号完全一致的根 Trace 开始
筛选；不提供 `--user` 时归档时间窗口内所有账号的数据，manifest 中记录为
`<all-users>`。两种范围都不区分用户 Agent 和系统 Agent，并始终归档选中 Trace 的完整
主/子 Agent 树及其 Session、评测、标签绑定、诊断和实验结果。即使某个子 Agent 的时间
落在窗口外，只要根 Trace 被选中，它仍会一起归档。

归档所有账号时直接省略 `--user`：

```bash
bash scripts/db_archive.sh create \
  --scope traces \
  --before '2026-01-01' \
  --output /data/agent-insight-archive/all-users.sqlite.gz
```

### 怎样归档一个时间区间或基础设施指标？

时间区间使用 `[from, to)` 语义，即包含起点、不包含终点。可以只写
`YYYY-MM-DD`，此时按运行脚本机器的本地时区解释为当天 `00:00:00`；写到分秒时必须带
`Z` 或数字时区：

```bash
bash scripts/db_archive.sh create \
  --scope traces \
  --user 'alice' \
  --from '2025-01-01T00:00:00+08:00' \
  --to '2026-01-01T00:00:00+08:00' \
  --output /data/agent-insight-archive
```

基础设施采样使用 `infra-metrics` scope，并按 `InfraMetricSample.tsMs` 筛选：

```bash
bash scripts/db_archive.sh create \
  --scope infra-metrics \
  --before '2026-01-01T00:00:00+08:00' \
  --output /data/agent-insight-archive
```

`InfraMetricSample` 没有账号字段，因此 `infra-metrics` 不接受 `--user`。

### 怎样检查和恢复归档？

归档由 `.sqlite.gz`、`.sqlite.gz.sha256` 组成；成功清理源数据后还会生成
`.sqlite.gz.purged` 收据。请把这些文件一起保存；存在 `.purged` 表示该归档对应的
源数据已经成功清理。

```bash
bash scripts/db_archive.sh inspect \
  --input /data/agent-insight-archive/traces-xxx.sqlite.gz

bash scripts/db_archive.sh import \
  --input /data/agent-insight-archive/traces-xxx.sqlite.gz \
  --dry-run

bash scripts/db_archive.sh import \
  --input /data/agent-insight-archive/traces-xxx.sqlite.gz
```

导入要求目标数据库 schema 与归档一致。相同主键且内容相同的数据会被幂等跳过；
相同主键但内容不同会终止并回滚整个导入。

该脚本目前仅支持 SQLite。归档只包含数据库行，不包含 `SkillVersion.assetPath` 等字段
指向的外部文件。创建一致性快照需要临时磁盘空间，高写入期间执行
默认清理可能因数据在导出后发生变化而安全中止；这种情况下保留已生成的归档，
重新执行即可。

## 下一步

- 想先跑通接入： [5 分钟上手](./quickstart)
- 想正式纳管 Agent： [Agent 管理](./agent-management)
- 想排查真实问题： [运行观测](./observability/index)
- 想建立回归验证： [评估与实验](./evaluation/index)
- 想管理和优化 Skill： [Skill 工作台](./skills/index)
