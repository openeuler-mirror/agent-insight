# x86_64 离线镜像打包

在带网络的 x86_64 Windows 机器上，用 Docker Desktop 把 Agent Insight 打成 `linux/amd64` 镜像，导出成 `docker save` 的 `.tar`，拷到任意 x86_64 Linux 主机上 `docker load` 即可运行。

**单文件构建**：系统依赖写在生成的 Dockerfile 内部 `base` 阶段，只装一次，builder 与 runtime 都从它开始；Node 版本每次从仓库 `Dockerfile.local` 现读，跟着代码仓走。

## 目录内容

```text
x86_64-docker-image-build/
├── build-image.bat                       # 构建脚本，四步走（唯一入口）
├── make-dockerfile-single.ps1            # 从仓库 Dockerfile.local 生成 Dockerfile.agent-insight.single
├── Dockerfile.agent-insight.single           # 生成产物，不要手改
├── Dockerfile.agent-insight.single.dockerignore  # 由脚本复制仓库清单并追加忽略规则
├── images/                               # 产物：agent-insight-<版本>-amd64.tar
├── SHA256SUMS                            # 产物校验和
└── BUILD-INFO.txt                        # 构建信息（时间/commit/镜像 ID/node 版本/耗时/sha256）
```

仓库代码只作为只读构建上下文，构建材料全部留在本目录。

## 为什么这样打包

仓库自带的 [Dockerfile.local](../Dockerfile.local) 直接构建时有四个外网瓶颈：

| 环节 | 默认行为 | 问题 |
|-|-|-|
| 基础镜像 | Docker Hub 的 `node:20-bookworm-slim` | 国内拉取慢，经常超时失败 |
| 系统依赖 | 每次构建都跑两次 `apt-get`，走 `deb.debian.org` | 慢，源一抖动构建直接失败 |
| npm 依赖 | npmjs 官方源 | 依赖树大，容易超时 |
| Prisma 引擎 | 从 `binaries.prisma.sh` 下载 | 国内经常卡死 |

对应的处理：

- **系统依赖只装一次**：生成的 Dockerfile 里有一个内部 `base` 阶段，仓库原本的两段 `apt-get` 合并成一次安装，builder 和 runtime 都 `FROM base`。
- **Node 版本跟着代码仓**：脚本每次构建都从 `Dockerfile.local` 的 `FROM ... AS builder` 那行取镜像，只把下载地址换成华为 SWR 镜像，版本号原样保留。仓库写 20 就是 20，改成 22 自动就是 22。
- **基础镜像始终是新的**：每次构建都带 `--pull`，上游 Node 小版本和 Debian 安全更新直接生效。
- **npm / Prisma 换源**：npm 走华为镜像，Prisma 引擎走 npmmirror。
- **加构建缓存**：`--mount=type=cache` 缓存 `/root/.npm` 和 `/src/.next/cache`，重复构建直接复用。

## 与代码仓保持一致

关键信息只有代码仓一个来源，对不上就停下，绝不悄悄打一个不一样的包：

1. **Node 版本**：只认 `Dockerfile.local` 里那行 `FROM`，每次构建重新读。
2. **前后同一个版本**：builder 与 runtime 必须是同一个基础镜像，脚本会比对，不一致直接报错。
3. **系统工具清单**：脚本逐字比对仓库里的两段 `apt-get install`；仓库增删工具而脚本没跟上，会报错而不是少装。
4. **装完自检**：起临时容器确认 `node -v`、`python3 -V`、`opencode` 都在，HTTP 首页返回 <500，缺一个就失败。
5. **结果留档**：`BUILD-INFO.txt` 记录实际用的 Node 镜像、实际 `node -v`、代码 commit、总耗时和 sha256。

已知代价：系统工具清单的**匹配文本**写死在脚本里，仓库改了构建文件写法（比如换成更复杂的多阶段）时必须同步改脚本——表现为构建前报错，不会产出错包。

## 脚本流程

`build-image.bat [repo-path]` 依次做四件事（`repo-path` 默认取本目录的上一级，即仓库根）：

1. **生成构建文件**。[make-dockerfile-single.ps1](make-dockerfile-single.ps1) 读仓库 `Dockerfile.local`，把 builder 的 `FROM` 换成内部 `base` 阶段、合并两段 `apt-get`、给 `npm install` 和 `npm run build` 加缓存挂载，其余逐行照搬；再把仓库根的 `Dockerfile.local.dockerignore` 复制过来，并追加本目录名与 `**/*.tar` / `**/*.tar.*` / `**/*.tgz`。
   追加这几行是必要的：构建上下文是整个仓库根，而 Docker 的 `*.tar` 规则只匹配上下文根目录，匹配不到 `images/*.tar`；已导出的离线包会被 `COPY . .` 带进镜像、被 Next 收进 `.next/standalone`，最终让 `npm pack` 打出超过 2GB 的包并以 `ERR_OUT_OF_RANGE: data is too long` 失败。
2. **构建镜像**。`docker build --pull --platform linux/amd64 -f Dockerfile.agent-insight.single -t agent-insight:<版本>-amd64 <仓库根>`，版本号取自仓库 `package.json`。
3. **自检**。起临时容器 `ai-pkg-verify`（映射 13000→3000，挂临时目录到 `/data/agent-insight`），轮询 HTTP 直到返回 <500，再进容器确认 `node -v`、`python3 -V` 和 `opencode` 可执行。任一步失败会打印最近 100 行日志并中止。
4. **导出交付包**。`docker save` 成 `images/agent-insight-<版本>-amd64.tar`（不再二次压缩），生成 `SHA256SUMS`（LF 换行）和 `BUILD-INFO.txt`。

每一步结束打印已耗时，末尾给出总耗时并写入 `build_elapsed_seconds`。

## 前提条件

### 硬件与系统

| 项 | 要求 |
|-|-|
| 架构 | **x86_64**。ARM（Apple Silicon、ARM Windows）靠 QEMU 模拟 amd64，几十倍慢，Next.js 编译常 OOM 失败 |
| 操作系统 | Windows（`.bat` 只能在 cmd 下跑） |
| 内存 | Docker Desktop 可用内存 ≥ 8GB |
| 磁盘 | 空闲 ≥ 20GB（现网实测：镜像约 820MB、交付包约 0.8GB，加上 node_modules、`.next` 与 build cache） |

### Docker Desktop

1. **Linux 容器模式**（不是 Windows 容器模式）。验证 `docker info --format "{{.OSType}}"` 输出 `linux`；否则托盘图标右键 → *Switch to Linux containers*。
2. **BuildKit 已启用**：Docker Desktop 默认开启，`docker buildx version` 能输出版本号即可，Dockerfile 里的缓存挂载语法只有 BuildKit 支持。

### 网络

构建时会联网下载下面四类内容，任一不通都会卡住：

| 用途 | 地址 |
|-|-|
| 基础镜像 | `swr.cn-north-4.myhuaweicloud.com` |
| Debian 软件包 | `mirrors.huaweicloud.com` |
| npm 包 | `repo.huaweicloud.com` |
| Prisma 引擎 | `registry.npmmirror.com` |

公司代理必须在 **Docker Desktop → Settings → Resources → Proxies** 里单独配，Docker 不走 Windows 系统代理。

## 运行

1. 启动 Docker Desktop，等守护进程就绪（`docker info` 能输出）。

2. 执行脚本：

   ```powershell
   D:\trae_pro\agent-insight-g\x86_64-docker-image-build\build-image.bat
   ```

版本号取自仓库 `package.json`，tag 形如 `agent-insight:0.9.0-amd64`。成功后终端打印镜像 tag、Node 版本、交付包路径、sha256 和总耗时。

参考量级（0.9.0 / commit `298d1d5b` / 首次构建后本地有缓存）：完整一轮约 14 分钟，其中构建 11 分钟、导出 `docker save` 约 2 分钟；镜像 822MB，交付包 0.77GB。

## 产物

```text
x86_64-docker-image-build/
├── images/agent-insight-<版本>-amd64.tar
├── SHA256SUMS
└── BUILD-INFO.txt
```

**不要再用 `tar -czf` 压一层**：会变成"tar 里套 tar"，目标机 `docker load` 读不到根目录的 `manifest.json` 会直接报错。

## 在目标机部署

```bash
sha256sum -c SHA256SUMS
docker load -i images/agent-insight-0.9.0-amd64.tar

docker run -d --name agent-insight \
  -p 3000:3000 \
  -v /data/agent-insight:/data/agent-insight \
  agent-insight:0.9.0-amd64
```

## 常见问题

| 现象 | 原因 | 处理 |
|-|-|-|
| `Docker daemon is not running` | Docker Desktop 没启动，或处于 Windows 容器模式 | 启动并切到 Linux containers |
| 卡在 `Pulling ...node:20-bookworm-slim` | 网络/代理不通 | 检查 SWR 可达性，或在 Docker Desktop 里配代理 |
| `npm pack` 报 `ERR_OUT_OF_RANGE: data is too long` | 构建上下文里混进了大文件（典型是已导出的 `images/*.tar`），被打进 `.next/standalone` 后 tgz 超过 2GB | 确认 `Dockerfile.agent-insight.single.dockerignore` 末尾有本目录名和 `**/*.tar` 等规则（脚本每次构建会自动追加），别手工删掉 |
| `load build context` 显示几百 MB 以上 | 忽略清单没生效 | 确认 `.dockerignore` 与 Dockerfile 同名同目录；清掉本目录外的其他大文件 |
| 卡在 `Generating Prisma client...` | 引擎从 `binaries.prisma.sh` 下载，国内常卡 | 已配 `PRISMA_ENGINES_MIRROR`；仍卡就换内网镜像或代理 |
| `[ERROR] HTTP check failed` | 13000 被占用，或构建内存不足导致容器起不来 | 换端口/释放端口，加大 Docker 内存；看 `docker logs --tail=100 ai-pkg-verify` |
| 生成 Dockerfile 时报 `pattern not found` | 仓库 `Dockerfile.local` 改了写法 | 按报错提示同步 [make-dockerfile-single.ps1](make-dockerfile-single.ps1) 里的匹配片段 |
| `docker load` 报 `manifest.json` / invalid tar | 手工把 tar 又压了一层 | 直接交付 `docker save` 的 `.tar` |
| 包太大需要分卷 | 单文件过大 | `split -b 2G` 分卷，落地 `cat` 合并后再校验 |
