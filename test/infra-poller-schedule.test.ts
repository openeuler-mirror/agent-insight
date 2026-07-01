import assert from 'node:assert/strict';
import test from 'node:test';

import { isInfraPollerRunning, startInfraPoller, stopInfraPoller } from '@/lib/infra/poller';

test('startInfraPoller 幂等 + start/stop 切换状态', () => {
  stopInfraPoller();
  assert.equal(isInfraPollerRunning(), false);

  // 用很大的间隔，保证测试期间不会真的触发一轮拉取
  startInfraPoller({ intervalMs: 3_600_000 });
  assert.equal(isInfraPollerRunning(), true);

  // 再次调用应幂等，不新建第二个定时器
  startInfraPoller({ intervalMs: 3_600_000 });
  assert.equal(isInfraPollerRunning(), true);

  stopInfraPoller();
  assert.equal(isInfraPollerRunning(), false);
});

test('intervalMs<=0 关闭自动拉取', () => {
  stopInfraPoller();
  startInfraPoller({ intervalMs: 0 });
  assert.equal(isInfraPollerRunning(), false);
  startInfraPoller({ intervalMs: -1 });
  assert.equal(isInfraPollerRunning(), false);
});
