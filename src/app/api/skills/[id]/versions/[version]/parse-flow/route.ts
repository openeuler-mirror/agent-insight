import { NextRequest, NextResponse } from 'next/server';
import { parseSkillFlow, getParsedFlow } from '@/lib/engine/observability/flow-parser';
import { db } from '@/lib/storage/prisma';

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
    const user = body.user || null;
    
    const skill = await db.findSkillById(id) as SkillDetail | null;
    if (!skill) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
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
    const user = searchParams.get('user') || null;
    
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
