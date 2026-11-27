import type { CallContext } from '../common/context/call-context';
import type { Ack, Envelope, HandlerResult, Messages } from './schemas/messages';

export interface DeviceTransport {
  upload(context: CallContext, clientId: string, message: Envelope): Promise<Ack>;
  poll(context: CallContext, clientId: string): Promise<Messages>;
  ack(context: CallContext, clientId: string, messageId: string, input: Ack): Promise<Ack>;
}

export interface MessageChannel {
  send(context: CallContext, envelope: Envelope): Promise<{ readonly id: string }>;
}

export interface MessageHandler {
  handle(context: CallContext, envelope: Envelope): Promise<HandlerResult>;
}
