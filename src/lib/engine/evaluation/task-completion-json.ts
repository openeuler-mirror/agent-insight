function parseJsonObject(candidate: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(candidate);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

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

export function parseLooseJson(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = fenced ? fenced[1] : trimmed;
    const parsed = parseJsonObject(candidate);
    if (parsed) return parsed;

    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
        const objectText = candidate.slice(first, last + 1);
        const extracted = parseJsonObject(objectText);
        if (extracted) return extracted;

        const repaired = parseJsonObject(repairUnescapedQuotesInJsonStrings(objectText));
        if (repaired) {
            return {
                ...repaired,
                _json_repaired: true,
            };
        }
    }

    return null;
}
