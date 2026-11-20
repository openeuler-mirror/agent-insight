import { redirect } from 'next/navigation';

export default async function Page({ searchParams }: {
    searchParams: Promise<{ taskId?: string }>;
}) {
    const { taskId } = await searchParams;
    redirect(taskId ? '/trace?taskId=' + encodeURIComponent(taskId) : '/trace');
}
