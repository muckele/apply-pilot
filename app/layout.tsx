import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Apply Pilot",
  description: "AI-assisted job discovery and controlled application workflows that keep you in control."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
