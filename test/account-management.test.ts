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
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-insight-accounts-'));
process.env.AGENT_INSIGHT_HOME = testHome;
const testDbPath = path.join(testHome, 'witty_insight.db');
fs.closeSync(fs.openSync(testDbPath, 'w'));
process.env.DATABASE_URL = 'file:' + testDbPath;
execFileSync(
  process.execPath,
  [path.resolve(__dirname, '../node_modules/prisma/build/index.js'), 'db', 'push', '--skip-generate'],
  { cwd: path.resolve(__dirname, '..'), env: process.env, stdio: 'ignore' },
);

const suffix = `${Date.now()}-${process.pid}`;
const adminName = `account-admin-${suffix}`;
const userName = `account-user-${suffix}`;
const adminKey = `wi_admin_${suffix}`;
const userKey = `wi_user_${suffix}`;
const adminPassword = 'AdminPassword123';
const userPassword = 'UserPassword123';

let routes: {
  login: (request: Request) => Promise<Response>;
  list: (request: Request) => Promise<Response>;
  create: (request: Request) => Promise<Response>;
  batch: (request: Request) => Promise<Response>;
  session: (request: Request) => Promise<Response>;
  reset: (request: Request, context: { params: Promise<{ username: string }> }) => Promise<Response>;
  remove: (request: Request, context: { params: Promise<{ username: string }> }) => Promise<Response>;
  changePassword: (request: Request) => Promise<Response>;
};
let prisma: typeof import('@/lib/storage/prisma').prisma;
let db: typeof import('@/lib/storage/prisma').db;
let hashPassword: typeof import('@/lib/auth/password').hashPassword;
let verifyPassword: typeof import('@/lib/auth/password').verifyPassword;
let resetLoginRateLimits: typeof import('@/lib/auth/login-rate-limit').resetLoginRateLimits;
let validateAccountUsername: typeof import('@/lib/auth/local-user').validateAccountUsername;
let normalizeAccountUsername: typeof import('@/lib/auth/local-user').normalizeAccountUsername;
const previousAdmins = process.env.AGENT_INSIGHT_ADMIN_USERS;

function requestWithKey(url: string, apiKey: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), 'x-witty-api-key': apiKey },
  });
}

function requestWithSetupToken(url: string, token: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), 'x-witty-password-token': token },
  });
}

function loginBody(username: string, password?: string, ip = '10.0.1.1'): Request {
  return new Request('http://localhost/api/auth/apikey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(password === undefined ? { username } : { username, password }),
  });
}

function loginWithKeyBody(username: string, apiKey: string): Request {
  return new Request('http://localhost/api/auth/apikey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-witty-api-key': apiKey },
    body: JSON.stringify({ username }),
  });
}

async function login(username: string, password?: string): Promise<Response> {
  return routes.login(loginBody(username, password));
}

async function changePasswordWithSetupToken(token: string, newPassword: string): Promise<Response> {
  return routes.changePassword(requestWithSetupToken('http://localhost/api/auth/password', token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword }),
  }));
}

test.before(async () => {
  process.env.AGENT_INSIGHT_ADMIN_USERS = adminName;
  const [loginRoute, listRoute, changePasswordRoute, prismaModule, passwordModule, rateLimitModule, localUserModule] =
    await Promise.all([
      import('@/app/api/auth/apikey/route'),
      import('@/app/api/admin/accounts/route'),
      import('@/app/api/auth/password/route'),
      import('@/lib/storage/prisma'),
      import('@/lib/auth/password'),
      import('@/lib/auth/login-rate-limit'),
      import('@/lib/auth/local-user'),
    ]);
  const resetRoute = await import('@/app/api/admin/accounts/[username]/reset-password/route');
  const removeRoute = await import('@/app/api/admin/accounts/[username]/route');
  const batchRoute = await import('@/app/api/admin/accounts/batch/route');
  const sessionRoute = await import('@/app/api/auth/session/route');

  routes = {
    login: loginRoute.POST,
    list: listRoute.GET,
    create: listRoute.POST,
    batch: batchRoute.POST,
    session: sessionRoute.GET,
    reset: resetRoute.POST,
    remove: removeRoute.DELETE,
    changePassword: changePasswordRoute.POST,
  };
  prisma = prismaModule.prisma;
  db = prismaModule.db;
  hashPassword = passwordModule.hashPassword;
  verifyPassword = passwordModule.verifyPassword;
  resetLoginRateLimits = rateLimitModule.resetLoginRateLimits;
  validateAccountUsername = localUserModule.validateAccountUsername;
  normalizeAccountUsername = localUserModule.normalizeAccountUsername;

  await prisma.user.create({
    data: {
      username: adminName,
      apiKey: adminKey,
      passwordHash: await hashPassword(adminPassword),
      passwordUpdatedAt: new Date(),
    },
  });
  await prisma.user.create({
    data: {
      username: userName,
      apiKey: userKey,
      passwordHash: await hashPassword(userPassword),
      passwordUpdatedAt: new Date(),
    },
  });
});

test.after(async () => {
  if (previousAdmins === undefined) delete process.env.AGENT_INSIGHT_ADMIN_USERS;
  else process.env.AGENT_INSIGHT_ADMIN_USERS = previousAdmins;

  await prisma.user.deleteMany({ where: { username: { in: [adminName, userName] } } });
  for (const prefix of ['created-', 'batch-', 'reset-', 'deleted-', 'change-', 'setup-', 'legacy-']) {
    await prisma.user.deleteMany({ where: { username: { startsWith: prefix } } });
  }
  await prisma.$disconnect();
  fs.rmSync(testHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  resetLoginRateLimits();
});

test('账号列表只允许管理员访问，且不返回凭据', async () => {
  const anonymous = await routes.list(new Request('http://localhost/api/admin/accounts'));
  assert.equal(anonymous.status, 401);

  const normal = await routes.list(requestWithKey('http://localhost/api/admin/accounts', userKey));
  assert.equal(normal.status, 403);

  const admin = await routes.list(requestWithKey('http://localhost/api/admin/accounts', adminKey));
  assert.equal(admin.status, 200);
  const body = await admin.json();
  assert.ok(Array.isArray(body.accounts));
  const row = body.accounts.find((account: any) => account.username === userName);
  assert.ok(row);
  assert.equal(row.hasPassword, true);
  assert.equal(row.disabled, false);
  assert.equal('apiKey' in row, false);
  assert.equal('passwordHash' in row, false);
});

test('新建账号使用随机一次性激活凭据，首次登录只发改密凭据，重复账号被拒绝', async () => {
  const username = `created-${suffix}@example.com`;
  const response = await routes.create(requestWithKey('http://localhost/api/admin/accounts', adminKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  }));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.username, username);
  assert.equal(typeof body.initialPassword, 'string');
  assert.ok(body.initialPassword.length >= 8);
  assert.notEqual(body.initialPassword, username);

  const created = await prisma.user.findUnique({ where: { username } });
  assert.equal(await verifyPassword(body.initialPassword, created?.passwordHash), true);
  assert.equal(await verifyPassword(username, created?.passwordHash), false);
  assert.equal(created?.mustChangePassword, true);
  assert.ok(created?.passwordUpdatedAt);

  const loginResponse = await routes.login(loginBody(username, body.initialPassword));
  assert.equal(loginResponse.status, 200);
  const loginBodyJson = await loginResponse.json();
  assert.equal(loginBodyJson.passwordInitialized, true);
  assert.equal(loginBodyJson.passwordChangeRequired, true);
  assert.equal(typeof loginBodyJson.passwordSetupToken, 'string');
  assert.equal('apiKey' in loginBodyJson, false);

  const wrongPassword = await routes.login(loginBody(username, username));
  assert.equal(wrongPassword.status, 401);

  const duplicate = await routes.create(requestWithKey('http://localhost/api/admin/accounts', adminKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  }));
  assert.equal(duplicate.status, 409);
});

test('改密凭据只能设置新密码，设置完成后才返回正式 API Key', async () => {
  const username = `created-token-${suffix}@example.com`;
  const createResponse = await routes.create(requestWithKey('http://localhost/api/admin/accounts', adminKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  }));
  const { initialPassword } = await createResponse.json();
  const loginResponse = await routes.login(loginBody(username, initialPassword));
  const { passwordSetupToken } = await loginResponse.json();
  assert.ok(passwordSetupToken);
  const created = await prisma.user.findUnique({ where: { username } });
  assert.ok(created?.apiKey);

  // 改密凭据不能访问业务或管理接口。
  const denied = await routes.list(requestWithKey('http://localhost/api/admin/accounts', passwordSetupToken));
  assert.equal(denied.status, 401);

  const session = await routes.session(
    requestWithSetupToken('http://localhost/api/auth/session', passwordSetupToken),
  );
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), {
    username,
    isAdmin: false,
    passwordChangeRequired: true,
    passwordInitialized: true,
  });

  const changed = await changePasswordWithSetupToken(passwordSetupToken, 'FinalPassword123');
  assert.equal(changed.status, 200);
  const changedBody = await changed.json();
  assert.equal(changedBody.ok, true);
  assert.equal(changedBody.apiKey, created.apiKey);

  // 已改密的凭据不能继续当会话凭据。
  const expired = await routes.session(
    requestWithSetupToken('http://localhost/api/auth/session', passwordSetupToken),
  );
  assert.equal(expired.status, 401);

  const finalLogin = await routes.login(loginBody(username, 'FinalPassword123'));
  assert.equal(finalLogin.status, 200);
  const finalBody = await finalLogin.json();
  assert.equal(finalBody.apiKey, created.apiKey);
  assert.equal(finalBody.passwordChangeRequired, false);
});

test('批量导入创建账号并返回一次性激活凭据，跳过重复与非法账号', async () => {
  const batchUser = `batch-${suffix}@example.com`;
  const batchSecond = `batch-second-${suffix}`;
  const invalid = `batch-invalid-${suffix}@bad`;
  const response = await routes.batch(requestWithKey('http://localhost/api/admin/accounts/batch', adminKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [batchUser, batchSecond, invalid, `  ${batchUser}  `] }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.created.map((entry: any) => entry.username), [batchUser, batchSecond]);
  assert.deepEqual(body.skipped, [{ username: invalid, reason: 'invalid' }]);
  for (const entry of body.created) {
    assert.equal(typeof entry.initialPassword, 'string');
    assert.ok(entry.initialPassword.length >= 8);
  }

  const created = await prisma.user.findMany({
    where: { username: { in: [batchUser, batchSecond] } },
    orderBy: { username: 'asc' },
  });
  assert.equal(created.length, 2);
  for (const row of created) {
    const credential = body.created.find((entry: any) => entry.username === row.username);
    assert.equal(await verifyPassword(credential.initialPassword, row.passwordHash), true);
    assert.equal(row.mustChangePassword, true);
  }

  const repeated = await routes.batch(requestWithKey('http://localhost/api/admin/accounts/batch', adminKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [batchUser] }),
  }));
  assert.equal(repeated.status, 200);
  assert.deepEqual((await repeated.json()).skipped, [{ username: batchUser, reason: 'exists' }]);

  const nonAdmin = await routes.batch(requestWithKey('http://localhost/api/admin/accounts/batch', userKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usernames: [`batch-denied-${suffix}`] }),
  }));
  assert.equal(nonAdmin.status, 403);
});

test('账号名只接受邮箱或受限的普通账号字符', () => {
  for (const username of ['alice@example.com', 'alice.smith-1', '用户_1', 'team-01']) {
    assert.equal(validateAccountUsername(normalizeAccountUsername(username)), null, username);
  }
  for (const username of [
    'foo bar',
    'foo\tbar',
    'foo\nbar',
    'foo$bar',
    'foo|bar',
    'foo,bar',
    'foo@bar',
    'foo/bar',
    'foo\u0000bar',
  ]) {
    assert.ok(validateAccountUsername(normalizeAccountUsername(username)), username);
  }
});

test('新建账号拒绝内部空白与控制字符', async () => {
  for (const username of ['bad name', 'bad$name', 'bad|name']) {
    const response = await routes.create(requestWithKey('http://localhost/api/admin/accounts', adminKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    }));
    assert.equal(response.status, 400, username);
  }
});

test('历史混合大小写账号可按归一化用户名查找', async () => {
  const mixed = `Legacy-Case-${suffix}`;
  await prisma.user.create({ data: { username: mixed, apiKey: `wi_${suffix}_case` } });
  try {
    assert.equal((await db.findUserByUsername(mixed))?.username, mixed);
    assert.equal((await db.findUserByUsername(mixed.toLowerCase()))?.username, mixed);
  } finally {
    await prisma.user.deleteMany({ where: { username: mixed } });
  }
});

test('创建管理员白名单中的账号需要先确认', async () => {
  const username = `created-admin-${suffix}`;
  process.env.AGENT_INSIGHT_ADMIN_USERS = `${adminName},${username}`;

  const unconfirmed = await routes.create(requestWithKey('http://localhost/api/admin/accounts', adminKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  }));
  assert.equal(unconfirmed.status, 409);
  assert.equal((await unconfirmed.json()).code, 'admin_confirmation_required');

  const confirmed = await routes.create(requestWithKey('http://localhost/api/admin/accounts', adminKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, acknowledgeAdmin: true }),
  }));
  assert.equal(confirmed.status, 201);
  const confirmedBody = await confirmed.json();
  assert.equal(confirmedBody.adminGranted, true);
  assert.equal(typeof confirmedBody.initialPassword, 'string');
});

test('重置密码直接设置新密码，旧密码立即失效，登录只发改密凭据', async () => {
  const resetUser = `reset-${suffix}`;
  const resetKey = `wi_reset_${suffix}`;
  const oldPassword = 'ResetPassword123';
  const newPassword = 'ResetPassword456';
  const finalPassword = 'ResetPassword789';
  await prisma.user.create({
    data: {
      username: resetUser,
      apiKey: resetKey,
      passwordHash: await hashPassword(oldPassword),
      passwordUpdatedAt: new Date(),
    },
  });

  const resetRequest = (password: string) => routes.reset(
    requestWithKey(`http://localhost/api/admin/accounts/${encodeURIComponent(resetUser)}/reset-password`, adminKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),
    { params: Promise.resolve({ username: resetUser }) },
  );

  const weak = await resetRequest('short');
  assert.equal(weak.status, 400);

  const response = await resetRequest(newPassword);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { username: resetUser });

  const resetRow = await prisma.user.findUnique({ where: { username: resetUser } });
  assert.equal(await verifyPassword(newPassword, resetRow?.passwordHash), true);
  assert.equal(await verifyPassword(oldPassword, resetRow?.passwordHash), false);
  assert.equal(resetRow?.mustChangePassword, true);

  const oldLogin = await login(resetUser, oldPassword);
  assert.equal(oldLogin.status, 401);

  const newLogin = await login(resetUser, newPassword);
  assert.equal(newLogin.status, 200);
  const body = await newLogin.json();
  assert.equal(body.passwordInitialized, true);
  assert.equal(body.passwordChangeRequired, true);
  assert.equal(typeof body.passwordSetupToken, 'string');
  assert.equal('apiKey' in body, false);

  const changed = await changePasswordWithSetupToken(body.passwordSetupToken, finalPassword);
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).apiKey, resetKey);

  const finalLogin = await login(resetUser, finalPassword);
  assert.equal(finalLogin.status, 200);
  assert.equal((await finalLogin.json()).apiKey, resetKey);
});

test('停用账号仅管理员可用，且不能停用当前登录账号', async () => {
  const target = `deleted-${suffix}`;
  const oldKey = `wi_deleted_${suffix}`;
  await prisma.user.create({
    data: { username: target, apiKey: oldKey },
  });

  const remove = (apiKey: string, username: string) => routes.remove(
    requestWithKey(`http://localhost/api/admin/accounts/${encodeURIComponent(username)}`, apiKey, {
      method: 'DELETE',
    }),
    { params: Promise.resolve({ username }) },
  );

  const anonymous = await routes.remove(
    new Request(`http://localhost/api/admin/accounts/${encodeURIComponent(target)}`, { method: 'DELETE' }),
    { params: Promise.resolve({ username: target }) },
  );
  assert.equal(anonymous.status, 401);

  assert.equal((await remove(userKey, target)).status, 403);
  assert.equal((await remove(adminKey, adminName)).status, 400);

  const response = await remove(adminKey, target);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.username, target);
  assert.equal(body.disabled, true);
  assert.ok(body.disabledAt);

  const row = await prisma.user.findUnique({ where: { username: target } });
  assert.ok(row);
  assert.ok(row?.disabledAt);
  assert.notEqual(row?.apiKey, oldKey);
  assert.equal(await db.findUserByApiKey(oldKey), null);

  assert.equal((await login(target, undefined)).status, 401);
  assert.equal((await remove(adminKey, target)).status, 409);

  const recreate = await routes.create(requestWithKey('http://localhost/api/admin/accounts', adminKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: target }),
  }));
  assert.equal(recreate.status, 409);
});

test('停用账号保留用户名与历史业务数据，历史归属不变', async () => {
  const target = `deleted-data-${suffix}`;
  const taskId = `task-${suffix}`;
  const skillName = `skill-${suffix}`;
  await prisma.user.create({ data: { username: target, apiKey: `wi_${suffix}_data` } });
  await prisma.session.create({ data: { taskId, user: target } });
  await prisma.skill.create({ data: { name: skillName, user: target } });

  try {
    const response = await routes.remove(
      requestWithKey(`http://localhost/api/admin/accounts/${encodeURIComponent(target)}`, adminKey, {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ username: target }) },
    );
    assert.equal(response.status, 200);
    const row = await prisma.user.findUnique({ where: { username: target } });
    assert.ok(row?.disabledAt);
    assert.equal(await prisma.session.count({ where: { taskId, user: target } }), 1);
    assert.equal(await prisma.skill.count({ where: { name: skillName, user: target } }), 1);

    const recreate = await routes.create(requestWithKey('http://localhost/api/admin/accounts', adminKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: target }),
    }));
    assert.equal(recreate.status, 409);
  } finally {
    await prisma.session.deleteMany({ where: { taskId } });
    await prisma.skill.deleteMany({ where: { name: skillName } });
  }
});

test('修改密码需要原密码且 API Key 保持不变', async () => {
  const changeUser = `change-${suffix}`;
  const changeKey = `wi_change_${suffix}`;
  const changePassword = 'ChangePassword123';
  await prisma.user.create({
    data: {
      username: changeUser,
      apiKey: changeKey,
      passwordHash: await hashPassword(changePassword),
      passwordUpdatedAt: new Date(),
    },
  });

  const wrong = await routes.changePassword(requestWithKey('http://localhost/api/auth/password', changeKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'wrong-current', newPassword: 'NewPassword123' }),
  }));
  assert.equal(wrong.status, 400);

  const success = await routes.changePassword(requestWithKey('http://localhost/api/auth/password', changeKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword: changePassword, newPassword: 'NewPassword123' }),
  }));
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { ok: true });

  const oldLogin = await login(changeUser, changePassword);
  assert.equal(oldLogin.status, 401);

  const newLogin = await login(changeUser, 'NewPassword123');
  assert.equal(newLogin.status, 200);
  const body = await newLogin.json();
  assert.equal(body.apiKey, changeKey);
  assert.equal(body.passwordChangeRequired, false);
});

test('未设置密码的存量账号仅凭用户名不能登录，凭已有 Key 设密后才拿到正式 Key', async () => {
  const setupUser = `setup-${suffix}`;
  const setupKey = `wi_setup_${suffix}`;
  await prisma.user.create({
    data: {
      username: setupUser,
      apiKey: setupKey,
    },
  });

  // 仅凭用户名不再换取正式 API Key。
  const usernameOnly = await login(setupUser);
  assert.equal(usernameOnly.status, 401);

  // 浏览器或 Agent 已持有的旧 Key 仍可用，但改密前只换到改密凭据。
  const restored = await routes.login(loginWithKeyBody(setupUser, setupKey));
  assert.equal(restored.status, 200);
  const restoredBody = await restored.json();
  assert.equal(restoredBody.passwordChangeRequired, true);
  assert.equal(restoredBody.passwordInitialized, false);
  assert.equal(typeof restoredBody.passwordSetupToken, 'string');
  assert.equal('apiKey' in restoredBody, false);

  const restoredSession = await routes.session(
    requestWithSetupToken('http://localhost/api/auth/session', restoredBody.passwordSetupToken),
  );
  assert.equal(restoredSession.status, 200);
  assert.equal((await restoredSession.json()).passwordChangeRequired, true);

  const response = await changePasswordWithSetupToken(restoredBody.passwordSetupToken, 'SetupPassword123');
  assert.equal(response.status, 200);
  const changedBody = await response.json();
  assert.equal(changedBody.apiKey, setupKey);

  const row = await prisma.user.findUnique({ where: { username: setupUser } });
  assert.equal(await verifyPassword('SetupPassword123', row?.passwordHash), true);
  assert.equal(row?.mustChangePassword, false);
  // 既有 Key 不变，Agent 上报不受影响。
  assert.equal((await db.findUserByApiKey(setupKey))?.username, setupUser);

  const loginResponse = await login(setupUser, 'SetupPassword123');
  assert.equal(loginResponse.status, 200);
  assert.equal((await loginResponse.json()).passwordInitialized, true);
});

test('未设置密码的账号恢复会话时仍要求设置密码', async () => {
  const sessionUser = `setup-session-${suffix}`;
  const sessionKey = `wi_setup_session_${suffix}`;
  await prisma.user.create({
    data: { username: sessionUser, apiKey: sessionKey },
  });

  const response = await routes.session(
    requestWithKey('http://localhost/api/auth/session', sessionKey),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    username: sessionUser,
    isAdmin: false,
    passwordChangeRequired: true,
    passwordInitialized: false,
  });
});

test('非 standalone 模式关闭账号管理接口', async () => {
  const previousMode = process.env.LOGIN_MODE;
  process.env.LOGIN_MODE = 'idaas_oauth';
  try {
    const response = await routes.list(requestWithKey('http://localhost/api/admin/accounts', adminKey));
    assert.equal(response.status, 404);
  } finally {
    if (previousMode === undefined) delete process.env.LOGIN_MODE;
    else process.env.LOGIN_MODE = previousMode;
  }
});
