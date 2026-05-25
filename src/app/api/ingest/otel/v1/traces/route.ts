
import { saveExecutionRecord } from '@/lib/storage/data-service';
import { db } from '@/lib/storage/prisma';
import { NextResponse } from 'next/server';

function getValue(anyValue: any): any {
  if (!anyValue) return undefined;
  if (anyValue.stringValue !== undefined) return anyValue.stringValue;
  if (anyValue.intValue !== undefined) return parseInt(anyValue.intValue);
  if (anyValue.doubleValue !== undefined) return anyValue.doubleValue;
  if (anyValue.boolValue !== undefined) return anyValue.boolValue;
  if (anyValue.arrayValue !== undefined) return anyValue.arrayValue.values?.map(getValue);
  if (anyValue.kvlistValue !== undefined) {
    const obj: any = {};
    anyValue.kvlistValue.values.forEach((kv: any) => {
        obj[kv.key] = getValue(kv.value);
    });
    return obj;
  }
  return undefined;
}

export async function POST(req: Request) {
  try {
    const apiKey = req.headers.get('x-witty-api-key');
    let authenticatedUser: string | undefined;

    if (apiKey) {
        const userRecord = await db.findUserByApiKey(apiKey);
        if (userRecord) {
            authenticatedUser = userRecord.username;
            console.log(`[OTel] Authenticated User: ${authenticatedUser}`);
        } else {
            console.warn(`[OTel] Invalid API Key provided: ${apiKey}`);
        }
    }

    const contentType = req.headers.get('content-type') || '';
    console.log(`[OTel] Received Request. Content-Type: ${contentType}`);

    let body;
    try {
        if (contentType.includes('application/json')) {
            body = await req.json();
        } else if (contentType.includes('application/x-protobuf')) {
            console.warn('[OTel] Received Protobuf payload. JSON parser skipped.');
            return NextResponse.json({ error: 'Protobuf not supported yet, please use OTEL_EXPORTER_OTLP_PROTOCOL=http/json' }, { status: 415 });
        } else {
            console.log('[OTel] Unknown Content-Type, attempting JSON parse...');
            body = await req.json();
        }
    } catch (e) {
        console.error('[OTel] Failed to parse request body:', e);
        return NextResponse.json({ error: 'Invalid Payload' }, { status: 400 });
    }
    
    if (!body) return NextResponse.json({});

    console.log('[OTel] Raw Body Structure:', JSON.stringify(body, (key, value) => {
        if (key === 'resourceSpans' && Array.isArray(value)) return `[${value.length} spans]`;
        return value;
    }, 2));
    
    if (body.resourceSpans && body.resourceSpans.length > 0) {
        console.log('[OTel] First Resource Attributes:', JSON.stringify(body.resourceSpans[0].resource?.attributes));
        if (body.resourceSpans[0].scopeSpans?.[0]?.spans?.[0]) {
             console.log('[OTel] First Span Attributes:', JSON.stringify(body.resourceSpans[0].scopeSpans[0].spans[0].attributes));
        }
    }

    const resourceSpans = body.resourceSpans || [];

    for (const resourceSpan of resourceSpans) {
      const resourceAttrsStart = resourceSpan.resource?.attributes || [];
      const resourceAttrs: Record<string, any> = {};
      resourceAttrsStart.forEach((a: any) => {
          resourceAttrs[a.key] = getValue(a.value);
      });

      const serviceName = resourceAttrs['service.name'] || 'unknown-service';
      
      const userId = authenticatedUser || resourceAttrs['user.id'] || resourceAttrs['enduser.id'];

      const scopeSpans = resourceSpan.scopeSpans || [];
      for (const scopeSpan of scopeSpans) {
        const spans = scopeSpan.spans || [];
        for (const span of spans) {
          const attrsStart = span.attributes || [];
          const attrs: Record<string, any> = {};
          attrsStart.forEach((a: any) => {
              attrs[a.key] = getValue(a.value);
          });

          const isGenAI = Object.keys(attrs).some(k => k.startsWith('gen_ai.') || k.startsWith('llm.'));
          const isTool = attrs['tool.name'] !== undefined;

          if (isGenAI || isTool) {
            const traceId = span.traceId;
            const spanId = span.spanId;
            const parentSpanId = span.parentSpanId;
            
            const model = attrs['gen_ai.request.model'] || attrs['llm.request.model'];
            const inputTokens = attrs['gen_ai.usage.input_tokens'] || attrs['llm.usage.prompt_tokens'] || 0;
            const outputTokens = attrs['gen_ai.usage.output_tokens'] || attrs['llm.usage.completion_tokens'] || 0;
            const reasoningTokens = attrs['gen_ai.usage.reasoning_tokens'] || 0;
            const totalTokens = (inputTokens || 0) + (outputTokens || 0);

            const startTimeNano = BigInt(span.startTimeUnixNano || 0);
            const endTimeNano = BigInt(span.endTimeUnixNano || 0);
            const latencyMs = Number((endTimeNano - startTimeNano) / BigInt(1000000));
            const startTimeMs = Number(startTimeNano / BigInt(1000000));

            const prompt = attrs['gen_ai.prompt'] || attrs['db.statement'];
            const completion = attrs['gen_ai.completion'] || attrs['db.result'];
            
            const interaction: any = {
                spanId,
                parentSpanId,
                name: span.name,
                type: isTool ? 'tool' : 'llm',
                model,
                usage: {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    reasoning_tokens: reasoningTokens || undefined,
                    total_tokens: totalTokens
                },
                latency: latencyMs,
                timestamp: startTimeMs,
            };

            if (prompt) interaction.requestMessages = [{ role: 'user', content: prompt }];
            if (completion) interaction.responseMessage = { role: 'assistant', content: completion };
            
            if (isTool) {
                interaction.toolCall = {
                    name: attrs['tool.name'],
                    arguments: attrs['tool.arguments'] || JSON.stringify(attrs)
                };
            }

            console.log(`[OTel] Processed Span: ${traceId} - ${span.name} (${latencyMs}ms)`);

            const serviceInstanceId = resourceAttrs['service.instance.id'];
            const explicitSessionId = resourceAttrs['session.id'] || attrs['session.id'];

            let taskId = explicitSessionId || serviceInstanceId || traceId;
            
            if (taskId === 'unknown') taskId = traceId;

            console.log(`[OTel] Grouping into Session: ${taskId} (Source: ${explicitSessionId ? 'SessionID' : serviceInstanceId ? 'ProcessID' : 'TraceID'})`);

            const existingSession = await db.findSessionByTaskId(taskId);
            
            let currentInteractions: any[] = [];
            if (existingSession?.interactions) {
                try {
                    currentInteractions = JSON.parse(existingSession.interactions);
                } catch (e) {}
            }
            
            if (!currentInteractions.find((i: any) => i.spanId === spanId)) {
                
                interaction.traceId = traceId;

                currentInteractions.push(interaction);
                currentInteractions.sort((a, b) => a.timestamp - b.timestamp);
                
                await db.upsertSession(
                    taskId,
                    {
                        taskId,
                        user: userId,
                        model: model || 'unknown',
                        startTime: new Date(startTimeMs),
                        interactions: JSON.stringify(currentInteractions),
                        label: serviceName
                    },
                    {
                        interactions: JSON.stringify(currentInteractions),
                        model: (existingSession && (existingSession as any).model === 'unknown' && model) ? model : undefined
                    }
                );
            }

            try {
                const firstInteraction = currentInteractions[0];
                const lastInteraction = currentInteractions[currentInteractions.length - 1];
                
                const totalInputTokens = currentInteractions.reduce((sum, i) => sum + (i.usage?.input_tokens || 0), 0);
                const totalOutputTokens = currentInteractions.reduce((sum, i) => sum + (i.usage?.output_tokens || 0), 0);
                const totalLatency = currentInteractions.reduce((sum, i) => sum + (i.latency || 0), 0);

                await saveExecutionRecord({
                    task_id: taskId,
                    query: firstInteraction?.requestMessages?.[0]?.content || 'OTel Session',
                    framework: serviceName,
                    model: model || 'unknown',
                    tokens: totalInputTokens + totalOutputTokens,
                    latency: totalLatency,
                    final_result: lastInteraction?.responseMessage?.content || '',
                    timestamp: new Date(startTimeMs),
                    label: serviceName,
                    user: userId || 'anonymous',
                });
                console.log(`[OTel] Synced Task ${taskId} to Execution table.`);
            } catch (err) {
                console.error('[OTel] Execution Sync Error:', err);
            }
          }
        }
      }
    }

    return NextResponse.json({ status: 'success' });
  } catch (e) {
    console.error('OTel Parsing Error', e);
    return NextResponse.json({ error: 'Failed to parse OTLP' }, { status: 400 });
  }
}

export async function OPTIONS(req: Request) {
    console.log('[OTel] Received OPTIONS Request. Headers:', JSON.stringify(Object.fromEntries(req.headers.entries())));
    return new NextResponse(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-witty-api-key, x-api-key, baggage, traceparent, tracestate',
        }
    });
}
