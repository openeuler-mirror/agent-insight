'use client';

import { createPortal } from 'react-dom';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useTheme, useThemeColors } from '@/lib/client/theme-context';
import { useLocale } from '@/lib/client/locale-context';

export interface GuideStep {
    id: string;
    target: string;
    title: string;
    content: string;
    position: 'top' | 'bottom' | 'left' | 'right' | 'center';
    action?: () => void;
    actionLabel?: string;
    linkUrl?: string;
    linkText?: string;
    setupCommands?: {
        linux: string;
        windows: string;
    };
    apiKey?: string;
}

interface GuideBubbleProps {
    step: GuideStep;
    currentStep: number;
    totalSteps: number;
    onNext: () => void;
    onPrev: () => void;
    onSkip: () => void;
    onDismiss: () => void;
    onDontShowAgain: () => void;
    isVisible: boolean;
}

interface PositionState {
    top: number;
    left: number;
}

interface ArrowPositionState {
    top: number;
    left: number;
}

function GuideBubble({
    step,
    currentStep,
    totalSteps,
    onNext,
    onPrev,
    onSkip,
    onDismiss,
    onDontShowAgain,
    isVisible
}: GuideBubbleProps) {
    const [position, setPosition] = useState<PositionState>({ top: 0, left: 0 });
    const [arrowPosition, setArrowPosition] = useState<ArrowPositionState>({ top: 0, left: 0 });
    const bubbleRef = useRef<HTMLDivElement>(null);
    const mounted = typeof window !== 'undefined';
    const { isDark } = useTheme();
    const { t } = useLocale();
    const c = useThemeColors();


    const handleCopy = (text: string) => {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(text).then(() => {
                alert(t('common.copySuccess'));
            }).catch(() => {
                alert(t('common.copyFailed'));
            });
        } else {
            const textArea = document.createElement("textarea");
            textArea.value = text;
            textArea.style.position = "fixed";
            textArea.style.left = "-9999px";
            textArea.style.top = "0";
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();
            try {
                document.execCommand('copy');
                alert(t('common.copySuccess'));
            } catch (err) {
                console.error('Fallback: Fallback: Oops, unable to copy', err);
                alert(t('common.copyFailed'));
            }
            document.body.removeChild(textArea);
        }
    };

    const calculatePosition = useCallback(() => {
        if (step.position === 'center') {
            if (!bubbleRef.current) return;
            const bubbleRect = bubbleRef.current.getBoundingClientRect();
            setPosition({
                top: (window.innerHeight - bubbleRect.height) / 2,
                left: (window.innerWidth - bubbleRect.width) / 2,
            });
            setArrowPosition({ top: 0, left: 0 });
            return;
        }

        const targetElement = document.querySelector(step.target);
        if (!targetElement || !bubbleRef.current) return;

        const targetRect = targetElement.getBoundingClientRect();
        const bubbleRect = bubbleRef.current.getBoundingClientRect();
        const padding = 12;
        const arrowSize = 8;

        let top = 0;
        let left = 0;
        let arrowTop = 0;
        let arrowLeft = 0;

        const targetCenterX = targetRect.left + targetRect.width / 2;
        const targetCenterY = targetRect.top + targetRect.height / 2;

        switch (step.position) {
            case 'top':
                top = targetRect.top - bubbleRect.height - padding;
                left = targetCenterX - bubbleRect.width / 2;
                break;
            case 'bottom':
                top = targetRect.bottom + padding;
                left = targetCenterX - bubbleRect.width / 2;
                break;
            case 'left':
                top = targetCenterY - bubbleRect.height / 2;
                left = targetRect.left - bubbleRect.width - padding;
                break;
            case 'right':
                top = targetCenterY - bubbleRect.height / 2;
                left = targetRect.right + padding;
                break;
        }

        if (left < 10) left = 10;
        if (left + bubbleRect.width > window.innerWidth - 10) {
            left = window.innerWidth - bubbleRect.width - 10;
        }
        if (top < 10) top = 10;
        if (top + bubbleRect.height > window.innerHeight - 10) {
            top = window.innerHeight - bubbleRect.height - 10;
        }

        switch (step.position) {
            case 'top':
            case 'bottom':
                arrowLeft = targetCenterX - left - arrowSize;
                arrowTop = step.position === 'top' ? bubbleRect.height - arrowSize : -arrowSize;
                break;
            case 'left':
            case 'right':
                arrowTop = targetCenterY - top - arrowSize;
                arrowLeft = step.position === 'left' ? bubbleRect.width - arrowSize : -arrowSize;
                break;
        }

        setPosition({ top, left });
        setArrowPosition({ top: arrowTop, left: arrowLeft });
    }, [step]);

    useEffect(() => {
        if (isVisible) {
            const timer = requestAnimationFrame(() => {
                calculatePosition();
            });
            window.addEventListener('resize', calculatePosition);
            window.addEventListener('scroll', calculatePosition, true);
            return () => {
                cancelAnimationFrame(timer);
                window.removeEventListener('resize', calculatePosition);
                window.removeEventListener('scroll', calculatePosition, true);
            };
        }
    }, [isVisible, calculatePosition]);

    if (!mounted || !isVisible) return null;

    const getArrowStyle = () => {
        if (step.position === 'center') return null;

        const baseStyle: React.CSSProperties = {
            position: 'absolute',
            width: 0,
            height: 0,
            borderStyle: 'solid',
        };

        switch (step.position) {
            case 'top':
                return {
                    ...baseStyle,
                    top: arrowPosition.top,
                    left: arrowPosition.left,
                    borderWidth: '8px 8px 0 8px',
                    borderColor: '#1e293b transparent transparent transparent',
                };
            case 'bottom':
                return {
                    ...baseStyle,
                    top: arrowPosition.top,
                    left: arrowPosition.left,
                    borderWidth: '0 8px 8px 8px',
                    borderColor: 'transparent transparent #1e293b transparent',
                };
            case 'left':
                return {
                    ...baseStyle,
                    top: arrowPosition.top,
                    left: arrowPosition.left,
                    borderWidth: '8px 0 8px 8px',
                    borderColor: 'transparent transparent transparent #1e293b',
                };
            case 'right':
                return {
                    ...baseStyle,
                    top: arrowPosition.top,
                    left: arrowPosition.left,
                    borderWidth: '8px 8px 8px 0',
                    borderColor: 'transparent #1e293b transparent transparent',
                };
            default:
                return null;
        }
    };

    const isCenter = step.position === 'center';

    return createPortal(
        <>
            <div
                style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'rgba(0, 0, 0, 0.5)',
                    zIndex: 9998,
                    pointerEvents: 'auto',
                }}
                onClick={onDismiss}
            />
            <div
                ref={bubbleRef}
                style={{
                    position: 'fixed',
                    top: position.top,
                    left: position.left,
                    background: isCenter ? `linear-gradient(135deg, ${c.bgSecondary} 0%, ${c.bg} 100%)` : c.bgSecondary,
                    border: `1px solid ${c.primary}`,
                    borderRadius: isCenter ? '16px' : '12px',
                    padding: isCenter ? '32px 40px' : '20px',
                    maxWidth: isCenter ? '480px' : '360px',
                    minWidth: isCenter ? '320px' : '280px',
                    zIndex: 9999,
                    boxShadow: isCenter
                        ? `0 25px 50px ${c.overlayBg}, 0 0 40px ${c.primarySubtleBorder}`
                        : `0 20px 40px ${c.overlayBg}, 0 0 20px ${c.primarySubtle}`,
                    animation: 'fadeInScale 0.3s ease-out',
                    textAlign: isCenter ? 'center' : 'left',
                }}
            >
                {!isCenter && <div style={getArrowStyle() || {}} />}

                {isCenter && (
                    <div style={{ fontSize: '3rem', marginBottom: '16px' }}>👋</div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                    <h3 style={{
                        margin: 0,
                        color: c.primary,
                        fontSize: isCenter ? '1.4rem' : '1.1rem',
                        fontWeight: 600,
                        width: '100%',
                    }}>
                        {step.title}
                    </h3>
                    <button
                        onClick={onDismiss}
                        style={{
                            background: 'transparent',
                            border: 'none',
                            color: c.fgMuted,
                            cursor: 'pointer',
                            fontSize: '1.2rem',
                            padding: '0',
                            lineHeight: 1,
                        }}
                    >
                        ✕
                    </button>
                </div>

                <p style={{ margin: '0 0 16px 0', color: c.fg, fontSize: '0.9rem', lineHeight: 1.6 }}>
                    {step.content}
                </p>

                {step.linkUrl && step.linkText && (
                    <div style={{ marginBottom: '16px' }}>
                        <a
                            href={step.linkUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{
                                color: c.primary,
                                textDecoration: 'none',
                                                               fontSize: '0.9rem',
                                fontWeight: 500,
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '6px',
                                padding: '8px 16px',
                                background: 'rgba(56, 189, 248, 0.1)',
                                borderRadius: '6px',
                                border: '1px solid rgba(56, 189, 248, 0.3)',
                                transition: 'all 0.2s',
                            }}
                            onClick={(e) => e.stopPropagation()}
                        >
                            {step.linkText}
                            <span style={{ fontSize: '0.8rem' }}>↗</span>
                        </a>
                    </div>
                )}

                {step.setupCommands && (
                    <div style={{ marginBottom: '16px', textAlign: 'left' }}>
                        <div style={{
                            color: c.fgMuted,
                            fontSize: '0.85rem',
                            marginBottom: '12px',
                            lineHeight: 1.5
                        }}>
                            {t('guide.setup.description')}
                        </div>

                        <div style={{ marginBottom: '10px' }}>
                            <div style={{
                                color: c.primary,
                                fontSize: '0.85rem',
                                fontWeight: 600,
                                marginBottom: '6px',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px'
                            }}>
                                <span>🐧</span>
                                <span>Linux / macOS</span>
                            </div>
                            <div style={{
                                background: c.bg,
                                border: `1px solid ${c.border}`,
                                borderRadius: '6px',
                                padding: '10px',
                                position: 'relative'
                            }}>
                                <code style={{
                                    color: c.fg,
                                    fontSize: '0.8rem',
                                    fontFamily: 'monospace',
                                    wordBreak: 'break-all',
                                    display: 'block',
                                    paddingRight: '40px'
                                }}>
                                    {step.setupCommands.linux}
                                </code>
                                <button
                                    onClick={() => {
                                        handleCopy(step.setupCommands!.linux);
                                    }}
                                    style={{
                                        position: 'absolute',
                                        top: '8px',
                                        right: '8px',
                                        background: 'rgba(56, 189, 248, 0.2)',
                                        border: '1px solid rgba(56, 189, 248, 0.4)',
                                        color: c.primary,
                                        padding: '4px 8px',
                                        borderRadius: '4px',
                                        cursor: 'pointer',
                                        fontSize: '0.75rem',
                                        fontWeight: 500,
                                        transition: 'all 0.2s',
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.background = 'rgba(56, 189, 248, 0.3)';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.background = 'rgba(56, 189, 248, 0.2)';
                                    }}
                                >
                                    {t('guide.buttons.copy')}
                                </button>
                            </div>
                        </div>

                        <div>
                            <div style={{
                                color: c.primary,
                                fontSize: '0.85rem',
                                fontWeight: 600,
                                marginBottom: '6px',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '6px'
                            }}>
                                <span>🪟</span>
                                <span>Windows</span>
                            </div>
                            <div style={{
                                background: c.bg,
                                border: `1px solid ${c.border}`,
                                borderRadius: '6px',
                                padding: '10px',
                                position: 'relative'
                            }}>
                                <code style={{
                                    color: c.fg,
                                    fontSize: '0.8rem',
                                    fontFamily: 'monospace',
                                    wordBreak: 'break-all',
                                    display: 'block',
                                    paddingRight: '40px'
                                }}>
                                    {step.setupCommands.windows}
                                </code>
                                <button
                                    onClick={() => {
                                        handleCopy(step.setupCommands!.windows);
                                    }}
                                    style={{
                                        position: 'absolute',
                                        top: '8px',
                                        right: '8px',
                                        background: 'rgba(56, 189, 248, 0.2)',
                                        border: '1px solid rgba(56, 189, 248, 0.4)',
                                        color: c.primary,
                                        padding: '4px 8px',
                                        borderRadius: '4px',
                                        cursor: 'pointer',
                                        fontSize: '0.75rem',
                                        fontWeight: 500,
                                        transition: 'all 0.2s',
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.background = 'rgba(56, 189, 248, 0.3)';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.background = 'rgba(56, 189, 248, 0.2)';
                                    }}
                                >
                                    {t('guide.buttons.copy')}
                                </button>
                            </div>
                        </div>

                        {step.apiKey && (
                            <div style={{
                                background: 'rgba(56, 189, 248, 0.1)',
                                border: '1px solid rgba(56, 189, 248, 0.3)',
                                borderRadius: '6px',
                                padding: '10px',
                                marginTop: '12px'
                            }}>
                                <div style={{
                                    color: c.primary,
                                    fontSize: '0.85rem',
                                    fontWeight: 600,
                                    marginBottom: '6px'
                                }}>
                                    {t('guide.setup.yourApiKey')}
                                </div>
                                <div style={{
                                    position: 'relative'
                                }}>
                                    <div style={{
                                        color: c.fg,
                                        fontSize: '0.8rem',
                                        fontFamily: 'monospace',
                                        wordBreak: 'break-all',
                                        marginBottom: '6px',
                                        paddingRight: '50px'
                                    }}>
                                        {step.apiKey}
                                    </div>
                                    <button
                                        onClick={() => {
                                            handleCopy(step.apiKey!);
                                        }}
                                        style={{
                                            position: 'absolute',
                                            top: '0',
                                            right: '0',
                                            background: 'rgba(56, 189, 248, 0.2)',
                                            border: '1px solid rgba(56, 189, 248, 0.4)',
                                            color: c.primary,
                                            padding: '4px 8px',
                                            borderRadius: '4px',
                                            cursor: 'pointer',
                                            fontSize: '0.75rem',
                                            fontWeight: 500,
                                            transition: 'all 0.2s',
                                        }}
                                        onMouseEnter={(e) => {
                                            e.currentTarget.style.background = 'rgba(56, 189, 248, 0.3)';
                                        }}
                                        onMouseLeave={(e) => {
                                            e.currentTarget.style.background = 'rgba(56, 189, 248, 0.2)';
                                        }}
                                    >
                                        复制
                                    </button>
                                </div>
                                <div style={{
                                    color: c.fgMuted,
                                    fontSize: '0.75rem',
                                    lineHeight: 1.4
                                }}>
                                    {t('guide.setup.apiKeyHint')}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px', gap: '8px' }}>
                    {Array.from({ length: totalSteps }).map((_, i) => (
                        <div
                            key={i}
                            style={{
                                width: '8px',
                                height: '8px',
                                borderRadius: '50%',
                                background: i === currentStep ? '#38bdf8' : '#52525b',
                                transition: 'background 0.2s',
                            }}
                        />
                    ))}
                    <span style={{ marginLeft: 'auto', color: c.fgMuted, fontSize: '0.8rem' }}>
                        {currentStep + 1} / {totalSteps}
                    </span>
                </div>

                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {currentStep > 0 && (
                        <button
                            onClick={onPrev}
                            style={{
                                background: 'transparent',
                                border: '1px solid #52525b',
                                color: c.fgMuted,
                                padding: '8px 16px',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontSize: '0.85rem',
                            }}
                        >
                            {t('guide.buttons.prev')}
                        </button>
                    )}

                    {step.action && step.actionLabel && (
                        <button
                            onClick={() => {
                                step.action?.();
                                onNext();
                            }}
                            style={{
                                background: c.primary,
                                border: 'none',
                                color: c.bg,
                                padding: '8px 16px',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontSize: '0.85rem',
                                fontWeight: 600,
                            }}
                        >
                            {step.actionLabel}
                        </button>
                    )}

                    {currentStep < totalSteps - 1 ? (
                        <button
                            onClick={onNext}
                            style={{
                                background: c.primary,
                                border: 'none',
                                color: c.bg,
                                padding: '8px 16px',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontSize: '0.85rem',
                                fontWeight: 600,
                            }}
                        >
                            {t('guide.buttons.next')}
                        </button>
                    ) : (
                        <button
                            onClick={onDismiss}
                            style={{
                                background: c.success,
                                border: 'none',
                                color: c.bg,
                                padding: '8px 16px',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontSize: '0.85rem',
                                fontWeight: 600,
                            }}
                        >
                            {t('guide.buttons.done')}
                        </button>
                    )}

                    <button
                        onClick={onSkip}
                        style={{
                            background: 'transparent',
                            border: 'none',
                            color: c.fgMuted,
                            padding: '8px 12px',
                            borderRadius: '6px',
                            cursor: 'pointer',
                            fontSize: '0.8rem',
                        }}
                    >
                        {t('guide.buttons.skip')}
                    </button>
                </div>

                <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: `1px solid ${c.border}` }}>
                    <label style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        color: c.fgMuted,
                        fontSize: '0.8rem',
                        cursor: 'pointer',
                    }}>
                        <input
                            type="checkbox"
                            onChange={(e) => {
                                if (e.target.checked) {
                                    onDontShowAgain();
                                }
                            }}
                            style={{ accentColor: '#38bdf8' }}
                        />
                        {t('guide.buttons.dontShow')}
                    </label>
                </div>
            </div>

            <style jsx global>{`
                @keyframes fadeInScale {
                    from {
                        opacity: 0;
                        transform: scale(0.9);
                    }
                    to {
                        opacity: 1;
                        transform: scale(1);
                    }
                }
            `}</style>
        </>,
        document.body
    );
}

interface UserGuideProps {
    steps: GuideStep[];
    onComplete: () => void;
    onSkip: (stepId: string) => void;
    onDontShowAgain: () => void;
    startStep?: number;
}

export default function UserGuide({
    steps,
    onComplete,
    onSkip,
    onDontShowAgain,
    startStep = 0
}: UserGuideProps) {
    const [currentStep, setCurrentStep] = useState(startStep);
    const [isVisible, setIsVisible] = useState(true);

    const handleNext = () => {
        if (currentStep < steps.length - 1) {
            setCurrentStep(currentStep + 1);
        } else {
            setIsVisible(false);
            onComplete();
        }
    };

    const handlePrev = () => {
        if (currentStep > 0) {
            setCurrentStep(currentStep - 1);
        }
    };

    const handleSkip = () => {
        onSkip(steps[currentStep].id);
        setIsVisible(false);
        onComplete();
    };

    const handleDismiss = () => {
        setIsVisible(false);
        onComplete();
    };

    if (steps.length === 0 || currentStep >= steps.length) return null;

    return (
        <GuideBubble
            step={steps[currentStep]}
            currentStep={currentStep}
            totalSteps={steps.length}
            onNext={handleNext}
            onPrev={handlePrev}
            onSkip={handleSkip}
            onDismiss={handleDismiss}
            onDontShowAgain={onDontShowAgain}
            isVisible={isVisible}
        />
    );
}

export { GuideBubble };
