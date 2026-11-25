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

const URL_PREFIX = process.env.NEXT_PUBLIC_URL_PREFIX || '';
const API_PATH_PREFIX = '/api/';
// 登录入口不自动带上旧 Key；其余 /api 请求（含会话恢复与改密）使用本地凭据。
const NO_API_KEY_AUTH_PATHS = ['auth/apikey', 'auth/idaas-oauth'];

function isApiRequest(url: string): boolean {
  try {
    const base = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
    const target = new URL(URL_PREFIX + url, base);
    const apiRoot = new URL(`${URL_PREFIX}${API_PATH_PREFIX}`, base);
    const relativePath = target.pathname.slice(apiRoot.pathname.length);
    return target.origin === apiRoot.origin
      && target.pathname.startsWith(apiRoot.pathname)
      && !NO_API_KEY_AUTH_PATHS.some(prefix => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
  } catch {
    return false;
  }
}

export async function apiFetch(url: string, options?: RequestInit): Promise<Response> {
  const fullUrl = URL_PREFIX + url;
  const headers = new Headers(options?.headers);
  if (typeof window !== 'undefined' && isApiRequest(url) && !headers.has('x-witty-api-key')) {
    const key = localStorage.getItem('api_key');
    if (key) headers.set('x-witty-api-key', key);
  }
  return fetch(fullUrl, { ...options, headers });
}

export function getApiUrl(url: string): string {
  return URL_PREFIX + url;
}
