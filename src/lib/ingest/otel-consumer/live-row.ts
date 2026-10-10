const MAX_FIELD_BYTES = 64 * 1024;

/** Only routing fields survive a chunk; payload size does not determine discovery memory. */
export class LiveRowParser {
  private depth = 0;
  private quoted = false;
  private escaped = false;
  private expectingKey = false;
  private key = '';
  private capture = false;
  private token: number[] = [];
  private invalid = false;
  private started = false;
  private ended = false;
  sessionId?: string;
  receivedAt?: string;

  push(byte: number): void {
    if (!this.quoted && this.depth === 0) {
      if (byte === 32 || byte === 9 || byte === 13) return;
      if (this.started || this.ended || byte !== 123) { this.invalid = true; return; }
      this.started = true;
    }
    if (this.quoted) {
      if (this.capture) {
        if (this.token.length < MAX_FIELD_BYTES) this.token.push(byte);
        else { this.invalid = true; this.capture = false; this.token = []; }
      }
      if (this.escaped) { this.escaped = false; return; }
      if (byte === 92) { this.escaped = true; return; }
      if (byte !== 34) return;
      this.quoted = false;
      if (this.capture) {
        try {
          const value = JSON.parse(Buffer.from(this.token).toString('utf8')) as string;
          if (this.expectingKey) this.key = value;
          else if (this.key === 'sessionId') this.sessionId = value;
          else if (this.key === 'receivedAt') this.receivedAt = value;
        } catch { this.invalid = true; }
      }
      this.token = [];
      return;
    }
    if (byte === 34) {
      this.quoted = true;
      this.capture = this.depth === 1 && (this.expectingKey || this.key === 'sessionId' || this.key === 'receivedAt');
      this.token = this.capture ? [34] : [];
    } else if (byte === 123 || byte === 91) {
      this.depth++;
      if (this.depth === 1) this.expectingKey = true;
    } else if (byte === 125 || byte === 93) {
      this.depth--;
      if (this.depth === 0) this.ended = true;
    } else if (this.depth === 1 && byte === 58) {
      this.expectingKey = false;
      if (this.key === 'sessionId') this.sessionId = undefined;
      if (this.key === 'receivedAt') this.receivedAt = undefined;
    } else if (this.depth === 1 && byte === 44) {
      this.expectingKey = true;
      this.key = '';
    }
  }

  finish(): { sessionId: string; receivedAt: number } | undefined {
    const receivedAt = Date.parse(this.receivedAt || '');
    return this.started && this.ended && !this.invalid && !this.quoted && this.depth === 0 && this.sessionId && Number.isFinite(receivedAt)
      ? { sessionId: this.sessionId, receivedAt } : undefined;
  }
}
