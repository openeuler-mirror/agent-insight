import { normalizeTraceCases } from './contracts';

function csvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], value = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else value += char;
    } else if (char === ',' || char === '\n') {
      row.push(value); value = ''; closed = false;
      if (char === '\n') { rows.push(row); row = []; }
    } else if (char === '"' && !value && !closed) quoted = true;
    else if (closed || char === '"') throw new Error('CSV 引号格式错误');
    else value += char;
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  row.push(value); rows.push(row);
  return rows.filter(r => r.some(v => v !== ''));
}

export function parseTraceBatch(text: string) {
  try {
    const content = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    let values: unknown[];
    if (/^\s*[\[{]/.test(content)) {
      const root = JSON.parse(content);
      values = Array.isArray(root) ? root : [root];
    } else {
      const [header, ...rows] = csvRows(content);
      if (!header || header.length !== 2 || new Set(header).size !== 2 || !header.includes('input') || !header.includes('reference_output')) throw new Error('CSV 表头必须且只能为 input,reference_output');
      values = rows.map(row => {
        if (row.length !== 2) throw new Error('每行必须包含两个字段');
        return Object.fromEntries(header.map((key, i) => [key, row[i]]));
      });
    }
    const cases = normalizeTraceCases(values.map(value => ({ id: crypto.randomUUID(), values: value })));
    return { cases, skippedEmpty: 0, ...(cases.length ? {} : { message: '内容为空' }) };
  } catch (error) {
    return { cases: [], skippedEmpty: 0, message: error instanceof Error ? error.message : '导入失败' };
  }
}
