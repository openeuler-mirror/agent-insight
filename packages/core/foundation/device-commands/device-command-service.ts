import type { CallContext } from '../common/context/call-context';
import type { ApiError } from '../common/errors/safe-error';
import type { Envelope } from '../device-protocol';

export type Delivery =
  | { readonly messageId: string; readonly state: 'queued' | 'received' | 'processed' }
  | { readonly messageId: string; readonly state: 'failed'; readonly error: ApiError };

export interface DeviceCommandService {
  /** 确认持久化后返回。同一项目、设备和幂等键的重复提交返回同一命令。 */
  enqueue(context: CallContext, clientId: string, input: Envelope, key: string): Promise<{ readonly id: string }>;
  getReceipt(context: CallContext, clientId: string, messageId: string): Promise<Delivery>;
}
