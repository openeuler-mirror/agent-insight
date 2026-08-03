export const CODEAGENT_UNIX_SETUP_BLOCK = `# 6.6 Configure CodeAgent OpenTelemetry wrapper
if [ "$INSTALL_CODEAGENT" = "true" ]; then
    CODEAGENT_WRAPPER_DIR="$HOME/.agent-insight/bin"
    CODEAGENT_WRAPPER_PATH="$CODEAGENT_WRAPPER_DIR/codeagent"
    CODEAGENT_REAL_BIN_FILE="$HOME/.agent-insight/codeagent_real_bin"
    mkdir -p "$CODEAGENT_WRAPPER_DIR"

    _ai_codeagent_clean_path=""
    _ai_codeagent_old_ifs="$IFS"
    IFS=:
    for _ai_codeagent_path_entry in \${PATH:-}; do
        case "$_ai_codeagent_path_entry" in "$CODEAGENT_WRAPPER_DIR"|"$CODEAGENT_WRAPPER_DIR/") continue ;; esac
        [ -z "$_ai_codeagent_path_entry" ] && continue
        _ai_codeagent_clean_path="\${_ai_codeagent_clean_path:+$_ai_codeagent_clean_path:}$_ai_codeagent_path_entry"
    done
    IFS="$_ai_codeagent_old_ifs"
    CODEAGENT_REAL_BIN="$(PATH="$_ai_codeagent_clean_path" type -P codeagent 2>/dev/null || true)"
    if [ -n "$CODEAGENT_REAL_BIN" ] && [ "$CODEAGENT_REAL_BIN" != "$CODEAGENT_WRAPPER_PATH" ]; then
        printf '%s\\n' "$CODEAGENT_REAL_BIN" > "$CODEAGENT_REAL_BIN_FILE"
    elif [ ! -s "$CODEAGENT_REAL_BIN_FILE" ]; then
        echo "⚠️  CodeAgent executable not found. Install CodeAgent, then rerun setup."
    fi

    cat > "$CODEAGENT_WRAPPER_PATH" << 'CODEAGENT_WRAPPER_EOF'
#!/usr/bin/env bash
# Agent-Insight CodeAgent executable wrapper
_agent_insight_dir="$HOME/.agent-insight"
_wrapper_dir="$_agent_insight_dir/bin"
_clean_path=""
IFS=':' read -r -a _path_entries <<< "\${PATH:-}"
for _path_entry in "\${_path_entries[@]}"; do
  case "$_path_entry" in "$_wrapper_dir"|"$_wrapper_dir/") continue ;; esac
  [ -z "$_path_entry" ] && continue
  _clean_path="\${_clean_path:+$_clean_path:}$_path_entry"
done

_real_bin="$(PATH="$_clean_path" type -P codeagent 2>/dev/null || true)"
if [ -z "$_real_bin" ] && [ -r "$_agent_insight_dir/codeagent_real_bin" ]; then
  IFS= read -r _recorded_bin < "$_agent_insight_dir/codeagent_real_bin"
  if [ -x "$_recorded_bin" ] && [ "$_recorded_bin" != "$0" ]; then
    _real_bin="$_recorded_bin"
  fi
fi
if [ -z "$_real_bin" ]; then
  echo "Agent Insight: CodeAgent executable not found outside $_wrapper_dir." >&2
  echo "Install CodeAgent or rerun Agent Insight setup after updating PATH." >&2
  exit 127
fi

if [ -f "$_agent_insight_dir/.env" ]; then
  set -a
  . "$_agent_insight_dir/.env"
  set +a
fi
_si_host="\${AGENT_INSIGHT_HOST:-127.0.0.1:3000}"
case "$_si_host" in http://*|https://*) ;; *) _si_host="http://$_si_host" ;; esac
_si_host="\${_si_host%/}"

exec env \\
  CODEAGENT3_ENABLE_TELEMETRY=1 \\
  OTEL_EXPORTER_OTLP_ENDPOINT="$_si_host/api/ingest/otel" \\
  OTEL_EXPORTER_OTLP_PROTOCOL=http/json \\
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json \\
  OTEL_EXPORTER_OTLP_HEADERS="x-witty-api-key=\${AGENT_INSIGHT_API_KEY:-}" \\
  "$_real_bin" "$@"
CODEAGENT_WRAPPER_EOF
    chmod 0755 "$CODEAGENT_WRAPPER_PATH"

    cat > "$HOME/.agent-insight/codeagent_otel_env.sh" << 'CODEAGENT_OTEL_EOF'
# Agent-Insight CodeAgent OpenTelemetry integration
unalias codeagent 2>/dev/null || true
_agent_insight_codeagent_bin="$HOME/.agent-insight/bin"
case ":\${PATH:-}:" in
  *":$_agent_insight_codeagent_bin:"*) ;;
  *) export PATH="$_agent_insight_codeagent_bin\${PATH:+:$PATH}" ;;
esac
unset _agent_insight_codeagent_bin
CODEAGENT_OTEL_EOF
    SHELL_RC="$HOME/.zshrc"
    [ -f "$HOME/.bashrc" ] && SHELL_RC="$HOME/.bashrc"
    if [ -f "$SHELL_RC" ] && ! grep -q "\\.agent-insight/codeagent_otel_env\\.sh" "$SHELL_RC"; then
        echo "" >> "$SHELL_RC"
        echo "# Agent-Insight CodeAgent OTel" >> "$SHELL_RC"
        echo "source \\"$HOME/.agent-insight/codeagent_otel_env.sh\\"" >> "$SHELL_RC"
    fi
    echo "✅ CodeAgent OTel wrapper installed at $CODEAGENT_WRAPPER_PATH"
    echo "   Restart your terminal or run: source $HOME/.agent-insight/codeagent_otel_env.sh"
    echo "   Then use the original command in terminals or scripts: codeagent"
    echo "   CodeAgent may still send traces/metrics; Agent Insight accepts and discards those signals."
fi`;

export const CODEAGENT_WINDOWS_SETUP_BLOCK = `# 6.6a Configure CodeAgent OpenTelemetry wrapper
if ($INSTALL_CODEAGENT) {
    $codeAgentInsightDir = Join-Path $env:USERPROFILE ".agent-insight"
    $codeAgentBinDir = Join-Path $codeAgentInsightDir "bin"
    $codeAgentCmdPath = Join-Path $codeAgentBinDir "codeagent.cmd"
    $codeAgentWrapperPath = Join-Path $codeAgentBinDir "codeagent-wrapper.ps1"
    $codeAgentRealBinFile = Join-Path $codeAgentInsightDir "codeagent_real_bin"
    New-Item -ItemType Directory -Path $codeAgentBinDir -Force | Out-Null

    $codeAgentBinNormalized = $codeAgentBinDir.TrimEnd([IO.Path]::DirectorySeparatorChar)
    $codeAgentCleanPath = (($env:PATH -split ";") | Where-Object {
        $_ -and $_.Trim().TrimEnd([IO.Path]::DirectorySeparatorChar) -ine $codeAgentBinNormalized
    }) -join ";"
    $codeAgentOriginalPath = $env:PATH
    try {
        $env:PATH = $codeAgentCleanPath
        $codeAgentCommand = Get-Command codeagent -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
    } finally {
        $env:PATH = $codeAgentOriginalPath
    }
    if ($codeAgentCommand -and $codeAgentCommand.Source -and $codeAgentCommand.Source -ine $codeAgentCmdPath -and $codeAgentCommand.Source -ine $codeAgentWrapperPath) {
        Set-Content -Path $codeAgentRealBinFile -Value $codeAgentCommand.Source -Encoding UTF8
    } elseif (-not (Test-Path $codeAgentRealBinFile)) {
        Write-Warning "CodeAgent executable not found. Install CodeAgent, then rerun setup."
    }

    $codeAgentWrapperScript = @'
$agentInsightDir = Join-Path $env:USERPROFILE ".agent-insight"
$wrapperDir = Join-Path $agentInsightDir "bin"
$wrapperCmdPath = Join-Path $wrapperDir "codeagent.cmd"
$recordedBinFile = Join-Path $agentInsightDir "codeagent_real_bin"
$wrapperDirNormalized = $wrapperDir.TrimEnd([IO.Path]::DirectorySeparatorChar)
$cleanPath = (($env:PATH -split ";") | Where-Object {
    $_ -and $_.Trim().TrimEnd([IO.Path]::DirectorySeparatorChar) -ine $wrapperDirNormalized
}) -join ";"
$originalPath = $env:PATH
try {
    $env:PATH = $cleanPath
    $command = Get-Command codeagent -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
} finally {
    $env:PATH = $originalPath
}
$realBin = if ($command -and $command.Source -and $command.Source -ine $wrapperCmdPath -and $command.Source -ine $PSCommandPath) {
    $command.Source
} else {
    $null
}
if (-not $realBin -and (Test-Path $recordedBinFile)) {
    $recordedBin = (Get-Content $recordedBinFile -Raw).Trim()
    if ($recordedBin -and (Test-Path -LiteralPath $recordedBin -PathType Leaf) -and $recordedBin -ine $wrapperCmdPath -and $recordedBin -ine $PSCommandPath) {
        $realBin = $recordedBin
    }
}
if (-not $realBin) {
    Write-Error "Agent Insight: CodeAgent executable not found outside $wrapperDir. Install CodeAgent or rerun setup after updating PATH."
    exit 127
}

$envFile = Join-Path $agentInsightDir ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match "^([^#=]+)=(.*)$") {
            [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2], "Process")
        }
    }
}
$siHost = if ($env:AGENT_INSIGHT_HOST) { $env:AGENT_INSIGHT_HOST } else { "127.0.0.1:3000" }
if ($siHost -notmatch "^https?://") { $siHost = "http://$siHost" }
$siHost = $siHost.TrimEnd("/")
$env:CODEAGENT3_ENABLE_TELEMETRY = "1"
$env:OTEL_EXPORTER_OTLP_ENDPOINT = "$siHost/api/ingest/otel"
$env:OTEL_EXPORTER_OTLP_PROTOCOL = "http/json"
$env:OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/json"
$env:OTEL_EXPORTER_OTLP_HEADERS = "x-witty-api-key=$($env:AGENT_INSIGHT_API_KEY)"

& $realBin @args
$exitCode = $LASTEXITCODE
if ($null -eq $exitCode) { $exitCode = 0 }
exit $exitCode
'@
    Set-Content -Path $codeAgentWrapperPath -Value $codeAgentWrapperScript -Encoding UTF8

    $codeAgentCmdScript = @'
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\\.agent-insight\\bin\\codeagent-wrapper.ps1" %*
exit /b %ERRORLEVEL%
'@
    Set-Content -Path $codeAgentCmdPath -Value $codeAgentCmdScript -Encoding ASCII

    $codeAgentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $codeAgentUserPathEntries = @(($codeAgentUserPath -split ";") | Where-Object {
        $_ -and $_.Trim().TrimEnd([IO.Path]::DirectorySeparatorChar) -ine $codeAgentBinNormalized
    })
    $codeAgentUpdatedUserPath = (@($codeAgentBinDir) + $codeAgentUserPathEntries) -join ";"
    if ($codeAgentUpdatedUserPath -ne $codeAgentUserPath) {
        [Environment]::SetEnvironmentVariable("Path", $codeAgentUpdatedUserPath, "User")
    }

    $codeAgentOtelScript = @'
# Agent-Insight CodeAgent OpenTelemetry integration
Remove-Item Alias:codeagent -Force -ErrorAction SilentlyContinue
Remove-Item Function:Invoke-AgentInsightCodeAgent -Force -ErrorAction SilentlyContinue
$_agentInsightCodeAgentBin = Join-Path (Join-Path $env:USERPROFILE ".agent-insight") "bin"
$_agentInsightCodeAgentBinNormalized = $_agentInsightCodeAgentBin.TrimEnd([IO.Path]::DirectorySeparatorChar)
$_agentInsightCodeAgentPathEntries = @(($env:PATH -split ";") | Where-Object {
    $_ -and $_.Trim().TrimEnd([IO.Path]::DirectorySeparatorChar) -ine $_agentInsightCodeAgentBinNormalized
})
$env:PATH = (@($_agentInsightCodeAgentBin) + $_agentInsightCodeAgentPathEntries) -join ";"
Remove-Variable _agentInsightCodeAgentBin, _agentInsightCodeAgentBinNormalized, _agentInsightCodeAgentPathEntries -ErrorAction SilentlyContinue
'@
    $codeAgentOtelPath = Join-Path $codeAgentInsightDir "codeagent_otel_env.ps1"
    Set-Content -Path $codeAgentOtelPath -Value $codeAgentOtelScript -Encoding UTF8
    $profileDir = Split-Path $PROFILE -Parent
    if ($profileDir) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
    if (-not (Test-Path $PROFILE) -or -not ((Get-Content $PROFILE -Raw) -match "codeagent_otel_env.ps1")) {
        Add-Content -Path $PROFILE -Value ""
        Add-Content -Path $PROFILE -Value "# Agent-Insight CodeAgent OTel"
        Add-Content -Path $PROFILE -Value ('. "' + $codeAgentOtelPath + '"')
    }
    Write-Host "✅ CodeAgent OTel wrapper installed at $codeAgentCmdPath"
    Write-Host ('   Restart PowerShell or run: . "' + $codeAgentOtelPath + '"')
    Write-Host "   Then use the original command in PowerShell, CMD, or scripts: codeagent"
    Write-Host "   CodeAgent may still send traces/metrics; Agent Insight accepts and discards those signals."
}`;
