import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

const digest = '2f7ba42e79072b2674be9f28d051665e006732fa6cc5de474f783b823bdfb0a9';
const original = '\t\t\tthis.requireTurn(event.type);';
const replacement = `			if (this.turn === null) {
				const op = event.surfaceOp;
				const priorEvent = this.artifact.events[op.startSeq];
				const prune = this.artifact.events[event.seq - 1];
				const message = data.message, prior = priorEvent?.data?.message;
				const valid = op.op === 'replace' && op.startSeq === op.endSeq
					&& priorEvent?.type === 'tool/result' && prune?.type === 'compaction/prune'
					&& JSON.stringify(prune.data.shadowedSeqs) === JSON.stringify([op.startSeq])
					&& JSON.stringify(event.sourceEventSeqs) === JSON.stringify([op.startSeq])
					&& prune.data.shadowedRange?.start === op.startSeq && prune.data.shadowedRange?.end === op.endSeq
					&& message?.id === prior?.id && message?.toolCallId === prior?.toolCallId
					&& message?.source?.callId === prior?.source?.callId && message?.isError === prior?.isError
					&& JSON.stringify({ ...data, message: { ...message, content: null } })
						=== JSON.stringify({ ...priorEvent.data, message: { ...prior, content: null } })
					&& data.turn === priorEvent.data.turn && data.step === priorEvent.data.step;
				if (!valid) this.requireTurn(event.type);
			}`;

export function compatibleReplaySource(source, version) {
  source = source.replaceAll('\r\n', '\n');
  if (version !== '0.2.2-rc.1' || createHash('sha256').update(source).digest('hex') !== digest) return null;
  const anchor = '\t\tif (event.type === "tool/result" && event["surfaceOp"] !== "append") {\n' + original;
  if (!source.includes(anchor)) return null;
  return source.replace(anchor, anchor.replace(original, replacement));
}

registerHooks({ load(url, context, next) {
  const loaded = next(url, context);
  if (!url.endsWith('/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js')) return loaded;
  const version = JSON.parse(readFileSync(new URL('../package.json', url), 'utf8')).version;
  const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString();
  const compatible = compatibleReplaySource(source, version);
  if (compatible === null) {
    process.stderr.write('[Agent Insight] replay compatibility not applied: unverified version/source\n');
    return loaded;
  }
  process.stderr.write('[Agent Insight] verified Harness 0.2.2-rc.1 replay compatibility enabled\n');
  return { ...loaded, source: compatible };
} });
