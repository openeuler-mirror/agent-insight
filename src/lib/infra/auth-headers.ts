// pull 源的鉴权 header：DB 里以 JSON 对象字符串存（`InfraSource.authHeaders`），
// 抓取时展开成 fetch 的 header 对象，回给前端时必须脱敏 —— 里面是明文凭证，
// 而 GET /api/observe/infra/sources 谁都能读。
//
// 纯函数，无 DB/网络依赖（单测覆盖）。

/** 允许配置的 header 名白名单外的字符一律拒绝，避免把换行等注入进请求头。 */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** DB 里的 JSON 字符串 → fetch 用的 header 对象。非法/空值一律返回 {}，不抛。 */
export function parseAuthHeaders(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    const name = k.trim();
    const value = v.trim();
    if (!name || !value || !HEADER_NAME_RE.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * 前端提交的东西 → 可落库的 JSON 字符串。接受三种形态：
 *   - 字符串：当作 Authorization 的值（UI 单输入框走这条）
 *   - 对象：多 header（以后 UI 扩成 key-value 列表时走这条）
 *   - null / '' ：显式清除，返回 null
 * 返回 undefined 表示「本次不改动」（调用方据此决定是否写库）。
 */
export function toAuthHeadersJson(input: unknown): string | null | undefined {
  if (input === undefined) return undefined;
  if (input === null) return null;

  let obj: Record<string, string> = {};
  if (typeof input === 'string') {
    const v = input.trim();
    if (!v) return null; // 清空输入框 = 清除鉴权
    obj = { Authorization: v };
  } else if (typeof input === 'object' && !Array.isArray(input)) {
    for (const [k, val] of Object.entries(input as Record<string, unknown>)) {
      if (typeof val !== 'string') continue;
      const name = k.trim();
      const value = val.trim();
      if (!name || !value || !HEADER_NAME_RE.test(name)) continue;
      obj[name] = value;
    }
    if (Object.keys(obj).length === 0) return null;
  } else {
    return undefined; // 认不出的类型 → 不动
  }
  return JSON.stringify(obj);
}

export interface AuthHeadersSummary {
  /** 配了哪些 header 名（不含值）。 */
  keys: string[];
  /** 是否配了鉴权 —— UI 用它显示「已配置」。 */
  hasAuth: boolean;
}

/** GET 接口回显用：只说配了哪些 header，绝不返回值。 */
export function summarizeAuthHeaders(raw: string | null | undefined): AuthHeadersSummary {
  const keys = Object.keys(parseAuthHeaders(raw));
  return { keys, hasAuth: keys.length > 0 };
}

/** 把一行 InfraSource 脱敏成可安全返回给前端的形状（authHeaders 换成摘要）。 */
export function redactSource<T extends { authHeaders?: string | null }>(
  src: T,
): Omit<T, 'authHeaders'> & { auth: AuthHeadersSummary } {
  const { authHeaders, ...rest } = src;
  return { ...rest, auth: summarizeAuthHeaders(authHeaders) };
}
