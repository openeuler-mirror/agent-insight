# ZSoft 部署指南

本指南说明 ZSoft userspace 与内核题的执行任务目录、119 服务器镜像准备、公有 SWR 发布和评测资产安装。平台、执行客户端及 Evaluator 的通用安装步骤见 [Benchmark 整体服务安装指南](service-deployment-guide.md)。

## ZSoft 任务目录与执行器

ZSoft 是 Benchmark；MCTS 是执行器。平台直接读取官方题目目录，在线和离线都通过统一启动入口准备数据，无需导出中间数据集。

**平台机器在线准备：**

```bash
bash scripts/start.sh --benchmark zsoft-l1
```

首次启动自动获取官方仓库 `https://gitcode.com/linmalin/muyuan-sec.git` 的固定提交 `7f7d675eff19eec27745ddcd24b1efaf398bb753`，缓存到 `~/.agent-insight/benchmark-assets/zsoft-l1/`，解析 30 道正式题（24 道 userspace、6 道 kernel）并导入数据库。已安装时直接复用数据库，不访问来源。持续启用可在 `~/.agent-insight/.env` 设置 `AGENT_INSIGHT_BENCHMARK=zsoft-l1`。

**平台机器离线准备：** 将官方 L1 包目录或完整仓库放在本机目录，在上述配置文件设置：

```dotenv
ZSOFT_DATASET_SOURCE=/srv/datasets/zsoft-l1
```

L1 目录包含 `tasks/<task-id>/task.json` 与 `public/README.md`；完整仓库根目录内的 `benchmarks/vulnerability/zsoft-l1` 也能识别。仍运行同一启动命令，平台不需要 Docker、构建状态或私有判题资产。在线镜像可设置 HTTP(S) Git 仓库来源，`ZSOFT_DATASET_REVISION` 指定完整 40 位提交；离线按实际题目内容识别，有 Git 元数据时附带真实 revision。

无需重启服务的管理命令：

```bash
npx tsx scripts/benchmark/ensure-dataset.ts --benchmark zsoft-l1
# 显式读取新来源；已引用的数据集不能覆盖，用新名称安装新版本。
npx tsx scripts/benchmark/ensure-dataset.ts \
  --benchmark zsoft-l1 --refresh --name "ZSoft L1 新版本"
```

此前已安装的 24 题数据集不会自动扩容；使用上面的 `--refresh --name` 安装全量版本。在线缓存使用新的解析版本键，旧缓存不会被误判为损坏。旧 P2 JSON/JSONL 和 ZSoft 公开包工作区不再兼容，需从官方目录重新导入。历史实验不会自动迁移。题目身份使用 `task.json` 与公开文件内容的 `sourceTaskDigest`；私有判题材料和镜像构建摘要由评测机单独冻结，平台不以它们作为数据准备前置条件。

执行机准备原生 ZSoft 任务目录，结构为 `<tasks-dir>/<task-id>/task.json` 和 `<tasks-dir>/<task-id>/public/`。路径属于执行客户端所在机器，可以沿用上游仓库已有目录；若执行在用户机器，由用户准备该目录，平台不需要访问它。私有判题资产和正式镜像仍由 Evaluator 管理。

在实验向导中选择 ZSoft 数据集、生成 Trace 和执行客户端后，填写 **ZSoft 任务目录** 的绝对路径并保存。配置按用户、客户端 ID 和 Benchmark 保存，后续该客户端的 ZSoft 实验自动复用，也支持修改；IP 仅用于识别机器，不作为配置主键。切换到 SWE-bench 时隐藏此项。目录不是 Agent/MCTS 安装选项，`task-id` 由平台按所选 Case 下发。

创建实验时冻结当前目录。客户端收到 `zsoft-tasks` 工作区契约，核对题目 ID 和公开元数据，从原生目录复制 `public/` 与裁剪后的 `task.json` 到独立运行目录，不将私有判题文件交给 Agent，不改写原始任务。MCTS 使用该独立目录作为实际 `--tasks-dir`，生成单文件 PoC 和 Trace，客户端上传后清理运行目录。缺题返回 `ZSOFT_TASK_MISSING`；题目与数据集不一致返回 `ZSOFT_TASK_MISMATCH`。保存配置仅校验路径格式，文件存在性在执行机准备任务时检查。

客户端上报 `zsoft-tasks-workspace/v2`、`single-file/v1`；MCTS 还需 `mcts-zsoft-export/v1`。v2 包含 userspace 与 kernel 轨道，旧客户端需升级后重新上报能力。内核题仍使用同一个 `tasks-dir`，任务 ID 由平台下发，提交物为单文件 C 源码。

ZSoft 执行链路只接受 `zsoft-tasks` 工作区；旧公开包导出脚本不再用于当前接入，无需设置 `AGENT_INSIGHT_PUBLIC_BUNDLES_DIR`。

## ZSoft 镜像准备与公有 SWR 部署

镜像在 119 构建机准备；该机 MCTS 位于 `/mnt/sdc/ymt/MCTS`，正式评测镜像由官方 ZSoft L1 包的 `prepare` 构建，与 MCTS 搜索运行环境分开。以下是操作模板，需先将本次平台代码部署到 119，并替换源目录、版本和 SWR 地址。平台脚本不修改外部仓库；所有构建状态写在单独的资产快照中。

SWR 只发布每题的目标环境，沿用 SWE-bench 的区域和组织，使用一个公有仓库 `swr.cn-east-3.myhuaweicloud.com/agent-insight/zsoft-l1-userspace-x86-64`。当前 24 道正式非内核题包含 6 组 `vuln_image/fix_image` 和 18 组 `target_image/driver_image`，共 48 个镜像引用；共享镜像和层可复用。此处的 `--all-userspace` 不选择样例或内核题；内核题另按下节准备，也可用 `--all-tasks` 选择全部正式题。没有 `userspace` 标签的非内核服务题在平台读取时补齐标签，原始 `task.json` 不改写。平台 ZSoft Evaluator Runtime 在评测机本地准备，不上传 SWR；只准备 Case 镜像时无需构建 Runtime。

一道题对应一个 Case，Case 所需镜像数量由官方环境决定。`vuln_image/fix_image` 分别是漏洞版本和修复版本；`target_image/driver_image` 分别是目标服务环境和驱动环境。例如前两道 civetweb 题各生成漏洞、修复两个镜像，因此两题合计四个镜像引用。

**在 119 准备独立快照并构建题目环境：**

```bash
cd /mnt/sdc/ymt/agent-insight  # 使用已部署本次代码的平台目录
ZSOFT_SOURCE=/path/to/official/benchmarks/vulnerability/zsoft-l1
ZSOFT_REVISION='7f7d675eff19eec27745ddcd24b1efaf398bb753'
ZSOFT_RELEASE='/mnt/sdc/ymt/zsoft-releases/<新的版本目录>'
ZSOFT_PYTHON=/path/to/official/venv/bin/python
export PATH="$(dirname "$ZSOFT_PYTHON"):$PATH"
SWR_PREFIX='<swr区域域名>/<组织>'
mkdir -p "$ZSOFT_RELEASE"
cp -a "$ZSOFT_SOURCE" "$ZSOFT_RELEASE/assets"

python3 scripts/benchmark/prepare-zsoft-images.py plan \
  --root "$ZSOFT_RELEASE/assets" --revision "$ZSOFT_REVISION" --all-userspace
python3 scripts/benchmark/prepare-zsoft-images.py build \
  --root "$ZSOFT_RELEASE/assets" --revision "$ZSOFT_REVISION" --all-userspace \
  --python "$ZSOFT_PYTHON"
```

`ZSOFT_PYTHON` 使用已安装官方构建依赖的解释器，并将该解释器所在目录放在 `PATH` 前面，保证官方准备脚本的 `python3` 使用同一环境。`plan` 不调用 Docker；`build` 只顺序调用官方 `fetch-sources`、`prepare`，不运行 PoC 或 judge。可用重复的 `--task <id>` 替代 `--all-userspace`，先准备部分正式题。构建机需要源码下载和基础镜像拉取网络、Docker 及足够磁盘空间；正式评测另外需要 Compose。镜像体积由实际构建结果决定。

**发布到 SWR，再冻结评测资产：**

```bash
# 公有仓库的读取无需认证；写入端仍需按 SWR 控制台给出的命令 docker login。
# 登录凭据只用于构建机 docker push，不配置到评测镜像池。
python3 scripts/benchmark/prepare-zsoft-images.py publish \
  --root "$ZSOFT_RELEASE/assets" --revision "$ZSOFT_REVISION" --all-userspace \
  --repository "$SWR_PREFIX/zsoft-l1-userspace-x86-64" \
  --output "$ZSOFT_RELEASE/registry-images.json"

python3 scripts/benchmark/export-zsoft-dataset.py \
  --root "$ZSOFT_RELEASE/assets" --revision "$ZSOFT_REVISION" --all-userspace \
  --image-mapping "$ZSOFT_RELEASE/registry-images.json" \
  --output "$ZSOFT_RELEASE/source-metadata.json"
python3 scripts/benchmark/pack-zsoft-assets.py \
  --root "$ZSOFT_RELEASE/assets" --output "$ZSOFT_RELEASE/private-assets.tar.gz"
```

确认 SWR 题目仓库为公有；首次 push 自动创建的仓库可能默认私有，需要在控制台调整可见性。发布脚本使用 `<task-id>-<角色>-<Image ID 前16位>` 作为稳定 tag（过长的 task-id 自动截短），角色为 `vuln/fix/target/driver` 等。上传后核对远端 manifest 的 config digest，并记录 tag 和固定 `repo@sha256`。每个成功镜像立即保存到映射文件；失败后用相同参数重试可跳过已成功上传且摘要匹配的镜像。

`registry-images.json` 是 Case 镜像发布记录；`agent-insight-assets.json` 是冻结清单，记录私有文件摘要、本地 Image ID 与远端固定引用，以及题目的 `sourceTaskDigest`。本机构建摘要不参与平台数据集指纹；`source-metadata.json` 仅供资产审计，不需导入平台。冻结后不能再对该快照执行 build/publish；准备新版本应使用新目录。评测资产镜像从冻结清单覆盖的文件构建，不包含构建缓存、未选题目或 Docker 镜像层。

完整评测资产包含私有任务状态、Judge 输入和内核文件，资产镜像必须推送到**私有 SWR 仓库**，不能复用公开的 Case 镜像仓库。此镜像不是 Evaluator Runtime，也不会被 MCTS 执行端拉取；它只是把固定 release 搬运到评测机的数据卷。

**构建并发布私有资产镜像：**

```bash
ZSOFT_ASSET_IMAGE_REPOSITORY="$SWR_PREFIX/agent-insight-benchmark-assets-zsoft-l1"
ZSOFT_ASSET_RELEASE='20261014-v1'
python3 scripts/benchmark/build-zsoft-assets-image.py \
  --root "$ZSOFT_RELEASE/assets" \
  --repository "$ZSOFT_ASSET_IMAGE_REPOSITORY" \
  --release "$ZSOFT_ASSET_RELEASE" \
  --push
```

SWR 控制台中先将该资产仓库设为私有。保留命令输出的 `repoDigests`，后续按 `repository@sha256:...` 安装，不能用可变 tag 作为部署身份。脚本在构建前逐题重新校验冻结清单及文件摘要；镜像只含清单、框架、选定任务、任务状态和 release 元数据。

**上传后的构建机清理：**

先完成上传、匿名读取和摘要核对，再生成冻结清单并打包私有资产。当前清单导出仍读取本地镜像 ID，因此不能在冻结前删除准备好的镜像。保留发布映射、冻结清单、私有资产包和日志；正式评测从公有 SWR 按固定摘要拉取，无需在构建机长期保留镜像层。

清理时仅移除本次发布映射中的本地 prepared tag 和 SWR tag，并先核对它们的实际 Image ID 与映射一致。其他标签或容器仍引用的共享镜像要保留。删除标签后，镜像层可能仍被 BuildKit 缓存引用；待本批全部构建完成后，再按缓存 ID 清理本次构建产生的闲置缓存。不要在仍有题目构建时清空共享缓存，也不要用带 `--volumes` 的全局清理命令。

**在正式评测机部署资产和 Runtime：**

Controller 的 `/data` 命名卷与 Runtime 共享。ZSoft 与 SWE-bench 使用相同的 Runtime 准备流程：首次调用时复用摘要匹配的本地镜像；缺失时先尝试拉取，拉取失败后使用 Controller 中接入包的 Dockerfile 自动构建，并校验 Catalog artifact 摘要。启动 Controller 不会预热 Runtime。本方案不上传 Runtime，保持 `EVALUATOR_RUNTIME_IMAGE_PREFIX` 未设置；评测机需要访问构建基础镜像和 Python 依赖的网络。资产镜像则由独立私有 SWR 仓库拉取并安装到 Controller 的 `/data` 命名卷：

```bash
bash scripts/evaluator.sh start \
  --platform-base-url <平台地址>
docker inspect agent-insight-benchmark-evaluator --format '{{json .Mounts}}'

# 安装前确认 SWR 登录态有私有仓库拉取权限；传入固定 digest。
bash scripts/benchmark/install-zsoft-assets-image.sh \
  --image "$ZSOFT_ASSET_IMAGE_REPOSITORY@sha256:<资产镜像摘要>" \
  --release "$ZSOFT_ASSET_RELEASE"

# Controller 的首次部署或更换 release 时配置对应目录。
bash scripts/evaluator.sh start \
  --platform-base-url <平台地址> \
  --evaluator-env ZSOFT_L1_ASSETS_DIR=/data/benchmark-assets/zsoft-l1/releases/20261014-v1
```

安装脚本要求 digest 和 release ID，先校验镜像中的 release metadata、bundleDigest 及每道题的冻结文件，再复制到共享卷；目标 release 已存在时拒绝覆盖。每次更新使用新 release ID，旧目录保留到确认没有评测任务使用后再按运维流程清理。启动 Controller 时将 `ZSOFT_L1_ASSETS_DIR` 指向所选 release；平台按第一节独立获取并导入官方目录，执行机配置自己的公开原生任务目录。完整资产镜像只在评测机使用，执行机/MCTS 仍按原流程使用公开 `tasks-dir`。评测机无需数据库。评测任务携带 `taskId`、`sourceTaskDigest` 和可选 revision，评测端与本机清单匹配后执行；平台有 revision 时严格核对，无 Git 元数据的离线题按内容摘要匹配。导入已有 PoC 无需配置执行任务目录。

评测端对公有 SWR 匿名拉取，无需 registry 认证配置。题目镜像由公共镜像池按固定摘要拉取、缓存、回收；重评或回收后重拉均使用同一摘要。Runtime 校验实际 Image ID 与冻结清单一致，Compose 使用 Image ID 且禁止自动 pull，因此无需覆盖原始 tag。当前清单未配置 `registryImages` 时需在本机预装固定 Image ID，不能在冷缓存下从远端恢复。缺少 `sourceTaskDigest` 的旧评测资产清单不再支持，需重新冻结。

本地 Runtime 的标签和 Catalog artifact 摘要必须匹配，后续调用直接复用；接入包内容变化会生成新标签并重新准备。需要避免首次评测等待构建，或评测机离线时，可提前用与 Controller 一致的平台源码执行 `node scripts/benchmark/build-evaluator-runtime.cjs zsoft-l1`，不传 `--push`、`--image-prefix`，也可通过 `docker save/load` 搬运匹配版本。采用远端题目清单时 doctor 不要求所有题目镜像预先缓存，实际评测逐题验证。首次调用可能等待 Runtime 构建及题目镜像下载，构建失败会返回错误，恢复网络或依赖来源后可重试。该自动构建仅针对平台 Runtime；Case 镜像和冻结评测资产仍按前述发布流程提前准备。`EVALUATOR_RUNTIME_IMAGE_PREFIX` 仍是通用的可选远端 Runtime 配置，本部署方案不使用它。

当前已在 119 完成官方提交 `7f7d675eff19eec27745ddcd24b1efaf398bb753` 的 24 道正式 userspace 题构建和发布，公有 SWR 仓库包含 48 个 tag，全部通过匿名读取与 manifest/config 摘要核对。发布目录为 `/mnt/sdc/ymt/zsoft-releases/20261012-swr-v1`，包含 `registry-images.json`、`assets/agent-insight-assets.json`、`private-assets.tar.gz`、`anonymous-verification.json` 和日志。

冻结与打包完成后，已移除本次 96 个本地 prepared/SWR 标签，并定向清理本批闲置构建缓存，释放约 5.73 GiB。其他镜像、容器和卷保留，共享层仍可能由其他镜像或历史缓存引用。此次未准备 Runtime、部署评测服务或运行 PoC/judge；这些步骤及真实题目验收仍需后续执行。

## 内核题资产准备与部署

内核题仍使用同一个 ZSoft Evaluator Runtime。QEMU、C 编译工具和 rootfs 生成工具由官方 Case 的 runner 镜像提供，不需要新增平台 Runtime。每道内核题包含一个 `runner_image` 引用和漏洞版、修复版两套内核资产；6 道正式题合计 6 个 runner 镜像引用、12 套内核资产，实际镜像 ID 和层可能共享。runner 发布到 SWR，`bzImage`、`metadata.json` 及可选模块/rootfs 扩展文件通过私有资产包分发，不上传为 Docker 镜像。

内核 runner 可以与 userspace 镜像共用公有仓库，无需按题型另建仓库。119 本次沿用 `swr.cn-east-3.myhuaweicloud.com/agent-insight/zsoft-l1-userspace-x86-64`；名字中的 `userspace` 不限制镜像内容，发布脚本以任务 ID、角色和镜像 ID 生成独立标签，评测使用固定 digest。保留仓库名称可以继续使用已有 userspace 引用；若以后迁移仓库，需要重新发布并冻结新的引用。

构建机需要 Docker、官方 Python 构建依赖和 Linux 内核编译工具；Debian/Ubuntu 上通常包括 `build-essential`、`flex`、`bison`、`bc`、`libelf-dev`、`libssl-dev`、`rsync`、`patch`、`cpio`、`kmod`。源码编译在构建机执行，预留磁盘、内存及编译时间；无需在构建机运行 QEMU 或准备 KVM。公有仓库允许匿名拉取，上传仍需要有推送权限的有效 SWR 登录凭据。

**119 已准备的内核发布（2026-10-14）：** 固定官方 revision 为 `7f7d675eff19eec27745ddcd24b1efaf398bb753`，发布目录为 `/mnt/sdc/ymt/zsoft-releases/20261014-kernel-v1`。6 道内核题已准备 12 套内核资产，runner 的 6 个任务标签全部上传并通过匿名读取、manifest digest 和 config digest 核对；实际共用 2 个不同镜像 digest。024 题复用了历史构建资产，复制前核对框架源码、任务文件及源码锁一致，复制后核对资产摘要；其余 5 题执行了本次官方 `prepare` 构建。GitHub 源码下载限流通过同一固定提交的本地源码缓存绕过；初次上传权限错误已重试成功。

该目录保存 `registry-images.json`、`assets/agent-insight-assets.json`、`reuse-provenance.json`、逐题日志，以及以下包和核对记录：

| 文件 | 内容 |
|---|---|
| `private-assets.tar.gz` | 6 道内核题、12 套内核资产，约 353 MiB |
| `combined-private-assets.tar.gz` | 已有 24 道 userspace 与 6 道内核题的合并资产，约 353 MiB；后续完整部署可使用此包 |
| `anonymous-verification.json` | 6 个 runner 引用匿名核对全部通过，仓库共 54 个标签 |
| `package-verification.json` | 包文件 SHA-256、大小、题目及内核资产数量 |
| `archive-content-verification.json` | 归档内各文件摘要和 bundleDigest 的核对结果 |

本次生成的 `source`、`out`、`modules-install` 中间目录已定向清理；保留最终资产、源码缓存和本地 runner 标签。旧 userspace 发布目录未覆盖。本次没有构建 Runtime、安装到评测机或运行 QEMU、PoC、Judge；这些属于后续统一部署和实题验证。

**在 119 使用独立快照准备内核资产：**

```bash
cd /mnt/sdc/ymt/agent-insight
ZSOFT_SOURCE=/path/to/official/benchmarks/vulnerability/zsoft-l1
ZSOFT_REVISION='7f7d675eff19eec27745ddcd24b1efaf398bb753'
ZSOFT_KERNEL_RELEASE='/mnt/sdc/ymt/zsoft-releases/<新的内核版本目录>'
ZSOFT_PYTHON=/path/to/official/venv/bin/python
export PATH="$(dirname "$ZSOFT_PYTHON"):$PATH"
SWR_PREFIX='<swr区域域名>/<组织>'
mkdir -p "$ZSOFT_KERNEL_RELEASE"
cp -a "$ZSOFT_SOURCE" "$ZSOFT_KERNEL_RELEASE/assets"

python3 scripts/benchmark/prepare-zsoft-images.py plan \
  --root "$ZSOFT_KERNEL_RELEASE/assets" --revision "$ZSOFT_REVISION" --all-kernel
python3 scripts/benchmark/prepare-zsoft-images.py build \
  --root "$ZSOFT_KERNEL_RELEASE/assets" --revision "$ZSOFT_REVISION" --all-kernel \
  --python "$ZSOFT_PYTHON"
python3 scripts/benchmark/prepare-zsoft-images.py publish \
  --root "$ZSOFT_KERNEL_RELEASE/assets" --revision "$ZSOFT_REVISION" --all-kernel \
  --repository "$SWR_PREFIX/zsoft-l1-userspace-x86-64" \
  --output "$ZSOFT_KERNEL_RELEASE/registry-images.json"
python3 scripts/benchmark/export-zsoft-dataset.py \
  --root "$ZSOFT_KERNEL_RELEASE/assets" --revision "$ZSOFT_REVISION" --all-kernel \
  --image-mapping "$ZSOFT_KERNEL_RELEASE/registry-images.json" \
  --output "$ZSOFT_KERNEL_RELEASE/source-metadata.json"
python3 scripts/benchmark/pack-zsoft-assets.py \
  --root "$ZSOFT_KERNEL_RELEASE/assets" \
  --output "$ZSOFT_KERNEL_RELEASE/private-assets.tar.gz"
```

`build` 仅调用官方 `fetch-sources` 和 `prepare`，不运行 Judge 或 PoC。请从未冻结的官方源码目录复制快照；不要复制已有 `agent-insight-assets.json`，也不要覆盖已发布的 userspace 快照。冻结清单必须覆盖 `.task-state/<task-id>/image-refs.json` 以及两版 `artifacts/` 中的全部文件；打包排除同级源码、编译输出和缓存目录。先发布、核对匿名读取和镜像摘要，再冻结打包，之后按前节定向清理本批镜像及闲置编译缓存，保留内核文件资产及发布记录。

**与现有 userspace 资产合并：**

可以直接读取 `/mnt/sdc/ymt/zsoft-releases/20261012-swr-v1/assets` 的冻结资产，无需恢复已清理的 Docker 镜像；若只保留旧包，先将它解压到独立目录，再把该目录作为 `--root`。合并要求官方 revision 和框架文件摘要相同；同题存在冲突时拒绝合并。输出必须是源目录外的新文件。

```bash
python3 scripts/benchmark/pack-zsoft-assets.py \
  --root /mnt/sdc/ymt/zsoft-releases/20261012-swr-v1/assets \
  --additional-root "$ZSOFT_KERNEL_RELEASE/assets" \
  --output "$ZSOFT_KERNEL_RELEASE/combined-private-assets.tar.gz"
```

该包包含合并后重新计算摘要的清单，覆盖 24 道 userspace 与 6 道内核题。将它复制到评测机并解压，按前节方式安装到新的共享数据卷目录，例如 `/data/benchmark-assets/zsoft-l1-full-v1`，然后启动对应配置：

```bash
bash scripts/evaluator.sh start \
  --platform-base-url <平台地址> \
  --evaluator-env ZSOFT_L1_ASSETS_DIR=/data/benchmark-assets/zsoft-l1-full-v1 \
  --evaluator-env ZSOFT_KERNEL_ACCEL=tcg
```

加速模式默认 `tcg`，无需 `/dev/kvm`，但启动和执行可能较慢，实际超时预算待统一实题测试确定。此前检查 119 未提供 `/dev/kvm`，因此当前以 TCG 为部署起点；需要 KVM 时应先由宿主机开启虚拟化或嵌套虚拟化，再改为 `--evaluator-env ZSOFT_KERNEL_ACCEL=kvm`。平台 Runtime 本身无需设备或 privileged 权限，受控代理只向实际 runner 开放 `/dev/kvm:rw`；实际评测在拉取 runner 后检查 KVM API，失败返回 `ZSOFT_KERNEL_KVM_UNAVAILABLE`。doctor 只检查资产与加速配置，不代表已验证 KVM 或 QEMU 启动。

评测 CPU、内存预算仍通过平台现有资源配置传入。代理按 `vuln/fix` 两个服务均分，要求总 CPU 至少为两版 metadata 中最大 `smp` 的两倍，总内存至少为 `2 × (最大 memory_mb + 512)` MiB，不满足返回 `ZSOFT_KERNEL_RESOURCES_INSUFFICIENT`。当前官方 6 题每版内存为 2048 MiB、CPU 为 1 或 2，现有默认 4 CPU / 8192 MiB 满足此启动检查；并发容量及 TCG 耗时仍需部署后测定。平台全量数据集、执行客户端 v2 能力和对应原生任务目录也需同步准备。

后续统一验证应覆盖 userspace 与内核题的正确/错误提交、编译失败、超时、取消、资源清理，以及 MCTS 单文件 C 导出到独立评测机的完整链路。本次内核资产已构建、发布并冻结，但没有执行这些真实验证，也没有构建或上传平台 Runtime。
