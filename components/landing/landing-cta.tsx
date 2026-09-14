import Link from "next/link";

export function LandingCta() {
  return (
    <section className="landing-cta" aria-labelledby="cta-title">
      <div className="public-container landing-cta-inner">
        <h2 id="cta-title">Take control of<br />your job search.</h2>
        <p>Build a more focused, evidence-backed job search with AI assistance that keeps every application decision yours.</p>
        <div>
          <Link className="public-button public-button-primary" href="/signup">Sign up</Link>
          <a className="public-button public-button-secondary" href="#how-it-works">See how it works</a>
        </div>
      </div>
    </section>
  );
}
