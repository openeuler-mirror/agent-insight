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
import { parseSkillFlow, getParsedFlow } from '@/lib/engine/observability/flow-parser';
import { canAccessSkill, resolveUser } from '@/lib/auth/auth';

interface SkillVersion {
  version: number;
  content?: string;
}

interface SkillDetail {
  id: string;
  versions?: SkillVersion[];
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; version: string }> }
) {
  try {
    const { id, version } = await params;
    const body = await request.json().catch(() => ({}));
    const { username: user } = await resolveUser(request, typeof body.user === 'string' ? body.user : null);
    const { allowed, skill: accessSkill } = await canAccessSkill(id, user);
    const skill = accessSkill as SkillDetail | null;
    if (!skill) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
    }
    if (!allowed) {
      return NextResponse.json({ error: 'Unauthorized: Access denied' }, { status: 403 });
    }
    
    const targetVersion = parseInt(version, 10);
    const skillVersion = skill.versions?.find((v: SkillVersion) => v.version === targetVersion);
    
    if (!skillVersion) {
      return NextResponse.json({ error: 'Version not found' }, { status: 404 });
    }
    
    const content = skillVersion.content;
    if (!content) {
      return NextResponse.json({ error: 'Skill content is empty' }, { status: 400 });
    }
    
    const result = await parseSkillFlow(content, id, targetVersion, user);
    
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
    
    return NextResponse.json({
      success: true,
      flow: result.flow,
      mermaidCode: result.mermaidCode
    });
    
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('Parse flow error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; version: string }> }
) {
  try {
    const { id, version } = await params;
    const searchParams = request.nextUrl.searchParams;
    const { username: user } = await resolveUser(request, searchParams.get('user'));
    const { allowed, skill } = await canAccessSkill(id, user);
    if (!skill) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
    }
    if (!allowed) {
      return NextResponse.json({ error: 'Unauthorized: Access denied' }, { status: 403 });
    }
    
    const targetVersion = parseInt(version, 10);
    const parsedFlow = await getParsedFlow(id, targetVersion, user);
    
    if (!parsedFlow) {
      return NextResponse.json({ 
        parsed: false,
        message: 'Flow not parsed yet' 
      });
    }
    
    return NextResponse.json({
      parsed: true,
      flowJson: parsedFlow.flowJson,
      mermaidCode: parsedFlow.mermaidCode,
      parsedAt: parsedFlow.parsedAt
    });
    
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('Get parsed flow error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
