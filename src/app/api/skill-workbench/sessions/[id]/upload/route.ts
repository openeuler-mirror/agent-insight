import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import {
  SkillSnapshotUploadError,
  bindUploadedSkillSnapshot,
  parseUploadedSkillSnapshot,
} from '@/lib/skill-workbench/upload-service';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const formData = await request.formData();
    const { username } = await resolveUser(request, formData.get('user')?.toString());
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });

    const files = formData.getAll('files').filter((item): item is File => item instanceof File);
    const paths = formData.getAll('paths').map((item) => item.toString());
    const snapshot = await parseUploadedSkillSnapshot(files, paths);
    const { id } = await context.params;
    const result = await bindUploadedSkillSnapshot({
      user: username,
      sessionId: id,
      skillName: snapshot.skillName,
      files: snapshot.files,
    });
    if (!result?.session) return NextResponse.json({ error: '工作台会话不存在或无访问权限' }, { status: 404 });
    return NextResponse.json({ ...result, description: snapshot.description });
  } catch (error) {
    if (error instanceof SkillSnapshotUploadError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error('[skill-workbench upload POST] failed:', error);
    return NextResponse.json({ error: '解析上传内容失败' }, { status: 500 });
  }
}
