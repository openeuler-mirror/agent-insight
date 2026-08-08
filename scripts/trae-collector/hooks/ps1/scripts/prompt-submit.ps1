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

# 写入 prompt 语言感知估算状态文件，供 stop.ps1 读取（与 completion 同公式）。
# 替代未生效的 TRAE_ENV_FILE 方案（该变量无设置方，Windows 下同样死代码）。
$safeSessionId = ($sessionId -replace '[^a-zA-Z0-9_-]', '')
if ($safeSessionId) {
    $cjkMatches = [regex]::Matches($prompt, '[\u3400-\u9fff]')
    $cjkCount = $cjkMatches.Count
    $textWithoutCjk = [regex]::Replace($prompt, '[\u3400-\u9fff]', '')
    $latinMatches = [regex]::Matches($textWithoutCjk, '[A-Za-z0-9_]+')
    $latinWordCount = $latinMatches.Count
    $otherText = [regex]::Replace($prompt, '[A-Za-z0-9_\s\u3400-\u9fff]', '')
    $otherCount = $otherText.Length
    $promptTokensEst = [Math]::Max(1, [int]($cjkCount * 1.2 + $latinWordCount * 1.3 + $otherCount * 0.5))

    $stateDir = if ($env:AGENT_INSIGHT_DIR) { $env:AGENT_INSIGHT_DIR } else { "$env:USERPROFILE\.agent-insight" }
    $stateFile = Join-Path $stateDir "trae-prompt-state-$safeSessionId.json"
    try {
        $state = @{
            session_id = $safeSessionId
            prompt_tokens = $promptTokensEst
            prompt_length = if ($prompt) { $prompt.Length } else { 0 }
            ts = [int64]((Get-Date).ToUniversalTime() - (Get-Date '1970-01-01')).TotalSeconds
        } | ConvertTo-Json -Compress
        [System.IO.Directory]::CreateDirectory($stateDir) | Out-Null
        [System.IO.File]::WriteAllText($stateFile, $state, [System.Text.Encoding]::UTF8)
    } catch {}
}

Write-Output 'allow'
exit 0
