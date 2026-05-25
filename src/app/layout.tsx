import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/components/shell/providers";

// 注:之前用 next/font/google 加载 Inter,内网/国内服务器跑 build 时
// 连不上 Google Fonts 会导致 build 失败。改成依赖 CSS fallback 字体栈
// (globals.css 里 --font-sans 已经有 -apple-system / Segoe UI 等系统字体)。
// 用户如果想用 Inter,可以在系统层面装一下,浏览器会自动用本地的。
// 视觉差异极小,Inter 跟 macOS 系统字体几乎像。

export const metadata: Metadata = {
  title: "Agent-insight",
  description: "Agent 全生命周期可观测、评估、归因与优化平台",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Providers>
          {children}
        </Providers>
      </body>
    </html>
  );
}
