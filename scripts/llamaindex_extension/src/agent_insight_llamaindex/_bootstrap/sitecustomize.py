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
    except Exception:
        # Observability must never prevent the instrumented application from
        # starting. Runtime diagnostics remain available through the CLI.
        pass
