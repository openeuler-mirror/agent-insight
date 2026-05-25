type InteractionLike = Record<string, any>;

export interface ObservedAgentRegistration {
    name: string;
    agentType: 'main' | 'subagent';
}

function cleanAgentName(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function extractObservedAgentRegistrations(
    interactions: InteractionLike[] | null | undefined,
    primaryAgentName?: string | null,
): ObservedAgentRegistration[] {
    const out: ObservedAgentRegistration[] = [];
    const seen = new Set<string>();
    const primary = cleanAgentName(primaryAgentName);

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
            add(subagentName, 'subagent');
            continue;
        }

        if ((role === 'subagent' || role === 'opencode') && agent && agent !== primary) {
            add(agent, 'subagent');
        } else if (!primary && agent) {
            add(agent, 'main');
        }
    }

    return out;
}

export function extractObservedAgentNames(interactions: InteractionLike[] | null | undefined): string[] {
    return extractObservedAgentRegistrations(interactions).map(agent => agent.name);
}
