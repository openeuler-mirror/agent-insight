import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { appendOtelTraceEvents } from '@/lib/ingest/claude-otel/spool';
import { getActiveConfig } from '@/lib/storage/server-config';
import type { OtelTraceEvent } from '@/lib/ingest/claude-otel/types';

function randomHex(len: number): string {
  return crypto.randomBytes(len).toString('hex').slice(0, len);
}

function makeTraceEvent(
  sessionId: string,
  traceId: string,
  spanId: string,
  model: string,
  kind: 'llm' | 'tool',
  usage: { input_tokens: number; output_tokens: number; total_tokens: number },
  latencyMs: number,
  startTimeMs: number,
  attrs: Record<string, any>,
  user?: string,
  parentSpanId?: string,
): OtelTraceEvent {
  return {
    receivedAt: new Date().toISOString(),
    sessionId,
    traceId,
    spanId,
    parentSpanId,
    name: kind === 'llm' ? 'chat' : 'execute_tool',
    kind,
    serviceName: 'openclaw',
    user,
    model,
    usage,
    latencyMs,
    startTimeMs,
    attributes: {
      'gen_ai.span.kind': kind,
      'gen_ai.request.model': model,
      ...attrs,
    },
  };
}

export async function POST(request: Request) {
  const body: any = await request.json().catch(() => ({}));
  if (!body || !body.messages) {
    return NextResponse.json({ error: 'Bad Request: messages required' }, { status: 400 });
  }

  // Resolve user from active config, env, or OS username
  let user: string | undefined;
  const activeConfig = await getActiveConfig();
  const configUser = activeConfig?.name || process.env.PROXY_USER;
  const osUser = process.env.USER || process.env.USERNAME;
  const apiKey = activeConfig?.apiKey || process.env.WITTY_API_KEY;
  user = configUser || osUser || 'openclaw-user';

  // For the proxy, we forward API key in Authorization header to upstream
  const requestAuth = request.headers.get('authorization');

  // Use the activeConfig API key for upstream if no auth header provided
  let upstreamAuth: string;
  if (requestAuth) {
    upstreamAuth = requestAuth;
  } else if (apiKey) {
    upstreamAuth = `Bearer ${apiKey}`;
  } else {
    return NextResponse.json({ error: 'No API key available' }, { status: 401 });
  }

  // Determine upstream URL: use DEEPSEEK_BASE_URL env or default to api.deepseek.com
  const upstreamBase = process.env.PROXY_DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
  const isStream = body.stream === true;
  const model = body.model || 'deepseek-chat';
  const sessionId = randomHex(8);
  const traceId = randomHex(8);
  const spanId = randomHex(8);
  const startTimeMs = Date.now();

  // Extract prompt (last user message) and tool definitions from request body
  const lastUserMsg = [...body.messages].reverse().find((m: any) => m.role === 'user');
  const prompt: string | undefined = lastUserMsg
    ? (typeof lastUserMsg.content === 'string'
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg.content)
          ? lastUserMsg.content.findLast((c: any) => c.type === 'text')?.text
          : undefined)
    : undefined;
  const requestTools: string[] = Array.isArray(body.tools)
    ? body.tools.map((t: any) => t.function?.name || t.name || 'unknown').filter(Boolean)
    : [];
  // Prepare upstream payload (ensure stream_options for usage in streaming)
  const upstreamBody = { ...body };
  if (isStream && !upstreamBody.stream_options) {
    upstreamBody.stream_options = { include_usage: true };
  }

  try {
    const response = await fetch(`${upstreamBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': upstreamAuth,
      },
      body: JSON.stringify(upstreamBody),
    });

    if (!response.ok) {
      // Forward error as-is (but capture as error trace)
      const errorBody = await response.text().catch(() => '');
      const latencyMs = Date.now() - startTimeMs;
      const evt = makeTraceEvent(
        sessionId, traceId, spanId, model, 'llm',
        { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        latencyMs, startTimeMs,
        { 'error.code': response.status, 'error.message': response.statusText },
        user,
      );
      appendOtelTraceEvents([evt]);

      return new NextResponse(errorBody, {
        status: response.status,
        statusText: response.statusText,
      });
    }

    if (isStream) {
      // Streaming: tee the response body — one for client, one for capture
      const [clientStream, logStream] = response.body!.tee();
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('content-encoding');
      responseHeaders.delete('content-length');
      responseHeaders.delete('transfer-encoding');

      // Background capture
      (async () => {
        try {
          const reader = logStream.getReader();
          const decoder = new TextDecoder();
          const usage: any = {};
          let content = '';
          let reasoningContent = '';
          // Accumulate tool_calls by their `index` from the delta
          const toolCallsMap = new Map<number, any>();
          let done = false;

          while (!done) {
            const { value, done: doneReading } = await reader.read();
            done = doneReading;
            if (value) {
              const chunk = decoder.decode(value, { stream: true });
              for (const line of chunk.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data: ')) { continue; }
                const dataStr = trimmed.slice(6);
                if (dataStr === '[DONE]') { continue; }
                try {
                  const data = JSON.parse(dataStr);
                  // Accumulate streaming content
                  if (data.choices?.[0]) {
                    const delta = data.choices[0].delta;
                    if (delta?.content) { content += delta.content; }
                    if (delta?.reasoning_content) { reasoningContent += delta.reasoning_content; }
                    if (delta?.tool_calls) {
                      for (const tc of delta.tool_calls) {
                        const idx = tc.index ?? 0;
                        if (!toolCallsMap.has(idx)) {
                          toolCallsMap.set(idx, { function: { name: '', arguments: '' } });
                        }
                        const entry = toolCallsMap.get(idx);
                        if (tc.function?.name) { entry.function.name += tc.function.name; }
                        if (tc.function?.arguments) { entry.function.arguments += tc.function.arguments; }
                        if (tc.id) { entry.id = tc.id; }
                      }
                    }
                    // Capture usage from final chunk
                    if (data.usage) {
                      Object.assign(usage, data.usage);
                    }
                  }
                } catch (_ex) {
                  // skip malformed SSE line
                }
              }
            }
          }

          const latencyMs = Date.now() - startTimeMs;
          const inputTokens = usage.prompt_tokens ?? Math.ceil(JSON.stringify(body).length / 4);
          const outputTokens = usage.completion_tokens ?? Math.ceil((content + reasoningContent).length / 3);
          const totalTokens = usage.total_tokens ?? (inputTokens + outputTokens);

          const events: OtelTraceEvent[] = [];

          // 1. LLM event with prompt/completion attributes
          events.push(makeTraceEvent(
            sessionId, traceId, spanId, model, 'llm',
            { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens },
            latencyMs, startTimeMs,
            {
              'llm.latency_ms': latencyMs,
              'llm.provider': 'deepseek',
              ...(reasoningContent ? { 'gen_ai.response.reasoning': reasoningContent } : {}),
              ...(content ? { 'gen_ai.completion': content } : {}),
              ...(prompt ? { 'gen_ai.prompt': prompt } : {}),
              ...(requestTools.length > 0 ? { 'gen_ai.request.tools': requestTools.join(',') } : {}),
            },
            user,
          ));

          // 2. Tool events for each accumulated tool call
          for (const tc of toolCallsMap.values()) {
            if (tc?.function?.name) {
              const toolSpanId = randomHex(8);
              events.push(makeTraceEvent(
                sessionId, traceId, toolSpanId, model, 'tool',
                { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                0, startTimeMs,
                {
                  'tool.name': tc.function.name,
                  'tool.arguments': tc.function.arguments || '{}',
                  'llm.provider': 'deepseek',
                },
                user,
                spanId, // parentSpanId → LLM span
              ));
            }
          }

          appendOtelTraceEvents(events);
        } catch (err) {
          console.error('[Proxy] Background stream capture error:', err);
        }
      })();

      return new NextResponse(clientStream as any, {
        status: response.status,
        headers: responseHeaders,
      });
    }

    // Non-streaming: read full response
    const data = await response.json();
    const latencyMs = Date.now() - startTimeMs;

    const usageTokens = data.usage || {};
    const inputTokens = usageTokens.prompt_tokens ?? 0;
    const outputTokens = usageTokens.completion_tokens ?? 0;
    const totalTokens = usageTokens.total_tokens ?? (inputTokens + outputTokens);

    const events: OtelTraceEvent[] = [];

    // 1. LLM event
    const completion = data.choices?.[0]?.message?.content || '';
    events.push(makeTraceEvent(
      sessionId, traceId, spanId, model, 'llm',
      { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens },
      latencyMs, startTimeMs,
      {
        'llm.latency_ms': latencyMs,
        'llm.provider': 'deepseek',
        ...(completion ? { 'gen_ai.completion': completion } : {}),
        ...(prompt ? { 'gen_ai.prompt': prompt } : {}),
        ...(requestTools.length > 0 ? { 'gen_ai.request.tools': requestTools.join(',') } : {}),
      },
      user,
    ));

    // 2. Tool events from non-streaming response
    const responseToolCalls = data.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(responseToolCalls)) {
      for (const tc of responseToolCalls) {
        if (tc?.function?.name) {
          const toolSpanId = randomHex(8);
          events.push(makeTraceEvent(
            sessionId, traceId, toolSpanId, model, 'tool',
            { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            0, startTimeMs,
            {
              'tool.name': tc.function.name,
              'tool.arguments': tc.function.arguments || '{}',
              'llm.provider': 'deepseek',
            },
            user,
            spanId, // parentSpanId → LLM span
          ));
        }
      }
    }

    appendOtelTraceEvents(events);

    return NextResponse.json(data, {
      status: response.status,
      headers: new Headers(response.headers),
    });
  } catch (error: any) {
    console.error('[Proxy] Error:', error);
    const latencyMs = Date.now() - startTimeMs;
    const evt = makeTraceEvent(
      sessionId, traceId, spanId, model, 'llm',
      { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      latencyMs, startTimeMs,
      { 'error.message': error?.message || 'Proxy failed' },
      user,
    );
    appendOtelTraceEvents([evt]);
    return NextResponse.json({ error: 'Proxy failed' }, { status: 502 });
  }
}
