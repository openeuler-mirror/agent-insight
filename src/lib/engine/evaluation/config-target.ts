export function normalizeConfigQuery(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

export function normalizeConfigSkillName(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.trim();
}

export function normalizeOptionalSkillVersion(value: unknown): number | null {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        return value;
    }

    if (typeof value === 'string' && value.trim()) {
        const parsed = parseInt(value, 10);
        if (!Number.isNaN(parsed) && parsed >= 0) {
            return parsed;
        }
    }

    return null;
}

export function formatSkillTargetLabel(skill?: string | null, skillVersion?: number | null): string | null {
    const normalizedSkill = normalizeConfigSkillName(skill);
    if (!normalizedSkill) return null;
    return skillVersion != null ? `${normalizedSkill} (v${skillVersion})` : normalizedSkill;
}

export function getConfigSubjectLabel(config: {
    query?: string | null;
    skill?: string | null;
    skillVersion?: number | null;
}, fallback = 'Skill benchmark'): string {
    return normalizeConfigQuery(config.query)
        || formatSkillTargetLabel(config.skill, config.skillVersion)
        || fallback;
}
