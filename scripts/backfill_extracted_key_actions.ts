import { db } from '../src/lib/storage/prisma';
import { normalizeExpectedSkills, normalizeConfigDatasetType } from '../src/lib/engine/evaluation/config-dataset';
import { normalizeConfigSkillName, normalizeOptionalSkillVersion } from '../src/lib/engine/evaluation/config-target';
import {
  parseSkillFlow,
  extractKeyActionsFromFlow,
  mergeKeyActionsFromMultipleSkills,
  type ExtractedKeyAction,
  type ParsedFlowResult,
} from '../src/lib/engine/observability/flow-parser';

type RawConfigRecord = {
  id: string;
  user?: string | null;
  query?: string | null;
  skill?: string | null;
  skillVersion?: number | null;
  datasetType?: string | null;
  expectedSkills?: string | null;
  keyActions?: string | null;
  extractedKeyActions?: string | null;
};

type FlowTarget = {
  skill: string;
  version: number | null;
};

type ParsedSkillCacheValue = {
  skill: string;
  version: number;
  actions: ExtractedKeyAction[];
};

function parseArgs() {
  const args = process.argv.slice(2);
  let user: string | null = null;
  let write = false;
  const includeSkills = new Set<string>();
  const excludeSkills = new Set<string>();
  const includeVersions = new Set<string>();
  const excludeVersions = new Set<string>();

  const parseVersionArg = (value: unknown): number | null | undefined => {
    if (typeof value === 'string') {
      const trimmed = value.trim().toLowerCase();
      if (!trimmed) return undefined;
      if (trimmed === 'null') return null;
    }

    const version = normalizeOptionalSkillVersion(value);
    return version == null ? undefined : version;
  };

  const toVersionFilterKey = (value: number | null) => (value == null ? 'null' : String(value));

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--user') {
      user = args[i + 1] || null;
      i += 1;
      continue;
    }
    if (arg === '--write') {
      write = true;
      continue;
    }
    if (arg === '--include-skill') {
      const skill = normalizeConfigSkillName(args[i + 1]);
      if (skill) includeSkills.add(skill);
      i += 1;
      continue;
    }
    if (arg === '--exclude-skill') {
      const skill = normalizeConfigSkillName(args[i + 1]);
      if (skill) excludeSkills.add(skill);
      i += 1;
      continue;
    }
    if (arg === '--include-version') {
      const version = parseVersionArg(args[i + 1]);
      if (version !== undefined) includeVersions.add(toVersionFilterKey(version));
      i += 1;
      continue;
    }
    if (arg === '--exclude-version') {
      const version = parseVersionArg(args[i + 1]);
      if (version !== undefined) excludeVersions.add(toVersionFilterKey(version));
      i += 1;
      continue;
    }
  }

  return { user, write, includeSkills, excludeSkills, includeVersions, excludeVersions };
}

function getKeyActionFlowTargets(config: RawConfigRecord): FlowTarget[] {
  const targets = new Map<string, FlowTarget>();

  const addTarget = (rawSkill: unknown, rawVersion: unknown) => {
    const skill = normalizeConfigSkillName(rawSkill);
    if (!skill) return;

    const version = normalizeOptionalSkillVersion(rawVersion);
    targets.set(`${skill}::${version ?? 'any'}`, { skill, version });
  };

  addTarget(config.skill, config.skillVersion);

  let expectedSkills: { skill: string; version: number | null }[] = [];
  if (config.expectedSkills) {
    try {
      expectedSkills = normalizeExpectedSkills(JSON.parse(config.expectedSkills));
    } catch {
      expectedSkills = [];
    }
  }

  for (const expected of expectedSkills) {
    addTarget(expected.skill, expected.version);
  }

  return Array.from(targets.values());
}

function buildStoredKeyActions(actions: ExtractedKeyAction[]) {
  return actions.map(action => ({
    content: action.content,
    weight: action.weight,
    ...(action.controlFlowType !== 'required' ? { controlFlowType: action.controlFlowType } : {}),
    ...(action.condition ? { condition: action.condition } : {}),
    ...(action.branchLabel ? { branchLabel: action.branchLabel } : {}),
    ...(action.loopCondition ? { loopCondition: action.loopCondition } : {}),
    ...(action.expectedMinCount !== undefined ? { expectedMinCount: action.expectedMinCount } : {}),
    ...(action.expectedMaxCount !== undefined ? { expectedMaxCount: action.expectedMaxCount } : {}),
    ...(action.groupId ? { groupId: action.groupId } : {}),
  }));
}

async function resolveSkillRecord(skillName: string, user: string | null) {
  const candidates = await db.findSkills({
    OR: [
      { user },
      { user: null },
    ],
  });

  const normalizedSkill = normalizeConfigSkillName(skillName).toLowerCase();
  return candidates
    .filter((item: any) => normalizeConfigSkillName(item.name).toLowerCase() === normalizedSkill)
    .sort((a: any, b: any) => Number((b.user || null) === user) - Number((a.user || null) === user))[0] || null;
}

async function deriveTargetActions(
  target: FlowTarget,
  user: string | null,
  cache: Map<string, ParsedSkillCacheValue>
): Promise<ParsedSkillCacheValue | null> {
  const cacheKey = `${user ?? '__global__'}::${target.skill}::${target.version ?? 'any'}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const skillRecord = await resolveSkillRecord(target.skill, user);
  if (!skillRecord) {
    console.warn(`[Backfill] Skill "${target.skill}" not found for user ${user ?? 'null'}`);
    return null;
  }

  const resolvedVersion = target.version
    ?? skillRecord.activeVersion
    ?? skillRecord.versions?.[0]?.version
    ?? null;

  if (resolvedVersion == null) {
    console.warn(`[Backfill] Skill "${target.skill}" has no resolvable version`);
    return null;
  }

  let parsedFlow = await db.findParsedFlow(skillRecord.id, resolvedVersion, user);

  if (!parsedFlow?.flowJson) {
    const skillVersion = skillRecord.versions?.find((item: any) => item.version === resolvedVersion)
      || skillRecord.versions?.[0];

    if (!skillVersion?.content) {
      console.warn(`[Backfill] Skill "${target.skill}" v${resolvedVersion} has no content for flow parsing`);
      return null;
    }

    console.log(`[Backfill] Parsing flow for ${target.skill} v${resolvedVersion}`);
    const parseResult = await parseSkillFlow(skillVersion.content, skillRecord.id, resolvedVersion, user);
    if (!parseResult.success || !parseResult.flow) {
      console.warn(`[Backfill] Failed to parse flow for ${target.skill} v${resolvedVersion}: ${parseResult.error || 'unknown error'}`);
      return null;
    }

    parsedFlow = {
      flowJson: JSON.stringify(parseResult.flow),
    };
  }

  const flow: ParsedFlowResult = JSON.parse(parsedFlow.flowJson);
  const actions = extractKeyActionsFromFlow(flow).map(action => ({
    ...action,
    skillSource: action.skillSource || target.skill,
  }));

  if (actions.length === 0) {
    console.warn(`[Backfill] Parsed flow for ${target.skill} v${resolvedVersion} produced no key actions`);
    return null;
  }

  const result = {
    skill: target.skill,
    version: resolvedVersion,
    actions,
  };

  cache.set(cacheKey, result);
  return result;
}

async function main() {
  const { user, write, includeSkills, excludeSkills, includeVersions, excludeVersions } = parseArgs();
  const cache = new Map<string, ParsedSkillCacheValue>();

  const where = user ? { user } : {};
  const configs = (await db.findConfigs(where)) as RawConfigRecord[];
  const targetConfigs = configs.filter(config => {
    const datasetType = normalizeConfigDatasetType(config.datasetType);
    if ((datasetType !== 'outcome' && datasetType !== 'combined') || config.extractedKeyActions) {
      return false;
    }

    const skill = normalizeConfigSkillName(config.skill);
    const versionFilterKey = config.skillVersion == null ? 'null' : String(config.skillVersion);
    if (includeSkills.size > 0 && !includeSkills.has(skill)) {
      return false;
    }
    if (excludeSkills.has(skill)) {
      return false;
    }
    if (includeVersions.size > 0 && !includeVersions.has(versionFilterKey)) {
      return false;
    }
    if (excludeVersions.has(versionFilterKey)) {
      return false;
    }

    return true;
  });

  console.log(`[Backfill] Loaded ${configs.length} configs, ${targetConfigs.length} need extracted key action backfill`);

  let updatedCount = 0;
  let skippedCount = 0;

  for (const config of targetConfigs) {
    const targets = getKeyActionFlowTargets(config);
    if (targets.length === 0) {
      console.warn(`[Backfill] Config ${config.id} has no skill targets, skipping`);
      skippedCount += 1;
      continue;
    }

    const allActions: { name: string; actions: ExtractedKeyAction[] }[] = [];
    for (const target of targets) {
      const parsed = await deriveTargetActions(target, config.user || null, cache);
      if (parsed) {
        allActions.push({ name: parsed.skill, actions: parsed.actions });
      }
    }

    if (allActions.length === 0) {
      console.warn(`[Backfill] Config ${config.id} could not derive any flow actions`);
      skippedCount += 1;
      continue;
    }

    const mergedActions = allActions.length === 1
      ? allActions[0].actions
      : mergeKeyActionsFromMultipleSkills(allActions);
    const storedKeyActions = buildStoredKeyActions(mergedActions);

    console.log(
      `[Backfill] ${write ? 'Updating' : 'Would update'} config ${config.id} `
      + `(${normalizeConfigSkillName(config.skill) || 'no-skill'}) with ${mergedActions.length} shared flow actions`
    );

    if (write) {
      await db.updateConfig(config.id, {
        keyActions: JSON.stringify(storedKeyActions),
        extractedKeyActions: JSON.stringify(mergedActions),
      });
    }

    updatedCount += 1;
  }

  console.log(`[Backfill] Done. ${write ? 'Updated' : 'Would update'} ${updatedCount} configs, skipped ${skippedCount}.`);
}

main().catch((error) => {
  console.error('[Backfill] Fatal error:', error);
  process.exit(1);
});
