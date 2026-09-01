import { LandingCta } from "@/components/landing/landing-cta";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingHeader } from "@/components/landing/landing-header";
import { LandingHero } from "@/components/landing/landing-hero";
import { PrecisionSection } from "@/components/landing/precision-section";
import { ProductShowcase } from "@/components/landing/product-showcase";
import { SafetySection } from "@/components/landing/safety-section";
import { WorkflowSection } from "@/components/landing/workflow-section";

export function LandingPage() {
  return (
    <>
      <LandingHeader />
      <main id="public-main">
        <LandingHero />
        <WorkflowSection />
        <ProductShowcase />
        <SafetySection />
        <PrecisionSection />
        <LandingCta />
      </main>
      <LandingFooter />
    </>
  );
}
