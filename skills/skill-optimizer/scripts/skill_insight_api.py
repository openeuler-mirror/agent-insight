import json
import logging
import os
import sys

try:
    from dotenv import load_dotenv
except Exception:
    load_dotenv = None

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
sys.path.append(os.path.abspath(os.path.dirname(__file__)))

logger = logging.getLogger(__name__)

_env_loaded = False
_base_url_cache = None
_headers_cache = None


def _ensure_env_loaded():
    global _env_loaded
    if not _env_loaded:
        from constants import ENV_FILE, GLOBAL_ENV_FILE

        if load_dotenv is not None:
            load_dotenv(ENV_FILE)

        if load_dotenv is not None and GLOBAL_ENV_FILE.exists():
            load_dotenv(GLOBAL_ENV_FILE, override=False)

        _env_loaded = True


def _get_base_url():
    global _base_url_cache

    if _base_url_cache is not None:
        return _base_url_cache

    _ensure_env_loaded()

    base_ip = os.environ.get("SKILL_INSIGHT_HOST")

    if not base_ip:
        raise ValueError(
            f"\n❌ Error: Cannot resolve Agent Insight API IP.\n"
            f"'SKILL_INSIGHT_HOST' environment variable is not set.\n"
            f"This is required for Dynamic/Hybrid modes to fetch historical execution logs."
        )

    if ":" in base_ip and not base_ip.startswith("http"):
        _base_url_cache = f"http://{base_ip}"
    elif base_ip.startswith("http"):
        _base_url_cache = base_ip
    else:
        _base_url_cache = f"http://{base_ip}:3000"

    _base_url_cache = _base_url_cache.rstrip("/")

    return _base_url_cache


def _get_headers():
    global _headers_cache

    if _headers_cache is not None:
        return _headers_cache

    _ensure_env_loaded()

    _headers_cache = {
        "Content-Type": "application/json",
    }

    return _headers_cache


def get_skill_logs(skill: str, skill_version: int = None, limit: int = 20):
    base_url = _get_base_url()
    headers = _get_headers()

    _ensure_env_loaded()
    api_key = os.environ.get("SKILL_INSIGHT_API_KEY", "")

    url = f"{base_url}/api/skills/logs"
    params = {
        "skill": skill,
        "apiKey": api_key,
        "limit": limit,
    }
    if skill_version is not None:
        params["skill_version"] = skill_version

    logger.debug(f"GET {url}")
    logger.debug(f"Params: skill={skill}, limit={limit}")

    try:
        import requests

        response = requests.get(url, params=params, headers=headers)
        logger.debug(f"Status Code: {response.status_code}")
        try:
            result = response.json()
            if isinstance(result, list):
                logger.debug(f"Response Body Length: {len(result)}")
                return result
            else:
                logger.warning(f"Unexpected response format (expected list): {result}")
                return []
        except json.JSONDecodeError:
            logger.warning(f"Response Body (Text): {response.text}")
            return []
    except Exception as e:
        logger.error(f"Error executing get logs request: {e}")
        return []


if __name__ == "__main__":
    logging.basicConfig(level=logging.DEBUG)
    print(f"Target Base URL: {_get_base_url()}")
