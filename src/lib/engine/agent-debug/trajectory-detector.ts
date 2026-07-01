/**
 * 轨迹诊断器（trajectory diagnoser）—— 确定性、零 LLM 成本。
 *
 * AgentDebug 主链路是"逐 turn 认知错误检测 + 单点根因定位"，对"跨很多 turn、整条轨迹
 * 不收敛"的死循环 / 无进展天然看不见（见
 * docs/agentdebug-diagnosis-principle-and-loop-detection-gap.md）。本模块作为独立的
 * 并行 pass，直接扫描归一化后的 turns（不经过 40k digest、不调用 LLM），按"在一段连续
 * 区间内反复执行此前已出现过的动作、几乎不产生新进展"识别循环，产出 kind=trajectory 的
 * finding。
 *
 * 检测信号只取结构化元数据（工具名 + 归一化参数 / 文本指纹、turn 位置、trace 节点编号），
 * 这些字段不受主链路逐字段截断影响，因此"完整性"对本检测器是免费的。
 *
 * 核心判据（"无进展"）：把每个 turn 标为「首见(novel)」或「复发(repeat)」，在连续区间上
 * 用 max-subarray 找出"复发占比高"的最密区段——健康轨迹会不断引入新动作（novel 多），
 * livelock 区段则几乎全是对此前动作的重复（repeat 多）。这样能精确定位密集循环段，而不会
 * 因为把整条 trace 的稀疏重复平均进来而漏判。
 */
import type {
  DebugTurn,
  AgentDebugTrajectoryFinding,
  AgentDebugTrajectoryAnchor,
} from './types';

export const TRAJECTORY_DETECTOR_ID = 'trajectory-detector@0.1';

export interface TrajectoryDetectorOptions {
  /** 区间内主导复发动作至少出现多少次（默认 4） */
  minRepeats?: number;
  /** 循环区间至少多少个 turn（默认 10） */
  minRegionTurns?: number;
  /** 区间内"复发 turn 占比"阈值，越高越像原地打转（默认 0.6） */
  dominanceRatio?: number;
  /** 最多产出多少条 trajectory finding（默认 5） */
  maxFindings?: number;
}

interface DenseRegion {
  from: number;
  to: number;
}

/**
 * 在归一化 turns 上检测循环 / 无进展，返回 trajectory finding 列表（按 cycleCount 降序）。
 * 纯确定性：相同输入永远得到相同结果。
 */
export function detectTrajectoryFindings(
  turns: DebugTurn[],
  options: TrajectoryDetectorOptions = {},
): AgentDebugTrajectoryFinding[] {
  const minRepeats = options.minRepeats ?? 4;
  const minRegionTurns = options.minRegionTurns ?? 10;
  const dominanceRatio = options.dominanceRatio ?? 0.6;
  const maxFindings = options.maxFindings ?? 5;

  if (!Array.isArray(turns) || turns.length < minRegionTurns) return [];

  const sigs = turns.map(signatureForTurn);

  // 每个 turn 的"进展性"：首见动作=novel（推进），复发动作=repeat（原地踏步），空=neutral。
  // 权重让"复发占比 >= dominanceRatio 的连续区间"对应正的子段和（见文件头说明）。
  const seen = new Set<string>();
  const weights = new Array<number>(turns.length);
  const isRepeat = new Array<boolean>(turns.length);
  for (let i = 0; i < turns.length; i++) {
    const s = sigs[i];
    if (!s) {
      weights[i] = 0;
      isRepeat[i] = false;
      continue;
    }
    if (seen.has(s)) {
      weights[i] = 1 - dominanceRatio;
      isRepeat[i] = true;
    } else {
      seen.add(s);
      weights[i] = -dominanceRatio;
      isRepeat[i] = false;
    }
  }

  // 反复用 max-subarray 找"复发占主导"的密集区段；找到一个就屏蔽它，再找下一个。
  const masked = weights.slice();
  const findings: AgentDebugTrajectoryFinding[] = [];
  for (let n = 0; n < maxFindings; n++) {
    const region = maxSubarray(masked);
    if (!region || region.sum <= 0) break;
    for (let i = region.from; i <= region.to; i++) masked[i] = Number.NEGATIVE_INFINITY;

    const finding = tryBuildFinding({
      turns,
      sigs,
      isRepeat,
      region: { from: region.from, to: region.to },
      minRegionTurns,
      minRepeats,
    });
    if (finding) findings.push(finding);
  }

  findings.sort((a, b) => b.cycleCount - a.cycleCount);
  return findings;
}

/** 标准 Kadane：返回和最大的连续子段 [from,to] 及其和（全 <=0 时返回单元素最大者）。 */
function maxSubarray(weights: number[]): { from: number; to: number; sum: number } | null {
  if (weights.length === 0) return null;
  let bestSum = Number.NEGATIVE_INFINITY;
  let bestFrom = 0;
  let bestTo = 0;
  let curSum = 0;
  let curFrom = 0;
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i];
    if (curSum <= 0) {
      curSum = w;
      curFrom = i;
    } else {
      curSum += w;
    }
    if (curSum > bestSum) {
      bestSum = curSum;
      bestFrom = curFrom;
      bestTo = i;
    }
  }
  return { from: bestFrom, to: bestTo, sum: bestSum };
}

function tryBuildFinding(input: {
  turns: DebugTurn[];
  sigs: string[];
  isRepeat: boolean[];
  region: DenseRegion;
  minRegionTurns: number;
  minRepeats: number;
}): AgentDebugTrajectoryFinding | null {
  const { turns, sigs, isRepeat, region, minRegionTurns, minRepeats } = input;
  const turnCount = region.to - region.from + 1;
  if (turnCount < minRegionTurns) return null;

  // 区间内各签名出现次数 → 主导动作
  const counts = new Map<string, number>();
  let repeatCount = 0;
  for (let i = region.from; i <= region.to; i++) {
    if (isRepeat[i]) repeatCount++;
    const s = sigs[i];
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  const [dominantSig, cycleCount] = ranked[0];
  if (cycleCount < minRepeats) return null;

  const ratio = repeatCount / turnCount;
  const pct = Math.round(ratio * 100);
  const label = humanLabel(dominantSig);
  const fromTurn = turns[region.from];
  const toTurn = turns[region.to];
  const fromStep = traceStep(fromTurn);
  const toStep = traceStep(toTurn);
  const spanText = fromStep != null && toStep != null ? `trace 节点 #${fromStep}–#${toStep}` : `约 ${turnCount} 个 turn`;

  const faultChain = ranked
    .filter(([, c]) => c >= 2)
    .slice(0, 4)
    .map(([s, c]) => `${humanLabel(s)} ×${c}`);

  const anchors = pickAnchors(turns, sigs, dominantSig, region);

  const noProgressEvidence =
    `区间约 ${turnCount} 个 turn，其中约 ${pct}% 是对此前已出现动作的重复（无新进展）；` +
    `主导动作「${label}」重复约 ${cycleCount} 次。`;
  const mechanism =
    `在 ${spanText}（约 ${turnCount} 个 turn）范围内，约 ${pct}% 的 turn 在重复此前已做过的动作、` +
    `几乎不产生新进展，主导动作「${label}」重复约 ${cycleCount} 次，疑似未终止循环（livelock）：` +
    `每一轮单独看都"正常"，但整体不收敛、不推进到终止条件。`;

  const confidence = clamp(
    0.5 + Math.min(cycleCount, 20) * 0.02 + Math.max(0, ratio - 0.6) * 0.3,
    0.5,
    0.92,
  );

  return {
    id: `trajectory-${region.from + 1}-${region.to + 1}`,
    kind: 'trajectory',
    pattern: 'non_termination',
    severity: 'high',
    summary: `${spanText} 之间疑似未终止循环：主导动作「${label}」重复约 ${cycleCount} 次、${pct}% 的 turn 无新进展。`,
    span: {
      fromStep,
      toStep,
      fromInteractionIndex: fromTurn?.sourceInteractionIndex ?? region.from,
      toInteractionIndex: toTurn?.sourceInteractionIndex ?? region.to,
      turnCount,
    },
    cycleCount,
    signature: dominantSig,
    noProgressEvidence,
    mechanism,
    faultChain,
    anchors,
    correctionGuidance:
      '核查该区间的循环：动作反复执行但任务状态不前进。确认是否缺少终止条件，' +
      '或存在外部依赖（如内容被压缩 / 截断、前置任务长期未完成）导致每轮从头重来；' +
      '建议加入"重复 N 次仍无进展即中止 / 上报 / 强制推进"的兜底。',
    confidence,
    detector: TRAJECTORY_DETECTOR_ID,
  };
}

// ---------------------------------------------------------------------------
// 签名：把一个 turn 归一化成可比较的"动作指纹"
// ---------------------------------------------------------------------------

function signatureForTurn(turn: DebugTurn): string {
  if (turn && Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0) {
    return turn.toolCalls
      .map((t) => `tool:${normName(t.name)}|${normArgs(t.args)}`)
      .join('+');
  }
  const text = (turn?.text || turn?.reasoningText || '').trim();
  if (!text) return '';
  return `text:${textFingerprint(text)}`;
}

function normName(name: unknown): string {
  return String(name ?? 'unknown').trim().toLowerCase().slice(0, 60);
}

/**
 * 取参数的归一化前缀：去多余空白 + 小写 + 取前缀。
 * 故意**不**抹掉数字——这样"重读同一文件 / 同一目标"会归为同一签名（循环），
 * 而"读 file_0、file_1…"或"同一文件 offset 递增"则保持不同签名（属于推进，不误报为循环）。
 */
function normArgs(args: unknown): string {
  let s: string;
  if (args == null) s = '';
  else if (typeof args === 'string') s = args;
  else {
    try {
      s = JSON.stringify(args);
    } catch {
      s = String(args);
    }
  }
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** 文本指纹：归一化后取前缀，让"措辞几乎一致"的助手消息（如反复'收到催促…'）归到同一签名 */
function textFingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}

// ---------------------------------------------------------------------------
// 证据锚点 & 小工具
// ---------------------------------------------------------------------------

/** 取区间内主导签名的代表性出现位置（首 / 中 / 末）作为证据锚点 */
function pickAnchors(turns: DebugTurn[], sigs: string[], dominantSig: string, region: DenseRegion): AgentDebugTrajectoryAnchor[] {
  const inRegion: number[] = [];
  for (let i = region.from; i <= region.to; i++) {
    if (sigs[i] === dominantSig) inRegion.push(i);
  }
  if (inRegion.length === 0) return [];
  const picks =
    inRegion.length <= 3
      ? inRegion
      : [inRegion[0], inRegion[Math.floor(inRegion.length / 2)], inRegion[inRegion.length - 1]];
  const noteMap = ['首次', '中段', '末次'];
  return picks.map((p, idx) => {
    const turn = turns[p];
    return {
      traceStepIndex: traceStep(turn) ?? undefined,
      traceNodeLabel: turn?.traceNodeLabel,
      anchorId: turn?.anchorIds?.[0],
      sourceInteractionIndex: turn?.sourceInteractionIndex,
      note: `${picks.length > 1 ? noteMap[idx] ?? '' : ''}重复出现`,
    };
  });
}

function traceStep(turn: DebugTurn | undefined): number | null {
  if (!turn) return null;
  if (typeof turn.traceStepIndex === 'number') return turn.traceStepIndex;
  if (typeof turn.turnIndex === 'number') return turn.turnIndex;
  return null;
}

function humanLabel(sig: string): string {
  if (sig.startsWith('tool:')) {
    const body = sig.slice('tool:'.length);
    const [name, arg] = body.split('|');
    const argText = (arg || '').trim();
    return argText ? `工具 ${name} ${truncate(argText, 48)}` : `工具 ${name}`;
  }
  if (sig.startsWith('text:')) {
    return `助手消息「${truncate(sig.slice('text:'.length).trim(), 32)}…」`;
  }
  return truncate(sig, 48);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
