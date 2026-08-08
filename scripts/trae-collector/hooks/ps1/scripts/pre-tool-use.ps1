$ErrorActionPreference = 'SilentlyContinue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$ScriptDir\..\lib\common.ps1"
. "$ScriptDir\..\lib\redact.ps1"
$ErrorActionPreference = 'SilentlyContinue'

$rawInput = $input | Out-String

try {
    $hookInput = $rawInput | ConvertFrom-Json -ErrorAction Stop
} catch {
    Write-Output '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
    exit 0
}

$sessionId = $hookInput.session_id
$toolUseId = $hookInput.tool_use_id
$toolName = $hookInput.tool_name
$llmToolName = $hookInput.llm_tool_name
$toolInput = $hookInput.tool_input
$agentId = $hookInput.agent_id
$agentType = $hookInput.agent_type
$cwd = $hookInput.cwd

# Synthetic fallback so we never silently skip spool write
$hadSyntheticId = $false
if (-not $toolUseId) {
    $hadSyntheticId = $true
    $toolUseId = if ($sessionId -and $toolName) { "${sessionId}_${toolName}_$(Get-Random -Minimum 1000 -Maximum 9999)" } else { "fallback_tool_$(Get-Random -Minimum 1000 -Maximum 9999)" }
}
if (-not $sessionId) {
    $sessionId = "fallback_session_$(Get-Random -Minimum 1000 -Maximum 9999)"
}

Write-DebugTrace -HookName 'PreToolUse' -Message "ENTER" -Data "sessionId=$sessionId toolUseId=$toolUseId toolName=$toolName synthetic=$hadSyntheticId"
Write-RawDebug -RawInput $rawInput -HookName 'PreToolUse' -SessionId $sessionId

$toolTraceId = "tool_$toolUseId"

$toolInputJson = ''
if ($toolInput) {
    try {
        if ($toolInput -is [string]) {
            $parsed = $toolInput | ConvertFrom-Json -ErrorAction Stop
            $toolInputJson = $parsed | ConvertTo-Json -Depth 10 -Compress
        } else {
            $toolInputJson = $toolInput | ConvertTo-Json -Depth 10 -Compress
        }
    } catch {
        $toolInputJson = '{}'
    }
} else {
    $toolInputJson = '{}'
}

Write-DebugTrace -HookName 'PreToolUse' -Message "RAW_INPUT_JSON" -Data "len=$($toolInputJson.Length) json=$toolInputJson"

# Use raw JSON directly - skip Redact-Json which silently drops data in PS 5.1
$safeInput = $toolInputJson
Write-DebugTrace -HookName 'PreToolUse' -Message "AFTER_REDACT" -Data "len=$($safeInput.Length) json=$safeInput"

$safeInput = Get-TruncatedPayload -Json $safeInput -MaxLen $MaxToolIoSize
Write-DebugTrace -HookName 'PreToolUse' -Message "AFTER_TRUNCATE" -Data "len=$($safeInput.Length) json=$safeInput"

$toolType = Get-ToolType -ToolName $toolName -LlmToolName $llmToolName

$skillName = ''
$skillVersion = ''
if ($toolType -eq 'skill') {
    try {
        $inputObj = ConvertFrom-JsonSafe -Json $toolInputJson
        if ($inputObj.name) { $skillName = $inputObj.name }
        elseif ($inputObj.skill) { $skillName = $inputObj.skill }
    } catch {}
    if (-not $skillName) { $skillName = $toolName }
}

if ($toolType -eq 'terminal') {
    try {
        $inputObj = ConvertFrom-JsonSafe -Json $safeInput
        if ($inputObj.command) {
            $inputObj.command = Redact-Text -Text $inputObj.command
            $safeInput = $inputObj | ConvertTo-Json -Depth 10 -Compress
        }
    } catch {}
}

Write-DebugTrace -HookName 'PreToolUse' -Message "BEFORE_PAYLOAD" -Data "safeInput_len=$($safeInput.Length) toolType=$toolType skillName=$skillName"

$payload = @{
    toolName = $toolName
    toolType = $toolType
    llm_tool_name = $llmToolName
    toolUseId = $toolUseId
    toolInput = (ConvertFrom-JsonSafe -Json $safeInput)
}

Write-DebugTrace -HookName 'PreToolUse' -Message "PAYLOAD_BUILT" -Data "keys=$($payload.Keys -join ',')"

if ($toolType -eq 'skill' -and $skillName) {
    $payload.skillName = $skillName
    if ($skillVersion) { $payload.skillVersion = $skillVersion }
    $payload.triggerMode = 'auto'
}

if ($cwd) {
    $payload.cwd = $cwd
}

if ($toolType -eq 'mcp') {
    $mcpServerName = 'trae'
    $mcpToolName = $llmToolName
    if ($toolName -match '^mcp__') {
        $withoutPrefix = $toolName -replace '^mcp__', ''
        $parts = $withoutPrefix -split '__'
        $mcpServerName = $parts[0]
        $mcpToolName = if ($parts.Count -gt 1) { $parts[-1] } else { $llmToolName }
    }
    $payload.mcpServerName = $mcpServerName
    $payload.mcpToolName = $mcpToolName
}

if ($agentType -ne 'solo_agent' -and $agentType -match '_agent$') {
    $payload.subagentId = $agentId
    $payload.subagentType = $agentType
}

Write-DebugTrace -HookName 'PreToolUse' -Message "BEFORE_JSON" -Data "payload_type=$($payload.GetType().Name)"

try {
    $payloadJson = $payload | ConvertTo-Json -Depth 20 -Compress
    Write-DebugTrace -HookName 'PreToolUse' -Message "JSON_OK" -Data "len=$($payloadJson.Length)"
} catch {
    Write-DebugTrace -HookName 'PreToolUse' -Message "JSON_FAIL" -Data "error=$($_.Exception.Message)"
    $payloadJson = '{}'
}

try {
    Write-SpoolEvent -Kind 'tool.call.start' `
        -SessionId $sessionId `
        -TraceId $toolTraceId `
        -ParentId $sessionId `
        -Payload $payloadJson `
        -AgentId $agentId `
        -AgentType $agentType
    Write-DebugTrace -HookName 'PreToolUse' -Message "SPOOL_OK" -Data "traceId=$toolTraceId"
} catch {
    Write-DebugTrace -HookName 'PreToolUse' -Message "SPOOL_FAIL" -Data "traceId=$toolTraceId error=$($_.Exception.Message)"
}

$stateDir = if ($env:TRAE_TOOL_STATE_DIR) { $env:TRAE_TOOL_STATE_DIR } else { "$env:TEMP\.trae-tool-state" }
if (-not (Test-Path $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
}
$stateFile = Join-Path $stateDir "$toolUseId.json"
$stateData = @{
    toolType = $toolType
    toolName = $toolName
    skillName = $skillName
}
try {
    $stateData | ConvertTo-Json -Depth 5 -Compress | Set-Content -Path $stateFile -Encoding UTF8
    Write-DebugTrace -HookName 'PreToolUse' -Message "STATE_OK" -Data "stateFile=$stateFile"
} catch {
    Write-DebugTrace -HookName 'PreToolUse' -Message "STATE_FAIL" -Data "stateFile=$stateFile error=$($_.Exception.Message)"
}

Write-DebugTrace -HookName 'PreToolUse' -Message "EXIT"
Write-Output '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
exit 0
