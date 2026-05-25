
import { db } from '@/lib/storage/prisma';
import { getProxyConfig } from '@/lib/ingest/proxy-config';
import { getActiveConfig } from '@/lib/storage/server-config';
import {
    generateAnswerExtractionPrompt,
    generateKeyActionExtractionPrompt,
    generateRootCauseExtractionPrompt,
} from '@/prompts/config-extraction-prompt';
import { configSupportsDatasetType, normalizeConfigDatasetType, type ConfigDatasetType } from '@/lib/engine/evaluation/config-dataset';
import { getConfigSubjectLabel, normalizeConfigQuery, normalizeConfigSkillName, normalizeOptionalSkillVersion } from '@/lib/engine/evaluation/config-target';
import { deriveRoutingSignature } from '@/lib/ingest/routing-signature';
import { extractKeyActionsFromFlow, mergeKeyActionsFromMultipleSkills, type ExtractedKeyAction, type ParsedFlowResult } from '@/lib/engine/observability/flow-parser';
import { NextResponse } from 'next/server';
import { OpenAI } from "openai";
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

export const dynamic = 'force-dynamic';

function parseJsonPayload<T>(raw: string): T {
    let jsonStr = raw.trim();
    const fenced = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) {
        jsonStr = fenced[1];
    } else {
        const first = jsonStr.indexOf('{');
        const last = jsonStr.lastIndexOf('}');
        if (first !== -1 && last !== -1 && last >= first) {
            jsonStr = jsonStr.substring(first, last + 1);
        }
    }
    return JSON.parse(jsonStr) as T;
}

function normalizeCriteriaItems(items?: { content?: string; weight?: number }[]) {
    return Array.isArray(items)
        ? items
            .filter(item => typeof item?.content === 'string' && item.content.trim())
            .map(item => ({
                content: item.content!.trim(),
                weight: typeof item?.weight === 'number' ? item.weight : 1,
            }))
        : [];
}

async function resolveSkillDefinition(
    skillName: string | null,
    skillVersion: number | null,
    user?: string | null,
) {
    const normalizedSkill = normalizeConfigSkillName(skillName);
    if (!normalizedSkill) return null;

    const skills = await db.findSkills({
        OR: [
            { user: user || null },
            { user: null },
        ],
    });

    const matchedSkill = skills
        .filter((item: any) => normalizeConfigSkillName(item.name) === normalizedSkill)
        .sort((a: any, b: any) => {
            const aExactUser = Number((a.user || null) === (user || null));
            const bExactUser = Number((b.user || null) === (user || null));
            return bExactUser - aExactUser;
        })[0];

    if (!matchedSkill || !Array.isArray(matchedSkill.versions) || matchedSkill.versions.length === 0) {
        return null;
    }

    const versionRecord = skillVersion != null
        ? matchedSkill.versions.find((item: any) => item.version === skillVersion)
        : matchedSkill.versions.find((item: any) => item.version === (matchedSkill.activeVersion ?? null)) || matchedSkill.versions[0];

    if (!versionRecord?.content) {
        return null;
    }

    return {
        skill: matchedSkill,
        version: versionRecord.version ?? skillVersion ?? null,
        content: versionRecord.content as string,
    };
}

async function findReusableKeyActions(
    skillName: string | null,
    skillVersion: number | null,
    user?: string | null,
    excludeConfigId?: string,
) {
    const normalizedSkill = normalizeConfigSkillName(skillName);
    if (!normalizedSkill) return [];

    const configs = await db.findConfigs({
        OR: [
            { user: user || null },
            { user: null },
        ],
    });

    const matched = configs
        .filter((config: any) => config.id !== excludeConfigId)
        .filter((config: any) => normalizeConfigDatasetType(config.datasetType) === 'outcome')
        .filter((config: any) => normalizeConfigSkillName(config.skill) === normalizedSkill)
        .filter((config: any) => (config.skillVersion ?? null) === (skillVersion ?? null))
        .map((config: any) => ({
            query: normalizeConfigQuery(config.query),
            keyActions: normalizeCriteriaItems(config.keyActions ? JSON.parse(config.keyActions) : []),
        }))
        .filter(item => item.keyActions.length > 0)
        .sort((a, b) => Number(a.query !== null) - Number(b.query !== null));

    return matched[0]?.keyActions || [];
}

function normalizeFlowTargets(
    skill: string | null,
    skillVersion: number | null,
    expectedSkills?: { skill: string; version: number | null }[] | null,
) {
    const targets = new Map<string, { skill: string; version: number | null }>();

    const addTarget = (rawSkill: string | null | undefined, rawVersion: number | null | undefined) => {
        const normalizedSkill = normalizeConfigSkillName(rawSkill);
        if (!normalizedSkill) return;

        const version = rawVersion ?? null;
        targets.set(`${normalizedSkill}::${version ?? 'any'}`, {
            skill: normalizedSkill,
            version,
        });
    };

    addTarget(skill, skillVersion);

    for (const item of expectedSkills || []) {
        addTarget(item?.skill, normalizeOptionalSkillVersion(item?.version));
    }

    return Array.from(targets.values());
}

async function extractKeyActionsFromTargetFlows(
    targets: { skill: string; version: number | null }[],
    user?: string | null,
): Promise<{
    keyActions: { content: string; weight: number; controlFlowType?: string; condition?: string; branchLabel?: string; loopCondition?: string; expectedMinCount?: number; expectedMaxCount?: number; groupId?: string }[];
    extractedKeyActions: ExtractedKeyAction[] | null;
}> {
    const allActions: { name: string; actions: ExtractedKeyAction[] }[] = [];

    for (const target of targets) {
        const skillRecord = await db.findSkill(target.skill, user || null);
        if (!skillRecord) {
            console.warn(`[ConfigCreate] Skill "${target.skill}" not found, skipping flow-based key action extraction`);
            continue;
        }

        const resolvedVersion = target.version
            ?? skillRecord.activeVersion
            ?? skillRecord.versions?.[0]?.version
            ?? null;
        if (resolvedVersion == null) {
            continue;
        }

        const parsedFlow = await db.findParsedFlow(skillRecord.id, resolvedVersion, user || null);
        if (!parsedFlow?.flowJson) {
            console.warn(`[ConfigCreate] No parsed flow for skill "${target.skill}" v${resolvedVersion}, skipping`);
            continue;
        }

        const flow: ParsedFlowResult = JSON.parse(parsedFlow.flowJson);
        const actions = extractKeyActionsFromFlow(flow).map(action => ({
            ...action,
            skillSource: action.skillSource || target.skill,
        }));

        if (actions.length > 0) {
            allActions.push({ name: target.skill, actions });
        }
    }

    if (allActions.length === 0) {
        return { keyActions: [], extractedKeyActions: null };
    }

    const extractedActions = allActions.length === 1
        ? allActions[0].actions
        : mergeKeyActionsFromMultipleSkills(allActions);

    return {
        keyActions: extractedActions.map(action => ({
            content: action.content,
            weight: action.weight,
            ...(action.controlFlowType !== 'required' ? { controlFlowType: action.controlFlowType } : {}),
            ...(action.condition ? { condition: action.condition } : {}),
            ...(action.branchLabel ? { branchLabel: action.branchLabel } : {}),
            ...(action.loopCondition ? { loopCondition: action.loopCondition } : {}),
            ...(action.expectedMinCount !== undefined ? { expectedMinCount: action.expectedMinCount } : {}),
            ...(action.expectedMaxCount !== undefined ? { expectedMaxCount: action.expectedMaxCount } : {}),
            ...(action.groupId ? { groupId: action.groupId } : {}),
        })),
        extractedKeyActions: extractedActions,
    };
}

async function processConfigAsync(
    configId: string, 
    query: string | null,
    standardAnswer: string, 
    documentContent: string | null,
    datasetType: ConfigDatasetType,
    skill: string | null,
    skillVersion: number | null,
    expectedSkills: { skill: string; version: number | null }[] | null,
    user?: string | null
) {
    try {
        const settings = await getActiveConfig(user);
        if (!settings) {
            console.error(`[ConfigCreate] No model configuration for user: ${user}`);
            await db.updateConfig(configId, { parseStatus: 'failed' });
            return;
        }

        const { customFetch } = getProxyConfig();
        const openaiClient = new OpenAI({
            apiKey: settings.apiKey || 'no-api-key-required',
            baseURL: settings.baseUrl || 'https://api.deepseek.com',
            fetch: customFetch,
        });
        const modelName = settings.model || 'deepseek-chat';

        const taskContext = getConfigSubjectLabel({ query, skill, skillVersion });
        const updates: Record<string, unknown> = {};

        if (configSupportsDatasetType(datasetType, 'routing')) {
            if (!query) {
                throw new Error('Routing dataset requires query for semantic signature extraction');
            }
            const routingSignature = await deriveRoutingSignature(query, user);
            if (!routingSignature) {
                throw new Error('Failed to derive routing semantic signature');
            }

            updates.routingIntent = routingSignature.intent;
            updates.routingAnchors = JSON.stringify(routingSignature.anchors);
        }

        if (configSupportsDatasetType(datasetType, 'outcome') && documentContent && !standardAnswer) {
            try {
                const prompt = generateAnswerExtractionPrompt(taskContext, documentContent);
                const response = await openaiClient.chat.completions.create({
                    messages: [{ role: "user", content: prompt }],
                    model: modelName,
                });

                const content = response.choices[0].message.content;
                if (!content) {
                    throw new Error('No content returned from LLM for document extraction');
                }

                let jsonStr = content.trim();
                const matchParse = jsonStr.match(/```(?:json)?\\s*([\\s\\S]*?)\\s*```/i);
                if (matchParse) {
                    jsonStr = matchParse[1];
                } else {
                    const first = jsonStr.indexOf('{');
                    const last = jsonStr.lastIndexOf('}');
                    if (first !== -1 && last !== -1 && last >= first) {
                        jsonStr = jsonStr.substring(first, last + 1);
                    }
                }
                const parsed = JSON.parse(jsonStr);
                standardAnswer = parsed.standard_answer?.trim() || '';

                if (!standardAnswer) {
                    throw new Error('Extracted standard answer is empty');
                }

                updates.standardAnswer = standardAnswer;

                console.log(`[ConfigCreate] Successfully extracted standard answer for config ${configId}`);
            } catch (e: any) {
                console.error(`[ConfigCreate] Failed to extract standard answer for config ${configId}:`, e.message);
                await db.updateConfig(configId, { parseStatus: 'failed' }).catch(() => {});
                return;
            }
        }

        if (configSupportsDatasetType(datasetType, 'outcome')) {
            let extractedKeyActionsData: ExtractedKeyAction[] | null = null;

            if (standardAnswer.trim()) {
                const rootCausePrompt = generateRootCauseExtractionPrompt(taskContext, standardAnswer);
                const response = await openaiClient.chat.completions.create({
                    messages: [{ role: "user", content: rootCausePrompt }],
                    model: modelName,
                });

                const content = response.choices[0].message.content;
                if (!content) {
                    throw new Error('No content returned from LLM for key point extraction');
                }

                const extractedData = parseJsonPayload<{ root_causes?: { content?: string; weight?: number }[] }>(content);
                updates.rootCauses = JSON.stringify(normalizeCriteriaItems(extractedData.root_causes));
            } else {
                updates.rootCauses = JSON.stringify([]);
            }

            let keyActions = await findReusableKeyActions(skill, skillVersion, user, configId);
            if (keyActions.length === 0) {
                const flowTargets = normalizeFlowTargets(skill, skillVersion, expectedSkills);
                if (flowTargets.length > 0) {
                    const derived = await extractKeyActionsFromTargetFlows(flowTargets, user);
                    keyActions = derived.keyActions;
                    extractedKeyActionsData = derived.extractedKeyActions;
                }
            }

            if (keyActions.length === 0) {
                const skillDefinition = await resolveSkillDefinition(skill, skillVersion, user);
                if (skillDefinition) {
                    const skillLabel = `${normalizeConfigSkillName(skill)}${skillDefinition.version != null ? ` v${skillDefinition.version}` : ''}`;
                    const keyActionPrompt = generateKeyActionExtractionPrompt(skillLabel, skillDefinition.content);
                    const response = await openaiClient.chat.completions.create({
                        messages: [{ role: "user", content: keyActionPrompt }],
                        model: modelName,
                    });

                    const content = response.choices[0].message.content;
                    if (!content) {
                        throw new Error('No content returned from LLM for key action extraction');
                    }

                    const extractedData = parseJsonPayload<{ key_actions?: { content?: string; weight?: number }[] }>(content);
                    keyActions = normalizeCriteriaItems(extractedData.key_actions);
                }
            }

            updates.keyActions = JSON.stringify(keyActions);
            updates.extractedKeyActions = extractedKeyActionsData ? JSON.stringify(extractedKeyActionsData) : null;

            console.log(`[ConfigCreate] Successfully extracted outcome criteria for config ${configId}`);
        }

        await db.updateConfig(configId, {
            ...updates,
            parseStatus: 'completed'
        });
    } catch (error: any) {
        console.error(`[ConfigCreate] Failed to process config ${configId}:`, error.message);
        await db.updateConfig(configId, { parseStatus: 'failed' }).catch(() => {});
    }
}

export async function POST(request: Request) {
    try {
        const contentType = request.headers.get('content-type') || '';
        
        let query: string | null = null;
        let standardAnswer = '';
        let user: string | null = null;
        let documentContent: string | null = null;
        let datasetType: ConfigDatasetType = 'combined';

        let skill: string | null = null;
        let skillVersion: number | null = null;
        let expectedSkills: { skill: string; version: number | null }[] | null = null;

        if (contentType.includes('multipart/form-data')) {
            const formData = await request.formData();
            query = normalizeConfigQuery(formData.get('query'));
            standardAnswer = formData.get('standardAnswer') as string || '';
            user = formData.get('user') as string || null;
            datasetType = normalizeConfigDatasetType(formData.get('datasetType') as string || null);
            skill = normalizeConfigSkillName(formData.get('skill'));
            skillVersion = normalizeOptionalSkillVersion(formData.get('skillVersion'));
            
            const expectedSkillsStr = formData.get('expectedSkills') as string || null;
            if (expectedSkillsStr) {
                try {
                    expectedSkills = JSON.parse(expectedSkillsStr);
                    if (expectedSkills && Array.isArray(expectedSkills)) {
                        for (const item of expectedSkills) {
                            if (!item || typeof item !== 'object') {
                                return NextResponse.json({ error: 'expectedSkills 数组中的每个元素必须是对象' }, { status: 400 });
                            }
                            if (!item.skill || typeof item.skill !== 'string' || !item.skill.trim()) {
                                return NextResponse.json({ error: 'expectedSkills 中的每个技能必须包含 skill 名称' }, { status: 400 });
                            }
                        }
                        expectedSkills = expectedSkills.map((item: any) => ({
                            ...item,
                            version: normalizeOptionalSkillVersion(item.version)
                        }));
                    } else if (expectedSkills !== null) {
                        return NextResponse.json({ error: 'expectedSkills 必须是 JSON 数组' }, { status: 400 });
                    }
                } catch (e) {
                    console.error('Failed to parse expectedSkills:', e);
                    return NextResponse.json({ error: 'expectedSkills JSON 格式无效' }, { status: 400 });
                }
            }

            const file = formData.get('document') as File | null;
            if (file) {
                const fileName = file.name.toLowerCase();
                if (fileName.endsWith('.pdf')) {
                    const arrayBuffer = await file.arrayBuffer();
                    const buffer = Buffer.from(arrayBuffer);
                    const pdfData = await pdfParse(buffer);
                    documentContent = pdfData.text;
                } else {
                    documentContent = await file.text();
                }
            }
        } else {
            const body = await request.json();
            query = normalizeConfigQuery(body.query);
            standardAnswer = body.standardAnswer || '';
            user = body.user || null;
            documentContent = body.documentContent || null;
            datasetType = normalizeConfigDatasetType(body.datasetType);
            skill = normalizeConfigSkillName(body.skill);
            skillVersion = normalizeOptionalSkillVersion(body.skillVersion);
            expectedSkills = body.expectedSkills || null;
            if (expectedSkills && Array.isArray(expectedSkills)) {
                expectedSkills = expectedSkills.map((item: any) => ({
                    ...item,
                    version: normalizeOptionalSkillVersion(item.version)
                }));
            }
        }

        if (datasetType === 'routing') {
            if (!query) {
                return NextResponse.json({ error: '路由评测数据需要填写问题 (Query)' }, { status: 400 });
            }
            const hasExpectedSkills = Array.isArray(expectedSkills) && expectedSkills.some(item => item?.skill?.trim());
            const hasLegacySkill = !!skill?.trim();
            if (!hasExpectedSkills && !hasLegacySkill) {
                return NextResponse.json({ error: '路由评测数据需要至少配置一个预期技能' }, { status: 400 });
            }
        } else {
            if (!skill?.trim()) {
                return NextResponse.json({ error: '效果评测数据需要绑定目标 skill' }, { status: 400 });
            }
            if (!standardAnswer && !documentContent) {
                return NextResponse.json({ error: '请提供标准答案或上传案例文档' }, { status: 400 });
            }
        }

        const existingConfigs = await db.findConfigs({
            OR: [
                { user: user || null }
            ]
        });
        const existing = existingConfigs.find((c: any) => {
            if (normalizeConfigDatasetType(c.datasetType) !== datasetType) {
                return false;
            }

            if (datasetType === 'routing') {
                return normalizeConfigQuery(c.query) === query;
            }

            return normalizeConfigSkillName(c.skill) === skill
                && (c.skillVersion ?? null) === (skillVersion ?? null)
                && normalizeConfigQuery(c.query) === query;
        });
        if (existing) {
            return NextResponse.json({
                error: datasetType === 'routing'
                    ? '该问题已存在于当前数据集类型中'
                    : query
                        ? '该目标 skill 的当前业务场景已存在于效果数据集中'
                        : '该目标 skill 的通用效果数据已存在于当前效果数据集中'
            }, { status: 409 });
        }

        const parseStatus = 'parsing';
        const newConfig = await db.createConfig({
            query,
            skill: skill || '',
            skillVersion: skillVersion ?? null,
            datasetType,
            routingIntent: null,
            routingAnchors: null,
            expectedSkills: expectedSkills ? JSON.stringify(expectedSkills) : null,
            standardAnswer: standardAnswer || '',
            rootCauses: null,
            keyActions: null,
            user: user || null,
            parseStatus
        });

        const formattedConfig = {
            id: newConfig.id,
            query: newConfig.query ?? null,
            dataset_type: datasetType,
            skill: newConfig.skill,
            skillVersion: newConfig.skillVersion ?? null,
            routing_intent: null,
            routing_anchors: [],
            expectedSkills: expectedSkills,
            standard_answer: standardAnswer || (documentContent && configSupportsDatasetType(datasetType, 'outcome') ? '正在从文档中提取...' : ''),
            root_causes: [],
            key_actions: [],
            extractedKeyActions: null,
            parse_status: 'parsing'
        };

        void processConfigAsync(
            newConfig.id,
            query,
            standardAnswer,
            documentContent,
            datasetType,
            skill,
            skillVersion,
            expectedSkills,
            user
        );

        return NextResponse.json(formattedConfig);

    } catch (error: any) {
        console.error('Config Create Error:', error);
        return NextResponse.json({ error: error.message || 'Internal Server Error' }, { status: 500 });
    }
}
