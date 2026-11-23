# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

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
