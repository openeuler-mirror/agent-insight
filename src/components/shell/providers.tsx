'use client';

import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { AuthProvider } from '@/lib/auth/auth-context';
import { ThemeProvider } from '@/lib/client/theme-context';
import { LocaleProvider } from '@/lib/client/locale-context';
import { SidebarProvider } from '@/lib/client/sidebar-context';
import { Toaster } from '@/components/ui/sonner';
import { InferenceAnalysisProvider } from '@/lib/client/inference-analysis-context';
import type { InferenceAnalysisConfig } from '@/lib/trace/inference-analysis-link';

export function Providers({ children, inferenceAnalysis = { status: 'unconfigured' } }: { children: React.ReactNode; inferenceAnalysis?: InferenceAnalysisConfig }) {
  return (
    <NuqsAdapter>
      <ThemeProvider>
        <LocaleProvider>
          <AuthProvider>
            <SidebarProvider>
              <InferenceAnalysisProvider config={inferenceAnalysis}>{children}</InferenceAnalysisProvider>
              <Toaster />
            </SidebarProvider>
          </AuthProvider>
        </LocaleProvider>
      </ThemeProvider>
    </NuqsAdapter>
  );
}
