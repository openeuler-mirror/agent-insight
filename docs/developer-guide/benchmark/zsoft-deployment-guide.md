# ZSoft 部署指南

本指南与 [SWE-bench 部署指南](swe-bench-deployment-guide.md) 同级，说明 ZSoft 的数据、执行任务目录、评测资产和验收。平台、执行客户端与 Evaluator 的公共安装见 [Benchmark 通用服务部署指南](service-deployment-guide.md)。资产构建与发布由维护者按 [ZSoft 评测资产发布指南](../zsoft-assets-release.md) 完成。

## 1. 部署前提

- 完成公共服务安装，平台、执行客户端和 Controller 版本兼容。
- 平台能读取官方题目目录，执行机具备匹配的原生任务目录与所选 Agent Runtime。
- 评测机具备 Docker 和 Compose，能匿名拉取接入包固定的资产镜像及 Case 镜像；Runtime 缺失时还需构建网络或预置匹配镜像。
- 内核题的 runner 提供 QEMU、C 编译工具和 rootfs 工具。默认使用 TCG；使用 KVM 时需在宿主机提供虚拟化能力并完成实际评测验证。

ZSoft 是 Benchmark，MCTS 是可选 Agent Runtime。数据集导入不要求平台具备 Docker、MCTS 或私有判题资产。

## 2. 数据集安装

### 在线与离线来源

**平台机器在线准备：**

```bash
bash scripts/start.sh
```

`benchmarks.zsoft-l1.dataset.autoImport` 默认 `true`，启动时获取官方仓库 `https://gitcode.com/linmalin/muyuan-sec.git` 的固定提交 `7f7d675eff19eec27745ddcd24b1efaf398bb753`，缓存到 `~/.agent-insight/benchmark-assets/zsoft-l1/`，解析 30 道正式题（24 道 userspace、6 道 kernel）并导入当前数据库。已安装时直接复用数据库，不访问来源。将 `config/benchmark/platform.local.yaml` 中的 `autoImport` 设为 `false` 只关闭启动自动导入，不影响已有数据集和下面的管理命令。各 Benchmark 的开关互相独立；旧启动参数 `--benchmark` 和选择变量 `AGENT_INSIGHT_BENCHMARK` 已移除。

准备或导入失败只警告，继续准备其他数据集并启动服务；详细输出写入 `~/.agent-insight/logs/zsoft-l1-bootstrap.log`（随 `AGENT_INSIGHT_HOME` 调整），每次尝试覆盖，下次启动重试。启动会同步等待准备完成；本步骤只导入题目，不启动评测服务或下载评测镜像。

**平台机器离线准备：** 将官方 L1 包目录或完整仓库放在本机目录，在项目 `config/benchmark/platform.local.yaml` 设置：

```yaml
benchmarks:
  zsoft-l1:
    dataset:
      autoImport: true
      source: /srv/datasets/zsoft-l1
      revision: null
```

L1 目录包含 `tasks/<task-id>/task.json` 与 `public/README.md`；完整仓库根目录内的 `benchmarks/vulnerability/zsoft-l1` 也能识别。配置后执行 `bash scripts/start.sh`，平台不需要 Docker、构建状态或私有判题资产。在线镜像将 `dataset.source` 设置为 HTTP(S) Git 仓库地址，`dataset.revision` 指定完整 40 位小写提交哈希；两项 `null` 使用接入包固定的官方来源与版本。离线按实际题目内容识别，有 Git 元数据时附带真实 revision。相对路径按声明配置的文件所在目录解析。

旧 `ZSOFT_DATASET_SOURCE`、`ZSOFT_DATASET_REVISION` 不再生效，发现残留时提示迁移。不要再把它们写入 `.env`。已经导入数据库的数据不会因修改来源配置自动更新，需要显式刷新。

无需重启服务的管理命令：

```bash
npx tsx scripts/benchmark/ensure-dataset.ts --benchmark zsoft-l1
# 显式读取新来源；已引用的数据集不能覆盖，用新名称安装新版本。
npx tsx scripts/benchmark/ensure-dataset.ts \
  --benchmark zsoft-l1 --refresh --name "ZSoft L1 新版本"
```

旧 24 题数据集不会自动扩容；使用上面的 `--refresh --name` 安装全量版本。在线缓存使用新的解析版本键，旧缓存不会被误判为损坏。旧 P2 JSON/JSONL 和 ZSoft 公开包工作区不再兼容，需从官方目录重新导入。历史实验不会自动迁移。题目身份使用 `task.json` 与公开文件内容的 `sourceTaskDigest`；私有判题材料和镜像构建摘要由评测机单独冻结，平台不以它们作为数据准备前置条件。

## 3. 执行端准备

执行机准备原生目录 `<tasks-dir>/<task-id>/task.json` 和 `<tasks-dir>/<task-id>/public/`，题目内容与平台导入版本一致。MCTS 接入见 [MCTS xGovernor 接入](../../user-guide/observability/mcts-xgovernor.md#用于平台-benchmark-实验)；在执行机的 MCTS 仓库 `testcases_union/config.env` 设置绝对路径，例如：

```bash
ZSOFT_TASKS_DIR=/srv/zsoft/tasks
```

可以沿用已有上游目录；平台不需要访问执行机路径。内核题与 userspace 共用目录，任务 ID 由平台自动下发。实验向导只选择数据集和执行客户端，无需填写任务目录或额外导入公开资料包。

没有 `public/repo-vul/` 的题目还需保留原生 `<task-id>/private/source-manifest.json` 和 `<tasks-dir>/../source-locks/<source-id>.json`。源码来源须锁定到完整提交或带 SHA-256 的归档；MCTS 在沙箱中下载，需预留网络和执行预算。隐藏测试、参考 PoC、修复补丁与 Judge 配置不交给 Agent。公开工作区与源码裁剪契约见 [接入开发规范](benchmark-integration-development-guide.md#zsoft-自动生成-poc-的执行契约)。

客户端须上报 `zsoft-tasks-workspace/v3` 和 `single-file/v1`；MCTS 还需 `mcts-zsoft-export/v1`。ZSoft 不要求 SWE 专属的 `datasets` 和 `run_union.sh`；MCTS 插件需支持当前源码下载与 `bundle_bytes` 接口，未就绪时执行目标不可用。升级后重新安装客户端，不能只更新平台代码。

## 4. 评测端准备

### 安装固定资产版本

直接使用接入包 `benchmarks/zsoft-l1/evaluator/evaluator.yaml` 中 `assets` 固定的 image digest、release ID、bundleDigest 和 sourcePath，不手工改成可变 tag。Controller 启动后在后台拉取资产镜像，从未启动的临时容器复制文件，校验 release、冻结清单与逐题摘要，再原子安装到共享卷：

```bash
bash scripts/evaluator.sh start   --platform-base-url <agent-insight-url>
```

默认目录为容器内 `/data/benchmark-assets/zsoft-l1/<镜像摘要>`；`/data` 由 Docker 命名卷 `agent-insight-benchmark-evaluator-data` 提供，宿主无需创建同名目录。需要宿主指定磁盘时，在首次创建卷前配置 local volume 绑定；已有卷迁移需保留原数据。

在评测机 `config/benchmark/evaluator.local.yaml` 可覆盖根目录与加速模式：

```yaml
benchmarks:
  zsoft-l1:
    assetsDir: null
    kernelAccel: tcg
```

`assetsDir: null` 使用默认根目录；自定义目录须处于 Controller 与 Runtime 共享且可写的 bind/volume 内，通常在 `/data` 下，不会自动新增宿主挂载。实际版本目录自动追加镜像摘要，重启复用已校验版本；不同摘要分别保存，不覆盖历史版本。安装失败最多重试三次，排除网络、权限或摘要问题后重启 Controller 重试。旧手动解压目录不会被自动识别为托管版本。

旧 `ZSOFT_L1_ASSETS_DIR`、`ZSOFT_KERNEL_ACCEL` 不再覆盖 YAML，不要通过 `--evaluator-env` 传入。平台和评测机分别维护各自配置；评测端不连接平台数据库。

Case 镜像由公共镜像池按固定 digest 拉取、缓存和回收，Compose 使用已校验 Image ID 并禁止自动 pull。没有 `registryImages` 的冻结清单要求本机预装固定 Image ID；缺少 `sourceTaskDigest` 的旧清单需由维护者重新冻结。离线部署需提前搬运匹配版本的完整资产镜像、题目镜像及 Runtime。

### 准备 Evaluator Runtime

首次评测复用匹配的本地 Runtime，缺失时尝试拉取，失败后按接入包 Dockerfile 自动构建并核对 Catalog artifact 摘要。启动 Controller 不预热 Runtime；自动构建不会重新编译 Case 环境。无需远程 Runtime 时保持 `EVALUATOR_RUNTIME_IMAGE_PREFIX` 未设置。

避免首次等待或准备离线环境时，可在与 Controller 一致的源码版本执行：

```bash
node scripts/benchmark/build-evaluator-runtime.cjs zsoft-l1
```

不传 `--push`、`--image-prefix` 时只准备本地 Runtime；跨机可用 `docker save/load` 搬运匹配镜像。构建和发布流程的区别见 [资产发布指南](../zsoft-assets-release.md)。

### 内核加速与资源

默认 `kernelAccel: tcg` 无需 `/dev/kvm`，但应按真实耗时调整超时。使用 `kvm` 前，先在宿主开启虚拟化或嵌套虚拟化，再修改 YAML 并重启 Evaluator。平台 Runtime 不需要 privileged；受控代理仅对实际 runner 开放 `/dev/kvm:rw`。实际评测会检查 KVM API；doctor 不代表已验证 KVM 或 QEMU 启动。

CPU、内存使用平台现有评测资源预算。两版服务均分预算，总 CPU 至少为两版 metadata 中最大 `smp` 的两倍，总内存至少为 `2 × (最大 memory_mb + 512)` MiB。当前官方题目每版内存 2048 MiB、CPU 为 1 或 2，默认 4 CPU / 8192 MiB 可通过启动资源检查；并发容量与 TCG 耗时需部署后实测。

## 5. 部署验收

```bash
curl -fsS http://127.0.0.1:3001/health
bash scripts/evaluator-doctor.sh
```

自定义端口时替换 `3001`。doctor 校验资产、轨道和加速配置，不在冷缓存时启动 QEMU。真实验收应分别覆盖 userspace 和 kernel：

1. 用已知正确和错误提交运行判题，确认结果与预期一致，基础设施错误不能当作错误提交通过。
2. 创建单 Case 自动生成实验，确认客户端产出单文件 PoC（内核题为 C 源码）、根 Trace、提交物上传和独立 Evaluator 评测。
3. 检查编译失败、超时、取消的终态和错误详情，以及容器、网络和临时工作区清理。
4. 重启服务或清理受管镜像后重评已有提交，确认固定版本可恢复且历史实验快照未变。

原生对照验证工具的前提与操作见 [ZSoft 本机验证](benchmark-integration-development-guide.md#zsoft-接入前的本机验证)。只有镜像拉取或摘要校验通过，不能判定完整链路验收成功。

## 6. 排查与更新

| 现象或错误 | 处理 |
|---|---|
| 导入失败 | 检查 `zsoft-l1-bootstrap.log`、官方目录结构与来源版本，修复后单独重试导入 |
| `ZSOFT_TASKS_DIR_INVALID` / `ZSOFT_TASK_MISSING` | 在执行机核对 MCTS 配置、目录权限和题目是否存在 |
| `ZSOFT_SOURCE_MISSING` / `ZSOFT_SOURCE_INVALID` | 补齐原生公开源码或合法、固定版本的 source manifest 与 source lock |
| `ZSOFT_AGENT_BUNDLE_INVALID` | 核对客户端与插件版本、公开包内容及链接；不将私有判题文件加入公开包 |
| `ZSOFT_TASK_DIGEST_LEGACY` | 更新平台和 Controller，从匹配来源用 `--refresh --name` 安装独立数据集，再新建实验；旧快照不回写，重评旧实验不会更新冻结身份 |
| `ZSOFT_TASK_MISMATCH` | 核对平台、执行机任务和评测资产的题目内容与 revision，不跳过摘要校验 |
| `ZSOFT_KERNEL_KVM_UNAVAILABLE` | 检查宿主虚拟化和设备，或按实际条件切换 TCG 后重启 |
| `ZSOFT_KERNEL_RESOURCES_INSUFFICIENT` | 根据题目 metadata 提高评测 CPU、内存预算 |
| Runtime 依赖下载失败 | 检查构建网络与包源；默认华为云 PyPI、固定 `pydantic==2.10.6`，单次超时 60 秒、重试 5 次。`PIP_INDEX_URL` 是 Docker 构建参数，不能用 `--evaluator-env` 修改 |
| `ZSOFT_ARTIFACT_INVALID` / `ZSOFT_ARTIFACT_DIGEST_MISMATCH` | 检查三端版本与提交物归属、文件大小及 SHA-256，按错误日志定位，勿跳过校验 |

旧摘要排序问题通过新解析缓存版本修正；正确摘要不受影响，无需因此重发题目镜像。正式错误与可重试下载、空间等待分开处理，不应持续等待不可恢复的元数据错误。

更新 Runtime Dockerfile 或校验实现后，由维护者重新生成 Catalog，部署匹配平台和 Controller。已有 PoC 的 Case 可用“Benchmark 重评”复用提交。执行端更新需重新安装客户端；通用回滚见 [更新与回滚](service-deployment-guide.md#9-更新与回滚)。
