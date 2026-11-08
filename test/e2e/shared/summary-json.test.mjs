import test from 'node:test';import assert from 'node:assert/strict';
import {parseSummaryJson} from './summary-json.mjs';
test('summary JSON preserves the same payload with plain or paired inline Markdown code',()=>{
 for(const line of ['E2E-SUMMARY {"value":1}','E2E-SUMMARY `{"value":1}`','`E2E-SUMMARY {"value":1}`','E2E-SUMMARY： {"value":1}'])assert.deepEqual(parseSummaryJson('正文\n'+line),{value:1});
});
test('summary JSON rejects duplicate, absent, malformed, multiline and unpaired payloads',()=>{
 for(const text of ['no summary','E2E-SUMMARY {"value":1}\nE2E-SUMMARY {"value":1}','E2E-SUMMARY {bad}','E2E-SUMMARY `{\n"value":1\n}`','E2E-SUMMARY `{"value":1}','E2E-SUMMARY {"value":1}`','E2E-SUMMARY {"value":1}{"value":2}'])assert.throws(()=>parseSummaryJson(text));
});
