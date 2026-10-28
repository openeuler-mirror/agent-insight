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

import os
import logging
from typing import List


def check_environment_variables(required_vars: List[str]) -> None:
    missing_vars = [var for var in required_vars if not os.getenv(var)]
    if missing_vars:
        logging.error(f"错误: 缺少必要的环境变量: {', '.join(missing_vars)}")
        raise SystemExit(1)


def format_header(
    title: str, width: int = 60, min_width: int = 20, char: str = "="
) -> str:
    lines = []
    final_width = max(width, min_width, len(title) + 4)
    lines.append(char * final_width)
    padding = (final_width - len(title)) // 2
    lines.append(" " * padding + title)
    lines.append(char * final_width)
    return "\n".join(lines)

