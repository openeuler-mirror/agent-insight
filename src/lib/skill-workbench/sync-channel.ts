export type WorkbenchSyncKind = 'run-started' | 'run-settled';

export interface WorkbenchSyncEvent {
  sessionId: string;
  taskType: 'generation' | 'optimization';
  kind: WorkbenchSyncKind;
}

const CHANNEL_NAME = 'agent-insight-skill-workbench';
let channel: BroadcastChannel | null = null;

function getChannel() {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  channel ||= new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

export function publishWorkbenchSync(event: WorkbenchSyncEvent) {
  getChannel()?.postMessage(event);
}

export function subscribeWorkbenchSync(listener: (event: WorkbenchSyncEvent) => void) {
  const activeChannel = getChannel();
  if (!activeChannel) return () => undefined;
  const handleMessage = (message: MessageEvent<WorkbenchSyncEvent>) => listener(message.data);
  activeChannel.addEventListener('message', handleMessage);
  return () => activeChannel.removeEventListener('message', handleMessage);
}
