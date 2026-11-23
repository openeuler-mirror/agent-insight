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

import { create } from 'zustand';

export type GeneratedSkillFile = {
    path: string;
    content: string;
    modified_at: string;
};

export type GeneratedSkill = {
    id: string;
    name: string;
    description: string;
    skillMdPath: string;
    skillMdContent: string;
    files: GeneratedSkillFile[];
    updated_at: string;
};

type SkillPanelState = {
    skills: GeneratedSkill[];
    activeSkillId: string | null;
    activeFilePath: string | null;
};

type GeneratedSkillsStore = {
    panels: Record<string, SkillPanelState>;
    syncPanel: (panelId: string, skills: GeneratedSkill[]) => void;
    setActiveSkill: (panelId: string, skillId: string) => void;
    setActiveFile: (panelId: string, filePath: string) => void;
};

const getDefaultPanelState = (skills: GeneratedSkill[]): SkillPanelState => {
    const firstSkill = skills[0];
    const firstFilePath = firstSkill?.skillMdPath || firstSkill?.files[0]?.path || null;
    return {
        skills,
        activeSkillId: firstSkill?.id ?? null,
        activeFilePath: firstFilePath,
    };
};

export const useGeneratedSkillsStore = create<GeneratedSkillsStore>((set, get) => ({
    panels: {},
    syncPanel: (panelId, skills) => {
        const current = get().panels[panelId];
        if (!current) {
            set((state) => ({
                panels: {
                    ...state.panels,
                    [panelId]: getDefaultPanelState(skills),
                },
            }));
            return;
        }

        const activeSkillExists = skills.some((skill) => skill.id === current.activeSkillId);
        const activeSkillId = activeSkillExists
            ? current.activeSkillId
            : (skills[0]?.id ?? null);

        const activeSkill = skills.find((skill) => skill.id === activeSkillId) ?? skills[0];
        const activeFileExists = Boolean(
            current.activeFilePath
            && activeSkill?.files.some((file) => file.path === current.activeFilePath)
        );
        const activeFilePath = activeFileExists
            ? current.activeFilePath
            : (activeSkill?.skillMdPath || activeSkill?.files[0]?.path || null);

        set((state) => ({
            panels: {
                ...state.panels,
                [panelId]: {
                    skills,
                    activeSkillId,
                    activeFilePath,
                },
            },
        }));
    },
    setActiveSkill: (panelId, skillId) => {
        set((state) => {
            const panel = state.panels[panelId];
            if (!panel) return state;
            const activeSkill = panel.skills.find((skill) => skill.id === skillId);
            if (!activeSkill) return state;
            return {
                panels: {
                    ...state.panels,
                    [panelId]: {
                        ...panel,
                        activeSkillId: skillId,
                        activeFilePath: activeSkill.skillMdPath || activeSkill.files[0]?.path || null,
                    },
                },
            };
        });
    },
    setActiveFile: (panelId, filePath) => {
        set((state) => {
            const panel = state.panels[panelId];
            if (!panel) return state;
            return {
                panels: {
                    ...state.panels,
                    [panelId]: {
                        ...panel,
                        activeFilePath: filePath,
                    },
                },
            };
        });
    },
}));
