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

function parseFromCandidate(candidate: string): Record<string, unknown> | null {
    const direct = parseJsonObject(candidate);
    if (direct) return direct;

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

export function parseLooseJson(text: string): Record<string, unknown> | null {
    const trimmed = text.trim();
    const direct = parseFromCandidate(trimmed);
    if (direct) return direct;

    const jsonFenceMatches = Array.from(trimmed.matchAll(/```json\s*([\s\S]*?)\s*```/gi));
    for (const match of jsonFenceMatches) {
        const parsed = parseFromCandidate(match[1] || '');
        if (parsed) return parsed;
    }

    const genericFenceMatches = Array.from(trimmed.matchAll(/```(?:[^\n`]*)\n([\s\S]*?)\s*```/g));
    for (const match of genericFenceMatches) {
        const parsed = parseFromCandidate(match[1] || '');
        if (parsed) return parsed;
    }

    return null;
}

const RESULT_ISSUE_KINDS = new Set(['incorrect_fact', 'extra_content', 'verbosity', 'format', 'other']);
const RESULT_ISSUE_SEVERITIES = new Set(['low', 'medium', 'high']);

export function normalizeResultIssues(
    raw: unknown,
    mode: 'skill-aware' | 'no-skill',
): Array<Record<string, unknown>> {
    if (!Array.isArray(raw)) return [];
    const out: Array<Record<string, unknown>> = [];
    for (const it of raw) {
        if (!it || typeof it !== 'object') continue;
        const o = it as Record<string, unknown>;
        const summary = String(o.summary ?? '').trim();
        if (!summary) continue;

        const kindRaw = String(o.kind ?? 'other').toLowerCase().trim();
        const kind = RESULT_ISSUE_KINDS.has(kindRaw) ? kindRaw : 'other';
        const sevRaw = String(o.severity ?? 'medium').toLowerCase().trim();
        const severity = RESULT_ISSUE_SEVERITIES.has(sevRaw) ? sevRaw : 'medium';
        const attributable = mode === 'no-skill'
            ? false
            : (o.is_skill_attributable === true || o.isSkillAttributable === true);

        out.push({
            kind,
            summary,
            severity,
            is_skill_attributable: attributable,
            attribution_reason: attributable ? String(o.attribution_reason ?? o.attributionReason ?? '').trim() : '',
            improvement_suggestion: attributable ? String(o.improvement_suggestion ?? o.improvementSuggestion ?? '').trim() : '',
        });
    }
    return out;
}
