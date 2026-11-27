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

$ErrorActionPreference = 'SilentlyContinue'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$ScriptDir\..\lib\common.ps1"
. "$ScriptDir\..\lib\redact.ps1"
. "$ScriptDir\subagent-detect.ps1"
$ErrorActionPreference = 'SilentlyContinue'

$rawInput = $input | Out-String

try {
    $hookInput = $rawInput | ConvertFrom-Json -ErrorAction Stop
} catch {
    Write-Output '{"hookSpecificOutput":{"hookEventName":"SessionStart","permissionDecision":"allow"}}'
    exit 0
}

$sessionId = $hookInput.session_id
$agentId = $hookInput.agent_id
$agentType = $hookInput.agent_type
$cwd = $hookInput.cwd
$workspaceRoots = $hookInput.workspace_roots
$source = $hookInput.source

if (-not $sessionId) {
    Write-Output '{"hookSpecificOutput":{"hookEventName":"SessionStart","permissionDecision":"allow"}}'
    exit 0
}

Write-RawDebug -RawInput $rawInput -HookName 'SessionStart' -SessionId $sessionId

$parentId = Register-Session -SessionId $sessionId -AgentType $agentType

if ($parentId) {
    $payload = @{
        source = $source
        pid = $PID
        subagent = $true
        parent_session_id = $parentId
    }
    if ($cwd) { $payload.cwd = $cwd }
    if ($workspaceRoots) { $payload.workspace_roots = $workspaceRoots }

    Write-SpoolEvent -Kind 'agent.subagent.start' `
        -SessionId $sessionId `
        -TraceId $sessionId `
        -ParentId $parentId `
        -Payload $payload `
        -AgentId $agentId `
        -AgentType $agentType
} else {
    $payload = @{
        source = $source
        pid = $PID
    }
    if ($cwd) { $payload.cwd = $cwd }
    if ($workspaceRoots) { $payload.workspace_roots = $workspaceRoots }

    Write-SpoolEvent -Kind 'agent.session.start' `
        -SessionId $sessionId `
        -TraceId $sessionId `
        -Payload $payload `
        -AgentId $agentId `
        -AgentType $agentType
}

Write-Output '{"hookSpecificOutput":{"hookEventName":"SessionStart","permissionDecision":"allow"}}'
exit 0
