/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-auth-registration-'));
process.env.AGENT_INSIGHT_HOME = testHome;
const testDbPath = path.join(testHome, "witty_insight.db");
fs.closeSync(fs.openSync(testDbPath, "w"));
process.env.DATABASE_URL = "file:" + testDbPath;
execFileSync(
  process.execPath,
  [path.resolve(__dirname, "../node_modules/prisma/build/index.js"), "db", "push", "--skip-generate"],
  { cwd: path.resolve(__dirname, ".."), env: process.env, stdio: 'ignore' },
);

let POST: (request: Request) => Promise<Response>;
let prisma: typeof import('@/lib/storage/prisma').prisma;
let hashPassword: typeof import('@/lib/auth/password').hashPassword;
let resetLoginRateLimits: typeof import('@/lib/auth/login-rate-limit').resetLoginRateLimits;

const suffix = `${Date.now()}-${process.pid}`;
const usernames = {
  active: `login-active-${suffix}@example.com`,
  uninitialized: `login-uninitialized-${suffix}@example.com`,
  mustChange: `login-must-change-${suffix}@example.com`,
  disabled: `login-disabled-${suffix}@example.com`,
  attempts: `login-attempts-${suffix}@example.com`,
  organization: `login-org-${suffix}@example.com`,
};
const idaasUsername = `Employee-UUID-${suffix}-ABCDEF`;
const password = 'CorrectHorseBattery';

function login(username: string, submittedPassword?: string): Promise<Response> {
  return POST(new Request('http://localhost/api/auth/apikey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
    body: JSON.stringify(submittedPassword === undefined
      ? { username }
      : { username, password: submittedPassword }),
  }));
}

function loginWithKey(username: string, apiKey: string): Promise<Response> {
  return POST(new Request('http://localhost/api/auth/apikey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-witty-api-key': apiKey },
    body: JSON.stringify({ username }),
  }));
}

async function withLoginMode<T>(mode: string, run: () => Promise<T>): Promise<T> {
  const previousLoginMode = process.env.LOGIN_MODE;
  const previousOrganizationMode = process.env.ORGANIZATION_MODE;
  if (mode === 'organization') {
    delete process.env.LOGIN_MODE;
    process.env.ORGANIZATION_MODE = 'true';
  } else {
    process.env.LOGIN_MODE = mode;
    delete process.env.ORGANIZATION_MODE;
  }
  try {
    return await run();
  } finally {
    if (previousLoginMode === undefined) delete process.env.LOGIN_MODE;
    else process.env.LOGIN_MODE = previousLoginMode;
    if (previousOrganizationMode === undefined) delete process.env.ORGANIZATION_MODE;
    else process.env.ORGANIZATION_MODE = previousOrganizationMode;
  }
}

test.before(async () => {
  const [routeModule, prismaModule, passwordModule, rateLimitModule] = await Promise.all([
    import('@/app/api/auth/apikey/route'),
    import('@/lib/storage/prisma'),
    import('@/lib/auth/password'),
    import('@/lib/auth/login-rate-limit'),
  ]);
  POST = routeModule.POST;
  prisma = prismaModule.prisma;
  hashPassword = passwordModule.hashPassword;
  resetLoginRateLimits = rateLimitModule.resetLoginRateLimits;

  await prisma.user.create({
    data: {
      username: usernames.active,
      apiKey: `wi_active_${suffix}`,
      passwordHash: await hashPassword(password),
      passwordUpdatedAt: new Date(),
    },
  });
  await prisma.user.create({
    data: { username: usernames.uninitialized, apiKey: `wi_uninit_${suffix}` },
  });
  await prisma.user.create({
    data: {
      username: usernames.mustChange,
      apiKey: `wi_must_change_${suffix}`,
      passwordHash: await hashPassword(password),
      passwordUpdatedAt: new Date(),
      mustChangePassword: true,
    },
  });
  await prisma.user.create({
    data: {
      username: usernames.disabled,
      apiKey: `wi_disabled_${suffix}`,
      passwordHash: await hashPassword(password),
      disabledAt: new Date(),
    },
  });
});

test.after(async () => {
  const candidates = [
    usernames.active,
    usernames.uninitialized,
    usernames.mustChange,
    usernames.disabled,
    usernames.attempts,
    usernames.organization,
    `login-reset-${suffix}@example.com`,
    idaasUsername,
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

test.beforeEach(() => {
  resetLoginRateLimits();
});

test('缺少密码时不会为不存在的用户自动创建账号', async () => {
  const response = await login(`login-missing-${suffix}@example.com`);
  assert.equal(response.status, 401);
  assert.equal(
    await prisma.user.count({ where: { username: `login-missing-${suffix}@example.com` } }),
    0,
  );
});

test('已设置密码的账号缺少密码时返回与凭据错误相同的 401', async () => {
  const missing = await login(usernames.active);
  assert.equal(missing.status, 401);

  const wrong = await login(usernames.active, 'not-the-password');
  assert.equal(wrong.status, 401);
  assert.deepEqual(await missing.json(), await wrong.json());
});

test('密码错误与用户不存在返回相同的 401 文案', async () => {
  const wrongPassword = await login(usernames.active, 'not-the-password');
  const unknownUser = await login(`login-unknown-${suffix}@example.com`, 'not-the-password');

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownUser.status, 401);
  const [wrongBody, unknownBody] = await Promise.all([wrongPassword.json(), unknownUser.json()]);
  assert.deepEqual(wrongBody, unknownBody);
});

test('正确密码返回身份、管理员标记与改密要求', async () => {
  const response = await login(usernames.active, password);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    username: usernames.active,
    apiKey: `wi_active_${suffix}`,
    isAdmin: false,
    passwordChangeRequired: false,
    passwordInitialized: true,
  });
});

test('未设置密码的账号仅凭用户名不能登录，凭已有 Key 只换到改密凭据', async () => {
  const usernameOnly = await login(usernames.uninitialized);
  assert.equal(usernameOnly.status, 401);

  const restored = await loginWithKey(usernames.uninitialized, `wi_uninit_${suffix}`);
  assert.equal(restored.status, 200);
  assert.equal(restored.headers.get('cache-control'), 'no-store');
  const body = await restored.json();
  assert.equal(body.username, usernames.uninitialized);
  assert.equal(body.isAdmin, false);
  assert.equal(body.passwordChangeRequired, true);
  assert.equal(body.passwordInitialized, false);
  assert.equal(typeof body.passwordSetupToken, 'string');
  assert.equal('apiKey' in body, false);
});

test('需要改密的账号即使密码正确也只发改密凭据', async () => {
  const response = await login(usernames.mustChange, password);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.passwordChangeRequired, true);
  assert.equal(body.passwordInitialized, true);
  assert.equal(typeof body.passwordSetupToken, 'string');
  assert.equal('apiKey' in body, false);
});

test('停用账号不能登录，旧 Key 也不再有效', async () => {
  const response = await login(usernames.disabled, password);
  assert.equal(response.status, 401);
  const { db } = await import('@/lib/storage/prisma');
  assert.equal(await db.findUserByApiKey(`wi_disabled_${suffix}`), null);
});

test('连续失败达到阈值后返回 429', async () => {
  await prisma.user.create({
    data: {
      username: usernames.attempts,
      apiKey: `wi_attempts_${suffix}`,
      passwordHash: await hashPassword(password),
    },
  });

  for (let i = 0; i < 5; i += 1) {
    const response = await login(usernames.attempts, 'wrong-password');
    assert.equal(response.status, 401);
  }
  const blocked = await login(usernames.attempts, 'wrong-password');
  assert.equal(blocked.status, 429);
  const body = await blocked.json();
  assert.equal(body.code, 'too_many_attempts');
  assert.ok(body.retryAfterSeconds > 0);

  const correct = await login(usernames.attempts, password);
  assert.equal(correct.status, 429);
});

test('成功登录会清零失败计数', async () => {
  await prisma.user.create({
    data: {
      username: `login-reset-${suffix}@example.com`,
      apiKey: `wi_reset_${suffix}`,
      passwordHash: await hashPassword(password),
    },
  });

  for (let i = 0; i < 4; i += 1) {
    await login(`login-reset-${suffix}@example.com`, 'wrong-password');
  }
  const success = await login(`login-reset-${suffix}@example.com`, password);
  assert.equal(success.status, 200);

  for (let i = 0; i < 4; i += 1) {
    const response = await login(`login-reset-${suffix}@example.com`, 'wrong-password');
    assert.equal(response.status, 401);
  }
});

test('organization 模式仍要求已有账号用原 API Key 恢复（#654）', async () => {
  await withLoginMode('organization', async () => {
    const first = await login(usernames.organization);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.username, usernames.organization);
    assert.ok(firstBody.apiKey);

    const unauthenticated = await login(usernames.organization);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).code, 'credential_required');

    const restored = await loginWithKey(usernames.organization.toUpperCase(), firstBody.apiKey);
    assert.equal(restored.status, 200);
    assert.deepEqual(await restored.json(), {
      username: usernames.organization,
      apiKey: firstBody.apiKey,
    });
  });
});

test('IDaaS 恢复登录时保持 UUID 大小写并校验已有 API key', async () => {
  const apiKey = `wi_idaas_restore_${suffix}`;
  await prisma.user.create({
    data: { username: idaasUsername, apiKey },
  });

  const previousRegionAccessEnabled = process.env.IDAAS_REGION_ACCESS_ENABLED;
  process.env.IDAAS_REGION_ACCESS_ENABLED = "false";

  try {
    await withLoginMode('idaas_oauth', async () => {
      const response = await loginWithKey(`  ${idaasUsername}  `, apiKey);

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        username: idaasUsername,
        apiKey,
        displayName: idaasUsername,
      });
    });
  } finally {
    if (previousRegionAccessEnabled === undefined) delete process.env.IDAAS_REGION_ACCESS_ENABLED;
    else process.env.IDAAS_REGION_ACCESS_ENABLED = previousRegionAccessEnabled;
  }
});
