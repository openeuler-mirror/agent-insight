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

import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { BenchmarkArtifactContent } from '../src/components/eval/BenchmarkArtifactContent';
import { canPreviewBenchmarkArtifact, isMarkdownBenchmarkArtifact, resolveBenchmarkArtifactPreview } from '../src/lib/benchmark/presentation';
import { BenchmarkArtifactActions } from '../src/components/eval/BenchmarkArtifactActions';

test('benchmark evidence directories render as keyboard-accessible expandable folders with file actions', () => {
  const artifact = (name: string, mediaType = 'text/plain') => ({ name, kind: 'test-output', mediaType, sizeBytes: 0, contentUrl: '/artifact' });
  const html = renderToStaticMarkup(createElement(BenchmarkArtifactActions, {
    user: 'synthetic', submissions: [artifact('poc')],
    evidence: [artifact('evaluation.json', 'application/json'), artifact('judge-evidence/nested/vuln.stderr'), artifact('public-feedback/generator.json', 'application/json'), artifact('official-output.zip', 'application/zip')],
  }));
  assert.equal((html.match(/<details/g) || []).length, 3);
  assert.match(html, /<summary[^>]*>judge-evidence\//);
  assert.match(html, /<summary[^>]*>nested\//);
  assert.match(html, /<summary[^>]*>public-feedback\//);
  assert.match(html, /vuln.stderr/);
  assert.equal((html.match(/>查看<\/button>/g) || []).length, 4);
  assert.equal((html.match(/>下载<\/button>/g) || []).length, 5);
  assert.match(html, /0 B/);
});

test('flat SWE-bench artifacts keep their existing labels and actions without folders', () => {
  const artifact = (name: string, kind: string) => ({ name, kind, mediaType: 'text/plain', sizeBytes: 12, contentUrl: '/artifact' });
  const html = renderToStaticMarkup(createElement(BenchmarkArtifactActions, {
    user: 'synthetic', submissions: [artifact('model.patch', 'submission')],
    evidence: [artifact('report.json', 'official-report'), artifact('test_output.txt', 'test-output'), artifact('run_instance.log', 'harness-log')],
    presentation: { artifacts: [{ source: 'evidence', kind: 'official-report', label: '报告输出', order: 20 }] },
  }));
  assert.equal(html.includes('<details'), false);
  assert.match(html, /报告输出/);
  assert.match(html, /model.patch/);
  assert.match(html, /test_output.txt/);
  assert.match(html, /run_instance.log/);
});

test('evidence UI preserves Unicode names and distinguishes declared provenance from unverified kinds', () => {
  const artifact = (name: string, evidenceSource?: string) => ({ name, evidenceSource, kind: 'official-report', mediaType: 'application/json', sizeBytes: 2, contentUrl: '/artifact' })
  const html = renderToStaticMarkup(createElement(BenchmarkArtifactActions, {
    user: 'synthetic', submissions: [],
    evidence: [artifact('官方目录/测试 结果.json', 'official-file'), artifact('controller/stderr.log', 'platform'), artifact('legacy.json')],
  }))
  assert.match(html, /测试 结果.json/)
  assert.match(html, /官方文件（接入声明）/)
  assert.match(html, /平台诊断/)
  assert.match(html, /来源未声明/)
})


test('Markdown evidence is recognized by MIME or original filename, without guessing from other text', () => {
  for (const artifact of [
    { name: 'report.bin', mediaType: 'text/markdown; charset=utf-8' },
    { name: '原始目录/报告.MD', mediaType: 'text/plain' },
    { name: 'report.markdown', mediaType: 'application/octet-stream' },
  ]) {
    assert.equal(isMarkdownBenchmarkArtifact(artifact), true);
    assert.equal(canPreviewBenchmarkArtifact(artifact), true);
  }
  assert.equal(isMarkdownBenchmarkArtifact({ name: 'report.json', mediaType: 'application/json' }), false);
  assert.equal(isMarkdownBenchmarkArtifact({ name: 'report.md.log', mediaType: 'text/plain' }), false);
});

test('Markdown preview renders report structure while original view retains source text', () => {
  const content = '# 官方报告\n\n| 指标 | 结果 |\n| --- | --- |\n| 正确 | 是 |\n\n- 原始条目\n\n```python\nprint("原文")\n```\n';
  const preview = renderToStaticMarkup(createElement(BenchmarkArtifactContent, { content, renderer: 'markdown' }));
  assert.match(preview, /<h1>官方报告<\/h1>/);
  assert.match(preview, /<table>/);
  assert.match(preview, /<li>原始条目<\/li>/);
  assert.match(preview, /<code class="language-python">/);
  const raw = renderToStaticMarkup(createElement(BenchmarkArtifactContent, { content, renderer: 'text' }));
  assert.match(raw, /# 官方报告/);
  assert.match(raw, /\| 指标 \| 结果 \|/);
  assert.match(raw, /```python/);
  assert.equal(raw.includes('<h1>'), false);
});

test('Markdown preview does not activate embedded HTML or unsafe link protocols', () => {
  const content = '<script>alert(1)</script>\n\n<iframe src="https://example.com"></iframe>\n\n[unsafe](javascript:alert%281%29)\n\n[safe](https://example.com/report)';
  const html = renderToStaticMarkup(createElement(BenchmarkArtifactContent, { content, renderer: 'markdown' }));
  assert.doesNotMatch(html, /<script|<iframe|href="javascript:/);
  assert.match(html, /href="https:\/\/example.com\/report"/);
});

test('HTML, CSV and JSONL use shared format detection and expose a view action', () => {
  const files = [
    { name: 'report.HTML', mediaType: 'application/octet-stream', format: 'html', renderer: 'html' },
    { name: 'scores.dat', mediaType: 'TEXT/CSV; charset=utf-8', format: 'csv', renderer: 'csv' },
    { name: 'events.log', mediaType: 'application/x-ndjson', format: 'jsonl', renderer: 'text' },
    { name: 'trace.JSONL', mediaType: 'application/octet-stream', format: 'jsonl', renderer: 'text' },
  ];
  for (const { name, mediaType, format, renderer } of files) {
    assert.deepEqual(resolveBenchmarkArtifactPreview({ name, mediaType }), { format, renderer, load: 'text' });
  }
  const html = renderToStaticMarkup(createElement(BenchmarkArtifactActions, {
    user: 'synthetic', submissions: [],
    evidence: files.map(({ name, mediaType }) => ({ name, mediaType, sizeBytes: 1, kind: 'test-output', contentUrl: '/artifact' })),
  }));
  assert.equal((html.match(/>查看<\/button>/g) || []).length, files.length);
});

test('HTML allows inline scripts only inside the sandboxed frame', () => {
  const content = '<h1>报告</h1><script>window.parent.alert("unsafe")</script>';
  const html = renderToStaticMarkup(createElement(BenchmarkArtifactContent, { content, filename: 'report.html', renderer: 'html' }));
  assert.match(html, /<iframe[^>]*sandbox="allow-scripts"/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src &#x27;none&#x27;/);
  assert.match(html, /script-src &#x27;unsafe-inline&#x27;;/);
  assert.match(html, /&lt;h1&gt;报告&lt;\/h1&gt;/);
  assert.doesNotMatch(html, /<script/);
});

test('CSV preview keeps commas, escaped quotes and line breaks inside cells', () => {
  const content = '\uFEFFtask,details\r\n"case,1","line 1\nline ""2"""\r\n';
  const html = renderToStaticMarkup(createElement(BenchmarkArtifactContent, { content, renderer: 'csv' }));
  assert.match(html, /<th[^>]*>task<\/th>/);
  assert.match(html, /<td[^>]*>case,1<\/td>/);
  assert.match(html, /<td[^>]*>line 1\nline &quot;2&quot;<\/td>/);
});

test('JSONL uses the raw text view and preserves numeric values and malformed lines', () => {
  const content = '{"id":9007199254740993}\r\n\r\ninvalid JSON';
  const { renderer } = resolveBenchmarkArtifactPreview({ name: 'records.jsonl', mediaType: 'application/x-ndjson' });
  assert.equal(renderer, 'text');
  const html = renderToStaticMarkup(createElement(BenchmarkArtifactContent, { content, renderer }));
  assert.equal((html.match(/<pre/g) || []).length, 1);
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /9007199254740993/);
  assert.match(html, /invalid JSON/);
});
