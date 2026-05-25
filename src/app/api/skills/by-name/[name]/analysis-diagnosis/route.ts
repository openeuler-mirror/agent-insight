import { NextResponse } from 'next/server';
import { OpenAI } from 'openai';

import { getProxyConfig } from '@/lib/ingest/proxy-config';
import {
  buildDiagnosisPrompt,
  buildFallbackDiagnosis,
  parseDiagnosisResponse,
  type SkillDiagnosisSnapshot,
} from '@/lib/skill-analysis/diagnosis';
import { getActiveConfig } from '@/lib/storage/server-config';

export const dynamic = 'force-dynamic';

function isSnapshot(value: unknown): value is SkillDiagnosisSnapshot {
  if (!value || typeof value !== 'object') return false;
  const root = value as Record<string, unknown>;
  return typeof root.skillName === 'string' && 'overall' in root && 'ab' in root && 'trace' in root && 'recall' in root && 'static' in root;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  try {
    const { name } = await params;
    const body = await request.json().catch(() => ({}));
    const user = typeof body?.user === 'string' ? body.user.trim() : '';
    const snapshot = body?.snapshot;

    if (!user) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }
    if (!isSnapshot(snapshot)) {
      return NextResponse.json({ error: 'snapshot is required' }, { status: 400 });
    }

    const skillName = decodeURIComponent(name);
    const safeSnapshot: SkillDiagnosisSnapshot = {
      ...snapshot,
      skillName,
    };

    const fallback = buildFallbackDiagnosis(safeSnapshot);
    const activeConfig = await getActiveConfig(user);
    if (!activeConfig) {
      return NextResponse.json({
        diagnosis: {
          ...fallback,
          errorMessage: '当前未配置可用的评测模型，已回退为基础诊断。',
          modelLabel: null,
        },
      });
    }

    try {
      const { customFetch } = getProxyConfig();
      const client = new OpenAI({
        apiKey: activeConfig.apiKey || 'no-api-key-required',
        baseURL: activeConfig.baseUrl || 'https://api.deepseek.com',
        fetch: customFetch as typeof fetch | undefined,
      });
      const model = activeConfig.model || 'deepseek-chat';
      const prompt = buildDiagnosisPrompt(safeSnapshot);
      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        response_format: { type: 'json_object' },
      });
      const content = completion.choices?.[0]?.message?.content || '';
      const parsed = parseDiagnosisResponse(content);
      if (!parsed) {
        throw new Error('诊断响应解析失败');
      }
      return NextResponse.json({
        diagnosis: {
          ...parsed,
          mode: 'llm',
          modelLabel: activeConfig.name || activeConfig.model || model,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LLM diagnosis failed';
      return NextResponse.json({
        diagnosis: {
          ...fallback,
          errorMessage: message,
          modelLabel: activeConfig.name || activeConfig.model || null,
        },
      });
    }
  } catch (error) {
    console.error('analysis-diagnosis POST error:', error);
    return NextResponse.json({ error: 'failed to generate diagnosis' }, { status: 500 });
  }
}
