import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseAuthHeaders,
  redactSource,
  summarizeAuthHeaders,
  toAuthHeadersJson,
} from '@/lib/infra/auth-headers';

test('parseAuthHeaders 解出 header 对象；非法输入一律给 {} 不抛', () => {
  assert.deepEqual(parseAuthHeaders('{"Authorization":"bearer abc"}'), { Authorization: 'bearer abc' });
  assert.deepEqual(parseAuthHeaders(null), {});
  assert.deepEqual(parseAuthHeaders(''), {});
  assert.deepEqual(parseAuthHeaders('not json'), {});
  assert.deepEqual(parseAuthHeaders('[1,2]'), {}); // 数组不是 header 对象
  assert.deepEqual(parseAuthHeaders('{"Authorization":123}'), {}); // 非字符串值丢弃
});

test('parseAuthHeaders 拒绝非法 header 名与空值（防注入/脏数据）', () => {
  assert.deepEqual(parseAuthHeaders('{"Bad Name":"x"}'), {}); // 名字里有空格 → 丢弃
  assert.deepEqual(parseAuthHeaders('{"Authorization":"   "}'), {}); // 值只有空白 → 丢弃
  assert.deepEqual(parseAuthHeaders('{"X-Apig-AppCode":"code1"}'), { 'X-Apig-AppCode': 'code1' });
});

test('parseAuthHeaders 先清洗再校验：粘贴带进来的首尾空白/换行被剥掉，不会注入', () => {
  // 换行被 trim 掉后是合法名字 → 保留清洗后的版本，而不是把换行原样带进请求头
  assert.deepEqual(parseAuthHeaders('{"X-Inject\\n":"x"}'), { 'X-Inject': 'x' });
  assert.deepEqual(parseAuthHeaders('{" Authorization ":" bearer abc\\n"}'), { Authorization: 'bearer abc' });
});

test('toAuthHeadersJson：字符串当作 Authorization 值（UI 单输入框）', () => {
  assert.equal(toAuthHeadersJson('bearer abc'), '{"Authorization":"bearer abc"}');
  assert.equal(toAuthHeadersJson('  bearer abc  '), '{"Authorization":"bearer abc"}');
});

test('toAuthHeadersJson：undefined=不改动、空串/null=清除', () => {
  assert.equal(toAuthHeadersJson(undefined), undefined);
  assert.equal(toAuthHeadersJson(''), null);
  assert.equal(toAuthHeadersJson('   '), null);
  assert.equal(toAuthHeadersJson(null), null);
});

test('toAuthHeadersJson：对象形态（未来多 header）与全非法对象', () => {
  assert.equal(
    toAuthHeadersJson({ Authorization: 'bearer a', 'X-Apig-AppCode': 'b' }),
    '{"Authorization":"bearer a","X-Apig-AppCode":"b"}',
  );
  assert.equal(toAuthHeadersJson({ 'Bad Name': 'x' }), null);
});

test('summarizeAuthHeaders 只给 keys/hasAuth，不含凭证真值', () => {
  const s = summarizeAuthHeaders('{"Authorization":"bearer super-secret"}');
  assert.deepEqual(s, { keys: ['Authorization'], hasAuth: true });
  assert.ok(!JSON.stringify(s).includes('super-secret'));
  assert.deepEqual(summarizeAuthHeaders(null), { keys: [], hasAuth: false });
});

test('redactSource 把 authHeaders 换成摘要，凭证不出现在返回体里', () => {
  const row = {
    id: 'src1',
    endpoint: 'https://gw/spark/qwen35',
    scrapeUrl: 'https://gw/spark/qwen35/metrics',
    authHeaders: '{"Authorization":"bearer super-secret"}',
  };
  const out = redactSource(row);
  assert.equal('authHeaders' in out, false);
  assert.deepEqual(out.auth, { keys: ['Authorization'], hasAuth: true });
  assert.equal(out.endpoint, 'https://gw/spark/qwen35');
  assert.ok(!JSON.stringify(out).includes('super-secret'));
});
