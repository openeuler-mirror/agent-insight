import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const databaseDir = mkdtempSync(join(tmpdir(), 'experiment-rename-'));
const databasePath = join(databaseDir, 'test.db');
execFileSync('python3', ['-c', 'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("CREATE TABLE Experiment (id TEXT PRIMARY KEY, user TEXT NOT NULL, name TEXT NOT NULL, scope TEXT, deletedAt DATETIME, updatedAt DATETIME NOT NULL)"); db.commit(); db.close()', databasePath]);

let PATCH: typeof import('@/app/api/experiments/[id]/route').PATCH;
let prisma: typeof import('@/lib/storage/prisma').prisma;

test.before(async () => {
  process.env.DATABASE_URL = `file:${databasePath}`;
  ({ PATCH } = await import('@/app/api/experiments/[id]/route'));
  ({ prisma } = await import('@/lib/storage/prisma'));
});

test.after(async () => {
  if (prisma) await prisma.$disconnect();
  rmSync(databaseDir, { recursive: true, force: true });
});

function patchRequest(id: string, user: string, body: Record<string, unknown>): Request {
  return new Request(`http://localhost/api/experiments/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, ...body }),
  });
}

test('重命名拒绝空名称、超长名称、非字符串名称及混合更新', async () => {
  for (const body of [{ name: '   ' }, { name: 'x'.repeat(121) }, { name: null }, { name: 123 }, { name: '新名称', watchMode: false }]) {
    const response = await PATCH(
      patchRequest('exp-rename', 'rename-owner', body),
      { params: Promise.resolve({ id: 'exp-rename' }) },
    );
    assert.equal(response.status, 400);
  }
});

test('普通与 Skill 实验只允许所属用户重命名', async () => {
  for (const scope of ['', 'skill-workbench']) {
    const id = `rename-${scope || 'global'}`;
    await prisma.$executeRawUnsafe(
      'INSERT INTO "Experiment" ("id", "user", "name", "scope", "updatedAt") VALUES (?, ?, ?, ?, ?)',
      id, 'rename-owner', '原名称', scope, Date.now(),
    );
    const context = { params: Promise.resolve({ id }) };
    const denied = await PATCH(patchRequest(id, 'other-user', { name: '无权修改' }), context);
    assert.equal(denied.status, 404);

    const response = await PATCH(patchRequest(id, 'rename-owner', { name: '  新名称  ' }), context);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, name: '新名称' });
    assert.equal((await prisma.experiment.findUnique({ where: { id }, select: { name: true } }))?.name, '新名称');
  }

  const deletedId = 'rename-deleted';
  await prisma.$executeRawUnsafe(
    'INSERT INTO "Experiment" ("id", "user", "name", "deletedAt", "updatedAt") VALUES (?, ?, ?, ?, ?)',
    deletedId, 'rename-owner', '已删除', Date.now(), Date.now(),
  );
  const deletedResponse = await PATCH(
    patchRequest(deletedId, 'rename-owner', { name: '不应改名' }),
    { params: Promise.resolve({ id: deletedId }) },
  );
  assert.equal(deletedResponse.status, 404);
});
