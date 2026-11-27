/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { randomUUID } from 'node:crypto';
import { getProxyConfig } from '@/lib/ingest/proxy-config';
import { createLogger } from '@/lib/logger';
import { sanitizeLogValue } from '@/lib/logger/server';
import { resolveModelProtocol, type ModelConnectionConfig } from '@/lib/shared/model-connection';

const logger = createLogger('ModelConnectionTest');
const MAX_ERROR_BYTES = 8192;
type Fields = Record<string, unknown>;
type ErrorCapture = { chunks: Uint8Array[]; size: number; complete: boolean; truncated: boolean };

export function createModelTestDiagnostics(config: ModelConnectionConfig, timeoutMs: number, fetcher?: typeof fetch) {
  const testId = randomUUID();
  const startedAt = Date.now();
  const secrets = new Set<string>();
  const attempts: Fields[] = [];
  let upstream: Fields | undefined;
  let capture: ErrorCapture | undefined;

  const addSecret = (value?: string) => {
    if (!value) return;
    for (const secret of [value, value.trim(), encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]) {
      if (secret) secrets.add(secret);
    }
  };
  const collectUrlSecrets = (value?: string) => {
    if (!value) return;
    try {
      const url = new URL(value);
      for (const part of [url.username, url.password]) {
        addSecret(part);
        try { addSecret(decodeURIComponent(part)); } catch {}
      }
      if (url.username || url.password) {
        addSecret(Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64'));
      }
      for (const part of url.searchParams.values()) addSecret(part);
    } catch {}
  };
  const collectHeaderSecrets = (name: string, value: string) => {
    addSecret(value);
    if (/^(?:authorization|proxy-authorization)$/i.test(name.trim())) {
      const credential = /^(Bearer|Basic)\s+(.+)$/i.exec(value.trim());
      if (credential) {
        addSecret(credential[2]);
        if (credential[1].toLowerCase() === 'basic') {
          const decoded = Buffer.from(credential[2], 'base64').toString('utf8');
          addSecret(decoded);
          const separator = decoded.indexOf(':');
          if (separator >= 0) { addSecret(decoded.slice(0, separator)); addSecret(decoded.slice(separator + 1)); }
        }
      }
    }
    if (name.trim().toLowerCase() === 'cookie') {
      for (const part of value.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0) continue;
        const token = part.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1');
        addSecret(token);
        try { addSecret(decodeURIComponent(token)); } catch {}
      }
    }
  };
  addSecret(config.apiKey);
  for (const [name, value] of Object.entries(config.headers ?? {})) collectHeaderSecrets(name, value);
  collectUrlSecrets(config.baseUrl);

  const safe = (value: unknown, limit = 2048): string | undefined => {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    let text = String(value);
    const pattern = [...secrets].sort((a, b) => b.length - a.length).map(secret => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    if (pattern) text = text.replace(new RegExp(pattern, 'g'), '[REDACTED]');
    text = String(sanitizeLogValue(text)).replace(/[\u0000-\u001f\u007f]/g, ' ');
    return text.length > limit ? text.slice(0, limit) + ' [TRUNCATED]' : text;
  };
  const endpoint = (value: string, originOnly = false) => {
    collectUrlSecrets(value);
    try {
      const url = new URL(value);
      return safe(url.origin + (originOnly ? '' : url.pathname), 1024);
    } catch { return '[invalid URL]'; }
  };

  const diagnosticFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const proxy = fetcher ? undefined : getProxyConfig();
    const route = proxy?.getRoute(input);
    collectUrlSecrets(route?.proxyUrl);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    for (const name of ['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie']) {
      const value = headers.get(name);
      if (value) collectHeaderSecrets(name, value);
    }
    const attempt: Fields = {
      endpoint: endpoint(url), method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headerNames: [...headers.keys()].sort(),
      customHeaderNames: Object.keys(config.headers ?? {}).map(name => name.trim().toLowerCase()).sort(),
      authorizationPresent: headers.has('authorization'),
      apiKeyHeaderPresent: headers.has('x-api-key') || headers.has('api-key'),
      proxy: route ? { mode: route.mode, env: route.env, endpoint: route.proxyUrl ? endpoint(route.proxyUrl, true) : undefined,
        bypassed: route.bypassed, noProxyConfigured: route.noProxyConfigured, rejectUnauthorized: route.rejectUnauthorized } : { mode: 'custom' },
    };
    attempts.push(attempt);
    const response = await (fetcher ?? proxy?.customFetch ?? globalThis.fetch)(input, init);
    attempt.upstreamStatus = response.status;
    upstream = { status: response.status, contentType: safe(response.headers.get('content-type')),
      requestId: safe(response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? response.headers.get('x-amzn-requestid')),
      authChallenge: safe(response.headers.get('www-authenticate')) };
    const observed: ErrorCapture = { chunks: [], size: 0, complete: !response.body, truncated: false };
    capture = observed;
    if (response.ok || !response.body) return response;
    // Observe bytes consumed by the SDK, without cloning/reading ahead or adding another deadline.
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        observed.size += chunk.byteLength;
        if (observed.size > MAX_ERROR_BYTES) { observed.truncated = true; observed.chunks = []; }
        else if (!observed.truncated) observed.chunks.push(chunk.slice());
        controller.enqueue(chunk);
      },
      flush() { observed.complete = true; },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  const errorDetails = (): Fields => {
    if (!upstream || !capture || Number(upstream.status) < 400) return {};
    if (capture.truncated || !capture.complete) return { bodyTruncated: capture.truncated, bodyIncomplete: !capture.complete };
    const raw = new TextDecoder().decode(Buffer.concat(capture.chunks));
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      const outer = parsed && typeof parsed === 'object' ? parsed as Fields : {};
      const inner = outer.error && typeof outer.error === 'object' ? outer.error as Fields : outer;
      return {
        ...(upstream.requestId ? {} : { requestId: safe(outer.request_id ?? outer.requestId) }),
        errorCode: safe(inner.code ?? inner.error_code ?? outer.code ?? outer.error_code, 256), errorType: safe(inner.type ?? outer.type, 256),
        reason: safe(inner.message ?? inner.msg ?? inner.detail ?? inner.error_description ?? inner.error_msg ??
          outer.message ?? outer.msg ?? outer.detail ?? outer.error_description ?? outer.error_msg ??
          (typeof outer.error === 'string' ? outer.error : typeof parsed === 'string' ? parsed : undefined)),
      };
    } catch {
      if (String(upstream.contentType).includes('json')) return { reason: '[Invalid JSON error body omitted]' };
      return { reason: safe(raw.replace(/<[^>]*>/g, ' ')) };
    }
  };

  return {
    fetch: diagnosticFetch,
    finish(result: string, error?: unknown) {
      try {
        const causeCodes: string[] = [];
        let proxyTunnelStatus: number | undefined;
        let cause = error;
        for (let depth = 0; depth < 8 && cause instanceof Error; depth++, cause = cause.cause) {
          const code = (cause as Error & { code?: unknown }).code;
          if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) causeCodes.push(safe(code, 128)!);
          const tunnel = /^Proxy response \(([1-5]\d{2})\) !== 200 when HTTP Tunneling$/.exec(cause.message);
          if (code === 'UND_ERR_ABORTED' && tunnel) proxyTunnelStatus = Number(tunnel[1]);
        }
        const context = { testId, result, elapsedMs: Date.now() - startedAt, timeoutMs,
          provider: safe(config.provider), protocol: resolveModelProtocol(config), model: safe(config.model), attempts,
          upstream: upstream ? { ...upstream, ...errorDetails() } : undefined, causeCodes, proxyTunnelStatus };
        if (result === 'success') logger.info('Model connection test completed', context);
        else logger.error('Model connection test failed', context);
      } catch { /* Diagnostics cannot change the connection test outcome. */ }
    },
  };
}
