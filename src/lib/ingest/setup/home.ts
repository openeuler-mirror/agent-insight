export const SETUP_BASH_HOME = [
  "",
  "if [ -n \"${AGENT_INSIGHT_DATA_DIR:-}\" ]; then",
  "    echo \"AGENT_INSIGHT_DATA_DIR is no longer supported; use AGENT_INSIGHT_HOME.\" >&2",
  "    exit 1",
  "fi",
  "AGENT_INSIGHT_HOME=\"${AGENT_INSIGHT_HOME:-$HOME/.agent-insight}\"",
  "case \"$AGENT_INSIGHT_HOME\" in",
  "    '~'|'~/'*) AGENT_INSIGHT_HOME=\"$HOME${AGENT_INSIGHT_HOME#\\~}\" ;;",
  "    '$HOME'|'$HOME/'*) AGENT_INSIGHT_HOME=\"$HOME${AGENT_INSIGHT_HOME#\\$HOME}\" ;;",
  "    '${HOME}'|'${HOME}/'*) AGENT_INSIGHT_HOME=\"$HOME${AGENT_INSIGHT_HOME#\\$\\{HOME\\}}\" ;;",
  "esac",
  "case \"$AGENT_INSIGHT_HOME\" in /*) ;; *) AGENT_INSIGHT_HOME=\"$PWD/$AGENT_INSIGHT_HOME\" ;; esac",
  "export AGENT_INSIGHT_HOME",
  "agent_insight_write_script() {",
  "    printf '#!/bin/bash\\nexport AGENT_INSIGHT_HOME=%q\\n' \"$AGENT_INSIGHT_HOME\"",
  "    cat",
  "}",
  "",
].join('\n');

export const SETUP_POWERSHELL_HOME = [
  "",
  "if ($env:AGENT_INSIGHT_DATA_DIR) { throw 'AGENT_INSIGHT_DATA_DIR is no longer supported; use AGENT_INSIGHT_HOME.' }",
  "if (-not $env:AGENT_INSIGHT_HOME) { $env:AGENT_INSIGHT_HOME = Join-Path $HOME '.agent-insight' }",
  "$env:AGENT_INSIGHT_HOME = [regex]::Replace($env:AGENT_INSIGHT_HOME, '^(~|\\$HOME|\\$\\{HOME\\})(?=[/\\\\]|$)', { param($match) $HOME })",
  "$env:AGENT_INSIGHT_HOME = [System.IO.Path]::GetFullPath($env:AGENT_INSIGHT_HOME)",
  "",
].join('\n');
