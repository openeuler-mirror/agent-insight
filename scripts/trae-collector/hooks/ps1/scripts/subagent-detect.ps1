# ============================================================================
# Agent Insight TRAE Collector — SubAgent Relationship Detector (PowerShell)
# Functions to be dot-sourced by other scripts.
#
# Detection strategy:
#   Find most recent active non-child session (other than self) as parent.
#
# File locking via try-catch for concurrent access safety.
# ============================================================================
$ErrorActionPreference = 'Stop'

$script:SubagentStateFile = if ($env:TRAE_SUBAGENT_STATE_FILE) {
    $env:TRAE_SUBAGENT_STATE_FILE
} else {
    "$env:USERPROFILE\.agent-insight\trae-subagent-state.json"
}

$script:SubagentStaleSeconds = if ($env:TRAE_SUBAGENT_STALE_SECONDS) {
    [int]$env:TRAE_SUBAGENT_STALE_SECONDS
} else {
    1800
}

function Get-UnixTimestamp {
    return [int64]((Get-Date).ToUniversalTime() - (Get-Date '1970-01-01')).TotalSeconds
}

function _Read-StateFile {
    if (-not (Test-Path $script:SubagentStateFile -PathType Leaf)) {
        return @{ activeSessions = @{}; relationships = @() }
    }
    $maxRetries = 3
    for ($i = 0; $i -lt $maxRetries; $i++) {
        try {
            $content = [System.IO.File]::ReadAllText($script:SubagentStateFile, [System.Text.Encoding]::UTF8)
            if ([string]::IsNullOrWhiteSpace($content)) {
                return @{ activeSessions = @{}; relationships = @() }
            }
            $parsed = $content | ConvertFrom-Json
            $state = @{
                activeSessions = @{}
                relationships = @()
            }
            if ($parsed.activeSessions) {
                foreach ($prop in $parsed.activeSessions.PSObject.Properties) {
                    # 兼容旧格式（纯数字 ts）与新格式（{ts, agent_type}）→ 统一转为 dict
                    if ($prop.Value -is [int64] -or $prop.Value -is [int] -or $prop.Value -is [double]) {
                        $state.activeSessions[$prop.Name] = @{ ts = [int64]$prop.Value; agent_type = '' }
                    } else {
                        $state.activeSessions[$prop.Name] = @{
                            ts = if ($prop.Value.ts) { [int64]$prop.Value.ts } else { 0 }
                            agent_type = if ($prop.Value.agent_type) { $prop.Value.agent_type.ToString() } else { '' }
                        }
                    }
                }
            }
            if ($parsed.relationships) {
                foreach ($rel in $parsed.relationships) {
                    $state.relationships += @{
                        parent = if ($rel.parent) { $rel.parent.ToString() } else { '' }
                        child = if ($rel.child) { $rel.child.ToString() } else { '' }
                        ts = if ($rel.ts) { [int64]$rel.ts } else { 0 }
                    }
                }
            }
            return $state
        } catch {
            if ($i -lt $maxRetries - 1) { Start-Sleep -Milliseconds (50 * ($i + 1)) }
        }
    }
    return @{ activeSessions = @{}; relationships = @() }
}

function _Write-StateFile {
    param($State)
    $json = ($State | ConvertTo-Json -Compress -Depth 20)
    $stateDir = Split-Path $script:SubagentStateFile -Parent
    if (-not (Test-Path $stateDir)) {
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    }
    $maxRetries = 3
    for ($i = 0; $i -lt $maxRetries; $i++) {
        try {
            $stream = [System.IO.File]::Open(
                $script:SubagentStateFile,
                [System.IO.FileMode]::Create,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None)
            try {
                $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
                $stream.Write($bytes, 0, $bytes.Length)
                $stream.Flush()
                return
            } finally {
                $stream.Close()
            }
        } catch {
            if ($i -lt $maxRetries - 1) { Start-Sleep -Milliseconds (50 * ($i + 1)) }
            else { throw }
        }
    }
}

function _Cleanup-StaleSessions {
    param($State)
    $cutoff = (Get-UnixTimestamp) - $script:SubagentStaleSeconds
    $staleKeys = @()
    foreach ($key in $State.activeSessions.Keys) {
        $ts = if ($State.activeSessions[$key] -is [hashtable]) { [int64]$State.activeSessions[$key].ts } else { [int64]$State.activeSessions[$key] }
        if ($ts -lt $cutoff) {
            $staleKeys += $key
        }
    }
    foreach ($key in $staleKeys) {
        $State.activeSessions.Remove($key)
    }
    return $State
}

function Register-Session {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId,
        [string]$AgentType
    )

    $state = _Read-StateFile
    $state = _Cleanup-StaleSessions -State $state

    $nowTs = Get-UnixTimestamp
    # 状态升级为 dict：{ts, agent_type}（与 sh 版一致）
    $state.activeSessions[$SessionId] = @{ ts = $nowTs; agent_type = $AgentType }

    $parent = ''

    # 主会话（solo_agent 或非 *_agent 结尾）永远是 root，不需要 parent。
    # 修复：此前对任何会话都做时序 parent 判定，快速连续新建多个主会话时
    # 后建会话被误判为前一会话的子 agent（与 sh 版同 bug）。
    if (-not $AgentType -or $AgentType -eq 'solo_agent' -or $AgentType -notmatch '_agent$') {
        _Write-StateFile -State $state
        return ''
    }

    $sortedSessions = $state.activeSessions.GetEnumerator() |
        Sort-Object { $_.Value.ts } -Descending

    # --- 子 agent 类型（*_agent 结尾）：按时序找最近 active 非 child 会话作 parent ---
    foreach ($entry in $sortedSessions) {
        if ($entry.Key -eq $SessionId) { continue }
        $isChild = $false
        foreach ($rel in $state.relationships) {
            if ($rel.child -eq $entry.Key) {
                $isChild = $true
                break
            }
        }
        if (-not $isChild) {
            $parent = $entry.Key
            break
        }
    }

    if ($parent -and ($parent -ne $SessionId)) {
        $already = $false
        foreach ($rel in $state.relationships) {
            if ($rel.parent -eq $parent -and $rel.child -eq $SessionId) {
                $already = $true
                break
            }
        }
        if (-not $already) {
            $state.relationships += @{
                parent = $parent
                child = $SessionId
                ts = $nowTs
            }
        }
    }

    _Write-StateFile -State $state

    return $parent
}

function Unregister-Session {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId
    )

    $state = _Read-StateFile
    if ($state.activeSessions.ContainsKey($SessionId)) {
        $state.activeSessions.Remove($SessionId)
    }
    _Write-StateFile -State $state
}

function Get-ParentId {
    param(
        [Parameter(Mandatory = $true)]
        [string]$SessionId
    )

    $state = _Read-StateFile
    foreach ($rel in $state.relationships) {
        if ($rel.child -eq $SessionId) {
            return $rel.parent
        }
    }
    return ''
}
