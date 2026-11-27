export type LogValue = null | boolean | number | string | readonly LogValue[] | { readonly [key: string]: LogValue };

/** 仅输出经过允许列表、脱敏和长度限制的字段，嵌套原因与堆栈也走该步骤。 */
export interface LogRedactor {
  redact(details: unknown): Readonly<Record<string, LogValue>>;
}
