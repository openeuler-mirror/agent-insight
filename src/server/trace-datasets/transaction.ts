import type { PrismaClient, Prisma } from '@prisma/client';
export async function transaction<T>(db: PrismaClient, callback: (tx: Prisma.TransactionClient) => Promise<T>, options = { maxWait: 30000, timeout: 30000 }): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(callback, options); }
    catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt >= 4 || !['P1008', 'P2028', 'P2034'].includes(code || '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
    }
  }
}
