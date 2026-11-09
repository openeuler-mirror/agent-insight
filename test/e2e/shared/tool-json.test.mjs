import test from 'node:test';import assert from 'node:assert/strict';import {toolJsonObjects} from './skill-evidence.mjs';
test('complete tool JSON can span lines and contain braces, quotes and nested objects',()=>{
 const value={evidence:['log {text} and "quoted" value'],nested:[{value:1}]};assert.deepEqual(toolJsonObjects('exit=0\n```json\n'+JSON.stringify(value,null,2)+'\n```\nDONE'),[value]);assert.deepEqual(toolJsonObjects(value),[value]);
});
test('truncated or malformed outer JSON never becomes a successful inner fragment',()=>{
 for(const text of ['prefix\n{"outer":{"evidence":["line"]}','{"outer":invalid,"inner":{"evidence":["line"]}}'])assert.deepEqual(toolJsonObjects(text),[]);
});
test('separate complete results remain separate and ordinary text is not evidence',()=>{
 assert.deepEqual(toolJsonObjects('log\n{"one":1}\nexit=0\n{"two":2}'),[{one:1},{two:2}]);assert.deepEqual(toolJsonObjects('script succeeded'),[]);
});
