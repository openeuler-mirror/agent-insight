import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getOtelTraceSpoolDir } from './spool';
import type { DecodedOtlpRequest } from './decode';

export type ActrailRawOtlpRecord = {
  receivedAt: string;
  requestId: string;
  contentType: string;
  encoding: 'json' | 'protobuf';
  sha256: string;
  sessions: string[];
  authenticatedUser?: string;
  rawBodyText?: string;
  rawBodyBase64?: string;
};

function dayString(receivedAt: string): string {
  const date = new Date(receivedAt);
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function getActrailRawOtlpSpoolFile(
  receivedAt: string,
  spoolDir = getOtelTraceSpoolDir(),
): string {
  return path.join(spoolDir, 'raw', 'actrail', dayString(receivedAt), 'requests.jsonl');
}

export function listActrailRawOtlpSpoolFiles(
  spoolDir = getOtelTraceSpoolDir(),
): string[] {
  const root = path.join(spoolDir, 'raw', 'actrail');
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, 'requests.jsonl'))
      .filter((file) => fs.existsSync(file))
      .sort();
  } catch {
    return [];
  }
}

export function appendActrailRawOtlpRequest(
  decoded: DecodedOtlpRequest,
  options: {
    receivedAt: string;
    sessions: string[];
    authenticatedUser?: string;
    spoolDir?: string;
  },
): ActrailRawOtlpRecord {
  const rawBuffer = Buffer.from(decoded.rawBody);
  const record: ActrailRawOtlpRecord = {
    receivedAt: options.receivedAt,
    requestId: crypto.randomUUID(),
    contentType: decoded.contentType,
    encoding: decoded.encoding,
    sha256: crypto.createHash('sha256').update(rawBuffer).digest('hex'),
    sessions: [...new Set(options.sessions.filter(Boolean))],
    authenticatedUser: options.authenticatedUser,
    ...(decoded.encoding === 'json'
      ? { rawBodyText: rawBuffer.toString('utf8') }
      : { rawBodyBase64: rawBuffer.toString('base64') }),
  };
  const file = getActrailRawOtlpSpoolFile(options.receivedAt, options.spoolDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return record;
}
