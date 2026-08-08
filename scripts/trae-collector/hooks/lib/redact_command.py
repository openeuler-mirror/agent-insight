"""Redact sensitive patterns from Bash command strings."""
import sys, json, re

PATTERNS = [
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", "***REDACTED PRIVATE KEY***"),
    (r"[bB]earer\s+[A-Za-z0-9._-]{10,}", "Bearer ***"),
    (r"api[_-]?key[=:]\s*['\"]?\s*[A-Za-z0-9._-]{8,}", "api_key=***"),
    (r"token[=:]\s*['\"]?\s*[A-Za-z0-9._-]{8,}", "token=***"),
    (r"password[=:]\s*['\"]?\s*[^&\s]{3,}", "password=***"),
]

try:
    d = json.loads(sys.stdin.read())
    cmd = d.get("command", "") if isinstance(d, dict) else ""
    if isinstance(cmd, str):
        for p, r in PATTERNS:
            flags = re.DOTALL if "PRIVATE KEY" in p else re.IGNORECASE
            cmd = re.sub(p, r, cmd, flags=flags)
        d["command"] = cmd
    print(json.dumps(d, ensure_ascii=False))
except:
    fallback = json.dumps(d) if "d" in locals() else sys.stdin.read().strip()
    print(fallback)
