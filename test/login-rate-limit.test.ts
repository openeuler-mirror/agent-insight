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
import test from 'node:test';

import { loginRateLimitKey, resolveClientIp } from '@/lib/auth/login-rate-limit';

function request(headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/api/auth/apikey', { headers });
}

test('默认不信任客户端可伪造的转发头', () => {
    delete process.env.AGENT_INSIGHT_TRUST_PROXY_HEADERS;
    assert.equal(resolveClientIp(request({ 'x-forwarded-for': '1.2.3.4' })), 'unknown');
    assert.equal(resolveClientIp(request({ 'x-real-ip': '5.6.7.8' })), 'unknown');
    assert.equal(
        loginRateLimitKey(request({ 'x-forwarded-for': '1.2.3.4' }), 'Admin'),
        'unknown|admin',
    );
});

test('可信代理模式使用转发头首段并截断超长部分', () => {
    process.env.AGENT_INSIGHT_TRUST_PROXY_HEADERS = 'true';
    try {
        assert.equal(resolveClientIp(request({ 'x-forwarded-for': ' 1.2.3.4, 10.0.0.1 ' })), '1.2.3.4');
        assert.equal(resolveClientIp(request({ 'x-real-ip': ' 5.6.7.8 ' })), '5.6.7.8');
        assert.equal(resolveClientIp(request()), 'unknown');
        assert.equal(resolveClientIp(request({ 'x-forwarded-for': 'a'.repeat(300) })).length, 128);
        assert.equal(
            loginRateLimitKey(request(), 'U'.repeat(300)),
            `unknown|${'u'.repeat(128)}`,
        );
    } finally {
        delete process.env.AGENT_INSIGHT_TRUST_PROXY_HEADERS;
    }
});

test('显式关闭可信代理时忽略转发头', () => {
    process.env.AGENT_INSIGHT_TRUST_PROXY_HEADERS = 'false';
    try {
        assert.equal(resolveClientIp(request({ 'x-forwarded-for': '1.2.3.4' })), 'unknown');
    } finally {
        delete process.env.AGENT_INSIGHT_TRUST_PROXY_HEADERS;
    }
});
