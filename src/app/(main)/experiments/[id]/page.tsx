'use client';

import { use } from 'react';

import { ExperimentDetail } from '@/components/eval/ExperimentDetail';

export default function ExperimentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ExperimentDetail id={id} />;
}
