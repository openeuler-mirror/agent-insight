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

import fs from 'node:fs';
import { LiveRowParser } from './live-row';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { getFileCursor, toCheckpointRelPath } from './checkpoint';
import type { SpoolSource } from './sources';
import type { SpoolReceiptNotice } from './live-input';
import { readSpoolStateBySegment, safeSpoolSegment } from '@/lib/runtime-cleanup/spool-state';

const SCAN_STEPS = 100;
const SCAN_MS = 50;
const READ_BYTES = 64 * 1024;
type Candidate = { source: SpoolSource; file: string };
type Reader = { source: SpoolSource; file: string; ino: number; position: number; consumed: number; buffer: Buffer; parser: LiveRowParser; ready?: { sessionId: string; receivedAt: number; bytes: number } };
type Accept = (candidate: Candidate, sessionId: string, bytes: number, receivedAt: number) => boolean;

function day(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function* liveScanDays(cutoff: number, now: number): Generator<string> {
  const current = day(new Date(now));
  yield current;
  const date = new Date(cutoff);
  date.setHours(0, 0, 0, 0);
  while (day(date) < current) {
    yield day(date);
    date.setDate(date.getDate() + 1);
  }
}

async function* walk(source: SpoolSource, directory: string, depth = 0): AsyncGenerator<Candidate | undefined> {
  let entries: fs.Dir;
  try { entries = await fsp.opendir(directory, { bufferSize: 1 }); }
  catch { yield undefined; return; }
  try {
    for await (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isFile() && (source.fileName ? entry.name === source.fileName : entry.name.endsWith('.jsonl'))) {
        yield { source, file };
      } else {
        yield undefined;
        if (entry.isDirectory() && depth < 2 && (depth > 0 || entry.name === 'sessions')) yield* walk(source, file, depth + 1);
      }
    }
  } finally { try { await entries.close(); } catch {} }
}

async function* scan(source: SpoolSource, cutoff: number, now: number) {
  for (const current of liveScanDays(cutoff, now)) yield* walk(source, path.join(source.spoolDir(), current));
}

export class LiveSpoolDiscovery {
  private stopped = false;
  private sourceIndex = 0;
  private iterators = new Map<string, AsyncGenerator<Candidate | undefined>>();
  private notices = new Map<string, SpoolReceiptNotice>();
  private readers = new Map<string, Reader>();
  private activeReader?: string;
  private remainingBytes = 0;
  private lastWarnAt = 0;

  constructor(private readonly sources: SpoolSource[], readonly cutoff: number, private readonly capacity: number,
    private readonly accept: Accept, private readonly now: () => number = Date.now, private readonly warn: (...args: any[]) => void = console.warn) {}

  receive(notice: SpoolReceiptNotice): void {
    if (this.stopped || notice.receivedAt < this.cutoff) return;
    const root = path.resolve(notice.root);
    if (!this.sources.some(source => path.resolve(source.spoolDir()) === root)) return;
    const key = `${root}\0${notice.sessionId}`;
    if (this.notices.has(key) || this.notices.size < this.capacity) this.notices.set(key, notice);
  }

  rewind(root: string, file: string): void {
    this.readers.delete(`${path.resolve(root)}:${toCheckpointRelPath(root, file)}`);
  }

  stop(): void {
    this.stopped = true;
    this.notices.clear();
    this.readers.clear();
    for (const iterator of this.iterators.values()) void iterator.return(undefined).catch(() => {});
    this.iterators.clear();
  }

  private async modern(candidate: Candidate, info: fs.Stats, sessionId?: string, receivedAt?: number): Promise<boolean> {
    if (this.stopped) return true;
    const root = candidate.source.spoolDir();
    const segment = path.basename(path.dirname(candidate.file));
    const receipt = readSpoolStateBySegment(root, segment);
    const timestamp = receivedAt ?? receipt?.lastReceivedAt;
    const key = sessionId ?? receipt?.key;
    if (!key || timestamp === undefined) return false;
    if (timestamp < this.cutoff) return true;
    const cursor = getFileCursor(root, toCheckpointRelPath(root, candidate.file));
    if (cursor.bytes >= info.size && receipt?.status !== 'unknown') return true;
    this.accept(candidate, key, info.size, timestamp);
    return true;
  }

  private async legacy(candidate: Candidate, info: fs.Stats, deadline: number): Promise<void> {
    const root = candidate.source.spoolDir();
    const key = `${path.resolve(root)}:${toCheckpointRelPath(root, candidate.file)}`;
    let reader = this.readers.get(key);
    if (!reader && this.remainingBytes <= 0) return;
    if (!reader || reader.ino !== info.ino || reader.position > info.size) {
      const saved = getFileCursor(root, toCheckpointRelPath(root, candidate.file)).bytes;
      const bytes = saved <= info.size ? saved : 0;
      reader = { ...candidate, ino: info.ino, position: bytes, consumed: bytes, buffer: Buffer.alloc(0), parser: new LiveRowParser() };
      while (this.readers.size >= Math.min(4, this.capacity)) this.readers.delete(this.readers.keys().next().value!);
      this.readers.set(key, reader);
    }
    if (reader.ready) {
      if (!this.accept(candidate, reader.ready.sessionId, reader.ready.bytes, reader.ready.receivedAt)) return;
      reader.ready = undefined;
    }
    if (!reader.buffer.length && reader.position < info.size && this.remainingBytes > 0) {
      const handle = await fsp.open(candidate.file, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(READ_BYTES, this.remainingBytes, info.size - reader.position));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, reader.position);
        this.remainingBytes -= bytesRead;
        if (this.stopped || this.readers.get(key) !== reader) return;
        reader.buffer = buffer.subarray(0, bytesRead);
        reader.position += bytesRead;
      } finally { await handle.close(); }
    }
    let index = 0;
    for (; index < reader.buffer.length && this.now() < deadline && !this.stopped; index++) {
      const byte = reader.buffer[index];
      reader.consumed++;
      if (byte !== 10) { reader.parser.push(byte); continue; }
      const event = reader.parser.finish();
      reader.parser = new LiveRowParser();
      if (event && event.receivedAt >= this.cutoff && !this.accept(candidate, event.sessionId, reader.consumed, event.receivedAt)) {
        reader.ready = { ...event, bytes: reader.consumed };
        index++;
        break;
      }
    }
    reader.buffer = reader.buffer.subarray(index);
    this.activeReader = !reader.ready && (reader.buffer.length > 0 || reader.position < info.size) ? key : undefined;
  }

  private async inspect(candidate: Candidate, deadline: number): Promise<void> {
    try {
      const info = await fsp.lstat(candidate.file);
      if (this.stopped || !info.isFile()) return;
      if (path.basename(path.dirname(path.dirname(candidate.file))) === 'sessions') {
        if (!await this.modern(candidate, info) && info.mtimeMs >= this.cutoff) await this.legacy(candidate, info, deadline);
      } else if (info.mtimeMs >= this.cutoff) {
        await this.legacy(candidate, info, deadline);
      }
    } catch {}
  }

  async tick(): Promise<void> {
    const deadline = this.now() + SCAN_MS;
    this.remainingBytes = READ_BYTES;
    let steps = 0;
    for (const [key, notice] of this.notices) {
      if (this.stopped || steps >= SCAN_STEPS / 2 || this.now() >= deadline) break;
      this.notices.delete(key);
      for (const source of this.sources) {
        if (path.resolve(source.spoolDir()) !== path.resolve(notice.root) || !source.fileName) continue;
        const file = path.join(source.spoolDir(), day(new Date(notice.receivedAt)), 'sessions', safeSpoolSegment(notice.sessionId), source.fileName);
        try {
          const info = await fsp.lstat(file);
          if (!this.stopped && info.isFile()) await this.modern({ source, file }, info, notice.sessionId, notice.receivedAt);
        } catch {}
      }
      steps++;
    }
    if (this.activeReader && !this.stopped && this.now() < deadline) {
      const reader = this.readers.get(this.activeReader);
      if (reader) await this.inspect(reader, deadline);
      else this.activeReader = undefined;
      steps++;
    }
    while (!this.stopped && this.sources.length > 0 && steps++ < SCAN_STEPS && this.now() < deadline) {
      const source = this.sources[this.sourceIndex++ % this.sources.length];
      let iterator = this.iterators.get(source.id);
      if (!iterator) { iterator = scan(source, this.cutoff, this.now()); this.iterators.set(source.id, iterator); }
      let next: IteratorResult<Candidate | undefined>;
      try { next = await iterator.next(); }
      catch (error) {
        this.iterators.delete(source.id);
        if (this.now() - this.lastWarnAt >= 60000) {
          this.lastWarnAt = this.now();
          this.warn('[OTelConsumer] live discovery scan failed', { source: source.id, message: String(error) });
        }
        continue;
      }
      if (this.stopped) return;
      if (next.done) this.iterators.delete(source.id);
      else if (next.value) await this.inspect(next.value, deadline);
    }
  }
}
