import { OpenAI } from 'openai';
import { getProxyConfig } from '@/lib/ingest/proxy-config';
import { getActiveConfig } from '@/lib/storage/server-config';

export interface RoutingSemanticSignature {
    intent: string;
    anchors: string[];
}

const signatureCache = new Map<string, Promise<RoutingSemanticSignature | null>>();

function normalizeRoutingText(input: string): string {
    return input
        .trim()
        .toLowerCase()
        .replace(/[`"'“”‘’]/g, '')
        .replace(/[.,，。!?！？;；:：、·…()[\]{}<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function dedupeAnchors(anchors: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];

    for (const anchor of anchors) {
        const normalized = normalizeRoutingText(anchor);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(anchor.trim());
    }

    return result;
}

function parseSignature(raw: string): RoutingSemanticSignature {
    let jsonStr = raw.trim();
    const fenced = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) {
        jsonStr = fenced[1];
    } else {
        const first = jsonStr.indexOf('{');
        const last = jsonStr.lastIndexOf('}');
        if (first !== -1 && last !== -1 && last >= first) {
            jsonStr = jsonStr.slice(first, last + 1);
        }
    }

    const parsed = JSON.parse(jsonStr);
    const intent = typeof parsed.intent === 'string' ? parsed.intent.trim() : '';
    const anchors = Array.isArray(parsed.anchors)
        ? parsed.anchors.filter((item: unknown) => typeof item === 'string').map((item: string) => item.trim())
        : [];

    return {
        intent,
        anchors: dedupeAnchors(anchors).slice(0, 8),
    };
}

export function normalizeRoutingAnchor(input: string): string {
    return normalizeRoutingText(input).replace(/\s/g, '');
}

export async function deriveRoutingSignature(query: string, user?: string | null): Promise<RoutingSemanticSignature | null> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return null;

    const cacheKey = `${user || '__global__'}::${normalizedQuery}`;
    if (signatureCache.has(cacheKey)) {
        return signatureCache.get(cacheKey)!;
    }

    const work = (async () => {
        const settings = await getActiveConfig(user);
        if (!settings) {
            throw new Error('No active model configuration for routing signature extraction');
        }

        const { customFetch } = getProxyConfig();
        const client = new OpenAI({
            apiKey: settings.apiKey || 'no-api-key-required',
            baseURL: settings.baseUrl || 'https://api.deepseek.com',
            fetch: customFetch,
        });

        const prompt = `
You are extracting a routing signature for skill benchmark matching.

Given one user query, produce a compact semantic signature that captures the query's routing intent rather than the full scenario wording.

User Query:
"""
${normalizedQuery}
"""

Return ONLY JSON in this format:
{
  "intent": "one concise canonical intent sentence in the same language as the query",
  "anchors": [
    "short technical phrase 1",
    "short technical phrase 2"
  ]
}

Rules:
- The intent must summarize the core task the agent is being asked to do.
- Anchors must be short reusable semantic phrases, not full sentences.
- Keep 4-8 anchors.
- Preserve domain terms, repo terms, tool names, protocol names, object names, and constraints that affect routing.
- Remove storytelling details, hostnames, dates, and incidental wording unless they are essential to routing.
- The output language must match the query language.
`.trim();

        const response = await client.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model: settings.model || 'deepseek-chat',
            temperature: 0.1,
        });

        const content = response.choices[0]?.message?.content;
        if (!content) {
            throw new Error('No content returned for routing signature extraction');
        }

        const signature = parseSignature(content);
        if (!signature.intent || signature.anchors.length === 0) {
            throw new Error('Routing signature extraction returned empty intent or anchors');
        }

        return signature;
    })().finally(() => {
        signatureCache.delete(cacheKey);
    });

    signatureCache.set(cacheKey, work);
    return work;
}

export interface RoutingSemanticMatch {
    intentMatched: boolean;
    matchedAnchors: string[];
    anchorCoverage: number;
}

export function matchQueryToStoredRoutingSignature(
    query: string,
    configSignature: RoutingSemanticSignature
): RoutingSemanticMatch {
    const normalizedQuery = normalizeRoutingAnchor(query);
    const configIntent = normalizeRoutingAnchor(configSignature.intent);

    const matchedAnchors = configSignature.anchors.filter(anchor => {
        const normalizedAnchor = normalizeRoutingAnchor(anchor);
        if (!normalizedAnchor) return false;
        return normalizedQuery.includes(normalizedAnchor);
    });

    const intentMatched = Boolean(
        normalizedQuery
        && configIntent
        && (
            normalizedQuery === configIntent
            || normalizedQuery.includes(configIntent)
            || configIntent.includes(normalizedQuery)
        )
    );

    return {
        intentMatched,
        matchedAnchors,
        anchorCoverage: configSignature.anchors.length > 0
            ? matchedAnchors.length / configSignature.anchors.length
            : 0,
    };
}

export function matchRoutingSignature(
    query: string,
    runtimeSignature: RoutingSemanticSignature,
    configSignature: RoutingSemanticSignature
): RoutingSemanticMatch {
    const normalizedQuery = normalizeRoutingAnchor(query);
    const runtimeIntent = normalizeRoutingAnchor(runtimeSignature.intent);
    const configIntent = normalizeRoutingAnchor(configSignature.intent);
    const runtimeAnchors = runtimeSignature.anchors.map(normalizeRoutingAnchor).filter(Boolean);

    const matchedAnchors = configSignature.anchors.filter(anchor => {
        const normalizedAnchor = normalizeRoutingAnchor(anchor);
        if (!normalizedAnchor) return false;

        if (normalizedQuery.includes(normalizedAnchor)) {
            return true;
        }

        return runtimeAnchors.some(runtimeAnchor =>
            runtimeAnchor === normalizedAnchor
            || runtimeAnchor.includes(normalizedAnchor)
            || normalizedAnchor.includes(runtimeAnchor)
        );
    });

    const intentMatched = Boolean(
        runtimeIntent
        && configIntent
        && (
            runtimeIntent === configIntent
            || runtimeIntent.includes(configIntent)
            || configIntent.includes(runtimeIntent)
        )
    );

    return {
        intentMatched,
        matchedAnchors,
        anchorCoverage: configSignature.anchors.length > 0
            ? matchedAnchors.length / configSignature.anchors.length
            : 0,
    };
}
