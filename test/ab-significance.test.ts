import assert from 'node:assert/strict';
import test from 'node:test';

import { formatPValueLabel, welchTTestPValue } from '@/lib/skill-analysis/ab-significance';

test('welchTTestPValue returns a significant p-value for clearly separated samples', () => {
  const sampleA = [55, 58, 60, 57, 59, 56, 61, 58, 57, 60, 59, 56, 58, 57, 60, 59, 58, 57, 56, 60];
  const sampleB = [78, 80, 82, 79, 81, 77, 83, 80, 79, 82, 81, 78, 80, 79, 82, 81, 80, 79, 78, 82];

  const pValue = welchTTestPValue(sampleA, sampleB);

  assert.notEqual(pValue, null);
  assert.ok((pValue as number) < 0.01);
  assert.equal(formatPValueLabel(pValue), 'p < 0.01 ✓✓');
});

test('welchTTestPValue returns a non-significant p-value for similar samples', () => {
  const sampleA = [70, 72, 69, 71, 70, 73, 68, 71, 72, 69, 70, 71, 72, 70, 69, 71, 70, 72, 69, 71];
  const sampleB = [70, 71, 69, 72, 70, 72, 69, 70, 71, 69, 71, 70, 72, 69, 70, 71, 70, 71, 69, 72];

  const pValue = welchTTestPValue(sampleA, sampleB);

  assert.notEqual(pValue, null);
  assert.ok((pValue as number) > 0.05);
  assert.match(formatPValueLabel(pValue), /^p = 0\.\d{3}$/);
});

test('welchTTestPValue supports a single round per side', () => {
  assert.equal(welchTTestPValue([0], [0]), 1);
  assert.equal(welchTTestPValue([0], [80]), 0);
  assert.equal(formatPValueLabel(welchTTestPValue([0], [80])), 'p < 0.01 ✓✓');
});
