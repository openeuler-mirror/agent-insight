import { isEvaluatorAgentName } from '@/lib/evaluator-agent';

type InteractionLike = Record<string, any>;

export interface ObservedAgentRegistration {
    name: string;
    agentType: 'main' | 'subagent';
}

export interface ObservedAgentRegistrationOptions {
    includeSubagents?: boolean;
}

const FRAMEWORK_PRIMARY_AGENT_NAMES: Record<string, string> = {
    codex: 'codex',
    'pi-agent': 'pi-agent',
};

function cleanAgentName(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function getFrameworkPrimaryAgentName(framework: unknown): string | undefined {
    const key = typeof framework === 'string' ? framework.trim().toLowerCase() : '';
    return FRAMEWORK_PRIMARY_AGENT_NAMES[key];
}

export function getAgentDisplayName(name: unknown): string {
    const value = cleanAgentName(name);
    if (value === 'codex') return 'Codex';
    if (value === 'pi-agent') return 'Pi';
    return value;
}

/**
 * Display a stable platform Agent together with its delegated role. The role is
 * intentionally kept out of the primary Agent name because it powers filtering
 * and registration, but it remains essential context in a task tree.
 */
export function getAgentNodeDisplayLabel(agent: unknown, subagentName?: unknown): string {
    const displayAgent = getAgentDisplayName(agent);
    const role = cleanAgentName(subagentName);
    return role ? `${displayAgent} · ${role}` : displayAgent;
}

export function extractObservedAgentRegistrations(
    interactions: InteractionLike[] | null | undefined,
    primaryAgentName?: string | null,
    options?: ObservedAgentRegistrationOptions,
): ObservedAgentRegistration[] {
    const out: ObservedAgentRegistration[] = [];
    const seen = new Set<string>();
    const primary = cleanAgentName(primaryAgentName);
    const includeSubagents = options?.includeSubagents ?? true;

    const add = (name: string, agentType: ObservedAgentRegistration['agentType']) => {
        const cleaned = cleanAgentName(name);
        if (!cleaned) return;
        const key = `${agentType}:${cleaned}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ name: cleaned, agentType });
    };

    if (primary) add(primary, 'main');

    for (const m of interactions || []) {
        if (!m || typeof m !== 'object') continue;
        const role = cleanAgentName(m.role).toLowerCase();
        const subagentName = cleanAgentName(m.subagent_name);
        const agent = cleanAgentName(m.agent);

        if (subagentName) {
            if (includeSubagents) add(subagentName, 'subagent');
            continue;
        }

        if ((role === 'subagent' || role === 'opencode') && agent && agent !== primary) {
            if (includeSubagents) add(agent, 'subagent');
        } else if (!primary && agent) {
            add(agent, 'main');
        }
    }

    return out;
}

export function extractObservedAgentNames(
    interactions: InteractionLike[] | null | undefined,
    primaryAgentName?: string | null,
    options?: ObservedAgentRegistrationOptions,
): string[] {
    return extractObservedAgentRegistrations(interactions, primaryAgentName, options).map(agent => agent.name);
}

export function getPrimaryObservedAgentName(
    interactions: InteractionLike[] | null | undefined,
    primaryAgentName?: string | null,
): string {
    const registrations = extractObservedAgentRegistrations(interactions, primaryAgentName);
    const primary = registrations.find(agent =>
        agent.agentType === 'main' && !isEvaluatorAgentName(agent.name),
    );
    if (primary) return primary.name;
    return registrations.find(agent => !isEvaluatorAgentName(agent.name))?.name || '';
}
