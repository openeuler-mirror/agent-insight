/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
