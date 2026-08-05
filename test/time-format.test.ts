import assert from 'node:assert/strict';
import test from 'node:test';

import { formatAbsoluteLocalTime } from '@/lib/time-format';

test('formatAbsoluteLocalTime renders a stable local date and time', () => {
    const date = new Date(2026, 6, 31, 14, 35, 22);
    assert.equal(formatAbsoluteLocalTime(date), '2026-07-31 14:35:22');
});

test('formatAbsoluteLocalTime rejects invalid dates', () => {
    assert.equal(formatAbsoluteLocalTime('not-a-date'), null);
});
