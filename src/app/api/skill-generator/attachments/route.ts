import { NextRequest, NextResponse } from 'next/server';
import {
  saveUploadedFiles,
  materializeTextSidecars,
  listAttachments,
  deleteAttachment,
} from '@/lib/skill-generator/attachments';

export const dynamic = 'force-dynamic';

/**
 * Skill-Generator 附件 API。
 *
 * 附件直接落到对应 thread 的 workspace `<root>/<user>/<threadId>/uploads/`，
 * skill-generator agent 走内置 read 工具就能读——不另起 MCP 服务器、不进 DB。
 *
 * VFS 扫描 / 下载 zip 已在 bridge 里排除 uploads/，避免素材污染生成产物视图。
 */

/** POST: 上传一批文件 */
export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return NextResponse.json({ error: 'invalid multipart' }, { status: 400 });
  }

  const user = String(form.get('user') || '').trim();
  const threadId = String(form.get('threadId') || '').trim();
  if (!user || !threadId) {
    return NextResponse.json({ error: 'user / threadId required' }, { status: 400 });
  }

  const files = form.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return NextResponse.json({ error: 'no files' }, { status: 400 });
  }

  const { saved, errors } = await saveUploadedFiles(user, threadId, files);
  // 异步抽 PDF / docx 文本。route 等它结束——首次上传是用户预期"传完就好用"的强信号
  const sidecars = await materializeTextSidecars(saved);

  // 重新扫一次，把刚 save 的 + 已存在的都吐回去，前端 chip 列表直接吃整份
  const items = listAttachments(user, threadId);
  return NextResponse.json({
    items,
    accepted: saved.map(s => ({
      name: s.name,
      bytes: s.bytes,
      textName: sidecars[s.name] || null,
    })),
    errors,
  });
}

/** GET: 列出当前 thread 已上传的附件 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const user = url.searchParams.get('user') || '';
  const threadId = url.searchParams.get('threadId') || '';
  if (!user || !threadId) {
    return NextResponse.json({ error: 'user / threadId required' }, { status: 400 });
  }
  return NextResponse.json({ items: listAttachments(user, threadId) });
}

/** DELETE: 删除指定附件（连带 .txt 副本） */
export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const user = url.searchParams.get('user') || '';
  const threadId = url.searchParams.get('threadId') || '';
  const name = url.searchParams.get('name') || '';
  if (!user || !threadId || !name) {
    return NextResponse.json({ error: 'user / threadId / name required' }, { status: 400 });
  }
  const ok = deleteAttachment(user, threadId, name);
  if (!ok) return NextResponse.json({ error: 'not found or invalid name' }, { status: 404 });
  return NextResponse.json({ ok: true, items: listAttachments(user, threadId) });
}
