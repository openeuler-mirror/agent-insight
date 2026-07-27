FROM node:20-bookworm-slim

ARG AGENT_INSIGHT_VERSION=latest

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

RUN npm init -y \
    && npm install --omit=dev --registry=https://registry.npmjs.org/ "agent-insight@${AGENT_INSIGHT_VERSION}" \
    && npm cache clean --force \
    && rm -rf "$HOME/.npm" "$HOME/.cache/prisma"

# 源码模式(AGENT_INSIGHT_SOURCE_DIR)要在容器里跑 next build,需要 devDependencies
# (tailwindcss / typescript / postcss 等)。npm 不会安装依赖包自身的 devDependencies,
# 这里从装好的包里读出清单显式再装一份——跟着 AGENT_INSIGHT_VERSION 走,不依赖构建上下文。
RUN DEV_DEPS="$(node -p "Object.entries(require('/app/node_modules/agent-insight/package.json').devDependencies || {}).map(([name, range]) => name + '@' + range).join(' ')")" \
    && if [ -n "$DEV_DEPS" ]; then \
         NODE_ENV=development npm install --no-save --registry=https://registry.npmjs.org/ $DEV_DEPS; \
       else \
         echo "Warning: agent-insight@${AGENT_INSIGHT_VERSION} ships no devDependencies; source mode may fail to build." >&2; \
       fi \
    && npm cache clean --force \
    && rm -rf "$HOME/.npm"

RUN test -x /app/node_modules/.bin/opencode

COPY scripts/docker-entrypoint.sh /usr/local/bin/agent-insight-entrypoint

RUN chmod +x /usr/local/bin/agent-insight-entrypoint \
    && mkdir -p /data/agent-insight /app/source /app/node_modules/.prisma /app/node_modules/.cache \
    && for path in \
        /app/node_modules/agent-insight/node_modules/.prisma \
        /app/node_modules/agent-insight/node_modules/@prisma/client \
        /app/node_modules/agent-insight/.next/standalone/node_modules/.prisma \
        /app/node_modules/agent-insight/.next/standalone/node_modules/@prisma/client \
        /app/node_modules/.prisma \
        /app/node_modules/.cache \
        /app/node_modules/@prisma/client \
        /app/source; \
        do [ ! -e "$path" ] || chown -R node:node "$path"; done \
    && chown node:node /app \
    && chown -R node:node /data/agent-insight

USER node

VOLUME ["/data/agent-insight"]
EXPOSE 3000

# start-period 放宽到 10 分钟:源码模式(AGENT_INSIGHT_SOURCE_DIR)启动时要先跑一次 next build,
# 期间端口还没起来。首次探活成功即转 healthy,放宽只影响"判定为 unhealthy"的时机。
HEALTHCHECK --interval=30s --timeout=5s --start-period=600s --retries=3 \
    CMD node -e "const port=process.env.PORT||3000;require('http').get({host:'127.0.0.1',port,path:'/'},res=>process.exit(res.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["agent-insight-entrypoint"]
