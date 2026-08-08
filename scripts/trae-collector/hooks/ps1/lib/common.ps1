# ============================================================================
# Agent Insight TRAE Collector — Common Library (PowerShell)
# Shared functions for all Hook event handler scripts.
# Dot-source this file: . "$PSScriptRoot\..\lib\common.ps1"
# ============================================================================

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:TraeBuiltinTools = @{
    Read = $true; Write = $true; Edit = $true
    Glob = $true; Grep = $true; LS = $true
    Bash = $true; RunCommand = $true; Exec = $true
    WebSearch = $true; WebFetch = $true
    AskUserQuestion = $true; Question = $true
    Task = $true; TodoWrite = $true; Skill = $true
}

$script:ToolTypeMap = @{
    Read = 'file_read'; Write = 'file_write'; Edit = 'file_edit'
    Glob = 'search'; Grep = 'search'; LS = 'search'
    Bash = 'terminal'; RunCommand = 'terminal'; Exec = 'terminal'
    WebSearch = 'web'; WebFetch = 'web'
    AskUserQuestion = 'interaction'; Question = 'interaction'
    Task = 'task'; TodoWrite = 'task'
    Skill = 'skill'
}

function _Read-EnvFile {
    param([string]$Path)
    if (-not (Test-Path $Path -PathType Leaf)) { return @{} }
    $vars = @{}
    foreach ($line in Get-Content $Path -Encoding UTF8) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
        $eqIdx = $trimmed.IndexOf('=')
        if ($eqIdx -le 0) { continue }
        $key = $trimmed.Substring(0, $eqIdx).Trim()
        $value = $trimmed.Substring($eqIdx + 1).Trim().Trim("'").Trim('"')
        $vars[$key] = $value
    }
    return $vars
}

$_loadedEnv = $null
function _Get-InsightEnv {
    if ($null -ne $_loadedEnv) { return $_loadedEnv }
    $_loadedEnv = _Read-EnvFile "$env:USERPROFILE\.agent-insight\.env"
    return $_loadedEnv
}

function _Get-ApiKey {
    if ($env:AGENT_INSIGHT_API_KEY) { return $env:AGENT_INSIGHT_API_KEY }
    $envVars = _Get-InsightEnv
    return $envVars['AGENT_INSIGHT_API_KEY']
}

function _Get-SHA256First16 {
    param([string]$InputString)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($InputString)
    $hashBytes = $sha.ComputeHash($bytes)
    $hex = -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
    return $hex.Substring(0, [Math]::Min(16, $hex.Length))
}

# ============================================================================
# 1. Get-SpoolBase
# ============================================================================
function Get-SpoolBase {
    $insightDir = if ($env:AGENT_INSIGHT_DIR) { $env:AGENT_INSIGHT_DIR } else { "$env:USERPROFILE\.agent-insight" }
    $apiKey = _Get-ApiKey
    if ($apiKey) {
        $keyHash = _Get-SHA256First16 $apiKey
        return "$insightDir\otel_data\trae\$keyHash"
    }
    return "$insightDir\otel_data\trae\default"
}

# ============================================================================
# 2. Get-SpoolDir
# ============================================================================
function Get-SpoolDir {
    $base = Get-SpoolBase
    $dayDir = "$base\$((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd'))"
    if (-not (Test-Path $dayDir)) {
        New-Item -ItemType Directory -Path $dayDir -Force | Out-Null
    }
    return $dayDir
}

# ============================================================================
# 3. Get-SpoolFile
# ============================================================================
function Get-SpoolFile {
    $dir = Get-SpoolDir
    $hostname = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { 'unknown' }
    return "$dir\trae-otel-$hostname.jsonl"
}

# ============================================================================
# 10. Format-TimeStamp
# ============================================================================
function Format-TimeStamp {
    return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}

# ============================================================================
# 8. ConvertTo-JsonEscape
# ============================================================================
function ConvertTo-JsonEscape {
    param([string]$InputString)
    $sb = [System.Text.StringBuilder]::new($InputString.Length + 20)
    foreach ($ch in $InputString.ToCharArray()) {
        switch ($ch) {
            '"'  { $sb.Append('\') | Out-Null; $sb.Append('"') | Out-Null }
            '\'  { $sb.Append('\\') | Out-Null }
            "`b" { $sb.Append('\b') | Out-Null }
            "`f" { $sb.Append('\f') | Out-Null }
            "`n" { $sb.Append('\n') | Out-Null }
            "`r" { $sb.Append('\r') | Out-Null }
            "`t" { $sb.Append('\t') | Out-Null }
            default {
                $code = [int]$ch
                if ($code -lt 0x20) {
                    $sb.AppendFormat('\u{0:x4}', $code) | Out-Null
                } else {
                    $sb.Append($ch) | Out-Null
                }
            }
        }
    }
    return $sb.ToString()
}

# ============================================================================
# 5. Test-IsTraeBuiltin
# ============================================================================
function Test-IsTraeBuiltin {
    param([string]$ToolName)
    return $script:TraeBuiltinTools.ContainsKey($ToolName)
}

# ============================================================================
# 6. Test-IsMcpTool
# ============================================================================
function Test-IsMcpTool {
    param(
        [string]$ToolName,
        [string]$LlmToolName
    )
    if ($ToolName -and $ToolName.StartsWith('mcp__')) { return $true }
    if ($LlmToolName -and $ToolName -and
        $LlmToolName.Contains('_') -and ($LlmToolName -ne $ToolName)) { return $true }
    if ($ToolName -and ($ToolName -like 'Browser*' -or $ToolName -like 'browser_*')) { return $true }
    return $false
}

# ============================================================================
# 7. Get-ToolType
# ============================================================================
function Get-ToolType {
    param(
        [string]$ToolName,
        [string]$LlmToolName
    )
    if ($script:ToolTypeMap.ContainsKey($ToolName)) {
        return $script:ToolTypeMap[$ToolName]
    }
    if (Test-IsMcpTool -ToolName $ToolName -LlmToolName $LlmToolName) {
        return 'mcp'
    }
    if ($LlmToolName -and ($LlmToolName -ne $ToolName)) {
        return 'tool'
    }
    return 'unknown'
}

# ============================================================================
# 4. Write-SpoolEvent
# ============================================================================
function Write-SpoolEvent {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Kind,
        [string]$SessionId,
        [string]$TraceId,
        [string]$ParentId,
        $Payload,
        [string]$AgentId,
        [string]$AgentType
    )
    $ts = Format-TimeStamp
    $entry = @{ t = $ts; kind = $Kind; sessionID = $SessionId }
    if ($TraceId) { $entry['trace_id'] = $TraceId }
    if ($ParentId) { $entry['parent_id'] = $ParentId }
    if ($AgentId) { $entry['agent_id'] = $AgentId }
    if ($AgentType) { $entry['agent_type'] = $AgentType }

    if ($null -ne $Payload) {
        if ($Payload -is [string]) {
            $trimmed = $Payload.Trim()
            if ($trimmed.StartsWith('{') -or $trimmed.StartsWith('[')) {
                try {
                    $entry['payload'] = $trimmed | ConvertFrom-Json
                } catch {
                    $entry['payload'] = $Payload
                }
            } else {
                $entry['payload'] = $Payload
            }
        } else {
            $entry['payload'] = $Payload
        }
    } else {
        $entry['payload'] = @{}
    }

    $spoolFile = Get-SpoolFile
    $jsonLine = $entry | ConvertTo-Json -Compress -Depth 20
    $jsonLine += "`n"
    $retryCount = 0
    $maxRetries = 3
    while ($retryCount -lt $maxRetries) {
        try {
            [System.IO.File]::AppendAllText($spoolFile, $jsonLine, [System.Text.Encoding]::UTF8)
            break
        } catch {
            $retryCount++
            if ($retryCount -ge $maxRetries) { throw }
            Start-Sleep -Milliseconds (50 * $retryCount)
        }
    }
}

$MaxContentLength = if ($env:AGENT_INSIGHT_TRAE_MAX_CONTENT_LENGTH) {
    [int]$env:AGENT_INSIGHT_TRAE_MAX_CONTENT_LENGTH
} else { 2000 }

$MaxToolIoSize = if ($env:AGENT_INSIGHT_TRAE_MAX_TOOL_IO_SIZE) {
    [int]$env:AGENT_INSIGHT_TRAE_MAX_TOOL_IO_SIZE
} else { 4000 }

# ============================================================================
# 9. Get-TruncatedString
# ============================================================================
function Get-TruncatedString {
    param(
        [string]$Str,
        [int]$MaxLen = $MaxContentLength
    )
    if (-not $Str) { return '' }
    if ($Str.Length -le $MaxLen) { return $Str }
    return $Str.Substring(0, $MaxLen) + '...'
}

# ============================================================================
# 10. Get-TruncatedPayload
# ============================================================================
function Get-TruncatedPayload {
    param(
        [string]$Json,
        [int]$MaxLen = $MaxToolIoSize
    )
    if (-not $Json) { return '{}' }
    if ($Json.Length -le $MaxLen) { return $Json }
    try {
        $obj = $Json | ConvertFrom-JsonSafe
        $truncated = _TruncateRecurse $obj $MaxLen
        return ($truncated | ConvertTo-Json -Depth 10 -Compress)
    } catch {
        if ($Json.Length -gt $MaxLen) { return $Json.Substring(0, $MaxLen) + '...' }
        return $Json
    }
}

function _TruncateRecurse {
    param($Value, [int]$MaxLen)
    if ($Value -is [string] -and $Value.Length -gt $MaxLen) {
        return $Value.Substring(0, $MaxLen) + '...'
    }
    if ($Value -is [hashtable]) {
        $result = @{}
        foreach ($k in $Value.Keys) {
            $result[$k] = _TruncateRecurse $Value[$k] $MaxLen
        }
        return $result
    }
    if ($Value -is [array]) {
        $result = @()
        foreach ($item in $Value) {
            $result += (_TruncateRecurse $item $MaxLen)
        }
        return $result
    }
    if ($Value -is [psobject]) {
        $obj = [PSCustomObject]@{}
        foreach ($prop in $Value.PSObject.Properties) {
            $obj | Add-Member -NotePropertyName $prop.Name -NotePropertyValue (_TruncateRecurse $prop.Value $MaxLen) -Force
        }
        return $obj
    }
    return $Value
}

# ============================================================================
# 11. Redact-Text — redact sensitive patterns from plain text
# ============================================================================
function Redact-Text {
    param([string]$InputString)

    if ([string]::IsNullOrEmpty($InputString)) { return '' }

    $result = $InputString

    $result = [regex]::Replace($result,
        '-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----',
        '***REDACTED PRIVATE KEY***',
        [System.Text.RegularExpressions.RegexOptions]::Multiline)

    $result = [regex]::Replace($result,
        '[Bb]earer\s+[A-Za-z0-9._-]{10,}',
        'Bearer ***')

    $result = [regex]::Replace($result,
        'api[_-]?key[=:][''""]?[A-Za-z0-9._-]{8,}',
        'api_key=***',
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)

    $result = [regex]::Replace($result,
        'token[=:][''""]?[A-Za-z0-9._-]{8,}',
        'token=***',
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)

    $result = [regex]::Replace($result,
        'password[=:][''""]?[^&\s''""]{3,}',
        'password=***',
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)

    return $result
}

# ============================================================================
# 12. Redact-Json — redact sensitive field values from a JSON string
# ============================================================================
function Redact-Json {
    param([string]$JsonString)

    if ([string]::IsNullOrEmpty($JsonString)) { return '{}' }

    $sensitivePatterns = @(
        'api[_-]?key', 'apikey', 'token', 'secret', 'password', 'passwd',
        'authorization', 'auth', 'access[_-]?token', 'refresh[_-]?token',
        'client[_-]?secret', 'private[_-]?key', 'ssh[_-]?key',
        'session[_-]?token', 'bearer', 'credential', 'jwt'
    )

    try {
        $data = $JsonString | ConvertFrom-Json
    } catch {
        return '{}'
    }

    function _IsSensitiveKey($key) {
        $k = $key.ToString().ToLower()
        foreach ($p in $sensitivePatterns) {
            if ($k -match $p) { return $true }
        }
        return $false
    }

    function _RedactValue($val) {
        if ($null -eq $val) { return $null }
        if ($val -is [string] -or $val -is [int] -or $val -is [long] -or
            $val -is [double] -or $val -is [decimal] -or $val -is [bool]) {
            return $val
        }
        if ($val -is [array]) {
            $result = @()
            foreach ($item in $val) { $result += _RedactValue $item }
            return ,$result
        }
        if ($val -is [hashtable]) {
            $out = @{}
            foreach ($k in $val.Keys) {
                if (_IsSensitiveKey $k) {
                    $out[$k] = '***'
                } else {
                    $out[$k] = _RedactValue $val[$k]
                }
            }
            return $out
        }
        if ($val -is [System.Management.Automation.PSCustomObject] -or
            $val -is [System.Management.Automation.PSObject]) {
            $out = [PSCustomObject]@{}
            foreach ($prop in $val.PSObject.Properties) {
                if (_IsSensitiveKey $prop.Name) {
                    $out | Add-Member -NotePropertyName $prop.Name -NotePropertyValue '***' -Force
                } else {
                    $out | Add-Member -NotePropertyName $prop.Name -NotePropertyValue (_RedactValue $prop.Value) -Force
                }
            }
            return $out
        }
        return $val
    }

    $redacted = _RedactValue $data
    return ($redacted | ConvertTo-Json -Compress -Depth 20)
}

# ============================================================================
# 12.5 ConvertFrom-JsonSafe — PS 5.1 compatible ConvertFrom-Json without -AsHashtable
# ============================================================================
function ConvertFrom-JsonSafe {
    param(
        [Parameter(ValueFromPipeline = $true)]
        [string]$Json
    )
    if ([string]::IsNullOrEmpty($Json) -or $Json.Trim() -eq '{}') { return [PSCustomObject]@{} }
    try {
        return $Json | ConvertFrom-Json
    } catch {
        return [PSCustomObject]@{} }
}

# ============================================================================
# 13. Write-DebugTrace — lightweight trace log for hook diagnostics
# Writes to %TEMP%\trae-hook-debug.log so we can inspect execution path
# ============================================================================
function Write-DebugTrace {
    param(
        [string]$HookName = 'unknown',
        [string]$Message = '',
        [string]$Data = ''
    )
    $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $line = "[$ts] [$HookName] $Message"
    if ($Data) { $line += " | DATA: $Data" }
    $line += "`n"
    $debugFile = "$env:TEMP\trae-hook-debug.log"
    try {
        [System.IO.File]::AppendAllText($debugFile, $line, [System.Text.Encoding]::UTF8)
    } catch {}
}

# ============================================================================
# 14. Write-RawDebug
# ============================================================================
function Write-RawDebug {
    param(
        [string]$RawInput,
        [string]$HookName = 'unknown',
        [string]$SessionId = ''
    )
    if ($env:TRAE_DEBUG_RAW -ne '1') { return }
    $insightDir = if ($env:AGENT_INSIGHT_DIR) { $env:AGENT_INSIGHT_DIR } else { "$env:USERPROFILE\.agent-insight" }
    $debugBase = "$insightDir\otel_data\trae\_debug_raw"
    $debugFile = "$debugBase\$((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')).jsonl"
    $debugDir = Split-Path $debugFile -Parent
    if (-not (Test-Path $debugDir)) {
        New-Item -ItemType Directory -Path $debugDir -Force | Out-Null
    }
    $ts = Format-TimeStamp
    $rawObj = $null
    try {
        $trimmed = $RawInput.Trim()
        if ($trimmed -and ($trimmed.StartsWith('{') -or $trimmed.StartsWith('['))) {
            $rawObj = $trimmed | ConvertFrom-Json
        }
    } catch { }
    if ($null -eq $rawObj) { $rawObj = $RawInput }
    $entry = @{ t = $ts; hook = $HookName; sessionID = $SessionId; raw = $rawObj }
    $jsonLine = ($entry | ConvertTo-Json -Compress -Depth 20) + "`n"
    $retryCount = 0
    $maxRetries = 3
    while ($retryCount -lt $maxRetries) {
        try {
            [System.IO.File]::AppendAllText($debugFile, $jsonLine, [System.Text.Encoding]::UTF8)
            break
        } catch {
            $retryCount++
            if ($retryCount -ge $maxRetries) { throw }
            Start-Sleep -Milliseconds (50 * $retryCount)
        }
    }
}
