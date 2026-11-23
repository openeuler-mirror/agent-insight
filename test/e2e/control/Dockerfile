ARG BASE_IMAGE=node:24-bookworm
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-yaml git procps lsof openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV npm_config_registry=${NPM_REGISTRY}
WORKDIR /opt/dependencies
COPY package.json package-lock.json ./
COPY prisma/ ./prisma/
RUN npm ci --legacy-peer-deps --ignore-scripts --no-audit --no-fund && npx prisma generate
WORKDIR /opt/e2e
COPY test/e2e/package.json test/e2e/package-lock.json ./
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
ARG DEBIAN_MIRROR
RUN if [ -n "$DEBIAN_MIRROR" ]; then sed -i "s|http://deb.debian.org|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi \
    && npm ci --ignore-scripts --no-audit --no-fund && npx playwright install --with-deps --no-shell chromium
RUN timeout 300s npm install --prefix /opt/opencode-v2 --ignore-scripts --no-audit --no-fund --fetch-retries=1 --fetch-timeout=60000 @opencode/cli@2.1.4 \
    && /opt/opencode-v2/node_modules/@opencode/cli-linux-$(node -p process.arch)/bin/opencode --version \
    && node /opt/opencode-v2/node_modules/@opencode/cli/postinstall.mjs
RUN python3 -m venv /opt/e2e-python && /opt/e2e-python/bin/pip download --index-url https://mirrors.huaweicloud.com/repository/pypi/simple --dest /opt/wheels "setuptools>=77" wheel "PyYAML>=6.0.2" "pydantic>=2,<3" && /opt/e2e-python/bin/pip install --no-index --find-links=/opt/wheels PyYAML pydantic
RUN npm install --prefix /opt/ras-plugin --ignore-scripts --no-audit --no-fund @opencode-ai/plugin@1.14.39
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip python3-dev python3-pydantic sqlite3 unzip curl && rm -rf /var/lib/apt/lists/*
RUN . /etc/os-release && curl -fsSL --retry 2 "https://packages.microsoft.com/config/${ID}/${VERSION_ID}/packages-microsoft-prod.deb" -o /tmp/ms-packages.deb && dpkg -i /tmp/ms-packages.deb && apt-get update && apt-get install -y --no-install-recommends powershell && rm -f /tmp/ms-packages.deb && rm -rf /var/lib/apt/lists/*
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix /opt/fi-plugin --cache /opt/fi-npm-cache --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund @opencode-ai/plugin@1.18.4 \
    && npm install --prefix /opt/fi-plugin-legacy --cache /opt/fi-npm-cache --registry=https://registry.npmjs.org --ignore-scripts --no-audit --no-fund @opencode-ai/plugin@1.14.39
WORKDIR /work
ARG RUNTIME_UID=1000
USER ${RUNTIME_UID}:${RUNTIME_UID}
