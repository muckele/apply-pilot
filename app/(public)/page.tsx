import type { Metadata } from "next";

import { LandingPage } from "@/components/landing/landing-page";

export const metadata: Metadata = {
  title: "Apply Pilot — AI-Assisted Job Search With Human Control",
  description:
    "Discover relevant opportunities, evaluate fit, and prepare evidence-backed applications while keeping every final submission decision yours."
};

export default function HomePage() {
  return <LandingPage />;
}
