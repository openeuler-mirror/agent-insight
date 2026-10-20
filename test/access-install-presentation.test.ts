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

test('安装页保留 Linux 和 Windows 安装命令卡，不展示相关文档卡', () => {
  const html = renderInstallPage();
  assert.ok(/>Linux<\//.test(html), '应展示 Linux 命令卡');
  assert.match(html, /Windows \(PowerShell\)/);
  assert.ok(!/相关文档|客户端高级配置|常见接入问题排查/.test(html), '不应展示相关文档卡');
  assert.match(html, /命令已包含当前账号的 API Key/);
});

test('客户安装页仅提供 OpenCode 和 Qoder，保留身份刷新与上报通道提示', () => {
  const html = renderInstallPage();
  assert.match(html, />OpenCode<\//);
  assert.match(html, />Qoder<\//);
  for (const framework of FRAMEWORK_OPTIONS) {
    if (['opencode', 'qoder'].includes(framework.value)) continue;
    assert.ok(!html.includes(framework.label), `不应展示 ${framework.label}`);
  }
  assert.match(html, /选择要接入的框架/);
  assert.doesNotMatch(html, /LangChain|LangGraph|LlamaIndex|LANGFUSE_|agent_insight_llamaindex/);
  assert.match(html, /当前上报通道/);
  assert.match(html, /页面会先向服务端刷新并验证当前登录身份/);
  const linuxCard = html.match(/<article\b[\s\S]*?<\/article>/g)?.find(card => />Linux(?: \/ macOS)?<\//.test(card));
  assert.ok(linuxCard, '应保留 Linux 命令卡');
  assert.ok(linuxCard.includes('加载中…'));
  assert.ok(!linuxCard.includes('<button'), '身份未就绪时不提供可复制的安装命令');
});

test('安装页在安装命令前提醒用户自行备份配置，不再提供自动恢复或卸载入口', () => {
  const html = renderInstallPage();
  assert.match(html, /安装前请自行备份/);
  assert.match(html, /模型地址、Hook 和插件配置/);
  assert.match(html, /不自动备份，也不提供一键恢复或卸载/);
  assert.match(html, /\.config\/opencode/);
  assert.match(html, /\.qoder-cn\/settings\.json/);
  assert.match(html, /opencode\.json/);
  assert.match(html, /\.opencode\//);
  assert.match(html, /\.qoder\//);
  assert.match(html, /\.profile/);
  assert.match(html, /\.bashrc/);
  assert.match(html, /\.zshrc/);
  assert.match(html, /Windows 用户环境变量/);
  assert.ok(html.indexOf('安装前请自行备份') < html.indexOf('>Linux</'), '备份提醒必须先于可复制安装命令');
  assert.doesNotMatch(html, /restore_inference_proxy\.sh|uninstall_client\.sh|恢复与卸载|两种操作都会保留/);
});
