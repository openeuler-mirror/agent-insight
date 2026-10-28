# coding: utf-8
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

"""Session id helpers shared by RAS push and OTel export."""
from __future__ import annotations


def strip_platform_prefix(session_id: str) -> str:
    """``platform:native`` → ``native`` (same rule as insight_push)."""
    sid = str(session_id or "")
    if ":" in sid:
        return sid.split(":", 1)[1]
    return sid


def with_platform_prefix(platform: str, native_id: str) -> str:
    native = str(native_id or "").strip()
    plat = str(platform or "").strip()
    if not plat:
        return native
    if native.startswith(f"{plat}:"):
        return native
    return f"{plat}:{native}"
