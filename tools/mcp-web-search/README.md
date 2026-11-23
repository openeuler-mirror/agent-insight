# mcp-web-search

Internal stdio MCP server exposing `web_search` / `web_fetch` to the playground
skill-generator agent.

## Tools

- **web_search(query, max_results=5)** — Tavily search. Returns title / url /
  snippet for each hit.
- **web_fetch(url)** — Fetch a URL and extract page text (HTML→text, no JS
  rendering).

## How it's launched

The agent-insight main server injects this server into each user's isolated
opencode config under `mcp.web-search`:

```json
{
  "mcp": {
    "web-search": {
      "type": "local",
      "command": ["node", "<repo>/tools/mcp-web-search/index.js"],
      "environment": { "TAVILY_API_KEY": "<from UserSettings>" },
      "enabled": true,
      "timeout": 8000
    }
  }
}
```

In development, `command` uses `tsx` to run `index.ts` directly so there is no
build step.

## Configuration

- `TAVILY_API_KEY` (required for `web_search`). Get one at
  https://tavily.com — free tier is ~1000 calls/month.
- `TAVILY_ENDPOINT` (optional, default `https://api.tavily.com/search`).
- `WEB_SEARCH_TIMEOUT_MS` (optional, default `8000`).

Missing `TAVILY_API_KEY` does not crash the server; tool calls return
`isError: true` with a human-readable hint so the agent backs off gracefully.

## Standalone test

```bash
TAVILY_API_KEY=tvly-xxx tsx tools/mcp-web-search/index.ts
```

Then drive it with any MCP client. The opencode CLI's `opencode mcp list` will
also show it as a registered server.
