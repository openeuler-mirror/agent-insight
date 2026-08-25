#!/usr/bin/env python3
# coding: utf-8
"""Smoke: Model.invoke and/or DeepAgent L3 skill judgment (llm-loop-detection).

Usage:
  python scripts/smoke_l3_runtime.py --mode model
  python scripts/smoke_l3_runtime.py --mode deepagent
  python scripts/smoke_l3_runtime.py --mode both

Env (pick one provider):
  DEEPSEEK_API_KEY  (+ optional DEEPSEEK_API_BASE, default https://api.deepseek.com)
  MINIMAX_API_KEY   (+ MINIMAX_API_HOST, OpenAI-compatible)
  SMOKE_MODEL_NAME  (optional override, e.g. deepseek-chat)
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _build_model():
    from openjiuwen.core.foundation.llm.model import Model
    from openjiuwen.core.foundation.llm.schema.config import (
        ModelClientConfig,
        ModelRequestConfig,
        ProviderType,
    )

    deepseek = (os.environ.get("DEEPSEEK_API_KEY") or "").strip()
    minimax = (os.environ.get("MINIMAX_API_KEY") or "").strip()
    name_override = (os.environ.get("SMOKE_MODEL_NAME") or "").strip()

    if deepseek:
        api_base = (
            os.environ.get("DEEPSEEK_API_BASE")
            or os.environ.get("DEEPSEEK_BASE_URL")
            or "https://api.deepseek.com"
        ).rstrip("/")
        model_name = name_override or "deepseek-chat"
        provider = "DeepSeek"
        client = ModelClientConfig(
            client_provider=ProviderType.OpenAI,
            api_key=deepseek,
            api_base=api_base,
            timeout=60.0,
            verify_ssl=False,
        )
    elif minimax:
        host = (os.environ.get("MINIMAX_API_HOST") or "https://api.minimaxi.com").rstrip(
            "/"
        )
        api_base = host if host.endswith("/v1") else f"{host}/v1"
        model_name = name_override or "MiniMax-Text-01"
        provider = "MiniMax"
        client = ModelClientConfig(
            client_provider=ProviderType.OpenAI,
            api_key=minimax,
            api_base=api_base,
            timeout=60.0,
            verify_ssl=False,
        )
    else:
        raise SystemExit(
            "FAIL[model]: set DEEPSEEK_API_KEY or MINIMAX_API_KEY in the environment"
        )

    model = Model(
        model_client_config=client,
        model_config=ModelRequestConfig(model=model_name, temperature=0.2, max_tokens=256),
    )
    print(f"OK[import/model]: provider={provider} model={model_name} api_base={api_base}")
    return model, provider, model_name


async def smoke_model(model) -> None:
    msg = await model.invoke(
        "Reply with exactly one word: pong",
        temperature=0.0,
        max_tokens=16,
    )
    content = getattr(msg, "content", None) or str(msg)
    preview = str(content).replace("\n", " ")[:80]
    print(f"OK[model.invoke]: preview={preview!r}")


async def smoke_deepagent(model) -> None:
    from platform_adapter.openjiuwen.deep_agent_adapter import DeepAgentAdapter

    adapter = DeepAgentAdapter(model=model)
    member = await adapter.get_or_create_member("detection")
    if member is None:
        raise SystemExit("FAIL[deepagent]: get_or_create_member returned None")
    print(f"OK[deepagent.warmup]: member={type(member).__name__}")

    # Deliberately deadlocked-ish excerpt so Judge has something to classify.
    excerpt = (
        "等等，刚才那个方案好像不对。再看看选项 A……不对，还是回到 B。"
        "等一下，B 也有问题，还是 A 吧。不对，再权衡一下 A 和 B……"
        "还是先不决定，再看看 A……不对，回到 B。"
    ) * 3
    verdict = await adapter.invoke_skill(
        role="detection",
        skill_name="llm-loop-detection",
        payload=excerpt,
        timeout=90.0,
    )
    if not verdict:
        raise SystemExit(
            "FAIL[deepagent.skill]: empty verdict (timeout/fail-open/parse fail)"
        )
    print(
        "OK[deepagent.skill]: "
        f"abnormal={verdict.get('abnormal')!r} "
        f"primary_fault={verdict.get('primary_fault')!r} "
        f"keys={sorted(verdict.keys())}"
    )


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode",
        choices=("model", "deepagent", "both"),
        default="both",
    )
    args = parser.parse_args()

    # Import gate
    from openjiuwen.harness.factory import create_deep_agent  # noqa: F401
    from openjiuwen.harness.rails.skill_use_rail import SkillUseRail  # noqa: F401
    from platform_adapter.openjiuwen.deep_agent_adapter import DeepAgentAdapter  # noqa: F401

    print("OK[import]: create_deep_agent / SkillUseRail / DeepAgentAdapter")

    model, _, _ = _build_model()
    if args.mode in ("model", "both"):
        await smoke_model(model)
    if args.mode in ("deepagent", "both"):
        await smoke_deepagent(model)
    print("PASS")


if __name__ == "__main__":
    asyncio.run(main())
