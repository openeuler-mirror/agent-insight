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
