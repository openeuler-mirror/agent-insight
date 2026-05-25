
import { db } from '@/lib/storage/prisma';
import { addToSession, getSession } from '@/lib/ingest/proxy-store';
import { getActiveConfig } from '@/lib/storage/server-config';
import { NextResponse } from 'next/server';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

function getProxyDispatcher(): ProxyAgent | undefined {
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
  if (proxyUrl) {
    console.log('[API Proxy] HTTP proxy configured');
    return new ProxyAgent({
      uri: proxyUrl,
      connect: {
        rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0'
      }
    });
  }
  return undefined;
}

const proxyDispatcher = getProxyDispatcher();

async function proxyFetch(url: string, init: RequestInit): Promise<Response> {
  if (proxyDispatcher) {
    const response = await undiciFetch(url, {
      ...init as any,
      dispatcher: proxyDispatcher
    });
    return response as unknown as Response;
  }
  return fetch(url, init);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ taskId: string; path: string[] }> }
) {
  const { taskId, path } = await params;
  
  let baseUrl = 'https://api.deepseek.com';
  if (taskId.startsWith('claude')) {
      baseUrl = 'https://api.deepseek.com/anthropic';
  }
  
  let body: any = {};
  const clonedRequest = request.clone();
  try {
      body = await clonedRequest.json();
  } catch (e) {
      console.error('Failed to parse request body');
  }

  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('content-length');
  
  const activeConfig = await getActiveConfig();
  const apiKey = activeConfig?.apiKey;

  try {
        const session = await getSession(taskId);
        if (session?.model) {
            if (typeof body === 'object' && body !== null) {
                console.log(`[Proxy] Overriding model for task ${taskId}: ${body.model} -> ${session.model}`);
                body.model = session.model;
            }
        } else if (typeof body === 'object' && body !== null && body.model) {
            await db.updateSession(taskId, { model: body.model });
            console.log(`[Proxy] Captured model from request for task ${taskId}: ${body.model}`);
        }
    } catch (e) {
        console.error('Failed to apply or capture model preference', e);
    }


  const targetUrl = `${baseUrl}/${path.join('/')}`;

  if (body.stream && !body.stream_options) {
      body.stream_options = { include_usage: true };
  }

  if (apiKey) {
      headers.set('Authorization', `Bearer ${apiKey}`);
  } else if (!headers.has('Authorization')) {
      console.warn('[Proxy] No API Key available for request');
  }

  const startTime = Date.now();
  const interactionData: any = {
      requestMessages: body.messages || [],
      responseMessage: { role: 'assistant', content: '' },
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      toolCalls: [],
      timestamp: startTime,
      latency: 0,
      // Capture LLM request parameters for trace display
      model: body.model,
      ...(body.temperature != null && { temperature: body.temperature }),
      ...(body.max_tokens != null && { max_tokens: body.max_tokens }),
      ...(body.top_p != null && { top_p: body.top_p }),
      ...(body.frequency_penalty != null && { frequency_penalty: body.frequency_penalty }),
      ...(body.presence_penalty != null && { presence_penalty: body.presence_penalty }),
      ...(body.stop != null && { stop: body.stop }),
  };

  try {
      const response = await proxyFetch(targetUrl, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body),
      });

      if (!response.ok) {
          console.error("Upstream error", response.status, response.statusText);
          return response;
      }

      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('content-encoding');
      responseHeaders.delete('content-length');
      responseHeaders.delete('transfer-encoding');

      const isStream = body.stream === true;

      if (isStream) {
          const [clientStream, logStream] = response.body?.tee() || [];

          if (!clientStream || !logStream) {
             console.error("Failed to tee stream"); 
             return response;
          }

          const nextResponse = new NextResponse(clientStream as any, {
              headers: responseHeaders,
              status: response.status
          });

          (async () => {
              try {
                const reader = logStream.getReader();
                const decoder = new TextDecoder();
                let done = false;
                
                interactionData.responseMessage.reasoning_content = ''; 

                while (!done) {
                    const { value, done: doneReading } = await reader.read();
                    done = doneReading;
                    if (value) {
                         const chunk = decoder.decode(value, { stream: true });
                         const lines = chunk.split('\n');
                         for (const line of lines) {
                            if (line.trim().startsWith('data: ')) {
                                const dataStr = line.trim().substring(6);
                                if (dataStr === '[DONE]') continue;
                                try {
                                    const data = JSON.parse(dataStr);

                                    if (data.choices && data.choices[0]) {
                                        const choice = data.choices[0];
                                        const delta = choice.delta;
                                        if (delta) {
                                            if (delta.content) interactionData.responseMessage.content += delta.content;
                                            if (delta.reasoning_content) interactionData.responseMessage.reasoning_content += delta.reasoning_content;
                                            if (delta.tool_calls) {
                                                delta.tool_calls.forEach((tc: any, index: number) => {
                                                    if (!interactionData.toolCalls[index]) interactionData.toolCalls[index] = { function: { name: '', arguments: '' }};
                                                    if (tc.function?.name) interactionData.toolCalls[index].function.name += tc.function.name;
                                                    if (tc.function?.arguments) interactionData.toolCalls[index].function.arguments += tc.function.arguments;
                                                });
                                            }
                                        }
                                        if (choice.finish_reason) interactionData.finish_reason = choice.finish_reason;
                                    }

                                    if (data.type === 'content_block_delta' && data.delta) {
                                        if (data.delta.type === 'text_delta' && data.delta.text) {
                                             interactionData.responseMessage.content += data.delta.text;
                                        } else if (data.delta.type === 'thinking_delta' && data.delta.thinking) {
                                             interactionData.responseMessage.reasoning_content += data.delta.thinking;
                                        } else if (data.delta.reasoning_content) {
                                             interactionData.responseMessage.reasoning_content += data.delta.reasoning_content;
                                        }
                                    }
                                    
                                    let newUsage = null;
                                    if (data.usage) newUsage = data.usage;
                                    if (data.type === 'message_delta' && data.usage) newUsage = data.usage;
                                    if (data.type === 'message_start' && data.message?.usage) newUsage = data.message.usage;

                                    if (newUsage) {
                                        if (!interactionData.usage) interactionData.usage = {};
                                        if (newUsage.input_tokens !== undefined) interactionData.usage.input_tokens = newUsage.input_tokens;
                                        if (newUsage.output_tokens !== undefined) interactionData.usage.output_tokens = newUsage.output_tokens;
                                        if (newUsage.cache_read_input_tokens !== undefined) interactionData.usage.cache_read_input_tokens = newUsage.cache_read_input_tokens;
                                        if (newUsage.cache_creation_input_tokens !== undefined) interactionData.usage.cache_creation_input_tokens = newUsage.cache_creation_input_tokens;
                                        // Extract reasoning tokens (OpenAI-compatible: completion_tokens_details.reasoning_tokens, or direct reasoning_tokens)
                                        const reasoningToks = newUsage.reasoning_tokens ?? newUsage.completion_tokens_details?.reasoning_tokens;
                                        if (reasoningToks !== undefined) interactionData.usage.reasoning_tokens = reasoningToks;

                                        const input = interactionData.usage.input_tokens || 0;
                                        const output = interactionData.usage.output_tokens || 0;
                                        const cacheRead = interactionData.usage.cache_read_input_tokens || 0;
                                        const cacheCreate = interactionData.usage.cache_creation_input_tokens || 0;
                                        interactionData.usage.total_tokens = input + output + cacheRead + cacheCreate;
                                    }

                                } catch (e) {}
                            }
                         }
                    }
                }
                
                if (!interactionData.usage) interactionData.usage = {};
                if (!interactionData.usage.input_tokens) {
                     const bodyStr = JSON.stringify(body);
                     const estInput = Math.ceil(bodyStr.length / 4);
                     interactionData.usage.input_tokens = estInput;
                }
                
                if (!interactionData.usage.output_tokens) {
                     const outContent = (interactionData.responseMessage.content || '') + (interactionData.responseMessage.reasoning_content || '');
                     const estOutput = Math.ceil(outContent.length / 3); 
                     interactionData.usage.output_tokens = estOutput;
                }
                
                const finalInput = interactionData.usage.input_tokens || 0;
                const finalOutput = interactionData.usage.output_tokens || 0;
                const finalCacheRead = interactionData.usage.cache_read_input_tokens || 0;
                const finalCacheCreate = interactionData.usage.cache_creation_input_tokens || 0;
                interactionData.usage.total_tokens = finalInput + finalOutput + finalCacheRead + finalCacheCreate;

                interactionData.latency = Date.now() - startTime;
                await addToSession(taskId, interactionData);
              } catch (err) {
                  console.error("Background stream logger error", err);
              }
          })();

          return nextResponse;

      } else {
          const data = await response.json();
          
          if (data.usage) interactionData.usage = data.usage;
          if (data.choices && data.choices[0]) {
              interactionData.responseMessage = data.choices[0].message;
              if (data.choices[0].message.tool_calls) {
                  interactionData.toolCalls = data.choices[0].message.tool_calls;
              }
              if (data.choices[0].finish_reason) {
                  interactionData.finish_reason = data.choices[0].finish_reason;
              }
          }
          
          interactionData.latency = Date.now() - startTime;
          await addToSession(taskId, interactionData);
          
          return NextResponse.json(data, {
              status: response.status,
              headers: responseHeaders 
          });
      }

  } catch (error) {
     console.error("[Proxy-Path] ❌ Error:", error);
     return NextResponse.json({ error: 'Proxy Failed' }, { status: 500 });
  }
}
