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

"""Opt-in bootstrap used by ``agent-insight-llamaindex run``.

This package directory is added to ``PYTHONPATH`` only for the child process
launched by the LlamaIndex CLI.  It is deliberately not installed as a global
``sitecustomize`` module, so other Python applications and collectors are
unaffected.
"""

# ruff: noqa: I001 - the collector import must remain inside the opt-in guard

import os


if os.environ.get("AGENT_INSIGHT_LLAMAINDEX_AUTOSTART") == "1":
    try:
        from agent_insight_llamaindex import setup

        setup()
    except Exception as error:
        # Observability must never prevent the instrumented application from
        # starting. Do not include the exception message because it may contain
        # request headers or credentials; the exception type is enough to make
        # a broken deployment visible without leaking content.
        import sys

        print(
            "Agent Insight LlamaIndex collector failed to start "
            f"({type(error).__name__}); run `python -m agent_insight_llamaindex.cli status`.",
            file=sys.stderr,
        )
