import Link from "next/link";

import { ProductPreview } from "@/components/landing/product-preview";

export function LandingHero() {
  return (
    <section className="public-hero" aria-labelledby="hero-title">
      <div className="public-container public-hero-grid">
        <div className="public-hero-copy">
          <h1 id="hero-title">Apply smarter.<br />Stay in control.</h1>
          <p>
            Turn a fragmented job search into one intelligent workflow—from finding the right
            opportunities to preparing stronger applications while staying in control of what
            employers receive.
          </p>
          <div className="public-hero-actions">
            <Link className="public-button public-button-primary" href="/signup">Sign up</Link>
            <a className="public-button public-button-secondary" href="#how-it-works">See how it works</a>
          </div>
        </div>
        <ProductPreview />
      </div>
    </section>
  );
}
