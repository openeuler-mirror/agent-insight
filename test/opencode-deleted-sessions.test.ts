import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  addDeletedOpencodeSessionIds,
  isDeletedOpencodeSessionId,
} from '@/lib/ingest/opencode-deleted-sessions';

test('opencode deleted session tombstone persists ids and dedupes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-insight-deleted-sessions-'));
  const file = path.join(dir, 'deleted.json');
  const previous = process.env.SKILL_INSIGHT_OPENCODE_DELETED_SESSIONS;
  process.env.SKILL_INSIGHT_OPENCODE_DELETED_SESSIONS = file;

  try {
    assert.equal(isDeletedOpencodeSessionId('ses_old'), false);
    assert.equal(addDeletedOpencodeSessionIds(['ses_old', ' ', null, 'ses_old']), 1);
    assert.equal(isDeletedOpencodeSessionId('ses_old'), true);
    assert.equal(addDeletedOpencodeSessionIds(['ses_old', 'ses_new']), 1);
    assert.equal(isDeletedOpencodeSessionId('ses_new'), true);

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.sessionIds, ['ses_new', 'ses_old']);
  } finally {
    if (previous === undefined) {
      delete process.env.SKILL_INSIGHT_OPENCODE_DELETED_SESSIONS;
    } else {
      process.env.SKILL_INSIGHT_OPENCODE_DELETED_SESSIONS = previous;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
