"use client";

import { AssistantRuntimeProvider, useThread, type ThreadMessageLike } from '@assistant-ui/react';
import { useChatRuntime } from '@assistant-ui/react-ai-sdk';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';


interface FileData {
    content: string[];
    created_at: string;
    modified_at: string;
}

type FilesState = Record<string, FileData>;

interface AgentRuntimeProviderProps {
    user: string | null;
    threadId: string | null;
    files: FilesState;
    modelId: string;
    scenario: string;
    locale: string;
    initialMessages?: readonly ThreadMessageLike[];
    onFiles?: (files: FilesState) => void;
    onFilePathsDetected?: (paths: string[]) => void;
    onThreadMessages?: (messages: readonly ThreadMessageLike[]) => void;
    onRunningChange?: (isRunning: boolean) => void;
    children: ReactNode;
}

interface FileSyncObserverProps {
    onFiles?: (files: FilesState) => void;
    onFilePathsDetected?: (paths: string[]) => void;
}

interface ThreadSyncObserverProps {
    onThreadMessages?: (messages: readonly ThreadMessageLike[]) => void;
    onRunningChange?: (isRunning: boolean) => void;
}

const extractFilesFromThreadMessages = (messages: unknown): FilesState | null => {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (!message || typeof message !== 'object') continue;
        const record = message as { content?: unknown; metadata?: unknown };

        // assistant-stream data chunks are accumulated under metadata.unstable_data
        const unstableData = (
            record.metadata && typeof record.metadata === 'object'
                ? (record.metadata as { unstable_data?: unknown }).unstable_data
                : undefined
        );
        if (Array.isArray(unstableData)) {
            for (let k = unstableData.length - 1; k >= 0; k -= 1) {
                const dataEntry = unstableData[k];
                if (!dataEntry || typeof dataEntry !== 'object') continue;
                const entry = dataEntry as { name?: unknown; data?: unknown };
                if (entry.name !== 'files') continue;
                if (!entry.data || typeof entry.data !== 'object') continue;
                const files = (entry.data as { files?: unknown }).files;
                if (files && typeof files === 'object') return files as FilesState;
            }
        }

        const content = Array.isArray(record.content) ? record.content : [];
        for (let j = content.length - 1; j >= 0; j -= 1) {
            const part = content[j];
            if (!part || typeof part !== 'object') continue;
            const partRecord = part as { type?: unknown; data?: unknown; files?: unknown };
            if (partRecord.type !== 'data-files') continue;
            const fromData = (partRecord.data && typeof partRecord.data === 'object')
                ? (partRecord.data as { files?: unknown }).files
                : undefined;
            const files = (fromData && typeof fromData === 'object')
                ? fromData
                : (partRecord.files && typeof partRecord.files === 'object' ? partRecord.files : undefined);
            if (!files) return null;
            return files as FilesState;
        }
    }
    return null;
};

function FileSyncObserver({ onFiles, onFilePathsDetected }: FileSyncObserverProps) {
    const messages = useThread((state) => state.messages as unknown);
    const isRunning = useThread((state) => state.isRunning);
    const lastSignatureRef = useRef('');
    const pendingFilesRef = useRef<FilesState | null>(null);
    const pendingPathsRef = useRef<string[] | null>(null);

    useEffect(() => {
        const files = extractFilesFromThreadMessages(messages);
        if (!files) return;

        const signature = Object.entries(files)
            .map(([filePath, fileData]) => `${filePath}:${fileData.modified_at}:${fileData.content.length}`)
            .join('|');
        if (!signature || signature === lastSignatureRef.current) return;
        lastSignatureRef.current = signature;

        const filePaths = Object.keys(files);
        if (isRunning) {
            // Avoid parent state churn during active stream; apply once run settles.
            pendingFilesRef.current = files;
            pendingPathsRef.current = filePaths;
            return;
        }

        onFiles?.(files);
        onFilePathsDetected?.(filePaths);
    }, [messages, isRunning, onFiles, onFilePathsDetected]);

    useEffect(() => {
        if (isRunning) return;
        if (!pendingFilesRef.current) return;

        onFiles?.(pendingFilesRef.current);
        onFilePathsDetected?.(pendingPathsRef.current ?? Object.keys(pendingFilesRef.current));
        pendingFilesRef.current = null;
        pendingPathsRef.current = null;
    }, [isRunning, onFiles, onFilePathsDetected]);

    return null;
}

function ThreadSyncObserver({ onThreadMessages, onRunningChange }: ThreadSyncObserverProps) {
    const messages = useThread((state) => state.messages as ThreadMessageLike[]);
    const isRunning = useThread((state) => state.isRunning);
    const pendingMessagesRef = useRef<readonly ThreadMessageLike[] | null>(null);

    useEffect(() => {
        if (isRunning) {
            pendingMessagesRef.current = messages;
            return;
        }

        onThreadMessages?.(messages);
    }, [messages, isRunning, onThreadMessages]);

    useEffect(() => {
        onRunningChange?.(isRunning);
    }, [isRunning, onRunningChange]);

    useEffect(() => {
        if (isRunning) return;
        if (!pendingMessagesRef.current) return;

        onThreadMessages?.(pendingMessagesRef.current);
        pendingMessagesRef.current = null;
    }, [isRunning, onThreadMessages]);

    return null;
}

export function AgentRuntimeProvider({
    user,
    threadId,
    files,
    modelId,
    scenario,
    locale,
    initialMessages,
    onFiles,
    onFilePathsDetected,
    onThreadMessages,
    onRunningChange,
    children,
}: AgentRuntimeProviderProps) {
    const defaultInitialMessages = useMemo<readonly ThreadMessageLike[]>(
        () => [{
            role: 'assistant',
            content: locale === 'zh'
                ? '你好！我是 Skills 生成助手。请告诉我你想生成什么样的 Skill？'
                : 'Hello! I am a Skills generation assistant. What would you like to generate?',
        }],
        [locale]
    );

    const resolvedInitialMessages = useMemo<readonly ThreadMessageLike[]>(
        () => (initialMessages && initialMessages.length > 0 ? initialMessages : defaultInitialMessages),
        [defaultInitialMessages, initialMessages]
    );

    const runtime = useChatRuntime({
        api: '/api/skill-generator/chat',
        body: {
            user,
            threadId,
            files,
            modelId,
            scenario,
            locale,
        },
        initialMessages: resolvedInitialMessages,
        onCancel: () => {
            if (!user || !threadId) return;
            void fetch('/api/skill-generator/chat/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user, threadId }),
            }).catch(() => {
                // local abort already stops client-side streaming
            });
        },
    });

    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <FileSyncObserver
                onFiles={onFiles}
                onFilePathsDetected={onFilePathsDetected}
            />
            <ThreadSyncObserver
                onThreadMessages={onThreadMessages}
                onRunningChange={onRunningChange}
            />
            {children}
        </AssistantRuntimeProvider>
    );
}
