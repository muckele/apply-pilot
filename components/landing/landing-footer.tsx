import Link from "next/link";

import { PublicBrand } from "@/components/public-brand";

const footerLinks = [
  ["Product", "#product"],
  ["How it works", "#how-it-works"],
  ["Why Apply Pilot", "#why-apply-pilot"],
  ["Safety", "#safety"]
] as const;

export function LandingFooter() {
  return (
    <footer className="landing-footer">
      <div className="public-container landing-footer-grid">
        <div><PublicBrand compact /><p>AI-assisted job search with human control.</p></div>
        <nav aria-label="Footer navigation">
          {footerLinks.map(([label, href]) => <a key={href} href={href}>{label}</a>)}
        </nav>
        <div className="landing-footer-auth"><Link href="/login">Sign in</Link><Link href="/signup">Sign up</Link></div>
        <p className="landing-footer-copyright">© 2026 Apply Pilot</p>
      </div>
    </footer>
  );
}
