export class MirroredDeltaGuard {
  private readonly pending = new Map<string, string[]>();

  remember(key: string, delta: string) {
    if (!key || !delta) return;
    const queue = this.pending.get(key) ?? [];
    queue.push(delta);
    if (queue.length > 128) queue.shift();
    this.pending.set(key, queue);
  }

  consume(key: string, delta: string) {
    if (!key || !delta) return false;
    const queue = this.pending.get(key);
    if (!queue?.length) return false;
    const index = queue.indexOf(delta);
    if (index === -1) return false;
    queue.splice(index, 1);
    if (queue.length === 0) this.pending.delete(key);
    return true;
  }
}
