import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { parseFragment } from 'parse5';

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

export function collectImages(source) {
  const tree = unified().use(remarkParse).parse(source);
  const definitions = new Map();
  walk(tree, node => {
    if (node.type === 'definition') definitions.set(node.identifier, node.url);
  });
  const images = [];
  walk(tree, node => {
    if (node.type === 'image' || node.type === 'imageReference') {
      images.push({ src: node.url ?? definitions.get(node.identifier), alt: node.alt,
        line: node.position.start.line, kind: 'markdown' });
    }
    if (node.type !== 'html') return;
    const fragment = parseFragment(node.value, { sourceCodeLocationInfo: true });
    function visit(element) {
      if (['code', 'pre', 'script', 'style'].includes(element.tagName)) return;
      if (element.tagName === 'img') {
        const attrs = Object.fromEntries(element.attrs.map(attr => [attr.name, attr.value]));
        images.push({ src: attrs.src, alt: attrs.alt,
          line: node.position.start.line + element.sourceCodeLocation.startLine - 1, kind: 'html' });
      }
      for (const child of element.childNodes ?? []) visit(child);
    }
    visit(fragment);
  });
  return images;
}

export function altProblem(alt) {
  if (alt === undefined) return 'missing-alt';
  const text = alt.trim();
  if (!text) return 'empty-alt';
  if (/^\p{Decimal_Number}+$/u.test(text)
    || /^(?:img|image|picture|photo|screenshot|图片|图像|截图|图)\s*\d*$/iu.test(text)
    || /^(?:图|figure|fig\.?)\s*\d+(?:[.\-]\d+)*$/iu.test(text)
    || /^zh[-_]cn[-_]image[_-]/iu.test(text)
    || /\.(?:png|jpe?g|gif|svg|webp|bmp|avif)$/iu.test(text)) return 'placeholder-alt';
  return null;
}

export function auditDocumentation(root) {
  const docs = path.join(root, 'docs');
  const exceptions = JSON.parse(fs.readFileSync(path.join(docs, 'image-alt-decorative.json'), 'utf8'));
  if (!Array.isArray(exceptions)) throw new Error('Decorative image exceptions must be an array');
  const used = new Set(), images = [], errors = [];
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) scan(absolute);
      else if (/\.mdx?$/i.test(entry.name)) {
        const file = path.relative(root, absolute).split(path.sep).join('/');
        for (const image of collectImages(fs.readFileSync(absolute, 'utf8'))) {
          const item = { file, ...image };
          images.push(item);
          const problem = altProblem(image.alt);
          const index = exceptions.findIndex(e => e.file === file && e.src === image.src);
          if (problem === 'empty-alt' && index >= 0 && exceptions[index].reason?.trim()) used.add(index);
          else if (problem) errors.push({ ...item, problem });
        }
      }
    }
  }
  for (const language of ['zh', 'en']) scan(path.join(docs, language));
  exceptions.forEach((entry, index) => {
    if (!used.has(index)) errors.push({ file: entry.file, src: entry.src, problem: 'unused-or-invalid-decorative-exception' });
  });
  return { images, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const report = auditDocumentation(root);
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    for (const error of report.errors) console.error(`${error.file}:${error.line ?? 1}: ${error.problem} (${error.src ?? 'unresolved image'})`);
    console.log(`Checked ${report.images.length} documentation images; ${report.errors.length} errors.`);
  }
  process.exitCode = report.errors.length ? 1 : 0;
}
