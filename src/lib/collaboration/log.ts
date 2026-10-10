import { createLogger } from '@/lib/logger';

export const collaborationLog = createLogger('collaboration');

export function failureDetails(error: unknown): { causeCode: string; reason: string } {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'P2010') {
        const meta = (error as { meta?: { message?: unknown } }).meta;
        const message = typeof meta?.message === 'string' ? meta.message : '';
        if (/no such table|relation .+ does not exist/i.test(message)) return { causeCode: code, reason: '数据库表不存在，请检查启动时的 schema 同步是否成功' };
        if (/no such column|column .+ does not exist/i.test(message)) return { causeCode: code, reason: '数据库列不存在，请检查 schema 同步' };
        if (/database is locked|database table is locked/i.test(message)) return { causeCode: code, reason: '数据库正在处理其他写入，请使用原编号重试' };
        return { causeCode: code, reason: '数据库 SQL 操作失败，请检查 schema 同步和数据库运行状态' };
    }
    const reasons: Record<string, string> = {
        P2021: '数据库表不存在，请检查启动时的 schema 同步是否成功',
        '42P01': '数据库表不存在，请检查启动时的 schema 同步是否成功',
        P2022: '数据库列与客户端不一致，请检查 schema 同步及 Prisma Client 生成',
        '42703': '数据库列不存在，请检查 schema 同步',
        P2002: '数据库唯一约束冲突',
        '23505': '数据库唯一约束冲突',
        P1001: '无法连接数据库',
        ECONNREFUSED: '数据库连接被拒绝',
        P1008: '数据库操作超时',
        P2024: '数据库连接池等待超时',
        P2028: '数据库事务失败或超时',
        P2034: '数据库事务写入冲突，请使用原编号重试',
        '40001': '数据库事务写入冲突，请使用原编号重试',
        '40P01': '数据库事务死锁，请使用原编号重试',
    };
    if (reasons[code]) return { causeCode: code, reason: reasons[code] };
    if (error instanceof SyntaxError) return { causeCode: 'INVALID_TRACE_JSON', reason: '已保存的 Trace 正文不是有效 JSON' };
    if (error instanceof Error && error.message === 'Conflicting original call identifier') return { causeCode: 'CALL_ID_CONFLICT', reason: '原始调用编号存在冲突，不能确定步骤位置' };
    return { causeCode: /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNEXPECTED_ERROR', reason: '内部操作失败；请求标识及处理阶段见本条日志' };
}
