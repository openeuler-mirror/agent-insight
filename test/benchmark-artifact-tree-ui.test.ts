import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
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
