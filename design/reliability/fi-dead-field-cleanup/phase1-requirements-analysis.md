# FI 死字段清理（injectionEvidenceJson / artifactDir）

> 类型：Refactor / schema debt  
> 日期：2026-08-10  
> 状态：✅ 已实现（2026-08-10）

## 1. 问题

`FaultInjectionRun` 上两列已无产品语义：

| 列 | 现状 |
|----|------|
| `injectionEvidenceJson` | Phase1 已从 collect 协议移除；ingest 写 `null`；Judge/UI 不读 |
| `artifactDir` | 全仓无写入；产物路径在本机 Worker，服务端不读 |

## 2. 目标

- Drop 上述两列，减少 schema 债与误导。
- **保留** `judgeRawJson` / `itemId` / `faultActivatedAt`。

## 3. 非目标

- 不改 Judge 输入、不改 Worker inventory。
- 不做历史 JSON 数据迁移（列本为空或未用）。

## 4. 实施

1. `prisma/schema.prisma` 删除两字段。
2. 本仓无 `prisma/migrations` 目录时，用 `prisma db push` 对齐本地 SQLite（与现有开发流程一致）。
3. 去掉 `store.ts` 对 `injectionEvidenceJson` 的写入。
4. 文档：产品 docs 已不再把该字段当现行契约。

## 5. 验证

- `npx prisma generate` + FI e2e ingest 仍可通过。
- grep：生产代码无 `injectionEvidenceJson` / `artifactDir` 引用。
