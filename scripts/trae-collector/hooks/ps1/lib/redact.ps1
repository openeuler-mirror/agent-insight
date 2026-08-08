# ============================================================================
# Agent Insight TRAE Collector — Sensitive Information Redaction Library (PowerShell)
# Dot-source this file: . "$PSScriptRoot\..\lib\redact.ps1"
# ============================================================================

$Script:SensitivePatterns = @(
    'api[_-]?key', 'apikey', 'token', 'secret', 'password', 'passwd',
    'authorization', 'auth', 'access[_-]?token', 'refresh[_-]?token',
    'client[_-]?secret', 'private[_-]?key', 'ssh[_-]?key',
    'session[_-]?token', 'bearer', 'credential', 'jwt'
)

function Redact-Json {
    <#
    .SYNOPSIS
    Recursively redacts sensitive values from a JSON object by matching key names.

    .DESCRIPTION
    Walks the JSON tree. Any key whose name matches a case-insensitive sensitive
    pattern (api_key, token, password, secret, etc.) gets its value replaced with "***".
    Returns the modified JSON as a compact string.
    #>
    param([string]$InputJson)

    function Test-SensitiveKey {
        param([string]$Key)
        foreach ($p in $Script:SensitivePatterns) {
            if ($Key -match $p) { return $true }
        }
        return $false
    }

    function Redact-Value {
        param($Value)
        if ($null -eq $Value) { return $null }
        if ($Value -is [Array]) {
            $arr = @()
            foreach ($item in $Value) { $arr += Redact-Value $item }
            return $arr
        }
        if ($Value -is [PSCustomObject]) {
            $ht = @{}
            foreach ($prop in $Value.PSObject.Properties) {
                $k = $prop.Name
                $v = $prop.Value
                if (Test-SensitiveKey $k) {
                    $ht[$k] = "***"
                } else {
                    $ht[$k] = Redact-Value $v
                }
            }
            return [PSCustomObject]$ht
        }
        return $Value
    }

    try {
        $obj = ConvertFrom-Json -InputObject $InputJson -Depth 100 -ErrorAction Stop
        if ($null -eq $obj) { return "{}" }
        $result = Redact-Value $obj
        return ConvertTo-Json -InputObject $result -Depth 100 -Compress
    } catch {
        return "{}"
    }
}

function Redact-Text {
    <#
    .SYNOPSIS
    Redacts sensitive patterns from plain text using regex replacements.

    .DESCRIPTION
    Redacts PEM private key blocks, Bearer tokens, api-key=value, token=value,
    and password=value patterns. Matching is case-insensitive where appropriate.
    Returns the modified text.
    #>
    param([string]$Text)

    $singleline = [System.Text.RegularExpressions.RegexOptions]::Singleline
    $ignoreCase = [System.Text.RegularExpressions.RegexOptions]::IgnoreCase

    $Text = [regex]::Replace($Text,
        '-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----',
        '***REDACTED PRIVATE KEY***',
        $singleline)

    $Text = [regex]::Replace($Text,
        'Bearer\s+[A-Za-z0-9._-]{10,}',
        'Bearer ***',
        $ignoreCase)

    $Text = [regex]::Replace($Text,
        'api[_-]?key[=:]\s*["'']?\s*[A-Za-z0-9._-]{8,}',
        'api_key=***',
        $ignoreCase)

    $Text = [regex]::Replace($Text,
        'token[=:]\s*["'']?\s*[A-Za-z0-9._-]{8,}',
        'token=***',
        $ignoreCase)

    $Text = [regex]::Replace($Text,
        'password[=:]\s*["'']?\s*[^&\s]{3,}',
        'password=***',
        $ignoreCase)

    return $Text
}
