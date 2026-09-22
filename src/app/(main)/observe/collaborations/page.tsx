import { Suspense } from 'react';
import CollaborationExplorer from '@/components/observe/CollaborationExplorer';
export default function Page() {
    return <Suspense fallback={<div className="p-6">加载协作图…</div>}><CollaborationExplorer /></Suspense>;
}
