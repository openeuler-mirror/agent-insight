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
    try { return JSON.parse(trimmed); } catch { return null; }
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
