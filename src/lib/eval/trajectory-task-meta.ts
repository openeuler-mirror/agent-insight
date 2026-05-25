export interface TrajectoryTaskMeta {
    title: string;
    description: string;
}

const DEFAULT_TITLE_PREFIX = '评测执行';

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

function safeParseObject(value: string | null | undefined): Record<string, unknown> | null {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

export function formatTrajectoryTaskTimestamp(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function buildDefaultTrajectoryTaskTitle(date = new Date()): string {
    return `${DEFAULT_TITLE_PREFIX} ${formatTrajectoryTaskTimestamp(date)}`;
}

export function normalizeTrajectoryTaskMeta(
    input: { title?: unknown; description?: unknown },
    fallbackDate = new Date(),
): TrajectoryTaskMeta {
    const title = String(input.title || '').trim();
    const description = String(input.description || '').trim();
    return {
        title: title || buildDefaultTrajectoryTaskTitle(fallbackDate),
        description,
    };
}

export function extractTrajectoryTaskMeta(
    rawAnalysisJson: string | null | undefined,
    fallbackDate = new Date(),
): TrajectoryTaskMeta {
    const parsed = safeParseObject(rawAnalysisJson);
    const taskMeta = parsed?.taskMeta && typeof parsed.taskMeta === 'object' && !Array.isArray(parsed.taskMeta)
        ? parsed.taskMeta as Record<string, unknown>
        : null;

    return normalizeTrajectoryTaskMeta({
        title: taskMeta?.title ?? parsed?.taskTitle,
        description: taskMeta?.description ?? parsed?.taskDescription,
    }, fallbackDate);
}
