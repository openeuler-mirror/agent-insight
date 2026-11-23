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

import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';

export interface ProxyConfig {
  customFetch: typeof fetch | undefined;
  proxyUrl: string | undefined;
  rejectUnauthorized: boolean;
  getRoute: (url: RequestInfo | URL) => ProxyRoute;
}

export interface ProxyRoute {
  mode: 'direct' | 'proxy';
  env?: string;
  proxyUrl?: string;
  bypassed: boolean;
  noProxyConfigured: boolean;
  rejectUnauthorized: boolean;
}

let cachedProxyConfig: ProxyConfig | null = null;

export function getProxyConfig(): ProxyConfig {
  if (cachedProxyConfig) {
    return cachedProxyConfig;
  }

  const proxyEnv = ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY'].find(name => process.env[name]);
  const proxyUrl = proxyEnv ? process.env[proxyEnv] : undefined;

  const rejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0';
  let customFetch: typeof fetch | undefined = undefined;
  const noProxy = process.env.no_proxy || process.env.NO_PROXY;
  const noProxyList = noProxy ? noProxy.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
  const getRoute = (url: RequestInfo | URL): ProxyRoute => {
    let bypassed = false;
    if (proxyUrl && noProxyList.length) {
      try {
        const host = new URL(url.toString()).hostname.toLowerCase();
        bypassed = noProxyList.some(pattern => pattern === '*' || host === pattern ||
          (pattern.startsWith('.') ? host.endsWith(pattern) : host.endsWith('.' + pattern)));
      } catch { /* Invalid URLs retain the existing proxy fallback. */ }
    }
    return { mode: proxyUrl && !bypassed ? 'proxy' : 'direct', env: proxyEnv, proxyUrl,
      bypassed, noProxyConfigured: noProxyList.length > 0, rejectUnauthorized };
  };

  if (proxyUrl) {
    console.log('[ProxyConfig] HTTP proxy configured (URL hidden for privacy)');
    
    if (rejectUnauthorized === false) {
      console.log('[ProxyConfig] SSL certificate verification is disabled');
    }

    const proxyAgent = new ProxyAgent({
      uri: proxyUrl,
      connect: {
        rejectUnauthorized
      }
    });

    const fallbackAgent = new Agent({
      connect: { rejectUnauthorized }
    });

    customFetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      return undiciFetch(url as any, {
        ...init as any,
        dispatcher: getRoute(url).mode === 'direct' ? fallbackAgent : proxyAgent
      });
    }) as unknown as typeof fetch;
  } else if (rejectUnauthorized === false) {
    console.log('[ProxyConfig] No proxy, but SSL certificate verification is disabled');
    const agent = new Agent({
      connect: { rejectUnauthorized: false }
    });
    customFetch = ((url: RequestInfo | URL, init?: RequestInit) => {
      return undiciFetch(url as any, {
        ...init as any,
        dispatcher: agent
      });
    }) as unknown as typeof fetch;
  }

  cachedProxyConfig = {
    customFetch,
    proxyUrl,
    rejectUnauthorized,
    getRoute,
  };

  return cachedProxyConfig;
}

export function resetProxyConfigCache() {
  cachedProxyConfig = null;
}
