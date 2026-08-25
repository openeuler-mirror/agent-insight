import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const pageSource = fs.readFileSync(
  path.join(process.cwd(), 'src/app/(main)/skill-opt/[name]/[version]/page.tsx'),
  'utf8',
);
const styleSource = fs.readFileSync(
  path.join(process.cwd(), 'src/app/(main)/skill-opt/skill-opt.css'),
  'utf8',
);

test('Skill 优化对话发送会发起真实优化请求', () => {
  const sendMessage = pageSource.match(
    /const sendMessage = \(\) => \{(?<body>[\s\S]*?)\n\s*\};/,
  )?.groups?.body;

  assert.ok(sendMessage, '应保留 sendMessage 交互入口');
  assert.match(sendMessage, /startOptimize\(\{\s*feedbackText:\s*message\s*\}\)/);
  assert.doesNotMatch(sendMessage, /setChat\(/, '发送不应只追加本地消息');
});

test('Skill 优化在会话或基线未就绪时禁用全部提交入口', () => {
  assert.match(
    pageSource,
    /const optimizationReady\s*=\s*Boolean\(currentSessionId\)\s*&&\s*Boolean\(baselineFiles\)\s*&&\s*!baselineLoading/,
  );
  assert.match(pageSource, /className="skopt-oneclick-btn"[\s\S]*?disabled=\{[\s\S]*?!optimizationReady/);
  assert.match(pageSource, /onClick=\{\(\) => startOptimize\(\)\}[\s\S]*?disabled=|disabled=\{[\s\S]*?!optimizationReady[\s\S]*?onClick=\{\(\) => startOptimize\(\)\}/);
  assert.match(pageSource, /<button[^>]*disabled=\{[\s\S]*?!optimizationReady[\s\S]*?onClick=\{sendMessage\}/);
  assert.match(pageSource, /role="alert"[\s\S]*?sessionError/);
});

test('Skill 优化的短用户消息气泡按内容收缩', () => {
  const userBubble = styleSource.match(
    /\.skopt-middle \.msg\.user\s*\{(?<body>[\s\S]*?)\}/,
  )?.groups?.body;

  assert.ok(userBubble, '应保留用户消息气泡样式');
  assert.match(userBubble, /width:\s*fit-content;/);
  assert.match(userBubble, /max-width:\s*78%;/);
});
