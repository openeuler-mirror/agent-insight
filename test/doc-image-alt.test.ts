import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { collectImages, altProblem, auditDocumentation } from '../scripts/check-doc-image-alt.mjs';

test('parses inline, reference, escaped and multiline images without scanning code examples', () => {
  const source = [
    '![组件\\[A\\]与存储](a.png "title")',
    '![安装结果][setup]',
    '',
    '[setup]: ./setup.png',
    '<img\n src="topo.png"\n alt="节点 &amp; 存储">',
    '`![](inline.png)`',
    '```markdown',
    '![](example.png)',
    '<img src="example2.png">',
    '```',
    '<!-- <img src="comment.png"> -->',
  ].join('\n');
  const images = collectImages(source);
  assert.deepEqual(images.map(i => [i.src, i.alt, i.line]), [
    ['a.png', '组件[A]与存储', 1], ['./setup.png', '安装结果', 2],
    ['topo.png', '节点 & 存储', 5],
  ]);
});

test('HTML attributes support single quotes, unquoted values, case and missing alt', () => {
  assert.deepEqual(collectImages('<IMG SRC=a.png ALT=架构>\n<img src="b.png" alt=\'配置\'>\n<img src=c.png>')
    .map(i => i.alt), ['架构', '配置', undefined]);
});

test('Markdown rendering preserves descriptive alt and escapes attribute characters', () => {
  const html = renderToStaticMarkup(createElement(Markdown, {}, '![节点 "A" & 存储](./topo.png)'));
  assert.match(html, /alt="节点 &quot;A&quot; &amp; 存储"/);
  assert.equal(collectImages(html)[0].alt, '节点 "A" & 存储');
});

test('rejects missing, whitespace, generic, numbered and generated filename placeholders', () => {
  assert.equal(altProblem(undefined), 'missing-alt');
  assert.equal(altProblem(' \n '), 'empty-alt');
  for (const value of ['img', 'IMAGE', '图1', 'Figure 2', 'zh-cn_image_000123', 'topo.PNG']) {
    assert.equal(altProblem(value), 'placeholder-alt', value);
  }
  assert.equal(altProblem('链路详情展示调用层级与耗时'), null);
  assert.equal(altProblem('Agent Insight'), null);
});

test('decorative exceptions require exact file/source, a reason and an actually empty alt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-alt-'));
  try {
    fs.mkdirSync(path.join(root, 'docs/zh'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs/en'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/zh/test.md'), '![](spacer.svg)\n<img src="missing.png">');
    const manifest = path.join(root, 'docs/image-alt-decorative.json');
    fs.writeFileSync(manifest, JSON.stringify([{ file: 'docs/zh/test.md', src: 'spacer.svg', reason: '分隔线' }]));
    assert.deepEqual(auditDocumentation(root).errors.map(e => e.problem), ['missing-alt']);
    fs.writeFileSync(manifest, JSON.stringify([{ file: 'docs/zh/test.md', src: 'missing.png', reason: '装饰' }]));
    assert.deepEqual(auditDocumentation(root).errors.map(e => e.problem),
      ['empty-alt', 'missing-alt', 'unused-or-invalid-decorative-exception']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects bare numeric labels while preserving descriptions containing numbers', () => {
  for (const alt of ['123', '0', '001', ' 123 ', '１２３']) {
    assert.equal(altProblem(alt), 'placeholder-alt', alt);
  }
  for (const alt of ['3 个计算节点连接存储节点', '第 2 步：配置模型供应商', '2026 年各月份调用量对比']) {
    assert.equal(altProblem(alt), null, alt);
  }
});

test('documentation audit flags numeric Markdown and HTML alt without flagging descriptive numbers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-alt-numeric-'));
  try {
    fs.mkdirSync(path.join(root, 'docs/zh'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs/en'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/image-alt-decorative.json'), '[]');
    fs.writeFileSync(path.join(root, 'docs/zh/test.md'), [
      '![123](diagram.png)',
      '<img src="setup.png" alt="１２３">',
      '![3 个计算节点连接存储节点](nodes.png)',
    ].join('\n\n'));
    const report = auditDocumentation(root);
    assert.equal(report.images.length, 3);
    assert.deepEqual(report.errors.map(error => [error.src, error.problem]), [
      ['diagram.png', 'placeholder-alt'], ['setup.png', 'placeholder-alt'],
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('all Chinese and English documentation images retain meaningful alt text', () => {
  const report = auditDocumentation(path.resolve(import.meta.dirname, '..'));
  assert.ok(report.images.length > 0);
  assert.deepEqual(report.errors, []);
});
