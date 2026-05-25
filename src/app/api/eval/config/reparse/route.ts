import { db } from '@/lib/storage/prisma';
import { getProxyConfig } from '@/lib/ingest/proxy-config';
import { getActiveConfig } from '@/lib/storage/server-config';
import {
    generateAnswerExtractionPrompt,
    generateRootCauseExtractionPrompt,
} from '@/prompts/config-extraction-prompt';
import { configSupportsDatasetType, normalizeConfigDatasetType, type ConfigDatasetType } from '@/lib/engine/evaluation/config-dataset';
import { getConfigSubjectLabel, normalizeConfigQuery, normalizeConfigSkillName, normalizeOptionalSkillVersion } from '@/lib/engine/evaluation/config-target';
import { deriveRoutingSignature } from '@/lib/ingest/routing-signature';
import { extractKeyActionsFromFlow, mergeKeyActionsFromMultipleSkills, type ExtractedKeyAction, type ParsedFlowResult } from '@/lib/engine/observability/flow-parser';
import { NextResponse } from 'next/server';
import { OpenAI } from "openai";

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

function parseStoredKeyActions(raw?: string | null) {
    if (!raw) return [];

    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];

        return parsed
            .filter(item => typeof item?.content === 'string' && item.content.trim())
            .map(item => ({
                content: item.content.trim(),
                weight: typeof item?.weight === 'number' ? item.weight : 1,
                ...(typeof item?.controlFlowType === 'string' ? { controlFlowType: item.controlFlowType } : {}),
                ...(typeof item?.condition === 'string' && item.condition.trim() ? { condition: item.condition.trim() } : {}),
                ...(typeof item?.branchLabel === 'string' && item.branchLabel.trim() ? { branchLabel: item.branchLabel.trim() } : {}),
                ...(typeof item?.loopCondition === 'string' && item.loopCondition.trim() ? { loopCondition: item.loopCondition.trim() } : {}),
                ...(typeof item?.expectedMinCount === 'number' ? { expectedMinCount: item.expectedMinCount } : {}),
                ...(typeof item?.expectedMaxCount === 'number' ? { expectedMaxCount: item.expectedMaxCount } : {}),
                ...(typeof item?.groupId === 'string' && item.groupId.trim() ? { groupId: item.groupId.trim() } : {}),
            }));
    } catch {
        return [];
    }
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

function normalizeFlowTargets(
    skill: string | null,
    skillVersion: number | null,
    expectedSkills: { skill: string; version: number | null }[] | null,
) {
    const targets = new Map<string, { skill: string; version: number | null }>();

    const addTarget = (rawSkill: string | null | undefined, rawVersion: number | null | undefined) => {
        const normalizedSkill = normalizeConfigSkillName(rawSkill);
        if (!normalizedSkill) return;

        const version = normalizeOptionalSkillVersion(rawVersion);
        targets.set(`${normalizedSkill}::${version ?? 'any'}`, {
            skill: normalizedSkill,
            version,
        });
    };

    addTarget(skill, skillVersion);
    for (const item of expectedSkills || []) {
        addTarget(item?.skill, item?.version ?? null);
    }

    return Array.from(targets.values());
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
    existingKeyActionsRaw: string | null,
    user?: string | null
) {
    try {
        const settings = await getActiveConfig(user);
        if (!settings) {
            console.error(`[ConfigReparse] No model configuration for user: ${user}`);
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

        if (documentContent && !standardAnswer) {
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
                const matchParse = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
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
                standardAnswer = parsed.standard_answer || '';

                if (!standardAnswer) {
                    throw new Error('Extracted standard answer is empty');
                }

                await db.updateConfig(configId, { standardAnswer });

                console.log(`[ConfigReparse] Successfully extracted standard answer for config ${configId}`);
            } catch (e: any) {
                console.error(`[ConfigReparse] Failed to extract standard answer for config ${configId}:`, e.message);
                await db.updateConfig(configId, { parseStatus: 'failed' }).catch(() => {});
                return;
            }
        }

        const updates: Record<string, unknown> = {};

        if (configSupportsDatasetType(datasetType, 'routing')) {
            const normalizedQuery = normalizeConfigQuery(query);
            if (!normalizedQuery) {
                throw new Error('Routing dataset requires a non-empty query for reparse');
            }

            const routingSignature = await deriveRoutingSignature(normalizedQuery, user);
            if (!routingSignature) {
                throw new Error('Failed to derive routing semantic signature');
            }

            updates.routingIntent = routingSignature.intent;
            updates.routingAnchors = JSON.stringify(routingSignature.anchors);
        }

        let rootCauses: { content: string; weight: number }[] = [];
        let finalKeyActions = parseStoredKeyActions(existingKeyActionsRaw);
        let extractedKeyActionsData: ExtractedKeyAction[] | null = null;

        if (configSupportsDatasetType(datasetType, 'outcome')) {
            if (standardAnswer.trim()) {
                const prompt = generateRootCauseExtractionPrompt(
                    normalizeConfigQuery(query) || normalizeConfigSkillName(skill) || 'Skill benchmark',
                    standardAnswer,
                );

                const response = await openaiClient.chat.completions.create({
                    messages: [{ role: "user", content: prompt }],
                    model: modelName,
                });

                const content = response.choices[0].message.content;
                if (!content) {
                    throw new Error('No content returned from LLM');
                }

                const extractedData = parseJsonPayload<{ root_causes?: { content: string; weight: number }[] }>(content);
                rootCauses = Array.isArray(extractedData.root_causes) ? extractedData.root_causes : [];
            }

            const skillTargets = normalizeFlowTargets(skill, skillVersion, expectedSkills);
            try {
                const allActions: { name: string; actions: ExtractedKeyAction[] }[] = [];

                for (const target of skillTargets) {
                    const skillRecord = await db.findSkill(target.skill, user || null);
                    if (!skillRecord) {
                        console.warn(`[ConfigReparse] Skill "${target.skill}" not found, skipping extraction`);
                        continue;
                    }

                    const resolvedVersion = target.version
                        ?? skillRecord.activeVersion
                        ?? skillRecord.versions?.[0]?.version
                        ?? null;
                    if (resolvedVersion == null) continue;

                    const parsedFlow = await db.findParsedFlow(skillRecord.id, resolvedVersion, user || null);
                    if (parsedFlow?.flowJson) {
                        const flow: ParsedFlowResult = JSON.parse(parsedFlow.flowJson);
                        const actions = extractKeyActionsFromFlow(flow).map(action => ({
                            ...action,
                            skillSource: action.skillSource || target.skill,
                        }));
                        if (actions.length > 0) {
                            allActions.push({ name: target.skill, actions });
                        }
                    } else {
                        console.warn(`[ConfigReparse] No parsed flow for skill "${target.skill}" v${resolvedVersion}, skipping`);
                    }
                }

                if (allActions.length > 0) {
                    const extractedActions = allActions.length === 1
                        ? allActions[0].actions
                        : mergeKeyActionsFromMultipleSkills(allActions);

                    finalKeyActions = buildStoredKeyActions(extractedActions);
                    extractedKeyActionsData = extractedActions;

                    console.log(`[ConfigReparse] Extracted ${extractedActions.length} key actions from Skill targets`);
                }
            } catch (err) {
                console.error('[ConfigReparse] Error extracting key actions from Skill:', err);
            }

            updates.rootCauses = JSON.stringify(rootCauses);
            updates.keyActions = JSON.stringify(finalKeyActions);
            if (extractedKeyActionsData) {
                updates.extractedKeyActions = JSON.stringify(extractedKeyActionsData);
            }
        }

        updates.parseStatus = 'completed';
        await db.updateConfig(configId, updates);

        console.log(`[ConfigReparse] Successfully extracted key points for config ${configId}`);
    } catch (error: any) {
        console.error(`[ConfigReparse] Failed to process config ${configId}:`, error.message);
        await db.updateConfig(configId, { parseStatus: 'failed' }).catch(() => {});
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { id, user } = body;

        if (!id) {
            return NextResponse.json({ error: '缺少配置ID' }, { status: 400 });
        }

        const config = await db.findConfigById(id);
        if (!config) {
            return NextResponse.json({ error: '配置不存在' }, { status: 404 });
        }

        await db.updateConfig(id, { parseStatus: 'parsing' });

        let expectedSkills = null;
        if (config.expectedSkills) {
            try {
                expectedSkills = JSON.parse(config.expectedSkills);
            } catch (e) {
                console.error('Failed to parse expectedSkills:', e);
            }
        }

        const datasetType = normalizeConfigDatasetType(config.datasetType);

        processConfigAsync(
            id, 
            config.query, 
            config.standardAnswer || '',
            null,
            datasetType,
            config.skill || null,
            normalizeOptionalSkillVersion(config.skillVersion),
            expectedSkills,
            config.keyActions || null,
            user
        );

        return NextResponse.json({ 
            success: true, 
            message: '重新解析已启动' 
        });

    } catch (error: any) {
        console.error('Reparse Error:', error);
        return NextResponse.json({ 
            error: error.message || 'Internal Server Error' 
        }, { status: 500 });
    }
}
