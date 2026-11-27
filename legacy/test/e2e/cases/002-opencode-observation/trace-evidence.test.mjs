import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requiredStagesFor, scenarioResult } from '../../shared/core.mjs';
import { assertTraceEvidence } from './trace-evidence.mjs';

const expected = { sessionId: 'ses-this-run', username: 'test@example.com', marker: 'E2E-this-run-002', file: 'fixtures/messages', firstLine: 'Jun 14 authentication failure', lineCount: 2000, modelName: 'deepseek-flash' };
const fixture = () => ({ taskId: expected.sessionId, user: expected.username, query: expected.marker, interactions: [
  { role: 'user', content: `${expected.marker}: read fixtures/messages` },
  { role: 'assistant', content: '', modelID: 'deepseek-flash', tool_calls: [{ function: { name: 'bash', arguments: JSON.stringify({ command: 'wc -l fixtures/messages; head -n 1 fixtures/messages' }) }, output: `2000 fixtures/messages\n${expected.firstLine}` }] },
  { role: 'assistant', content: `2000 lines\n${expected.firstLine}`, modelID: 'deepseek-flash' },
] });

test('002 requires ingestion and UI evidence, with no RAS prerequisite', () => {
  const stages = requiredStagesFor('002').map(id => ({ id, status: 'PASS' }));
  assert.ok(!stages.some(s => s.id === 'ras-client'));
  assert.equal(scenarioResult(stages, '002').status, 'PASS');
  assert.equal(scenarioResult(stages.filter(s => s.id !== 'trace-ui'), '002').status, 'PARTIAL');
});

test('trace evidence binds current native session, account, file, model and actual output', () => {
  const result = assertTraceEvidence(fixture(), expected);
  assert.equal(result.toolCount, 1);
  for (const [field, value] of [['taskId', 'ses-old'], ['user', 'another@example.com']]) {
    assert.throws(() => assertTraceEvidence({ ...fixture(), [field]: value }, expected));
  }
});

test('a correct answer without a real file-reading tool cannot pass', () => {
  const trace = fixture();trace.interactions[1].tool_calls = [];
  assert.throws(() => assertTraceEvidence(trace, expected), /tool/i);
});

test('wrong file or wrong final count cannot pass', () => {
  const wrongFile = fixture();wrongFile.interactions[1].tool_calls[0].function.arguments = '{"command":"cat another-file"}';
  assert.throws(() => assertTraceEvidence(wrongFile, expected), /file/i);
  const wrongAnswer = fixture();wrongAnswer.interactions[2].content = `100 lines\n${expected.firstLine}`;
  assert.throws(() => assertTraceEvidence(wrongAnswer, expected), /count/i);
});

test('shell workdir plus relative path must resolve to the exact requested file',()=>{
 const trace=fixture(),absolute={...expected,file:'/tmp/owned/workspace/fixtures/messages'};
 trace.interactions[1].tool_calls[0].function.arguments=JSON.stringify({workdir:'/tmp/owned/workspace',command:"awk 'END{print NR}' fixtures/messages; head -n 1 fixtures/messages"});
 assert.deepEqual(assertTraceEvidence(trace,absolute).fileArguments,['fixtures/messages']);
 for(const args of [{workdir:'/tmp/other',command:'head -n 1 fixtures/messages'},{workdir:'/tmp/owned/workspace',command:'cd /tmp/other; head -n 1 fixtures/messages'},{workdir:'/tmp/owned/workspace',command:'head -n 1 other-fixtures/messages'}]){
  trace.interactions[1].tool_calls[0].function.arguments=JSON.stringify(args);assert.throws(()=>assertTraceEvidence(trace,absolute),/expected file/);
 }
});
test('a literal absolute cd followed by && resolves the actual file without accepting later directory changes',()=>{
 const trace=fixture(),absolute={...expected,file:'/tmp/owned/workspace/fixtures/messages'};
 for(const command of ["cd /tmp/owned/workspace/fixtures && awk 'END{print NR}' messages && head -n 1 messages",'cd "/tmp/owned/workspace/fixtures" && head -n 1 ./messages']){
  trace.interactions[1].tool_calls[0].function.arguments=JSON.stringify({command});assert.ok(assertTraceEvidence(trace,absolute).fileArguments.includes(command.includes('./messages')?'./messages':'messages'));
 }
 for(const command of ['cd /tmp/other && head -n 1 messages','cd /tmp/owned/workspace/fixtures && cd /tmp/other; head -n 1 messages','cd /tmp/owned/workspace/fixtures || head -n 1 messages','cd /tmp/owned/workspace/fixtures$(echo other) && head -n 1 messages']){
  trace.interactions[1].tool_calls[0].function.arguments=JSON.stringify({command});assert.throws(()=>assertTraceEvidence(trace,absolute),/expected file/);
 }
});
