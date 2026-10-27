# ZSoft 评测资产发布指南

本指南供接入包维护者构建、冻结和发布 ZSoft 评测资产。普通部署直接消费接入包固定版本，步骤见 [ZSoft 部署指南](deploy-zsoft.md)。平台数据导入、Agent Runtime 接入和资产发布是不同流程，发布操作不代表完成真实判题验收。

## 1. 发布前提

使用与平台接入包匹配的官方 revision 和构建依赖。准备独立、尚未冻结的源码快照；脚本不改外部源码目录，构建状态写入发布目录。构建机需 Docker、源码下载和基础镜像网络、官方 Python 依赖及足够空间；正式判题还需 Compose。

发布记录、权限和本机路径由发布者自行管理，不写入项目指南。以下 `/srv` 路径和版本占位符需替换为本次发布值。

## 2. Userspace 资产

SWR 只发布每题的目标环境，可使用同一公有仓库承载各题型镜像。当前 24 道正式非内核题包含 6 组 `vuln_image/fix_image` 和 18 组 `target_image/driver_image`，共 48 个镜像引用；共享镜像和层可复用。此处的 `--all-userspace` 不选择样例或内核题；内核题另按下节准备，也可用 `--all-tasks` 选择全部正式题。没有 `userspace` 标签的非内核服务题在平台读取时补齐标签，原始 `task.json` 不改写。平台 ZSoft Evaluator Runtime 在评测机本地准备，不上传 SWR；只准备 Case 镜像时无需构建 Runtime。

一道题对应一个 Case，Case 所需镜像数量由官方环境决定。`vuln_image/fix_image` 分别是漏洞版本和修复版本；`target_image/driver_image` 分别是目标服务环境和驱动环境。例如前两道 civetweb 题各生成漏洞、修复两个镜像，因此两题合计四个镜像引用。

### 准备独立快照并构建题目环境

```bash
cd /srv/agent-insight
ZSOFT_SOURCE=/path/to/official/benchmarks/vulnerability/zsoft-l1
ZSOFT_REVISION='7f7d675eff19eec27745ddcd24b1efaf398bb753'
ZSOFT_RELEASE='/srv/zsoft-releases/<新的版本目录>'
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

### 发布题目镜像并冻结评测资产

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

完整评测资产包含任务状态、Judge 输入和内核文件。以下发布流程使用公有 SWR，资产镜像与 Case 镜像共用仓库，通过 `assets-<release>` 标签区分；评测机匿名拉取，无需登录配置。此镜像只用于把固定 release 安装到评测机数据卷，MCTS 执行端仍使用自己的原生任务目录。

### 构建并发布完整资产镜像

```bash
ZSOFT_ASSET_IMAGE_REPOSITORY="$SWR_PREFIX/zsoft-l1-userspace-x86-64"
ZSOFT_ASSET_RELEASE='<本次唯一发布版本>'
python3 scripts/benchmark/build-zsoft-assets-image.py \
  --root "$ZSOFT_RELEASE/assets" \
  --repository "$ZSOFT_ASSET_IMAGE_REPOSITORY" \
  --release "$ZSOFT_ASSET_RELEASE" \
  --tag "assets-$ZSOFT_ASSET_RELEASE" --push
```

SWR 仓库保持公有。发布者将输出的 `repoDigests`、release ID、bundleDigest 和镜像内目录写入接入包 `evaluator.yaml` 的 `assets` 声明，再生成 Catalog。部署按 `repository@sha256:...` 固定版本，不使用可变 tag。脚本在构建前逐题重新校验冻结清单及文件摘要；镜像只含清单、框架、选定任务、任务状态和 release 元数据。

### 发布后清理

先完成上传、匿名读取和摘要核对，再生成冻结清单并打包私有资产。当前清单导出仍读取本地镜像 ID，因此不能在冻结前删除准备好的镜像。保留发布映射、冻结清单、私有资产包和日志；正式评测从公有 SWR 按固定摘要拉取，无需在构建机长期保留镜像层。

清理时仅移除本次发布映射中的本地 prepared tag 和 SWR tag，并先核对它们的实际 Image ID 与映射一致。其他标签或容器仍引用的共享镜像要保留。删除标签后，镜像层可能仍被 BuildKit 缓存引用；待本批全部构建完成后，再按缓存 ID 清理本次构建产生的闲置缓存。不要在仍有题目构建时清空共享缓存，也不要用带 `--volumes` 的全局清理命令。

## 3. 内核资产

每道内核题包含 `runner_image` 和漏洞版、修复版两套文件资产；runner 可与 userspace 镜像共用公有仓库。`bzImage`、`metadata.json`、模块及可选 rootfs 扩展文件进入冻结资产包，不作为 Docker 镜像引用。

构建机需 Linux 内核编译工具。Debian/Ubuntu 通常包括 `build-essential`、`flex`、`bison`、`bc`、`libelf-dev`、`libssl-dev`、`rsync`、`patch`、`cpio`、`kmod`。编译不要求本机运行 QEMU 或具备 KVM；实际评测的加速模式在评测机配置。

### 准备内核快照

```bash
cd /srv/agent-insight
ZSOFT_SOURCE=/path/to/official/benchmarks/vulnerability/zsoft-l1
ZSOFT_REVISION='7f7d675eff19eec27745ddcd24b1efaf398bb753'
ZSOFT_KERNEL_RELEASE='/srv/zsoft-releases/<新的内核版本目录>'
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

### 合并 userspace 与内核资产

可以直接读取 `/srv/zsoft-releases/<userspace版本>/assets` 的冻结资产，无需恢复已清理的 Docker 镜像；若只保留旧包，先将它解压到独立目录，再把该目录作为 `--root`。合并要求官方 revision 和框架文件摘要相同；同题存在冲突时拒绝合并。输出必须是源目录外的新文件。

```bash
python3 scripts/benchmark/pack-zsoft-assets.py \
  --root "/srv/zsoft-releases/<userspace版本>/assets" \
  --additional-root "$ZSOFT_KERNEL_RELEASE/assets" \
  --output "$ZSOFT_KERNEL_RELEASE/combined-private-assets.tar.gz"
```

该包包含合并后重新计算摘要的清单，覆盖 24 道 userspace 与 6 道内核题。发布者将其解压到独立快照，按前节构建并发布完整资产镜像，再更新接入包固定引用。评测机启动通用服务即可自动安装全量资产，默认使用 `tcg`，不必增加 ZSoft 启动参数。

## 4. 发布交付与验收

发布者交付固定镜像 digest、release ID、bundleDigest 和镜像内目录，更新 `benchmarks/zsoft-l1/evaluator/evaluator.yaml` 的 `assets` 声明并生成 Catalog：

```bash
npm run benchmark:catalog
```

平台与 Controller 部署同一份匹配 Catalog 的代码。完整资产版本、题目内容摘要及镜像 ID 的契约见 [Benchmark 接入开发规范](develop-benchmark.md#zsoft-公有镜像与冻结资产)。

按 [ZSoft 部署验收](deploy-zsoft.md#5-部署验收) 在实际评测环境验证 userspace 和内核题，保留正确/错误提交、编译失败、超时、取消和资源清理记录。镜像发布、匿名拉取及摘要核对成功只代表资产可分发，不代表 Judge、QEMU 或 MCTS 全链路已验收。
