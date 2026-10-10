import { lstat, opendir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { runtimeOwner } from './ownership';

type Event = { kind: 'scanned' | 'deleted' | 'skipped'; bytes?: number; reason?: string };
type Snapshot = { directory: string; ino: number; dev: number };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_DEPTH = 8;

async function snapshot(directory: string): Promise<Snapshot> {
    const info = await lstat(directory);
    if (!info.isDirectory() || await realpath(directory) !== directory) throw new Error('Unsafe metadata directory');
    return { directory, ino: info.ino, dev: info.dev };
}

async function unchanged(expected: Snapshot): Promise<void> {
    const current = await snapshot(expected.directory);
    if (current.ino !== expected.ino || current.dev !== expected.dev) throw new Error('Metadata directory changed');
}

export async function* cleanupRetiredRuns(options: { directory: string; dryRun?: boolean }): AsyncGenerator<Event> {
    const requested = path.resolve(options.directory);
    const owner = runtimeOwner(requested);
    if (!owner) { yield { kind: 'skipped', reason: 'runtime-home-not-owned' }; return; }
    try {
        if (!(await lstat(requested)).isDirectory()) return;
        const directory = await realpath(requested);
        const root = await snapshot(directory);
        const base = await snapshot(path.join(directory, '.runtime-owners'));
        const guard = async (ancestors: Snapshot[] = []) => {
            const current = runtimeOwner(directory);
            if (!current || current.id !== owner.id || current.scope !== owner.scope || current.fd !== owner.fd) {
                throw new Error('Runtime owner changed');
            }
            for (const expected of [root, base, ...ancestors]) await unchanged(expected);
        };
        async function* remove(current: Snapshot, ancestors: Snapshot[] = []): AsyncGenerator<Event> {
            if (ancestors.length >= MAX_DEPTH) { yield { kind: 'skipped', reason: 'metadata-depth-limit' }; return; }
            const chain = [...ancestors, current];
            await guard(chain);
            const entries = await opendir(current.directory, { bufferSize: 8 });
            for await (const entry of entries) {
                yield { kind: 'scanned' };
                await guard(chain);
                const target = path.join(current.directory, entry.name);
                const info = await lstat(target);
                if (info.isDirectory()) {
                    yield* remove(await snapshot(target), chain);
                } else if (info.isFile()) {
                    await guard(chain);
                    const latest = await lstat(target);
                    if (!latest.isFile() || latest.ino !== info.ino || latest.dev !== info.dev) {
                        yield { kind: 'skipped', reason: 'metadata-file-changed' };
                        continue;
                    }
                    if (!options.dryRun) await unlink(target);
                    yield { kind: options.dryRun ? 'skipped' : 'deleted', bytes: options.dryRun ? 0 : info.size, reason: options.dryRun ? 'dry-run' : undefined };
                } else yield { kind: 'skipped', reason: 'unsupported-metadata-entry' };
            }
            await guard(chain);
            if (options.dryRun) { yield { kind: 'skipped', reason: 'dry-run' }; return; }
            try {
                await rmdir(current.directory);
                yield { kind: 'deleted', bytes: 0 };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error;
                yield { kind: 'skipped', reason: 'metadata-directory-not-empty' };
            }
        }
        await guard();
        const runs = await opendir(base.directory, { bufferSize: 8 });
        for await (const run of runs) {
            yield { kind: 'scanned' };
            await guard();
            if (!run.isDirectory() || !UUID.test(run.name) || run.name === owner.id) continue;
            yield* remove(await snapshot(path.join(base.directory, run.name)));
        }
    } catch { yield { kind: 'skipped', reason: 'metadata-unavailable-or-changed' }; }
}
