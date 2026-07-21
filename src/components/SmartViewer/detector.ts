export type ContentType =
    | { kind: 'json'; data: unknown }
    | { kind: 'markdown' }
    | { kind: 'code'; lang: string }
    | { kind: 'plain' };

const MD_PATTERNS = [
    /^#{1,6}\s+\S/m,
    /^```[\s\S]*?```/m,
    /^\|.+\|.+\|/m,
    /^[-*+]\s+\S/m,
    /^\d+\.\s+\S/m,
    /\[.+?\]\(.+?\)/,
];

const SHELL_PATTERNS = [
    /^\$\s+/m,
    /\b(sudo|apt|yum|brew|npm|pnpm|yarn|git|docker|kubectl|ssh|curl|wget)\b/,
];

const CODE_HINTS: Array<{ lang: string; pattern: RegExp }> = [
    { lang: 'typescript', pattern: /\b(interface|type)\s+\w+\s*[={]/ },
    { lang: 'tsx',        pattern: /<[A-Z]\w*[\s/>]/ },
    { lang: 'javascript', pattern: /\b(const|let|var|function|=>)\b/ },
    { lang: 'python',     pattern: /\b(def|import|from|class|self)\b.*:/ },
    { lang: 'go',         pattern: /\bfunc\s+\w+\s*\(/ },
    { lang: 'rust',       pattern: /\bfn\s+\w+\s*\(/ },
    { lang: 'sql',        pattern: /\b(SELECT|FROM|WHERE|INSERT|UPDATE)\b/i },
    { lang: 'yaml',       pattern: /^[\w-]+:\s*(\S|$)/m },
];

function looksLikeJson(text: string): unknown | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const first = trimmed[0];
    if (first !== '{' && first !== '[') return null;
    try { return deepParseJsonStrings(JSON.parse(trimmed)); } catch { return null; }
}

// 工具/LLM 输出常见"双重序列化":JSON 的字符串字段本身又是一段 JSON
// (如 LangChain ToolMessage.content 装着 API 返回的 JSON 字符串)。
// 不展开的话,那个字段就是一坨带 \n 字面的长字符串,不可读。
// 这里递归把"看起来是 JSON 的字符串值"parse 掉(限深、限长,防性能问题)。
const DEEP_PARSE_MAX_DEPTH = 4;
const DEEP_PARSE_MAX_STRING = 2_000_000;

function deepParseJsonStrings(value: unknown, depth = 0): unknown {
    if (depth >= DEEP_PARSE_MAX_DEPTH) return value;
    if (typeof value === 'string') {
        const t = value.trim();
        if (t.length < 2 || t.length > DEEP_PARSE_MAX_STRING) return value;
        const first = t[0];
        if (first !== '{' && first !== '[') return value;
        try {
            return deepParseJsonStrings(JSON.parse(t), depth + 1);
        } catch {
            return value;
        }
    }
    if (Array.isArray(value)) {
        return value.map((item) => deepParseJsonStrings(item, depth + 1));
    }
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = deepParseJsonStrings(v, depth + 1);
        }
        return out;
    }
    return value;
}

function looksLikeMarkdown(text: string): boolean {
    let hits = 0;
    for (const p of MD_PATTERNS) if (p.test(text)) hits++;
    return hits >= 2;
}

function guessCodeLang(text: string): string | null {
    if (SHELL_PATTERNS.some(p => p.test(text))) return 'bash';
    for (const { lang, pattern } of CODE_HINTS) {
        if (pattern.test(text)) return lang;
    }
    return null;
}

export function detect(text: string, hint?: string): ContentType {
    if (hint) {
        if (hint === 'json') {
            const data = looksLikeJson(text);
            if (data !== null) return { kind: 'json', data };
        }
        if (hint === 'markdown') return { kind: 'markdown' };
        return { kind: 'code', lang: hint };
    }
    const data = looksLikeJson(text);
    if (data !== null) return { kind: 'json', data };
    if (looksLikeMarkdown(text)) return { kind: 'markdown' };
    const lang = guessCodeLang(text);
    if (lang) return { kind: 'code', lang };
    return { kind: 'plain' };
}
