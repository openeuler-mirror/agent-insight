# ============================================================================
# Agent Insight TRAE Collector — Stop Handler (PowerShell)
# stdin: { session_id, text_content, last_assistant_message, loop_count,
#          stop_hook_active, agent_id, agent_type }
# stdout: "allow"
# ============================================================================
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\..\lib\common.ps1"
. "$PSScriptRoot\subagent-detect.ps1"

$rawInput = [System.Console]::In.ReadToEnd()
Write-RawDebug -RawInput $rawInput -HookName 'Stop'

try {
    $data = $rawInput | ConvertFrom-Json
} catch {
    Write-Output "allow"
    exit 0
}

$sessionId = $data.session_id
$agentId = $data.agent_id
$agentType = $data.agent_type
$lastMsg = $data.last_assistant_message
$textContent = $data.text_content
$loopCount = $data.loop_count
$stopActive = $data.stop_hook_active

if ([string]::IsNullOrEmpty($sessionId)) {
    Write-Output "allow"
    exit 0
}

if (-not [string]::IsNullOrEmpty($textContent)) {
    $fullMsg = $textContent
} else {
    $fullMsg = $lastMsg
}

if ([string]::IsNullOrEmpty($fullMsg)) {
    $fullMsg = ''
}

$safeMsg = Get-TruncatedString -Str $fullMsg -MaxLen 20000
$safeMsg = Redact-Text -InputString $safeMsg

$loopCountVal = if ($loopCount) { $loopCount } else { 0 }
$stopActiveVal = if ($stopActive) { $stopActive } else { $false }

Write-SpoolEvent `
    -Kind 'agent.response' `
    -SessionId $sessionId `
    -TraceId $sessionId `
    -ParentId '' `
    -Payload @{
        finalResult = $safeMsg
        length = $safeMsg.Length
        loopCount = [int]$loopCountVal
        stopActive = $stopActiveVal
    } `
    -AgentId $agentId `
    -AgentType $agentType

Write-SpoolEvent `
    -Kind 'agent.session.stop' `
    -SessionId $sessionId `
    -TraceId $sessionId `
    -ParentId '' `
    -Payload @{
        reason = 'stop-hook'
        loopCount = [int]$loopCountVal
        resultLength = $safeMsg.Length
    } `
    -AgentId $agentId `
    -AgentType $agentType

$llmTruncated = Get-TruncatedString -Str $fullMsg -MaxLen 2000
$llmSafe = Redact-Text -InputString $llmTruncated

$cjkMatches = [regex]::Matches($fullMsg, '[\u3400-\u9fff]')
$cjkCount = $cjkMatches.Count

$textWithoutCjk = [regex]::Replace($fullMsg, '[\u3400-\u9fff]', '')
$latinMatches = [regex]::Matches($textWithoutCjk, '[A-Za-z0-9_]+')
$latinWordCount = $latinMatches.Count

$otherText = [regex]::Replace($fullMsg, '[A-Za-z0-9_\s\u3400-\u9fff]', '')
$otherCount = $otherText.Length

$completionTokens = [Math]::Max(1, [int]($cjkCount * 1.2 + $latinWordCount * 1.3 + $otherCount * 0.5))

$promptTokens = 0
if ($env:TRAE_ENV_FILE -and (Test-Path $env:TRAE_ENV_FILE -PathType Leaf)) {
    $envContent = Get-Content $env:TRAE_ENV_FILE -Encoding UTF8 -ErrorAction SilentlyContinue
    foreach ($line in $envContent) {
        if ($line -match '^AGENT_INSIGHT_PROMPT_LENGTH=(\d+)') {
            $promptLen = [int]$matches[1]
            if ($promptLen -gt 0) {
                $promptTokens = [Math]::Max(1, [int]($promptLen / 3))
            }
            break
        }
    }
}

if ($promptTokens -eq 0) {
    $promptTokens = [Math]::Max(1, [int]($completionTokens / 2))
}

$totalTokens = $promptTokens + $completionTokens

Write-SpoolEvent `
    -Kind 'llm.call' `
    -SessionId $sessionId `
    -TraceId "llm_$sessionId" `
    -ParentId '' `
    -Payload @{
        promptTokens = $promptTokens
        completionTokens = $completionTokens
        tokens = $totalTokens
        totalTokens = $totalTokens
        latencyMs = 0
        estimated = $true
        estimationMethod = 'language-aware'
        responsePreview = $llmSafe
    } `
    -AgentId $agentId `
    -AgentType $agentType

$parentId = Get-ParentId -SessionId $sessionId
if ($parentId) {
    Write-SpoolEvent `
        -Kind 'agent.subagent.end' `
        -SessionId $sessionId `
        -TraceId $sessionId `
        -ParentId $parentId `
        -Payload @{ parent_session_id = $parentId } `
        -AgentId $agentId `
        -AgentType $agentType
}

Unregister-Session -SessionId $sessionId

Write-Output "allow"
