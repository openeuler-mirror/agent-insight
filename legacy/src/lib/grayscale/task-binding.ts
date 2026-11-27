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

export type GrayscaleTaskBoundSide = 'a' | 'b';

export type GrayscaleTaskBindingConfig = {
  skillId?: string;
  versionAId?: string;
  versionBId?: string;
  boundSide?: GrayscaleTaskBoundSide;
};

export function getGrayscaleTaskBoundSide(config: GrayscaleTaskBindingConfig): GrayscaleTaskBoundSide {
  return config.boundSide === 'a' ? 'a' : 'b';
}

export function getGrayscaleTaskBoundVersionId(config: GrayscaleTaskBindingConfig): string {
  return String(getGrayscaleTaskBoundSide(config) === 'a' ? config.versionAId || '' : config.versionBId || '').trim();
}

export function normalizeGrayscaleTaskBinding<T extends GrayscaleTaskBindingConfig>(
  config: T,
  task: { skillId: string; skillVersionId: string },
): T & { skillId: string; boundSide: GrayscaleTaskBoundSide } {
  const boundSide = getGrayscaleTaskBoundSide(config);
  return {
    ...config,
    skillId: task.skillId,
    boundSide,
    ...(boundSide === 'a'
      ? { versionAId: task.skillVersionId }
      : { versionBId: task.skillVersionId }),
  };
}

export function hydrateGrayscaleTaskBinding<T extends GrayscaleTaskBindingConfig>(
  config: T,
  task: { skillId: string; skillVersionId: string },
): T & { skillId: string; boundSide: GrayscaleTaskBoundSide } {
  const boundSide = getGrayscaleTaskBoundSide(config);
  const boundVersionId = getGrayscaleTaskBoundVersionId(config);
  return {
    ...config,
    skillId: String(config.skillId || '').trim() || task.skillId,
    boundSide,
    ...(!boundVersionId
      ? boundSide === 'a'
        ? { versionAId: task.skillVersionId }
        : { versionBId: task.skillVersionId }
      : {}),
  };
}

export function isGrayscaleTaskBindingValid(
  config: GrayscaleTaskBindingConfig,
  task: { skillId: string; skillVersionId: string },
): boolean {
  const configSkillId = String(config.skillId || '').trim();
  return (!configSkillId || configSkillId === task.skillId)
    && getGrayscaleTaskBoundVersionId(config) === task.skillVersionId;
}
