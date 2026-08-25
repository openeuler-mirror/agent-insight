import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function entryText(entry) {
  return entry?.message?.parts
    ?.filter((part) => typeof part?.text === 'string')
    .map((part) => part.text)
    .join('\n') || '';
}

function skillDirectory(text) {
  return text.match(/^Base directory for this skill:\s*([^\r\n]+)/i)?.[1]?.trim() || null;
}

function directoryName(path) {
  return String(path || '').replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || 'unknown';
}

function invocationBefore(entries, index) {
  for (let cursor = index - 1; cursor >= Math.max(0, index - 8); cursor -= 1) {
    const entry = entries[cursor];
    if (entry?.type === 'user') break;
    if (entry?.subtype !== 'slash_command') continue;
    const rawCommand = entry?.systemPayload?.rawCommand;
    if (typeof rawCommand === 'string' && rawCommand.startsWith('/')) return entry;
  }
  return null;
}

function responseAfter(entries, index) {
  for (let cursor = index + 1; cursor < entries.length; cursor += 1) {
    const entry = entries[cursor];
    if (cursor > index + 1 && skillDirectory(entryText(entry))) break;
    const event = entry?.systemPayload?.uiEvent;
    if (event?.['event.name'] === 'qwen-code.api_response' && !event.subagent_name && event.response_text) {
      return {
        result: event.response_text,
        endTimeMs: Date.parse(event['event.timestamp'] || entry.timestamp || '') || Date.now(),
      };
    }
  }
  return { result: null, endTimeMs: null };
}

export function parseTranscriptSkillCalls(contents) {
  const entries = String(contents || '').split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      // Qwen can be writing the final JSONL line while a Stop hook reads it.
      return [];
    }
  });
  const calls = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const expandedPrompt = entryText(entry);
    const baseDirectory = skillDirectory(expandedPrompt);
    if (!baseDirectory) continue;

    const invocation = invocationBefore(entries, index);
    const rawCommand = invocation?.systemPayload?.rawCommand || `/${directoryName(baseDirectory)}`;
    const [commandName, ...argumentsParts] = rawCommand.slice(1).trim().split(/\s+/);
    const skillName = directoryName(baseDirectory) || commandName || 'unknown';
    const startTimeMs = Date.parse(invocation?.timestamp || entry.timestamp || '') || Date.now();
    const response = responseAfter(entries, index);
    const normalizedPath = baseDirectory.replace(/\\/g, '/').toLowerCase();

    calls.push({
      invocationId: String(invocation?.uuid || entry.uuid || `${skillName}:${startTimeMs}`),
      skillName,
      baseDirectory,
      source: normalizedPath.includes('/bundled/') ? 'built-in' : 'custom',
      triggerMode: invocation ? 'slash_command' : 'prompt_expansion',
      command: rawCommand,
      arguments: argumentsParts.join(' '),
      prompt: expandedPrompt,
      result: response.result,
      startTimeMs,
      endTimeMs: response.endTimeMs || startTimeMs,
    });
  }

  return calls;
}

async function skillVersion(baseDirectory) {
  try {
    const contents = await readFile(join(baseDirectory, 'SKILL.md'), 'utf8');
    const frontmatter = contents.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    return frontmatter?.[1]?.match(/^version:\s*["']?([^\r\n"']+)/im)?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

export async function readTranscriptSkillCalls(transcriptPath) {
  if (!transcriptPath) return [];
  try {
    const calls = parseTranscriptSkillCalls(await readFile(transcriptPath, 'utf8'));
    return Promise.all(calls.map(async (call) => ({ ...call, version: await skillVersion(call.baseDirectory) })));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}
