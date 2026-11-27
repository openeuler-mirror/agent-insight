import {contextConfig} from '../../shared/model-config.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';

const text = value => typeof value === 'string' ? value : JSON.stringify(value ?? '');
export function assertTraceEvidence(session, expected) {
  assert.equal(session.taskId, expected.sessionId, 'Wrong native session');
  assert.equal(session.user, expected.username, 'Wrong account');
  const interactions = session.interactions || [];
  assert.ok(interactions.some(m => m.role === 'user' && text(m.content).includes(expected.marker)), 'Current task input missing');
  const tools = interactions.flatMap(m => (m.tool_calls || []).map(call => ({ name: call.function?.name || call.name, args: text(call.function?.arguments ?? call.arguments), output: text(call.output ?? call.result) })));
  assert.ok(tools.length > 0, 'No actual tool calls');
  const fileTools = tools.filter(tool => referencesFile(tool.args,expected.file));
  assert.ok(fileTools.length > 0, 'No tool read the expected file');
  const first = expected.firstLine.trimEnd();
  assert.ok(fileTools.some(tool => tool.output.includes(first)), 'Tool result does not contain the actual first line');
  const final = interactions.filter(m => m.role === 'assistant' && text(m.content).trim()).at(-1);
  assert.ok(final, 'Final assistant response missing');
  const reply = text(final.content);
  assert.match(reply.replace(/,/g, ''), new RegExp(`(?<!\\d)${expected.lineCount}(?!\\d)`), 'Final line count is wrong');
  assert.ok(reply.includes(first), 'Final first line is wrong');
  assert.ok(interactions.some(m => [m.modelID, m.model, m.system_prompt_modelID].some(value => text(value).includes(contextConfig().model.modelName))), 'DeepSeek model attribution missing');
  return { toolCount: tools.length, fileToolNames: [...new Set(fileTools.map(t => t.name))], fileArguments: [...new Set(fileTools.map(t => referencesFile(t.args, expected.file)))], reply, lineCount: expected.lineCount, firstLine: first };
}

function referencesFile(raw,file){
 if(raw.includes(file))return file;
 let args;try{args=JSON.parse(raw);}catch{return false;}
 if(!path.isAbsolute(file)||typeof args.command!=='string')return false;
 let directory=args.workdir,command=args.command;
 const change=command.match(/^\s*cd\s+(?:"([^"$`]+)"|'([^']+)'|([^\s;&|$`]+))\s*&&\s*([\s\S]+)$/);
 if(change){directory=change[1]||change[2]||change[3];command=change[4];}
 if(typeof directory!=='string'||!path.isAbsolute(directory)||/(?:^|[;&|])\s*(?:cd|pushd)\b/.test(command))return false;
 const relative=path.relative(directory,file);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))return false;
 const tokens=command.split(/[\s"';|&]+/);return tokens.find(token=>token===relative||token==='./'+relative)||false;
}
