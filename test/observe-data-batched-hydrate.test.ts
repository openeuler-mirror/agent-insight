import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunk, selectKeepIdsByTaskId } from '@/lib/storage/data-service';

// 按批 hydrate 根治非分页路径(/api/observe/data 不带 fields=light 的调用方)的 next-server 堆 OOM:
// 之前 paged===filtered 时会把全历史 session 的整段 interactions 一次性读进内存解析,撑爆 V8 堆。
// 现在 readRecordsInternal 把 finalResult + session 的加载/解析/归一化按 chunk() 切批处理,峰值内存降到 O(批大小)。
// dedup 这一遍也统一成 light 投影(无 finalResult),canonical 选取下沉到 selectKeepIdsByTaskId。
// 集成层(zero 跨批 session 泄漏 / batched==非batched 等价)由 tsc + scripts/dryrun_readrecords_batched.mjs
// 对真实数据端到端覆盖(本仓 node:test+tsx 下 mock.module 不可用,无法对 db 单例打桩)。
// 这里锁死两块纯逻辑:chunk 切批的边界,与 selectKeepIdsByTaskId 的 canonical 规则。

test('chunk: 整除 / 余数 / 空数组 / size≥len / size≤0 兜底', () => {
    assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 100), []);
    assert.deepEqual(chunk([1, 2, 3], 10), [[1, 2, 3]]);
    // size≤0 兜底成 1(防 i+=0 死循环):每个元素自成一批。
    assert.deepEqual(chunk([1, 2, 3], 0), [[1], [2], [3]]);
    assert.deepEqual(chunk([1, 2, 3], -5), [[1], [2], [3]]);
    // 非整数 size 截断:2.9 → 2。
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2.9), [[1, 2], [3, 4], [5]]);
});

test('chunk: 不丢不重,拼回原数组且每批不超过 size', () => {
    const arr = Array.from({ length: 250 }, (_, i) => i);
    const batches = chunk(arr, 100);
    assert.equal(batches.length, 3);
    assert.ok(batches.every(b => b.length <= 100));
    assert.deepEqual(batches.flat(), arr);
});

test('selectKeepIdsByTaskId: 组内唯一 → 留该行', () => {
    const recs = [
        { id: 'a', taskId: 't1', timestamp: '2026-06-01T00:00:00Z' },
        { id: 'b', taskId: 't2', timestamp: '2026-06-01T00:00:00Z' },
    ];
    const { keepIds } = selectKeepIdsByTaskId(recs);
    assert.deepEqual([...keepIds].sort(), ['a', 'b']);
});

test('selectKeepIdsByTaskId: 存在 id===taskId → 留 canonical(忽略时间戳)', () => {
    const recs = [
        // 重复上报行(id≠taskId),时间戳更新,但不该被选中。
        { id: 'dup-newer', taskId: 't1', timestamp: '2026-06-05T00:00:00Z' },
        { id: 't1', taskId: 't1', timestamp: '2026-06-01T00:00:00Z' },
    ];
    const { keepIds } = selectKeepIdsByTaskId(recs);
    assert.deepEqual([...keepIds], ['t1']);
});

test('selectKeepIdsByTaskId: 多行无 canonical → 按 timestamp desc 兜底', () => {
    const recs = [
        { id: 'older', taskId: 't1', timestamp: '2026-06-01T00:00:00Z' },
        { id: 'newer', taskId: 't1', timestamp: '2026-06-09T00:00:00Z' },
    ];
    const { keepIds } = selectKeepIdsByTaskId(recs);
    assert.deepEqual([...keepIds], ['newer']);
});

test('selectKeepIdsByTaskId: 时间戳相同且无 canonical → id localeCompare 稳定兜底(不再依赖 finalResult 长度)', () => {
    const recs = [
        { id: 'zzz', taskId: 't1', timestamp: '2026-06-01T00:00:00Z' },
        { id: 'aaa', taskId: 't1', timestamp: '2026-06-01T00:00:00Z' },
    ];
    const { keepIds } = selectKeepIdsByTaskId(recs);
    // localeCompare 最小者 'aaa' 胜出,与行序无关 → 稳定。
    assert.deepEqual([...keepIds], ['aaa']);
});

test('selectKeepIdsByTaskId: taskId 为空的行不参与去重(各自保留),byTaskId 只含非空 taskId', () => {
    const recs = [
        { id: 'x', taskId: null, timestamp: '2026-06-01T00:00:00Z' },
        { id: 'y', taskId: '', timestamp: '2026-06-01T00:00:00Z' },
        { id: 't1', taskId: 't1', timestamp: '2026-06-01T00:00:00Z' },
        { id: 'dup', taskId: 't1', timestamp: '2026-06-02T00:00:00Z' },
    ];
    const { keepIds, byTaskId } = selectKeepIdsByTaskId(recs);
    // 空 taskId 行不进 byTaskId、不进 keepIds(调用方 filter 时对 !taskId 直接放行)。
    assert.equal(byTaskId.has('t1'), true);
    assert.equal([...byTaskId.keys()].length, 1);
    // t1 组保留 canonical;空 taskId 的 x/y 由调用方原样透传,不在 keepIds 里。
    assert.deepEqual([...keepIds], ['t1']);
});
