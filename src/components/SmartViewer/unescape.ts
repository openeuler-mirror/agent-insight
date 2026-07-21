/**
 * 把"看起来被转义过的纯文本"还原成可读文本。
 *
 * 两个关键约束(修复满屏 \n / 内容被破坏的乱码问题):
 * 1. 合法 JSON 一律原样返回 —— 对 JSON 文本做正则还原会破坏结构
 *    (\" → " 后引号裸奔、\\n → \+真换行),导致 detector 识别失败、
 *    JsonRenderer 退化成 plain,整块内容变成乱文本。JSON 交给
 *    detector → JsonRenderer 结构化展示才是正道。
 * 2. 先保护 \\(双反斜杠),再还原 \n/\t/\" —— 否则 \\n 会被 /\\n/
 *    吃掉后半,剩下"\ + 真换行"的非法组合(用户看到的正是这个)。
 */
export function unescapeText(input: string): string {
    if (typeof input !== 'string') return String(input);
    const trimmed = input.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
        try {
            JSON.parse(trimmed);
            return input; // 合法 JSON:不做任何还原
        } catch { /* 不是合法 JSON,继续走文本还原 */ }
    }
    const hasEscapes = /\\[ntr"'\\]/.test(input);
    if (!hasEscapes) return input;
    const SENTINEL = '\u0000';
    return input
        .replace(/\\\\/g, SENTINEL)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(new RegExp(SENTINEL, 'g'), '\\');
}
