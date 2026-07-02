---
title: "Docker 测试构建"
description: "不发布 npm 包，直接用本地 npm pack 产物在服务器上快速验证 Docker 部署。"
---

# Docker 测试构建

本页适用于这样一种场景：

- 你已经有一台服务器
- 你想在服务器上验证最新改动是否能正常跑起来
- 你不想每次都先发布 npm `latest`
- 你也不想每次 `docker build --no-cache` 重新下载一遍依赖

推荐做法是：

1. 在本地用 `npm pack` 生成一个测试 tarball
2. 把 tarball 和测试用 `Dockerfile` 上传到服务器
3. 在服务器上利用 Docker 缓存构建测试镜像
4. 用现有 volume 启动容器并校验数据是否写到 `/data/agent-insight/data`

这样做的好处是：

- 不需要先发 npm 包
- `apt-get` 和基础镜像层可以复用缓存
- 改动只体现在 tarball 这一层，重建更快
- 可以直接验证 Docker 运行时的数据目录是否正确

## 本地准备

在项目根目录执行。注意：`npm pack` 不会自动重新编译 `.next/standalone`，它只会把当前已有的构建产物打进包里；测试本地改动前要先清理并重新构建：

```bash
rm -rf .next
npm run build
npm pack
```

执行后会生成一个类似下面的文件：

```text
agent-insight-0.4.1.tgz
```

如果你在验证某个具体修复，可以在上传前先检查 tarball 里是否已经包含新构建产物。例如静态分析路径修复可以检查新错误文案是否进入包内：

```bash
tar -xOf agent-insight-0.4.1.tgz package/.next/standalone/.next/server/chunks/src_lib_engine_skill-issues_static-evaluator_*.js | grep "运行时数据目录中缺少对应附件"
```

如果还能搜到旧文案，说明 `.next/standalone` 仍是旧构建，需要重新执行 `rm -rf .next && npm run build && npm pack`。

## 服务器目录

建议在服务器上准备一个独立目录，例如：

```text
/root/agent-insight-docker/
```

目录里至少放这些文件：

```text
Dockerfile
.dockerignore
agent-insight-0.4.1.tgz
scripts/docker-entrypoint.sh
```

## 测试用 Dockerfile

测试阶段推荐使用下面这份 `Dockerfile`。它优先安装你上传的 `.tgz`，不依赖远端 npm 发布：

```dockerfile
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    AGENT_INSIGHT_DATA_DIR=/data/agent-insight \
    PATH=/app/node_modules/.bin:$PATH \
    OPENCODE_BIN=/app/node_modules/.bin/opencode

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        openssl \
        python3 \
    && rm -rf /var/lib/apt/lists/*

COPY agent-insight-*.tgz /tmp/agent-insight.tgz

RUN npm init -y \
    && npm install --omit=dev /tmp/agent-insight.tgz \
    && npm cache clean --force

RUN test -x /app/node_modules/.bin/opencode

COPY scripts/docker-entrypoint.sh /usr/local/bin/agent-insight-entrypoint

RUN chmod +x /usr/local/bin/agent-insight-entrypoint \
    && mkdir -p /data/agent-insight \
    && chown -R node:node /app /data/agent-insight

USER node

VOLUME ["/data/agent-insight"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "const port=process.env.PORT||3000;require('http').get({host:'127.0.0.1',port,path:'/'},res=>process.exit(res.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["agent-insight-entrypoint"]
```

## `.dockerignore` 写法

如果你使用“先排除所有文件、再按需放行”的写法，记得把 tarball 也放行。一个可用示例：

```dockerignore
**
!Dockerfile
!.dockerignore
!agent-insight-*.tgz
!scripts/
!scripts/docker-entrypoint.sh
```

如果漏掉：

```dockerignore
!agent-insight-*.tgz
```

就会出现构建时报错：

```text
ENOENT: no such file or directory, open '/tmp/agent-insight.tgz'
```

## 构建镜像

第一次确认目录没问题时，可以用一次无缓存构建：

```bash
cd /root/agent-insight-docker
docker build --no-cache -t agent-insight:test .
```

确认 `.tgz` 已经能正常复制并安装后，后续测试建议直接复用缓存：

```bash
cd /root/agent-insight-docker
docker build -t agent-insight:test .
```

这样 `FROM node:20-bookworm-slim`、`apt-get install` 等层不会每次重下。

## 启动测试容器

如果测试机器的 `3000` 端口空闲：

```bash
docker stop agent-insight 2>/dev/null || true
docker rm agent-insight 2>/dev/null || true

docker run -d \
  --name agent-insight \
  -p 3000:3000 \
  -v agent-insight-data:/data/agent-insight \
  agent-insight:test
```

如果你要避开已占用的 `3000`，例如改用 `9292`：

```bash
docker stop agent-insight 2>/dev/null || true
docker rm agent-insight 2>/dev/null || true

docker run -d \
  --name agent-insight \
  -p 9292:3000 \
  -v agent-insight-data:/data/agent-insight \
  agent-insight:test
```

## 启动后校验

先看服务日志：

```bash
docker logs -f agent-insight
```

然后进入容器查看运行时数据目录：

```bash
docker exec -it agent-insight sh
```

容器内执行：

```bash
echo $AGENT_INSIGHT_DATA_DIR
ls -lah /data/agent-insight/data
ls -lah /data/agent-insight/data/storage/skills
```

如果要验证 opencode 是否存在：

```bash
which opencode
opencode --version
```

如果要检查服务端拉起的 opencode 健康页：

```bash
curl -i http://127.0.0.1:4090/api/health
```

## 你应该看到的数据位置

测试通过后，新的运行时数据应写入：

```text
/data/agent-insight/data/witty_insight.db
/data/agent-insight/data/storage/skills/...
/data/agent-insight/data/.opencode-runtime/...
```

而不是依赖 Next standalone 目录：

```text
/app/node_modules/agent-insight/.next/standalone/data/...
```

## 测试结束后切回正式版

测试流程只适合验证“当前这份本地代码打出来的 npm 包是否能在 Docker 中正常运行”。

正式发布时，建议还是切回仓库根目录正式 `Dockerfile` 的 npm 拉包方式，例如：

```bash
docker build --build-arg AGENT_INSIGHT_VERSION=latest -t agent-insight:npm-latest .
```

测试镜像和正式镜像可以并存，互不影响。
