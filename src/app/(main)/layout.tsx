'use client';

import { AppSidebar } from '@/components/shell/AppSidebar';
import { useSidebar } from '@/lib/client/sidebar-context';
import {usePathname} from 'next/navigation';
import Link from 'next/link';
import {isDemoPath} from '@/lib/evaluation-harness/demo-profile';

export default function MainLayout({ children }: { children: React.ReactNode }) {
    const { isCollapsed } = useSidebar();
    const path=usePathname()||'/dashboard';
    
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
                {isDemoPath(path)?children:<div className="p-8 space-y-3"><h1 className="text-lg font-semibold">此功能未纳入本次演示</h1><Link href="/experiments" className="ai-btn-s">返回实验</Link></div>}
            </main>
        </div>
    );
}
