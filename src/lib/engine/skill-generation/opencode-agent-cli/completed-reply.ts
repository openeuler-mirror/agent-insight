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

export function selectCompletedRootReply(messages: any[], expected: {
  sessionId: string; userMessageId: string; assistantMessageId: string; idle: boolean;
}): { info: any; parts: any[] } | null {
  if (!Array.isArray(messages)) return null;
  const userIndex = messages.findLastIndex(row => row?.info?.role === 'user');
  if (userIndex < 0 || messages[userIndex].info.id !== expected.userMessageId) return null;
  const reply = messages.at(-1), info = reply?.info;
  if (messages.length - 1 <= userIndex || info?.role !== 'assistant' || info.id !== expected.assistantMessageId) return null;
  if ((info.sessionID ?? info.sessionId) !== expected.sessionId || info.parentID !== expected.userMessageId || info.error) return null;
  if (!Number.isFinite(info.time?.completed) || info.time.completed <= 0) return null;
  const finish = info.finish ?? info.finishReason;
  if (finish !== 'stop' && !(expected.idle && (finish === undefined || finish === null || finish === ''))) return null;
  if (finish !== 'stop' && Array.isArray(reply.parts) && reply.parts.some((part: any) => part?.type === 'tool')) return null;
  const round = messages.slice(userIndex + 1);
  const tools = round.flatMap(row => Array.isArray(row.parts) ? row.parts.filter((part: any) => part?.type === 'tool') : []);
  if (tools.some(part => !['completed', 'error'].includes(part.state?.status))) return null;
  const hasText = Array.isArray(reply.parts) && reply.parts.some((part: any) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim());
  if (!hasText && !(finish === 'stop' && tools.some(part => part.state?.status === 'completed'))) return null;
  return reply;
}
