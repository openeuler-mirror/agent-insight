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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAgentInsightHome } from '@/lib/env';

// 改密前的登录凭据只用于设置新密码：短时、单用途、由服务端签发和校验，
// 不能当作业务 API Key 使用。
// v2 起绑定账号的密码版本（passwordUpdatedAt），管理员重置或用户改密后旧凭据立即失效。
const TOKEN_VERSION = 'v2';
export const PASSWORD_SETUP_TOKEN_TTL_MS = 15 * 60 * 1000;
const SECRET_FILE = '.password_setup_secret';

export interface PasswordSetupToken {
  username: string;
  passwordVersion: number;
}

// 以 passwordUpdatedAt 作为密码版本；未设置密码的账号为 0，设置密码后必然变化。
export function passwordVersionOf(user: { passwordUpdatedAt?: Date | string | null } | null | undefined): number {
  const value = user?.passwordUpdatedAt;
  if (!value) return 0;
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(time) ? time : 0;
}

let cachedSecret: Buffer | null = null;

function readSecretFile(filePath: string): Buffer | null {
  try {
    const value = fs.readFileSync(filePath, 'utf8').trim();
    return value ? Buffer.from(value, 'base64url') : null;
  } catch {
    return null;
  }
}

function getSecret(): Buffer {
  const configured = String(process.env.AGENT_INSIGHT_SESSION_SECRET || '').trim();
  if (configured) return Buffer.from(configured, 'utf8');
  if (cachedSecret) return cachedSecret;

  const filePath = path.join(getAgentInsightHome(), SECRET_FILE);
  const stored = readSecretFile(filePath);
  if (stored) {
    cachedSecret = stored;
    return stored;
  }

  const generated = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, generated.toString('base64url'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    cachedSecret = generated;
    return generated;
  } catch {
    // 并发启动时另一方已写入，读取那一份，保证同一实例内签发的 token 可校验。
    cachedSecret = readSecretFile(filePath) || generated;
    return cachedSecret;
  }
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
}

export function createPasswordSetupToken(username: string, passwordVersion: number, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({
    v: TOKEN_VERSION,
    u: username,
    pv: passwordVersion,
    exp: now + PASSWORD_SETUP_TOKEN_TTL_MS,
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyPasswordSetupToken(token: string | null | undefined, now = Date.now()): PasswordSetupToken | null {
  if (!token) return null;
  const [payload, signature] = String(token).split('.');
  if (!payload || !signature) return null;

  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data?.v !== TOKEN_VERSION) return null;
    if (typeof data.u !== 'string' || !data.u) return null;
    if (typeof data.pv !== 'number' || !Number.isSafeInteger(data.pv) || data.pv < 0) return null;
    if (typeof data.exp !== 'number' || data.exp <= now) return null;
    return { username: data.u, passwordVersion: data.pv };
  } catch {
    return null;
  }
}
