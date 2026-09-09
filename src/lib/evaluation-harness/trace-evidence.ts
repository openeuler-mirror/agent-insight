interface ToolMessage {
  role?: string;
  type?: string;
  tool_calls?: Array<{ id?: string; output?: unknown; result?: unknown }>;
  tool_call_id?: string;
  content?: unknown;
}

export interface LoadedSkillDefinition {
  name: string;
  externalVersion: string;
  definitionHash: string;
}

export function linkedToolResultIndices<T extends ToolMessage>(interactions: T[], index: number): number[] {
  const pending = new Set((interactions[index]?.tool_calls || []).map(call => call.id).filter((id): id is string => Boolean(id)));
  const result: number[] = [];
  for (let next = index + 1; next < interactions.length && pending.size; next++) {
    const message = interactions[next];
    for (const call of message.tool_calls || []) if (call.id) pending.delete(call.id);
    if ((message.role || message.type) !== 'tool' || !message.tool_call_id || !pending.has(message.tool_call_id)) continue;
    result.push(next);
    pending.delete(message.tool_call_id);
  }
  return result;
}

export function attachToolResults<T extends ToolMessage>(interactions: T[]): T[] {
  const result = interactions.slice();
  const pending = new Map<string, { index: number; callIndex: number }>();
  interactions.forEach((message, index) => {
    (message.tool_calls || []).forEach((call, callIndex) => {
      if (call.id) pending.set(call.id, { index, callIndex });
    });
    if ((message.role || message.type) !== 'tool' || !message.tool_call_id) return;
    const source = pending.get(message.tool_call_id);
    if (!source) return;
    pending.delete(message.tool_call_id);
    const interaction = result[source.index];
    const call = interaction.tool_calls![source.callIndex];
    if (call.output !== undefined || call.result !== undefined || message.content === undefined) return;
    result[source.index] = {
      ...interaction,
      tool_calls: interaction.tool_calls!.map((value, callIndex) => callIndex === source.callIndex ? { ...value, output: message.content } : value),
    };
  });
  return result;
}

export function loadedSkillDefinitions(interactions: readonly object[]): LoadedSkillDefinition[] {
  const definitions = new Map<string, LoadedSkillDefinition>();
  for (const interaction of interactions) {
    const loaded = (interaction as { metadata?: { evaluation?: { loadedSkills?: unknown } } }).metadata?.evaluation?.loadedSkills;
    if (!Array.isArray(loaded)) continue;
    for (const value of loaded) {
      if (!value || typeof value.skillId !== 'string' || !value.skillId.trim()
        || typeof value.skillVersion !== 'string' || !value.skillVersion.trim()
        || typeof value.definitionHash !== 'string' || !value.definitionHash.trim()) continue;
      const definition = { name: value.skillId.trim(), externalVersion: value.skillVersion, definitionHash: value.definitionHash };
      definitions.set(JSON.stringify([definition.name, definition.externalVersion, definition.definitionHash]), definition);
    }
  }
  return [...definitions.values()];
}
