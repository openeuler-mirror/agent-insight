import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as logging from '../src/lib/logger';

function fixture(level?: string) {
  const env = { ...process.env };
  delete process.env.LOG_LEVEL;
  if (level) process.env.AGENT_INSIGHT_LOG_LEVEL = level;
  else delete process.env.AGENT_INSIGHT_LOG_LEVEL;
  const entries: Array<{ level: string; args: unknown[] }> = [];
  const target = Object.fromEntries(['debug', 'log', 'info', 'warn', 'error'].map(level => [level,
    (...args: unknown[]) => entries.push({ level, args }),
  ])) as unknown as Pick<Console, 'debug' | 'log' | 'info' | 'warn' | 'error'>;
  return { entries, target, restore() { process.env = env; } };
}

test('production defaults to error; explicit levels and legacy LOG_LEVEL are resolved consistently', () => {
  const f = fixture();
  try {
    assert.equal(logging.getLoggerConfig().level, 'error');
    process.env.LOG_LEVEL = 'warn';
    assert.equal(logging.getLoggerConfig().level, 'warn');
    process.env.AGENT_INSIGHT_LOG_LEVEL = ' DEBUG ';
    assert.equal(logging.getLoggerConfig().level, 'debug');
    process.env.AGENT_INSIGHT_LOG_LEVEL = 'invalid';
    assert.equal(logging.getLoggerConfig().level, 'error');
    process.env.AGENT_INSIGHT_LOG_LEVEL = 'log';
    assert.equal(logging.getLoggerConfig().level, 'info');
  } finally { f.restore(); }
});

test('server console gating is idempotent and errors remain visible', () => {
  const f = fixture();
  try {
    assert.equal(typeof logging.installServerLogging, 'function');
    logging.installServerLogging(f.target);
    logging.installServerLogging(f.target);
    for (const level of ['debug', 'log', 'info', 'warn', 'error'] as const) f.target[level]('message');
    assert.deepEqual(f.entries.map(x => x.level), ['error']);
    process.env.AGENT_INSIGHT_LOG_LEVEL = 'info';
    f.target.info('information');
    f.target.debug('hidden');
    assert.equal(f.entries.at(-1)?.args[0], 'information');
  } finally { f.restore(); }
});

test('debug retains every correlated event and repeated error without a global sample budget', () => {
  const f = fixture('debug');
  try {
    assert.equal(typeof logging.installServerLogging, 'function');
    logging.installServerLogging(f.target);
    for (let i = 0; i < 1500; i++) {
      f.target.debug('[TraceTiming]', { traceId: String(i), stage: 'execution-upsert', durationMs: i });
      f.target.error('database failed', { traceId: String(i), code: 'P1008' });
    }
    assert.equal(f.entries.length, 3000);
    assert.match(String(f.entries.at(-1)?.args[0]), /1499/);
  } finally { f.restore(); }
});

test('console redacts credentials and bodies, supports Error/cycles/bigint, and contains sink failures', () => {
  const f = fixture('debug');
  try {
    assert.equal(typeof logging.installServerLogging, 'function');
    logging.installServerLogging(f.target);
    const value: any = { apiKey: 'SECRET_KEY', headers: { authorization: 'Bearer SECRET_AUTH' }, prompt: 'SECRET_PROMPT', traceId: 'abc', count: 1n };
    value.self = value;
    f.target.error('failed', value, Object.assign(new Error('password=SECRET_PASSWORD'), { code: 'P1008' }));
    f.target.debug('[old] {"api_key":"SECRET_JSON","stage":"decode"}');
    const output = f.entries.map(x => x.args.join(' ')).join('\n');
    assert.doesNotMatch(output, /SECRET_/);
    assert.match(output, /P1008/);
    assert.match(output, /abc/);
    const broken = { ...f.target, error(..._args: unknown[]) { throw new Error('sink broken'); } };
    logging.installServerLogging(broken);
    assert.doesNotThrow(() => broken.error('important'));
  } finally { f.restore(); }
});

test('file logger uses the same threshold and sanitization as console', () => {
  const f = fixture('error');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-log-test-'));
  const original = console.error;
  console.error = (...args) => f.entries.push({ level: 'error', args });
  process.env.AGENT_INSIGHT_LOG_DIR = dir;
  try {
    const logger = logging.createLogger('test');
    logger.info('hidden');
    logger.error('visible', { password: 'SECRET_FILE', traceId: 'retained' });
    const file = fs.readFileSync(path.join(dir, 'agent-insight.log'), 'utf8');
    assert.doesNotMatch(file, /hidden|SECRET_FILE/);
    assert.match(file, /retained/);
    assert.equal(f.entries.length, 1);
  } finally { console.error = original; f.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('large nested context is bounded and explicitly marked without hiding later events', () => {
  const f = fixture('debug');
  try {
    logging.installServerLogging(f.target);
    const large = Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => ({ detail: 'x'.repeat(1000) })));
    f.target.debug('large', large);
    f.target.error('next event', { code: 'P1008' });
    const first = String(f.entries[0].args[0]);
    assert.ok(first.length < 70_000, String(first.length));
    assert.match(first, /TRUNCATED/);
    assert.match(String(f.entries[1].args[0]), /P1008/);
  } finally { f.restore(); }
});

test('legacy raw-body arguments and query fields echoed by database errors are redacted', () => {
  const f = fixture('debug');
  try {
    logging.installServerLogging(f.target);
    f.target.error('Raw Body:', 'SECRET_PLAIN_BODY');
    f.target.debug('query=SECRET_QUERY_WORDS with spaces, answer=SECRET_ANSWER');
    f.target.error(new Error('Invalid invocation:\n{\n query: "SECRET_DB_QUERY",\n finalResult: "SECRET_DB_RESULT"\n}\nArgument foo is missing'));
    f.target.debug('context', { outputPreview: 'SECRET_PREVIEW', LANGFUSE_SECRET_KEY: 'SECRET_CREDENTIAL' });
    const output = f.entries.map(x => x.args.join(' ')).join('\n');
    assert.doesNotMatch(output, /SECRET_(?:PLAIN|QUERY|ANSWER|DB|PREVIEW|CREDENTIAL)/);
    assert.match(output, /Argument foo is missing/);
  } finally { f.restore(); }
});

test('JSON parser source excerpts are omitted from console and file error details', () => {
  const f = fixture('debug');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-log-parse-test-'));
  const original = console.error;
  console.error = (...args) => f.entries.push({ level: 'error', args });
  process.env.AGENT_INSIGHT_LOG_DIR = dir;
  try {
    logging.installServerLogging(f.target);
    let failure: unknown;
    try { JSON.parse('SECRET_PARSE_SOURCE'); } catch (error) { failure = error; }
    assert.ok(failure instanceof SyntaxError);
    f.target.error('model parse failed', failure);
    logging.createLogger('model').error('parse failed', { error: failure });
    const output = f.entries.map(entry => entry.args.join(' ')).join('\n')
      + fs.readFileSync(path.join(dir, 'agent-insight.log'), 'utf8');
    assert.doesNotMatch(output, /SECRET_/);
    assert.match(output, /SyntaxError/);
    assert.match(output, /source excerpt omitted/);
  } finally { console.error = original; f.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});
