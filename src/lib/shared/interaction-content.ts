function stringifyContentBlock(block: any): string {
    if (block == null) return '';
    if (typeof block === 'string') return block;
    if (typeof block === 'number' || typeof block === 'boolean') return String(block);

    if (Array.isArray(block)) {
        return block.map(stringifyContentBlock).filter(Boolean).join('');
    }

    if (typeof block === 'object') {
        if (typeof block.text === 'string') return block.text;
        if (typeof block.content === 'string') return block.content;
        if (Array.isArray(block.content)) return stringifyContentBlock(block.content);
        return '';
    }

    return '';
}

export function stringifyClaudeContent(content: any): string {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (typeof content === 'number' || typeof content === 'boolean') return String(content);
    if (Array.isArray(content)) {
        return content.map(stringifyContentBlock).filter(Boolean).join('');
    }
    if (typeof content === 'object') {
        if (typeof content.text === 'string') return content.text;
        if (typeof content.content === 'string') return content.content;
        if (Array.isArray(content.content)) return stringifyClaudeContent(content.content);
    }
    return '';
}

function normalizeContentHolder<T extends Record<string, any>>(holder: T): T {
    if (!holder || !Object.prototype.hasOwnProperty.call(holder, 'content')) return holder;
    if (typeof holder.content === 'string') return holder;

    const normalized = { ...holder } as any;
    if (normalized.content_blocks === undefined && normalized.content != null) {
        normalized.content_blocks = normalized.content;
    }
    normalized.content = stringifyClaudeContent(normalized.content);
    return normalized;
}

function normalizeInteraction(interaction: any): any {
    if (!interaction || typeof interaction !== 'object') return interaction;

    let normalized = normalizeContentHolder({ ...interaction });

    if (normalized.message && typeof normalized.message === 'object') {
        normalized.message = normalizeContentHolder({ ...normalized.message });
    }
    if (normalized.responseMessage && typeof normalized.responseMessage === 'object') {
        normalized.responseMessage = normalizeContentHolder({ ...normalized.responseMessage });
    }
    if (Array.isArray(normalized.requestMessages)) {
        normalized.requestMessages = normalized.requestMessages.map((message: any) =>
            message && typeof message === 'object' ? normalizeContentHolder({ ...message }) : message
        );
    }

    return normalized;
}

export function normalizeClaudeCodeInteractionsForStorage(interactions: any): any[] {
    if (!Array.isArray(interactions)) return [];
    return interactions.map(normalizeInteraction);
}
