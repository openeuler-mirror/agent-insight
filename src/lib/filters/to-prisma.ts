/**
 * FilterClause[] → Prisma `where` 翻译层 —— 对标 langfuse `adapter.ts`(AST→FilterState→SQL)。
 *
 * 纯函数、同步、不 import Prisma/opencode,因此可被 node:test 直接单测。
 * 只翻译能纯下推到 Execution 主查询的列(source=execution / observedAgents);
 * 需异步反查或派生的列(executionSkill / computed)放进 `deferred` 交调用方。
 *
 * 多条子句 AND 组合(用 `where.AND` 数组,避免同字段多子句的 key 覆盖)。
 * SQLite 注意:
 *  - `contains/startsWith/endsWith` 走 LIKE,对 ASCII 默认大小写不敏感;Prisma 在 SQLite 上不支持
 *    `mode:'insensitive'`(写了会报错)。
 *  - ⚠️ 已知局限:Prisma SQLite 的 `contains/startsWith/endsWith` **不转义 LIKE 通配符** `_` / `%`
 *    (无 ESCAPE 子句)。故搜索值里的 `_`/`%` 会被当通配符,可能**过匹配**(返回超集,绝不漏)。
 *    彻底修需走 raw SQL `LIKE … ESCAPE`,本期不做(危害小、仅过匹配)。
 */
import { type FilterClause, type FilterColumn, isOperatorAllowed } from './types';
import { resolveTraceColumn } from './trace-columns';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PrismaWhere = Record<string, any>;

export interface BuildWhereResult {
  /** 可 spread 进 Prisma findMany 的 where(AND 组合);无有效子句时为 {}。 */
  where: PrismaWhere;
  /** 无法纯下推、需调用方处理的子句(source=executionSkill / computed)。 */
  deferred: FilterClause[];
  /** 非法子句(列不存在 / 操作符与类型不符 / 值缺失或不可解析)。 */
  errors: Array<{ clause: FilterClause; reason: string }>;
}

type Resolver = (column: string) => FilterColumn | undefined;

const INVALID = Symbol('invalid');
type Frag = PrismaWhere | typeof INVALID | null;

/** comparison op → Prisma 数值/时间操作符 key。 */
const CMP: Record<string, string> = { '=': 'equals', '>': 'gt', '<': 'lt', '>=': 'gte', '<=': 'lte' };

export function buildPrismaWhere(
  clauses: FilterClause[],
  resolve: Resolver = resolveTraceColumn,
): BuildWhereResult {
  const and: PrismaWhere[] = [];
  const deferred: FilterClause[] = [];
  const errors: BuildWhereResult['errors'] = [];

  for (const clause of clauses) {
    const col = resolve(clause.column);
    if (!col) {
      errors.push({ clause, reason: `unknown column: ${clause.column}` });
      continue;
    }
    if (!isOperatorAllowed(col, clause.operator)) {
      errors.push({
        clause,
        reason: `operator "${clause.operator}" not allowed on ${col.type} column "${col.column}"`,
      });
      continue;
    }
    const source = col.source ?? 'execution';
    if (source === 'executionSkill' || source === 'computed') {
      deferred.push(clause);
      continue;
    }
    const frag = source === 'observedAgents' ? lowerObservedAgents(col, clause) : lowerColumn(col, clause);
    if (frag === INVALID) {
      errors.push({ clause, reason: `invalid value for ${col.type} operator "${clause.operator}"` });
      continue;
    }
    if (frag !== null) and.push(frag);
  }

  return { where: and.length ? { AND: and } : {}, deferred, errors };
}

function fieldName(col: FilterColumn): string {
  return col.field ?? col.column;
}

/**
 * 否定类操作符(does not contain / none of)的 NULL 修正:SQL 里 `NOT (col LIKE …)` 和
 * `col NOT IN (…)` 对 NULL 行求值为 NULL → 被排除。但「不包含 X / 不属于这些值」语义上 NULL 应**命中**
 * (空值确实不包含 X)。所以 nullable 列的否定结果再 OR 上 `col IS NULL`。
 * (正向匹配 =/contains/>/… 无需此修正:NULL 本就该被排除。)
 */
function includeNullOnNegation(frag: PrismaWhere, col: FilterColumn): PrismaWhere {
  if (!col.nullable) return frag;
  return { OR: [frag, { [fieldName(col)]: null }] };
}

function lowerColumn(col: FilterColumn, clause: FilterClause): Frag {
  const f = fieldName(col);
  const op = clause.operator;
  if (op === 'is null') return { [f]: null };
  if (op === 'is not null') return { [f]: { not: null } };

  switch (col.type) {
    case 'string': {
      const v = asString(clause.value);
      if (v === null) return INVALID;
      switch (op) {
        case '=':
          return { [f]: v };
        case 'contains':
          return { [f]: { contains: v } };
        case 'does not contain':
          return includeNullOnNegation({ NOT: { [f]: { contains: v } } }, col);
        case 'starts with':
          return { [f]: { startsWith: v } };
        case 'ends with':
          return { [f]: { endsWith: v } };
        default:
          return INVALID;
      }
    }
    case 'number': {
      const n = asNumber(clause.value);
      const key = CMP[op];
      if (n === null || !key) return INVALID;
      return { [f]: { [key]: n } };
    }
    case 'datetime': {
      const d = asDate(clause.value);
      const key = CMP[op];
      if (d === null || !key) return INVALID;
      return { [f]: { [key]: d } };
    }
    case 'boolean': {
      const b = asBoolean(clause.value);
      if (b === null) return INVALID;
      return { [f]: { equals: b } };
    }
    case 'stringOptions': {
      const arr = asStringArray(clause.value);
      if (arr === null || arr.length === 0) return INVALID;
      if (op === 'any of') return { [f]: { in: arr } };
      if (op === 'none of') return includeNullOnNegation({ [f]: { notIn: arr } }, col);
      return INVALID;
    }
    case 'arrayOptions':
      // execution-source arrayOptions 不在注册表里(只有 observedAgents/executionSkill),
      // 走到这里属误注册,显式判非法而非静默。
      return INVALID;
    default:
      return INVALID;
  }
}

/**
 * observedAgents 是 JSON 字符串数组(SQLite 无法做数组成员关系查询)→ 子串降级:
 * 匹配 JSON 元素 `"name"`(带引号转义,比裸 name 更不易误命中,如 "a" 不命中 "ab")。
 */
function lowerObservedAgents(col: FilterColumn, clause: FilterClause): Frag {
  const f = fieldName(col);
  const op = clause.operator;
  if (op === 'is null') return { [f]: null };
  if (op === 'is not null') return { [f]: { not: null } };

  const arr = asStringArray(clause.value);
  if (arr === null || arr.length === 0) return INVALID;
  const member = (v: string): PrismaWhere => ({ [f]: { contains: JSON.stringify(v) } });
  if (op === 'any of') return { OR: arr.map(member) };
  if (op === 'all of') return { AND: arr.map(member) };
  if (op === 'none of') return includeNullOnNegation({ NOT: { OR: arr.map(member) } }, col);
  return INVALID;
}

// ---- value coercion (容忍 string/number/boolean 输入,如来自 URL/JSON) ----

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asBoolean(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function asDate(v: unknown): Date | null {
  if (typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function asStringArray(v: unknown): string[] | null {
  if (Array.isArray(v)) {
    const out = v.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : null));
    return out.every((x) => x !== null) ? (out as string[]) : null;
  }
  if (typeof v === 'string' || typeof v === 'number') return [String(v)];
  return null;
}
