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
