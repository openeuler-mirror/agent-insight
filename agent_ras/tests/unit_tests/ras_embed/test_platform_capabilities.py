# coding: utf-8
from ras_embed.platform_capabilities import supports_host_skill_judge
from ras_embed.facade import call
import json


def test_supports_host_skill_judge_opencode_only():
    assert supports_host_skill_judge("opencode") is True
    assert supports_host_skill_judge("hermes") is False
    assert supports_host_skill_judge("openclaw") is False
    assert supports_host_skill_judge("openjiuwen") is False
    assert supports_host_skill_judge("xiaoo") is False
    assert supports_host_skill_judge("") is False


def test_hello_requires_platform():
    raw = call("hello", "ses_no_platform", "{}")
    data = json.loads(raw)
    assert data.get("error") == "missing platform"
