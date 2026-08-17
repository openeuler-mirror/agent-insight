/**
 * 预置评估器注册表一致性守卫。
 *
 * 新增一个预置评估器要同时改好几个登记点（卡片 / 元数据 / 分发），漏改任何一处
 * **编译期都不报错**：
 * - 漏登记元数据 → getEvaluatorMeta 静默回退 DEFAULT_META，卡片归错类目、绕过 ④ 步门控；
 * - 漏接分发 → 一路落到 run-experiment.ts 的 resolveEvaluatorCard，预置卡没有 llmConfig，
 *   最终抛「缺少可执行的 LLM 配置」——但要等用户点了运行才炸。
 *
 * 这个测试把上面两种漏改前移到 CI。**新增一族评估器时，把它的谓词加进 PRESET_RUNNERS。**
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_SELECTED_PRESET_IDS, presetEvaluators } from '../src/lib/evaluators/preset-evaluators';
import { hasPresetMeta } from '../src/lib/evaluators/registry';
import {
  FAITHFUL_PRESET_IDS,
  isFaithfulPresetId,
} from '../src/lib/engine/experiment/faithful-preset-evaluators';
import {
  RESULT_PRESET_IDS,
  isResultPresetId,
} from '../src/lib/engine/experiment/result-preset-evaluators';
import {
  CONTENT_PRESET_IDS,
  isContentPresetId,
} from '../src/lib/engine/experiment/content-preset-evaluators';
import {
  CREATIVITY_PRESET_IDS,
  isCreativityPresetId,
} from '../src/lib/engine/experiment/creativity-preset-evaluators';
import {
  SAFETY_PRESET_IDS,
  isSafetyPresetId,
} from '../src/lib/engine/experiment/safety-preset-evaluators';
import {
  DEPTH_PRESET_ID,
  isDepthPresetId,
} from '../src/lib/engine/experiment/depth-preset-evaluators';
import {
  AGENT_TOOL_PRESET_IDS,
  isAgentToolPresetId,
} from '../src/lib/engine/experiment/agent-tool-preset-evaluators';
import {
  RAS_DETECTION_RECOVERY_PRESET_ID,
  isRasReliabilityPresetId,
} from '../src/lib/engine/experiment/ras-reliability-evaluator';

/**
 * 分发谓词清单——与 run-experiment.ts 的 evaluateOnce() 一一对应。
 * 新增一族预置评估器时，在 evaluateOnce 里接了分发，就同步在这里登记一行。
 */
const PRESET_RUNNERS: Array<{ name: string; claims: (id: string) => boolean; ids: readonly string[] }> = [
  { name: 'faithful-preset-evaluators.ts', claims: isFaithfulPresetId, ids: FAITHFUL_PRESET_IDS },
  { name: 'result-preset-evaluators.ts', claims: isResultPresetId, ids: RESULT_PRESET_IDS },
  { name: 'content-preset-evaluators.ts', claims: isContentPresetId, ids: CONTENT_PRESET_IDS as readonly string[] },
  { name: 'creativity-preset-evaluators.ts', claims: isCreativityPresetId, ids: CREATIVITY_PRESET_IDS },
  { name: 'safety-preset-evaluators.ts', claims: isSafetyPresetId, ids: SAFETY_PRESET_IDS },
  { name: 'depth-preset-evaluators.ts', claims: isDepthPresetId, ids: [DEPTH_PRESET_ID] },
  {
    name: 'agent-tool-preset-evaluators.ts',
    claims: isAgentToolPresetId,
    ids: AGENT_TOOL_PRESET_IDS,
  },
  {
    name: 'ras-reliability-evaluator.ts',
    claims: isRasReliabilityPresetId,
    ids: [RAS_DETECTION_RECOVERY_PRESET_ID],
  },
];

test('预置卡 id 唯一', () => {
  const seen = new Set<string>();
  for (const card of presetEvaluators) {
    assert.ok(!seen.has(card.id), `预置卡 id 重复：${card.id}`);
    seen.add(card.id);
  }
});

test('每张预置卡都在 registry 登记了元数据（否则静默回退 res/无门控）', () => {
  for (const card of presetEvaluators) {
    assert.ok(
      hasPresetMeta(card.id),
      `${card.id} 未登记到 registry.ts 的 PRESET_META —— 会被静默当成 category='res'、无 requires 门控`,
    );
  }
});

test('每张预置卡都被恰好一个分发谓词认领（否则运行时才抛「缺少可执行的 LLM 配置」）', () => {
  for (const card of presetEvaluators) {
    const owners = PRESET_RUNNERS.filter((r) => r.claims(card.id)).map((r) => r.name);
    assert.equal(
      owners.length,
      1,
      owners.length === 0
        ? `${card.id} 没有任何分发实现认领 —— 用户选了它会在运行时失败。`
          + `请在 run-experiment.ts 的 evaluateOnce() 接分发，并把谓词登记进本测试的 PRESET_RUNNERS。`
        : `${card.id} 被多个分发实现同时认领（${owners.join(' / ')}）—— 实际执行取决于 evaluateOnce 里的判断顺序，必须消歧义。`,
    );
  }
});

test('默认勾选的评估器是显式小集合，不随注册表增长', () => {
  const cardIds = new Set(presetEvaluators.map((c) => c.id));
  for (const id of DEFAULT_SELECTED_PRESET_IDS) {
    assert.ok(cardIds.has(id), `DEFAULT_SELECTED_PRESET_IDS 里的 ${id} 没有对应的预置卡`);
  }
  const readyCount = presetEvaluators.filter((c) => c.status === 'ready').length;
  assert.ok(
    DEFAULT_SELECTED_PRESET_IDS.length < readyCount || readyCount <= 2,
    '默认勾选不该等于「全部 ready」——每多默认勾一个，用户什么都没点就多跑一个 LLM judge，'
      + '而通用 judge 每次调用会起一个临时 opencode server（见 eval-run-guards.ts 记录的 OOM 事故）',
  );
});

test('分发谓词声称的每个 id 都有对应的预置卡', () => {
  const cardIds = new Set(presetEvaluators.map((c) => c.id));
  for (const runner of PRESET_RUNNERS) {
    for (const id of runner.ids) {
      assert.ok(
        cardIds.has(id),
        `${runner.name} 声称实现了 ${id}，但 preset-evaluators.ts 里没有这张卡 —— 用户无从选择它`,
      );
    }
  }
});
