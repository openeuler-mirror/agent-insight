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

import { NextRequest, NextResponse } from 'next/server';
import { analyzeExecutionMatch, getExecutionMatch, analyzeDynamicOnly, parseSkillFlow } from '@/lib/engine/observability/flow-parser';
import { getRootSkillFromInteractions } from '@/lib/engine/observability/skill-scope';
import { persistAlignmentAttribution } from '@/lib/engine/evaluation/alignment-attribution';
import { db } from '@/lib/storage/prisma';
import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {withCoreExperimentMutationRoute} from '@/lib/storage-core/experiments';
import {getCoreFlowAnalysis,postCoreFlowAnalysis} from '@/lib/storage-core/flow-analysis';

interface ExecutionRecord {
  id?: string;
  taskId?: string | null;
  skill?: string;
  skillVersion?: number;
  skills?: string;
}

interface Session {
  interactions?: string | unknown[];
}

interface SkillDetail {
  id: string;
  name: string;
  activeVersion?: number | null;
  versions?: { version: number; content?: string }[];
}

async function getSkillAndActiveVersion(skillName: string, user: string | null): Promise<{ skillId: string; version: number } | null> {
  try {
    const skill = await db.findSkill(skillName, user) as SkillDetail | null;
    if (!skill) {
      return null;
    }
    
    const fullSkill = await db.findSkillById(skill.id) as SkillDetail | null;
    if (!fullSkill || !fullSkill.versions || fullSkill.versions.length === 0) {
      return null;
    }
    
    const targetVersion = fullSkill.activeVersion ?? 0;
    const versionExists = fullSkill.versions.some((v: { version: number }) => v.version === targetVersion);
    
    if (versionExists) {
      return { skillId: skill.id, version: targetVersion };
    } else {
      const versions = fullSkill.versions.map((v: { version: number }) => v.version);
      const latestVersion = Math.max(...versions);
      return { skillId: skill.id, version: latestVersion };
    }
  } catch {
    return null;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> }
) {
  return withCoreExperimentMutationRoute(request,async()=>{
    try{return NextResponse.json(await postCoreFlowAnalysis((await params).executionId));}
    catch(error){if((error as {coreFlowBusinessError?:boolean}).coreFlowBusinessError===true)return NextResponse.json({error:(error as Error).message},{status:500});throw error;}
  });
}

function shouldAutoParseSkillFlow(error?: string): boolean {
  return /请先解析\s*Skill\s*流程|Flow not parsed|not parsed/i.test(error || '');
}

async function parseResolvedSkillFlow(
  skillId: string,
  version: number,
  user: string | null,
): Promise<{ success: boolean; error?: string }> {
  const fullSkill = await db.findSkillById(skillId) as SkillDetail | null;
  const skillVersion = fullSkill?.versions?.find(v => v.version === version);
  const content = skillVersion?.content;
  if (!content) {
    return { success: false, error: `Skill v${version} 内容为空，无法自动解析流程` };
  }

  const parsed = await parseSkillFlow(content, skillId, version, user || null);
  if (!parsed.success) {
    return { success: false, error: parsed.error || 'Skill 流程解析失败' };
  }
  return { success: true };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> }
) {
  return withCoreExperimentMutationRoute(request,async()=>NextResponse.json(await getCoreFlowAnalysis((await params).executionId)));
}
