"use strict";

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const server = new Server(
  { name: "agent-insight-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "lookup",
      description: "Look up a deterministic catalog value by code.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string" },
        },
        required: ["code"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const code = String(request.params.arguments?.code || "");
  return {
    content: [
      {
        type: "text",
        text: code === "K-42" ? "CATALOG-CODEX-4242" : `UNKNOWN:${code}`,
      },
    ],
  };
});

server.connect(new StdioServerTransport()).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
