import { PrismaClient, Prisma } from '@prisma/client';

/**
 * Execution 上「整个 session 累计求和」的 token 列。schema 里是 BigInt（Int 的 32 位上限
 * 2,147,483,647 挡不住长命 session 的累计值），但 Prisma 读 BigInt 列一律返回 JS `bigint`，
 * 连 42 也是 —— 而 bigint 既不能 JSON.stringify（TypeError: Do not know how to serialize
 * a BigInt），也不能和 number 混算（TypeError: Cannot mix BigInt and other types）。
 *
 * 全站有 200+ 处按 number 消费这些字段，逐处改 bigint 既大又易漏，所以在读边界统一转回
 * number：Number 对整数在 2^53-1（约 9,007 万亿）以内精确，是 32 位上限的 400 万倍，
 * token 计数不可能触及，转换无损。
 *
 * 只影响读，不影响写：Prisma 的 BigInt 列接受 JS number 入参，所有现有写入点无需改动。
 *
 * 注意：needs/compute 必须逐列字面量写死。用 Object.fromEntries 之类动态构造会让 Prisma
 * 的结果类型推导退化，字段类型退回 bigint，扩展就等于没加。
 */
export const EXECUTION_BIGINT_COLUMNS = [
  'tokens',
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'reasoningTokens',
] as const;

// null 必须原样保留：转成 0 会把「没采到这项」伪装成「用了 0 token」。
const toNumber = (value: bigint | null): number | null => (value === null ? null : Number(value));

export const executionBigIntToNumber = Prisma.defineExtension({
  name: 'execution-bigint-to-number',
  result: {
    execution: {
      tokens: {
        needs: { tokens: true },
        compute: (execution) => toNumber(execution.tokens),
      },
      inputTokens: {
        needs: { inputTokens: true },
        compute: (execution) => toNumber(execution.inputTokens),
      },
      outputTokens: {
        needs: { outputTokens: true },
        compute: (execution) => toNumber(execution.outputTokens),
      },
      cacheReadInputTokens: {
        needs: { cacheReadInputTokens: true },
        compute: (execution) => toNumber(execution.cacheReadInputTokens),
      },
      cacheCreationInputTokens: {
        needs: { cacheCreationInputTokens: true },
        compute: (execution) => toNumber(execution.cacheCreationInputTokens),
      },
      reasoningTokens: {
        needs: { reasoningTokens: true },
        compute: (execution) => toNumber(execution.reasoningTokens),
      },
    },
  },
});

export function createPrismaClient() {
  return new PrismaClient().$extends(executionBigIntToNumber);
}

export type ExtendedPrismaClient = ReturnType<typeof createPrismaClient>;
