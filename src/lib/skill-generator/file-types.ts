/**
 * Skill-generator 附件白名单：前后端共用。
 * 此文件不得引入任何 node-only 模块（如 fs / path），否则前端无法 import。
 *
 * 单一数据源是 ALLOWED_EXT_GROUPS（按类别分组），其他形式（Set / 扁平数组 /
 * accept 字符串）都从它派生，避免改一处忘改另一处。
 */

export interface ExtGroup {
  /** 内部 key，前端用来取本地化标题 */
  key: 'documents' | 'data' | 'code' | 'config' | 'logs';
  /** 该分类下允许的扩展名，含前导点 */
  exts: readonly string[];
}

export const ALLOWED_EXT_GROUPS: readonly ExtGroup[] = [
  { key: 'documents', exts: ['.md', '.markdown', '.txt', '.pdf', '.docx', '.html', '.htm', '.xml'] },
  { key: 'data',      exts: ['.json', '.csv', '.tsv'] },
  { key: 'code',      exts: [
    '.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.sh', '.bash', '.zsh', '.fish',
    '.go', '.rs', '.java', '.kt', '.swift', '.rb', '.php',
    '.c', '.cc', '.cpp', '.h', '.hpp',
  ] },
  { key: 'config',    exts: ['.yaml', '.yml', '.toml', '.ini', '.conf'] },
  { key: 'logs',      exts: ['.log'] },
];

export const ALLOWED_EXT_LIST: readonly string[] =
  ALLOWED_EXT_GROUPS.flatMap(g => g.exts);

export const ALLOWED_EXT = new Set<string>(ALLOWED_EXT_LIST);

/** 直接喂给 <input type="file" accept="..."> 的字符串 */
export const ALLOWED_EXT_ACCEPT = ALLOWED_EXT_LIST.join(',');
