import type { Metadata } from "next";

import { PRODUCT_THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme-preference";

import "./globals.css";

export const metadata: Metadata = {
  title: "Apply Pilot",
  description: "AI-assisted job discovery and controlled application workflows that keep you in control."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: PRODUCT_THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
