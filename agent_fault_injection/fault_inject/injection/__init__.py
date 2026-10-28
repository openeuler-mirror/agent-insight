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

"""Injection installers, apply plan, and rewrite tools."""

from .context import InjectionContext
from .rewrite_engine import (
    apply_assistant_text_rewrite,
    apply_assistant_tool_call_rewrite,
    apply_messages_rewrite,
    apply_system_rewrite,
    apply_tool_result_rewrite,
)

__all__ = [
    "InjectionContext",
    "apply_assistant_text_rewrite",
    "apply_assistant_tool_call_rewrite",
    "apply_messages_rewrite",
    "apply_system_rewrite",
    "apply_tool_result_rewrite",
]
