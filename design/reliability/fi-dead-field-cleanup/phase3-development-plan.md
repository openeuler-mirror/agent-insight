# Phase3：开发计划 — FI 废列 drop

1. 改 [`prisma/schema.prisma`](../../../prisma/schema.prisma)。
2. `npx prisma db push`（本地 `DATABASE_URL`）+ `npx prisma generate`。
3. 删 [`store.ts`](../../../src/lib/fault-injection/store.ts) 中 `injectionEvidenceJson: null`。
4. 跑 `npx tsx --test test/fault-injection-e2e.test.ts`。
5. 需求清单登记为已实现。
