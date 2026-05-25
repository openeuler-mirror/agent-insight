import type { DatasetCase, DatasetKind } from '@/lib/agent-dataset-model';
import { createEmptyCase } from '@/lib/agent-dataset-model';

function strVal(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** 按常见字段名抽取输入与期望输出（含 UI 示例里的 output） */
export function pickInputOutput(obj: Record<string, unknown>): { input: string; expectedOutput: string; trajectory: string } {
  const inputKeys = ['input', 'question', 'prompt', '用户输入', 'query'];
  const outKeys = [
    'expected_output',
    'expectedOutput',
    'reference_output',
    'output',
    'answer',
    'expected',
    '参考答案',
    '预期输出',
  ];
  const trajKeys = ['trajectory', 'trace', 'agent_trace'];

  let input = '';
  for (const k of inputKeys) {
    if (k in obj) {
      input = strVal(obj[k]).trim();
      if (input) break;
    }
  }

  let expectedOutput = '';
  for (const k of outKeys) {
    if (k in obj) {
      expectedOutput = strVal(obj[k]).trim();
      if (expectedOutput) break;
    }
  }

  let trajectory = '';
  for (const k of trajKeys) {
    if (k in obj) {
      const t = strVal(obj[k]);
      if (t.trim()) {
        trajectory = typeof obj[k] === 'object' ? JSON.stringify(obj[k], null, 0) : t.trim();
        break;
      }
    }
  }

  return { input, expectedOutput, trajectory };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && c === ',') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

export type BatchImportParseResult = {
  cases: DatasetCase[];
  skippedEmpty: number;
  message?: string;
};

/**
 * 从 JSON 数组或对象解析为数据项（轨迹集会读 trajectory 等字段）。
 */
export function parseBatchJson(text: string, datasetKind: DatasetKind): BatchImportParseResult {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    return { cases: [], skippedEmpty: 0, message: '内容为空' };
  }

  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch {
    return { cases: [], skippedEmpty: 0, message: 'JSON 解析失败，请检查括号与引号是否闭合' };
  }

  const rows = Array.isArray(root) ? root : [root];
  const cases: DatasetCase[] = [];
  let skippedEmpty = 0;

  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      skippedEmpty++;
      continue;
    }
    const obj = row as Record<string, unknown>;
    const { input, expectedOutput, trajectory } = pickInputOutput(obj);
    if (!input && !expectedOutput) {
      skippedEmpty++;
      continue;
    }
    const base = createEmptyCase();
    cases.push({
      ...base,
      input,
      expectedOutput,
      trajectory: datasetKind === 'trajectory' ? trajectory : '',
      evaluationFocus: strVal(obj.evaluationFocus ?? obj.evaluation_focus).trim(),
      tags: Array.isArray(obj.tags)
        ? obj.tags.map(t => String(t).trim()).filter(Boolean)
        : [],
    });
  }

  if (cases.length === 0) {
    return {
      cases: [],
      skippedEmpty,
      message: '未解析到有效行：需要至少包含 input 与 expected_output（或 output 等别名）字段',
    };
  }

  return { cases, skippedEmpty };
}

/** 表头别名 → 列角色 */
function normalizeHeader(h: string): 'input' | 'expected' | 'trajectory' | 'ignore' {
  const x = h.replace(/^\uFEFF/, '').trim().toLowerCase();
  if (/^input$|问题|输入|prompt|question|query/.test(x)) return 'input';
  if (/expected_output|expectedoutput|reference_output|预期|输出|answer|参考答案|^output$/.test(x)) return 'expected';
  if (/trajectory|trace|轨迹/.test(x)) return 'trajectory';
  return 'ignore';
}

/**
 * CSV：首行可为表头；无表头时按列顺序 input, expected_output [, trajectory]。
 */
export function parseBatchCsv(text: string, datasetKind: DatasetKind): BatchImportParseResult {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    return { cases: [], skippedEmpty: 0, message: '内容为空' };
  }

  const lines = trimmed.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) {
    return { cases: [], skippedEmpty: 0, message: '内容为空' };
  }

  let headerCols = parseCsvLine(lines[0]);
  const looksLikeHeader = headerCols.some(c => normalizeHeader(c) !== 'ignore');

  let dataLines = lines;
  let colInput = 0;
  let colExpected = 1;
  let colTraj = -1;

  if (looksLikeHeader) {
    dataLines = lines.slice(1);
    colInput = -1;
    colExpected = -1;
    colTraj = -1;
    headerCols.forEach((h, i) => {
      const role = normalizeHeader(h);
      if (role === 'input' && colInput === -1) colInput = i;
      else if (role === 'expected' && colExpected === -1) colExpected = i;
      else if (role === 'trajectory' && colTraj === -1) colTraj = i;
    });
    if (colInput === -1 || colExpected === -1) {
      return {
        cases: [],
        skippedEmpty: 0,
        message: 'CSV 表头需包含「输入/input」与「预期输出/expected_output」对应列名',
      };
    }
  } else if (headerCols.length < 2) {
    return { cases: [], skippedEmpty: 0, message: '首行至少需要两列：输入、预期输出' };
  } else {
    dataLines = lines;
    colInput = 0;
    colExpected = 1;
    colTraj = datasetKind === 'trajectory' ? 2 : -1;
  }

  const cases: DatasetCase[] = [];
  let skippedEmpty = 0;

  for (const line of dataLines) {
    const cols = parseCsvLine(line);
    const input = colInput >= 0 ? (cols[colInput] ?? '').trim() : '';
    const expectedOutput = colExpected >= 0 ? (cols[colExpected] ?? '').trim() : '';
    const trajectory =
      datasetKind === 'trajectory' && colTraj >= 0 ? (cols[colTraj] ?? '').trim() : '';

    if (!input && !expectedOutput) {
      skippedEmpty++;
      continue;
    }

    const base = createEmptyCase();
    cases.push({
      ...base,
      input,
      expectedOutput,
      trajectory,
      evaluationFocus: '',
      tags: [],
    });
  }

  if (cases.length === 0) {
    return { cases: [], skippedEmpty, message: '未解析到有效 CSV 行' };
  }

  return { cases, skippedEmpty };
}

/** 粘贴/文件：以 [ 或 { 开头走 JSON，否则按 CSV 解析 */
export function parseBatchAuto(text: string, datasetKind: DatasetKind): BatchImportParseResult {
  const t = text.replace(/^\uFEFF/, '').trim();
  if (!t) {
    return { cases: [], skippedEmpty: 0, message: '内容为空' };
  }
  if (t.startsWith('[') || t.startsWith('{')) {
    return parseBatchJson(text, datasetKind);
  }
  return parseBatchCsv(text, datasetKind);
}

/** 根据文件名选择解析策略（.csv / .json；其余自动识别） */
export function parseBatchFromFileContent(
  text: string,
  fileName: string,
  datasetKind: DatasetKind,
): BatchImportParseResult {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.csv')) return parseBatchCsv(text, datasetKind);
  if (lower.endsWith('.json')) return parseBatchJson(text, datasetKind);
  return parseBatchAuto(text, datasetKind);
}

export async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ''));
    r.onerror = () => reject(new Error('文件读取失败'));
    r.readAsText(file, 'UTF-8');
  });
}
