import assert from 'node:assert/strict';
import test from 'node:test';

import {
    type AgentTrajectoryFacts,
    TrajectoryPromptTooLargeError,
    extractAgentTrajectoryFacts,
    promptAgentTrajectoryFacts,
} from '@/lib/engine/evaluation/agent-trajectory-facts';
import { summarizeTrace } from '@/lib/engine/evaluation/trace-summarizer';

interface PromptStepView {
    agent?: string;
    name?: string;
    argsSummary?: string;
    outputSummary?: string;
    textSummary?: string;
    errorSummary?: string;
}

interface PromptView {
    steps: PromptStepView[];
    statistics: { rootAgentName?: string };
    candidates: {
        repeatedSameCallCandidates: Array<{ name?: string }>;
    };
}

function buildToolCall(
    id: string,
    name: string,
    args: unknown,
    overrides: Record<string, unknown> = {},
) {
    return {
        id,
        type: 'function',
        function: {
            name,
            arguments: typeof args === 'string' ? args : JSON.stringify(args),
        },
        ...overrides,
    };
}

function buildToolCallWithoutArgs(
    id: string,
    name: string,
    overrides: Record<string, unknown> = {},
) {
    return {
        id,
        type: 'function',
        function: {
            name,
        },
        ...overrides,
    };
}

test('extractAgentTrajectoryFacts keeps visible order, normalizes status, and builds deterministic candidates', () => {
    const baseTime = 1_700_000_000_000;
    const interactions = [
        { role: 'user', content: 'diagnose the trace', timestamp: baseTime + 1000 },
        {
            role: 'assistant',
            agent: 'Root',
            content: 'dispatch child',
            timestamp: baseTime + 1100,
            timeInfo: { created: baseTime + 1100, completed: baseTime + 1400 },
            usage: { input: 7, output: 4, total: 11 },
            tool_calls: [
                buildToolCall(
                    'task-1',
                    'task',
                    { subagent_type: 'general', description: 'inspect child branch' },
                    {
                        state: 'success',
                        output: '<task_metadata>\nsession_id: child-1\n</task_metadata>',
                        timing: { started_at: baseTime + 1200, completed_at: baseTime + 1300 },
                    },
                ),
            ],
        },
        {
            role: 'assistant',
            agent: 'Root',
            content: '',
            timestamp: baseTime + 2000,
            timeInfo: { created: baseTime + 2000, completed: baseTime + 2600 },
            usage: { input: 15, output: 10, total: 25 },
            parts: [{ type: 'reasoning', text: 'I will inspect repeated tool calls.' }],
            tool_calls: [
                buildToolCall('read-1', 'read', { b: 2, a: 1 }, {
                    state: 'success',
                    output: { answer: 'same-output' },
                    timing: { started_at: baseTime + 2100, completed_at: baseTime + 2150 },
                }),
                buildToolCall('read-2', 'read', { a: 1, b: 2 }, {
                    state: 'success',
                    output: { answer: 'same-output' },
                    timing: { started_at: baseTime + 2150, completed_at: baseTime + 2200 },
                }),
                buildToolCall('read-3', 'read', { a: 1, b: 3 }, {
                    state: 'success',
                    output: { answer: 'other-output' },
                    timing: { started_at: baseTime + 2200, completed_at: baseTime + 2250 },
                }),
                buildToolCall('lookup-1', 'lookup', {}, {
                    state: 'timeout',
                    output: { items: [1] },
                    timing: { started_at: baseTime + 2250 },
                }),
                buildToolCall('lookup-2', 'lookup', {}, {
                    state: 'error',
                    output: { items: [1] },
                    timing: { started_at: baseTime + 2300, completed_at: baseTime + 2350 },
                }),
                buildToolCall('lookup-3', 'lookup', {}, {
                    state: 'success',
                    output: { items: [1] },
                    timing: { started_at: baseTime + 2350, completed_at: baseTime + 2400 },
                }),
                ...Array.from({ length: 8 }, (_, offset) =>
                    buildToolCall(`lookup-${offset + 4}`, 'lookup', {}, {
                        state: 'success',
                        output: { items: [1] },
                        timing: {
                            started_at: baseTime + 2400 + offset * 10,
                            completed_at: baseTime + 2405 + offset * 10,
                        },
                    }),
                ),
                ...['alpha', 'beta', 'gamma', 'delta', 'epsilon'].flatMap((name, groupIndex) => [
                    buildToolCall(`${name}-1`, name, { q: name }, {
                        state: 'success',
                        output: { ok: true, groupIndex },
                    }),
                    buildToolCall(`${name}-2`, name, { q: name }, {
                        state: 'success',
                        output: { ok: true, groupIndex },
                    }),
                ]),
            ],
        },
        {
            role: 'assistant',
            agent: 'Root',
            content: '',
            timestamp: baseTime + 3000,
            status: 'error',
            error_summary: 'quota exhausted',
        },
        {
            role: 'subagent',
            agent: 'ChildAgent',
            subagent_name: 'ChildAgent',
            subagent_session_id: 'child-1',
            content: 'child result',
            timestamp: baseTime + 4000,
            timeInfo: { created: baseTime + 4000, completed: baseTime + 4200 },
            usage: { input: 4, output: 3, total: 7 },
        },
    ];

    const facts = extractAgentTrajectoryFacts(interactions);

    assert.equal(facts.steps[0]?.kind, 'user');
    assert.equal(facts.steps[0]?.status, 'unknown');
    assert.equal(facts.steps[0]?.index, 0);

    const childStep = facts.steps.at(-1);
    assert.equal(childStep?.depth, 1);
    assert.equal(childStep?.interactionIndex, 4);
    assert.equal(childStep?.agent, 'ChildAgent');

    const readSteps = facts.steps.filter((step) => step.kind === 'tool' && step.name === 'read');
    assert.equal(readSteps.length, 3);
    assert.equal(readSteps[0]?.status, 'ok');
    assert.equal(readSteps[0]?.argsFingerprint, readSteps[1]?.argsFingerprint);
    assert.notEqual(readSteps[0]?.argsFingerprint, readSteps[2]?.argsFingerprint);
    assert.equal(readSteps[0]?.outputFingerprint, readSteps[1]?.outputFingerprint);
    assert.equal(readSteps[0]?.durationMs, 50);

    const lookupSteps = facts.steps.filter((step) => step.kind === 'tool' && step.name === 'lookup');
    assert.equal(lookupSteps.length, 11);
    assert.equal(new Set(lookupSteps.map((step) => step.argsFingerprint)).size, 1);
    assert.equal(lookupSteps[0]?.status, 'timeout');
    assert.equal(lookupSteps[1]?.status, 'error');
    assert.equal(lookupSteps[2]?.status, 'ok');
    assert.equal(lookupSteps[0]?.tokens, undefined);
    assert.equal(lookupSteps[0]?.durationMs, undefined);

    assert.equal(facts.statistics.totalSteps, facts.steps.length);
    assert.equal(facts.statistics.totalTokens, 43);
    assert.equal(facts.statistics.agentTreeDepth, 1);
    assert.equal(facts.statistics.rootAgentName, 'Root');
    assert.equal(facts.statistics.totalTaskCalls, 1);
    assert.equal(facts.statistics.totalToolCalls, 24);
    assert.equal(facts.statistics.totalLlmCalls, 4);
    assert.equal(facts.statistics.durationMs, 3200);

    const repeatedRead = facts.candidates.repeatedSameCallCandidates.find((candidate) => candidate.name === 'read');
    assert.deepEqual(repeatedRead?.stepIndexes, [4, 5]);

    const lookupRepeated = facts.candidates.repeatedSameCallCandidates.find((candidate) => candidate.name === 'lookup');
    assert.deepEqual(lookupRepeated?.stepIndexChunks, [
        [7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
        [17],
    ]);

    const pagedCandidate = facts.candidates.repeatedSameCallCandidates.find((candidate) => candidate.name === 'epsilon');
    assert.equal(pagedCandidate?.page, 2);

    const sameResultLookup = facts.candidates.repeatedSameResultCandidates.find((candidate) => candidate.name === 'lookup');
    assert.ok(sameResultLookup);
    assert.deepEqual(
        sameResultLookup?.stepIndexes.slice(0, 3),
        lookupSteps.filter((step) => step.status === 'ok').slice(0, 3).map((step) => step.index),
    );

    const retryLookup = facts.candidates.unchangedRetryCandidates.find((candidate) => candidate.name === 'lookup');
    assert.deepEqual(retryLookup?.stepIndexes, [7, 8, 9]);

    const consecutiveLookup = facts.candidates.consecutiveSimilarCandidates.find((candidate) => candidate.name === 'lookup');
    assert.equal(consecutiveLookup?.kind, 'tool');
    assert.equal(consecutiveLookup?.stepIndexes.length, 11);

    const prompt = promptAgentTrajectoryFacts(facts);
    const promptJson = JSON.stringify(prompt);
    assert.doesNotMatch(promptJson, new RegExp(String(lookupSteps[0]?.argsFingerprint)));
    assert.doesNotMatch(promptJson, new RegExp(String(lookupSteps[0]?.outputFingerprint)));
});

test('extractAgentTrajectoryFacts prefers tool status and falls back through trace/status/error', () => {
    const baseTime = 1_700_000_010_000;
    const interactions = [
        { role: 'user', content: 'inspect status fallback order', timestamp: baseTime },
        {
            role: 'assistant',
            agent: 'Root',
            content: '',
            timestamp: baseTime + 100,
            trace_status: 'timeout',
            status: 'error',
            error_summary: 'should not override trace_status',
            tool_calls: [
                buildToolCall('read-1', 'read', { file_path: '/tmp/a' }, {
                    state: 'success',
                    output: 'ok',
                    timing: { started_at: Number.NaN, completed_at: baseTime + 140 },
                }),
                buildToolCall('read-2', 'read', { file_path: '/tmp/b' }, {
                    output: 'fallback',
                    timing: { started_at: baseTime + 150, completed_at: baseTime + 180 },
                }),
            ],
        },
        {
            role: 'assistant',
            agent: 'Root',
            content: 'cancelled turn',
            timestamp: baseTime + 300,
            status: 'cancelled',
        },
        {
            role: 'assistant',
            agent: 'Root',
            content: '',
            timestamp: baseTime + 400,
            status: 'error',
            error_summary: 'network broke',
        },
    ];

    const facts = extractAgentTrajectoryFacts(interactions);

    assert.deepEqual(facts.steps.map((step) => step.index), [0, 1, 2, 3, 4, 5]);
    assert.equal(facts.steps[0]?.status, 'unknown');
    assert.equal(facts.steps[1]?.status, 'timeout');
    assert.equal(facts.steps[2]?.status, 'ok');
    assert.equal(facts.steps[3]?.status, 'timeout');
    assert.equal(facts.steps[3]?.durationMs, 30);
    assert.equal(facts.steps[4]?.status, 'cancelled');
    assert.equal(facts.steps[5]?.status, 'error');
    assert.equal(facts.steps[5]?.errorSummary, 'network broke');
});

test('extractAgentTrajectoryFacts keeps missing-args calls in repeated and retry candidates', () => {
    const baseTime = 1_700_000_020_000;
    const interactions = [
        { role: 'user', content: 'retry calls without args', timestamp: baseTime },
        {
            role: 'assistant',
            agent: 'Root',
            content: '',
            timestamp: baseTime + 100,
            tool_calls: [
                buildToolCallWithoutArgs('ping-1', 'ping', {
                    state: 'success',
                    output: { ok: true },
                    timing: { started_at: baseTime + 110, completed_at: baseTime + 120 },
                }),
                buildToolCallWithoutArgs('ping-2', 'ping', {
                    state: 'success',
                    output: { ok: true },
                    timing: { started_at: baseTime + 120, completed_at: baseTime + 130 },
                }),
                buildToolCallWithoutArgs('ping-3', 'ping', {
                    state: 'timeout',
                    output: { ok: true },
                    timing: { started_at: baseTime + 130, completed_at: baseTime + 140 },
                }),
                buildToolCallWithoutArgs('ping-4', 'ping', {
                    state: 'error',
                    output: { ok: true },
                    timing: { started_at: baseTime + 140, completed_at: baseTime + 150 },
                }),
                buildToolCallWithoutArgs('ping-5', 'ping', {
                    state: 'success',
                    output: { ok: true },
                    timing: { started_at: baseTime + 150, completed_at: baseTime + 160 },
                }),
            ],
        },
    ];

    const facts = extractAgentTrajectoryFacts(interactions);
    const pingSteps = facts.steps.filter((step) => step.kind === 'tool' && step.name === 'ping');
    const pingIndexes = pingSteps.map((step) => step.index);

    assert.equal(pingSteps.length, 5);
    assert.equal(new Set(pingSteps.map((step) => step.argsFingerprint)).size, 1);
    assert.equal(pingSteps[0]?.argsSummary, undefined);

    const repeatedSameCall = facts.candidates.repeatedSameCallCandidates.find((candidate) => candidate.name === 'ping');
    assert.deepEqual(repeatedSameCall?.stepIndexes, pingIndexes);

    const repeatedSameResult = facts.candidates.repeatedSameResultCandidates.find((candidate) => candidate.name === 'ping');
    assert.deepEqual(
        repeatedSameResult?.stepIndexes,
        pingSteps.filter((step) => step.status === 'ok').map((step) => step.index),
    );

    const unchangedRetry = facts.candidates.unchangedRetryCandidates.find((candidate) => candidate.name === 'ping');
    assert.deepEqual(unchangedRetry?.stepIndexes, pingIndexes.slice(2));
});

test('extractAgentTrajectoryFacts normalizes empty-object and empty-string args as missing', () => {
    const interactions = [{ role: 'assistant', content: '', tool_calls: [
        buildToolCall('a', 'ping', undefined, { state: 'success', output: { ok: true } }),
        buildToolCall('b', 'ping', {}, { state: 'success', output: { ok: true } }),
        buildToolCall('c', 'ping', '', { state: 'success', output: { ok: true } }),
    ] }];
    const facts = extractAgentTrajectoryFacts(interactions);
    const calls = facts.steps.filter(step => step.kind === 'tool');
    assert.equal(new Set(calls.map(step => step.argsFingerprint)).size, 1);
    assert.deepEqual(facts.candidates.repeatedSameCallCandidates[0]?.stepIndexes, calls.map(step => step.index));
});

test('extractAgentTrajectoryFacts keeps unknown-status calls with concrete outputs in repeated-result candidates', () => {
    const interactions = [
        { role: 'user', content: '重复查询', timestamp: 1_700_000_025_000 },
        {
            role: 'assistant',
            agent: 'Root',
            content: '',
            timestamp: 1_700_000_025_100,
            tool_calls: [
                buildToolCall('unknown-1', 'lookup', { q: 'same' }, { output: { value: 42 } }),
                buildToolCall('unknown-2', 'lookup', { q: 'same' }, { output: { value: 42 } }),
                buildToolCall('unknown-3', 'lookup', { q: 'same' }, { output: { value: 42 } }),
            ],
        },
    ];
    const facts = extractAgentTrajectoryFacts(interactions);
    const lookupSteps = facts.steps.filter(step => step.kind === 'tool' && step.name === 'lookup');
    assert.ok(lookupSteps.every(step => step.status === 'unknown'));
    assert.deepEqual(
        facts.candidates.repeatedSameResultCandidates[0]?.stepIndexes,
        lookupSteps.map(step => step.index),
    );
});

test('extractAgentTrajectoryFacts excludes cancelled calls from repeated-result candidates', () => {
    const interactions = [
        { role: 'user', content: '执行查询', timestamp: 1_700_000_026_000 },
        {
            role: 'assistant',
            agent: 'Root',
            content: '',
            timestamp: 1_700_000_026_100,
            tool_calls: [
                buildToolCall('cancelled-1', 'lookup', { q: 'same' }, { state: 'cancelled', output: { value: 42 } }),
                buildToolCall('cancelled-2', 'lookup', { q: 'same' }, { state: 'cancelled', output: { value: 42 } }),
                buildToolCall('cancelled-3', 'lookup', { q: 'same' }, { state: 'cancelled', output: { value: 42 } }),
            ],
        },
    ];

    const facts = extractAgentTrajectoryFacts(interactions);
    assert.equal(
        facts.candidates.repeatedSameResultCandidates.some(candidate => candidate.name === 'lookup'),
        false,
    );
});

test('extractAgentTrajectoryFacts detects unchanged retries across separate assistant turns', () => {
    const interactions = [
        { role: 'user', content: '查询状态', timestamp: 1_700_000_027_000 },
        ...Array.from({ length: 4 }, (_, index) => ({
            role: 'assistant',
            agent: 'Root',
            content: `第 ${index + 1} 次查询。`,
            timestamp: 1_700_000_027_100 + index * 100,
            tool_calls: [
                buildToolCall(`retry-${index + 1}`, 'query_database', { sql: 'SELECT status' }, {
                    state: 'timeout',
                    output: { error: 'timeout' },
                }),
            ],
        })),
    ];

    const facts = extractAgentTrajectoryFacts(interactions);
    assert.deepEqual(
        facts.candidates.unchangedRetryCandidates[0]?.stepIndexes,
        [2, 4, 6, 8],
    );
});

test('extractAgentTrajectoryFacts does not merge unchanged retries across root user turns', () => {
    const interactions = [
        { role: 'user', content: '任务甲', timestamp: 1_700_000_028_000 },
        {
            role: 'assistant', agent: 'Root', content: '查询任务甲。', timestamp: 1_700_000_028_100,
            tool_calls: [buildToolCall('task-a', 'lookup', { id: 7 }, { state: 'timeout', output: { error: 'timeout' } })],
        },
        { role: 'user', content: '新的任务乙', timestamp: 1_700_000_028_200 },
        {
            role: 'assistant', agent: 'Root', content: '查询任务乙。', timestamp: 1_700_000_028_300,
            tool_calls: [buildToolCall('task-b', 'lookup', { id: 7 }, { state: 'success', output: { value: 7 } })],
        },
    ];

    const facts = extractAgentTrajectoryFacts(interactions);
    assert.equal(facts.candidates.unchangedRetryCandidates.length, 0);
});

test('extractAgentTrajectoryFacts does not merge repeated calls or results across root user turns', () => {
    const interactions = Array.from({ length: 3 }, (_, index) => ([
        { role: 'user', content: `independent request ${index}` },
        {
            role: 'assistant',
            agent: 'Root',
            content: '',
            tool_calls: [buildToolCall(`read-${index}`, 'read', { path: '/same' }, {
                state: 'success',
                output: { content: 'same result' },
            })],
        },
    ])).flat();

    const extracted = extractAgentTrajectoryFacts(interactions);

    assert.deepEqual(extracted.candidates.repeatedSameCallCandidates, []);
    assert.deepEqual(extracted.candidates.repeatedSameResultCandidates, []);
});

test('extractAgentTrajectoryFacts does not merge retries from parallel same-name subagents', () => {
    const interactions = [
        { role: 'user', content: '并行查询', timestamp: 1_700_000_029_000 },
        {
            role: 'assistant', agent: 'Root', content: '派发两个子代理。', timestamp: 1_700_000_029_100,
            tool_calls: [
                buildToolCall('spawn-a', 'task', { subagent_type: 'worker', description: '分支 A' }, {
                    state: 'success', output: '<task_metadata>\nsession_id: child-a\n</task_metadata>',
                }),
                buildToolCall('spawn-b', 'task', { subagent_type: 'worker', description: '分支 B' }, {
                    state: 'success', output: '<task_metadata>\nsession_id: child-b\n</task_metadata>',
                }),
            ],
        },
        {
            role: 'subagent', agent: 'Worker', subagent_name: 'Worker', subagent_session_id: 'child-a',
            content: '分支 A 查询。', timestamp: 1_700_000_029_200,
            tool_calls: [buildToolCall('child-a-call', 'lookup', { id: 7 }, { state: 'timeout', output: { error: 'timeout' } })],
        },
        {
            role: 'subagent', agent: 'Worker', subagent_name: 'Worker', subagent_session_id: 'child-b',
            content: '分支 B 查询。', timestamp: 1_700_000_029_300,
            tool_calls: [buildToolCall('child-b-call', 'lookup', { id: 7 }, { state: 'success', output: { value: 7 } })],
        },
    ];

    const facts = extractAgentTrajectoryFacts(interactions);
    assert.equal(facts.candidates.unchangedRetryCandidates.length, 0);
    assert.equal(
        facts.candidates.repeatedSameCallCandidates.some(candidate => candidate.name === 'lookup'),
        false,
    );
});

test('extractAgentTrajectoryFacts keeps a long-running child chain in its spawn turn across a new root user message', () => {
    const interactions = [
        { role: 'user', content: '任务甲', timestamp: 1_700_000_029_500 },
        {
            role: 'assistant', agent: 'Root', content: '派发子代理。', timestamp: 1_700_000_029_600,
            tool_calls: [buildToolCall('spawn', 'task', { subagent_type: 'worker' }, {
                state: 'success', output: '<task_metadata>\nsession_id: child-long\n</task_metadata>',
            })],
        },
        {
            role: 'subagent', agent: 'Worker', subagent_session_id: 'child-long', content: '查询甲。', timestamp: 1_700_000_029_700,
            tool_calls: [buildToolCall('call-a', 'lookup', { id: 7 }, { state: 'timeout', output: { error: 'timeout' } })],
        },
        { role: 'user', content: '补充任务乙', timestamp: 1_700_000_029_800 },
        {
            role: 'subagent', agent: 'Worker', subagent_session_id: 'child-long', content: '继续查询。', timestamp: 1_700_000_029_900,
            tool_calls: [buildToolCall('call-b', 'lookup', { id: 7 }, { state: 'timeout', output: { error: 'timeout' } })],
        },
    ];
    const facts = extractAgentTrajectoryFacts(interactions);
    const lookupIndexes = facts.steps.filter(step => step.kind === 'tool' && step.name === 'lookup').map(step => step.index);
    assert.deepEqual(facts.candidates.unchangedRetryCandidates[0]?.stepIndexes, lookupIndexes);
});

test('extractAgentTrajectoryFacts groups consecutive same-tool calls across argument variants', () => {
    const baseTime = 1_700_000_030_000;
    const interactions = [
        { role: 'user', content: 'avoid merging page and chunk variants', timestamp: baseTime },
        {
            role: 'assistant',
            agent: 'Root',
            content: '',
            timestamp: baseTime + 100,
            tool_calls: [
                buildToolCall('search-1', 'search', { query: 'same', page: 1 }, {
                    state: 'success',
                    output: { items: [1] },
                }),
                buildToolCall('search-2', 'search', { query: 'same', page: 2 }, {
                    state: 'success',
                    output: { items: [2] },
                }),
                buildToolCall('search-3', 'search', { query: 'same', chunk: 1 }, {
                    state: 'success',
                    output: { items: [3] },
                }),
                buildToolCall('search-4', 'search', { query: 'same', chunk: 2 }, {
                    state: 'success',
                    output: { items: [4] },
                }),
                buildToolCall('search-5', 'search', { query: 'stable', page: 9 }, {
                    state: 'success',
                    output: { items: [5] },
                }),
                buildToolCall('search-6', 'search', { page: 9, query: 'stable' }, {
                    state: 'success',
                    output: { items: [6] },
                }),
                buildToolCall('search-7', 'search', { query: 'other' }, {
                    state: 'success',
                    output: { items: [7] },
                }),
            ],
        },
    ];

    const facts = extractAgentTrajectoryFacts(interactions);
    const searchSteps = facts.steps.filter((step) => step.kind === 'tool' && step.name === 'search');
    const matchingIndexes = searchSteps.map((step) => step.index);
    const consecutiveCandidates = facts.candidates.consecutiveSimilarCandidates.filter((candidate) => candidate.name === 'search');

    assert.deepEqual(consecutiveCandidates.map((candidate) => candidate.stepIndexes), [matchingIndexes]);
});

test('extractAgentTrajectoryFacts treats consecutive same-tool calls with distinct file args as mergeability candidates', () => {
    const baseTime = 1_700_000_031_000;
    const interactions = [
        { role: 'user', content: '读取三个配置文件', timestamp: baseTime },
        {
            role: 'assistant',
            agent: 'Root',
            content: '',
            timestamp: baseTime + 100,
            tool_calls: [
                buildToolCall('read-1', 'read_file', { path: '/etc/app.yaml' }, {
                    state: 'success',
                    output: { content: 'app' },
                }),
                buildToolCall('read-2', 'read_file', { path: '/etc/db.yaml' }, {
                    state: 'success',
                    output: { content: 'db' },
                }),
                buildToolCall('read-3', 'read_file', { path: '/etc/cache.yaml' }, {
                    state: 'success',
                    output: { content: 'cache' },
                }),
            ],
        },
    ];

    const facts = extractAgentTrajectoryFacts(interactions);
    const readIndexes = facts.steps
        .filter((step) => step.kind === 'tool' && step.name === 'read_file')
        .map((step) => step.index);

    assert.deepEqual(
        facts.candidates.consecutiveSimilarCandidates.map((candidate) => candidate.stepIndexes),
        [readIndexes],
    );
});

test('extractAgentTrajectoryFacts orders root and child steps by original interaction sequence', () => {
    const baseTime = 1_700_000_032_000;
    const interactions = [
        { role: 'user', content: '让子代理查询后回答', timestamp: baseTime },
        {
            role: 'assistant',
            agent: 'Root',
            content: '派发查询',
            timestamp: baseTime + 100,
            tool_calls: [buildToolCall('task-1', 'task', {
                subagent_type: 'research',
                description: '查询事实',
            }, {
                state: 'success',
                output: '<task_metadata>\nsession_id: child-order\n</task_metadata>',
            })],
        },
        {
            role: 'subagent',
            agent: 'Researcher',
            subagent_name: 'Researcher',
            subagent_session_id: 'child-order',
            content: '子代理查询完成',
            timestamp: baseTime + 200,
            tool_calls: [buildToolCall('lookup-1', 'lookup', { id: 1 }, {
                state: 'success',
                output: { value: 42 },
            })],
        },
        {
            role: 'assistant',
            agent: 'Root',
            content: '最终答案是 42',
            timestamp: baseTime + 300,
        },
    ];

    const facts = extractAgentTrajectoryFacts(interactions);
    const childTool = facts.steps.find((step) => step.name === 'lookup');
    const finalAnswer = facts.steps.find((step) => step.depth === 0 && step.textSummary === '最终答案是 42');

    assert.ok(childTool);
    assert.ok(finalAnswer);
    assert.ok(facts.steps.indexOf(childTool) < facts.steps.indexOf(finalAnswer));
    assert.ok(childTool.interactionIndex < finalAnswer.interactionIndex);
    assert.deepEqual(
        facts.steps.map((step) => step.interactionIndex),
        [...facts.steps.map((step) => step.interactionIndex)].sort((left, right) => left - right),
    );
    assert.deepEqual(facts.steps.map((step) => step.index), [0, 1, 2, 3, 4, 5]);
});

test('legacy trace-summarizer preserves its depth-first root-before-child traversal', () => {
    const baseTime = 1_700_000_033_000;
    const interactions = [
        { role: 'user', content: '让子代理查询后回答', timestamp: baseTime },
        {
            role: 'assistant',
            agent: 'Root',
            content: '派发查询',
            timestamp: baseTime + 100,
            tool_calls: [buildToolCall('task-1', 'task', {
                subagent_type: 'research',
                description: '查询事实',
            }, {
                state: 'success',
                output: '<task_metadata>\nsession_id: child-legacy-order\n</task_metadata>',
            })],
        },
        {
            role: 'subagent',
            agent: 'Researcher',
            subagent_name: 'Researcher',
            subagent_session_id: 'child-legacy-order',
            content: '子代理查询完成',
            timestamp: baseTime + 200,
            tool_calls: [buildToolCall('lookup-1', 'lookup', { id: 1 }, {
                state: 'success',
                output: { value: 42 },
            })],
        },
        {
            role: 'assistant',
            agent: 'Root',
            content: '最终答案是 42',
            timestamp: baseTime + 300,
        },
    ];

    const summary = summarizeTrace(interactions);
    const childTool = summary.steps.find((step) => step.name === 'lookup');
    const finalAnswer = summary.steps.find((step) => step.depth === 0 && step.textContent === '最终答案是 42');

    assert.ok(childTool);
    assert.ok(finalAnswer);
    assert.ok(summary.steps.indexOf(finalAnswer) < summary.steps.indexOf(childTool));
});

test('promptAgentTrajectoryFacts preserves 81 steps without truncating the list', () => {
    const facts = {
        steps: Array.from({ length: 81 }, (_, index) => ({
            index,
            interactionIndex: index,
            depth: index % 2,
            kind: 'llm',
            status: 'ok',
            name: `step-${index}`,
            textSummary: `step ${index}`,
        })),
        statistics: {
            totalSteps: 81,
            agentTreeDepth: 1,
            totalLlmCalls: 81,
            totalToolCalls: 0,
            totalSkillCalls: 0,
            totalTaskCalls: 0,
            totalTokens: 0,
            durationMs: 123,
            rootAgentName: 'PromptRoot',
        },
        candidates: {
            repeatedSameCallCandidates: [],
            repeatedSameResultCandidates: [],
            unchangedRetryCandidates: [],
            consecutiveSimilarCandidates: [],
        },
    };

    const prompt = promptAgentTrajectoryFacts(facts as unknown as AgentTrajectoryFacts) as PromptView;
    assert.equal(prompt.steps.length, 81);
});

test('trace-summarizer defaults to an 80-step head-tail view for legacy callers', () => {
    const interactions = Array.from({ length: 81 }, (_, index) => ({
        role: 'user',
        content: `step ${index}`,
    }));

    const summary = summarizeTrace(interactions);

    assert.equal(summary.totalSteps, 81);
    assert.equal(summary.truncated, true);
    assert.equal(summary.steps.length, 80);
    assert.deepEqual(summary.steps.slice(0, 2).map((step) => step.index), [0, 1]);
    assert.deepEqual(summary.steps.slice(-2).map((step) => step.index), [79, 80]);
    assert.equal(summary.steps.some((step) => step.index === 40), false);
});

test('promptAgentTrajectoryFacts clips each prompt text field to 500 chars', () => {
    const longText = 'x'.repeat(700);
    const facts = {
        steps: [{
            index: 0,
            interactionIndex: 0,
            depth: 0,
            kind: 'llm',
            status: 'ok',
            agent: longText,
            name: longText,
            argsSummary: longText,
            outputSummary: longText,
            textSummary: longText,
            errorSummary: longText,
            argsFingerprint: 'should-not-leak',
            outputFingerprint: 'should-not-leak',
        }],
        statistics: {
            totalSteps: 1,
            agentTreeDepth: 0,
            totalLlmCalls: 1,
            totalToolCalls: 0,
            totalSkillCalls: 0,
            totalTaskCalls: 0,
            totalTokens: 0,
            durationMs: 123,
            rootAgentName: longText,
        },
        candidates: {
            repeatedSameCallCandidates: [{
                kind: 'tool',
                name: longText,
                stepIndexes: [0, 1],
                stepIndexChunks: [[0, 1]],
                page: 1,
            }],
            repeatedSameResultCandidates: [],
            unchangedRetryCandidates: [],
            consecutiveSimilarCandidates: [],
        },
    };

    const prompt = promptAgentTrajectoryFacts(facts as unknown as AgentTrajectoryFacts) as PromptView;
    const firstStep = prompt.steps[0];
    assert.ok(firstStep);
    assert.equal(firstStep.agent?.length, 500);
    assert.equal(firstStep.name?.length, 500);
    assert.equal(firstStep.argsSummary?.length, 500);
    assert.equal(firstStep.outputSummary?.length, 500);
    assert.equal(firstStep.textSummary?.length, 500);
    assert.equal(firstStep.errorSummary?.length, 500);
    assert.equal('argsFingerprint' in firstStep, false);
    assert.equal('outputFingerprint' in firstStep, false);
    assert.equal(prompt.statistics.rootAgentName?.length, 500);
    assert.equal(prompt.candidates.repeatedSameCallCandidates[0]?.name?.length, 500);
});

test('trajectory facts bound raw summaries and redact PEM, DSN and Slack credentials', () => {
    const secretPem = '-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET-PRIVATE-MATERIAL\n-----END OPENSSH PRIVATE KEY-----';
    const facts = extractAgentTrajectoryFacts([{
        role: 'assistant',
        content: `visible ${secretPem}`,
        tool_calls: [{
            id: 'secret-call', type: 'function', function: { name: 'fetch', arguments: JSON.stringify({
                url: 'postgres://alice:password@db.example/app', token: 'xoxb-1234567890-SECRET',
            }) }, state: 'success', output: 'x'.repeat(10_000),
        }],
    }]);
    const tool = facts.steps.find(step => step.kind === 'tool');
    assert.ok(tool);
    assert.ok((tool.outputSummary?.length ?? 0) <= 500);
    const prompt = JSON.stringify(promptAgentTrajectoryFacts(facts));
    assert.doesNotMatch(prompt, /SECRET-PRIVATE-MATERIAL|password@db\.example|xoxb-1234567890-SECRET/);
    assert.match(prompt, /\[REDACTED\]/);
});

test('promptAgentTrajectoryFacts accepts 120000 chars and rejects 120001 chars', () => {
    type PromptTextField = 'agent' | 'name' | 'argsSummary' | 'outputSummary' | 'textSummary' | 'errorSummary';
    const promptTextFields: PromptTextField[] = [
        'agent', 'name', 'argsSummary', 'outputSummary', 'textSummary', 'errorSummary',
    ];
    const steps = Array.from({ length: 100 }, (_, index) => ({
            index,
            interactionIndex: index,
            depth: 0,
            kind: 'llm' as const,
            status: 'ok' as const,
            agent: '',
            name: '',
            argsSummary: '',
            outputSummary: '',
            textSummary: '',
            errorSummary: '',
        }));
    const makeFacts = () => ({
        steps,
        statistics: {
            totalSteps: steps.length,
            agentTreeDepth: 0,
            totalLlmCalls: steps.length,
            totalToolCalls: 0,
            totalSkillCalls: 0,
            totalTaskCalls: 0,
            totalTokens: 0,
            durationMs: 0,
            rootAgentName: 'PromptRoot',
        },
        candidates: {
            repeatedSameCallCandidates: [],
            repeatedSameResultCandidates: [],
            unchangedRetryCandidates: [],
            consecutiveSimilarCandidates: [],
        },
    });

    const baseLength = JSON.stringify(promptAgentTrajectoryFacts(makeFacts() as never)).length;
    let remaining = 120000 - baseLength;
    assert.ok(remaining > 0);
    for (const step of steps) {
        for (const field of promptTextFields) {
            const length = Math.min(500, remaining);
            step[field] = 'r'.repeat(length);
            remaining -= length;
        }
    }
    assert.equal(remaining, 0);

    const allowedPrompt = promptAgentTrajectoryFacts(makeFacts() as never);
    assert.equal(JSON.stringify(allowedPrompt).length, 120000);

    const overflowStep = steps.at(-1);
    assert.ok(overflowStep);
    assert.ok(overflowStep.errorSummary.length < 500);
    overflowStep.errorSummary += 'r';

    assert.throws(
        () => promptAgentTrajectoryFacts(makeFacts() as never),
        (error: unknown) => error instanceof TrajectoryPromptTooLargeError
            && /完整轨迹超过当前 Judge 上下文限制/.test(error.message),
    );
});
