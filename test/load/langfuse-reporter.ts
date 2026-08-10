/**
 * Langfuse OTLP 压测上报器。
 *
 * 构造与 Langfuse SDK 同形态的 OTLP/JSON trace 上报，以固定速率打到
 * /api/ingest/otel/v1/traces。每个 trace 的 traceId 即 sessionId 即 Execution.taskId，
 * 因此可以用 traceId 直接做端到端漏斗核验。
 *
 * 速率是"应发未发补齐"式的：即使服务端在聚合期间阻塞事件循环，发送侧也不会跟着塌下来，
 * 保证输入压力恒定 —— 否则被测系统一慢，输入跟着变慢，积压现象会被自己掩盖。
 *
 * 用法：
 *   node --import tsx test/load/langfuse-reporter.ts
 * 环境变量见下方 CONFIG。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CONFIG = {
  target: process.env.LOAD_TARGET || 'http://127.0.0.1:3100/api/ingest/otel/v1/traces',
  // 凭据不给默认值：压测器要打的是真实鉴权端点，硬编码一个形似密钥的字符串没必要也不合适。
  publicKey: process.env.LOAD_PUBLIC_KEY || '',
  secretKey: process.env.LOAD_SECRET_KEY || '',
  ratePerSec: Number(process.env.LOAD_RATE || 30),
  durationSec: Number(process.env.LOAD_DURATION || 180),
  spansPerTrace: Number(process.env.LOAD_SPANS || 5),
  padBytes: Number(process.env.LOAD_PAD_BYTES || 1500),
  maxInflight: Number(process.env.LOAD_MAX_INFLIGHT || 200),
  outDir: process.env.LOAD_OUT || path.join(process.cwd(), 'load-results'),
};

if (!CONFIG.publicKey || !CONFIG.secretKey) {
  console.error('需要 LOAD_PUBLIC_KEY / LOAD_SECRET_KEY（对应目标实例上某个用户的 username / apiKey）');
  process.exit(1);
}

fs.mkdirSync(CONFIG.outDir, { recursive: true });
const sentStream = fs.createWriteStream(path.join(CONFIG.outDir, 'sent-traces.jsonl'), { flags: 'a' });
const statsStream = fs.createWriteStream(path.join(CONFIG.outDir, 'reporter-stats.jsonl'), { flags: 'a' });

const authHeader = `Basic ${Buffer.from(`${CONFIG.publicKey}:${CONFIG.secretKey}`).toString('base64')}`;
const PAD = 'x'.repeat(Math.max(0, CONFIG.padBytes));

function hex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function attr(key: string, value: string) {
  return { key, value: { stringValue: value } };
}

/** 一条 trace = 1 个 root span + N-1 个子 span，形态对齐 Langfuse + LangGraph 集成。 */
function buildTraceBody(traceId: string, nowMs: number) {
  const rootSpanId = hex(8);
  const spans: any[] = [];

  const startNano = (ms: number) => String(BigInt(Math.floor(ms)) * BigInt(1_000_000));

  spans.push({
    traceId,
    spanId: rootSpanId,
    name: 'agent_graph',
    kind: 1,
    startTimeUnixNano: startNano(nowMs - 4200),
    endTimeUnixNano: startNano(nowMs),
    attributes: [
      attr('langfuse.internal.is_app_root', 'true'),
      attr('langfuse.observation.type', 'chain'),
      attr('langfuse.trace.metadata.ls_integration', 'langgraph'),
      attr('langfuse.trace.metadata.session_id', traceId),
      attr('langfuse.observation.input', JSON.stringify({ question: `压测请求 ${traceId.slice(0, 8)}`, context: PAD })),
      attr('langfuse.observation.output', JSON.stringify({ answer: '压测回答', detail: PAD })),
      attr('langfuse.observation.level', 'DEFAULT'),
    ],
  });

  for (let i = 1; i < CONFIG.spansPerTrace; i += 1) {
    const isLlm = i % 2 === 1;
    spans.push({
      traceId,
      spanId: hex(8),
      parentSpanId: rootSpanId,
      name: isLlm ? 'ChatOpenAI' : 'search_tool',
      kind: 1,
      startTimeUnixNano: startNano(nowMs - 4000 + i * 600),
      endTimeUnixNano: startNano(nowMs - 4000 + i * 600 + 520),
      attributes: [
        attr('langfuse.observation.type', isLlm ? 'generation' : 'tool'),
        attr('langfuse.observation.model.name', 'gpt-4o-mini'),
        attr('langfuse.observation.usage_details', JSON.stringify({ input: 1200, output: 340, total: 1540 })),
        attr('langfuse.observation.input', JSON.stringify({ messages: [{ role: 'user', content: PAD }] })),
        attr('langfuse.observation.output', JSON.stringify({ content: PAD.slice(0, Math.floor(PAD.length / 2)) })),
        attr('langfuse.observation.metadata.ls_integration', 'langgraph'),
      ],
    });
  }

  return {
    resourceSpans: [{
      resource: { attributes: [attr('service.name', 'langfuse-loadtest')] },
      scopeSpans: [{ scope: { name: 'langfuse-sdk', version: '3.0.0' }, spans }],
    }],
  };
}

let sent = 0;
let ok = 0;
let failed = 0;
let dropped = 0;
let inflight = 0;
const latencies: number[] = [];

function dispatch(): void {
  if (inflight >= CONFIG.maxInflight) {
    dropped += 1;
    return;
  }
  const traceId = hex(16);
  const sentAt = Date.now();
  const body = JSON.stringify(buildTraceBody(traceId, sentAt));
  sent += 1;
  inflight += 1;
  sentStream.write(`${JSON.stringify({ traceId, sentAt })}\n`);

  fetch(CONFIG.target, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: authHeader },
    body,
  })
    .then((res) => {
      if (res.ok) ok += 1;
      else failed += 1;
      return res.arrayBuffer();
    })
    .catch(() => { failed += 1; })
    .finally(() => {
      inflight -= 1;
      latencies.push(Date.now() - sentAt);
    });
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

const startedAt = Date.now();
const intervalMs = 1000 / CONFIG.ratePerSec;
let scheduled = 0;
let lastReport = startedAt;
let lastSent = 0;

console.log(`[reporter] → ${CONFIG.target}  ${CONFIG.ratePerSec} trace/s × ${CONFIG.durationSec}s，每 trace ${CONFIG.spansPerTrace} span、约 ${Math.round((CONFIG.padBytes * 1.5 * CONFIG.spansPerTrace) / 1024)}KB`);

const timer = setInterval(() => {
  const now = Date.now();
  const elapsed = now - startedAt;
  const due = Math.floor(elapsed / intervalMs);
  while (scheduled < due) {
    dispatch();
    scheduled += 1;
  }

  if (now - lastReport >= 1000) {
    const window = latencies.splice(0, latencies.length);
    const line = {
      t: Math.round((now - startedAt) / 1000),
      sentTotal: sent,
      sentPerSec: sent - lastSent,
      ok,
      failed,
      dropped,
      inflight,
      httpP50: percentile(window, 0.5),
      httpP95: percentile(window, 0.95),
    };
    statsStream.write(`${JSON.stringify(line)}\n`);
    if (line.t % 15 === 0) {
      console.log(`[reporter] t=${line.t}s sent=${sent} ok=${ok} failed=${failed} dropped=${dropped} inflight=${inflight} httpP95=${line.httpP95}ms`);
    }
    lastReport = now;
    lastSent = sent;
  }

  if (elapsed >= CONFIG.durationSec * 1000) {
    clearInterval(timer);
    setTimeout(() => {
      console.log(`[reporter] 结束：应发 ${due} 实发 ${sent}，成功 ${ok}，失败 ${failed}，因背压丢弃 ${dropped}`);
      sentStream.end();
      statsStream.end();
      process.exit(0);
    }, 3000);
  }
}, 20);
