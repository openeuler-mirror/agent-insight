import assert from 'node:assert/strict';

export function parseSummaryJson(answer) {
  const lines=answer.split(/\r?\n/).map(line=>line.trim()).filter(line=>/^`?E2E-SUMMARY\b/.test(line));
  assert.equal(lines.length,1,'Exactly one summary line is required');
  let line=lines[0];
  if(line.startsWith('`')){assert.ok(line.endsWith('`'),'Unpaired summary code wrapper');line=line.slice(1,-1);}
  const match=line.match(/^E2E-SUMMARY\s*[:：]?\s*(`?)(\{.*\})\1$/);
  assert.ok(match,'Summary must contain one JSON object with paired optional inline code');
  return JSON.parse(match[2]);
}
