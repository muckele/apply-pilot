import { Menu } from "lucide-react";
import Link from "next/link";

import { PublicBrand } from "@/components/public-brand";

const navigation = [
  { label: "Product", href: "#product" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Why Apply Pilot", href: "#why-apply-pilot" },
  { label: "Safety", href: "#safety" }
] as const;

export function LandingHeader() {
  return (
    <header className="public-header">
      <div className="public-container public-header-inner">
        <PublicBrand />
        <nav className="public-desktop-nav" aria-label="Primary navigation">
          {navigation.map((item) => (
            <a key={item.href} href={item.href}>{item.label}</a>
          ))}
        </nav>
        <div className="public-header-actions">
          <Link className="public-sign-in" href="/login">Sign in</Link>
          <Link className="public-button public-button-primary public-header-signup" href="/signup">Sign up</Link>
          <details className="public-mobile-nav">
            <summary aria-label="Open navigation menu">
              <Menu aria-hidden="true" />
            </summary>
            <nav aria-label="Mobile navigation">
              {navigation.map((item) => (
                <a key={item.href} href={item.href}>{item.label}</a>
              ))}
              <Link href="/login">Sign in</Link>
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
