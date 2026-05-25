'use client';

import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { AuthProvider } from '@/lib/auth/auth-context';
import { ThemeProvider } from '@/lib/client/theme-context';
import { LocaleProvider } from '@/lib/client/locale-context';
import { SidebarProvider } from '@/lib/client/sidebar-context';
import { Toaster } from '@/components/ui/sonner';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <NuqsAdapter>
      <ThemeProvider>
        <LocaleProvider>
          <AuthProvider>
            <SidebarProvider>
              {children}
              <Toaster />
            </SidebarProvider>
          </AuthProvider>
        </LocaleProvider>
      </ThemeProvider>
    </NuqsAdapter>
  );
}
