$ErrorActionPreference = 'SilentlyContinue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$ScriptDir\..\lib\common.ps1"
. "$ScriptDir\..\lib\redact.ps1"
$ErrorActionPreference = 'SilentlyContinue'

$rawInput = $input | Out-String

try {
    $hookInput = $rawInput | ConvertFrom-Json -ErrorAction Stop
} catch {
    Write-Output 'allow'
    exit 0
}

$sessionId = $hookInput.session_id
$toolUseId = $hookInput.tool_use_id
$toolName = $hookInput.tool_name
$llmToolName = $hookInput.llm_tool_name
$toolInput = $hookInput.tool_input
$toolResponse = $hookInput.tool_response
$agentId = $hookInput.agent_id
$agentType = $hookInput.agent_type

# Synthetic fallback so we never silently skip spool write
$hadSyntheticId = $false
if (-not $toolUseId) {
    $hadSyntheticId = $true
    $toolUseId = if ($sessionId -and $toolName) { "${sessionId}_${toolName}_$(Get-Random -Minimum 1000 -Maximum 9999)" } else { "fallback_tool_$(Get-Random -Minimum 1000 -Maximum 9999)" }
}
if (-not $sessionId) {
    $sessionId = "fallback_session_$(Get-Random -Minimum 1000 -Maximum 9999)"
}

Write-DebugTrace -HookName 'PostToolUse' -Message "ENTER" -Data "sessionId=$sessionId toolUseId=$toolUseId toolName=$toolName synthetic=$hadSyntheticId"
Write-RawDebug -RawInput $rawInput -HookName 'PostToolUse' -SessionId $sessionId

$toolTraceId = "tool_$toolUseId"

# Read tool type from state file
$stateDir = if ($env:TRAE_TOOL_STATE_DIR) { $env:TRAE_TOOL_STATE_DIR } else { "$env:TEMP\.trae-tool-state" }
$stateFile = Join-Path $stateDir "$toolUseId.json"
$toolType = 'unknown'
$skillNameFromState = ''

if (Test-Path $stateFile) {
    try {
        $stateData = Get-Content $stateFile -Raw | ConvertFrom-JsonSafe
        $toolType = $stateData.toolType
        $skillNameFromState = $stateData.skillName
    } catch {}
}

# Authoritative classification by tool_response structure
$responseJson = '{}'
if ($toolResponse) {
    try {
        if ($toolResponse -is [string]) {
            $responseJson = $toolResponse
        } else {
            $responseJson = $toolResponse | ConvertTo-Json -Depth 20 -Compress
        }
    } catch {
        $responseJson = '{}'
    }
}

if ($responseJson -and $responseJson -ne '{}') {
    try {
        $respObj = $responseJson | ConvertFrom-JsonSafe
        if ($respObj.skill_path -and $respObj.skill_type) {
            $toolType = 'skill'
        }
        $content = $respObj.content
        if ($content -is [array] -and $respObj.status -and $toolType -ne 'skill') {
            $toolType = 'mcp'
        }
    } catch {}
}

# Fallback re-classification if state file missing
if ($toolType -eq 'unknown') {
    $toolType = Get-ToolType -ToolName $toolName -LlmToolName $llmToolName
}

# Redact and truncate
$toolInputJson = '{}'
if ($toolInput) {
    try {
        if ($toolInput -is [string]) {
            $parsed = $toolInput | ConvertFrom-Json -ErrorAction Stop
            $toolInputJson = $parsed | ConvertTo-Json -Depth 10 -Compress
        } else {
            $toolInputJson = $toolInput | ConvertTo-Json -Depth 10 -Compress
        }
    } catch {}
}

# Skip Redact-Json which silently drops data in PS 5.1
$safeInput = $toolInputJson
$safeInput = Get-TruncatedPayload -Json $safeInput -MaxLen $MaxToolIoSize
$safeResponse = $responseJson
$safeResponse = Get-TruncatedPayload -Json $safeResponse -MaxLen $MaxToolIoSize

# Extract exit code / error
$exitCode = ''
$errorMsg = ''
$toolLatencyMs = $null
if ($responseJson -and $responseJson -ne '{}') {
    try {
        $respObj = $responseJson | ConvertFrom-JsonSafe
        if ($respObj.exit_code) { $exitCode = [string]$respObj.exit_code }
        if ($respObj.error) { $errorMsg = [string]$respObj.error }
        if (-not $errorMsg -and $respObj.stderr) { $errorMsg = [string]$respObj.stderr }
        # TRAE web 工具（WebSearch/WebFetch）失败时用 error_code/error_msg 指示（成功时 null）
        if (-not $errorMsg -and $respObj.error_msg) { $errorMsg = [string]$respObj.error_msg }
        # 失败命令（exit_code≠0）且无 stderr/error_msg 时：stdout 兜底；仍空则合成失败提示
        if (-not $errorMsg -and $exitCode -and $exitCode -ne '0') {
            if ($respObj.stdout) { $errorMsg = [string]$respObj.stdout }
        }
        if (-not $errorMsg -and $exitCode -and $exitCode -ne '0') {
            $errorMsg = "command failed (exit code: $exitCode)"
        }
        # TRAE RunCommand 响应带真实执行窗口，优先写入 latencyMs
        if ($respObj.command_start_ms -and $respObj.command_end_ms) {
            $cmdStart = [long]$respObj.command_start_ms
            $cmdEnd = [long]$respObj.command_end_ms
            if ($cmdEnd -ge $cmdStart) { $toolLatencyMs = $cmdEnd - $cmdStart }
        }
    } catch {}
}

# Build tool.call.end payload
$endPayload = @{
    toolName = $toolName
    toolType = $toolType
    toolUseId = $toolUseId
}
if ($llmToolName) {
    $endPayload.llm_tool_name = $llmToolName
}
if ($exitCode) {
    $endPayload.exitCode = if ($exitCode -match '^\d+$') { [int]$exitCode } else { $exitCode }
}
if ($null -ne $toolLatencyMs) {
    $endPayload.latencyMs = $toolLatencyMs
}
if ($errorMsg) {
    $safeError = Redact-Text -Text $errorMsg
    $safeError = Get-TruncatedString -Str $safeError -MaxLen $MaxContentLength
    $endPayload.error = $safeError
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
    $endPayload.toolType = 'mcp'
    $endPayload.mcpServerName = $mcpServerName
    $endPayload.mcpToolName = $mcpToolName
}

try {
    $respObj = $safeResponse | ConvertFrom-JsonSafe
    $endPayload.toolResponse = $respObj
} catch {
    $endPayload.toolResponse = @{}
}

$endPayloadJson = $endPayload | ConvertTo-Json -Depth 20 -Compress

try {
    Write-SpoolEvent -Kind 'tool.call.end' `
        -SessionId $sessionId `
        -TraceId $toolTraceId `
        -ParentId $sessionId `
        -Payload $endPayloadJson `
        -AgentId $agentId `
        -AgentType $agentType
    Write-DebugTrace -HookName 'PostToolUse' -Message "SPOOL_OK" -Data "traceId=$toolTraceId"
} catch {
    Write-DebugTrace -HookName 'PostToolUse' -Message "SPOOL_FAIL" -Data "traceId=$toolTraceId error=$($_.Exception.Message)"
}

# Generate dedicated Skill Trace
if ($toolType -eq 'skill' -or $toolName -eq 'Skill') {
    $skillTraceId = "skill_$toolUseId"
    $skillName = $skillNameFromState
    if (-not $skillName) {
        try {
            $inputObj = $toolInputJson | ConvertFrom-JsonSafe
            if ($inputObj.name) { $skillName = $inputObj.name }
            elseif ($inputObj.skill) { $skillName = $inputObj.skill }
        } catch {}
    }
    if (-not $skillName) { $skillName = $toolName }

    $skillVersion = ''
    $triggerMode = 'auto'
    $skillPath = ''
    $skillTypeFromResp = ''

    try {
        $respObj = $responseJson | ConvertFrom-JsonSafe
        if ($respObj.skill_path) { $skillPath = $respObj.skill_path }
        if ($respObj.skill_type) { $skillTypeFromResp = $respObj.skill_type }
    } catch {}

    $skillPayload = @{
        skillName = $skillName
        triggerMode = $triggerMode
    }
    if ($skillVersion) { $skillPayload.skillVersion = $skillVersion }
    if ($skillPath) { $skillPayload.skillPath = $skillPath }
    if ($skillTypeFromResp) { $skillPayload.skillType = $skillTypeFromResp }
    try {
        $inputObj = $safeInput | ConvertFrom-JsonSafe
        $skillPayload.params = $inputObj
    } catch {
        $skillPayload.params = @{}
    }
    if ($safeResponse -and $safeResponse -ne '{}') {
        try {
            $respObj = $safeResponse | ConvertFrom-JsonSafe
            $skillPayload.result = $respObj
        } catch {}
    }
    if ($errorMsg) {
        $safeError = Redact-Text -Text $errorMsg
        $safeError = Get-TruncatedString -Str $safeError -MaxLen $MaxContentLength
        $skillPayload.error = $safeError
    }

    $skillPayloadJson = $skillPayload | ConvertTo-Json -Depth 20 -Compress

    try {
        Write-SpoolEvent -Kind 'skill.call.end' `
            -SessionId $sessionId `
            -TraceId $skillTraceId `
            -ParentId $sessionId `
            -Payload $skillPayloadJson `
            -AgentId $agentId `
            -AgentType $agentType
        Write-DebugTrace -HookName 'PostToolUse' -Message "SKILL_SPOOL_OK" -Data "traceId=$skillTraceId"
    } catch {
        Write-DebugTrace -HookName 'PostToolUse' -Message "SKILL_SPOOL_FAIL" -Data "traceId=$skillTraceId error=$($_.Exception.Message)"
    }
}

# Generate dedicated MCP Trace
if ($toolType -eq 'mcp') {
    $mcpTraceId = "mcp_$toolUseId"
    $mcpServerName = 'trae'
    $mcpToolName = $llmToolName

    if ($toolName -match '^mcp__') {
        $withoutPrefix = $toolName -replace '^mcp__', ''
        $parts = $withoutPrefix -split '__'
        $mcpServerName = $parts[0]
        $mcpToolName = if ($parts.Count -gt 1) { $parts[-1] } else { $llmToolName }
    }

    $mcpPayload = @{
        serverName = $mcpServerName
        toolName = $mcpToolName
    }
    try {
        $inputObj = $safeInput | ConvertFrom-JsonSafe
        $mcpPayload.params = $inputObj
    } catch {
        $mcpPayload.params = @{}
    }
    if ($safeResponse -and $safeResponse -ne '{}') {
        try {
            $respObj = $safeResponse | ConvertFrom-JsonSafe
            $mcpPayload.result = $respObj
            # AC19: MCP 标准失败指示 isError=true（错误内容在 content[].text）
            if ($respObj.isError -eq $true -and $respObj.content) {
                $errTexts = @($respObj.content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text })
                $errMsg = ($errTexts -join ' ')
                if (-not $errMsg) { $errMsg = 'MCP call failed (isError=true)' }
                $mcpPayload.error = Get-TruncatedString -Str (Redact-Text -Text $errMsg) -MaxLen $MaxContentLength
            }
        } catch {}
    }
    if (-not $mcpPayload.ContainsKey('error') -and $errorMsg) {
        $safeError = Redact-Text -Text $errorMsg
        $safeError = Get-TruncatedString -Str $safeError -MaxLen $MaxContentLength
        $mcpPayload.error = $safeError
    }

    $mcpPayloadJson = $mcpPayload | ConvertTo-Json -Depth 20 -Compress

    try {
        Write-SpoolEvent -Kind 'mcp.call.end' `
            -SessionId $sessionId `
            -TraceId $mcpTraceId `
            -ParentId $sessionId `
            -Payload $mcpPayloadJson `
            -AgentId $agentId `
            -AgentType $agentType
        Write-DebugTrace -HookName 'PostToolUse' -Message "MCP_SPOOL_OK" -Data "traceId=$mcpTraceId"
    } catch {
        Write-DebugTrace -HookName 'PostToolUse' -Message "MCP_SPOOL_FAIL" -Data "traceId=$mcpTraceId error=$($_.Exception.Message)"
    }
}

# Remove state file
if (Test-Path $stateFile) {
    Remove-Item $stateFile -Force -ErrorAction SilentlyContinue
}

Write-DebugTrace -HookName 'PostToolUse' -Message "EXIT"
Write-Output 'allow'
exit 0
