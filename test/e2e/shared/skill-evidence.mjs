import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function toolJsonObjects(output) {
  if(output&&typeof output==='object')return Array.isArray(output)?[]:[output];
  const text=String(output||''),values=[];let start=-1,depth=0,quoted=false,escaped=false;
  for(let i=0;i<text.length;i++){
    const char=text[i];
    if(!depth){if(char==='{'){start=i;depth=1;}continue;}
    if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}
    if(char==='"')quoted=true;
    else if(char==='{')depth++;
    else if(char==='}'&&!--depth){try{const value=JSON.parse(text.slice(start,i+1));if(value&&typeof value==='object'&&!Array.isArray(value))values.push(value);}catch{}}
  }
  return values;
}

export function assertSnapshot(expected, actual) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), 'Snapshot file list differs');
  for (const file of Object.keys(expected)) assert.equal(actual[file], expected[file], `Snapshot content differs: ${file}`);
  return Object.fromEntries(Object.entries(actual).map(([file, content]) => [file, createHash('sha256').update(content).digest('hex')]));
}

export function assertSkillAnswer(reply, summary = false) {
  const explanation = reply.split('E2E-SUMMARY')[0];
  assert.match(explanation, /(?<!\d)351(?!\d)/, 'Root failure count missing');
  assert.ok(explanation.includes('150.183.249.110'), 'Top source missing');
  assert.match(explanation, /(?<!\d)80(?!\d)/, 'Top source failure count missing');
  assert.match(explanation, /authentication failure;/, 'Actual log evidence missing');
  if (summary) {
    const objects = [...reply.matchAll(/E2E-SUMMARY\s*[:：]?\s*(\{[^\n]*?\})/g)];
    assert.equal(objects.length, 1, 'Exactly one E2E-SUMMARY JSON object is required');
    const result = JSON.parse(objects[0][1]);
    assert.deepEqual(result, { root_ssh_failures: 351, top_source: '150.183.249.110', top_source_failures: 80 });
    return result;
  }
  assert.ok(!reply.includes('E2E-SUMMARY'), 'Baseline unexpectedly includes candidate feature');
  return { root_ssh_failures: 351, top_source: '150.183.249.110', top_source_failures: 80 };
}

const traceContent=items=>items.map(({_payloadVersion,...item})=>{if(Array.isArray(item.tool_calls)&&item.tool_calls.length===0)delete item.tool_calls;return item;});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export function semanticTraceHash(items){return createHash('sha256').update(JSON.stringify(canonical(traceContent(items)))).digest('hex');}
export function assertSameTraceSnapshot(before,after){assert.deepEqual(traceContent(after),traceContent(before),'Trace content or nonempty tool calls changed');return semanticTraceHash(before);}
export function assertDiagnosticBinding(accepted,done,executionId){
 const row=accepted.row;assert.ok(row&&/^[a-f0-9]{64}$/.test(row.interactionsHash));assert.equal(row.executionId,executionId);assert.equal(done.row.id,row.id);assert.equal(done.row.executionId,executionId);assert.equal(done.report.executionId,executionId);assert.equal(done.row.interactionsHash,row.interactionsHash);assert.equal(done.report.interactionHash,row.interactionsHash);return row.interactionsHash;
}
