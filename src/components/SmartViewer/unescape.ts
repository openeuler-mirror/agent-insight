export function unescapeText(input: string): string {
    if (typeof input !== 'string') return String(input);
    const hasEscapes = /\\[ntr"\\]/.test(input);
    if (!hasEscapes) return input;
    return input
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');
}
