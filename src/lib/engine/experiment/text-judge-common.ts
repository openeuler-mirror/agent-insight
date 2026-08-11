/**
 * Fluency / Hallucination 两个文本类预置评估器的 Judge 调用与 JSON 修复（族内共享，
 * 不改动其他评估器共用的 specialized-evaluator-common）。
 *
 * 与共享通道的唯一差异：judge 输出 JSON 解析失败时先自动修复再走严格 schema——
 * ① 字符串内裸引号/裸换行转义（内联自 task-completion-json 的修复器，保持族内自包含）；
 * ② 截断补全（max_tokens 打满 / 流中断导致输出中途切断时，回退到最近完整结构边界）。
 * 修复产物仍受 zod 严格校验，不兜底默认档。
 */
import { z } from 'zod';
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly';

export interface TextPresetJudgePrompt {
  stage?: string;
  system: string;
  user: string;
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 转义 JSON 字符串内的裸引号与裸换行（同 task-completion-json 的修复器）。 */
function repairUnescapedQuotesInJsonStrings(candidate: string): string {
  let repaired = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < candidate.length; index += 1) {
    const char = candidate[index];

    if (!inString) {
      if (char === '"') inString = true;
      repaired += char;
      continue;
    }

    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      repaired += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      let lookahead = index + 1;
      while (lookahead < candidate.length && /\s/.test(candidate[lookahead])) {
        lookahead += 1;
      }
      const next = candidate[lookahead] || '';
      if (next === ':' || next === ',' || next === '}' || next === ']') {
        inString = false;
        repaired += char;
      } else {
        repaired += '\\"';
      }
      continue;
    }

    if (char === '\n') {
      repaired += '\\n';
      continue;
    }
    if (char === '\r') {
      repaired += '\\r';
      continue;
    }
    if (char === '\t') {
      repaired += '\\t';
      continue;
    }

    repaired += char;
  }

  return repaired;
}

/**
 * 截断修复：输出中途被切断时，扫描定位最近的结构完整边界（字符串闭合 / 逗号 /
 * 括号），从该处截断并补全未闭合括号。仅当原始片段足够长（≥24 字符）且截断点后
 * 仍有字段时才尝试，避免把零碎垃圾静默成「无问题」输出；产物仍走严格 schema 校验。
 */
function salvageTruncatedJson(text: string): unknown | null {
  if (text.length < 24) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  const boundaries: Array<{ pos: number; stack: string[] }> = [];
  const record = (pos: number) => {
    boundaries.push({ pos, stack: [...stack] });
    if (boundaries.length > 8) boundaries.shift();
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = false; record(i + 1); }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') { stack.push(ch); record(i + 1); continue; }
    if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) return null;
      record(i + 1);
      continue;
    }
    if (ch === ',') record(i + 1);
  }
  if (stack.length === 0 && !inString) return null;
  const closerFor = (open: string) => (open === '{' ? '}' : ']');
  for (const { pos, stack: snapshot } of [...boundaries].reverse()) {
    let candidate = text.slice(0, pos).replace(/[,\s]+$/, '');
    if (!candidate.includes('"')) continue;
    candidate += [...snapshot].reverse().map(closerFor).join('');
    const parsed = tryParseJson(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

/** 解析修复链（仅作为原始 parse 失败后的第二次尝试）。 */
function parseJsonWithRepair(text: string): unknown | null {
  const direct = tryParseJson(text);
  if (direct !== null) return direct;
  const escaped = repairUnescapedQuotesInJsonStrings(text);
  const repaired = tryParseJson(escaped);
  if (repaired !== null) return repaired;
  return salvageTruncatedJson(escaped);
}

function extractAndValidateJudgeOutput<T>(rawText: string, schema: z.ZodType<T>): T {
  const text = rawText.replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new JudgeOutputParseError('judge 输出中未找到 JSON 对象', rawText);
  }

  const parsed = parseJsonWithRepair(text.slice(start, end + 1));
  if (parsed === null) {
    throw new JudgeOutputParseError(
      'judge 输出 JSON 解析失败（原始输出与自动修复后均无法解析）',
      rawText,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new JudgeOutputParseError(`judge 输出不符合文本预置评估器契约: ${details}`, rawText);
  }
  return result.data;
}

/** 族内 Judge 调用：callJudgeLlm → 自动修复解析 → 严格 schema 校验。
 *  固定传 temperature 0（判定确定性化，压严重度/条数波动）+ maxTokens 8192（防长输出截断）；
 *  仅本族评估器使用，其他评估器不传 modelOptions，行为不变。 */
export async function invokeTextPresetJudge<T>(
  user: string,
  prompt: TextPresetJudgePrompt,
  schema: z.ZodType<T>,
): Promise<T> {
  const { callJudgeLlm } = await import('./judge-llm');
  const rawText = await callJudgeLlm(user, {
    system: prompt.system,
    user: prompt.user,
    sessionTitle: `exp-judge-${prompt.stage ?? 'text'}`,
    modelOptions: { temperature: 0, maxTokens: 8192 },
  });
  return extractAndValidateJudgeOutput(rawText, schema);
}
