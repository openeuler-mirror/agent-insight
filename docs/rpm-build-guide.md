# Agent Insight 830 分支 RPM 构建指南

本文用于在 `119.3.152.42` 上重复构建、验证和分发 Agent Insight `830` 分支的 RPM。

构建基线：openEuler 24.03 LTS-SP2、`x86_64`、Node.js 20.18.2、npm 10.8.2。源码位于 `/home/ymt/agent-insight`，构建产物写入 `/mnt/sdc/ymt/agent-insight-rpm`。

## 1. 必须遵守的规则

- 源码必须位于干净的 `830` 分支，构建前记录 commit。
- 当前应用版本固定为 `0.7.0`；若 `package.json` 版本变化，必须同步修改 spec 和产物路径。
- 每次源码 commit 变化都必须递增 `PACKAGE_RELEASE`，例如 `0.830.1` → `0.830.2`，不得用不同代码覆盖同一 NEVRA。
- 使用普通用户 `ymt` 构建；`root` 只负责安装工具、授权目录和安装验证。
- 测试失败仅记录告警，不阻塞；`npm ci`、`npm run build`、standalone 准备和 RPM 阶段失败仍会阻塞。
- RPM 内置官方 Node.js 20.18.2，目标服务器已有 Node.js 18 或 22 均不影响服务启动。
- RPM 不包含密钥；模型 API Key 等配置只在目标服务器填写。
- 当前包适用于 openEuler 22.03/24.03 `x86_64` glibc 环境，同时内置 OpenSSL 1.1 和 3.0 对应的 Prisma 引擎，安装后约占 1.8 GiB。

## 2. 首次构建准备

以 `root` 登录：

```bash
ssh root@119.3.152.42
```

检查构建工具；版本已经正确时不要重复安装：

```bash
/usr/bin/node --version 2>/dev/null || true
/usr/bin/npm --version 2>/dev/null || true
rpm -q nodejs npm rpm-build rpmdevtools
```

缺失或版本不正确时，先预览事务，再执行安装：

```bash
dnf install --assumeno \
  'nodejs-1:20.18.2-7.oe2403.x86_64' \
  'npm-1:10.8.2-1.20.18.2.7.oe2403.x86_64' \
  rpm-build rpmdevtools gcc gcc-c++ make python3 python3-pip \
  curl openssl openssl-devel tar gzip cpio xz

dnf install -y \
  'nodejs-1:20.18.2-7.oe2403.x86_64' \
  'npm-1:10.8.2-1.20.18.2.7.oe2403.x86_64' \
  rpm-build rpmdevtools gcc gcc-c++ make python3 python3-pip \
  curl openssl openssl-devel tar gzip cpio xz
```

如果系统 RPM 管理的 Node/npm 高于指定版本而安装命令未降级，改用：

```bash
dnf downgrade -y \
  'nodejs-1:20.18.2-7.oe2403.x86_64' \
  'npm-1:10.8.2-1.20.18.2.7.oe2403.x86_64'
```

创建构建目录：

```bash
install -d -o ymt -g ymt -m 0755 \
  /mnt/sdc/ymt/agent-insight-rpm \
  /mnt/sdc/ymt/agent-insight-rpm/rpmbuild/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS} \
  /mnt/sdc/ymt/agent-insight-rpm/{npm-cache,tmp,build-data,release}

chown -R ymt:ymt /home/ymt/agent-insight
df -h / /mnt/sdc
```

## 3. 每次代码更新后构建

进入 `ymt` 的 Bash 环境：

```bash
su --login --shell /bin/bash ymt

export PATH=/usr/bin:/bin:/usr/sbin
export RPM_TOPDIR=/mnt/sdc/ymt/agent-insight-rpm/rpmbuild
export RPM_TMPDIR=/mnt/sdc/ymt/agent-insight-rpm/tmp
export npm_config_cache=/mnt/sdc/ymt/agent-insight-rpm/npm-cache
export TMPDIR=/mnt/sdc/ymt/agent-insight-rpm/tmp
export AGENT_INSIGHT_DATA_DIR=/mnt/sdc/ymt/agent-insight-rpm/build-data
```

确认 Node/npm：

```bash
node --version
npm --version
node -p 'process.execPath'
```

预期为 `v20.18.2`、`10.8.2`、`/usr/bin/node`。

### 3.1 更新并锁定源码

如果构建远端最新的 `origin/830`：

```bash
cd /home/ymt/agent-insight
git remote -v
git fetch origin 830
git switch 830
git merge --ff-only origin/830
```

如果构建指定 commit，则不要合并远端，确保该 commit 已位于本地 `830` 分支。

统一检查：

```bash
git branch --show-current
git status --short
git diff --check
git log -1 --oneline
test "$(/usr/bin/node -p 'require("./package.json").version')" = '0.7.0'
test "$(git branch --show-current)" = '830'
test -z "$(git status --short)"

export SOURCE_COMMIT=$(git rev-parse HEAD)
printf 'SOURCE_COMMIT=%s\n' "$SOURCE_COMMIT"
```

### 3.2 设置本次 RPM Release

每次源码变化都使用一个从未分发过的新值：

```bash
export PACKAGE_RELEASE=0.830.3
export BUILD_LOG="/mnt/sdc/ymt/agent-insight-rpm/rpmbuild-${PACKAGE_RELEASE}.log"

test ! -e "$RPM_TOPDIR/RPMS/x86_64/agent-insight-0.7.0-${PACKAGE_RELEASE}.x86_64.rpm"
test ! -e "$RPM_TOPDIR/SRPMS/agent-insight-0.7.0-${PACKAGE_RELEASE}.src.rpm"
```

### 3.3 生成源码包和私有 Node 运行时

```bash
cd /home/ymt/agent-insight

git archive \
  --format=tar.gz \
  --prefix=agent-insight-0.7.0/ \
  --output="$RPM_TOPDIR/SOURCES/agent-insight-0.7.0.tar.gz" \
  "$SOURCE_COMMIT"

cd "$RPM_TOPDIR/SOURCES"
curl -fL \
  -o node-v20.18.2-linux-x64.tar.xz \
  https://nodejs.org/dist/v20.18.2/node-v20.18.2-linux-x64.tar.xz
curl -fL \
  -o SHASUMS256.txt \
  https://nodejs.org/dist/v20.18.2/SHASUMS256.txt
grep ' node-v20.18.2-linux-x64.tar.xz$' SHASUMS256.txt |
  sha256sum -c -
```

不要复制 openEuler 的 `/usr/bin/node`，它依赖系统 `libnode.so`，不能作为独立运行时分发。

## 4. RPM 配置文件

以下四个文件首次创建后可以复用；变更时必须与本文保持一致。

### 4.1 `$RPM_TOPDIR/SOURCES/agent-insight.env`

```ini
NODE_ENV=production
NEXT_TELEMETRY_DISABLED=1
HOSTNAME=0.0.0.0
PORT=3000
HOME=/var/lib/agent-insight
AGENT_INSIGHT_DATA_DIR=/var/lib/agent-insight
DATABASE_URL=file:/var/lib/agent-insight/data/witty_insight.db
OPENCODE_BIN=/usr/lib/agent-insight/node_modules/.bin/opencode
```

### 4.2 `$RPM_TOPDIR/SOURCES/agent-insight.service`

```ini
[Unit]
Description=Agent Insight Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agent-insight
Group=agent-insight
WorkingDirectory=/usr/lib/agent-insight
Environment=PATH=/usr/lib/agent-insight/runtime/bin:/usr/lib/agent-insight/node_modules/.bin:/usr/bin:/bin
EnvironmentFile=-/etc/agent-insight/agent-insight.env
ExecStartPre=/usr/lib/agent-insight/runtime/bin/node /usr/lib/agent-insight/node_modules/prisma/build/index.js db push --skip-generate --schema /usr/lib/agent-insight/prisma/schema.prisma
ExecStart=/usr/lib/agent-insight/runtime/bin/node /usr/lib/agent-insight/server.js
Restart=on-failure
RestartSec=5
TimeoutStartSec=600
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/agent-insight

[Install]
WantedBy=multi-user.target
```

### 4.3 `$RPM_TOPDIR/SOURCES/prepare-prisma-multi-engine.js`

该脚本只修改 RPM 构建工作区：为生成的 Prisma Client 准备 OpenSSL 1.1/3.0 两套 query engine，并把两套 schema engine 放入 `@prisma/engines`。它不会修改 Git 源码工作区。

```js
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')

const targets = ['debian-openssl-1.1.x', 'debian-openssl-3.0.x']
const root = process.cwd()
const requireFromRoot = createRequire(path.join(root, 'package.json'))
const { BinaryType, download } = requireFromRoot('@prisma/fetch-engine')
const { enginesVersion } = requireFromRoot('@prisma/engines')
const schemaPath = path.join(root, 'prisma', 'schema.prisma')
const buildSchemaPath = path.join(root, 'prisma', 'schema.rpm.prisma')
const enginesPath = path.join(root, 'node_modules', '@prisma', 'engines')

async function main() {
  const schema = fs.readFileSync(schemaPath, 'utf8')
  const buildSchema = schema.replace(
    /generator client \{\n/,
    `generator client {\n  binaryTargets = [${targets.map((target) => `"${target}"`).join(', ')}]\n`,
  )
  if (buildSchema === schema) throw new Error('Unable to add RPM binaryTargets')

  fs.writeFileSync(buildSchemaPath, buildSchema)
  try {
    await download({
      binaries: { [BinaryType.SchemaEngineBinary]: enginesPath },
      binaryTargets: targets,
      version: enginesVersion,
      showProgress: true,
    })
    const result = spawnSync(
      process.execPath,
      ['node_modules/prisma/build/index.js', 'generate', '--schema', buildSchemaPath],
      { stdio: 'inherit' },
    )
    if (result.status !== 0) throw new Error(`Prisma generate failed: ${result.status}`)
  } finally {
    fs.rmSync(buildSchemaPath, { force: true })
  }

  const expected = [
    ...targets.map((target) => path.join(enginesPath, `schema-engine-${target}`)),
    ...targets.map((target) =>
      path.join(root, 'node_modules', '.prisma', 'client', `libquery_engine-${target}.so.node`),
    ),
  ]
  for (const file of expected) {
    fs.accessSync(file, fs.constants.R_OK)
    console.log(`Prisma RPM engine ready: ${path.relative(root, file)}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
```

### 4.4 `$RPM_TOPDIR/SPECS/agent-insight.spec`

```spec
%global debug_package %{nil}
%global __strip /bin/true
%{!?package_release:%global package_release 0.830.3}

Name:           agent-insight
Version:        0.7.0
Release:        %{package_release}%{?dist}
Summary:        Agent Skill evaluation and observability platform
License:        MIT
URL:            https://atomgit.com/openeuler/agent-insight

Source0:        %{name}-%{version}.tar.gz
Source1:        agent-insight.service
Source2:        agent-insight.env
Source3:        node-v20.18.2-linux-x64.tar.xz
Source4:        prepare-prisma-multi-engine.js

BuildArch:      x86_64
AutoReqProv:    no
BuildRequires:  nodejs = 1:20.18.2-7.oe2403
BuildRequires:  npm = 1:10.8.2-1.20.18.2.7.oe2403
BuildRequires:  xz
Requires:       systemd
Requires:       python3
Requires:       curl
Requires:       openssl
Requires(pre):  shadow-utils

%global appdir %{_prefix}/lib/%{name}
%global datadir %{_sharedstatedir}/%{name}
%global unitdir /usr/lib/systemd/system

%description
Agent Insight is an Agent Skill evaluation and observability platform.
This package includes a private Node.js 20.18.2 runtime.

%prep
%autosetup -n %{name}-%{version}

%build
export PATH=/usr/bin:/bin
export HOME=%{_builddir}/agent-insight-build-home
export AGENT_INSIGHT_DATA_DIR=%{_builddir}/agent-insight-build-data
export npm_config_cache=%{_topdir}/../npm-cache
export TMPDIR=%{_tmppath}
mkdir -p "$HOME" "$AGENT_INSIGHT_DATA_DIR" "$npm_config_cache" "$TMPDIR"
/usr/bin/npm ci
/usr/bin/node %{SOURCE4}
set +e
find test -type f -name '*.test.ts' -print0 | \
  xargs -0 /usr/bin/node --import tsx --test
TEST_STATUS=$?
set -e
if [ "$TEST_STATUS" -ne 0 ]; then
  echo "WARNING: test suite failed with exit code $TEST_STATUS; continuing RPM build" >&2
fi
/usr/bin/npm run build
/usr/bin/node scripts/prepare-npm-package.js
/usr/bin/npm prune --omit=dev
test -x node_modules/@prisma/engines/schema-engine-debian-openssl-1.1.x
test -x node_modules/@prisma/engines/schema-engine-debian-openssl-3.0.x
test -r node_modules/.prisma/client/libquery_engine-debian-openssl-1.1.x.so.node
test -r node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node

%install
rm -rf %{buildroot}
install -d %{buildroot}%{appdir}
cp -a .next/standalone/. %{buildroot}%{appdir}/
install -d %{buildroot}%{appdir}/node_modules
cp -a node_modules/. %{buildroot}%{appdir}/node_modules/
install -d %{buildroot}%{appdir}/runtime
tar -xJf %{SOURCE3} -C %{buildroot}%{appdir}/runtime --strip-components=1
install -D -m 0644 %{SOURCE1} %{buildroot}%{unitdir}/%{name}.service
install -D -m 0640 %{SOURCE2} %{buildroot}%{_sysconfdir}/%{name}/%{name}.env
install -d -m 0750 %{buildroot}%{datadir}
install -d -m 0750 %{buildroot}%{datadir}/data

%pre
getent group agent-insight >/dev/null || groupadd -r agent-insight
getent passwd agent-insight >/dev/null || \
  useradd -r -g agent-insight -d /var/lib/agent-insight \
    -s /sbin/nologin -c "Agent Insight service" agent-insight

%post
/usr/bin/systemctl daemon-reload >/dev/null 2>&1 || :

%preun
if [ "$1" -eq 0 ]; then
  /usr/bin/systemctl disable --now agent-insight.service >/dev/null 2>&1 || :
fi

%postun
/usr/bin/systemctl daemon-reload >/dev/null 2>&1 || :

%files
%defattr(-,root,root,-)
%license LICENSE
%{appdir}
%{unitdir}/%{name}.service
%config(noreplace) %{_sysconfdir}/%{name}/%{name}.env
%attr(0750,agent-insight,agent-insight) %dir %{datadir}
%attr(0750,agent-insight,agent-insight) %dir %{datadir}/data

%changelog
* Tue Aug 11 2026 Agent Insight Maintainers <intelligence@openeuler.org> - 0.7.0-0.830.3
- Bundle Prisma engines for both OpenSSL 1.1 and OpenSSL 3.0 targets

* Tue Aug 11 2026 Agent Insight Maintainers <intelligence@openeuler.org> - 0.7.0-0.830.2
- Skip Prisma client generation during service startup and restore default port 3000

* Tue Aug 11 2026 Agent Insight Maintainers <intelligence@openeuler.org> - 0.7.0-0.830.1
- Build transfer-test RPM from branch 830 with bundled Node.js 20.18.2
```

检查 spec：

```bash
rpmspec -P "$RPM_TOPDIR/SPECS/agent-insight.spec" >/dev/null
```

## 5. 构建、验包和生成交付目录

### 5.1 构建

```bash
set -o pipefail
rpmbuild \
  --define "_topdir $RPM_TOPDIR" \
  --define "_tmppath $RPM_TMPDIR" \
  --define "package_release $PACKAGE_RELEASE" \
  -ba "$RPM_TOPDIR/SPECS/agent-insight.spec" \
  2>&1 | tee "$BUILD_LOG"
RPMBUILD_STATUS=${PIPESTATUS[0]}
test "$RPMBUILD_STATUS" -eq 0
```

只有退出码为 0 且日志出现二进制 RPM 和 SRPM 两行 `Wrote:` 才算成功。`pipefail` 防止 `tee` 掩盖构建失败。

### 5.2 验包

```bash
export RPM_FILE="$RPM_TOPDIR/RPMS/x86_64/agent-insight-0.7.0-${PACKAGE_RELEASE}.x86_64.rpm"
export SRPM_FILE="$RPM_TOPDIR/SRPMS/agent-insight-0.7.0-${PACKAGE_RELEASE}.src.rpm"
test -f "$RPM_FILE"
test -f "$SRPM_FILE"

rpm -qip "$RPM_FILE"
rpm -qpR "$RPM_FILE"
rpm -qlp "$RPM_FILE" | grep '/usr/lib/agent-insight/runtime/bin/node'
rpm -qlp "$RPM_FILE" | grep -E 'schema-engine-debian-openssl-(1\.1|3\.0)\.x$'
rpm -qlp "$RPM_FILE" | grep -E 'libquery_engine-debian-openssl-(1\.1|3\.0)\.x\.so\.node$'

! rpm -qlp "$RPM_FILE" | grep -E '^(/mnt/sdc|/home/ymt|/root)(/|$)'
rpm -qpl --dump "$RPM_FILE" |
  awk '$NF ~ /^\/(mnt\/sdc|home\/ymt|root)(\/|$)/ { print; bad=1 } END { exit bad }'

CHECK_DIR=$(mktemp -d "$RPM_TMPDIR/rpm-check.XXXXXX")
cd "$CHECK_DIR"
rpm2cpio "$RPM_FILE" |
  cpio -idm --quiet ./usr/lib/agent-insight/runtime/bin/node
./usr/lib/agent-insight/runtime/bin/node --version
```

包内 Node 必须输出 `v20.18.2`。

### 5.3 生成独立交付目录

```bash
export RELEASE_DIR="/mnt/sdc/ymt/agent-insight-rpm/release/agent-insight-0.7.0-${PACKAGE_RELEASE}"
test ! -e "$RELEASE_DIR"
install -d -o ymt -g ymt "$RELEASE_DIR"

install -o ymt -g ymt -m 0644 \
  "$RPM_FILE" \
  "$SRPM_FILE" \
  "$RPM_TOPDIR/SPECS/agent-insight.spec" \
  "$RPM_TOPDIR/SOURCES/prepare-prisma-multi-engine.js" \
  "$RELEASE_DIR/"

cd "$RELEASE_DIR"
grep -E '^[[:space:]]*not ok [0-9]+' "$BUILD_LOG" |
  sed -E 's/^[[:space:]]+//' |
  sed 's#/mnt/sdc/ymt/agent-insight-rpm/rpmbuild/BUILD/agent-insight-0.7.0/##' \
  > FAILED-TESTS.txt || :

{
  printf 'source_branch=830\n'
  printf 'source_commit=%s\n' "$SOURCE_COMMIT"
  printf 'package_nevra=agent-insight-0.7.0-%s.x86_64\n' "$PACKAGE_RELEASE"
  printf 'build_node=%s\n' "$(/usr/bin/node --version)"
  printf 'build_npm=%s\n' "$(/usr/bin/npm --version)"
  printf 'bundled_node=20.18.2\n'
  printf 'default_port=3000\n'
  printf 'prisma_binary_targets=debian-openssl-1.1.x,debian-openssl-3.0.x\n'
  grep -E '^# (tests|pass|fail|skipped) ' "$BUILD_LOG" | tail -n 4
} > BUILD-INFO.txt

chown ymt:ymt BUILD-INFO.txt FAILED-TESTS.txt
chmod 0644 BUILD-INFO.txt FAILED-TESTS.txt

sha256sum \
  "$(basename "$RPM_FILE")" \
  "$(basename "$SRPM_FILE")" \
  agent-insight.spec \
  prepare-prisma-multi-engine.js \
  BUILD-INFO.txt \
  FAILED-TESTS.txt \
  > SHA256SUMS
chown ymt:ymt SHA256SUMS
sha256sum -c SHA256SUMS
```

最终只分发本次 `RELEASE_DIR`，不要从包含历史产物的 `RPMS/` 目录取包。

## 6. 当前构建服务器并行转测

当前服务器已有 `/etc/systemd/system/agent-insight.service`，它优先于 RPM 自带的同名 unit。RPM 默认端口是 `3000`；由于源码服务已经占用 `3000`，并行验证时必须使用独立的 `agent-insight-rpm-test.service`、数据目录，并显式覆盖为 `3001`。

以 `root` 执行：

```bash
exit  # 从 ymt 构建 shell 返回 root

export PACKAGE_RELEASE=0.830.3
export RPM_FILE="/mnt/sdc/ymt/agent-insight-rpm/rpmbuild/RPMS/x86_64/agent-insight-0.7.0-${PACKAGE_RELEASE}.x86_64.rpm"

rpm -Uvh --test "$RPM_FILE"
dnf install -y --nogpgcheck "$RPM_FILE"

install -d -o agent-insight -g agent-insight -m 0750 \
  /var/lib/agent-insight-rpm-test \
  /var/lib/agent-insight-rpm-test/data

install -m 0644 \
  /usr/lib/systemd/system/agent-insight.service \
  /etc/systemd/system/agent-insight-rpm-test.service
sed -i \
  -e 's/^Description=.*/Description=Agent Insight RPM Test/' \
  -e 's#^EnvironmentFile=.*#EnvironmentFile=/etc/agent-insight/rpm-test.env#' \
  -e 's#^ReadWritePaths=.*#ReadWritePaths=/var/lib/agent-insight-rpm-test#' \
  /etc/systemd/system/agent-insight-rpm-test.service
```

创建 `/etc/agent-insight/rpm-test.env`：

```ini
NODE_ENV=production
NEXT_TELEMETRY_DISABLED=1
HOSTNAME=0.0.0.0
PORT=3001
HOME=/var/lib/agent-insight-rpm-test
AGENT_INSIGHT_DATA_DIR=/var/lib/agent-insight-rpm-test
DATABASE_URL=file:/var/lib/agent-insight-rpm-test/data/witty_insight.db
OPENCODE_BIN=/usr/lib/agent-insight/node_modules/.bin/opencode
```

启动并验证：

```bash
chown root:root /etc/agent-insight/rpm-test.env
chmod 0640 /etc/agent-insight/rpm-test.env
systemctl daemon-reload
systemctl restart agent-insight-rpm-test.service

systemctl status agent-insight-rpm-test.service --no-pager -l
journalctl -u agent-insight-rpm-test.service -n 100 --no-pager
ss -lntp | grep -E ':(3000|3001)([[:space:]]|$)'
curl -sS -o /dev/null \
  -w 'HTTP=%{http_code} redirect=%{redirect_url}\n' \
  http://127.0.0.1:3001/
```

这台服务器卸载 RPM 时，不要直接执行 `dnf remove agent-insight`，否则卸载脚本可能停止原有同名服务。使用：

```bash
systemctl stop agent-insight-rpm-test.service
rpm -e --noscripts agent-insight
systemctl daemon-reload
```

## 7. 分发到其他服务器

复制第 5.3 节生成的整个 `RELEASE_DIR`，然后在目标服务器执行：

```bash
export PACKAGE_RELEASE=0.830.3
cd "agent-insight-0.7.0-${PACKAGE_RELEASE}"
sha256sum -c SHA256SUMS
rpm -Uvh --test "./agent-insight-0.7.0-${PACKAGE_RELEASE}.x86_64.rpm"
dnf install -y --nogpgcheck \
  "./agent-insight-0.7.0-${PACKAGE_RELEASE}.x86_64.rpm"
```

启动前检查同名 unit 和端口：

```bash
systemctl show agent-insight.service -p LoadState -p FragmentPath -p ActiveState
ss -lntp | grep ':3000' || true
```

目标服务器没有同名服务时：

```bash
systemctl enable --now agent-insight.service
systemctl status agent-insight.service --no-pager -l
journalctl -u agent-insight.service -n 100 --no-pager
curl -I http://127.0.0.1:3000/
```

目标服务器已有同名服务时，使用第 6 节的隔离 unit。公网访问还需在云安全组放行入方向 TCP `3001`。

依赖树中部分包声明最低 Node 20.19 或 22；Node 20.18.2 已验证可以完成生产构建和启动，但转测仍需覆盖 AI SDK、文件监听及相关调用链。
