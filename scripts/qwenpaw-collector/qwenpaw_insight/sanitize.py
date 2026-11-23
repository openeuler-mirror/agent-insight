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

"""Sensitive-information sanitization for collected trace content (AC12).

Every content field that may carry user input or tool output is passed
through this module before it is written into a span.  The goal is to
mask API keys, tokens, passwords and other credentials while keeping the
surrounding trace content readable.
"""
from __future__ import annotations

import re
from typing import Any

MASK = "***"

# Keys whose values should always be masked (matched case-insensitively on
# any substring of the dict key).
SENSITIVE_KEY_HINTS: tuple[str, ...] = (
    "api_key",
    "apikey",
    "api-key",
    "access_key",
    "accesskey",
    "auth_token",
    "authorization",
    "bearer",
    "client_secret",
    "cookie",
    "credential",
    "password",
    "passwd",
    "private_key",
    "secret",
    "session_key",
    "token",
)

# Value-level patterns applied to plain text / serialized JSON strings.
_VALUE_PATTERNS: tuple[re.Pattern, ...] = (
    # Well-known key prefixes: OpenAI sk-, Anthropic sk-ant-, AgentInsight wi_,
    # GitHub ghp_/gho_, Slack xox*, AWS AKIA/ASIA.
    re.compile(r"\b(?:sk|pk|wi|ghp|gho|xox[baprs]|AKIA|ASIA)[-_A-Za-z0-9]{8,}\b"),
    # Authorization: Bearer <token>
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b", re.IGNORECASE),
    # key=value / "key": "value" / key: value assignments.
    re.compile(
        r"(?i)\b(authorization|api[_-]?key|apikey|access[_-]?token|auth[_-]?token"
        r"|secret|password|passwd|private[_-]?key|session[_-]?key|client[_-]?secret)"
        r"\b\s*[:=]\s*[\"']?[^\s,;}\"']+"
    ),
    # PEM private key blocks.
    re.compile(
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
        re.DOTALL,
    ),
)


def is_sensitive_key(key: Any) -> bool:
    """Return True when a dict key looks like a credential field."""
    if not isinstance(key, str):
        return False
    lowered = key.lower()
    return any(hint in lowered for hint in SENSITIVE_KEY_HINTS)


def sanitize_text(text: str) -> str:
    """Mask credential-shaped substrings inside a plain string."""
    out = text
    for pattern in _VALUE_PATTERNS:
        out = pattern.sub(MASK, out)
    return out


def sanitize_value(value: Any) -> Any:
    """Recursively sanitize a value (str / dict / list / scalar)."""
    if isinstance(value, str):
        return sanitize_text(value)
    if isinstance(value, dict):
        return {
            str(key): (MASK if is_sensitive_key(key) else sanitize_value(item))
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [sanitize_value(item) for item in value]
    return value
