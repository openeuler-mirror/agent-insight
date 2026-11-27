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
