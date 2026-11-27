import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function credentialSuffix(ctx, username) {
  return createHash('sha256').update(`${ctx.runId}:${username}`).digest('hex').slice(0, 12);
}

export async function readAdminApiKey(appHome, timeoutMs = 15000) {
  const keyPath = path.join(appHome, '.admin_api_key');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const apiKey = fs.readFileSync(keyPath, 'utf8').trim();
      if (apiKey) return apiKey;
    } catch {
      // instrumentation 尚未写完文件，继续轮询。
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`admin API key file was not ready: ${keyPath}`);
}

async function adminFetch(ctx, route, init = {}) {
  const apiKey = await readAdminApiKey(ctx.appHome);
  return fetch(ctx.baseUrl + route, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-witty-api-key': apiKey,
      ...init.headers,
    },
  });
}

export async function prepareAccount(ctx, username) {
  const suffix = credentialSuffix(ctx, username);
  const initialPassword = `E2eTemp-${suffix}`;
  const finalPassword = `E2eFinal-${suffix}`;
  assert.ok(initialPassword.length >= 8 && finalPassword.length >= 8);
  assert.notEqual(initialPassword, username);

  const created = await adminFetch(ctx, '/api/admin/accounts', {
    method: 'POST',
    body: JSON.stringify({ username, password: initialPassword }),
  });
  if (created.status === 409) {
    const reset = await adminFetch(ctx, `/api/admin/accounts/${encodeURIComponent(username)}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password: initialPassword }),
    });
    assert.equal(reset.status, 200, `Unable to reset test account ${username}: ${reset.status}`);
  } else {
    assert.equal(created.status, 201, `Unable to create test account ${username}: ${created.status}`);
  }
  return { username, initialPassword, finalPassword };
}

async function completeFirstLogin(ctx, prepared) {
  const login = await fetch(ctx.baseUrl + '/api/auth/apikey', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: prepared.username, password: prepared.initialPassword }),
  });
  assert.equal(login.status, 200, `Login failed for ${prepared.username}: ${login.status}`);
  const pending = await login.json();
  assert.equal(pending.passwordChangeRequired, true);
  assert.equal(typeof pending.passwordSetupToken, 'string');
  assert.equal('apiKey' in pending, false, 'First login must not issue the formal API key');

  const changed = await fetch(ctx.baseUrl + '/api/auth/password', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-witty-password-token': pending.passwordSetupToken,
    },
    body: JSON.stringify({ newPassword: prepared.finalPassword }),
  });
  assert.equal(changed.status, 200, `Password change failed for ${prepared.username}: ${changed.status}`);
  const body = await changed.json();
  assert.ok(body.apiKey, 'Password change must return the formal API key');
  return { username: prepared.username, apiKey: body.apiKey, password: prepared.finalPassword };
}

export async function ensureAccount(ctx, username) {
  const prepared = await prepareAccount(ctx, username);
  const account = await completeFirstLogin(ctx, prepared);
  ctx.secrets.push(prepared.initialPassword, prepared.finalPassword, account.apiKey);
  return account;
}

export async function loginThroughUi(ctx, page, username) {
  const prepared = await prepareAccount(ctx, username);
  ctx.secrets.push(prepared.initialPassword, prepared.finalPassword);

  await page.goto(ctx.baseUrl + '/login');
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(prepared.initialPassword);
  const loginResponse = page.waitForResponse(
    r => r.url().endsWith('/api/auth/apikey') && r.request().method() === 'POST',
  );
  await page.locator('button[type=submit]').click();
  const login = await loginResponse;
  assert.equal(login.status(), 200);
  const pending = await login.json();
  assert.equal(pending.passwordChangeRequired, true);
  assert.equal(typeof pending.passwordSetupToken, 'string');
  assert.equal('apiKey' in pending, false, 'Browser login must not receive the formal API key before password change');

  await page.waitForURL(url => url.pathname.endsWith('/config/password'));
  await page.locator('#new-password').fill(prepared.finalPassword);
  await page.locator('#confirm-password').fill(prepared.finalPassword);
  const changedResponse = page.waitForResponse(
    r => r.url().endsWith('/api/auth/password') && r.request().method() === 'POST',
  );
  await page.locator('form button[type=submit]').click();
  const changed = await changedResponse;
  assert.equal(changed.status(), 200);
  const body = await changed.json();
  assert.ok(body.apiKey, 'Password change must return the formal API key');

  await page.waitForURL(url => !url.pathname.endsWith('/config/password') && !url.pathname.endsWith('/login'));
  ctx.secrets.push(body.apiKey);
  return { username, apiKey: body.apiKey, password: prepared.finalPassword };
}
