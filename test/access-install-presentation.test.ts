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
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import AccessInstallPage from '@/app/(main)/accessconfig/install/page';
import { AuthProvider } from '@/lib/auth/auth-context';
import { LocaleProvider } from '@/lib/client/locale-context';
import { SidebarProvider } from '@/lib/client/sidebar-context';
import { FRAMEWORK_OPTIONS } from '@/lib/ingest/setup/install-profile';

function renderInstallPage() {
  const router = {
    back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {},
  };
  return renderToStaticMarkup(
    createElement(AppRouterContext.Provider, { value: router },
      createElement(PathnameContext.Provider, { value: '/accessconfig/install' },
        createElement(AuthProvider, null,
          createElement(LocaleProvider, null,
            createElement(SidebarProvider, null, createElement(AccessInstallPage)),
          ),
        ),
      ),
    ),
  );
}

test('安装页展示 Linux 和 Windows 安装命令卡，不展示相关文档卡', () => {
  const html = renderInstallPage();
  assert.ok(/>Linux<\//.test(html), '应展示 Linux 命令卡');
  assert.match(html, />Windows \(PowerShell\)<\//, '应展示 Windows 命令卡');
  assert.ok(!/相关文档|客户端高级配置|常见接入问题排查/.test(html), '不应展示相关文档卡');
  assert.match(html, /命令已包含当前账号的 API Key/);
});

test('安装页保留 master 的框架选择、专用接入信息和身份刷新提示', () => {
  const html = renderInstallPage();
  for (const framework of FRAMEWORK_OPTIONS) assert.ok(html.includes(framework.label));
  assert.match(html, /选择要接入的框架/);
  assert.match(html, /LangChain \/ LangGraph 接入/);
  assert.match(html, /LlamaIndex Trace Collector/);
  assert.match(html, /import agent_insight_llamaindex/);
  assert.match(html, /当前上报通道/);
  assert.match(html, /页面会先向服务端刷新并验证当前登录身份/);
  const cards = html.match(/<article\b[\s\S]*?<\/article>/g) || [];
  for (const label of ['Linux', 'Windows (PowerShell)']) {
    const card = cards.find(item => item.includes(`>${label}</`));
    assert.ok(card, `应保留 ${label} 命令卡`);
    assert.ok(card.includes('加载中…'));
    assert.ok(!card.includes('<button'), '身份未就绪时不提供可复制的安装命令');
  }
});
