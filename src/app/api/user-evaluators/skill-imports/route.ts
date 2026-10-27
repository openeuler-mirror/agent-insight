import { evaluatorSkillApi, evaluatorSkillUser } from '@/lib/evaluators/evaluator-skill-api';
import { EvaluatorSkillError, EvaluatorSkillStore, skillRelativePath, SKILL_FILE_LIMIT, SKILL_PACKAGE_LIMIT } from '@/lib/evaluators/evaluator-skill-store';

export const dynamic = 'force-dynamic';
async function boundedFormData(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new EvaluatorSkillError('没有上传文件');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > SKILL_PACKAGE_LIMIT + 1024 * 1024) {
        await reader.cancel();
        throw new EvaluatorSkillError('上传大小超限', 413);
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return new Response(new Uint8Array(Buffer.concat(chunks)), { headers: { 'Content-Type': request.headers.get('content-type') || '' } }).formData();
}
export async function POST(request: Request) {
  return evaluatorSkillApi(async () => {
    if (Number(request.headers.get('content-length')) > SKILL_PACKAGE_LIMIT + 1024 * 1024) throw new EvaluatorSkillError('上传大小超限', 413);
    const form = await boundedFormData(request);
    const user = await evaluatorSkillUser(request, String(form.get('user') || ''));
    const kind = form.get('kind');
    const files = form.getAll('files');
    const paths = form.getAll('paths');
    if (kind !== 'folder') throw new EvaluatorSkillError('请导入 Skill 文件夹，不支持直接上传 ZIP 或单个文件');
    if (!files.length || files.length > SKILL_FILE_LIMIT
      || files.some(f => typeof f === 'string') || files.reduce((n, f) => n + (f as File).size, 0) > SKILL_PACKAGE_LIMIT) {
      throw new EvaluatorSkillError('请选择有效文件，上传总量不超过 10 MiB、256 个文件');
    }
    if (paths.length !== files.length || paths.some(p => typeof p !== 'string')) throw new EvaluatorSkillError('文件夹路径清单无效');
    const relativePaths = paths.map(p => skillRelativePath(String(p)));
    const root = relativePaths[0].split('/')[0];
    if (relativePaths.some((p, i) => {
      const filename = (files[i] as File).name;
      return !p.startsWith(`${root}/`) || (filename !== p && filename !== p.split('/').at(-1));
    })
      || !relativePaths.includes(`${root}/SKILL.md`)) throw new EvaluatorSkillError('请选择根目录包含 SKILL.md 的单个 Skill 文件夹');
    const input = await Promise.all(files.map(async (file, i) => ({ path: relativePaths[i], data: Buffer.from(await (file as File).arrayBuffer()) })));
    return new EvaluatorSkillStore().stage(user, input, root);
  });
}
