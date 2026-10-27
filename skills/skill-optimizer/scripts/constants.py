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

from pathlib import Path

# Workspace Root
WORKSPACE_DIR = Path(__file__).parent.parent
ENV_FILE = WORKSPACE_DIR / ".env"

GLOBAL_CONFIG_DIR = (
    Path.home() / ".agent-insight"
    if (Path.home() / ".agent-insight").exists()
    else Path.home() / ".skill-insight"
)
GLOBAL_ENV_FILE = GLOBAL_CONFIG_DIR / ".env"
