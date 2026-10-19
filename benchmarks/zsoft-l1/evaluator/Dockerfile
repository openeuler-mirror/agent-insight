FROM docker:27.5.1-cli AS docker-cli
FROM python:3.11-slim-bookworm
ARG PIP_INDEX_URL=https://repo.huaweicloud.com/repository/pypi/simple
ARG EVALUATOR_ARTIFACT_DIGEST=unknown
ARG EVALUATOR_SOURCE_REVISION=unknown
ARG EVALUATOR_SOURCE_DIRTY=false
LABEL agent-insight.evaluator.artifact-digest=$EVALUATOR_ARTIFACT_DIGEST \
      org.opencontainers.image.revision=$EVALUATOR_SOURCE_REVISION \
      org.opencontainers.image.source-dirty=$EVALUATOR_SOURCE_DIRTY
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" \
    --timeout 60 --retries 5 pydantic==2.10.6
COPY benchmarks/zsoft-l1/evaluator /opt/agent-insight/zsoft
ENV PYTHONDONTWRITEBYTECODE=1
WORKDIR /data
