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
    && npm install --omit=dev --registry=https://registry.npmjs.org/ "agent-insight@${AGENT_INSIGHT_VERSION}"

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
