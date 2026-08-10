/**
 * 统一过滤器模型(operator 模型)—— 对齐 langfuse 的 "back half"。
 *
 * 列注册表(≈ langfuse `FIELDS`)→ FilterClause(≈ `singleFilter`)→ buildPrismaWhere
 * (≈ adapter→FilterState→SQL)。每个可过滤列声明一个 FilterType,FilterType 决定它
 * 可用哪些操作符(OPERATORS_BY_TYPE)。前端据此渲染控件,后端据此校验 + 翻译成 Prisma where。
 *
 * 设计与取舍见 docs/design/langfuse-style-trace-search/design.md §2.5 / §5。
 */

export type FilterType =
  | 'string' // 文本:= / contains / does not contain / starts with / ends with
  | 'number' // 数值:= / > / < / >= / <=
  | 'datetime' // 时间:> / < / >= / <=
  | 'stringOptions' // 单字段枚举多选:any of / none of
  | 'arrayOptions' // 数组/JSON 多值:any of / none of / all of
  | 'boolean'; // 布尔:=

export type Operator =
  | '='
  | 'contains'
  | 'does not contain'
  | 'starts with'
  | 'ends with'
  | '>'
  | '<'
  | '>='
  | '<='
  | 'any of'
  | 'none of'
  | 'all of'
  | 'is null'
  | 'is not null';

export const OPERATORS_BY_TYPE: Record<FilterType, Operator[]> = {
  string: ['=', 'contains', 'does not contain', 'starts with', 'ends with'],
  number: ['=', '>', '<', '>=', '<='],
  datetime: ['>', '<', '>=', '<='],
  stringOptions: ['any of', 'none of'],
  arrayOptions: ['any of', 'none of', 'all of'],
  boolean: ['='],
};

/** nullable 列额外支持的空值判定(对标 langfuse 的 `has:` / `-has:`)。 */
export const NULL_OPERATORS: Operator[] = ['is null', 'is not null'];

/**
 * 列的数据来源,决定能否纯下推到 Prisma 主查询的 where:
 *  - `execution`:Execution 表上的真实列 → 直接下推
 *  - `observedAgents`:observedAgents JSON string 列 → 子串降级下推
 *  - `executionSkill`:经 ExecutionSkill 反查表(异步,由调用方处理)→ 本翻译层 defer
 *  - `computed`:派生字段(status/ownership 等,非真实列)→ 本翻译层 defer,前端二次过滤
 */
export type ColumnSource = 'execution' | 'observedAgents' | 'executionSkill' | 'computed';

/** langfuse `FieldDef.syncMode` 的对应物,供后续 front-half 文法栏(Phase 4)消费,Phase 1 仅登记。 */
export type SyncMode = 'textSearch' | 'exactOption' | 'arrayOption';

export interface FilterColumn {
  /** 逻辑列名(过滤契约里的 key)。 */
  column: string;
  type: FilterType;
  label: string;
  /** Prisma 上的真实字段名,缺省 = column。 */
  field?: string;
  /** 数据来源,缺省 `execution`。 */
  source?: ColumnSource;
  /** 是否可空(决定是否额外提供 is null / is not null)。 */
  nullable?: boolean;
  /** 文法栏裸值语义(front half 用),Phase 1 仅登记不消费。 */
  syncMode?: SyncMode;
  /** 数值/时间的展示单位(如 latency 's'、cost '$')。仅作 UI 标注,不做单位换算——
   *  过滤值与 DB 原始列同单位(见 trace-columns.ts 对 latency=秒的说明)。 */
  unit?: string;
  /** 字段说明,langfuse 风格 FIELDS 下拉右侧灰字。 */
  description?: string;
}

/** 一条过滤子句。多条之间 AND 组合(Phase 1 不支持跨字段 OR)。 */
export interface FilterClause {
  column: string;
  operator: Operator;
  /** any of/none of/all of 用数组;其它单值。is null/is not null 忽略 value。 */
  value?: string | number | boolean | Array<string | number>;
}

/** 该列在 UI 上可选的全部操作符(含 nullable 的空值判定)。 */
export function operatorsForColumn(col: FilterColumn): Operator[] {
  const base = OPERATORS_BY_TYPE[col.type];
  return col.nullable ? [...base, ...NULL_OPERATORS] : base;
}

export function isOperatorAllowed(col: FilterColumn, op: Operator): boolean {
  return operatorsForColumn(col).includes(op);
}
