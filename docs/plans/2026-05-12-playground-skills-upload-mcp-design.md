---
title: Playground skills 生成：文件上传 + 网络搜索（MCP）
date: 2026-05-12
status: in-progress
branch: feat/playground-skills-upload-mcp
---

## 目标

让 playground 的 "skills 生成" 能：

1. **上传参考资料**（PDF / Word / md / txt / code 文件等）作为生成素材
2. **联网搜索**（Tavily 等）查官方文档 / 最佳实践，作为生成素材

两类素材最终都会被注入 skill-generator agent 的执行上下文（前者作为只读文件、后者作为工具调用结果），并影响最终生成的 SKILL.md / scripts/ / references/ 内容。

非目标（后续）：
- 多模态（图片 OCR）
- 上传文件超过 10MB / 单次会话 > 50 个附件
- 搜索引擎多供应商抽象（MVP 只接 Tavily）
- 把附件作为 chip 引用进消息（仅作为"工作区已有素材"提示给 agent，不绑定到具体 user message）

---

## 现状摘要（关键 file:line）

- 上传按钮当前是 `alert('Upload coming soon!')` 占位（[playground/page.tsx:1216](../../src/app/(main)/playground/page.tsx)）
- chat 请求体里有 `files` 字段，**实模式不消费**（[api/playground/chat/route.ts:96](../../src/app/api/playground/chat/route.ts)）
- LLM 入口是 opencode-server 子进程（`@opencode-ai/sdk@1.14.39`），不是直接 Anthropic SDK
- opencode 隔离 config 主动 `delete parsed.mcp`，**MCP 被刻意剥光**（[opencode-manager.ts:264](../../src/lib/engine/skill-generation/opencode-agent-cli/opencode-manager.ts)）
- workspace 目录：`~/.agent_insight/agent_workspaces/<userSlug>/<threadId>/`，由 [workspace.ts](../../src/lib/engine/general-agent/workspace.ts) 管理
- 现有 `/api/skills/upload`（[route.ts](../../src/app/api/skills/upload/route.ts)）是上传**成品 skill 包**，不能复用

## 设计要点

### 1. 文件上传走"落盘 + 内置 read"，不走 MCP

agent 用内置 `read` 工具读 `<workspace>/uploads/<file>` 即可。**没必要为附件搞 MCP**：
- opencode 内置 `read` 已经足够；
- 附件天然是"per-thread 持久的工作区文件"，跟 workspace 模型完美契合；
- MCP 服务器有冷启动 + 子进程开销，每次只读几个文件不值得。

但 **VFS 扫描必须排除 `uploads/`**——否则前端 IDE 面板会把用户上传的素材当生成产物展示，下载 zip 卡片也会把素材打包进去。

### 2. 网络搜索必须走 MCP

opencode SDK 不接收 caller 在每次 chat 调用里塞自定义函数定义（不像 Anthropic SDK 的 `tools` 参数）。能给 agent 加新工具的唯一路径：

> 在 user 的隔离 config（`<runtime>/opencode/opencode.json`）里挂 `mcp` 字段，type `local`（stdio）或 `remote`（HTTP）。

参考类型定义：
- [`McpLocalConfig`](../../node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts) (line 946)
- [`McpRemoteConfig`](../../node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts) (line 984)

implement 为本地 stdio MCP server（`tools/mcp-web-search/`），暴露两个工具：

```
web_search(query, max_results?=5)  → 返回 [{title, url, snippet}]
web_fetch(url)                     → 返回 {url, title, content}（content 走 readability + html-to-text）
```

供应商：MVP 仅接 **Tavily**（免费额度 1000 calls/月、对 LLM 友好的 ranking、API 极简）。环境变量 `TAVILY_API_KEY` 由 opencode static config 的 `environment` 字段注入，源自 `UserSettings.searchApiKey`。

### 3. 解除"删 mcp"的副作用

[opencode-manager.ts:264](../../src/lib/engine/skill-generation/opencode-agent-cli/opencode-manager.ts) 的 `delete parsed.mcp` 历史上是为了**屏蔽用户全局挂的第三方 MCP**（同 plugin 副作用一样会污染 playground）。

修改语义：先 delete user 的全局 mcp（保留隔离），**再 merge 我们自己内置注入的 mcp**。即"剥外、加内"。

### 4. UserSettings 扩字段（不需要 DB migration）

`UserSettings` 已是 JSON blob 存 `User.settingsJson` 列。在 [server-config.ts](../../src/lib/storage/server-config.ts) 的 interface 里加：

```ts
export interface UserSettings {
  activeConfigId: string | null;
  configs: ModelConfig[];
  autoEvaluationEnabled?: boolean;
  // 新增
  searchProvider?: 'tavily' | 'none';   // 默认 'none'
  searchApiKey?: string;                // tavily api key
}
```

### 5. system prompt 加引导

在 [playground-opencode-bridge.ts `preparePlaygroundSystemPrompt`](../../src/lib/playground-opencode-bridge.ts) 里追加一段：

```
# 可用素材
- ./uploads/ : 用户已上传的参考资料（只读）。需要的话用 read 工具读取。
- 工具 web_search / web_fetch（如已配置 Tavily）：查官方文档 / 最佳实践时主动调用。
  搜回来的关键资料请落到 ./references/ 里，让生成的 skill 自带可追溯引用。
```

只在 `uploads/` 真的有文件 或 `web_search` MCP 已配置 时拼对应那段，避免给 agent 死引用空目录。

---

## 改动清单

### 新增

| 路径 | 作用 |
|---|---|
| `src/app/api/playground/attachments/route.ts` | POST: 上传 multipart files → `<workspace>/uploads/`；GET: 列表；DELETE: 删除 |
| `src/lib/playground/attachments.ts` | PDF/docx 转 txt（`pdf-parse` + `mammoth`）、文件名 sanitize、类型/大小校验 |
| `tools/mcp-web-search/package.json` | 独立子包（不污染主项目 deps） |
| `tools/mcp-web-search/index.ts` | stdio MCP server（`@modelcontextprotocol/sdk`） |
| `tools/mcp-web-search/README.md` | 简要使用文档 |
| `test/playground-attachments.test.ts` | 上传/扫描/清理用例 |

### 修改

| 路径 | 改动 |
|---|---|
| `src/app/(main)/playground/page.tsx` | 上传按钮接真实 `<input type="file" multiple>`；附件 chip 列表渲染；发送时把附件 manifest 拼进 message |
| `src/app/api/playground/chat/route.ts` | 透传 attachments manifest 给 bridge（可选：暂时不用，bridge 直接扫 uploads/） |
| `src/lib/playground-opencode-bridge.ts` | `preparePlaygroundSystemPrompt` 拼"可用素材"提示；`VFS_IGNORE` 加 `uploads`；download zip 也排除 |
| `src/lib/engine/general-agent/runner.ts` | （可能）需要把 MCP 配置传到 ensureRuntime —— 视调用栈而定 |
| `src/lib/engine/skill-generation/opencode-agent-cli/opencode-manager.ts` | 改"删 mcp"为"删 user 全局 mcp、merge 内置 mcp"；`buildIsolatedOpencodeConfig` 读 UserSettings.searchApiKey 注入 |
| `src/lib/storage/server-config.ts` | UserSettings 加 `searchProvider` / `searchApiKey` 字段 |
| `src/app/(main)/settings/...` | Settings 页面加搜索 API key 配置区块（最小 UI：provider 下拉 + key 输入） |
| `skills/skill-generator/SKILL.md` | 文档化"什么场景调 web_search / 怎么消费 uploads/" |
| `package.json` | 加 `pdf-parse`, `mammoth` deps |

预计代码量：~600-900 行（含 plan / 测试 / 注释）。

---

## API 契约

### `POST /api/playground/attachments`
```
multipart/form-data
  user: string
  threadId: string
  files: File[]    // 一次最多 10 个
  
Response 200:
{
  items: [
    { id: 'a1b2', name: 'api-spec.pdf', size: 12345, relPath: 'uploads/api-spec.pdf',
      textPath?: 'uploads/api-spec.txt' /* PDF/docx 转的纯文本副本 */ }
  ]
}

Response 4xx:
{ error: 'file too large' | 'unsupported type' | 'too many files' }
```

约束：
- 单文件 ≤ 10 MB
- 累计每 thread ≤ 50 个附件
- 允许扩展名：`.md .markdown .txt .pdf .docx .json .csv .py .ts .tsx .js .jsx .sh .yaml .yml .html .xml .log .toml .ini .conf`
- 文件名 sanitize：`[^A-Za-z0-9._-]` → `_`，截到 80 字符

### `GET /api/playground/attachments?user=&threadId=`
返回 `{ items: [...] }`，从 `<workspace>/uploads/` 实时扫，元数据从 sidecar `.meta.json` 读（或干脆只返回文件名 + size + mtime，无 sidecar）。

### `DELETE /api/playground/attachments?user=&threadId=&name=`
删 `uploads/<name>` 与对应 `.txt` 副本。

---

## MCP server 协议（tools/mcp-web-search）

stdio JSON-RPC，遵循 MCP spec。`tools/list` 返回：

```json
[
  {
    "name": "web_search",
    "description": "用关键词搜索网页。当需要查询官方文档、最佳实践、库的最新 API、报错信息含义等时调用。",
    "inputSchema": {
      "type": "object",
      "required": ["query"],
      "properties": {
        "query":       { "type": "string" },
        "max_results": { "type": "integer", "minimum": 1, "maximum": 10, "default": 5 }
      }
    }
  },
  {
    "name": "web_fetch",
    "description": "抓取指定 URL 的页面正文（去 HTML、保留段落与代码块）。web_search 命中后再深读时调用。",
    "inputSchema": {
      "type": "object",
      "required": ["url"],
      "properties": { "url": { "type": "string", "format": "uri" } }
    }
  }
]
```

Tavily API 调用：`POST https://api.tavily.com/search`，body `{api_key, query, max_results, include_answer:false, include_raw_content:false}`。

错误降级：环境变量缺 `TAVILY_API_KEY` 时 server 启动但 `tools/call` 返回 `{ isError: true, content: [{type:'text', text:'TAVILY_API_KEY not configured'}] }`，agent 看到自然就不会再调。

---

## opencode config 注入示意

`buildIsolatedOpencodeConfig` 输出附加 `mcp`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": { "deepseek": { ... } },
  "plugin": [],
  "mcp": {
    "web-search": {
      "type": "local",
      "command": ["node", "<repo>/tools/mcp-web-search/dist/index.js"],
      "environment": { "TAVILY_API_KEY": "<from UserSettings>" },
      "enabled": true,
      "timeout": 8000
    }
  }
}
```

只在 `searchApiKey` 存在时挂这段；不存在就完全不写 `mcp` 字段，避免 agent 看到一个永远报 error 的工具。

`configHash` 一并计算进 searchApiKey（[opencode-manager.ts stableHash 调用处](../../src/lib/engine/skill-generation/opencode-agent-cli/opencode-manager.ts)），改 key 时能正确触发 opencode-server 重启。

---

## 风险与回退

| 风险 | 缓解 |
|---|---|
| `pdf-parse` 在 worker thread 里偶尔崩 | 用 try/catch 包；失败时退化为"上传原始 PDF，告诉 agent 自己读不了二进制" |
| Tavily 网络抽风 | MCP server 内部加 8s timeout；tool_result 返回 error，agent 会自然降级用 read 已有 uploads/ |
| user 上传含敏感信息（API key 等）的素材 | 文档提示；后续可加扫描（不在 MVP 范围） |
| MCP server 拉子进程慢（首次 ~500ms） | 接受；opencode-server 在 session 复用时只拉一次 |
| 同事拉新代码后 MCP server 没 build | postinstall 里加 `npm run build` for tools/mcp-web-search；或者直接用 tsx 跑 ts 源码（更简单，省 build） |

**回退**：MCP 子项目独立，禁用只需 UserSettings 里清空 searchApiKey；上传走 workspace 目录，禁用只需把按钮换回 alert。两条路相互独立、互不阻塞。

---

## 实现顺序

1. ✅ 写本 plan（当前）
2. Phase 1 · 上传：
   - 加 `pdf-parse` / `mammoth` deps
   - `src/lib/playground/attachments.ts` + `/api/playground/attachments` 路由
   - 改 bridge：`VFS_IGNORE += uploads`，system prompt 拼 uploads/ 提示
   - page.tsx：替换上传按钮 + chip 列表
   - 测：手动上传 PDF + md + txt，看 agent 能不能 read
3. Phase 2 · 搜索：
   - 新建 `tools/mcp-web-search/`（tsx 直跑，省 build）
   - 改 `opencode-manager.ts`：merge mcp、configHash 含 searchApiKey
   - 改 `server-config.ts` 加字段；Settings 页面加 UI
   - 改 `skills/skill-generator/SKILL.md` 文档化
   - 测：配 Tavily key → 让 agent 查 "kubernetes node not ready 排查最佳实践" → 看 web_search 工具块出现
4. `npm run test` + `bash scripts/restart_dev.sh` 双验证
5. commit + PR → upstream/new_src
