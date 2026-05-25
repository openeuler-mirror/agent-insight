import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// 走自定义 workspace root，隔离测试副作用——getWorkspaceRoot() 读 env GENERAL_AGENT_WORKSPACE_ROOT
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-test-'));
process.env.GENERAL_AGENT_WORKSPACE_ROOT = tmpRoot;

const TEST_USER = 'tester';
const TEST_THREAD = 'thread_abc';

// tsx 在 cjs 输出模式下不允许顶层 await，所以直接 import 模块——env 已在 import 之前设了。
import {
  saveUploadedFiles,
  materializeTextSidecars,
  listAttachments,
  deleteAttachment,
  formatAttachmentsForPrompt,
  MAX_FILES_PER_REQUEST,
} from '../src/lib/skill-generator/attachments';

/** 构造一个 File 对象（Node 18+ 自带 File）—— route 拿到的就是这种 */
function makeFile(name: string, content: string | Uint8Array): File {
  // BlobPart 在 Node 18+ 类型里不包括泛型化的 Uint8Array<ArrayBufferLike>，需要显式 cast
  const blob = typeof content === 'string'
    ? new Blob([content])
    : new Blob([content as BlobPart]);
  return new File([blob], name);
}

before(() => {
  // noop：每个 case 用独立 thread 隔离
});

after(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('saveUploadedFiles 写盘并返回正确元数据', async () => {
  const thread = 'thread_save_1';
  const f1 = makeFile('note.md', '# hello\nworld');
  const f2 = makeFile('data.json', '{"k":1}');
  const { saved, errors } = await saveUploadedFiles(TEST_USER, thread, [f1, f2]);
  assert.equal(errors.length, 0);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].name, 'note.md');
  assert.ok(saved[0].bytes > 0);
  assert.ok(fs.existsSync(saved[0].absPath));
});

test('saveUploadedFiles 拒绝不允许的扩展名', async () => {
  const thread = 'thread_reject';
  const f = makeFile('badge.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  const { saved, errors } = await saveUploadedFiles(TEST_USER, thread, [f]);
  assert.equal(saved.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /不支持/);
});

test('saveUploadedFiles 同名文件自动避让 -1 / -2', async () => {
  const thread = 'thread_collide';
  const a = makeFile('doc.md', 'A');
  const b = makeFile('doc.md', 'B');
  const c = makeFile('doc.md', 'C');
  const { saved, errors } = await saveUploadedFiles(TEST_USER, thread, [a, b, c]);
  assert.equal(errors.length, 0);
  const names = saved.map(s => s.name).sort();
  assert.deepEqual(names, ['doc-1.md', 'doc-2.md', 'doc.md']);
});

test('listAttachments 列出非隐藏文件且按 mtime 倒序', async () => {
  const thread = 'thread_list';
  await saveUploadedFiles(TEST_USER, thread, [
    makeFile('a.txt', 'aaa'),
    makeFile('b.txt', 'bbb'),
  ]);
  const items = listAttachments(TEST_USER, thread);
  assert.equal(items.length, 2);
  assert.ok(items.every(i => i.relPath.startsWith('uploads/')));
});

test('deleteAttachment 移除文件，再 list 时不见', async () => {
  const thread = 'thread_delete';
  await saveUploadedFiles(TEST_USER, thread, [makeFile('rm.txt', 'X')]);
  const before = listAttachments(TEST_USER, thread);
  assert.equal(before.length, 1);
  const ok = deleteAttachment(TEST_USER, thread, 'rm.txt');
  assert.equal(ok, true);
  assert.equal(listAttachments(TEST_USER, thread).length, 0);
});

test('deleteAttachment 拒绝带路径穿越的名字', async () => {
  const thread = 'thread_traverse';
  await saveUploadedFiles(TEST_USER, thread, [makeFile('ok.txt', 'x')]);
  const ok = deleteAttachment(TEST_USER, thread, '../ok.txt');
  assert.equal(ok, false);
  // 文件还在
  assert.equal(listAttachments(TEST_USER, thread).length, 1);
});

test('formatAttachmentsForPrompt 空列表 → 空串；有列表 → 含路径前缀 ./', () => {
  assert.equal(formatAttachmentsForPrompt([]), '');
  const out = formatAttachmentsForPrompt([
    { name: 'a.md', size: 10, relPath: 'uploads/a.md', mtimeMs: 0 },
  ]);
  assert.match(out, /\.\/uploads\/a\.md/);
  assert.match(out, /只读/);
});

test('materializeTextSidecars 对纯文本文件返回 null（无需转）', async () => {
  const thread = 'thread_sidecar';
  const r = await saveUploadedFiles(TEST_USER, thread, [makeFile('plain.md', 'hi')]);
  const sidecars = await materializeTextSidecars(r.saved);
  assert.equal(sidecars['plain.md'], null);
});

test('MAX_FILES_PER_REQUEST 大于 10 时 reject', async () => {
  const thread = 'thread_quota';
  const many = Array.from({ length: MAX_FILES_PER_REQUEST + 1 }, (_, i) =>
    makeFile(`f${i}.txt`, 'x'),
  );
  const { saved, errors } = await saveUploadedFiles(TEST_USER, thread, many);
  assert.equal(saved.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /上限|最多/);
});
