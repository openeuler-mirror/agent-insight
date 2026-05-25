import type { ChatModelAdapter, ThreadAssistantMessagePart, ThreadMessage } from '@assistant-ui/react';

interface FileData {
    content: string[];
    created_at: string;
    modified_at: string;
}

type FilesState = Record<string, FileData>;

interface AdapterRuntimeContext {
    user: string | null;
    threadId: string | null;
    files: FilesState;
    modelId: string;
    scenario: string;
    locale: string;
}

interface PlaygroundAgentAdapterOptions {
    getContext: () => AdapterRuntimeContext;
    onFiles?: (files: FilesState) => void;
    onFilePathsDetected?: (paths: string[]) => void;
}

type StreamCallKind = 'tool' | 'model' | 'node';

interface StreamCallEvent {
    id: string;
    kind: StreamCallKind;
    name: string;
    status: string;
    input?: string;
    output?: string;
}

const STREAM_LOG_PATTERNS = [
    /No files found in\s+\/[^\s)]+/gi,
    /No files found matching pattern\s+['"`][^'"`]+['"`]/gi,
    /Successfully wrote to\s+\/[^\s)]+/gi,
    /Found\s+\d+\s+files?/gi,
    /The workspace root is completely empty/gi,
];

const STREAM_PATH_ENTRY_PATTERN = /(?:^|\s)\/[^\s)]+(?:\/)?\s*\((?:directory|\d+\s*bytes)\)/gi;

const sanitizeAssistantStreamText = (text: string): string => {
    if (!text) return '';
    let sanitized = text;
    for (const pattern of STREAM_LOG_PATTERNS) {
        sanitized = sanitized.replace(pattern, ' ');
    }
    sanitized = sanitized.replace(STREAM_PATH_ENTRY_PATTERN, ' ');
    return sanitized
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
};

const toPlainText = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';

    return content
        .map((part: unknown) => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            const record = part as Record<string, unknown>;
            if (record.type === 'text' && typeof record.text === 'string') return record.text;
            if (typeof record.text === 'string') return record.text;
            return '';
        })
        .join('');
};

const toRequestMessages = (messages?: readonly ThreadMessage[]) =>
    (Array.isArray(messages) ? messages : [])
        .map((message) => ({
            role: message.role,
            content: toPlainText((message as { content?: unknown }).content),
        }))
        .filter((message) => message.content.trim().length > 0);

const parseSseEventData = (event: string): Record<string, unknown> | null => {
    const dataLines = event
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());

    if (dataLines.length === 0) return null;
    const raw = dataLines.join('\n').trim();
    if (!raw || raw === '[DONE]') return null;

    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
};

const extractTokenText = (token: unknown): string => {
    if (typeof token === 'string') return token;
    if (Array.isArray(token)) {
        return token.map((part: unknown) => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            const record = part as Record<string, unknown>;
            if (typeof record.text === 'string' || typeof record.text === 'number' || typeof record.text === 'boolean') {
                return String(record.text);
            }
            if ('content' in record) return extractTokenText(record.content);
            return '';
        }).join('');
    }
    if (token && typeof token === 'object' && 'text' in token) {
        const value = (token as { text?: unknown }).text;
        return value == null ? '' : String(value);
    }
    return '';
};

const extractStreamText = (payload: unknown): string => {
    if (!payload) return '';
    if (Array.isArray(payload)) {
        const first: unknown = payload[0];
        if (typeof first === 'string') return first;
        if (first && typeof first === 'object') {
            const record = first as Record<string, unknown>;
            if ('content' in record) return extractTokenText(record.content);
            const kwargs = record.kwargs;
            if (kwargs && typeof kwargs === 'object' && 'content' in kwargs) {
                return extractTokenText((kwargs as Record<string, unknown>).content);
            }
        }
        return '';
    }
    if (typeof payload === 'string') return payload;
    if (payload && typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        if ('content' in record) return extractTokenText(record.content);
        const kwargs = record.kwargs;
        if (kwargs && typeof kwargs === 'object' && 'content' in kwargs) {
            return extractTokenText((kwargs as Record<string, unknown>).content);
        }
    }
    return '';
};

const toSingleLineText = (value: unknown): string => {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
};

const normalizeStatusText = (value: unknown): string => {
    const raw = toSingleLineText(value).toLowerCase();
    if (!raw) return 'running';
    return raw.replace(/\s+/g, '_');
};

const isTerminalStatus = (status: string): boolean => {
    return /(complete|completed|done|success|failed|error|cancelled|canceled|timeout)/i.test(status);
};

const inferStreamCallKind = (nodeName: string, update: Record<string, unknown>, displayName: string): StreamCallKind => {
    const explicitType = (
        toSingleLineText(update.kind)
        || toSingleLineText(update.type)
        || toSingleLineText(update.category)
    ).toLowerCase();
    if (explicitType.includes('tool')) return 'tool';
    if (explicitType.includes('model') || explicitType.includes('llm')) return 'model';

    const hasToolHint = Boolean(
        toSingleLineText(update.toolName)
        || toSingleLineText(update.tool)
        || toSingleLineText(update.tool_call_id)
    );
    if (hasToolHint) return 'tool';

    const hasModelHint = Boolean(
        toSingleLineText(update.model)
        || toSingleLineText(update.modelName)
        || toSingleLineText(update.llm)
        || toSingleLineText(update.provider)
        || update.usage
    );
    if (hasModelHint) return 'model';

    const lowered = `${nodeName} ${displayName}`.toLowerCase();
    if (/(model|llm|chat|completion|inference)/.test(lowered)) return 'model';
    return 'node';
};

const extractUpdateBlocks = (payload: unknown): StreamCallEvent[] => {
    if (!payload || typeof payload !== 'object') return [];
    const blocks: StreamCallEvent[] = [];
    const updates = payload as Record<string, unknown>;

    for (const [nodeName, updateRaw] of Object.entries(updates)) {
        if (!updateRaw || typeof updateRaw !== 'object') continue;
        const update = updateRaw as Record<string, unknown>;
        const displayName = toSingleLineText(update.toolName)
            || toSingleLineText(update.tool)
            || toSingleLineText(update.name)
            || toSingleLineText(update.modelName)
            || toSingleLineText(update.model)
            || nodeName;
        const status = normalizeStatusText(update.status ?? update.state ?? update.phase ?? 'running');
        const stableId = toSingleLineText(update.id)
            || toSingleLineText(update.toolCallId)
            || toSingleLineText(update.tool_call_id)
            || toSingleLineText(update.runId)
            || toSingleLineText(update.run_id)
            || nodeName;
        const input = toSingleLineText(update.query)
            || toSingleLineText(update.prompt)
            || toSingleLineText(update.task)
            || toSingleLineText(update.input)
            || undefined;
        const output = toSingleLineText(update.output)
            || toSingleLineText(update.result)
            || toSingleLineText(update.response)
            || undefined;
        const kind = inferStreamCallKind(nodeName, update, displayName);

        blocks.push({
            id: stableId,
            kind,
            name: displayName,
            status,
            input: input && input.length > 500 ? `${input.slice(0, 500)}...` : input,
            output: output && output.length > 500 ? `${output.slice(0, 500)}...` : output,
        });
    }

    return blocks;
};

const toToolInputText = (value: unknown): string | undefined => {
    if (value == null) return undefined;
    if (typeof value === 'string') return value.trim() || undefined;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        const serialized = JSON.stringify(value);
        return serialized && serialized !== 'null' ? serialized : undefined;
    } catch {
        return undefined;
    }
};

const extractToolCallsFromMessagePayload = (payload: unknown): StreamCallEvent[] => {
    if (!Array.isArray(payload)) return [];

    const blocks: StreamCallEvent[] = [];

    for (const item of payload) {
        if (!item || typeof item !== 'object') continue;
        const message = item as Record<string, unknown>;
        const kwargs = (message.kwargs && typeof message.kwargs === 'object')
            ? message.kwargs as Record<string, unknown>
            : undefined;
        if (!kwargs) continue;

        const toolCalls = Array.isArray(kwargs.tool_calls) ? kwargs.tool_calls : [];
        for (const [index, rawCall] of toolCalls.entries()) {
            if (!rawCall || typeof rawCall !== 'object') continue;
            const call = rawCall as Record<string, unknown>;
            const name = toSingleLineText(call.name);
            if (!name) continue;
            const id = toSingleLineText(call.id) || `${name}-${index}`;
            const input = toToolInputText(call.args);
            blocks.push({
                id,
                kind: 'tool',
                name,
                status: normalizeStatusText(call.status ?? 'running'),
                ...(input ? { input } : {}),
            });
        }

        const messageId = Array.isArray(message.id) ? message.id : [];
        const isToolMessage = messageId.some((part) => String(part).toLowerCase().includes('toolmessage'));
        const toolCallId = toSingleLineText(kwargs.tool_call_id);
        if (isToolMessage || toolCallId) {
            const name = toSingleLineText(kwargs.name) || 'tool';
            const id = toolCallId || name;
            const output = extractTokenText(kwargs.content ?? message.content);
            blocks.push({
                id,
                kind: 'tool',
                name,
                status: normalizeStatusText(kwargs.status ?? 'completed'),
                ...(output ? { output } : {}),
            });
        }
    }

    return blocks;
};

const toTitleCase = (value: string): string => {
    return value
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (char) => char.toUpperCase());
};

const buildAssistantParts = (
    accumulatedText: string,
    callEvents: ReadonlyMap<string, StreamCallEvent>,
    files?: FilesState
): ThreadAssistantMessagePart[] => {
    const parts: ThreadAssistantMessagePart[] = [];
    const displayText = sanitizeAssistantStreamText(accumulatedText);
    if (displayText.length > 0 || files) {
        const textPart: any = {
            type: 'text',
            text: displayText,
        };
        if (files) {
            textPart.files = Object.entries(files).map(([path, data]) => ({ path, content: data.content, size: data.content?.length || 0 }));
        }
        parts.push(textPart);
    }

    for (const event of callEvents.values()) {
        const formattedStatus = toTitleCase(event.status);
        const toolName = event.kind === 'tool'
            ? event.name
            : `${event.kind}: ${event.name}`;
        const args = {
            kind: event.kind,
            status: event.status,
            input: event.input ?? '',
        };
        const argsText = [
            `kind: ${event.kind}`,
            `status: ${formattedStatus}`,
            ...(event.input ? [`input: ${event.input}`] : []),
        ].join('\n');

        parts.push({
            type: 'tool-call',
            toolCallId: event.id,
            toolName,
            args,
            argsText,
            ...(event.output ? { result: event.output } : {}),
            ...(isTerminalStatus(event.status) && !event.output ? { result: `Status: ${formattedStatus}` } : {}),
            ...(event.status.includes('error') || event.status.includes('failed') ? { isError: true } : {}),
        });
    }

    return parts;
};

export const createPlaygroundAgentAdapter = ({
    getContext,
    onFiles,
    onFilePathsDetected,
}: PlaygroundAgentAdapterOptions): ChatModelAdapter => ({
    async *run(input) {
        const messages = Array.isArray(input?.messages) ? input.messages : [];
        const abortSignal = input?.abortSignal;
        const context = getContext();
        if (!context.user) {
            throw new Error(context.locale === 'zh' ? '用户未登录，无法发送请求。' : 'User is not authenticated.');
        }

        const requestMessages = toRequestMessages(messages);
        const latestUserMessage = [...requestMessages].reverse().find((item) => item.role === 'user');
        if (!latestUserMessage?.content) {
            throw new Error(context.locale === 'zh' ? '未找到用户输入。' : 'No user prompt was found.');
        }

        try {
            const response = await fetch('/api/skill-generator/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: latestUserMessage.content,
                    user: context.user,
                    threadId: context.threadId,
                    files: context.files,
                    modelId: context.modelId,
                    scenario: context.scenario,
                }),
            });

            if (!response.ok || !response.body) {
                throw new Error(
                    `${context.locale === 'zh' ? 'Agent 请求失败' : 'Agent request failed'}: ${response.status}`
                );
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let accumulatedText = '';
            let generatedFileCount = 0;
            let finalFiles: FilesState | undefined;
            const callEvents = new Map<string, StreamCallEvent>();
            let hasMessageChunk = false;

            const upsertCallEvents = (target: Map<string, StreamCallEvent>, blocks: StreamCallEvent[]) => {
                for (const block of blocks) {
                    const prev = target.get(block.id);
                    target.set(block.id, {
                        ...prev,
                        ...block,
                        input: block.input ?? prev?.input,
                        output: block.output ?? prev?.output,
                    });
                }
            };

            while (true) {
                if (abortSignal?.aborted) {
                    await reader.cancel();
                    return;
                }
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const events = buffer.split('\n\n');
                buffer = events.pop() || '';

                for (const event of events) {
                    const data = parseSseEventData(event);
                    if (!data) continue;

                    if (data.mode === 'messages') {
                        const messageToolBlocks = extractToolCallsFromMessagePayload(data.payload);
                        if (messageToolBlocks.length > 0) {
                            upsertCallEvents(callEvents, messageToolBlocks);
                            yield { content: buildAssistantParts(accumulatedText, callEvents, finalFiles) };
                        }

                        const delta = extractStreamText(data.payload);
                        if (!delta) continue;
                        hasMessageChunk = true;
                        accumulatedText += delta;
                        yield { content: buildAssistantParts(accumulatedText, callEvents, finalFiles) };
                        continue;
                    }

                if (data.mode === 'updates') {
                    const blocks = extractUpdateBlocks(data.payload);
                    if (blocks.length === 0) continue;
                    upsertCallEvents(callEvents, blocks);
                    yield { content: buildAssistantParts(accumulatedText, callEvents, finalFiles) };
                    continue;
                }

                if (data.mode === 'values') {
                    const payload = data.payload;
                    if (payload && typeof payload === 'object' && 'files' in payload && typeof payload.files === 'object' && payload.files) {
                        finalFiles = payload.files as FilesState;
                        const filePaths = Object.keys(finalFiles);
                        generatedFileCount = filePaths.length;
                        onFiles?.(finalFiles);
                        onFilePathsDetected?.(filePaths);
                    }

                    const valuesMessages = payload && typeof payload === 'object'
                        ? (payload as Record<string, unknown>).messages
                        : undefined;
                    const valueToolBlocks = extractToolCallsFromMessagePayload(valuesMessages);
                    if (valueToolBlocks.length > 0) {
                        upsertCallEvents(callEvents, valueToolBlocks);
                        yield { content: buildAssistantParts(accumulatedText, callEvents, finalFiles) };
                    }

                    // values.messages is only a fallback for providers that do not emit messages chunks.
                    // Once messages chunks are flowing, avoid using values.messages to prevent history replay
                    // from overriding current turn text.
                    if (!hasMessageChunk) {
                        if (Array.isArray(valuesMessages)) {
                            const assistantMessages = (valuesMessages as unknown[]).filter((message): message is Record<string, unknown> => {
                                if (!message || typeof message !== 'object') return false;
                                const messageRecord = message as Record<string, unknown>;
                                const kwargs = (messageRecord.kwargs && typeof messageRecord.kwargs === 'object')
                                    ? messageRecord.kwargs as Record<string, unknown>
                                    : undefined;
                                const messageId = Array.isArray(messageRecord.id) ? messageRecord.id : undefined;
                                const type = [
                                    typeof messageId?.[2] === 'string' ? messageId[2] : '',
                                    typeof messageRecord.type === 'string' ? messageRecord.type : '',
                                    typeof messageRecord.role === 'string' ? messageRecord.role : '',
                                    typeof kwargs?.type === 'string' ? kwargs.type : '',
                                    typeof kwargs?.role === 'string' ? kwargs.role : '',
                                ].find((value) => typeof value === 'string') || '';
                                const lowered = String(type).toLowerCase();
                                return lowered.includes('ai') || lowered.includes('assistant') || lowered.includes('agent');
                            });
                            const latestAssistant = assistantMessages.at(-1);
                            if (latestAssistant) {
                                const kwargs = (latestAssistant.kwargs && typeof latestAssistant.kwargs === 'object')
                                    ? latestAssistant.kwargs as Record<string, unknown>
                                    : undefined;
                                const text = extractTokenText(kwargs?.content ?? latestAssistant.content);
                                if (text && text.length >= accumulatedText.length) {
                                    accumulatedText = text;
                                    yield { content: buildAssistantParts(accumulatedText, callEvents, finalFiles) };
                                }
                            }
                        }
                    }
                    continue;
                }

                if (data.mode === 'error') {
                    const errorMessage = typeof data.payload === 'string' ? data.payload : 'Unknown stream error';
                    throw new Error(errorMessage);
                }

                if (data.mode === 'done' && accumulatedText.trim().length === 0) {
                    const hasStreamEvents = callEvents.size > 0;
                    if (hasStreamEvents) {
                        yield { content: buildAssistantParts(accumulatedText, callEvents, finalFiles) };
                        continue;
                    }
                    if (generatedFileCount > 0) {
                        yield {
                            content: [{
                                type: 'text',
                                text: context.locale === 'zh'
                                    ? `已生成 ${generatedFileCount} 个文件，可在右侧编辑器中查看。`
                                    : `Generated ${generatedFileCount} files. You can view them in the editor panel.`,
                                files: finalFiles ? Object.entries(finalFiles).map(([path, fileData]) => ({ path, content: fileData.content, size: fileData.content?.length || 0 })) : []
                            } as any],
                        };
                    } else {
                        yield {
                            content: [{
                                type: 'text',
                                text: context.locale === 'zh' ? '已完成处理。' : 'Completed.',
                            }],
                        };
                    }
                } else if (data.mode === 'done') {
                    yield { content: buildAssistantParts(accumulatedText, callEvents, finalFiles) };
                }
                }
            }
        } catch (error) {
            const isAbortError =
                abortSignal?.aborted ||
                (error instanceof DOMException && error.name === 'AbortError') ||
                (error instanceof Error && /abort/i.test(error.name));
            if (isAbortError) {
                // User-initiated cancel should stop quietly without surfacing runtime errors.
                return;
            }
            throw error;
        }
    },
});
