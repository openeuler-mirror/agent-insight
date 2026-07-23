import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('does not expose detector provenance as a user-visible finding tag', () => {
  const card = fs.readFileSync(
    path.join(process.cwd(), 'src', 'components', 'observe', 'AgentDebugCard.tsx'),
    'utf8',
  );
  assert.doesNotMatch(card, /专项发现|Specialized finding/);
  assert.match(card, /AgentDebugSupplementalEvidenceBlock/);
  assert.match(card, /relatedFinding=\{findings\.find/);
});
