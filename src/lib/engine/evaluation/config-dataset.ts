/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export type ConfigDatasetType = 'combined' | 'routing' | 'outcome';

export const CONFIG_DATASET_TYPES: ConfigDatasetType[] = ['combined', 'routing', 'outcome'];

export function normalizeConfigDatasetType(value: unknown): ConfigDatasetType {
    if (value === 'routing' || value === 'outcome' || value === 'combined') {
        return value;
    }
    return 'combined';
}

export function configSupportsDatasetType(
    datasetType: unknown,
    targetType: Exclude<ConfigDatasetType, 'combined'>
): boolean {
    const normalized = normalizeConfigDatasetType(datasetType);
    return normalized === 'combined' || normalized === targetType;
}

export function getDatasetTypePriority(
    datasetType: unknown,
    targetType: Exclude<ConfigDatasetType, 'combined'> | 'any'
): number {
    const normalized = normalizeConfigDatasetType(datasetType);
    if (targetType === 'any') {
        return normalized === 'combined' ? 1 : 2;
    }
    if (normalized === targetType) {
        return 3;
    }
    if (normalized === 'combined') {
        return 2;
    }
    return 0;
}

export function normalizeExpectedSkills(
    value: unknown
): { skill: string; version: number | null }[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .map((item) => {
            if (typeof item === 'string') {
                const trimmed = item.trim();
                if (!trimmed) return null;
                return { skill: trimmed, version: null };
            }

            if (!item || typeof item !== 'object') {
                return null;
            }

            const rawSkill = 'skill' in item ? (item as { skill?: unknown }).skill : null;
            const skill = typeof rawSkill === 'string' ? rawSkill.trim() : '';
            if (!skill) {
                return null;
            }

            const rawVersion = 'version' in item ? (item as { version?: unknown }).version : null;
            let version: number | null = null;
            if (typeof rawVersion === 'number' && Number.isInteger(rawVersion) && rawVersion >= 0) {
                version = rawVersion;
            } else if (typeof rawVersion === 'string' && rawVersion.trim()) {
                const parsed = parseInt(rawVersion, 10);
                version = Number.isNaN(parsed) || parsed < 0 ? null : parsed;
            }

            return { skill, version };
        })
        .filter((item): item is { skill: string; version: number | null } => Boolean(item));
}

export function hasRoutingExpectations(config: {
    skill?: string | null;
    expectedSkills?: { skill: string; version: number | null }[] | null;
}): boolean {
    if (config.skill && config.skill.trim() !== '') {
        return true;
    }

    return normalizeExpectedSkills(config.expectedSkills).length > 0;
}

export function hasOutcomeExpectations(config: {
    standard_answer?: string | null;
    root_causes?: unknown[] | null;
    key_actions?: unknown[] | null;
}): boolean {
    if (config.standard_answer && config.standard_answer.trim() !== '') {
        return true;
    }

    return (Array.isArray(config.root_causes) && config.root_causes.length > 0)
        || (Array.isArray(config.key_actions) && config.key_actions.length > 0);
}
