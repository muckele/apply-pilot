import { BriefcaseBusiness, MapPin, ShieldCheck } from "lucide-react";
import Link from "next/link";

import { AccessDeniedNotice } from "@/components/public-auth/access-denied-notice";
import { AuthRunway } from "@/components/public-auth/auth-runway";
import { PublicBrand } from "@/components/public-brand";

type PublicAuthPageProps = {
  mode: "signup" | "login";
  authState: "available" | "denied" | "unavailable";
  googleAction?: React.ReactNode;
  deniedAction?: React.ReactNode;
};

const copy = {
  signup: {
    heading: "Your next opportunity starts here.",
    supporting: "Create your Apply Pilot account and build a more focused, evidence-backed job search.",
    cardHeading: "Create your account.",
    cardCopy: "Continue with Google to start using Apply Pilot.",
    prompt: "Already have an account?",
    linkLabel: "Sign in",
    linkHref: "/login"
  },
  login: {
    heading: "Welcome back.",
    supporting: "Continue your job search with Apply Pilot.",
    cardHeading: "Sign in to Apply Pilot.",
    cardCopy: "Continue with Google to return to your workspace.",
    prompt: "New to Apply Pilot?",
    linkLabel: "Sign up",
    linkHref: "/signup"
  }
} as const;

function AuthOpportunity() {
  return (
    <div className="auth-opportunity" aria-label="Illustrative opportunity ready for review">
      <BriefcaseBusiness aria-hidden="true" />
      <div><strong>Northstar Labs</strong><span>Product Operations Lead</span><p><MapPin aria-hidden="true" /> Remote · Full-time · <em>Ready for review</em></p></div>
      <div><span>FIT SCORE</span><strong>86</strong><em>Strong fit</em></div>
    </div>
  );
}

export function PublicAuthPage({ mode, authState, googleAction, deniedAction }: PublicAuthPageProps) {
  const content = copy[mode];

  return (
    <div className={`public-auth-page public-auth-${mode}`}>
      <header className="public-auth-header public-container">
        <PublicBrand />
        <Link href={content.linkHref}>{content.linkLabel}</Link>
      </header>
      <main id="public-main" className="public-auth-main public-container">
        <section className="public-auth-story" aria-labelledby="auth-title">
          <h1 id="auth-title">{content.heading}</h1>
          <p>{content.supporting}</p>
          <AuthRunway />
          {mode === "signup" ? <AuthOpportunity /> : <div className="auth-runway-floor" aria-hidden="true" />}
        </section>
        <section className="public-auth-card" aria-labelledby="auth-card-title">
          <div className="public-auth-card-content">
            <h2 id="auth-card-title">{content.cardHeading}</h2>
            <p>{content.cardCopy}</p>
            {authState === "available" ? googleAction : null}
            {authState === "unavailable" ? (
              <div className="public-auth-unavailable" role="status">
                <ShieldCheck aria-hidden="true" />
                <span><strong>Google sign-in is temporarily unavailable.</strong><small>Please try again later.</small></span>
              </div>
            ) : null}
            <div className="public-auth-alternate"><span>{content.prompt}</span> <Link href={content.linkHref}>{content.linkLabel}</Link></div>
            <div className="public-auth-note"><ShieldCheck aria-hidden="true" /><p>Google is used for account access. Gmail permissions are separate and are not requested here.</p></div>
          </div>
          {authState === "denied" ? <AccessDeniedNotice action={deniedAction} /> : null}
        </section>
      </main>
    </div>
  );
}
