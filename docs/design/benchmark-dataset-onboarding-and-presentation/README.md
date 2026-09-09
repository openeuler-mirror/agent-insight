# Benchmark 数据集接入与展示开发方案

> 状态：已实现（待浏览器验收）

## Phase 1：需求

新增 Benchmark 时，开发者除 Adapter、Evaluator 和执行器能力外，还需要提供：

- 数据集 Loader：把官方数据格式转换为平台 Raw Case；
- 展示配置：声明 Case 列表和结果页展示哪些公开字段。

数据集文件不进入 Git 仓库，由平台管理员在部署环境安装一次，所有用户共享读取；实验、Trace 和评测结果仍按用户隔离。

## Phase 2：方案

### 1. 接入包

沿用现有 Benchmark 接入包，只增加可选 Loader 和声明式展示配置：

```text
benchmarks/<key>/
├── benchmark.yaml
├── adapter/
├── dataset/index.ts       # 特殊数据格式时提供
├── evaluator/
├── schemas/
└── tests/
```

`benchmark.yaml` 增加：

```yaml
implementation:
  datasetLoader: ./dataset/index.ts

dataset:
  profiles:
    - key: verified
      acceptedExtensions: [.parquet]

presentation:
  caseTable:
    searchPaths: [externalCaseId, values.repo]
    columns:
      - { path: input, label: 任务输入, type: text }
      - { path: externalCaseId, label: Instance ID, type: code }
      - { path: values.repo, label: 仓库, type: text }
  result:
    primaryMetric: { path: primaryMetric.value, label: Resolved, type: boolean }
```

展示配置只描述平台通用组件，不允许 Benchmark 注入 React、HTML 或 JavaScript。没有配置时回退显示 `input + externalCaseId`。

### 2. Dataset Loader

平台定义统一接口：

```ts
interface BenchmarkDatasetLoader {
  loadCases(sourcePath: string): AsyncIterable<JsonValue>
}
```

Loader 只读取文件并逐条输出 Raw Case，不直接写数据库。每条 Raw Case 继续交给现有 Adapter 完成校验、公开/私有字段拆分。

- JSON、JSONL 可由平台提供通用 Loader；
- Parquet 或官方 SDK 等特殊格式由 Benchmark 开发者提供 Loader；
- Loader 随代码构建进入 Catalog，下载目录只放数据文件。

### 3. 数据集下载、放置与导入

这里的“用户”指平台管理员或部署者。普通实验用户不上传数据集。

数据集可以放在任意目录，`--source` 直接指定文件路径。唯一要求是：执行导入命令的 Agent Insight 进程能够读取该路径。

平台推荐但不强制使用以下暂存目录：

```text
~/.agent-insight/data/benchmark-datasets/inbox/
```

例如：

```text
~/.agent-insight/data/benchmark-datasets/inbox/swe-bench/verified/test.parquet
```

Docker 或 Kubernetes 中，`--source` 必须使用容器内路径；宿主机文件需要先挂载或复制进容器。若文件下载在个人电脑，而服务运行在远端，则需要先复制到服务器。

首期提供管理员 CLI：

```bash
npx tsx scripts/benchmark/install-dataset.ts \
  --benchmark swe-bench \
  --profile verified \
  --source /任意可读取目录/test.parquet
```

Benchmark 接入包已构建、数据库已初始化且文件可读时，管理员只需执行这一个命令。成功后所有用户都可以使用该数据集，服务启动时不需要再次导入。

导入流程：

1. 根据 `benchmark + profile` 从 Catalog 找到 Loader 和 Adapter；
2. 校验文件类型并计算哈希；
3. Loader 读取数据，Adapter 校验并拆分公开/私有字段；
4. 在一个事务内写入 Dataset 和 Cases；
5. 使用系统 owner 保存为平台共享、只读数据集。

Cases 及评测所需字段全部写入数据库，运行时不再依赖原文件。数据库只记录原文件名和哈希，不记录个人绝对路径。相同内容重复导入直接复用。

默认保留原文件；如确认不再需要，可在命令中显式增加：

```bash
--delete-source-after-import
```

该选项只在数据库事务成功且导入结果校验通过后删除 `--source` 指定的单个文件；导入失败时必须保留原文件，不允许删除目录。

### 4. 平台数据集删除

数据集删除由管理员 CLI 完成：

```bash
npx tsx scripts/benchmark/remove-dataset.ts --dataset <dataset-id>
```

- 没有实验引用：删除 Dataset 和 Cases；
- 已被实验引用：不物理删除，只将状态改为 `archived`；
- `archived` 数据集不再用于创建新实验，但历史实验仍可查看；
- 首期不提供强制删除已被引用数据集的选项。

该命令处理的是数据库数据，与导入时的 `--delete-source-after-import` 无关。

### 5. 多用户规则

系统数据集使用保留 owner，例如：

```text
__agent_insight_system__
```

- 查询：用户可读取自己的数据集和系统数据集；
- 修改：用户只能修改自己的数据集；
- 创建实验：系统数据集可被所有用户引用；
- 实验、Run、Trace、结果和 Artifact 仍归当前用户所有。

现阶段沿用已有数据表，不新增独立数据集服务，也不为每个用户复制一份 SWE-bench。

## Phase 3：开发步骤

1. **扩展接入协议**
   - 为 `benchmark.yaml` 增加 Dataset Profile、Loader 和 Presentation；
   - Catalog 构建时校验并注册 Loader 和展示配置。

2. **实现通用导入器**
   - 新增管理员 CLI；
   - 完成任意可读路径导入、Loader 调用、事务写库和幂等处理；
   - 支持导入成功后按显式选项删除源文件；
   - 新增数据集删除 CLI：未引用时删除，已引用时归档；
   - 系统数据集使用保留 owner。

3. **迁移 SWE-bench**
   - 将现有 Parquet 导入代码改成 Loader；
   - 在 Adapter 中生成前端需要的公开字段；
   - 在 `benchmark.yaml` 声明 Case 和结果展示字段。

4. **改造通用前端**
   - Case 表格、搜索字段和结果指标从 Presentation 渲染；
   - 删除前端对 SWE-bench 字段名的硬编码；
   - 系统数据集显示“平台共享 · 只读”。

5. **测试**
   - 重复导入不产生重复数据；
   - 导入失败不留下半成品；
   - 被实验引用的数据集只能归档，未引用的数据集可以删除；
   - 两个用户看到同一 Dataset，但实验数据互不可见；
   - 私有字段不会出现在 Case API、页面或 Agent Task；
   - 新 Benchmark 只增加接入包，不修改核心导入和前端代码。

首期不做浏览器上传、远程 URL 下载、在线插件市场和自定义 React 渲染器。
