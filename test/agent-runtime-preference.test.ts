/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    emptyCapabilities,
    isAgentRuntimeId,
    type AgentRuntimeDescriptor,
    type AgentRuntimeStatus,
} from '@/lib/agent-runtime/types';
import {
    resolveAgentRuntimePreference,
    validateAgentRuntimeSelection,
} from '@/lib/agent-runtime/preference';

function descriptor(
    id: 'pi' | 'opencode',
    status: AgentRuntimeStatus,
    selectable = status === 'available',
): AgentRuntimeDescriptor {
    return {
        id,
        label: id === 'pi' ? 'Pi' : 'OpenCode',
        adapter: selectable ? { id: `${id}-adapter`, label: id, capabilities: emptyCapabilities() } : null,
        executable: status === 'not-installed' ? null : { path: `/opt/${id}/bin/${id}`, source: 'path' },
        version: status === 'not-installed' ? null : '1.1.39',
        minimumVersion: id === 'pi' ? '0.82.1' : '1.0.0',
        status,
        selectable,
        capabilities: emptyCapabilities(),
        diagnostics: [{ code: status === 'available' ? 'RUNTIME_READY' : 'RUNTIME_ADAPTER_MISSING', message: `${id} ${status}` }],
        checkedAt: '2026-11-09T00:00:00.000Z',
    };
}

test('platform default prefers pi, then opencode', () => {
    const withPi = resolveAgentRuntimePreference(null, [
        descriptor('pi', 'available'),
        descriptor('opencode', 'available'),
    ]);
    assert.equal(withPi.source, 'platform-default');
    assert.equal(withPi.status, 'ready');
    assert.equal(withPi.effectiveId, 'pi');

    const withoutPi = resolveAgentRuntimePreference(null, [
        descriptor('pi', 'adapter-missing'),
        descriptor('opencode', 'available'),
    ]);
    assert.equal(withoutPi.source, 'platform-default');
    assert.equal(withoutPi.effectiveId, 'opencode');
});

test('a saved personal default wins over the platform order', () => {
    const preference = resolveAgentRuntimePreference('opencode', [
        descriptor('pi', 'available'),
        descriptor('opencode', 'available'),
    ]);
    assert.equal(preference.source, 'user');
    assert.equal(preference.selectedId, 'opencode');
    assert.equal(preference.effectiveId, 'opencode');
    assert.equal(preference.status, 'ready');
});

test('an unavailable saved runtime fails explicitly instead of falling back', () => {
    const preference = resolveAgentRuntimePreference('pi', [
        descriptor('pi', 'adapter-missing'),
        descriptor('opencode', 'available'),
    ]);
    assert.equal(preference.status, 'unavailable');
    assert.equal(preference.effectiveId, null);
    assert.equal(preference.runtime?.id, 'pi');
    assert.equal(preference.diagnostic?.code, 'RUNTIME_SELECTION_UNAVAILABLE');
});

test('an unknown saved runtime is reported as invalid and never executed', () => {
    const preference = resolveAgentRuntimePreference('claude', [
        descriptor('opencode', 'available'),
    ]);
    assert.equal(preference.status, 'unavailable');
    assert.equal(preference.effectiveId, null);
    assert.equal(preference.diagnostic?.code, 'RUNTIME_SELECTION_INVALID');
});

test('no selectable runtime yields a none preference with a diagnostic', () => {
    const preference = resolveAgentRuntimePreference(null, [
        descriptor('pi', 'not-installed'),
        descriptor('opencode', 'incompatible-version'),
    ]);
    assert.equal(preference.status, 'none');
    assert.equal(preference.source, 'none');
    assert.equal(preference.effectiveId, null);
    assert.equal(preference.diagnostic?.code, 'RUNTIME_SELECTION_UNAVAILABLE');
});

test('selection validation rejects unknown, missing and unavailable runtimes', () => {
    const runtimes = [
        descriptor('pi', 'adapter-missing'),
        descriptor('opencode', 'available'),
    ];

    assert.equal(validateAgentRuntimeSelection('claude', runtimes).ok, false);
    assert.equal(validateAgentRuntimeSelection('claude', runtimes).diagnostic?.code, 'RUNTIME_SELECTION_INVALID');

    assert.equal(validateAgentRuntimeSelection('pi', runtimes).ok, false);
    assert.equal(validateAgentRuntimeSelection('pi', runtimes).diagnostic?.code, 'RUNTIME_SELECTION_UNAVAILABLE');

    const missing = validateAgentRuntimeSelection('opencode', [descriptor('pi', 'not-installed')]);
    assert.equal(missing.ok, false);
    assert.equal(missing.diagnostic?.code, 'RUNTIME_SELECTION_UNAVAILABLE');

    const accepted = validateAgentRuntimeSelection('opencode', runtimes);
    assert.equal(accepted.ok, true);
    assert.equal(accepted.runtime?.id, 'opencode');
    assert.equal(accepted.diagnostic, null);
});

test('runtime id guard only accepts supported ids', () => {
    assert.equal(isAgentRuntimeId('pi'), true);
    assert.equal(isAgentRuntimeId('opencode'), true);
    assert.equal(isAgentRuntimeId('claude'), false);
    assert.equal(isAgentRuntimeId(undefined), false);
});
