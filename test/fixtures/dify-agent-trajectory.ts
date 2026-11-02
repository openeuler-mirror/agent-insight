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

export const difyAgentTraceId = '33333333333333333333333333333333';
export const difyAgentSessionId = `dify:${difyAgentTraceId}`;

export function difyAgentAttributes(values: Record<string, unknown>) {
  return Object.entries(values).map(([key, value]) => ({ key, value:
    typeof value === 'number' ? { intValue: String(value) }
      : typeof value === 'boolean' ? { boolValue: value }
        : { stringValue: typeof value === 'string' ? value : JSON.stringify(value) },
  }));
}

export function difyAgentFixture() {
  const common = { 'dify.agent_id': 'agent-probe', 'dify.app_id': 'app-probe', 'dify.trace_id': 'shared-correlation', 'gen_ai.agent.name': 'lookup-agent' };
  const messages = [{ role: 'user', parts: [{ type: 'text', content: 'Look up alpha' }] }];
  const call = { type: 'tool_call', id: 'call-1', name: 'lookup', arguments: '{"item":"alpha"}' };
  function span(id: string, operation: string, start: number, end: number, extra: Record<string, unknown>) {
    return {
      traceId: difyAgentTraceId, spanId: id, parentSpanId: '1111111111111111', name: `${operation} probe`,
      startTimeUnixNano: String(start * 1_000_000), endTimeUnixNano: String(end * 1_000_000), status: {},
      attributes: difyAgentAttributes({ ...common, 'gen_ai.operation.name': operation, 'logfire.span_type': 'span', ...extra }),
    };
  }
  const first = span('2222222222222222', 'chat', 1100, 1800, {
    'gen_ai.request.model': 'deepseek-flash', 'gen_ai.usage.input_tokens': 5, 'gen_ai.usage.output_tokens': 1,
    'gen_ai.input.messages': messages, 'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'thinking', content: 'I should use lookup for the code.' }, call] }],
    'gen_ai.system_instructions': [{ type: 'text', content: 'Use lookup.' }],
  });
  const tool = span('3333333333333333', 'execute_tool', 1900, 2100, {
    'gen_ai.tool.name': 'lookup', 'gen_ai.tool.call.id': 'call-1', 'gen_ai.tool.call.arguments': '{"item":"alpha"}', 'gen_ai.tool.call.result': '{"value":"ok"}',
  });
  const second = span('4444444444444444', 'chat', 2200, 2800, {
    'gen_ai.request.model': 'deepseek-flash', 'gen_ai.usage.input_tokens': 9, 'gen_ai.usage.output_tokens': 3,
    'gen_ai.input.messages': [...messages, { role: 'assistant', parts: [call] }, { role: 'user', parts: [{ type: 'tool_call_response', id: 'call-1', name: 'lookup', result: '{"value":"ok"}' }] }],
    'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'thinking', content: 'The lookup returned ok.' }, { type: 'text', content: 'alpha is ok' }], finish_reason: 'stop' }],
    'gen_ai.system_instructions': [{ type: 'text', content: 'Use lookup.' }],
  });
  const root = { ...span('1111111111111111', 'invoke_agent', 1000, 3000, {
    final_result: 'alpha is ok', 'gen_ai.aggregated_usage.input_tokens': 14, 'gen_ai.aggregated_usage.output_tokens': 4,
  }), parentSpanId: '' };
  const noise = { ...first, spanId: '5555555555555555', attributes: difyAgentAttributes({ 'db.system': 'redis' }) };
  const body = { resourceSpans: [{ resource: { attributes: difyAgentAttributes({ 'service.name': 'dify-agent-trajectory', 'service.instance.id': 'shared-instance' }) }, scopeSpans: [{ scope: { name: 'pydantic-ai' }, spans: [root, first, tool, second, noise] }] }] };
  return { body, root, first, tool, second };
}
