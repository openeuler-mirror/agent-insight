#!/usr/bin/env bash
set -euo pipefail

# Maps a MODEL string to the env var name that must hold its API key.
# Prints the var name to stdout. On unknown model — error to stderr, exit 1.
api_key_var_for_model() {
    local model="${1:?api_key_var_for_model requires <model>}"
    case "${model}" in
        opencode/*)                            echo OPENCODE_API_KEY ;;
        openrouter/*)                          echo OPENROUTER_API_KEY ;;
        deepseek/*|deepseek-*|qwen/deepseek-*) echo DEEPSEEK_API_KEY ;;
        gpt-*|openai/*|o1-*)                   echo OPENAI_API_KEY ;;
        claude-*|anthropic/*)                  echo ANTHROPIC_API_KEY ;;
        gemini-*|google/*)                     echo GOOGLE_API_KEY ;;
        together_ai/*)                         echo TOGETHER_API_KEY ;;
        *) echo "Error: unknown model '${model}' — extend api_key_var_for_model in $(basename "${BASH_SOURCE[0]}")" >&2
           return 1 ;;
    esac
}

# Asserts that the API key required by MODEL is set in the current environment.
# .env must already be sourced by the caller.
require_api_key() {
    local model="${1:?require_api_key requires <model>}"
    local var
    var="$(api_key_var_for_model "${model}")"
    if [[ -z "${!var:-}" ]]; then
        echo "Error: ${var} is empty or unset (required for MODEL='${model}'). Set it in skillbench/.env." >&2
        return 1
    fi
    echo "🔑 ${var} OK (model: ${model})"
}

# Direct CLI use: ./check_api_keys.sh <model>
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    [[ $# -eq 1 ]] || { echo "Usage: ${0} <model>" >&2; exit 1; }
    require_api_key "${1}"
fi
