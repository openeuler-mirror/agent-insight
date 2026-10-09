export type SpoolReceiptNotice = { root: string; sessionId: string; receivedAt: number };
type Listener = (notice: SpoolReceiptNotice) => void;

declare global {
  var __otelLiveReceiptListener: Listener | undefined;
}

export function subscribeSpoolReceipts(listener: Listener): () => void {
  globalThis.__otelLiveReceiptListener = listener;
  return () => {
    if (globalThis.__otelLiveReceiptListener === listener) globalThis.__otelLiveReceiptListener = undefined;
  };
}

export function notifySpoolReceived(root: string, sessionId: string, receivedAt: number): void {
  try { globalThis.__otelLiveReceiptListener?.({ root, sessionId, receivedAt }); }
  catch { /* Receipt persistence remains authoritative when the optional listener is unavailable. */ }
}
