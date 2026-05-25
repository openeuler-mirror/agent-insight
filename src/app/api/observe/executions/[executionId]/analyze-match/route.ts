import { NextRequest, NextResponse } from 'next/server';
import { analyzeExecutionMatch, getExecutionMatch, analyzeDynamicOnly, parseSkillFlow } from '@/lib/engine/observability/flow-parser';
import { getRootSkillFromInteractions } from '@/lib/engine/observability/skill-scope';
import { persistAlignmentAttribution } from '@/lib/engine/evaluation/alignment-attribution';
import { db } from '@/lib/storage/prisma';

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
  try {
    const { executionId } = await params;
    const body = await request.json().catch(() => ({}));
    const user = body.user || null;
    const mode = body.mode || 'compare';
    
    const execution = await db.findExecutionById(executionId) as ExecutionRecord | null;
    if (!execution) {
      return NextResponse.json({ error: 'Execution not found' }, { status: 404 });
    }
    
    if (mode === 'dynamic') {
      const result = await analyzeDynamicOnly(executionId, user);
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 500 });
      }
      return NextResponse.json({
        success: true,
        mode: 'dynamic',
        dynamicMermaid: result.dynamicMermaid,
        interactionCount: result.interactionCount
      });
    }

    const session = await db.findSessionByTaskId(executionId) as Session | null;
    let rootSkill = null as ReturnType<typeof getRootSkillFromInteractions>;
    if (session?.interactions) {
      try {
        const interactions = typeof session.interactions === 'string'
          ? JSON.parse(session.interactions)
          : session.interactions;
        rootSkill = getRootSkillFromInteractions(interactions);
      } catch {
        rootSkill = null;
      }
    }
    // 兜底：interactions 里没显式 skill 工具调用时（旧 trace / 上报不规范 / 测试数据），
    // 用 Execution 行上 denormalized 的 skill + skillVersion 字段——只要后端记录了
    // 这次执行用的是哪个 skill 哪个版本，就能继续走流程对齐分析。
    // 跟 data-service.ts:1131 的 rootSkill fallback 同口径。
    if (!rootSkill?.name && execution?.skill) {
      rootSkill = {
        name: String(execution.skill),
        version: typeof execution.skillVersion === 'number' ? execution.skillVersion : null,
      };
    }

    const skillName = rootSkill?.name;
    let skillVersion: number | undefined = rootSkill?.version ?? undefined;

    if (!skillName) {
      return NextResponse.json({
        error: '当前 Trace 的外层主 Agent 未加载 Skill，无法进行主 Skill 流程对齐分析。',
      }, { status: 400 });
    }
    
    const skillInfo = await getSkillAndActiveVersion(skillName, user);
    if (!skillInfo) {
      return NextResponse.json({ 
        error: `Skill "${skillName}" 未找到或没有版本。请确认 Skill 已创建并至少有一个版本，或者使用"动态分析"功能。` 
      }, { status: 400 });
    }
    
    const skillId = skillInfo.skillId;
    if (!skillVersion) {
      skillVersion = skillInfo.version;
    }
    
    let result = await analyzeExecutionMatch(
      executionId,
      skillId,
      skillVersion,
      user,
      skillName
    );

    if (!result.success && shouldAutoParseSkillFlow(result.error)) {
      const parseResult = await parseResolvedSkillFlow(skillId, skillVersion, user);
      if (!parseResult.success) {
        return NextResponse.json({
          error: parseResult.error || result.error || 'Skill 流程解析失败',
          autoParseAttempted: true,
        }, { status: 500 });
      }

      result = await analyzeExecutionMatch(
        executionId,
        skillId,
        skillVersion,
        user,
        skillName
      );
    }
    
    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }

    const attribution = await persistAlignmentAttribution({
      user,
      executionId,
      execution,
      match: result.result!,
      skillName,
      skillVersion,
    }).catch(error => {
      console.warn('[analyze-match] alignment attribution failed (non-fatal):', error);
      return null;
    });
    
    return NextResponse.json({
      success: true,
      mode: 'compare',
      match: result.result,
      staticMermaid: result.staticMermaid,
      dynamicMermaid: result.dynamicMermaid,
      flowJson: result.flow ? JSON.stringify(result.flow) : undefined,
      extractedSteps: result.extractedSteps ? JSON.stringify(result.extractedSteps) : undefined,
      interactionCount: result.interactionCount,
      usedSkillName: skillName,
      usedSkillVersion: skillVersion,
      attribution
    });
    
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('Analyze execution match error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
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
  try {
    const { executionId } = await params;
    
    const match = await getExecutionMatch(executionId);
    
    if (!match) {
      return NextResponse.json({ 
        analyzed: false,
        message: 'Execution not analyzed yet' 
      });
    }
    
    const session = await db.findSessionByTaskId(executionId) as Session | null;
    let currentInteractionCount = 0;
    if (session && session.interactions) {
      try {
        const interactions = typeof session.interactions === 'string' 
          ? JSON.parse(session.interactions) 
          : session.interactions;
        currentInteractionCount = Array.isArray(interactions) ? interactions.length : 0;
      } catch {
        // ignore parse errors
      }
    }

    let flowJson: string | null = null;
    let skillName: string | null = null;
    if (match.skillId && match.skillVersion != null) {
      const parsedFlow = await db.findParsedFlow(match.skillId, match.skillVersion, match.user ?? null);
      flowJson = parsedFlow?.flowJson || null;
      const skill = await db.findSkillById(match.skillId) as SkillDetail | null;
      skillName = skill?.name || null;
    }
    
    return NextResponse.json({
      analyzed: true,
      mode: match.mode || 'compare',
      matchJson: match.matchJson,
      staticMermaid: match.staticMermaid,
      dynamicMermaid: match.dynamicMermaid,
      analysisText: match.analysisText,
      flowJson,
      extractedSteps: match.extractedSteps,
      interactionCount: match.interactionCount,
      currentInteractionCount,
      hasUpdate: currentInteractionCount > match.interactionCount,
      matchedAt: match.matchedAt,
      usedSkillName: skillName,
      usedSkillVersion: match.skillVersion
    });
    
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('Get execution match error:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
