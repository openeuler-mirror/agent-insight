"use client";

import {
    ComposerPrimitive,
    MessagePartPrimitive,
    MessagePrimitive,
    ThreadPrimitive,
    type ToolCallMessagePartProps,
    useThread,
    useMessage,
} from '@assistant-ui/react';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { Tool, ToolHeader, ToolInput, ToolTitle, ToolTrigger } from '@/components/ai-elements/tool';
import { Children, isValidElement, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Wrench, Bot, GitCommit, ChevronDown, CheckCircle2, AlertCircle, Loader2, ChevronRight, Folder, FolderOpen, FileCode, FileSpreadsheet, FileText, Download, X, Copy, Sparkles, Globe, Database, Calculator } from 'lucide-react';
import MDEditor from '@uiw/react-md-editor';
import {
    useGeneratedSkillsStore,
    type GeneratedSkill,
    type GeneratedSkillFile,
} from '@/components/skill-generator/generated-skills-store';

interface SkillGeneratorAssistantEmbedProps {
    locale: string;
    controls?: ReactNode;
}

export function SkillGeneratorAssistantEmbed({ locale, controls }: SkillGeneratorAssistantEmbedProps) {
    const sendLabel = locale === 'zh' ? '发送' : 'Send';
    const stopLabel = locale === 'zh' ? '结束执行' : 'Stop';
    const placeholder = locale === 'zh' ? '描述需求...' : 'Describe your request...';
    const AssistantMessageWithLocale = () => <AssistantMessage locale={locale} />;
    const viewportRef = useRef<HTMLDivElement | null>(null);

    return (
        <ThreadPrimitive.Root className="assistant-embedded-root">
            <AutoScrollManager viewportRef={viewportRef} />
            <div className="relative flex-1 flex flex-col min-h-0">
                <ThreadPrimitive.Viewport
                    ref={viewportRef}
                    className="ae-conversation chat-messages"
                    role="log"
                    aria-live="polite"
                    aria-relevant="additions text"
                >
                    <ThreadPrimitive.Messages
                        components={{
                            UserMessage,
                            AssistantMessage: AssistantMessageWithLocale,
                        }}
                    />
                </ThreadPrimitive.Viewport>
                <ThreadPrimitive.ScrollToBottom className="chat-scroll-to-bottom" />
            </div>

            <div className="aui-composer-area chat-input-area">
                <div className="chat-compose-panel">
                    {controls}
                    <ComposerPrimitive.Root className="aui-composer-wrap chat-input-container">
                        <div className="aui-composer-shell">
                            <ComposerPrimitive.Input
                                className="aui-composer-input chat-input ae-prompt-input-textarea"
                                placeholder={placeholder}
                            />
                            <div className="aui-composer-actions chat-action-row">
                                <RunningAction stopLabel={stopLabel} />
                                <IdleAction sendLabel={sendLabel} />
                            </div>
                        </div>
                    </ComposerPrimitive.Root>
                </div>
            </div>
        </ThreadPrimitive.Root>
    );
}

function AutoScrollManager({ viewportRef }: { viewportRef: React.RefObject<HTMLDivElement | null> }) {
    const isRunning = useThread((state) => state.isRunning);
    const messageCount = useThread((state) => (Array.isArray(state.messages) ? state.messages.length : 0));
    const lastMessageSignature = useThread((state) => {
        const messages = Array.isArray(state.messages) ? state.messages : [];
        const last = messages[messages.length - 1] as { id?: unknown; content?: unknown } | undefined;
        const parts = Array.isArray(last?.content) ? last.content : [];

        let textLength = 0;
        for (const part of parts) {
            if (!part || typeof part !== 'object') continue;
            const record = part as { type?: unknown; text?: unknown };
            if (record.type !== 'text') continue;
            if (typeof record.text === 'string') textLength += record.text.length;
        }

        return `${String(last?.id ?? '')}:${parts.length}:${textLength}`;
    });
    const shouldStickToBottomRef = useRef(true);

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return;

        const handleScroll = () => {
            const distanceToBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
            shouldStickToBottomRef.current = distanceToBottom <= 80;
        };

        handleScroll();
        viewport.addEventListener('scroll', handleScroll, { passive: true });
        return () => viewport.removeEventListener('scroll', handleScroll);
    }, [viewportRef]);

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport) return;
        if (!shouldStickToBottomRef.current && !isRunning) return;

        viewport.scrollTo({
            top: viewport.scrollHeight,
            behavior: isRunning ? 'auto' : 'smooth',
        });
    }, [messageCount, isRunning, lastMessageSignature, viewportRef]);

    useEffect(() => {
        const viewport = viewportRef.current;
        if (!viewport || typeof ResizeObserver === 'undefined') return;

        const resizeObserver = new ResizeObserver(() => {
            if (!shouldStickToBottomRef.current) return;
            viewport.scrollTop = viewport.scrollHeight;
        });

        resizeObserver.observe(viewport);
        return () => resizeObserver.disconnect();
    }, [viewportRef]);

    useEffect(() => {
        if (!isRunning) return;
        let rafId = 0;

        const keepBottomWhileStreaming = () => {
            const viewport = viewportRef.current;
            if (viewport && shouldStickToBottomRef.current) {
                viewport.scrollTop = viewport.scrollHeight;
            }
            rafId = window.requestAnimationFrame(keepBottomWhileStreaming);
        };

        rafId = window.requestAnimationFrame(keepBottomWhileStreaming);
        return () => window.cancelAnimationFrame(rafId);
    }, [isRunning, viewportRef]);

    return null;
}

function IdleAction({ sendLabel }: { sendLabel: string }) {
    const isRunning = useThread((state) => state.isRunning);
    if (isRunning) return null;

    return (
        <ComposerPrimitive.Send className="aui-composer-send" aria-label={sendLabel}>
            <Sparkles size={16} strokeWidth={2.5} />
        </ComposerPrimitive.Send>
    );
}

function RunningAction({ stopLabel }: { stopLabel: string }) {
    const isRunning = useThread((state) => state.isRunning);
    if (!isRunning) return null;

    return (
        <ComposerPrimitive.Cancel className="aui-composer-cancel" aria-label={stopLabel}>
            <div style={{ width: 10, height: 10, background: 'currentColor', borderRadius: 2 }} />
        </ComposerPrimitive.Cancel>
    );
}

function UserMessage() {
    const messageId = useMessage((state) => String((state as { id?: unknown }).id ?? 'user-message'));

    return (
        <MessagePrimitive.Root className="aui-user-message" data-component="session-turn">
            <div
                data-slot="session-turn-message-container"
                data-message={messageId}
            >
                <div data-slot="session-turn-message-content" aria-live="off">
                    <div data-component="user-message">
                        <div data-slot="user-message-body">
                            <div data-slot="user-message-text" className="aui-user-bubble">
                                <MessagePrimitive.Parts components={{ Text: UserMessageText }} />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </MessagePrimitive.Root>
    );
}

function UserMessageText() {
    const parts = useMessage((s) => (Array.isArray(s.content) ? s.content : []) as any[]);
    const textPart = parts.find((p: any) => p?.type === 'text');
    const text = textPart?.text || '';
    return (
        <div className="message-markdown aui-text-part">
            <RichMarkdown content={text} />
        </div>
    );
}

const TOOL_META: Record<string, any> = {
    web_search: { icon: Globe, label: "Web search", color: "blue" },
    read_file: { icon: FileText, label: "Read file", color: "gray" },
    run_code: { icon: FileCode, label: "Run code", color: "purple" },
    query_db: { icon: Database, label: "Query database", color: "teal" },
    calculator: { icon: Calculator, label: "Calculator", color: "amber" },
    sub_agent: { icon: Bot, label: "Sub-agent", color: "coral" },
};

const COLOR_TOKENS: Record<string, any> = {
    blue: { bg: "#E6F1FB", text: "#0C447C", border: "#B5D4F4", solid: "#378ADD" },
    gray: { bg: "#F1EFE8", text: "#444441", border: "#D3D1C7", solid: "#888780" },
    purple: { bg: "#EEEDFE", text: "#3C3489", border: "#CECBF6", solid: "#7F77DD" },
    teal: { bg: "#E1F5EE", text: "#085041", border: "#9FE1CB", solid: "#1D9E75" },
    amber: { bg: "#FAEEDA", text: "#633806", border: "#FAC775", solid: "#EF9F27" },
    coral: { bg: "#FAECE7", text: "#712B13", border: "#F5C4B3", solid: "#D85A30" },
    green: { bg: "#EAF3DE", text: "#27500A", border: "#C0DD97", solid: "#639922" },
};

function ToolGroupPart({
    children,
    locale,
}: {
    startIndex: number;
    endIndex: number;
    children?: ReactNode;
    locale: string;
}) {
    const [open, setOpen] = useState(false);
    const title = locale === "zh" ? "工具执行" : "Tool execution";
    const dedupedChildren = useMemo(() => {
        const nodes = Children.toArray(children);
        const latestByKey = new Map<string, { index: number; node: ReactNode }>();

        for (const [index, node] of nodes.entries()) {
            if (!isValidElement(node)) {
                latestByKey.set(`raw-${index}`, { index, node });
                continue;
            }

            const props = (node.props ?? {}) as Record<string, unknown>;
            const toolName = typeof props.toolName === 'string' ? props.toolName.trim() : 'tool';

            const args = (props.args && typeof props.args === 'object')
                ? props.args as Record<string, unknown>
                : undefined;
            const inputText = typeof args?.input === 'string'
                ? args.input.trim()
                : (typeof props.argsText === 'string' ? props.argsText.trim() : '');

            // De-duplicate same tool + same input, keep the latest status/result item only.
            const dedupeKey = `${toolName}::${inputText}`;
            latestByKey.set(dedupeKey, { index, node });
        }

        return [...latestByKey.values()]
            .sort((a, b) => a.index - b.index)
            .map((entry) => entry.node);
    }, [children]);

    return (
        <div className="aui-toolgroup">
            <button className="aui-toolgroup-header" onClick={() => setOpen(!open)} type="button">
                <span className="aui-toolgroup-status">
                    <Wrench size={14} style={{ color: "#7F77DD" }} />
                </span>
                <span className="aui-toolgroup-title">
                    {title}
                </span>
                <div className="aui-toolgroup-chips" />
                <span className="aui-chev">
                    <ChevronRight size={14} />
                </span>
            </button>

            {open && (
                <div className="aui-toolgroup-body">
                    {dedupedChildren}
                </div>
            )}
        </div>
    );
}

function ReasoningPart({ text, status }: any) {
    const [open, setOpen] = useState(status?.type === "running");
    const isRunning = status?.type === "running";

    return (
        <div className="aui-reasoning">
            <button className="aui-reasoning-header" onClick={() => setOpen(!open)} type="button">
                <span className="aui-reasoning-icon">
                    {isRunning ? (
                        <Loader2 size={13} className="aui-spin" />
                    ) : (
                        <Sparkles size={13} />
                    )}
                </span>
                <span className="aui-reasoning-label">
                    {isRunning ? "Thinking…" : `Thought`}
                </span>
                <span className={`aui-chev ${open ? "aui-chev-open" : ""}`}>
                    <ChevronRight size={14} />
                </span>
            </button>
            {open && (
                <div className="aui-reasoning-body">
                    {(text || "").split("\n\n").map((p: string, i: number) => (
                        <p key={i} className="aui-reasoning-para">{p}</p>
                    ))}
                </div>
            )}
        </div>
    );
}

function AssistantMessage({ locale }: { locale: string }) {
    return (
        <MessagePrimitive.Root className="aui-assistant-message" data-component="session-turn">
            <div className="aui-assistant-avatar">
                <Sparkles size={13} />
            </div>
            <div className="aui-assistant-body" data-slot="session-turn-assistant-content" aria-hidden="false">
                <MessagePrimitive.Parts
                    components={{
                        Text: (props) => <MessageText {...(props as Record<string, unknown>)} locale={locale} />,
                        Reasoning: ReasoningPart,
                        ToolGroup: (props) => <ToolGroupPart {...props} locale={locale} />,
                        tools: {
                            Override: (props) => <ToolEventPart {...props} locale={locale} />,
                        },
                    }}
                />
            </div>
        </MessagePrimitive.Root>
    );
}

function MessageText({ locale, ...partProps }: { locale: string } & Record<string, unknown>) {
    const isThreadRunning = useThread((state) => state.isRunning);
    const lastThreadMessageId = useThread((state) => {
        const messages = Array.isArray(state.messages) ? state.messages : [];
        const last = messages[messages.length - 1] as { id?: unknown } | undefined;
        return String(last?.id ?? '');
    });
    const parts = useMessage((s) => (Array.isArray(s.content) ? s.content : []) as any[]);
    const messageId = useMessage((state) => String((state as { id?: unknown }).id ?? 'assistant-message'));
    const textPart = parts.find((p: any) => p?.type === 'text');
    const textFromCurrentPart = typeof partProps.text === 'string' ? partProps.text : '';
    const textFromAllParts = parts
        .filter((p: any) => p?.type === 'text' && typeof p?.text === 'string')
        .map((p: any) => p.text as string)
        .join('');
    const text = textFromCurrentPart || textFromAllParts || '';
    const filesDataPart = [...parts].reverse().find((p: any) => p?.type === 'data-files');
    const skillsDataPart = [...parts].reverse().find((p: any) => p?.type === 'data-skills');
    const filesPayload = (filesDataPart?.data && typeof filesDataPart.data === 'object')
        ? filesDataPart.data
        : undefined;
    const skillsPayload = (skillsDataPart?.data && typeof skillsDataPart.data === 'object')
        ? skillsDataPart.data
        : undefined;
    const files = (Array.isArray(textPart?.files) ? textPart.files : undefined)
        || normalizeFilesData(filesPayload?.files ?? filesDataPart?.files);
    const skills = normalizeGeneratedSkills(skillsPayload?.skills ?? skillsDataPart?.skills);
    const toolCallParts = parts.filter((p: any) => p?.type === 'tool-call');
    const toolEvents = dedupeToolEvents(
        parts
            .filter((p: any) => p?.type === 'data-tool_event')
            .map((p: any) => p?.data)
            .filter((event: any) => event && typeof event === 'object')
    );
    const flowEvents = normalizeFlowEvents([
        ...parts
            .filter((p: any) => p?.type === 'data-subagent_event')
            .map((p: any) => ({ category: 'subagent' as const, data: p?.data })),
        ...parts
            .filter((p: any) => p?.type === 'data-opencode_event')
            .map((p: any) => ({ category: 'opencode' as const, data: p?.data })),
    ]);
    const showStreamingIndicator = isThreadRunning && messageId === lastThreadMessageId;

    return (
        <div className="message-markdown aui-text-part">
            <RichMarkdown content={text} />
            {showStreamingIndicator && (
                <div className="message-streaming-indicator" data-slot="session-turn-thinking" aria-live="polite">
                    <span className="message-streaming-dot" />
                    <span className="message-streaming-text">
                        {locale === 'zh' ? '正在后台执行...' : 'Running in background...'}
                    </span>
                </div>
            )}
            {skills.length > 0 && (
                <GeneratedSkillsPanel
                    panelId={`skills-panel-${messageId}`}
                    skills={skills}
                    locale={locale}
                />
            )}
            {files && files.length > 0 && <FileAttachments files={files} />}
            {toolEvents.length > 0 && toolCallParts.length === 0 && (
                <div className="tool-event-list tool-event-inline">
                    {toolEvents.map((event, index) => (
                        <DataToolEventCard
                            key={`${event.id}-${event.eventType}-${index}`}
                            event={event}
                            locale={locale}
                        />
                    ))}
                </div>
            )}
            {flowEvents.length > 0 && (
                <div className="tool-event-list tool-event-inline">
                    {flowEvents.map((event) => (
                        <FlowEventCard
                            key={`${event.category}-${event.id}-${event.eventType || (event as any).kind || 'event'}`}
                            event={event}
                            locale={locale}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

type ToolEventView = {
    id: string;
    name: string;
    status: string;
    input?: string;
    output?: string;
    eventType?: string;
};

const dedupeToolEvents = (events: ToolEventView[]): ToolEventView[] => {
    const latestById = new Map<string, ToolEventView>();
    for (const event of events) {
        const id = toSingleLineText(event?.id) || `${toSingleLineText(event?.name) || 'tool'}-${events.indexOf(event)}`;
        const name = toSingleLineText(event?.name) || 'tool';
        const status = toSingleLineText(event?.status) || 'running';
        const input = toSingleLineText(event?.input);
        const output = toSingleLineText(event?.output);
        const eventType = toSingleLineText(event?.eventType);
        latestById.set(id, {
            id,
            name,
            status,
            ...(input ? { input } : {}),
            ...(output ? { output } : {}),
            ...(eventType ? { eventType } : {}),
        });
    }
    return [...latestById.values()];
};

type FlowEventView = {
    category: 'subagent' | 'opencode';
    id: string;
    title: string;
    body?: string;
    eventType?: string;
};

const normalizeFlowEvents = (
    events: Array<{ category: 'subagent' | 'opencode'; data: unknown }>
): FlowEventView[] => {
    const latestById = new Map<string, FlowEventView>();
    for (const entry of events) {
        if (!entry?.data || typeof entry.data !== 'object') continue;
        const record = entry.data as Record<string, unknown>;
        const id = toSingleLineText(record.id)
            || `${entry.category}-${toSingleLineText(record.eventType) || toSingleLineText(record.kind) || 'event'}`;
        const title = entry.category === 'subagent'
            ? toSingleLineText(record.agent) || 'subagent'
            : toSingleLineText(record.kind) || toSingleLineText(record.eventType) || 'event';
        const body = entry.category === 'subagent'
            ? toSingleLineText(record.description) || toSingleLineText(record.prompt)
            : toSingleLineText(record.text);
        latestById.set(id, {
            category: entry.category,
            id,
            title,
            ...(body ? { body } : {}),
            ...(toSingleLineText(record.eventType) ? { eventType: toSingleLineText(record.eventType) } : {}),
        });
    }
    return [...latestById.values()];
};

function DataToolEventCard({ event, locale }: { event: ToolEventView; locale: string }) {
    const [expanded, setExpanded] = useState(false);
    const statusType = toStatusType(event.status || 'running');
    const detailText = event.input || '';
    const resultText = event.output || '';
    const hasDetails = Boolean(detailText || resultText || statusType === 'incomplete');

    return (
        <Tool className="tool-event-card tool-event-inline" onClick={() => setExpanded((prev) => !prev)}>
            <ToolHeader className="tool-event-meta">
                <div className="skill-generator-tool-fallback-left">
                    <span className="skill-generator-tool-fallback-kind-icon-wrapper" aria-hidden="true">
                        <Wrench className="skill-generator-tool-fallback-kind-icon" size={14} />
                    </span>
                    <div className="skill-generator-tool-fallback-title-wrap">
                        <span className="skill-generator-tool-fallback-kind">{locale === 'zh' ? '工具调用' : 'Tool'}</span>
                        <ToolTitle className="tool-event-name" title={event.name}>{compactLabel(event.name)}</ToolTitle>
                    </div>
                </div>
            </ToolHeader>
            {hasDetails && expanded && (
                <ToolInput className="skill-generator-tool-fallback-content">
                    {detailText && (
                        <div className="skill-generator-tool-fallback-section">
                            <p className="skill-generator-tool-fallback-label">{locale === 'zh' ? '输入' : 'Input'}</p>
                            <pre className="skill-generator-tool-fallback-pre">{detailText}</pre>
                        </div>
                    )}
                    {resultText && (
                        <div className="skill-generator-tool-fallback-section">
                            <p className="skill-generator-tool-fallback-label">{locale === 'zh' ? '结果' : 'Result'}</p>
                            <pre className="skill-generator-tool-fallback-pre">{resultText}</pre>
                        </div>
                    )}
                    {statusType === 'incomplete' && (
                        <div className="skill-generator-tool-fallback-error">
                            <span aria-hidden="true">!</span>
                            <span>{locale === 'zh' ? '执行异常，请查看输入或日志。' : 'Execution failed. Check input or logs.'}</span>
                        </div>
                    )}
                </ToolInput>
            )}
        </Tool>
    );
}

function FlowEventCard({ event, locale }: { event: FlowEventView; locale: string }) {
    const [expanded, setExpanded] = useState(false);
    const isSubagent = event.category === 'subagent';
    const label = isSubagent
        ? (locale === 'zh' ? '子任务' : 'Subagent')
        : (locale === 'zh' ? '流程事件' : 'Flow event');
    const hasDetails = Boolean(event.body);

    return (
        <Tool className="tool-event-card tool-event-inline" onClick={() => setExpanded((prev) => !prev)}>
            <ToolHeader className="tool-event-meta">
                <div className="skill-generator-tool-fallback-left">
                    <span className="skill-generator-tool-fallback-kind-icon-wrapper" aria-hidden="true">
                        {isSubagent ? <Bot className="skill-generator-tool-fallback-kind-icon" size={14} /> : <GitCommit className="skill-generator-tool-fallback-kind-icon" size={14} />}
                    </span>
                    <div className="skill-generator-tool-fallback-title-wrap">
                        <span className="skill-generator-tool-fallback-kind">{label}</span>
                        <ToolTitle className="tool-event-name" title={event.title}>{compactLabel(event.title)}</ToolTitle>
                    </div>
                </div>
            </ToolHeader>
            {hasDetails && expanded && (
                <ToolInput className="skill-generator-tool-fallback-content">
                    <div className="skill-generator-tool-fallback-section">
                        <p className="skill-generator-tool-fallback-label">{locale === 'zh' ? '内容' : 'Details'}</p>
                        <pre className="skill-generator-tool-fallback-pre">{event.body}</pre>
                    </div>
                </ToolInput>
            )}
        </Tool>
    );
}

const normalizeFilesData = (rawFiles: unknown): Array<{ path: string; content: string; size: number }> => {
    if (!rawFiles || typeof rawFiles !== 'object') return [];
    const entries = Object.entries(rawFiles as Record<string, any>);
    return entries.map(([path, fileData]) => {
        const rawContent = fileData?.content;
        const content = Array.isArray(rawContent)
            ? rawContent.join('\n')
            : (typeof rawContent === 'string' ? rawContent : '');
        return {
            path,
            content,
            size: content.length,
        };
    });
};

const normalizeGeneratedSkills = (rawSkills: unknown): GeneratedSkill[] => {
    if (!Array.isArray(rawSkills)) return [];
    const normalized: GeneratedSkill[] = [];

    for (const rawSkill of rawSkills) {
        if (!rawSkill || typeof rawSkill !== 'object') continue;
        const record = rawSkill as Record<string, unknown>;
        const id = toSingleLineText(record.id);
        const name = toSingleLineText(record.name);
        if (!id || !name) continue;

        const filesRaw = Array.isArray(record.files) ? record.files : [];
        const files: GeneratedSkillFile[] = filesRaw
            .map((rawFile) => {
                if (!rawFile || typeof rawFile !== 'object') return null;
                const fileRecord = rawFile as Record<string, unknown>;
                const path = toSingleLineText(fileRecord.path);
                if (!path) return null;
                return {
                    path,
                    content: typeof fileRecord.content === 'string' ? fileRecord.content : '',
                    modified_at: toSingleLineText(fileRecord.modified_at),
                };
            })
            .filter((file): file is GeneratedSkillFile => Boolean(file));

        normalized.push({
            id,
            name,
            description: toSingleLineText(record.description),
            skillMdPath: toSingleLineText(record.skillMdPath) || files[0]?.path || '',
            skillMdContent: typeof record.skillMdContent === 'string' ? record.skillMdContent : '',
            files,
            updated_at: toSingleLineText(record.updated_at),
        });
    }

    return normalized;
};

function GeneratedSkillsPanel({
    panelId,
    skills,
    locale,
}: {
    panelId: string;
    skills: GeneratedSkill[];
    locale: string;
}) {
    const syncPanel = useGeneratedSkillsStore((state) => state.syncPanel);
    const setActiveSkill = useGeneratedSkillsStore((state) => state.setActiveSkill);
    const setActiveFile = useGeneratedSkillsStore((state) => state.setActiveFile);
    const panel = useGeneratedSkillsStore((state) => state.panels[panelId]);

    useEffect(() => {
        syncPanel(panelId, skills);
    }, [panelId, skills, syncPanel]);

    const activeSkill = panel?.skills.find((skill) => skill.id === panel.activeSkillId) ?? panel?.skills[0];
    const activeFile = activeSkill?.files.find((file) => file.path === panel?.activeFilePath)
        ?? activeSkill?.files.find((file) => file.path === activeSkill.skillMdPath)
        ?? activeSkill?.files[0];
    const activeFileContent = activeFile?.content ?? activeSkill?.skillMdContent ?? '';
    const isMarkdownFile = Boolean(activeFile?.path?.toLowerCase().endsWith('.md'));

    if (!panel || panel.skills.length === 0 || !activeSkill) return null;

    return (
        <div className="generated-skills-panel" data-color-mode="light">
            <div className="generated-skills-header">
                <span className="generated-skills-title">{locale === 'zh' ? '生成的技能' : 'Generated Skills'}</span>
                <span className="generated-skills-count">{panel.skills.length}</span>
            </div>

            <div className="generated-skills-toolbar">
                {panel.skills.map((skill) => (
                    <button
                        key={skill.id}
                        type="button"
                        className={`generated-skill-chip ${panel.activeSkillId === skill.id ? 'active' : ''}`}
                        onClick={() => setActiveSkill(panelId, skill.id)}
                    >
                        {skill.name}
                    </button>
                ))}
            </div>

            {activeSkill.description && (
                <p className="generated-skill-description">{activeSkill.description}</p>
            )}

            <div className="generated-skill-files">
                {activeSkill.files.map((file) => (
                    <button
                        key={file.path}
                        type="button"
                        className={`generated-skill-file ${panel.activeFilePath === file.path ? 'active' : ''}`}
                        onClick={() => setActiveFile(panelId, file.path)}
                    >
                        {file.path.split('/').pop()}
                    </button>
                ))}
            </div>

            <div className="generated-skill-editor">
                {isMarkdownFile ? (
                    <MDEditor
                        value={activeFileContent}
                        onChange={() => {}}
                        preview="edit"
                        hideToolbar
                        visibleDragbar={false}
                        height={300}
                    />
                ) : (
                    <pre><code>{activeFileContent || (locale === 'zh' ? '暂无内容' : 'No content')}</code></pre>
                )}
            </div>
        </div>
    );
}

const escapeHtml = (text: string) => {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
};

const inlineFormat = (s: string) => {
    if (!s) return "";
    const escaped = escapeHtml(s);
    return escaped
        .replace(/`([^`]+)`/g, '<code class="aui-inline-code">$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>");
};

const parseMarkdown = (md: string) => {
    const lines = md.split("\n");
    const blocks: any[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.startsWith("```")) {
            const lang = line.slice(3).trim();
            const code = [];
            i++;
            while (i < lines.length && !lines[i].startsWith("```")) {
                code.push(lines[i]);
                i++;
            }
            blocks.push({ type: "code", lang, text: code.join("\n") });
            i++;
            continue;
        }
        if (line.startsWith("### ")) { blocks.push({ type: "h3", text: line.slice(4) }); i++; continue; }
        if (line.startsWith("## ")) { blocks.push({ type: "h2", text: line.slice(3) }); i++; continue; }
        if (line.startsWith("# ")) { blocks.push({ type: "h1", text: line.slice(2) }); i++; continue; }
        // Tables
        if (line.includes("|") && lines[i + 1]?.match(/^\s*\|?[\s:|-]+\|/)) {
            const headers = line.split("|").map((s) => s.trim()).filter(Boolean);
            const rows = [];
            i += 2;
            while (i < lines.length && lines[i].includes("|")) {
                rows.push(lines[i].split("|").map((s) => s.trim()).filter((_, k, a) => k > 0 && k < a.length - 1 || (a[0] !== "" && a[a.length - 1] !== "")));
                i++;
            }
            // Normalize rows to header length
            const normRows = rows.map((r) => {
                const cleaned = r.filter((c) => c !== undefined);
                while (cleaned.length < headers.length) cleaned.push("");
                return cleaned.slice(0, headers.length);
            });
            blocks.push({ type: "table", headers, rows: normRows });
            continue;
        }
        // Lists
        if (line.match(/^[-*]\s/)) {
            const items = [];
            while (i < lines.length && lines[i].match(/^[-*]\s/)) {
                items.push(lines[i].replace(/^[-*]\s/, ""));
                i++;
            }
            blocks.push({ type: "ul", items });
            continue;
        }
        if (line.match(/^\d+\.\s/)) {
            const items = [];
            while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
                items.push(lines[i].replace(/^\d+\.\s/, ""));
                i++;
            }
            blocks.push({ type: "ol", items });
            continue;
        }
        if (line.trim() === "") { i++; continue; }
        // Paragraph (consume contiguous non-empty lines)
        const para = [line];
        i++;
        while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("#") && !lines[i].startsWith("```") && !lines[i].match(/^[-*]\s/) && !lines[i].match(/^\d+\.\s/) && !lines[i].includes("|")) {
            para.push(lines[i]);
            i++;
        }
        blocks.push({ type: "p", text: para.join("\n") });
    }
    return blocks;
};

const MarkdownTable = ({ headers, rows }: { headers: string[], rows: string[][] }) => (
    <div className="aui-table-wrap">
        <table className="aui-table">
            <thead>
                <tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
            </thead>
            <tbody>
                {rows.map((r, i) => (
                    <tr key={i}>{r.map((c, j) => <td key={j} dangerouslySetInnerHTML={{ __html: inlineFormat(c) }} />)}</tr>
                ))}
            </tbody>
        </table>
    </div>
);

const RichMarkdown = ({ content }: { content: string }) => {
    const blocks = useMemo(() => parseMarkdown(content), [content]);
    return (
        <div className="aui-md">
            {blocks.map((b, i) => {
                if (b.type === "h1") return <h1 key={i}>{b.text}</h1>;
                if (b.type === "h2") return <h2 key={i}>{b.text}</h2>;
                if (b.type === "h3") return <h3 key={i}>{b.text}</h3>;
                if (b.type === "code") return (
                    <pre key={i} className="aui-code">
                        <div className="aui-code-header">
                            <span>{b.lang || "text"}</span>
                            <button type="button" onClick={() => navigator.clipboard?.writeText(b.text)}>
                                <Copy size={11} /> Copy
                            </button>
                        </div>
                        <code>{b.text}</code>
                    </pre>
                );
                if (b.type === "table") return <MarkdownTable key={i} headers={b.headers} rows={b.rows} />;
                if (b.type === "ul") return (
                    <ul key={i}>{b.items.map((it: string, j: number) => <li key={j} dangerouslySetInnerHTML={{ __html: inlineFormat(it) }} />)}</ul>
                );
                if (b.type === "ol") return (
                    <ol key={i}>{b.items.map((it: string, j: number) => <li key={j} dangerouslySetInnerHTML={{ __html: inlineFormat(it) }} />)}</ol>
                );
                return <p key={i} dangerouslySetInnerHTML={{ __html: inlineFormat(b.text) }} />;
            })}
        </div>
    );
};

const FileAttachments = ({ files }: { files: any[] }) => {
    const [openFile, setOpenFile] = useState<any>(null);
    const tree = useMemo(() => buildTree(files), [files]);

    return (
        <div className="aui-files">
            <div className="aui-files-header">
                <Folder size={13} />
                <span>{files.length} file{files.length > 1 ? "s" : ""} generated</span>
            </div>
            <div className="aui-files-list">
                {tree.map((node, i) => (
                    <FileTreeNode
                        key={i}
                        node={node}
                        depth={0}
                        openFile={openFile}
                        onOpen={setOpenFile}
                    />
                ))}
            </div>
            {openFile && (
                <FileViewer file={openFile} onClose={() => setOpenFile(null)} />
            )}
        </div>
    );
};

const buildTree = (files: any[]) => {
    const root = { name: "", children: [], _map: {} as any };
    files.forEach((f) => {
        const parts = f.path.split("/");
        let cur: any = root;
        parts.forEach((part: string, idx: number) => {
            const isLeaf = idx === parts.length - 1;
            if (isLeaf) {
                cur.children.push({ type: "file", name: part, file: f });
            } else {
                if (!cur._map[part]) {
                    const dir = { type: "dir", name: part, children: [], _map: {} };
                    cur.children.push(dir);
                    cur._map[part] = dir;
                }
                cur = cur._map[part];
            }
        });
    });
    return root.children;
};

const FileTreeNode = ({ node, depth, openFile, onOpen }: any) => {
    const [open, setOpen] = useState(depth === 0);
    if (node.type === "dir") {
        return (
            <>
                <button
                    className="aui-file-row aui-file-dir"
                    onClick={() => setOpen(!open)}
                    style={{ paddingLeft: 8 + depth * 16 }}
                    type="button"
                >
                    <span className="aui-file-chev">
                        <ChevronRight size={12} className={open ? "aui-chev-open" : ""} />
                    </span>
                    {open ? <FolderOpen size={13} /> : <Folder size={13} />}
                    <span className="aui-file-name">{node.name}</span>
                    <span className="aui-file-count">{countFiles(node)}</span>
                </button>
                {open && node.children.map((child: any, i: number) => (
                    <FileTreeNode
                        key={i}
                        node={child}
                        depth={depth + 1}
                        openFile={openFile}
                        onOpen={onOpen}
                    />
                ))}
            </>
        );
    }
    const isOpen = openFile && openFile.path === node.file.path;
    return (
        <button
            className={`aui-file-row aui-file-item ${isOpen ? "aui-file-active" : ""}`}
            onClick={() => onOpen(node.file)}
            style={{ paddingLeft: 8 + depth * 16 + 14 }}
            type="button"
        >
            <FileIcon name={node.name} />
            <span className="aui-file-name">{node.name}</span>
            <span className="aui-file-size">{formatSize(node.file.size)}</span>
        </button>
    );
};

const countFiles = (node: any): number => {
    if (node.type === "file") return 1;
    return node.children.reduce((s: number, c: any) => s + countFiles(c), 0);
};

const FileIcon = ({ name }: { name: string }) => {
    const ext = name.split(".").pop();
    if (["js", "jsx", "ts", "tsx", "py", "rs", "go", "md", "json", "yaml", "yml"].includes(ext || ""))
        return <FileCode size={13} style={{ color: "#7F77DD" }} />;
    if (["csv", "xlsx", "xls"].includes(ext || ""))
        return <FileSpreadsheet size={13} style={{ color: "#1D9E75" }} />;
    return <FileText size={13} style={{ color: "#888780" }} />;
};

const formatSize = (b: number) => {
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + " KB";
    return (b / (1024 * 1024)).toFixed(1) + " MB";
};

const FileViewer = ({ file, onClose }: { file: any, onClose: () => void }) => {
    return (
        <div className="aui-fileviewer-overlay" onClick={onClose}>
            <div className="aui-fileviewer" onClick={(e) => e.stopPropagation()}>
                <div className="aui-fileviewer-header">
                    <div className="aui-fileviewer-title">
                        <FileIcon name={file.path.split("/").pop()} />
                        <span className="aui-fileviewer-path">{file.path}</span>
                    </div>
                    <div className="aui-fileviewer-actions">
                        <button type="button" className="aui-iconbtn" title="Download"><Download size={14} /></button>
                        <button type="button" className="aui-iconbtn" title="Close" onClick={onClose}><X size={14} /></button>
                    </div>
                </div>
                <div className="aui-fileviewer-body">
                    {file.path.endsWith(".md") ? (
                        <RichMarkdown content={file.content} />
                    ) : (
                        <pre className="aui-fileviewer-code"><code>{file.content}</code></pre>
                    )}
                </div>
            </div>
        </div>
    );
};

const normalizeStatus = (status: string): string => status.toLowerCase().replace(/[^a-z0-9]+/g, '_');

const toSingleLineText = (value: unknown): string => {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
};

const compactLabel = (value: string): string => {
    return value
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};

const prettyKindLabel = (kind: string, locale: string): string => {
    const key = kind.trim().toLowerCase();
    if (locale === 'zh') {
        if (key === 'tool') return '工具调用';
        if (key === 'model') return '模型调用';
        return '流程节点';
    }
    if (key === 'tool') return 'Tool';
    if (key === 'model') return 'Model';
    return 'Node';
};

const normalizeDisplayName = (name: string): string => {
    const cleaned = name
        .replace(/^(tool|model|node)\s*:\s*/i, '')
        .trim();
    return cleaned || name;
};

const toTaskState = (status: string): 'running' | 'completed' | 'failed' => {
    const statusType = toStatusType(status);
    if (statusType === 'complete') return 'completed';
    if (statusType === 'incomplete') return 'failed';
    return 'running';
};

const getKindIcon = (kind: string) => {
    const normalized = kind.trim().toLowerCase();
    if (normalized === 'tool') return <Wrench className="skill-generator-tool-fallback-kind-icon" size={14} />;
    if (normalized === 'model') return <Bot className="skill-generator-tool-fallback-kind-icon" size={14} />;
    return <GitCommit className="skill-generator-tool-fallback-kind-icon" size={14} />;
};

const getStatusIcon = (statusType: 'running' | 'complete' | 'incomplete') => {
    if (statusType === 'running') return <Loader2 className="ae-task-icon animate-spin" size={12} />;
    if (statusType === 'complete') return <CheckCircle2 className="ae-task-icon" size={12} />;
    return <AlertCircle className="ae-task-icon" size={12} />;
};

const toStatusType = (status: string): 'running' | 'complete' | 'incomplete' => {
    const normalized = normalizeStatus(status);
    if (/(error|failed|cancel|incomplete|timeout)/i.test(normalized)) return 'incomplete';
    if (/(complete|completed|done|success|ok)/i.test(normalized)) return 'complete';
    return 'running';
};

const getStatusLabel = (status: string, locale: string): string => {
    const statusType = toStatusType(status);
    if (locale === 'zh') {
        if (statusType === 'running') return '运行中';
        if (statusType === 'complete') return '已完成';
        return '异常';
    }
    if (statusType === 'running') return 'Running';
    if (statusType === 'complete') return 'Completed';
    return 'Failed';
};

function ToolEventPart({ toolName, args, argsText, result, locale }: ToolCallMessagePartProps & { locale: string }) {
    const [expanded, setExpanded] = useState(false);
    const meta = (args && typeof args === 'object') ? (args as Record<string, unknown>) : {};
    const kind = toSingleLineText(meta.kind) || 'tool';
    const rawStatus = toSingleLineText(meta.status) || 'running';
    const input = toSingleLineText(meta.input);
    const statusType = toStatusType(rawStatus);
    const isRunning = statusType === 'running';
    const detailText = input || argsText || '';
    const resultText = toSingleLineText(result) || toSingleLineText(meta.result);
    const title = normalizeDisplayName(toolName);
    const kindLabel = prettyKindLabel(kind, locale);
    const hasDetails = Boolean(detailText || resultText || statusType === 'incomplete');
    const kindIcon = getKindIcon(kind);

    return (
        <Tool className="tool-event-card tool-event-inline" onClick={() => setExpanded((prev) => !prev)}>
            <ToolHeader className="tool-event-meta">
                <div className="skill-generator-tool-fallback-left">
                    <span className="skill-generator-tool-fallback-kind-icon-wrapper" aria-hidden="true">{kindIcon}</span>
                    <div className="skill-generator-tool-fallback-title-wrap">
                        <span className="skill-generator-tool-fallback-kind">{kindLabel}</span>
                        <ToolTitle className="tool-event-name" title={title}>{compactLabel(title)}</ToolTitle>
                    </div>
                </div>
            </ToolHeader>

            {hasDetails && expanded && (
                <ToolInput className="skill-generator-tool-fallback-content">
                    {detailText && (
                        <div className="skill-generator-tool-fallback-section">
                            <p className="skill-generator-tool-fallback-label">{locale === 'zh' ? '输入' : 'Input'}</p>
                            <pre className="skill-generator-tool-fallback-pre">{detailText}</pre>
                        </div>
                    )}
                    {resultText && (
                        <div className="skill-generator-tool-fallback-section">
                            <p className="skill-generator-tool-fallback-label">{locale === 'zh' ? '结果' : 'Result'}</p>
                            <pre className="skill-generator-tool-fallback-pre">{resultText}</pre>
                        </div>
                    )}
                    {statusType === 'incomplete' && (
                        <div className="skill-generator-tool-fallback-error">
                            <span aria-hidden="true">!</span>
                            <span>{locale === 'zh' ? '执行异常，请查看输入或日志。' : 'Execution failed. Check input or logs.'}</span>
                        </div>
                    )}
                </ToolInput>
            )}
            {!hasDetails && isRunning && (
                <p className="skill-generator-tool-fallback-label">{locale === 'zh' ? '等待工具结果…' : 'Waiting for tool result...'}</p>
            )}
        </Tool>
    );
}
