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

import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { prismaRaw } from '@/lib/storage/prisma';

export const EXTERNAL_VERIFICATION_RESULTS = ['passed', 'failed'] as const;
export type ExternalVerificationResult = (typeof EXTERNAL_VERIFICATION_RESULTS)[number];

export class SkillVersionVerificationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface OptimizationPublishedVersionState {
  skillId: string | null;
  activeVersion: number | null;
  verificationStatus: string | null;
  verificationMode: string | null;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  verificationNote: string | null;
}

export async function loadOptimizationPublishedVersionStates(
  user: string,
  records: ReadonlyArray<{ id: string; skillName: string; publishedVersion: number | null }>,
) {
  const published = records.filter((record) => Number.isInteger(record.publishedVersion));
  if (!published.length) return new Map<string, OptimizationPublishedVersionState>();
  const names = [...new Set(published.map((record) => record.skillName))];
  const versions = [...new Set(published.map((record) => record.publishedVersion as number))];
  const skills = await prismaRaw.skill.findMany({
    where: { user, name: { in: names } },
    select: {
      id: true,
      name: true,
      activeVersion: true,
      versions: {
        where: { version: { in: versions } },
        select: {
          version: true,
          verificationStatus: true,
          verificationMode: true,
          verifiedAt: true,
          verifiedBy: true,
          verificationNote: true,
        },
      },
    },
  });
  const skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
  return new Map(published.map((record) => {
    const skill = skillsByName.get(record.skillName);
    const version = skill?.versions.find((item) => item.version === record.publishedVersion);
    return [record.id, {
      skillId: skill?.id || null,
      activeVersion: skill?.activeVersion ?? null,
      verificationStatus: version?.verificationStatus || null,
      verificationMode: version?.verificationMode || null,
      verifiedAt: version?.verifiedAt || null,
      verifiedBy: version?.verifiedBy || null,
      verificationNote: version?.verificationNote || null,
    }];
  }));
}

export async function recordExternalSkillVersionVerification(input: {
  user: string;
  skillName: string;
  version: number;
  result: ExternalVerificationResult;
  note?: string;
}) {
  const skill = await prismaRaw.skill.findFirst({
    where: { user: input.user, name: input.skillName },
    select: { id: true, name: true, activeVersion: true },
  });
  if (!skill) throw new SkillVersionVerificationError('Skill 不存在或无权操作', 404);
  const version = await prismaRaw.skillVersion.findUnique({
    where: { skillId_version: { skillId: skill.id, version: input.version } },
  });
  if (!version) throw new SkillVersionVerificationError(`Skill 版本 v${input.version} 不存在`, 404);
  if (version.verificationMode !== 'external') {
    throw new SkillVersionVerificationError('该版本不是待外部验证版本', 409);
  }
  const note = input.note?.trim().slice(0, 2_000) || null;
  const updated = await prismaRaw.skillVersion.update({
    where: { id: version.id },
    data: {
      verificationStatus: input.result,
      verifiedAt: new Date(),
      verifiedBy: input.user,
      verificationNote: note,
    },
  });
  recordUsageEvent({
    user: input.user,
    featureKey: 'skill-opt',
    eventKey: input.result === 'passed'
      ? 'skill.optimize.verification.passed'
      : 'skill.optimize.verification.failed',
  });
  return { skill, version: updated };
}

export async function activateVerifiedSkillVersion(input: {
  user: string;
  skillName: string;
  version: number;
}) {
  const skill = await prismaRaw.skill.findFirst({
    where: { user: input.user, name: input.skillName },
    select: { id: true, name: true, activeVersion: true },
  });
  if (!skill) throw new SkillVersionVerificationError('Skill 不存在或无权操作', 404);
  const version = await prismaRaw.skillVersion.findUnique({
    where: { skillId_version: { skillId: skill.id, version: input.version } },
  });
  if (!version) throw new SkillVersionVerificationError(`Skill 版本 v${input.version} 不存在`, 404);
  if (!['passed', 'not_required'].includes(version.verificationStatus)) {
    throw new SkillVersionVerificationError(
      version.verificationStatus === 'failed'
        ? '该版本外部验证未通过，不能激活'
        : '该版本尚未完成外部验证，不能激活',
      409,
    );
  }
  const updated = skill.activeVersion === input.version
    ? await prismaRaw.skill.findUniqueOrThrow({ where: { id: skill.id } })
    : await prismaRaw.skill.update({ where: { id: skill.id }, data: { activeVersion: input.version } });
  recordUsageEvent({ user: input.user, featureKey: 'skill', eventKey: 'skill.activate' });
  return { skill: updated, version };
}
