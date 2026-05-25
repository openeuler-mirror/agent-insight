import { resolveUser } from '@/lib/auth/auth';
import { syncEnterpriseSkills } from '@/lib/engine/skill-generation/legacy/skill-sync-service';
import { NextRequest, NextResponse } from 'next/server';

let syncStatus = {
  isSyncing: false,
  lastResult: null as any,
  startTime: null as string | null
};

export async function GET(request: NextRequest) {
  console.log('[Enterprise-Sync-API] GET请求 - 获取同步状态');
  return NextResponse.json(syncStatus);
}

export async function POST(request: NextRequest) {
  console.log('[Enterprise-Sync-API] POST请求 - 开始同步');
  
  if (process.env.ORGANIZATION_MODE !== 'true') {
    console.log('[Enterprise-Sync-API] 企业模式未启用');
    return NextResponse.json({ error: '企业模式未启用' }, { status: 400 });
  }
  
  if (syncStatus.isSyncing) {
    console.log('[Enterprise-Sync-API] 同步正在进行中，拒绝请求');
    return NextResponse.json({ error: '同步正在进行中' }, { status: 409 });
  }
  
  try {
    console.log('[Enterprise-Sync-API] 解析用户信息');
    const authResult = await resolveUser(request);
    const user = authResult.username;
    console.log('[Enterprise-Sync-API] 用户:', user);
    
    // 从前端请求中读取 Cookie，用于转发给企业API
    const incomingCookie = request.headers.get('cookie') || undefined;
    console.log('[Enterprise-Sync-API] Cookie:', incomingCookie ? '存在' : '不存在');
    
    syncStatus.isSyncing = true;
    syncStatus.startTime = new Date().toISOString();
    
    console.log('[Enterprise-Sync-API] 调用同步服务');
    const result = await syncEnterpriseSkills(user, incomingCookie);
    
    syncStatus.isSyncing = false;
    syncStatus.lastResult = result;
    
    console.log('[Enterprise-Sync-API] 同步完成，返回结果');
    return NextResponse.json(result);
    
  } catch (error: any) {
    syncStatus.isSyncing = false;
    console.error('[Enterprise-Sync-API] 同步企业技能失败:', error);
    console.error('[Enterprise-Sync-API] 错误信息:', error.message);
    console.error('[Enterprise-Sync-API] 错误堆栈:', error.stack);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}