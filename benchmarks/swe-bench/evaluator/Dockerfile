FROM node:20-bookworm-slim

ARG SWE_BENCH_SOURCE_COMMIT=02e7a74ffd0b707aab73d203fe87bdc7c76afc8e
ARG SWE_BENCH_ARCHIVE_URL=https://codeload.github.com/swe-bench/SWE-bench/tar.gz
ARG SWE_BENCH_ARCHIVE_SHA256=d06181d5365b51fc7ff490171581b9ee87d77e19b3a739a8d574bf25d9ef9479
ARG DEBIAN_MIRROR=http://repo.huaweicloud.com/debian
ARG DEBIAN_SECURITY_MIRROR=http://repo.huaweicloud.com/debian-security
ARG PIP_INDEX_URL=https://repo.huaweicloud.com/repository/pypi/simple
ARG EVALUATOR_SOURCE_REVISION=unknown
ARG EVALUATOR_SOURCE_DIRTY=false
ARG EVALUATOR_ARTIFACT_DIGEST=unknown

LABEL org.opencontainers.image.revision=$EVALUATOR_SOURCE_REVISION
LABEL org.opencontainers.image.source-dirty=$EVALUATOR_SOURCE_DIRTY
LABEL agent-insight.evaluator.artifact-digest=$EVALUATOR_ARTIFACT_DIGEST

RUN set -eu; \
  cp /etc/apt/sources.list.d/debian.sources /tmp/debian.sources.official; \
  sed -i \
    -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
    -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" \
    /etc/apt/sources.list.d/debian.sources; \
  install_system_packages() { \
    apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=20 update \
      && apt-get install -y --no-install-recommends ca-certificates curl docker.io git python3 python3-venv; \
  }; \
  if ! install_system_packages; then \
    rm -rf /var/lib/apt/lists/*; \
    cp /tmp/debian.sources.official /etc/apt/sources.list.d/debian.sources; \
    install_system_packages; \
  fi; \
  rm -f /tmp/debian.sources.official; \
  rm -rf /var/lib/apt/lists/*

RUN set -eu; \
  python3 -m venv /opt/swebench-venv; \
  curl --fail --location --retry 3 --retry-delay 2 --connect-timeout 20 --max-time 180 \
    "$SWE_BENCH_ARCHIVE_URL/$SWE_BENCH_SOURCE_COMMIT" -o /tmp/swe-bench.tar.gz; \
  printf '%s  %s\n' "$SWE_BENCH_ARCHIVE_SHA256" /tmp/swe-bench.tar.gz | sha256sum --check; \
  mkdir -p /opt/SWE-bench; \
  tar -xzf /tmp/swe-bench.tar.gz --strip-components=1 -C /opt/SWE-bench; \
  rm -f /tmp/swe-bench.tar.gz

RUN set -eu; \
  if ! /opt/swebench-venv/bin/pip install --no-cache-dir --retries 2 --timeout 20 \
    --index-url "$PIP_INDEX_URL" /opt/SWE-bench; then \
    /opt/swebench-venv/bin/pip install --no-cache-dir --retries 2 --timeout 20 \
      --index-url https://pypi.org/simple /opt/SWE-bench; \
  fi

WORKDIR /app

COPY services/evaluator/src/evaluator-registry.cjs ./services/evaluator/src/evaluator-registry.cjs
COPY benchmarks/swe-bench ./benchmarks/swe-bench

ENV EVALUATOR_LISTEN_HOST=0.0.0.0 \
    EVALUATOR_DATA_DIR=/data \
    EVALUATOR_SOURCE_REVISION=$EVALUATOR_SOURCE_REVISION \
    EVALUATOR_SOURCE_DIRTY=$EVALUATOR_SOURCE_DIRTY \
    SWE_BENCH_PYTHON=/opt/swebench-venv/bin/python \
    SWE_BENCH_IMAGE_SOURCE=official \
    SWE_BENCH_IMAGE_ARCH=auto \
    SWE_BENCH_ALLOW_NON_OFFICIAL=false

VOLUME ["/data"]
CMD ["node", "benchmarks/swe-bench/evaluator/entrypoint.cjs", "doctor"]
