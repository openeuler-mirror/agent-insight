/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
