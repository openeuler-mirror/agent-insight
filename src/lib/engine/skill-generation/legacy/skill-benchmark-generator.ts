import fs from 'fs';
import path from 'path';
import { OpenAI } from 'openai';
import {
  generateKeyActionExtractionPrompt,
  generateRootCauseExtractionPrompt,
} from '@/prompts/config-extraction-prompt';
import {
  generateOutcomeBenchmarkPrompt,
  generateRoutingBenchmarkPrompt,
} from '@/prompts/benchmark-generation-prompt';
import { configSupportsDatasetType } from '@/lib/engine/evaluation/config-dataset';
import { getConfigSubjectLabel, normalizeConfigQuery, normalizeConfigSkillName, normalizeOptionalSkillVersion } from '@/lib/engine/evaluation/config-target';
import { readConfig, type ConfigItem } from '@/lib/storage/data-service';
import { db } from '@/lib/storage/prisma';
import { getProxyConfig } from '@/lib/ingest/proxy-config';
import { deriveRoutingSignature } from '@/lib/ingest/routing-signature';
import { getActiveConfig } from '@/lib/storage/server-config';

interface SkillVersionRecord {
  version: number;
  content: string;
  changeLog?: string | null;
  assetPath?: string | null;
}

interface SkillRecord {
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  activeVersion?: number | null;
  versions?: SkillVersionRecord[];
}

interface RoutingDraft {
  query: string;
  coverage?: string;
}

interface OutcomeDraft {
  sourceScenario?: string | null;
  standardAnswer: string;
}

interface SkillBenchmarkGenerationRequest {
  skill: SkillRecord;
  version: number;
  user: string;
  includeRouting?: boolean;
  includeOutcome?: boolean;
  routingCount?: number;
}

export interface SkillBenchmarkGenerationResult {
  generator_skills: string[];
  skill: {
    id: string;
    name: string;
    version: number;
  };
  created: {
    routing: ConfigItem[];
    outcome: ConfigItem[];
  };
  skipped: {
    routingDuplicates: string[];
    outcomeAlreadyExists: boolean;
  };
  inventory: {
    routingCount: number;
    outcomeCount: number;
  };
}

function parseJsonPayload<T>(raw: string): T {
  let jsonStr = raw.trim();
  const fenced = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    jsonStr = fenced[1];
  } else {
    const objectStart = jsonStr.indexOf('{');
    const arrayStart = jsonStr.indexOf('[');
    let start = -1;
    if (objectStart === -1) start = arrayStart;
    else if (arrayStart === -1) start = objectStart;
    else start = Math.min(objectStart, arrayStart);

    if (start !== -1) {
      const lastObject = jsonStr.lastIndexOf('}');
      const lastArray = jsonStr.lastIndexOf(']');
      const end = Math.max(lastObject, lastArray);
      if (end >= start) {
        jsonStr = jsonStr.slice(start, end + 1);
      }
    }
  }

  return JSON.parse(jsonStr) as T;
}

function dedupeQueries(queries: RoutingDraft[]): RoutingDraft[] {
  const seen = new Set<string>();
  const result: RoutingDraft[] = [];

  for (const item of queries) {
    const normalized = normalizeConfigQuery(item.query);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({
      query: normalized,
      coverage: typeof item.coverage === 'string' ? item.coverage.trim() : '',
    });
  }

  return result;
}

function loadAuxiliarySummaries(assetPath?: string | null): string[] {
  if (!assetPath) return [];

  const metaPath = path.join(process.cwd(), assetPath, 'AUXILIARY_META.json');
  if (!fs.existsSync(metaPath)) return [];

  try {
    const raw = fs.readFileSync(metaPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.entries(parsed)
      .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
      .map(([file, summary]) => `${file}: ${summary}`);
  } catch (error) {
    console.warn('[SkillBenchmarkGenerator] Failed to read AUXILIARY_META.json:', error);
    return [];
  }
}

function getTargetVersion(skill: SkillRecord, version: number): SkillVersionRecord {
  const target = skill.versions?.find(item => item.version === version);
  if (!target || !target.content?.trim()) {
    throw new Error(`Skill version v${version} is missing or empty`);
  }
  return target;
}

async function createConfiguredClient(user: string): Promise<{ client: OpenAI; model: string; }> {
  const settings = await getActiveConfig(user);
  if (!settings) {
    throw new Error('No active evaluation model configured for this user');
  }

  const { customFetch } = getProxyConfig();
  return {
    client: new OpenAI({
      apiKey: settings.apiKey || 'no-api-key-required',
      baseURL: settings.baseUrl || 'https://api.deepseek.com',
      fetch: customFetch,
    }),
    model: settings.model || 'deepseek-chat',
  };
}

async function completeJsonPrompt(client: OpenAI, model: string, prompt: string) {
  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Model returned empty content for benchmark generation');
  }

  return content;
}

async function generateRoutingDrafts(
  client: OpenAI,
  model: string,
  skill: SkillRecord,
  version: SkillVersionRecord,
  count: number,
  existingQueries: string[],
) {
  const prompt = generateRoutingBenchmarkPrompt({
    skillName: skill.name,
    skillVersion: version.version,
    skillDescription: skill.description,
    skillCategory: skill.category,
    changeLog: version.changeLog,
    auxiliarySummaries: loadAuxiliarySummaries(version.assetPath),
    skillContent: version.content,
    count,
    existingQueries,
  });

  const raw = await completeJsonPrompt(client, model, prompt);
  const parsed = parseJsonPayload<{ benchmarks?: RoutingDraft[] }>(raw);
  const drafts = Array.isArray(parsed.benchmarks) ? parsed.benchmarks : [];
  return dedupeQueries(drafts).slice(0, count);
}

async function generateOutcomeDraft(
  client: OpenAI,
  model: string,
  skill: SkillRecord,
  version: SkillVersionRecord,
) {
  const prompt = generateOutcomeBenchmarkPrompt({
    skillName: skill.name,
    skillVersion: version.version,
    skillDescription: skill.description,
    skillCategory: skill.category,
    changeLog: version.changeLog,
    auxiliarySummaries: loadAuxiliarySummaries(version.assetPath),
    skillContent: version.content,
  });

  const raw = await completeJsonPrompt(client, model, prompt);
  const parsed = parseJsonPayload<{ benchmark?: OutcomeDraft }>(raw);
  const benchmark = parsed.benchmark;
  if (!benchmark || typeof benchmark.standardAnswer !== 'string' || !benchmark.standardAnswer.trim()) {
    throw new Error('Outcome benchmark generation returned an empty standard answer');
  }

  return {
    sourceScenario: normalizeConfigQuery(benchmark.sourceScenario),
    standardAnswer: benchmark.standardAnswer.trim(),
  };
}

async function generateOutcomeCriteria(
  client: OpenAI,
  model: string,
  query: string | null,
  skillName: string,
  skillVersion: number | null,
  skillContent: string,
  standardAnswer: string,
) {
  const taskContext = getConfigSubjectLabel({ query, skill: skillName, skillVersion });
  const rootCausePrompt = generateRootCauseExtractionPrompt(taskContext, standardAnswer);
  const rootCauseRaw = await completeJsonPrompt(client, model, rootCausePrompt);
  const rootCauseParsed = parseJsonPayload<{
    root_causes?: { content: string; weight?: number }[];
  }>(rootCauseRaw);

  const skillLabel = `${skillName}${skillVersion != null ? ` v${skillVersion}` : ''}`;
  const keyActionPrompt = generateKeyActionExtractionPrompt(skillLabel, skillContent);
  const keyActionRaw = await completeJsonPrompt(client, model, keyActionPrompt);
  const keyActionParsed = parseJsonPayload<{
    key_actions?: { content: string; weight?: number }[];
  }>(keyActionRaw);

  const normalizeItems = (items?: { content: string; weight?: number }[]) =>
    Array.isArray(items)
      ? items
          .filter(item => typeof item?.content === 'string' && item.content.trim())
          .map(item => ({
            content: item.content.trim(),
            weight: typeof item.weight === 'number' ? item.weight : 1,
          }))
      : [];

  return {
    rootCauses: normalizeItems(rootCauseParsed.root_causes),
    keyActions: normalizeItems(keyActionParsed.key_actions),
  };
}

function matchesRoutingSkill(config: ConfigItem, skillName: string, version: number | null) {
  if (!configSupportsDatasetType(config.dataset_type, 'routing')) return false;
  return (config.expectedSkills || []).some(expected => {
    const sameName = normalizeConfigSkillName(expected.skill) === skillName;
    if (!sameName) return false;
    if (version == null) return true;
    return expected.version == null || expected.version === version;
  });
}

function matchesOutcomeSkill(config: ConfigItem, skillName: string, version: number | null) {
  if (!configSupportsDatasetType(config.dataset_type, 'outcome')) return false;
  return normalizeConfigSkillName(config.skill) === skillName
    && normalizeOptionalSkillVersion(config.skillVersion) === version;
}

async function computeInventory(user: string, skillName: string, version: number | null) {
  const configs = await readConfig(user);
  return {
    routingCount: configs.filter(config => matchesRoutingSkill(config, skillName, version)).length,
    outcomeCount: configs.filter(config => matchesOutcomeSkill(config, skillName, version)).length,
  };
}

function toConfigItem(config: any): ConfigItem {
  return {
    id: config.id,
    query: config.query ?? null,
    dataset_type: config.datasetType,
    skill: config.skill || '',
    skillVersion: config.skillVersion ?? null,
    routing_intent: config.routingIntent || undefined,
    routing_anchors: config.routingAnchors ? JSON.parse(config.routingAnchors) : undefined,
    expectedSkills: config.expectedSkills ? JSON.parse(config.expectedSkills) : undefined,
    standard_answer: config.standardAnswer || '',
    root_causes: config.rootCauses ? JSON.parse(config.rootCauses) : undefined,
    key_actions: config.keyActions ? JSON.parse(config.keyActions) : undefined,
    parse_status: config.parseStatus || 'completed',
  };
}

export async function generateBenchmarksForSkill(
  request: SkillBenchmarkGenerationRequest,
): Promise<SkillBenchmarkGenerationResult> {
  const includeRouting = request.includeRouting !== false;
  const includeOutcome = request.includeOutcome !== false;
  const routingCount = Math.min(Math.max(request.routingCount ?? 4, 1), 8);
  const skillName = normalizeConfigSkillName(request.skill.name);
  const targetVersionNumber = normalizeOptionalSkillVersion(request.version);

  if (!skillName) {
    throw new Error('Target skill name is empty');
  }
  if (targetVersionNumber == null) {
    throw new Error('Target skill version is invalid');
  }

  const targetVersion = getTargetVersion(request.skill, targetVersionNumber);
  const { client, model } = await createConfiguredClient(request.user);
  const configs = await readConfig(request.user);

  const allRoutingQueries = new Set(
    configs
      .filter(config => configSupportsDatasetType(config.dataset_type, 'routing'))
      .map(config => normalizeConfigQuery(config.query))
      .filter((query): query is string => Boolean(query)),
  );

  const existingSkillQueries = configs
    .filter(config => matchesRoutingSkill(config, skillName, targetVersionNumber))
    .map(config => normalizeConfigQuery(config.query))
    .filter((query): query is string => Boolean(query));

  const existingOutcomeConfig = configs.find(config => matchesOutcomeSkill(config, skillName, targetVersionNumber));

  const createdRouting: ConfigItem[] = [];
  const createdOutcome: ConfigItem[] = [];
  const skippedRoutingDuplicates: string[] = [];

  if (includeRouting) {
    const routingDrafts = await generateRoutingDrafts(
      client,
      model,
      request.skill,
      targetVersion,
      routingCount,
      existingSkillQueries,
    );

    for (const draft of routingDrafts) {
      const normalizedQuery = normalizeConfigQuery(draft.query);
      if (!normalizedQuery) continue;
      if (allRoutingQueries.has(normalizedQuery)) {
        skippedRoutingDuplicates.push(normalizedQuery);
        continue;
      }

      const signature = await deriveRoutingSignature(normalizedQuery, request.user);
      if (!signature) {
        throw new Error(`Failed to derive routing signature for generated query: ${normalizedQuery}`);
      }

      const created = await db.createConfig({
        query: normalizedQuery,
        skill: '',
        skillVersion: null,
        datasetType: 'routing',
        routingIntent: signature.intent,
        routingAnchors: JSON.stringify(signature.anchors),
        expectedSkills: JSON.stringify([{ skill: skillName, version: targetVersionNumber }]),
        standardAnswer: '',
        rootCauses: null,
        keyActions: null,
        user: request.user,
        parseStatus: 'completed',
      });

      createdRouting.push(toConfigItem(created));
      allRoutingQueries.add(normalizedQuery);
    }
  }

  if (includeOutcome && !existingOutcomeConfig) {
    const outcomeDraft = await generateOutcomeDraft(client, model, request.skill, targetVersion);
    const criteria = await generateOutcomeCriteria(
      client,
      model,
      outcomeDraft.sourceScenario,
      skillName,
      targetVersionNumber,
      targetVersion.content,
      outcomeDraft.standardAnswer,
    );

    const created = await db.createConfig({
      query: outcomeDraft.sourceScenario,
      skill: skillName,
      skillVersion: targetVersionNumber,
      datasetType: 'outcome',
      routingIntent: null,
      routingAnchors: null,
      expectedSkills: null,
      standardAnswer: outcomeDraft.standardAnswer,
      rootCauses: JSON.stringify(criteria.rootCauses),
      keyActions: JSON.stringify(criteria.keyActions),
      user: request.user,
      parseStatus: 'completed',
    });

    createdOutcome.push(toConfigItem(created));
  }

  return {
    generator_skills: [
      'skill-benchmark-generator',
      'routing-benchmark-generator',
      'outcome-benchmark-generator',
    ],
    skill: {
      id: request.skill.id,
      name: skillName,
      version: targetVersionNumber,
    },
    created: {
      routing: createdRouting,
      outcome: createdOutcome,
    },
    skipped: {
      routingDuplicates: skippedRoutingDuplicates,
      outcomeAlreadyExists: Boolean(existingOutcomeConfig),
    },
    inventory: await computeInventory(request.user, skillName, targetVersionNumber),
  };
}
