import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NextRequest } from 'next/server';

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-auth-security-'));
const testDbPath = path.join(testHome, 'security.db');
process.env.AGENT_INSIGHT_HOME = testHome;
process.env.DATABASE_URL = `file:${testDbPath}`;
fs.closeSync(fs.openSync(testDbPath, 'w'));
execFileSync(
  process.execPath,
  [path.resolve(__dirname, '../node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate'],
  { cwd: path.resolve(__dirname, '..'), env: process.env, stdio: 'ignore' },
);

const suffix = `${Date.now()}-${process.pid}`;
const alice = `alice-${suffix}`;
const bob = `bob-${suffix}`;
const aliceKey = `wi_alice_${suffix}`;
const bobKey = `wi_bob_${suffix}`;

let resolveUser: typeof import('@/lib/auth/auth').resolveUser;
let canAccessSkill: typeof import('@/lib/auth/auth').canAccessSkill;
let canManageSkill: typeof import('@/lib/auth/auth').canManageSkill;
let resolveTraceReadScope: typeof import('@/lib/auth/admin').resolveTraceReadScope;
let prisma: typeof import('@/lib/storage/prisma').prisma;
let privateSkillId = '';
let publicSkillId = '';
let systemSkillId = '';
let GET_VERSION: typeof import('@/app/api/skills/[id]/versions/[version]/route').GET;
let GET_VERSIONS: typeof import('@/app/api/skills/[id]/versions/route').GET;
let GET_SKILLS: typeof import('@/app/api/skills/route').GET;
let POST_PUBLISH: typeof import('@/app/api/skills/publish/route').POST;
let DELETE_TRACE: typeof import('@/app/api/observe/data/route').DELETE;
let aliceSessionId = '';
let ownerlessSessionId = '';

function request(url: string, apiKey?: string, init: RequestInit = {}): NextRequest {
  const headers = new Headers(init.headers);
  if (apiKey) headers.set('x-witty-api-key', apiKey);
  return new NextRequest(
    url,
    { ...init, headers } as ConstructorParameters<typeof NextRequest>[1],
  );
}

test.before(async () => {
  const [authModule, adminModule, prismaModule, versionRoute, versionsRoute, skillsRoute, publishRoute, traceRoute] = await Promise.all([
    import('@/lib/auth/auth'),
    import('@/lib/auth/admin'),
    import('@/lib/storage/prisma'),
    import('@/app/api/skills/[id]/versions/[version]/route'),
    import('@/app/api/skills/[id]/versions/route'),
    import('@/app/api/skills/route'),
    import('@/app/api/skills/publish/route'),
    import('@/app/api/observe/data/route'),
  ]);
  resolveUser = authModule.resolveUser;
  canAccessSkill = authModule.canAccessSkill;
  canManageSkill = authModule.canManageSkill;
  resolveTraceReadScope = adminModule.resolveTraceReadScope;
  prisma = prismaModule.prisma;
  GET_VERSION = versionRoute.GET;
  GET_VERSIONS = versionsRoute.GET;
  GET_SKILLS = skillsRoute.GET;
  POST_PUBLISH = publishRoute.POST;
  DELETE_TRACE = traceRoute.DELETE;

  await prisma.user.createMany({
    data: [
      { username: alice, apiKey: aliceKey },
      { username: bob, apiKey: bobKey },
    ],
  });
  const [privateSkill, publicSkill, systemSkill, aliceSession, ownerlessSession] = await Promise.all([
    prisma.skill.create({
      data: {
        name: `private-${suffix}`,
        user: alice,
        visibility: 'private',
        versions: { create: { version: 0, content: '# private' } },
      },
    }),
    prisma.skill.create({
      data: {
        name: `public-${suffix}`,
        user: bob,
        visibility: 'public',
        versions: { create: { version: 0, content: '# public' } },
      },
    }),
    prisma.skill.create({
      data: {
        name: `system-${suffix}`,
        user: null,
        visibility: 'private',
        versions: { create: { version: 0, content: '# system' } },
      },
    }),
    prisma.skillGeneratorSession.create({
      data: {
        user: alice,
        title: `alice-session-${suffix}`,
      },
    }),
    prisma.skillGeneratorSession.create({
      data: {
        user: null,
        title: `ownerless-session-${suffix}`,
      },
    }),
  ]);
  privateSkillId = privateSkill.id;
  publicSkillId = publicSkill.id;
  systemSkillId = systemSkill.id;
  aliceSessionId = aliceSession.id;
  ownerlessSessionId = ownerlessSession.id;
});

test.after(async () => {
  if (aliceSessionId) await prisma.skillGeneratorSession.deleteMany({ where: { id: aliceSessionId } });
  if (ownerlessSessionId) await prisma.skillGeneratorSession.deleteMany({ where: { id: ownerlessSessionId } });
  if (privateSkillId) await prisma.skill.deleteMany({ where: { id: privateSkillId } });
  if (publicSkillId) await prisma.skill.deleteMany({ where: { id: publicSkillId } });
  if (systemSkillId) await prisma.skill.deleteMany({ where: { id: systemSkillId } });
  await prisma.user.deleteMany({ where: { username: { in: [alice, bob] } } });
  await prisma.$disconnect();
  fs.rmSync(testHome, { recursive: true, force: true });
});

test('显式 user 不能单独认证', async () => {
  assert.deepEqual(
    await resolveUser(request(`http://localhost/api/skills?user=${alice}`), alice),
    { username: null, apiKey: null },
  );
});

test('API Key 与显式 user 不一致时拒绝认证', async () => {
  assert.deepEqual(
    await resolveUser(request(`http://localhost/api/skills?user=${bob}`, aliceKey), bob),
    { username: null, apiKey: null },
  );
});

test('API Key 与显式 user 一致时认证成功', async () => {
  assert.deepEqual(
    await resolveUser(request(`http://localhost/api/skills?user=${alice}`, aliceKey), alice),
    { username: alice, apiKey: aliceKey },
  );
});

test('匿名请求不能读取用户私有 Skill 版本', async () => {
  const response = await GET_VERSION(
    new NextRequest(`http://localhost/api/skills/${privateSkillId}/versions/0?user=${alice}`),
    { params: Promise.resolve({ id: privateSkillId, version: '0' }) },
  );
  assert.equal(response.status, 403);
});

test('其他用户也不能读取私有 Skill', async () => {
  const access = await canAccessSkill(privateSkillId, bob);
  assert.equal(access.allowed, false);
  const response = await GET_VERSION(
    request(`http://localhost/api/skills/${privateSkillId}/versions/0?user=${alice}`, bobKey),
    { params: Promise.resolve({ id: privateSkillId, version: '0' }) },
  );
  assert.equal(response.status, 403);
});

test('所有者携带 API Key 可以读取私有 Skill', async () => {
  const response = await GET_VERSION(
    request(`http://localhost/api/skills/${privateSkillId}/versions/0?user=${alice}`, aliceKey),
    { params: Promise.resolve({ id: privateSkillId, version: '0' }) },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).content, '# private');
});

test('匿名用户仍可读取公开 Skill', async () => {
  assert.equal((await canAccessSkill(publicSkillId, null)).allowed, true);
});

test('无归属存量 Skill 仅允许平台管理员管理', async () => {
  assert.equal((await canManageSkill(systemSkillId, alice)).allowed, false);
  assert.equal((await canManageSkill(systemSkillId, 'admin')).allowed, true);
});

test('Skill 发布拒绝使用其他用户或无属主的生成会话', async () => {
  const foreign = await POST_PUBLISH(request('http://localhost/api/skills/publish', bobKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: aliceSessionId, user: bob }),
  }));
  assert.equal(foreign.status, 403);

  const ownerless = await POST_PUBLISH(request('http://localhost/api/skills/publish', aliceKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: ownerlessSessionId, user: alice }),
  }));
  assert.equal(ownerless.status, 403);
});

test('Skill 列表即使收到 user 参数也不会返回目标用户的私有 Skill', async () => {
  const anonymous = await GET_SKILLS(
    new NextRequest(`http://localhost/api/skills?user=${alice}`),
  );
  assert.equal(anonymous.status, 200);
  const anonymousIds = (await anonymous.json()).map((skill: { id: string }) => skill.id);
  assert.equal(anonymousIds.includes(privateSkillId), false);
  assert.equal(anonymousIds.includes(publicSkillId), true);

  const mismatched = await GET_SKILLS(
    request(`http://localhost/api/skills?user=${alice}`, bobKey),
  );
  assert.equal(mismatched.status, 200);
  const mismatchedIds = (await mismatched.json()).map((skill: { id: string }) => skill.id);
  assert.equal(mismatchedIds.includes(privateSkillId), false);
});

test('匿名读取公开 Skill 版本时不会返回其他用户执行内容', async () => {
  await prisma.execution.create({
    data: {
      id: `public-execution-${suffix}`,
      taskId: `public-task-${suffix}`,
      user: alice,
      skill: `public-${suffix}`,
      skillVersion: 0,
      query: 'private input',
      finalResult: 'private output',
    },
  });
  const response = await GET_VERSIONS(
    new NextRequest(`http://localhost/api/skills/${publicSkillId}/versions`),
    { params: Promise.resolve({ id: publicSkillId }) },
  );
  assert.equal(response.status, 200);
  const versions = await response.json();
  assert.equal(versions[0].usage.calls7d, 0);
  assert.equal(versions[0].usage.successRate, null);
});

test('Trace 读取范围不接受仅凭 user 参数伪造身份', async () => {
  assert.deepEqual(
    await resolveTraceReadScope(request(`http://localhost/api/observe/data?user=${alice}`)),
    { username: null, user: undefined, canViewAllTraces: false },
  );
});

test('Trace 写操作拒绝以其他用户身份删除记录', async () => {
  const execution = await prisma.execution.create({
    data: {
      id: `private-trace-${suffix}`,
      taskId: `private-task-${suffix}`,
      user: alice,
    },
  });
  const denied = await DELETE_TRACE(request('http://localhost/api/observe/data', bobKey, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_id: execution.id }),
  }));
  assert.equal(denied.status, 403);

  const deleted = await DELETE_TRACE(request('http://localhost/api/observe/data', aliceKey, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ upload_id: execution.id }),
  }));
  assert.equal(deleted.status, 200);
  assert.equal(await prisma.execution.count({ where: { id: execution.id } }), 0);
});

test('数据集入口在缺少有效 Key 时失败关闭', async () => {
  const [{ GET }, { GET: GET_DATASET }] = await Promise.all([
    import('@/app/api/experiments/route'),
    import('@/app/api/agent-datasets/route'),
  ]);
  const [experiments, datasets] = await Promise.all([
    GET(request(`http://localhost/api/experiments?user=${alice}`)),
    GET_DATASET(request(`http://localhost/api/agent-datasets?user=${alice}`)),
  ]);
  assert.equal(experiments.status, 401);
  assert.equal(datasets.status, 401);
});

test('浏览器 API 请求自动携带本地 API Key，外部 URL 不泄露 Key', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalFetch = globalThis.fetch;
  const headers: Headers[] = [];

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://agent-insight.example' } },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key: string) => key === 'api_key' ? aliceKey : null },
  });
  globalThis.fetch = async (_input, init) => {
    headers.push(new Headers(init?.headers));
    return Response.json({});
  };

  try {
    const { apiFetch } = await import('@/lib/client/api');
    await apiFetch('/api/skills?user=alice');
    await apiFetch('/api/auth/apikey', { method: 'POST' });
    await apiFetch('https://external.example/collect');
    assert.equal(headers[0].get('x-witty-api-key'), aliceKey);
    assert.equal(headers[1].has('x-witty-api-key'), false);
    assert.equal(headers[2].has('x-witty-api-key'), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else delete (globalThis as { window?: unknown }).window;
    if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
