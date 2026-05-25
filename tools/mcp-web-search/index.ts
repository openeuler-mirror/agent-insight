#!/usr/bin/env -S tsx

/**
 * MCP stdio server: web_search / web_fetch
 *
 * 由 opencode-server 在 playground agent 启动时通过 `mcp.local.command` 拉起；
 * 通过 stdio JSON-RPC 暴露两个工具：
 *
 *   web_search(query, max_results?=5)  → 走 Tavily 返回 [{title,url,snippet}]
 *   web_fetch(url)                     → 抓 HTML，提取正文段落
 *
 * 鉴权：环境变量 TAVILY_API_KEY，由调用方（agent-insight 主 server）从用户的
 * UserSettings.searchApiKey 注入到 opencode 的 mcp.<name>.environment 字段。
 * 没配 key 时 server 仍能启动（避免子进程 boot 失败），但工具调用会返回 isError=true。
 *
 * 故意做得极简：单文件、无构建、tsx 直跑、依赖只用 @modelcontextprotocol/sdk + zod。
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const TAVILY_API_KEY = process.env.TAVILY_API_KEY?.trim() || '';
const TAVILY_ENDPOINT = process.env.TAVILY_ENDPOINT || 'https://api.tavily.com/search';
const REQUEST_TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS || 8000);

/** 简易 timeout fetch：浏览器 / Node 18+ 都自带 AbortSignal.timeout，但显式更易调 */
async function timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

interface TavilyHit {
  title: string;
  url: string;
  content?: string;
  snippet?: string;
  score?: number;
}

interface TavilyResponse {
  results?: TavilyHit[];
  answer?: string;
}

async function callTavily(query: string, maxResults: number): Promise<TavilyHit[]> {
  if (!TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY 未配置——请到 Settings 页面填入 Tavily API Key 后重启对话。');
  }
  const res = await timedFetch(
    TAVILY_ENDPOINT,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        max_results: Math.max(1, Math.min(10, maxResults)),
        include_answer: false,
        include_raw_content: false,
      }),
    },
    REQUEST_TIMEOUT_MS,
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Tavily ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as TavilyResponse;
  return Array.isArray(json.results) ? json.results : [];
}

/**
 * 极简 HTML → text：
 *  - 去 <script> / <style> / <noscript> 整段内容
 *  - 把常见块级标签替换成换行
 *  - 剩余标签全部 strip
 *  - 多个连续空白塌成单空格，多个空行塌成两个换行
 * 不引 jsdom / readability 是为了保持这个工具 ~150 行无构建。
 * 对结构化文档（API 文档、博客）效果可用；对 SPA / heavy-JS 网站效果差——
 * 这是 web_fetch 的固有限制，文档里讲清楚就行。
 */
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = (titleMatch?.[1] || '').trim();
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/pre)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  // 压缩空白：行内多空格 → 单空格；多个空行 → 两个换行
  text = text
    .split('\n')
    .map(l => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return { title, text };
}

const MAX_FETCH_CHARS = 40_000; // 单次返回正文上限——避免把整个 HN 论坛塞进 LLM 上下文

async function fetchUrl(url: string): Promise<{ url: string; title: string; content: string; truncated: boolean }> {
  const res = await timedFetch(
    url,
    {
      // Tavily 等 LLM 友好爬虫常用的 UA 头；很多站点对 default Node fetch UA 直接 403
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WittySkill/0.1; +https://gitcode.com/gyctl/witty-skill-insight)',
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.5',
      },
    },
    REQUEST_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`fetch ${url} → HTTP ${res.status}`);
  }
  const contentType = res.headers.get('content-type') || '';
  const raw = await res.text();
  // 非 HTML 文本（JSON / Markdown / 纯文本）直接返回 raw，跳过 HTML 提取
  let title = '';
  let content: string;
  if (/text\/html|application\/xhtml/i.test(contentType)) {
    const parsed = htmlToText(raw);
    title = parsed.title;
    content = parsed.text;
  } else {
    content = raw;
  }
  const truncated = content.length > MAX_FETCH_CHARS;
  if (truncated) content = content.slice(0, MAX_FETCH_CHARS) + `\n\n…[已截断，原文 ${raw.length} 字符]`;
  return { url, title, content, truncated };
}

const server = new McpServer({
  name: 'witty-web-search',
  version: '0.1.0',
});

// 用 deprecated 但 TS-friendly 的 `tool(name, description, schema, cb)` overload。
// `registerTool` 的 config 字段会触发 zod 深度推断爆炸（TS2589 "type instantiation
// is excessively deep"），换成扁平 overload 既能正常调用、运行时行为完全一致。
server.tool(
  'web_search',
  '用关键词搜索网页（Tavily）。当需要查询官方文档、最佳实践、库的最新 API、报错信息含义、kubernetes/linux 等运维场景的诊断思路时调用。调完后通常用 web_fetch 深读最相关的几条。',
  {
    query: z.string().min(1).describe('搜索关键词，中英文均可'),
    max_results: z.number().int().min(1).max(10).default(5).describe('返回结果条数，1-10，默认 5'),
  },
  async ({ query, max_results }) => {
    try {
      const hits = await callTavily(query, max_results);
      if (hits.length === 0) {
        return { content: [{ type: 'text', text: `web_search "${query}" 无结果` }] };
      }
      const lines = hits.map((h, i) => {
        const snippet = (h.content || h.snippet || '').replace(/\s+/g, ' ').slice(0, 280);
        return `${i + 1}. ${h.title}\n   ${h.url}\n   ${snippet}`;
      });
      return {
        content: [
          {
            type: 'text',
            text: `Tavily 搜索 "${query}" 命中 ${hits.length} 条：\n\n${lines.join('\n\n')}`,
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `web_search 失败：${(err as Error).message}` }],
      };
    }
  },
);

server.tool(
  'web_fetch',
  '抓取指定 URL 的页面正文（去 HTML，保留段落）。web_search 命中后想深读某条时调用。对 SPA / 重 JS 的站点效果差；遇到这种情况换个关键词再 search 一次。',
  {
    url: z.string().url().describe('完整 URL，必须以 http:// 或 https:// 开头'),
  },
  async ({ url }) => {
    try {
      const result = await fetchUrl(url);
      const header = result.title ? `# ${result.title}\n${result.url}\n\n` : `${result.url}\n\n`;
      return { content: [{ type: 'text', text: header + result.content }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `web_fetch 失败：${(err as Error).message}` }],
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 启动日志走 stderr——stdio MCP 协议占着 stdout 跑 JSON-RPC，stdout 不能掺别的字
  process.stderr.write(
    `[mcp-web-search] ready (tavily=${TAVILY_API_KEY ? 'configured' : 'MISSING'}, timeout=${REQUEST_TIMEOUT_MS}ms)\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`[mcp-web-search] fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
