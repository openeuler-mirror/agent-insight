import type { ClaudeOtelEvent, OtelTraceEvent } from './types';

export function getOtelAnyValue(anyValue: any): any {
  if (!anyValue || typeof anyValue !== 'object') return undefined;
  if (anyValue.stringValue !== undefined) return anyValue.stringValue;
  if (anyValue.intValue !== undefined) return Number(anyValue.intValue);
  if (anyValue.doubleValue !== undefined) return Number(anyValue.doubleValue);
  if (anyValue.boolValue !== undefined) return Boolean(anyValue.boolValue);
  if (anyValue.arrayValue !== undefined) {
    const values = anyValue.arrayValue?.values || [];
    return Array.isArray(values) ? values.map((v: any) => getOtelAnyValue(v)) : [];
  }
  if (anyValue.kvlistValue !== undefined) {
    const out: Record<string, any> = {};
    const values = anyValue.kvlistValue?.values || [];
    if (Array.isArray(values)) {
      for (const kv of values) {
        if (!kv?.key) continue;
        out[kv.key] = getOtelAnyValue(kv.value);
      }
    }
    return out;
  }
  return undefined;
}

export function otelAttrsToObject(attrs: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!Array.isArray(attrs)) return out;
  for (const attr of attrs) {
    if (!attr?.key) continue;
    out[attr.key] = getOtelAnyValue(attr.value);
  }
  return out;
}

function parseLogBody(body: any): any {
  const value = getOtelAnyValue(body);
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (!s) return value;
  if (!s.startsWith('{') && !s.startsWith('[')) return value;
  try {
    return JSON.parse(s);
  } catch {
    return value;
  }
}

function normalizeEventName(raw: any, body: any): string {
  const eventName = typeof raw === 'string' && raw.trim() ? raw.trim() : '';
  if (eventName) return eventName.replace(/^claude_code\./, '');
  if (typeof body === 'string') return body.replace(/^claude_code\./, '');
  return 'unknown';
}

function asOptionalString(value: any): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s ? s : undefined;
}

function firstOptionalString(...values: any[]): string | undefined {
  for (const value of values) {
    const s = asOptionalString(value);
    if (s) return s;
  }
  return undefined;
}

function asOptionalNumber(value: any): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function asNumber(value: any, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstDefined(...values: any[]): any {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function nanoToBigInt(value: any): bigint {
  if (value === undefined || value === null || value === '') return BigInt(0);
  try {
    return BigInt(String(value));
  } catch {
    return BigInt(0);
  }
}

export function normalizeClaudeOtlpLogs(
  body: any,
  opts: { receivedAt?: string; authenticatedUser?: string } = {},
): ClaudeOtelEvent[] {
  const receivedAt = opts.receivedAt || new Date().toISOString();
  const events: ClaudeOtelEvent[] = [];
  const resourceLogs = Array.isArray(body?.resourceLogs) ? body.resourceLogs : [];

  for (const resourceLog of resourceLogs) {
    const resource = otelAttrsToObject(resourceLog?.resource?.attributes || []);
    const scopeLogs = Array.isArray(resourceLog?.scopeLogs) ? resourceLog.scopeLogs : [];

    for (const scopeLog of scopeLogs) {
      const logRecords = Array.isArray(scopeLog?.logRecords) ? scopeLog.logRecords : [];
      for (const logRecord of logRecords) {
        const attributes = otelAttrsToObject(logRecord?.attributes || []);
        const parsedBody = parseLogBody(logRecord?.body);
        const eventName = normalizeEventName(attributes['event.name'], parsedBody);
        const sessionId = asOptionalString(attributes['session.id']) ||
          asOptionalString(resource['session.id']) ||
          asOptionalString(resource['service.instance.id']);
        if (!sessionId) continue;

        events.push({
          receivedAt,
          eventName,
          eventTimestamp: asOptionalString(attributes['event.timestamp']),
          sequence: asOptionalNumber(attributes['event.sequence']),
          sessionId,
          promptId: asOptionalString(attributes['prompt.id']),
          user: opts.authenticatedUser ||
            asOptionalString(attributes['user.email']) ||
            asOptionalString(resource['user.email']) ||
            asOptionalString(attributes['user.id']) ||
            asOptionalString(resource['user.id']),
          resource,
          attributes,
          body: parsedBody,
          traceId: asOptionalString(logRecord?.traceId),
          spanId: asOptionalString(logRecord?.spanId),
        });
      }
    }
  }

  return events;
}

export type SpanClassification = {
  recognized: boolean;
  skip: boolean;
  kind: 'llm' | 'tool' | 'agent';
  degraded: boolean;
};

/**
 * 识别 span 的分类：标准 GenAI/工具 span、openclaw 语义 span、生命周期 span、降级 span。
 *
 * 检测层次：
 * 1. gen_ai.span.kind（LLM→llm, TOOL→tool, AGENT/ENTRY→agent boundary）
 * 2. gen_ai.* / llm.* 前缀（既有标准检测）
 * 3. tool.name 存在
 * 4. span 命名（chat→llm, execute_tool→tool, invoke_agent→agent）
 * 5. 生命周期 span（session_start/end, gateway_start/stop, enter_openclaw_system）→ skip
 * 6. 其他有效调用但无标准语义 → degraded
 */
function classifyOtelSpan(span: any, attributes: Record<string, any>): SpanClassification {
  const name = (span?.name || '').toLowerCase();
  const spanKind = attributes['gen_ai.span.kind'];
 
  // 生命周期 / 基础设施 span（openclaw 特有）
  const lifecyclePatterns = [
    'session_start', 'session_end', 'session.start', 'session.end',
    'gateway_start', 'gateway_stop', 'gateway.start', 'gateway.stop',
    'enter_openclaw_system',
  ];
  if (lifecyclePatterns.includes(name)) {
    return { recognized: false, skip: true, kind: 'llm', degraded: false };
  }

  // gen_ai.span.kind 检测（openclaw 插件路径、aliyun exporter）
  if (spanKind) {
    const sk = String(spanKind).toLowerCase();
    if (sk === 'llm') return { recognized: true, skip: false, kind: 'llm', degraded: false };
    if (sk === 'tool') return { recognized: true, skip: false, kind: 'tool', degraded: false };
    if (sk === 'agent' || sk === 'entry') {
      return { recognized: true, skip: false, kind: 'agent', degraded: false };
    }
  }

  // span 命名检测（补充 openclaw 内置导出路径）
  if (name === 'chat') return { recognized: true, skip: false, kind: 'llm', degraded: false };
  if (name === 'execute_tool') return { recognized: true, skip: false, kind: 'tool', degraded: false };
  if (name === 'invoke_agent') {
    return { recognized: true, skip: false, kind: 'agent', degraded: false };
  }

  // 标准 GenAI 属性前缀检测（既有逻辑）
  const hasGenAiPrefix = Object.keys(attributes).some(k => k.startsWith('gen_ai.') || k.startsWith('llm.'));
  if (hasGenAiPrefix) {
    return { recognized: true, skip: false, kind: 'llm', degraded: false };
  }

  // tool.name 存在
  if (attributes['tool.name'] !== undefined) {
    return { recognized: true, skip: false, kind: 'tool', degraded: false };
  }

  // 有效调用但无标准语义 → 降级保留
  if (span?.traceId || span?.spanId) {
    // 有 trace/span id 的结构化 span，可能携带了有效信息
    return { recognized: false, skip: false, kind: 'llm', degraded: true };
  }

  // 无法识别的 span → 跳过
  return { recognized: false, skip: true, kind: 'llm', degraded: false };
}

export function normalizeClaudeOtlpTraces(
  body: any,
  opts: { receivedAt?: string; authenticatedUser?: string } = {},
): OtelTraceEvent[] {
  const receivedAt = opts.receivedAt || new Date().toISOString();
  const events: OtelTraceEvent[] = [];
  const resourceSpans = Array.isArray(body?.resourceSpans) ? body.resourceSpans : [];

  for (const resourceSpan of resourceSpans) {
    const resource = otelAttrsToObject(resourceSpan?.resource?.attributes || []);
    const serviceName = asOptionalString(resource['service.name']) || 'unknown-service';
    const resourceUser = opts.authenticatedUser ||
      asOptionalString(resource['user.id']) ||
      asOptionalString(resource['enduser.id']);
    const serviceInstanceId = asOptionalString(resource['service.instance.id']);
    const resourceSessionId = firstOptionalString(
      resource['session.id'],
      resource['session_id'],
      resource['hermes.session_id'],
    );
    const scopeSpans = Array.isArray(resourceSpan?.scopeSpans) ? resourceSpan.scopeSpans : [];

    for (const scopeSpan of scopeSpans) {
      const spans = Array.isArray(scopeSpan?.spans) ? scopeSpan.spans : [];
      for (const span of spans) {
        try {
          const attributes = otelAttrsToObject(span?.attributes || []);
          const classification = classifyOtelSpan(span, attributes);

          // 跳过生命周期 / 基础设施 span
          if (classification.skip) continue;

          const traceId = asOptionalString(span?.traceId);
          const explicitSessionId = firstOptionalString(
            resourceSessionId,
            attributes['session.id'],
            attributes['session_id'],
            attributes['hermes.session_id'],
            attributes['correlation.id'],
          );
          let sessionId = explicitSessionId || serviceInstanceId || traceId;
          if (sessionId === 'unknown' && traceId) sessionId = traceId;
          if (!sessionId) continue;

          const inputTokens = asNumber(firstDefined(
            attributes['gen_ai.usage.input_tokens'],
            attributes['llm.usage.prompt_tokens'],
            attributes['llm.token_count.prompt'],
          ));
          const outputTokens = asNumber(firstDefined(
            attributes['gen_ai.usage.output_tokens'],
            attributes['llm.usage.completion_tokens'],
            attributes['llm.token_count.completion'],
          ));
          const reasoningTokens = asNumber(firstDefined(
            attributes['gen_ai.usage.reasoning_tokens'],
            attributes['llm.token_count.reasoning'],
          ));
          const explicitTotalTokens = asOptionalNumber(firstDefined(
            attributes['gen_ai.usage.total_tokens'],
            attributes['llm.usage.total_tokens'],
            attributes['llm.token_count.total'],
          ));
          const startTimeNano = nanoToBigInt(span?.startTimeUnixNano);
          const endTimeNano = nanoToBigInt(span?.endTimeUnixNano);
          const latencyMs = endTimeNano > startTimeNano
            ? Number((endTimeNano - startTimeNano) / BigInt(1_000_000))
            : 0;
          const startTimeMs = Number(startTimeNano / BigInt(1_000_000));

          // 降级标记
          const eventAttributes = { ...attributes };
          if (classification.degraded) {
            eventAttributes['_degraded'] = true;
          }

          events.push({
            receivedAt,
            sessionId,
            traceId,
            spanId: asOptionalString(span?.spanId),
            parentSpanId: asOptionalString(span?.parentSpanId),
            name: asOptionalString(span?.name),
            kind: classification.kind === 'tool' ? 'tool' : 'llm',
            serviceName,
            user: resourceUser,
            authenticatedUser: Boolean(opts.authenticatedUser),
            model: firstOptionalString(
              attributes['gen_ai.request.model'],
              attributes['llm.request.model'],
              attributes['llm.model_name'],
              attributes['gen_ai.response.model'],
            ),
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              reasoning_tokens: reasoningTokens || undefined,
              total_tokens: explicitTotalTokens ?? (inputTokens + outputTokens + reasoningTokens),
            },
            latencyMs,
            startTimeMs,
            attributes: eventAttributes,
          });
        } catch {}
      }
    }
  }

  return events;
}

export const normalizeOtlpLogs = normalizeClaudeOtlpLogs;
