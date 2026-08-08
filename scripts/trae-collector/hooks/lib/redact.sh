#!/bin/bash
# ============================================================================
# Agent Insight TRAE Collector — Sensitive Information Redaction Library
# ============================================================================

# Patterns for sensitive keys (lowercase matched)
SENSITIVE_KEY_PATTERNS=(
  "api[_-]?key"
  "apikey"
  "token"
  "secret"
  "password"
  "passwd"
  "authorization"
  "auth"
  "access[_-]?token"
  "refresh[_-]?token"
  "client[_-]?secret"
  "private[_-]?key"
  "ssh[_-]?key"
  "session[_-]?token"
  "bearer"
  "credential"
  "jwt"
)

# Redact a JSON string by replacing sensitive field values with "***"
# Usage: redact_json <json_string>
redact_json() {
  local input="$1"
  echo "$input" | python3 -c '
import sys, json, re

SENSITIVE_PATTERNS = [
    "api[_-]?key", "apikey", "token", "secret", "password", "passwd",
    "authorization", "auth", "access[_-]?token", "refresh[_-]?token",
    "client[_-]?secret", "private[_-]?key", "ssh[_-]?key",
    "session[_-]?token", "bearer", "credential", "jwt"
]

def is_sensitive_key(key):
    k = str(key).lower()
    for p in SENSITIVE_PATTERNS:
        if re.search(p, k):
            return True
    return False

def redact_value(v):
    if v is None:
        return v
    if isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, list):
        return [redact_value(x) for x in v]
    if isinstance(v, dict):
        out = {}
        for k, val in v.items():
            if is_sensitive_key(k):
                out[k] = "***"
            else:
                out[k] = redact_value(val)
        return out
    return v

try:
    data = json.loads(sys.stdin.read())
    if not isinstance(data, dict):
        data = {}
    print(json.dumps(redact_value(data), ensure_ascii=False))
except:
    print("{}")
' 2>/dev/null || echo "{}"
}

# Redact sensitive patterns from plain text
# Usage: redact_text <text>
redact_text() {
  local text="$1"
  # Replace common patterns
  echo "$text" | sed \
    -e 's/-----BEGIN [A-Z ]*PRIVATE KEY-----.*-----END [A-Z ]*PRIVATE KEY-----/***REDACTED PRIVATE KEY***/g' \
    -e 's/[bB]earer\s\+[A-Za-z0-9._-]\{10,\}/Bearer ***/g' \
    -e 's/api[_-]?key[=:]["\x27]\?[A-Za-z0-9._-]\{8,\}/api_key=***/gi' \
    -e 's/token[=:]["\x27]\?[A-Za-z0-9._-]\{8,\}/token=***/gi' \
    -e 's/password[=:]["\x27]\?[^& \t"\x27]\{3,\}/password=***/gi' \
    2>/dev/null
}
