'use client';

import { AppSidebar } from '@/components/shell/AppSidebar';
import { useSidebar } from '@/lib/client/sidebar-context';

export default function MainLayout({ children }: { children: React.ReactNode }) {
    const { isCollapsed } = useSidebar();
    
    return (
        <div style={{ display: 'flex', height: '100vh', background: 'var(--background)', overflow: 'hidden' }}>
            <AppSidebar />
            <main style={{ 
                flex: 1, 
                minWidth: 0, 
                height: '100%',
                display: 'flex', 
                flexDirection: 'column',
                transition: 'margin-left 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                background: 'var(--background)',
                overflow: 'hidden'
            }}>
                {children}
            </main>
        </div>
    );
}
