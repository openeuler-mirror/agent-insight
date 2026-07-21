import assert from 'node:assert/strict';
import test from 'node:test';
import { TRACE_BUNDLE_FORMAT, TRACE_BUNDLE_VERSION, buildTraceIdentityMap, remapTraceBundle, sortTraceBundleNodes, validateTraceBundle, type PortableTraceExecution, type TraceBundleV1 } from '../src/lib/trace-transfer';

const exec = (id: string, taskId: string, overrides: Partial<PortableTraceExecution> = {}): PortableTraceExecution => ({
    id, taskId, query: null, framework: 'test', tokens: null, cost: null, latency: null,
    toolCallCount: null, llmCallCount: null, inputTokens: null, outputTokens: null,
    toolCallErrorCount: null, cacheReadInputTokens: null, cacheCreationInputTokens: null,
    maxSingleCallTokens: null, reasoningTokens: null, timestamp: '2026-07-15T00:00:00Z',
    model: null, endpoint: null, agentName: null, finalResult: null, skill: null,
    skills: [], invokedSkills: [], skillVersion: null, label: null, observedAgents: [],
    parentExecutionId: null, rootExecutionId: null, agentSessionId: taskId,
    subagentType: null, subagentName: null, isSubagent: false, ...overrides,
});

const makeBundle = (): TraceBundleV1 => ({
    format: TRACE_BUNDLE_FORMAT, version: TRACE_BUNDLE_VERSION,
    exportedAt: '2026-07-15T01:00:00Z', rootExecutionId: 'exec-root',
    executions: [{
        execution: exec('exec-child', 'task-child', {
            parentExecutionId: 'exec-root', rootExecutionId: 'exec-root',
            agentSessionId: 'task-child', isSubagent: true,
        }),
        session: {
            taskId: 'task-child', label: null, query: null,
            startTime: '2026-07-15T00:00:01Z', endTime: null, model: null,
            interactions: [{ traceId: 'otel-trace', spanId: 'otel-span',
                subagent_session_id: 'task-child', arguments: '{"session_id":"task-child"}' }],
        },
    }, {
        execution: exec('exec-root', 'task-root'),
        session: {
            taskId: 'task-root', label: null, query: null,
            startTime: '2026-07-15T00:00:00Z', endTime: null, model: null, interactions: [],
        },
    }],
});

test('validates and parent-sorts a multi-agent tree', () => {
    const value = validateTraceBundle(makeBundle());
    assert.deepEqual(sortTraceBundleNodes(value).map(node => node.execution.id), ['exec-root', 'exec-child']);
});

test('preserves free IDs and remaps only conflicts', async () => {
    let sequence = 0;
    const map = await buildTraceIdentityMap(
        makeBundle(), async identity => identity === 'exec-child', () => 'imported-' + ++sequence,
    );
    assert.equal(map.get('exec-root'), 'exec-root');
    assert.equal(map.get('task-root'), 'task-root');
    assert.equal(map.get('task-child'), 'task-child');
    assert.equal(map.get('exec-child'), 'imported-1');
});

test('remaps relationships and session references without changing OTel IDs', () => {
    const mapped = remapTraceBundle(makeBundle(), new Map([
        ['exec-root', 'new-root'], ['exec-child', 'new-child'], ['task-child', 'new-task'],
    ]));
    const child = mapped.executions.find(node => node.execution.id === 'new-child')!;
    const interaction = child.session?.interactions[0] as any;
    assert.equal(mapped.rootExecutionId, 'new-root');
    assert.equal(child.execution.parentExecutionId, 'new-root');
    assert.equal(child.session?.taskId, 'new-task');
    assert.equal(interaction.subagent_session_id, 'new-task');
    assert.equal(JSON.parse(interaction.arguments).session_id, 'new-task');
    assert.equal(interaction.traceId, 'otel-trace');
    assert.equal(interaction.spanId, 'otel-span');
});

test('rejects missing parents and cycles', () => {
    const missing = makeBundle();
    missing.executions[0].execution.parentExecutionId = 'missing';
    assert.throws(() => validateTraceBundle(missing), /missing parent/);
    const cyclic = makeBundle();
    cyclic.executions[0].execution.parentExecutionId = 'exec-child';
    assert.throws(() => validateTraceBundle(cyclic), /cycle/);
});
