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
$agentId = $hookInput.agent_id
$agentType = $hookInput.agent_type
$prompt = $hookInput.prompt
$cwd = $hookInput.cwd

if (-not $sessionId) {
    Write-Output 'allow'
    exit 0
}

Write-RawDebug -RawInput $rawInput -HookName 'UserPromptSubmit' -SessionId $sessionId

$safePrompt = Redact-Text -Text $prompt
$safePrompt = Get-TruncatedString -Str $safePrompt -MaxLen $MaxContentLength

$payload = @{
    query = $safePrompt
    length = $safePrompt.Length
}
if ($cwd) {
    $payload.cwd = $cwd
}

$payloadJson = $payload | ConvertTo-Json -Depth 10 -Compress

Write-SpoolEvent -Kind 'agent.prompt' `
    -SessionId $sessionId `
    -TraceId $sessionId `
    -Payload $payloadJson `
    -AgentId $agentId `
    -AgentType $agentType

if ($env:TRAE_ENV_FILE) {
    $promptLen = if ($prompt) { $prompt.Length } else { 0 }
    $envContent = "AGENT_INSIGHT_PROMPT_LENGTH=$promptLen`nAGENT_INSIGHT_SESSION_ID=$sessionId`n"
    [System.IO.File]::WriteAllText($env:TRAE_ENV_FILE, $envContent, [System.Text.Encoding]::UTF8)
}

Write-Output 'allow'
exit 0
