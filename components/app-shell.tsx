import { Menu } from "lucide-react";

import { AuthMenu } from "@/components/auth-menu";
import { ApplyPilotLogo } from "@/components/brand/apply-pilot-logo";
import { ProductNav } from "@/components/product-nav";

export async function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="product-shell min-h-screen" data-app-shell>
      <a className="product-skip-link" href="#product-main">
        Skip to content
      </a>
      <aside className="product-sidebar fixed inset-y-0 left-0 hidden w-64 border-r border-white/10 lg:block">
        <div className="flex h-16 items-center gap-3 border-b border-white/10 px-6">
          <ApplyPilotLogo subtitle="Human-in-the-loop" tone="dark" />
        </div>
        <ProductNav className="max-h-[calc(100vh-18rem)] overflow-y-auto px-3 py-5" />
        <div className="absolute inset-x-4 bottom-44">
          <AuthMenu tone="dark" />
        </div>
        <div className="absolute inset-x-4 bottom-4 rounded-xl border border-brand-500/30 bg-white/[0.04] p-4 text-xs text-brand-100">
          <p className="font-semibold text-brand-300">Safety rules active</p>
          <p className="mt-1 leading-5 text-[#aeb9b5]">
            No auto-apply, no prohibited scraping, no automatic email sending, and no recording without consent.
          </p>
        </div>
      </aside>
      <div className="lg:pl-64">
        <header className="product-mobile-header sticky top-0 z-20 border-b border-white/10 px-4 py-3 backdrop-blur lg:hidden">
          <div className="flex items-center justify-between gap-3">
            <ApplyPilotLogo className="gap-2" markClassName="h-7 w-7" tone="dark" />
            <div className="flex items-center gap-2">
              <AuthMenu tone="dark" />
              <details className="group relative">
                <summary
                  className="flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-lg border border-white/20 bg-white/[0.04] text-white hover:border-brand-400/60 hover:bg-brand-500/10"
                  aria-label="Open navigation"
                  title="Navigation"
                >
                  <Menu size={18} aria-hidden="true" />
                </summary>
                <ProductNav
                  className="absolute right-0 top-12 max-h-[calc(100vh-5rem)] w-64 overflow-y-auto rounded-xl border border-white/15 bg-[#071411] p-2 shadow-2xl"
                  label="Mobile product navigation"
                />
              </details>
            </div>
          </div>
        </header>
        <main id="product-main" className="product-main mx-auto max-w-7xl px-4 py-7 sm:px-6 sm:py-9 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
