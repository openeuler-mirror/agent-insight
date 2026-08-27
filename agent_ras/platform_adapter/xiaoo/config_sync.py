"""Pull Insight capability config and merge into local ras config.json.

Mirrors ``platform_adapter/opencode/config_sync.js``. Fail-open — never raise
into the xiaoO hooker.

Local layout (shared file, per-platform slices)::

    agent_ras.platforms.<platform>             # enabled / detectors / recovery
    agent_ras.platforms.<platform>.syncedFrom  # Insight provenance (not a decision cursor)

Merge decision is content-fingerprint only (Insight wins on drift).
Top-level ``detectors`` / ``recovery`` remain as a legacy mirror of the *last*
merged platform (readers should prefer ``platforms.<platform>``).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse


FetchImpl = Callable[[str, dict[str, str]], dict[str, Any]]


def resolve_ras_home() -> Path:
    raw = os.environ.get("AGENT_INSIGHT_RAS_HOME")
    if raw:
        return Path(raw).expanduser()
    return Path.home() / ".agent-insight" / "ras"


def resolve_config_path(ras_home: Path | None = None) -> Path:
    return (ras_home or resolve_ras_home()) / "config.json"


def _copy_detector_map(detectors: Any) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    if not isinstance(detectors, dict):
        return out
    for key, value in detectors.items():
        if isinstance(value, dict):
            out[str(key)] = dict(value)
    return out


def _capability_slice(body: dict[str, Any]) -> dict[str, Any]:
    detectors = body.get("detectors") if isinstance(body.get("detectors"), dict) else {}
    recovery = body.get("recovery") if isinstance(body.get("recovery"), dict) else {}
    return {
        "enabled": bool(body.get("enabled", True)),
        "detectors": _copy_detector_map(detectors),
        "recovery": dict(recovery),
    }


def capability_fingerprint(body: dict[str, Any] | None) -> str:
    if not isinstance(body, dict):
        return ""
    slice_ = _capability_slice(body)
    return json.dumps(slice_, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def capability_content_hash(body: dict[str, Any] | None) -> str:
    fp = capability_fingerprint(body)
    if not fp:
        return ""
    return hashlib.sha256(fp.encode("utf-8")).hexdigest()[:16]


def resolve_platform_capability_from_ras(
    ras: dict[str, Any] | None,
    platform: str,
) -> dict[str, Any] | None:
    """Return enabled/detectors/recovery for ``platform``, with legacy flat fallback."""
    if not isinstance(ras, dict):
        return None
    platforms = ras.get("platforms")
    if isinstance(platforms, dict):
        slot = platforms.get(platform)
        if isinstance(slot, dict) and (
            "detectors" in slot or "recovery" in slot or "enabled" in slot
        ):
            return _capability_slice(slot)
        # Map exists but this platform never synced — do not invent from top-level
        # (top-level may belong to another platform).
        if platforms:
            return None
    # Legacy single-slice layout.
    if ras.get("detectors") is not None or ras.get("recovery") is not None:
        return _capability_slice(ras)
    return None


def merge_capability_into_local_ras_config(
    local_config: dict[str, Any],
    body: dict[str, Any],
    sync_meta: dict[str, Any] | int | None = None,
    platform: str = "xiaoo",
) -> dict[str, Any]:
    root = dict(local_config)
    prev = root.get("agent_ras")
    prev_ras = dict(prev) if isinstance(prev, dict) else {}
    slice_ = _capability_slice(body)

    prev_platforms = (
        dict(prev_ras["platforms"])
        if isinstance(prev_ras.get("platforms"), dict)
        else {}
    )

    if isinstance(sync_meta, dict):
        meta_in = sync_meta
    elif isinstance(sync_meta, int):
        meta_in = {"revision": sync_meta}
    else:
        meta_in = {}

    content_hash = meta_in.get("contentHash")
    if not isinstance(content_hash, str) or not content_hash:
        content_hash = capability_content_hash(slice_)

    synced_from: dict[str, Any] = {"contentHash": content_hash}
    if isinstance(meta_in.get("revision"), (int, float)) and not isinstance(
        meta_in.get("revision"), bool
    ):
        synced_from["revision"] = int(meta_in["revision"])
    updated_at = meta_in.get("updatedAt")
    if isinstance(updated_at, str) and updated_at:
        synced_from["updatedAt"] = updated_at

    prev_platforms[platform] = {
        **slice_,
        "syncedFrom": synced_from,
    }

    next_ras: dict[str, Any] = {
        **prev_ras,
        # Legacy top-level mirror (last merged platform). Prefer platforms.*.
        "enabled": slice_["enabled"],
        "detectors": _copy_detector_map(slice_["detectors"]),
        "recovery": dict(slice_["recovery"]),
        "platforms": prev_platforms,
    }
    _KEEP = {
        "enabled",
        "service",
        "insight",
        "detectors",
        "recovery",
        "platforms",
        "debug",
    }
    for key in list(next_ras):
        if key in {"ras_config_revisions", "ras_config_revision"}:
            next_ras.pop(key, None)
        elif key not in _KEEP and isinstance(next_ras.get(key), dict):
            next_ras.pop(key, None)

    root["agent_ras"] = next_ras
    return root


def _events_to_config_url(url: str) -> str:
    trimmed = url.strip().rstrip("/")
    if trimmed.endswith("ras-events"):
        return trimmed[: -len("ras-events")] + "ras-config"
    return trimmed


def resolve_ras_config_url(insight: dict[str, Any] | None) -> str:
    from_env = (
        os.environ.get("AGENT_INSIGHT_RAS_CONFIG_URL")
        or os.environ.get("AGENT_INSIGHT_RAS_INGEST_URL")
        or ""
    ).strip()
    if from_env:
        return _events_to_config_url(from_env)
    events_url = ""
    if isinstance(insight, dict) and isinstance(insight.get("events_url"), str):
        events_url = insight["events_url"].strip()
    if events_url:
        return _events_to_config_url(events_url)
    return ""


def _is_loopback(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return False
    return host in {"localhost", "127.0.0.1", "::1"}


def _default_fetch(url: str, headers: dict[str, str]) -> dict[str, Any]:
    # Bypass corporate proxies for loopback (same rationale as OpenCode curl --noproxy).
    if _is_loopback(url):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    else:
        opener = urllib.request.build_opener()
    req = urllib.request.Request(url, headers=headers, method="GET")
    with opener.open(req, timeout=8) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw)


def _with_platform(url: str, platform: str) -> str:
    parsed = urlparse(url)
    q = dict(parse_qsl(parsed.query, keep_blank_values=True))
    if "platform" not in q:
        q["platform"] = platform
    return urlunparse(parsed._replace(query=urlencode(q)))


def _stamp_path(ras_home: Path, platform: str) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9_-]+", "_", platform).strip("_") or "default"
    return ras_home / f".ras_config_sync_stamp_{safe}"


def _stamp_fresh(ras_home: Path, platform: str, ttl_seconds: float) -> bool:
    stamp = _stamp_path(ras_home, platform)
    try:
        age = time.time() - stamp.stat().st_mtime
        return age < ttl_seconds
    except OSError:
        return False


def _touch_stamp(ras_home: Path, platform: str) -> None:
    stamp = _stamp_path(ras_home, platform)
    try:
        ras_home.mkdir(parents=True, exist_ok=True)
        stamp.write_text(str(time.time()), encoding="utf-8")
    except OSError:
        pass


def sync_capability_config_from_insight(
    *,
    platform: str = "xiaoo",
    ras_home: Path | None = None,
    fetch_impl: FetchImpl | None = None,
    log: Callable[[str], None] | None = None,
    ttl_seconds: float = 60.0,
    force: bool = False,
) -> dict[str, Any]:
    """Pull Insight ras-config and merge when content fingerprint differs.

    Returns ``{applied, reason, revision?, contentHash?}``. Never raises.
    """
    _log = log or (lambda _m: None)
    home = ras_home or resolve_ras_home()
    config_path = resolve_config_path(home)
    fetch = fetch_impl or _default_fetch

    try:
        if not force and _stamp_fresh(home, platform, ttl_seconds):
            return {"applied": False, "reason": "ttl_skip"}

        if not config_path.is_file():
            return {"applied": False, "reason": "no_local_config"}

        try:
            local = json.loads(config_path.read_text(encoding="utf-8"))
        except Exception:
            return {"applied": False, "reason": "local_config_parse_error"}

        ras = local.get("agent_ras") if isinstance(local.get("agent_ras"), dict) else {}
        insight = ras.get("insight") if isinstance(ras.get("insight"), dict) else {}
        if insight.get("enabled") is False:
            return {"applied": False, "reason": "insight_disabled"}

        url_base = resolve_ras_config_url(insight)
        if not url_base:
            return {"applied": False, "reason": "no_config_url"}

        api_key = ""
        if isinstance(insight.get("api_key"), str) and insight["api_key"].strip():
            api_key = insight["api_key"].strip()
        elif os.environ.get("AGENT_INSIGHT_API_KEY"):
            api_key = os.environ["AGENT_INSIGHT_API_KEY"].strip()
        if not api_key:
            return {"applied": False, "reason": "no_api_key"}

        url = _with_platform(url_base, platform)
        try:
            payload = fetch(
                url,
                {
                    "x-witty-api-key": api_key,
                    "Accept": "application/json",
                },
            )
        except urllib.error.HTTPError as exc:
            _log(f"[insight-ras] ras-config HTTP {exc.code}")
            _touch_stamp(home, platform)
            return {"applied": False, "reason": f"http_{exc.code}"}
        except Exception as exc:
            _log(f"[insight-ras] ras-config fetch failed: {exc}")
            _touch_stamp(home, platform)
            return {"applied": False, "reason": "fetch_error"}

        if not isinstance(payload, dict) or payload.get("syncEnabled") is not True or not payload.get("config"):
            _touch_stamp(home, platform)
            return {
                "applied": False,
                "reason": "sync_disabled_or_empty",
                "revision": payload.get("revision") if isinstance(payload, dict) else None,
            }

        remote_revision = int(payload.get("revision") or 0)
        remote_updated_at = payload.get("updatedAt") if isinstance(payload.get("updatedAt"), str) else None
        remote_cfg = payload["config"] if isinstance(payload["config"], dict) else {}
        local_slice = resolve_platform_capability_from_ras(ras, platform)
        remote_fp = capability_fingerprint(remote_cfg)
        local_fp = capability_fingerprint(local_slice)
        content_hash = capability_content_hash(remote_cfg)

        platforms = ras.get("platforms") if isinstance(ras.get("platforms"), dict) else None
        slot = platforms.get(platform) if isinstance(platforms, dict) else None
        synced = slot.get("syncedFrom") if isinstance(slot, dict) else None
        has_synced_from = (
            isinstance(synced, dict)
            and isinstance(synced.get("contentHash"), str)
            and bool(synced.get("contentHash"))
        )
        has_legacy_revision_keys = ("ras_config_revisions" in ras) or ("ras_config_revision" in ras)

        if local_fp and local_fp == remote_fp and has_synced_from and not has_legacy_revision_keys:
            _touch_stamp(home, platform)
            return {
                "applied": False,
                "reason": "already_current",
                "revision": remote_revision,
                "contentHash": content_hash,
            }

        merged = merge_capability_into_local_ras_config(
            local if isinstance(local, dict) else {},
            remote_cfg,
            {
                "revision": remote_revision,
                "updatedAt": remote_updated_at,
                "contentHash": content_hash,
            },
            platform,
        )
        home.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(prefix="config.", suffix=".tmp", dir=str(home))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(json.dumps(merged, ensure_ascii=False, indent=2))
                fh.write("\n")
            Path(tmp_name).replace(config_path)
        finally:
            try:
                if Path(tmp_name).exists():
                    Path(tmp_name).unlink()
            except OSError:
                pass

        _touch_stamp(home, platform)
        if local_fp and local_fp == remote_fp:
            reason = "layout_migrate"
        elif local_fp:
            reason = "content_drift"
        else:
            reason = "merged"
        _log(
            f"[insight-ras] ras-config applied platform={platform} "
            f"contentHash={content_hash} reason={reason}"
        )
        return {
            "applied": True,
            "reason": reason,
            "revision": remote_revision,
            "contentHash": content_hash,
        }
    except Exception as exc:
        _log(f"[insight-ras] ras-config sync failed: {exc}")
        return {"applied": False, "reason": "exception"}


def load_hello_config_from_ras_config(ras_home: Path | None = None) -> dict[str, Any]:
    """Build SessionHub hello payload from the local runtime config copy.

    Prefers ``platforms.xiaoo``; falls back to legacy top-level detectors.
    Nested ``detectors.<id>`` is passed through as-is (no env field-name overlay).
    """
    config_path = resolve_config_path(ras_home)
    detectors: dict[str, dict[str, Any]] = {}
    notify: bool | None = None

    if config_path.is_file():
        try:
            local = json.loads(config_path.read_text(encoding="utf-8"))
            ras = local.get("agent_ras") if isinstance(local.get("agent_ras"), dict) else {}
            slice_ = resolve_platform_capability_from_ras(ras, "xiaoo")
            if slice_ is None:
                detectors = _copy_detector_map(ras.get("detectors"))
                recovery = ras.get("recovery") if isinstance(ras.get("recovery"), dict) else {}
                if isinstance(recovery.get("notify_user_on_warning"), bool):
                    notify = recovery["notify_user_on_warning"]
            else:
                detectors = _copy_detector_map(slice_.get("detectors"))
                recovery = slice_.get("recovery") if isinstance(slice_.get("recovery"), dict) else {}
                if isinstance(recovery.get("notify_user_on_warning"), bool):
                    notify = recovery["notify_user_on_warning"]
        except Exception:
            detectors = {}

    payload: dict[str, Any] = {
        "detectors": _copy_detector_map(detectors),
    }
    if notify is not None:
        payload["notify_user_on_warning"] = notify
        payload["recovery"] = {"notify_user_on_warning": notify}
    return payload
