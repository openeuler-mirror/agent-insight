
import { db } from '@/lib/storage/prisma';

export interface SessionData {
    taskId: string;
    label?: string;
    query?: string;
    startTime: number;
    interactions: {
        requestMessages: any[];
        responseMessage: any;
        usage: {
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
        };
        latency: number;
        timestamp: number;
        toolCalls: any[];
    }[];
    user?: string;
    model?: string;
}

export async function startSession(taskId: string, label?: string, query?: string, user?: string, model?: string) {
    const data: SessionData = {
        taskId,
        label,
        query,
        user,
        model,
        startTime: Date.now(),
        interactions: []
    };
    
    await db.createSession({
        taskId,
        label,
        query,
        user,
        model,
        startTime: new Date(data.startTime),
        interactions: JSON.stringify([])
    });

    return data;
}

export async function addToSession(taskId: string, interaction: SessionData['interactions'][0]) {
    const session = await db.findSessionByTaskId(taskId);
    let interactions: any[] = [];
    let startTime = Date.now();
    let currentData: any = {};
    
    if (session) {
        try {
            interactions = session.interactions ? JSON.parse(session.interactions as string) : [];
        } catch (e) {
            console.error(`[ProxyStore] Failed to parse interactions for ${taskId}`, e);
            interactions = [];
        }
        
        startTime = session.startTime.getTime();
        currentData = {
            taskId: session.taskId,
            label: session.label,
            query: session.query,
            user: session.user,
            model: session.model,
            startTime,
            interactions
        };
    } else {
        console.log(`[ProxyStore] Session ${taskId} not found in addToSession, creating new.`);
        currentData = { taskId, startTime, interactions: [] };
        await db.createSession({
            taskId,
            startTime: new Date(startTime),
            interactions: JSON.stringify([])
        });
    }
    
    interactions.push(interaction);

    await db.updateSession(taskId, {
        interactions: JSON.stringify(interactions)
    });
    
    currentData.interactions = interactions;
    return currentData;
}

export async function endSession(taskId: string): Promise<SessionData | null> {
    const session = await db.findSessionByTaskId(taskId);
    if (!session) return null;

    try {
        await db.updateSession(taskId, { endTime: new Date() });
    } catch (error) {
        console.warn(`[ProxyStore] Failed to mark session ended for ${taskId}`, error);
    }
    
    return {
        taskId: session.taskId,
        label: session.label || undefined,
        query: session.query || undefined,
        user: session.user || undefined,
        model: session.model || undefined,
        startTime: session.startTime.getTime(),
        interactions: session.interactions ? JSON.parse(session.interactions) : []
    };
}

export async function getSession(taskId: string): Promise<SessionData | null> {
    const session = await db.findSessionByTaskId(taskId);
    if (!session) return null;
    
    return {
        taskId: session.taskId,
        label: session.label || undefined,
        query: session.query || undefined,
        user: session.user || undefined,
        model: session.model || undefined,
        startTime: session.startTime.getTime(),
        interactions: session.interactions ? JSON.parse(session.interactions) : []
    };
}
