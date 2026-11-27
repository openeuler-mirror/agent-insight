# Copyright (c) 2026 Huawei Technologies Co., Ltd.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# ============================================================================
# Agent Insight TRAE Collector — Notification Handler (PowerShell)
# stdin: { session_id, notification_type, message, agent_id, agent_type }
# stdout: "allow"
# ============================================================================
$ErrorActionPreference = 'Stop'

. "$PSScriptRoot\..\lib\common.ps1"

$rawInput = [System.Console]::In.ReadToEnd()
Write-RawDebug -RawInput $rawInput -HookName 'Notification'

try {
    $data = $rawInput | ConvertFrom-Json
} catch {
    Write-Output "allow"
    exit 0
}

$sessionId = $data.session_id
$agentId = $data.agent_id
$agentType = $data.agent_type
$notifType = $data.notification_type
$message = $data.message
$toolUseId = if ($data.PSObject.Properties.Name -contains 'tool_use_id') { $data.tool_use_id } else { $null }

if ([string]::IsNullOrEmpty($sessionId)) {
    Write-Output "allow"
    exit 0
}

$safeMsg = Get-TruncatedString -Str $message -MaxLen 500

Write-SpoolEvent `
    -Kind 'agent.notification' `
    -SessionId $sessionId `
    -TraceId $sessionId `
    -ParentId '' `
    -Payload @{
        notificationType = if ($notifType) { $notifType } else { '' }
        message = if ($safeMsg) { $safeMsg } else { '' }
        tool_use_id = if ($toolUseId) { $toolUseId } else { '' }
    } `
    -AgentId $agentId `
    -AgentType $agentType

Write-Output "allow"
