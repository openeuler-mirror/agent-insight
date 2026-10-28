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

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

trace_metadata: ContextVar[dict[str, Any] | None] = ContextVar(
    "agent_insight_trace_metadata", default=None
)


@contextmanager
def trace_context(
    *, session_id: str | None = None, query: str | None = None, agent_name: str | None = None
) -> Iterator[None]:
    current = dict(trace_metadata.get() or {})
    if session_id:
        current["session_id"] = session_id
    if query:
        current["query"] = query
    if agent_name:
        current["agent_name"] = agent_name
    token = trace_metadata.set(current)
    try:
        yield
    finally:
        trace_metadata.reset(token)
