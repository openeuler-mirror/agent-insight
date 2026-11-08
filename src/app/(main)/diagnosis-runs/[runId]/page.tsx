import { redirect } from 'next/navigation';

export default async function DiagnosisRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  redirect(`/fault?runId=${encodeURIComponent(runId)}`);
}
