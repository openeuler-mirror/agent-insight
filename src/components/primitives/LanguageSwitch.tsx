'use client';

import { useLocale } from '@/lib/client/locale-context';

export function LanguageSwitch() {
    const { locale, toggleLocale, t } = useLocale();

    return (
        <button
            className="theme-toggle-btn"
            onClick={toggleLocale}
            title={locale === 'zh' ? t('theme.switchToEnglish') : t('theme.switchToChinese')}
            style={{
                fontSize: '0.85rem',
                fontWeight: 600,
                padding: '4px 8px',
                minWidth: '32px',
            }}
        >
            {locale === 'zh' ? 'EN' : '中'}
        </button>
    );
}