FROM node:20-bookworm-slim

ARG SWE_BENCH_SOURCE_COMMIT=02e7a74ffd0b707aab73d203fe87bdc7c76afc8e

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates docker.io git python3 python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m venv /opt/swebench-venv \
  && git clone https://github.com/swe-bench/SWE-bench.git /opt/SWE-bench \
  && git -C /opt/SWE-bench checkout "$SWE_BENCH_SOURCE_COMMIT" \
  && /opt/swebench-venv/bin/pip install --no-cache-dir /opt/SWE-bench

WORKDIR /app

COPY services/evaluator ./services/evaluator
COPY benchmarks ./benchmarks
COPY .generated/benchmark-catalog/evaluators.cjs ./.generated/benchmark-catalog/evaluators.cjs

ENV EVALUATOR_LISTEN_HOST=0.0.0.0 \
    EVALUATOR_PORT=8080 \
    EVALUATOR_DATA_DIR=/data \
    EVALUATOR_MAX_CONCURRENCY=1 \
    SWE_BENCH_PYTHON=/opt/swebench-venv/bin/python \
    SWE_BENCH_IMAGE_SOURCE=official \
    SWE_BENCH_IMAGE_ARCH=auto \
    SWE_BENCH_ALLOW_NON_OFFICIAL=false

VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "services/evaluator/src/index.cjs"]
