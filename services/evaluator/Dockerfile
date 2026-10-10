FROM node:20-bookworm-slim

ARG DEBIAN_MIRROR=http://repo.huaweicloud.com/debian
ARG DEBIAN_SECURITY_MIRROR=http://repo.huaweicloud.com/debian-security
ARG EVALUATOR_SOURCE_REVISION=unknown
ARG EVALUATOR_SOURCE_DIRTY=false

LABEL org.opencontainers.image.revision=$EVALUATOR_SOURCE_REVISION
LABEL org.opencontainers.image.source-dirty=$EVALUATOR_SOURCE_DIRTY

RUN set -eu; \
  cp /etc/apt/sources.list.d/debian.sources /tmp/debian.sources.official; \
  sed -i \
    -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
    -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" \
    /etc/apt/sources.list.d/debian.sources; \
  install_system_packages() { \
    apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=20 update \
      && apt-get install -y --no-install-recommends ca-certificates docker.io python3; \
  }; \
  if ! install_system_packages; then \
    rm -rf /var/lib/apt/lists/*; \
    cp /tmp/debian.sources.official /etc/apt/sources.list.d/debian.sources; \
    install_system_packages; \
  fi; \
  rm -f /tmp/debian.sources.official; \
  rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY services/evaluator ./services/evaluator
COPY benchmarks ./benchmarks
COPY generated/benchmark-catalog/evaluators.cjs ./generated/benchmark-catalog/evaluators.cjs

ENV EVALUATOR_LISTEN_HOST=0.0.0.0 \
    EVALUATOR_PORT=8080 \
    EVALUATOR_DATA_DIR=/data \
    EVALUATOR_MAX_CONCURRENCY=1 \
    EVALUATOR_SOURCE_REVISION=$EVALUATOR_SOURCE_REVISION \
    EVALUATOR_SOURCE_DIRTY=$EVALUATOR_SOURCE_DIRTY

VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "services/evaluator/src/index.cjs"]
