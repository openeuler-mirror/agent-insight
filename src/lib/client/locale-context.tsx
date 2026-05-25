'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { Locale, locales, TranslationDict } from '@/locales';

interface LocaleContextType {
    locale: Locale;
    setLocale: (locale: Locale) => void;
    toggleLocale: () => void;
    t: (key: string, params?: Record<string, string>) => string;
}

const LocaleContext = createContext<LocaleContextType | undefined>(undefined);

const STORAGE_KEY = 'skill-insight-locale';

function getNestedValue(obj: TranslationDict, path: string): string | undefined {
    const keys = path.split('.');
    let result: any = obj;
    for (const key of keys) {
        if (result && typeof result === 'object' && key in result) {
            result = result[key];
        } else {
            return undefined;
        }
    }
    return typeof result === 'string' ? result : undefined;
}

function interpolate(template: string, params?: Record<string, string>): string {
    if (!params) return template;
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => params[key] || `{{${key}}}`);
}

export function LocaleProvider({ children }: { children: ReactNode }) {
    const [locale, setLocaleState] = useState<Locale>('zh');
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        const saved = localStorage.getItem(STORAGE_KEY) as Locale;
        if (saved === 'en' || saved === 'zh') {
            setLocaleState(saved);
        }
        setMounted(true);
    }, []);

    useEffect(() => {
        if (mounted) {
            localStorage.setItem(STORAGE_KEY, locale);
        }
    }, [locale, mounted]);

    const setLocale = (newLocale: Locale) => {
        setLocaleState(newLocale);
    };

    const toggleLocale = () => {
        setLocaleState(prev => prev === 'zh' ? 'en' : 'zh');
    };

    const t = (key: string, params?: Record<string, string>): string => {
        const dict = locales[locale];
        const value = getNestedValue(dict, key);
        if (value === undefined) {
            console.warn(`Translation missing for key: ${key}`);
            return key;
        }
        return interpolate(value, params);
    };

    return (
        <LocaleContext.Provider value={{ locale, setLocale, toggleLocale, t }}>
            {children}
        </LocaleContext.Provider>
    );
}

export function useLocale() {
    const context = useContext(LocaleContext);
    if (context === undefined) {
        throw new Error('useLocale must be used within a LocaleProvider');
    }
    return context;
}