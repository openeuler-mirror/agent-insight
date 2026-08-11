import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'agent-insight-test-mcp', version: '1.0.0' });

server.tool(
  'get_project_metadata',
  'Return deterministic metadata for validating Qwen Code MCP tracing.',
  async () => ({
    content: [{
      type: 'text',
      text: JSON.stringify({
        name: 'agent-insight',
        version: '0.7.0',
        traceCollector: 'qwencode',
        source: 'local-test-mcp',
      }),
    }],
  }),
);

await server.connect(new StdioServerTransport());
