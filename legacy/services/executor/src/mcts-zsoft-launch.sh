#!/usr/bin/env bash
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

set -euo pipefail
bridge_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${AGENT_INSIGHT_MCTS_REPO_DIR:?}"
DIR="$PWD/testcases_union"
source "$DIR/config.env"
export XGOVERNOR_BASE_URL="${AGENT_INSIGHT_MCTS_PROXY_URL:?}"
export XGOVERNOR_RUNTIME="${XGOVERNOR_RUNTIME:-xiaoo}"
export XIAOO_SUBMISSION_SELECTOR="${XIAOO_SUBMISSION_SELECTOR:-1}"
export ZSOFT_AGENT_SOURCE=public
export ZSOFT_LOCAL_SOURCE=0
export ZSOFT_BENCH_ROOT="${AGENT_INSIGHT_ZSOFT_WORKSPACE:?}"
export ZSOFT_TASKS_DIR="$ZSOFT_BENCH_ROOT/tasks"
export ZSOFT_BUNDLE_DIR="$ZSOFT_BENCH_ROOT/.mcts-bundles"
unset ZSOFT_SERVER_URL ZSOFT_BIN
exec "${AGENT_INSIGHT_MCTS_PYTHON:?}" "$bridge_dir/mcts-zsoft-export.py" "$@"
