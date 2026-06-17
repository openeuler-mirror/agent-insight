import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    hasClaudeCodeAssistantOutput,
    inferClaudeCodeTraceCompletedAt,
} from '@/app/api/observe/data/route';

test('Claude Code trace lifecycle: quiet window infers completion for claudecode only', () => {
    const latestActivityMs = Date.parse('2026-06-17T07:03:13.399Z');

    assert.equal(
        inferClaudeCodeTraceCompletedAt({
            framework: 'claudecode',
            latestActivityMs,
            quietLongEnough: true,
            explicitCompleted: false,
        }),
        '2026-06-17T07:03:13.399Z',
    );

    for (const framework of ['opencode', 'hermes', 'openclaw', 'claude', undefined]) {
        assert.equal(
            inferClaudeCodeTraceCompletedAt({
                framework,
                latestActivityMs,
                quietLongEnough: true,
                explicitCompleted: false,
            }),
            null,
            `${framework} should not use the Claude Code quiet-window completion rule`,
        );
    }
});

test('Claude Code trace lifecycle: active or explicitly completed traces are not inferred', () => {
    const latestActivityMs = Date.parse('2026-06-17T07:03:13.399Z');

    assert.equal(
        inferClaudeCodeTraceCompletedAt({
            framework: 'claudecode',
            latestActivityMs,
            quietLongEnough: false,
            explicitCompleted: false,
        }),
        null,
    );

    assert.equal(
        inferClaudeCodeTraceCompletedAt({
            framework: 'claudecode',
            latestActivityMs,
            quietLongEnough: true,
            explicitCompleted: true,
        }),
        null,
    );
});

test('Claude Code trace lifecycle: light records can use session assistant output as completion signal', () => {
    assert.equal(
        hasClaudeCodeAssistantOutput([
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi there' },
        ]),
        true,
    );

    assert.equal(
        hasClaudeCodeAssistantOutput([
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: '   ' },
        ]),
        false,
    );
});
