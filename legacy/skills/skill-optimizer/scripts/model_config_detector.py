#!/usr/bin/env python3
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

"""
Model Configuration Detector

Auto-detects and retrieves LLM API configuration from various AI platforms.
Updates .env file with detected configuration if fields are empty.

Supported Platforms:
1. OpenCode - via node scripts/opencode-model-detector.cjs (if available)
2. Claude Code - via ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY environment variables
3. Cursor/Windsurf - via environment variables

Usage:
    cd .claude/skill-optimizer
    python scripts/model_config_detector.py
"""
import os
import sys
from pathlib import Path
from dotenv import load_dotenv
import subprocess
import json

# Add project root to sys.path
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from constants import ENV_FILE


def load_env_file():
    """Load and parse .env file, return as dict."""
    env_vars = {}
    if ENV_FILE.exists():
        load_dotenv(ENV_FILE)
        # Read the file directly to get actual content
        with open(ENV_FILE, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#') and '=' in line:
                    key, value = line.split('=', 1)
                    env_vars[key.strip()] = value.strip()
    return env_vars


def is_field_empty(env_vars, key):
    """Check if a field is empty or not set."""
    value = env_vars.get(key, os.getenv(key, ''))
    return not value or value == f"your_{key.lower()}_here" or value == ""


def detect_opencode_config():
    """
    Detect configuration from OpenCode platform.
    Runs opencode-model-detector.cjs (in the same directory as this script).
    """
    print("[Detect] Checking OpenCode platform...")

    # opencode-model-detector.cjs is in the same directory as this script
    detector_script = Path(__file__).parent / "opencode-model-detector.cjs"

    if not detector_script.exists():
        print("[Detect] OpenCode detector script not found.")
        return None

    print(f"[Detect] Using detector script: {detector_script}")

    try:
        # First try --simple option which outputs provider/model format
        result = subprocess.run(
            ['node', str(detector_script), '--simple'],
            capture_output=True,
            text=True,
            timeout=10
        )

        if result.returncode == 0 and result.stdout.strip():
            output = result.stdout.strip()
            # Parse "provider/model" format
            if '/' in output:
                provider, model = output.split('/', 1)
                print(f"[Detect] Found OpenCode configuration:")
                print(f"  - Provider: {provider}")
                print(f"  - Model: {model}")
                print(f"  - API Key: 未找到 (需要手动配置)")
                print(f"  - Base URL: 默认")

                config = {
                    'provider': provider,
                    'api_key': '',  # API key not available from simple output
                    'base_url': '',
                    'model': model,
                }
                return config

    except (subprocess.TimeoutExpired, FileNotFoundError, Exception) as e:
        print(f"[Detect] Failed to detect OpenCode config with --simple: {e}")

    # Fallback: try parsing the default text output
    try:
        result = subprocess.run(
            ['node', str(detector_script)],
            capture_output=True,
            text=True,
            timeout=10
        )

        if result.returncode == 0 and result.stdout:
            # Parse text format output like:
            "Provider: myprovider\nModel: deepseek-chat\n..."
            provider = ''
            model = ''
            base_url = ''
            api_key = '未找到'

            for line in result.stdout.split('\n'):
                line = line.strip()
                if line.startswith('Provider:'):
                    provider = line.split(':', 1)[1].strip()
                elif line.startswith('Model:'):
                    model = line.split(':', 1)[1].strip()
                elif line.startswith('Base URL:'):
                    base_url = line.split(':', 1)[1].strip()
                elif line.startswith('API Key:'):
                    api_key = line.split(':', 1)[1].strip()

            if provider and model:
                print(f"[Detect] Found OpenCode configuration (from text output):")
                print(f"  - Provider: {provider}")
                print(f"  - Model: {model}")
                print(f"  - API Key: {api_key}")
                print(f"  - Base URL: {base_url}")

                config = {
                    'provider': provider,
                    'api_key': api_key if api_key != '未找到' else '',
                    'base_url': base_url if base_url != '默认' else '',
                    'model': model,
                }
                return config

    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError, Exception) as e:
        print(f"[Detect] Failed to detect OpenCode config with default output: {e}")

    print("[Detect] Could not detect OpenCode configuration.")
    return None


def detect_claude_code_config():
    """
    Detect configuration from Claude Code platform.
    Checks environment variables: ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL
    Also checks ANTHROPIC_DEFAULT_OPUS_MODEL for the current model
    """
    print("[Detect] Checking Claude Code environment...")

    auth_token = os.getenv('ANTHROPIC_AUTH_TOKEN') or os.getenv('ANTHROPIC_API_KEY')
    base_url = os.getenv('ANTHROPIC_BASE_URL')
    model = os.getenv('ANTHROPIC_MODEL') or os.getenv('ANTHROPIC_DEFAULT_OPUS_MODEL')

    if auth_token:
        print(f"[Detect] Found Claude Code configuration:")
        print(f"  - API Key: {'*' * (len(auth_token) - 4)}{auth_token[-4:]}")
        if base_url:
            print(f"  - Base URL: {base_url}")
        if model:
            print(f"  - Model: {model}")

        config = {
            'provider': 'anthropic',
            'api_key': auth_token,
            'base_url': base_url or 'https://api.anthropic.com',
            'model': model,
        }
        return config

    print("[Detect] No Claude Code configuration found.")
    return None


def detect_cursor_config():
    """
    Detect configuration from Cursor/Windsurf platform.
    Checks environment variables: OPENAI_API_KEY, DEEPSEEK_API_KEY
    """
    print("[Detect] Checking Cursor/Windsurf environment...")

    # Check for common LLM API keys
    deepseek_key = os.getenv('DEEPSEEK_API_KEY')
    openai_key = os.getenv('OPENAI_API_KEY')

    if deepseek_key:
        print(f"[Detect] Found DeepSeek configuration:")
        print(f"  - API Key: {'*' * (len(deepseek_key) - 4)}{deepseek_key[-4:]}")
        config = {
            'provider': 'deepseek',
            'api_key': deepseek_key,
            'base_url': os.getenv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/'),
            'model': os.getenv('DEEPSEEK_MODEL', 'deepseek-chat'),
        }
        return config

    if openai_key:
        print(f"[Detect] Found OpenAI configuration:")
        print(f"  - API Key: {'*' * (len(openai_key) - 4)}{openai_key[-4:]}")
        config = {
            'provider': 'openai',
            'api_key': openai_key,
            'base_url': os.getenv('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
            'model': os.getenv('OPENAI_MODEL', 'gpt-4'),
        }
        return config

    print("[Detect] No Cursor/Windsurf configuration found.")
    return None


def map_config_to_env_vars(config):
    """
    Map detected configuration to skill-optimizer's expected environment variable names.
    """
    provider = config.get('provider', '').lower()

    if 'anthropic' in provider or 'claude' in provider:
        # Map Anthropic to OPENAI_API_KEY for compatibility with langchain-openai
        return {
            'OPENAI_API_KEY': config['api_key'],
            'OPENAI_BASE_URL': config.get('base_url', 'https://api.anthropic.com'),
            'OPENAI_MODEL': config.get('model', 'claude-3-5-sonnet-20241022'),
        }
    elif 'deepseek' in provider:
        return {
            'DEEPSEEK_API_KEY': config['api_key'],
            'DEEPSEEK_BASE_URL': config.get('base_url', 'https://api.deepseek.com/'),
            'DEEPSEEK_MODEL': config.get('model', 'deepseek-chat'),
        }
    else:
        # Default to OpenAI format
        return {
            'OPENAI_API_KEY': config['api_key'],
            'OPENAI_BASE_URL': config.get('base_url', 'https://api.openai.com/v1'),
            'OPENAI_MODEL': config.get('model', 'gpt-4'),
        }


def update_env_file(env_vars, updates):
    """
    Update .env file with new values only if fields are empty.
    """
    if not updates:
        return False

    updated = False
    updates_to_apply = {}

    # Check which fields need updating
    for key, value in updates.items():
        if is_field_empty(env_vars, key):
            updates_to_apply[key] = value
            updated = True
            print(f"[Update] Will set {key}")
        else:
            print(f"[Skip] {key} already configured")

    if not updated:
        print("[Info] No fields to update. All API keys are already configured.")
        return False

    # Update .env file
    with open(ENV_FILE, 'a', encoding='utf-8') as f:
        f.write('\n# Auto-detected configuration\n')
        for key, value in updates_to_apply.items():
            f.write(f"{key}={value}\n")
            print(f"[Updated] {key} = {'*' * 20}")

    return True


def main():
    print("=" * 60)
    print("Model Configuration Detector for Skill Optimizer")
    print("=" * 60)

    # Load existing .env file
    env_vars = load_env_file()
    print(f"\n[Info] Loading .env from: {ENV_FILE}")

    # Check if required fields are already configured
    deepseek_configured = not is_field_empty(env_vars, 'DEEPSEEK_API_KEY')
    openai_configured = not is_field_empty(env_vars, 'OPENAI_API_KEY')

    if deepseek_configured or openai_configured:
        print(f"[Info] API key already configured (DEEPSEEK: {deepseek_configured}, OPENAI: {openai_configured})")
        print("[Info] Skipping auto-detection. Remove API key from .env to re-run detection.")
        return 0

    print("\n[Info] No API key found in .env. Starting auto-detection...")

    # Detect configuration from various platforms
    # Priority order: OpenCode > Claude Code > Cursor/Windsurf
    # Continue checking if current config doesn't have an API key
    config = detect_opencode_config()
    if not config or not config.get('api_key'):
        if config and not config.get('api_key'):
            print("[Detect] OpenCode config found but no API key, trying next platform...")
        config = detect_claude_code_config()
    if not config or not config.get('api_key'):
        if config and not config.get('api_key'):
            print("[Detect] Claude Code config found but no API key, trying next platform...")
        config = detect_cursor_config()

    if not config or not config.get('api_key'):
        print("\n[Error] Could not detect API configuration from any platform.")
        print("\nPlease manually configure your .env file with:")
        print("  DEEPSEEK_API_KEY=your_api_key_here")
        print("  DEEPSEEK_BASE_URL=https://api.deepseek.com/")
        print("  DEEPSEEK_MODEL=deepseek-chat")
        print("\nOr use OpenAI:")
        print("  OPENAI_API_KEY=your_api_key_here")
        print("  OPENAI_BASE_URL=https://api.openai.com/v1")
        print("  OPENAI_MODEL=gpt-4")
        return 1

    # Map config to skill-optimizer's expected format
    env_updates = map_config_to_env_vars(config)

    # Update .env file
    if update_env_file(env_vars, env_updates):
        print(f"\n[Success] Configuration updated {ENV_FILE}")
        return 0
    else:
        print("\n[Info] No updates needed.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
