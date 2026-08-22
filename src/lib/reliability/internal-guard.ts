import { ReliabilityError } from '@/lib/reliability/client-registry'

/**
 * 内部控制面接口只允许本机 control-server 调用。
 * 令牌来自 AGENT_INSIGHT_INTERNAL_TOKEN；未设置时只接受默认值 'local'，
 * 因为这类部署下 dispatch 端口本身也只绑定 127.0.0.1。
 */
export function assertInternalCaller(req: Request): void {
  const expected = process.env.AGENT_INSIGHT_INTERNAL_TOKEN || 'local'
  const provided = req.headers.get('x-agent-insight-internal') || ''
  if (provided !== expected) {
    throw new ReliabilityError('INTERNAL_ONLY', '仅限内部调用', 403)
  }
}
