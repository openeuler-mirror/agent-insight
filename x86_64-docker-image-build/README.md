# x86_64 离线镜像打包

在 x86_64 Windows + Docker Desktop 上构建 `linux/amd64` 镜像，`docker save` 成 `.tar`，拷到目标机 `docker load` 运行。

## 目录

```text
build-image.bat                                  构建入口
make-dockerfile-single.ps1                       生成 Dockerfile.agent-insight.single
Dockerfile.agent-insight.single                  生成产物，勿手改
Dockerfile.agent-insight.single.dockerignore     同上
images/                                          agent-insight-<版本>-amd64.tar
SHA256SUMS / BUILD-INFO.txt                      校验和 / 构建信息
```

产物保持 `docker save` 的原样；再 `tar -czf` 压一层，`docker load` 会读不到 `manifest.json`。

## 换源

[make-dockerfile-single.ps1](make-dockerfile-single.ps1) 每次从仓库 [Dockerfile.local](../Dockerfile.local) 现生成，替换四处下载地址，另外拆出一个依赖阶段（见下节）：

| 环节 | 原地址 | 换成 |
|-|-|-|
| 基础镜像 | Docker Hub 的 `node:<仓库 tag>` | `swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/library/node:<tag>` |
| 系统依赖 | `deb.debian.org` | `mirrors.huaweicloud.com` |
| npm 依赖 | npmjs 官方源 | `repo.huaweicloud.com/repository/npm/` |
| Prisma 引擎 | `binaries.prisma.sh` | `registry.npmmirror.com/-/binary/prisma` |

`FROM`、`apt-get update`、`npm install` 三个锚点找不到会直接报错，不会产出偏离的 Dockerfile。

## 重复构建

脚本每次都完整跑一遍，不跳过。缓存是否命中看日志：标 `CACHED` 的就是直接用了上次的结果，没标的才重做。

为了能多省一些，生成的 Dockerfile 把「装依赖」单独放成一步。只改代码时，这一步不动，装好的 2GB 多 `node_modules` 直接复用，只重新编译打包。镜像里的构建时间标签也挪到了最后，时间变化不会连累前面的步骤。

## 运行

启动 Docker Desktop（Linux 容器模式）后：

```powershell
D:\trae_pro\agent-insight-g\x86_64-docker-image-build\build-image.bat
```

流程：生成 Dockerfile → `docker build --pull --platform linux/amd64` → 起临时容器自检（HTTP <500、`node -v`、`python3 -V`、`opencode`）→ `docker save` 并写 `SHA256SUMS` / `BUILD-INFO.txt`。版本取自仓库 `package.json`，tag 形如 `agent-insight:0.9.0-amd64`；一轮约 14 分钟，镜像 822MB。

要求：x86_64、Docker 可用内存 ≥8GB、磁盘 ≥20GB、能访问上表四个源。Docker 不走 Windows 系统代理，代理在 Docker Desktop → Settings → Resources → Proxies 里配。

## 部署

```bash
sha256sum -c SHA256SUMS
docker load -i images/agent-insight-0.9.0-amd64.tar

docker run -d --name agent-insight \
  -p 3000:3000 \
  -v /data/agent-insight:/data/agent-insight \
  agent-insight:0.9.0-amd64
```

## 常见问题

| 现象 | 处理 |
|-|-|
| `Docker daemon is not running` | 启动 Docker Desktop 并切到 Linux containers |
| 卡在 `Pulling .../node:20-bookworm-slim` | 网络/代理不通，检查 SWR 或配 Docker 代理 |
| `npm pack` 报 `ERR_OUT_OF_RANGE`，或构建上下文几百 MB | `.dockerignore` 没生效：确认与生成的 Dockerfile 同名同目录，别删脚本追加的 `**/*.tar` 规则 |
| 卡在 `Generating Prisma client...` | 引擎换源后仍卡，改内网镜像或代理 |
| `[ERROR] HTTP check failed` | 13000 被占用或内存不足，看 `docker logs ai-pkg-verify` |
| 生成 Dockerfile 报 `pattern not found` | 仓库 `Dockerfile.local` 改了写法，同步脚本里的锚点 |
