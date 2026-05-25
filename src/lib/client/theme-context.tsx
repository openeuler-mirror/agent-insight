'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';

type Theme = 'light' | 'dark';

interface ThemeContextType {
    theme: Theme;
    toggleTheme: () => void;
    isDark: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [theme, setTheme] = useState<Theme>('light');
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        const savedTheme = localStorage.getItem('skill-insight-theme') as Theme;
        if (savedTheme === 'dark' || savedTheme === 'light') {
            setTheme(savedTheme);
        }
        setMounted(true);
    }, []);

    useEffect(() => {
        if (mounted) {
            localStorage.setItem('skill-insight-theme', theme);
            document.documentElement.setAttribute('data-theme', theme);
        }
    }, [theme, mounted]);

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
    }, [theme]);

    const toggleTheme = () => {
        setTheme(prev => prev === 'light' ? 'dark' : 'light');
    };

    return (
        <ThemeContext.Provider value={{ theme, toggleTheme, isDark: theme === 'dark' }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const context = useContext(ThemeContext);
    if (context === undefined) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
}

export interface ThemeColors {
    fg: string;
    fgSecondary: string;
    fgMuted: string;
    primary: string;
    primaryHover: string;
    primaryForeground: string;
    primarySubtle: string;
    primarySubtleBorder: string;
    secondary: string;
    secondaryHover: string;
    accent: string;
    success: string;
    successForeground: string;
    successSubtle: string;
    successSubtleBorder: string;
    warning: string;
    warningForeground: string;
    warningSubtle: string;
    warningSubtleBorder: string;
    error: string;
    errorForeground: string;
    errorSubtle: string;
    errorSubtleBorder: string;
    bg: string;
    bgSecondary: string;
    bgTertiary: string;
    border: string;
    borderDark: string;
    cardBg: string;
    cardBorder: string;
    inputBg: string;
    inputBorder: string;
    tableHeaderBg: string;
    tableBorder: string;
    tableRowBorder: string;
    codeBlockBg: string;
    shadowColor: string;
    shadowColorLg: string;
    ring: string;
    link: string;
    linkHover: string;
    overlayBg: string;
}

const lightColors: ThemeColors = {
    fg: '#18181b',
    fgSecondary: '#52525b',
    fgMuted: '#a1a1aa',
    primary: '#2563eb',
    primaryHover: '#1d4ed8',
    primaryForeground: '#ffffff',
    primarySubtle: 'rgba(37, 99, 235, 0.06)',
    primarySubtleBorder: 'rgba(37, 99, 235, 0.15)',
    secondary: '#7c3aed',
    secondaryHover: '#6d28d9',
    accent: '#db2777',
    success: '#16a34a',
    successForeground: '#ffffff',
    successSubtle: 'rgba(22, 163, 74, 0.06)',
    successSubtleBorder: 'rgba(22, 163, 74, 0.15)',
    warning: '#d97706',
    warningForeground: '#ffffff',
    warningSubtle: 'rgba(217, 119, 6, 0.06)',
    warningSubtleBorder: 'rgba(217, 119, 6, 0.15)',
    error: '#dc2626',
    errorForeground: '#ffffff',
    errorSubtle: 'rgba(220, 38, 38, 0.06)',
    errorSubtleBorder: 'rgba(220, 38, 38, 0.15)',
    bg: '#fafafa',
    bgSecondary: '#f4f4f5',
    bgTertiary: '#e4e4e7',
    border: '#e4e4e7',
    borderDark: '#d4d4d8',
    cardBg: '#ffffff',
    cardBorder: '#e4e4e7',
    inputBg: '#ffffff',
    inputBorder: '#d4d4d8',
    tableHeaderBg: '#f4f4f5',
    tableBorder: '#e4e4e7',
    tableRowBorder: '#f4f4f5',
    codeBlockBg: '#f4f4f5',
    shadowColor: 'rgba(0, 0, 0, 0.04)',
    shadowColorLg: 'rgba(0, 0, 0, 0.08)',
    ring: 'rgba(37, 99, 235, 0.25)',
    link: '#2563eb',
    linkHover: '#1d4ed8',
    overlayBg: 'rgba(0, 0, 0, 0.5)',
};

const darkColors: ThemeColors = {
    fg: '#fafafa',
    fgSecondary: '#a1a1aa',
    fgMuted: '#71717a',
    primary: '#3b82f6',
    primaryHover: '#60a5fa',
    primaryForeground: '#ffffff',
    primarySubtle: 'rgba(59, 130, 246, 0.08)',
    primarySubtleBorder: 'rgba(59, 130, 246, 0.18)',
    secondary: '#818cf8',
    secondaryHover: '#a5b4fc',
    accent: '#f472b6',
    success: '#22c55e',
    successForeground: '#ffffff',
    successSubtle: 'rgba(34, 197, 94, 0.08)',
    successSubtleBorder: 'rgba(34, 197, 94, 0.18)',
    warning: '#f59e0b',
    warningForeground: '#ffffff',
    warningSubtle: 'rgba(245, 158, 11, 0.08)',
    warningSubtleBorder: 'rgba(245, 158, 11, 0.18)',
    error: '#ef4444',
    errorForeground: '#ffffff',
    errorSubtle: 'rgba(239, 68, 68, 0.08)',
    errorSubtleBorder: 'rgba(239, 68, 68, 0.18)',
    bg: '#09090b',
    bgSecondary: '#18181b',
    bgTertiary: '#27272a',
    border: '#27272a',
    borderDark: '#3f3f46',
    cardBg: '#0c0c0e',
    cardBorder: '#27272a',
    inputBg: '#09090b',
    inputBorder: '#27272a',
    tableHeaderBg: '#18181b',
    tableBorder: '#27272a',
    tableRowBorder: '#18181b',
    codeBlockBg: '#18181b',
    shadowColor: 'rgba(0, 0, 0, 0.3)',
    shadowColorLg: 'rgba(0, 0, 0, 0.5)',
    ring: 'rgba(59, 130, 246, 0.35)',
    link: '#60a5fa',
    linkHover: '#93c5fd',
    overlayBg: 'rgba(0, 0, 0, 0.7)',
};

export function useThemeColors(): ThemeColors {
    const { isDark } = useTheme();
    return isDark ? darkColors : lightColors;
}

export const themes = {
    light: {
        background: '#fafafa',
        backgroundSecondary: '#f4f4f5',
        backgroundTertiary: '#e4e4e7',
        foreground: '#18181b',
        foregroundSecondary: '#52525b',
        foregroundMuted: '#a1a1aa',
        cardBg: '#ffffff',
        cardBorder: '#e4e4e7',
        primary: '#2563eb',
        primaryHover: '#1d4ed8',
        primaryForeground: '#ffffff',
        primarySubtle: 'rgba(37, 99, 235, 0.06)',
        primarySubtleBorder: 'rgba(37, 99, 235, 0.15)',
        secondary: '#7c3aed',
        secondaryHover: '#6d28d9',
        accent: '#db2777',
        success: '#16a34a',
        successForeground: '#ffffff',
        successSubtle: 'rgba(22, 163, 74, 0.06)',
        successSubtleBorder: 'rgba(22, 163, 74, 0.15)',
        warning: '#d97706',
        warningForeground: '#ffffff',
        warningSubtle: 'rgba(217, 119, 6, 0.06)',
        warningSubtleBorder: 'rgba(217, 119, 6, 0.15)',
        error: '#dc2626',
        errorForeground: '#ffffff',
        errorSubtle: 'rgba(220, 38, 38, 0.06)',
        errorSubtleBorder: 'rgba(220, 38, 38, 0.15)',
        border: '#e4e4e7',
        borderDark: '#d4d4d8',
        inputBg: '#ffffff',
        inputBorder: '#d4d4d8',
        codeBlockBg: '#f4f4f5',
        tableBorder: '#e4e4e7',
        tableRowBorder: '#f4f4f5',
        tableHeaderBg: '#f4f4f5',
        dropdownBg: '#ffffff',
        dropdownBorder: '#e4e4e7',
        shadowColor: 'rgba(0, 0, 0, 0.04)',
        shadowColorLg: 'rgba(0, 0, 0, 0.08)',
        ring: 'rgba(37, 99, 235, 0.25)',
    },
    dark: {
        background: '#09090b',
        backgroundSecondary: '#18181b',
        backgroundTertiary: '#27272a',
        foreground: '#fafafa',
        foregroundSecondary: '#a1a1aa',
        foregroundMuted: '#71717a',
        cardBg: '#0c0c0e',
        cardBorder: '#27272a',
        primary: '#3b82f6',
        primaryHover: '#60a5fa',
        primaryForeground: '#ffffff',
        primarySubtle: 'rgba(59, 130, 246, 0.08)',
        primarySubtleBorder: 'rgba(59, 130, 246, 0.18)',
        secondary: '#818cf8',
        secondaryHover: '#a5b4fc',
        accent: '#f472b6',
        success: '#22c55e',
        successForeground: '#ffffff',
        successSubtle: 'rgba(34, 197, 94, 0.08)',
        successSubtleBorder: 'rgba(34, 197, 94, 0.18)',
        warning: '#f59e0b',
        warningForeground: '#ffffff',
        warningSubtle: 'rgba(245, 158, 11, 0.08)',
        warningSubtleBorder: 'rgba(245, 158, 11, 0.18)',
        error: '#ef4444',
        errorForeground: '#ffffff',
        errorSubtle: 'rgba(239, 68, 68, 0.08)',
        errorSubtleBorder: 'rgba(239, 68, 68, 0.18)',
        border: '#27272a',
        borderDark: '#3f3f46',
        inputBg: '#09090b',
        inputBorder: '#27272a',
        codeBlockBg: '#18181b',
        tableBorder: '#27272a',
        tableRowBorder: '#18181b',
        tableHeaderBg: '#18181b',
        dropdownBg: '#0c0c0e',
        dropdownBorder: '#27272a',
        shadowColor: 'rgba(0, 0, 0, 0.3)',
        shadowColorLg: 'rgba(0, 0, 0, 0.5)',
        ring: 'rgba(59, 130, 246, 0.35)',
    }
};

export function getThemeColors(theme: Theme) {
    return themes[theme];
}
