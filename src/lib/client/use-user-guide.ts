'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '@/lib/client/api';

interface GuideState {
    id: string;
    user: string;
    guideDisabled: boolean;
    currentStep: number;
    completedSteps: string[];
    skippedSteps: string[];
    lastShownAt: string | null;
    dismissedAt: string | null;
}

export function useUserGuide(user: string | null) {
    const [guideState, setGuideState] = useState<GuideState | null>(null);
    const [loading, setLoading] = useState(true);
    const [shouldShowGuide, setShouldShowGuide] = useState(false);

    const fetchGuideState = useCallback(async () => {
        if (!user) {
            setLoading(false);
            return;
        }

        try {
            const res = await apiFetch('/api/guide', {
                headers: {
                    'x-user-id': user,
                },
            });

            if (res.ok) {
                const data = await res.json();
                const parsedState: GuideState = {
                    ...data,
                    completedSteps: JSON.parse(data.completedSteps || '[]'),
                    skippedSteps: JSON.parse(data.skippedSteps || '[]'),
                };
                setGuideState(parsedState);

                const isDisabled = data.guideDisabled;
                const hasDismissedToday = data.dismissedAt && 
                    new Date(data.dismissedAt).toDateString() === new Date().toDateString();
                
                setShouldShowGuide(!isDisabled && !hasDismissedToday);
            }
        } catch (error) {
            console.error('Failed to fetch guide state:', error);
        } finally {
            setLoading(false);
        }
    }, [user]);

    useEffect(() => {
        fetchGuideState();
    }, [fetchGuideState]);

    const updateGuideState = useCallback(async (updates: Partial<GuideState>) => {
        if (!user) return;

        try {
            const res = await apiFetch('/api/guide', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-user-id': user,
                },
                body: JSON.stringify(updates),
            });

            if (res.ok) {
                const data = await res.json();
                const parsedState: GuideState = {
                    ...data,
                    completedSteps: JSON.parse(data.completedSteps || '[]'),
                    skippedSteps: JSON.parse(data.skippedSteps || '[]'),
                };
                setGuideState(parsedState);
                return parsedState;
            }
        } catch (error) {
            console.error('Failed to update guide state:', error);
        }
    }, [user]);

    const markStepCompleted = useCallback(async (stepId: string) => {
        if (!guideState) return;
        
        const completedSteps = [...new Set([...guideState.completedSteps, stepId])];
        await updateGuideState({ completedSteps });
    }, [guideState, updateGuideState]);

    const markStepSkipped = useCallback(async (stepId: string) => {
        if (!guideState) return;
        
        const skippedSteps = [...new Set([...guideState.skippedSteps, stepId])];
        await updateGuideState({ skippedSteps });
    }, [guideState, updateGuideState]);

    const disableGuide = useCallback(async () => {
        await updateGuideState({ guideDisabled: true });
        setShouldShowGuide(false);
    }, [updateGuideState]);

    const enableGuide = useCallback(async () => {
        await updateGuideState({ 
            guideDisabled: false,
            dismissedAt: null 
        });
        setShouldShowGuide(true);
    }, [updateGuideState]);

    const dismissForToday = useCallback(async () => {
        await updateGuideState({ dismissedAt: new Date().toISOString() });
        setShouldShowGuide(false);
    }, [updateGuideState]);

    const resetGuide = useCallback(async () => {
        await updateGuideState({
            currentStep: 0,
            completedSteps: [],
            skippedSteps: [],
            guideDisabled: false,
            dismissedAt: null,
        });
        setShouldShowGuide(true);
    }, [updateGuideState]);

    const setCurrentStep = useCallback(async (step: number) => {
        await updateGuideState({ currentStep: step });
    }, [updateGuideState]);

    return {
        guideState,
        loading,
        shouldShowGuide,
        setShouldShowGuide,
        markStepCompleted,
        markStepSkipped,
        disableGuide,
        enableGuide,
        dismissForToday,
        resetGuide,
        setCurrentStep,
        refresh: fetchGuideState,
    };
}
