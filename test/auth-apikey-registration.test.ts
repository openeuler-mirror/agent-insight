import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-auth-registration-'));
process.env.AGENT_INSIGHT_DATA_DIR = testHome;
process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`;

let POST: (request: Request) => Promise<Response>;
let prisma: typeof import('@/lib/storage/prisma').prisma;

const suffix = `${Date.now()}-${process.pid}`;
const usernames = {
  seed: `registration-seed-${suffix}`,
  casing: `registration-case-${suffix}`,
  race: `registration-race-${suffix}@example.com`,
};

function register(username: string): Promise<Response> {
  return POST(new Request('http://localhost/api/auth/apikey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  }));
}

test.before(async () => {
  const [routeModule, prismaModule] = await Promise.all([
    import('@/app/api/auth/apikey/route'),
    import('@/lib/storage/prisma'),
  ]);
  POST = routeModule.POST;
  prisma = prismaModule.prisma;
});

test.after(async () => {
  const candidates = [
    usernames.seed,
    usernames.casing,
    usernames.casing.toUpperCase(),
    usernames.race,
  ];

  await prisma.session.deleteMany({ where: { user: { in: candidates } } });
  await prisma.execution.deleteMany({ where: { user: { in: candidates } } });
  await prisma.agentEvalDataset.deleteMany({ where: { user: { in: candidates } } });
  await prisma.registeredAgent.deleteMany({ where: { user: { in: candidates } } });
  await prisma.skill.deleteMany({ where: { user: { in: candidates } } });
  await prisma.user.deleteMany({ where: { username: { in: candidates } } });
  await prisma.$disconnect();
  fs.rmSync(testHome, { recursive: true, force: true });
});

test('首次注册会注入 Agent、Skill、数据集和 3 条 Trace 示例', async () => {
  const response = await register(usernames.seed);
  assert.equal(response.status, 200);

  const [agents, skills, versions, datasets, sessions, executions] = await Promise.all([
    prisma.registeredAgent.count({ where: { user: usernames.seed } }),
    prisma.skill.count({ where: { user: usernames.seed } }),
    prisma.skillVersion.count({ where: { Skill: { user: usernames.seed } } }),
    prisma.agentEvalDataset.count({ where: { user: usernames.seed } }),
    prisma.session.count({ where: { user: usernames.seed } }),
    prisma.execution.count({ where: { user: usernames.seed } }),
  ]);

  assert.deepEqual(
    { agents, skills, versions, datasets, sessions, executions },
    { agents: 1, skills: 1, versions: 1, datasets: 2, sessions: 3, executions: 3 },
  );
});

test('用户名大小写归一到同一用户和同一 API key', async () => {
  const first = await register(usernames.casing.toUpperCase());
  const second = await register(usernames.casing);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const firstBody = await first.json();
  const secondBody = await second.json();
  assert.equal(firstBody.username, usernames.casing);
  assert.equal(secondBody.username, usernames.casing);
  assert.equal(firstBody.apiKey, secondBody.apiKey);
  assert.equal(await prisma.user.count({ where: { username: usernames.casing } }), 1);
});

test('10 路并发首次注册全部成功并返回同一 API key', async () => {
  const responses = await Promise.all(Array.from({ length: 10 }, () => register(usernames.race)));
  assert.deepEqual(responses.map((response) => response.status), Array(10).fill(200));

  const bodies = await Promise.all(responses.map((response) => response.json()));
  assert.equal(new Set(bodies.map((body) => body.apiKey)).size, 1);
  assert.equal(await prisma.user.count({ where: { username: usernames.race } }), 1);
});

test('看起来像邮箱但格式非法的用户名返回 400', async () => {
  const response = await register(`invalid-${suffix}@domain`);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Username must be a valid email address' });
});
