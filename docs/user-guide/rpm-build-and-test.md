---
title: "RPM 构建与测试"
description: "从当前 Git commit 一键构建 Agent Insight RPM，并完成验包、安装、升级和服务测试。"
---

# RPM 构建与测试

本指南适用于在 openEuler 等 RPM 系 Linux 构建机上，将 Agent Insight 当前 Git commit 构建为二进制 RPM 和 SRPM，并在测试机或相似系统环境中完成安装验证。

## 环境要求

- 构建机使用 Linux x86_64 或 aarch64，并提供 `dnf` 软件源
- 源码目录是 Git 仓库，待打包代码已经提交
- 构建机自行安装 Node.js 20+ 与 npm；目标机需要已有 Node.js 20+，可以通过系统包、NodeSource、手工解压或 NVM 安装
- 构建机使用 root 执行，或已经预装脚本所需的 RPM 构建依赖

当前部分 npm 依赖更推荐 Node.js 22 LTS。Node.js 的具体发行版本和安装方式由环境维护者决定，不写入 RPM。RPM 不会联网下载 Node.js，但会自动发现目标机已有的兼容版本。

## 一键构建

进入需要打包的项目目录后执行：

```bash
bash scripts/build-rpm.sh
```

默认行为如下：

- 使用当前项目目录作为源码目录
- 通过 `git archive` 打包当前 HEAD，不自动拉取、切换或修改分支
- 从 `package.json` 读取 RPM Version
- 使用 UTC 构建时间和短 commit 生成唯一 Release
- 将工作目录、缓存和交付产物写入项目下的 `rpm-out/`
- 仅安装当前系统缺失的 RPM 构建依赖，版本由已启用的 `dnf` 软件源决定
- 根据构建环境自动探测 Prisma binary target，只打包这一套 Prisma 引擎
- 执行项目测试和 Next.js 生产构建

除构建脚本自身和输出目录外，源码目录存在未提交改动时，脚本会停止。这样 `BUILD-INFO.txt` 中记录的 commit 可以完整复现源码内容。

### 指定源码与输出目录

脚本可以在项目中直接执行，同时打包另一个代码目录：

```bash
bash scripts/build-rpm.sh \
  --source-dir /root/agent-insight \
  --output-dir /root/agent-insight-rpm
```

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--source-dir DIR` | 指定待打包 Git 仓库 |
| `--output-dir DIR` | 指定构建工作区和交付目录 |
| `--release VALUE` | 显式指定 RPM Release |
| `--skip-tests` | 构建时跳过项目测试 |
| `--no-install-deps` | 不通过 `dnf` 安装缺失的构建依赖 |
| `--npm-registry URL` | 使用内部 npm 仓库，并替换 lockfile 中的 registry 主机 |
| `--prisma-engines-mirror URL` | 使用内部 Prisma Engines 镜像 |

查看完整帮助：

```bash
bash scripts/build-rpm.sh --help
```

脚本支持 `x86_64` 和 `aarch64`。在 openEuler ARM64 构建机上会自动生成 `aarch64` RPM，并校验包内存在 `opencode-linux-arm64`；不需要在脚本中写死 openEuler 软件源地址，缺少的 RPM 构建依赖通过机器当前已启用的 `dnf` 仓库安装。

如果内部服务器不能访问公网 npm 或 Prisma 下载地址，可显式指定内部镜像：

```bash
bash scripts/build-rpm.sh \
  --source-dir /path/to/agent-insight \
  --output-dir /path/to/rpm-out \
  --npm-registry http://<internal-npm-registry>/ \
  --prisma-engines-mirror http://<internal-prisma-mirror>/
```

只配置了内部 openEuler RPM 软件源、但 npm 和 Prisma 下载仍可访问公网时，不需要传这两个镜像参数。

## 查看构建产物

每次构建会生成一个独立交付目录：

```text
<output-dir>/agent-insight-<version>-<release>.<arch>/
├── agent-insight-<version>-<release>.<arch>.rpm
├── agent-insight-<version>-<release>.src.rpm
├── agent-insight.spec
├── prepare-prisma-engine.js
├── agent-insight-node-setup
├── agent-insight-service
├── rpmbuild.log
├── BUILD-INFO.txt
└── SHA256SUMS
```

`BUILD-INFO.txt` 记录源码目录、分支、commit、构建 Node.js/npm/OpenSSL 版本、内置 OpenCode 版本、架构和 Prisma binary target。后续代码 commit 更新后可以直接再次运行脚本，新 Release 不会覆盖旧产物。

项目测试失败时，失败结果会写入 `rpmbuild.log`，RPM 构建会继续。交付前应检查日志中的测试汇总，分别判断项目测试结果和 RPM 构建结果。

## 验证 RPM

进入交付目录后先验证校验和：

```bash
sha256sum -c SHA256SUMS
```

查看包信息、运行依赖和文件列表：

```bash
RPM_FILE=$(find . -maxdepth 1 -type f -name 'agent-insight-*.rpm' ! -name '*.src.rpm' -print -quit)

rpm -qip "$RPM_FILE"
rpm -qpR "$RPM_FILE"
rpm -qlp "$RPM_FILE"
```

确认本次自动选择的 Prisma 引擎：

```bash
grep '^prisma_binary_target=' BUILD-INFO.txt
rpm -qlp "$RPM_FILE" | grep -E 'schema-engine-|libquery_engine-'
```

## 从构建机传输到测试机

测试机安装时必须迁移以下文件：

| 文件 | 是否必需 | 用途 |
| --- | --- | --- |
| `agent-insight-<version>-<release>.<arch>.rpm` | 必需 | 测试机实际安装的二进制 RPM |
| `SHA256SUMS` | 建议 | 确认传输后的 RPM 完整无损 |
| `BUILD-INFO.txt` | 建议 | 核对源码 commit、构建环境和 Prisma target |

`*.src.rpm`、`agent-insight.spec`、`prepare-prisma-engine.js` 和 `rpmbuild.log` 用于源码重建、审计与问题排查，不是测试机安装所必需的文件。特别注意：`*.src.rpm` 是源码 RPM，不能代替带有 `.x86_64.rpm` 或 `.aarch64.rpm` 后缀的二进制 RPM。

可以在构建机上将整个交付目录传到测试机：

```bash
scp -r <output-dir>/agent-insight-<version>-<release>.<arch> \
  root@<test-machine>:/root/
```

也可以只传输安装和校验需要的三个文件：

```bash
RELEASE_DIR=<output-dir>/agent-insight-<version>-<release>.<arch>

scp \
  "$RELEASE_DIR"/agent-insight-<version>-<release>.<arch>.rpm \
  "$RELEASE_DIR"/SHA256SUMS \
  "$RELEASE_DIR"/BUILD-INFO.txt \
  root@<test-machine>:/root/agent-insight-rpm-test/
```

传输完成后，在测试机进入文件所在目录，先确认二进制 RPM 确实存在：

```bash
ls -lh agent-insight-*.rpm
```

然后只校验待安装的二进制 RPM：

```bash
RPM_FILE=$(find . -maxdepth 1 -type f -name 'agent-insight-*.rpm' ! -name '*.src.rpm' -print -quit)
test -n "$RPM_FILE"
grep " ./$(basename "$RPM_FILE")$" SHA256SUMS | sha256sum -c -
```

必须看到 `OK` 才能继续安装。如果出现 `Payload SHA256 ... digest: BAD`、校验失败，或文件大小明显小于构建机上的原文件，说明传输不完整或文件已损坏，应重新传输二进制 RPM。

## 在测试机安装

目标机需要自行准备 Node.js 20+。Node.js 可以安装在系统目录，也可以由 root 或普通用户通过 NVM 安装：

```bash
node --version
npm --version
```

使用 `dnf` 安装 RPM，它会同时检查并安装包声明的系统依赖。RPM 将 `nodejs >= 20` 声明为弱依赖：如果当前软件源能够提供，`dnf` 会尝试安装；软件源无法提供时不会阻止 Agent Insight 安装，随后继续查找机器上已有的 Node.js。

```bash
sudo dnf install -y --nogpgcheck ./agent-insight-<version>-<release>.<arch>.rpm
```

安装后 `/usr/libexec/agent-insight-node-setup` 自动按以下顺序处理 Node.js：

1. 检查 `/usr/local/bin`、`/usr/bin`、`/bin`、`/opt/node/bin` 等系统路径
2. 复用之前已经准备好的 Agent Insight 私有 Node.js
3. 查找 root 和普通用户 NVM 目录中的 Node.js
4. 执行真实版本检查，只接受 Node.js 20+

如果系统路径中的 Node.js 可以由 `agent-insight` 用户直接运行，服务记录并使用它。如果 Node.js 位于 `/root/.nvm/` 等服务用户不能访问或不稳定的私有目录，安装脚本会把 Node 可执行文件复制到 `/var/lib/agent-insight/runtime/node`，不会创建指向私有目录的软链接，也不会修改用户全局的 `/usr/local/bin/node`。systemd 服务会把该私有运行目录加入 `PATH`，确保 RPM 内置 OpenCode 的 `#!/usr/bin/env node` 启动入口也能找到同一套 Node.js。

查看自动选择的路径和原始来源：

```bash
cat /var/lib/agent-insight/runtime/node-path
cat /var/lib/agent-insight/runtime/node-origin
```

通过 RPM 服务包装器验证最终运行时：

```bash
sudo -u agent-insight /usr/libexec/agent-insight-service check
```

RPM 已包含与构建架构匹配的 OpenCode。继续以服务用户验证内置 OpenCode，不需要在目标机额外全局安装：

```bash
sudo -u agent-insight env \
  PATH=/var/lib/agent-insight/runtime:/usr/lib/agent-insight/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
  /usr/lib/agent-insight/node_modules/.bin/opencode --version
```

该命令应输出 OpenCode 版本号。构建脚本也会检查 npm 启动入口和 Linux 原生二进制是否进入 RPM，并把版本写入 `BUILD-INFO.txt` 的 `bundled_opencode` 字段。

该命令成功输出版本后再启动服务。如果安装 RPM 时机器上完全没有 Node.js 20+，可以在之后安装 Node.js，再重新执行发现工具：

```bash
sudo /usr/libexec/agent-insight-node-setup
sudo -u agent-insight /usr/libexec/agent-insight-service check
```

默认安装位置：

| 内容 | 路径 |
| --- | --- |
| 应用 | `/usr/lib/agent-insight` |
| 环境配置 | `/etc/agent-insight/agent-insight.env` |
| 数据目录 | `/var/lib/agent-insight` |
| Node 运行时记录 | `/var/lib/agent-insight/runtime` |
| Node 发现工具 | `/usr/libexec/agent-insight-node-setup` |
| 服务包装器 | `/usr/libexec/agent-insight-service` |
| systemd 单元 | `/usr/lib/systemd/system/agent-insight.service` |

安装不会自动启动服务。检查配置后启动：

```bash
sudo systemctl start agent-insight.service
```

该命令只启动当前服务，不设置开机自动启动。

## 服务测试

检查服务和最近日志：

```bash
systemctl status agent-insight.service --no-pager
journalctl -u agent-insight.service --no-pager -n 100
```

默认监听 3000 端口。首页可能重定向到实际入口，因此同时检查首次响应和跟随跳转后的状态码：

```bash
curl -sS -D - -o /dev/null http://127.0.0.1:3000/
curl -sS -L -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

第二条命令应返回 `200`。还可以确认进程与端口：

```bash
systemctl show agent-insight.service \
  -p ActiveState -p SubState -p ExecMainStatus -p MainPID
ss -lntp | grep ':3000 '
```

## 停止服务

停止当前运行的服务：

```bash
sudo systemctl stop agent-insight.service
```

确认服务已经停止：

```bash
systemctl show agent-insight.service \
  -p ActiveState -p SubState -p MainPID
```

正常情况下 `ActiveState` 应为 `inactive`。停止服务不会删除 `/var/lib/agent-insight` 中的数据库和运行数据，也不会删除 `/etc/agent-insight/agent-insight.env`。需要再次运行时执行：

```bash
sudo systemctl start agent-insight.service
```

## 升级与重复打包

代码更新并提交后，在新的 HEAD 上重新执行同一条构建命令即可。升级测试机上的现有安装：

```bash
sudo dnf upgrade -y --nogpgcheck ./agent-insight-<new-version>-<new-release>.<arch>.rpm
sudo systemctl restart agent-insight.service
```

环境文件使用 RPM 的 `noreplace` 策略，升级时不会直接覆盖管理员已经修改的 `/etc/agent-insight/agent-insight.env`。升级后再次检查服务日志和 HTTP 状态。

## 迁移到其他机器

Prisma 引擎按构建机环境选择，RPM 适合部署到以下条件相近的机器：

- CPU 架构一致
- Linux 发行版及主要系统库版本相近
- OpenSSL ABI 与构建环境兼容
- 目标机已有符合项目要求的 Node.js；RPM 会自动兼容系统路径或 NVM 安装
- RPM 内置 OpenCode 的原生二进制与目标机 CPU 架构、libc 环境兼容

如果目标环境与测试构建机差异较大，应在与目标环境相同或相近的构建机上重新运行脚本，而不是复用原 RPM。
