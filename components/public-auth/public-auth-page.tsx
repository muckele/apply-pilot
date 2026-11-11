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
  // The sign-in code form. Given only on the way to a browser run's control page, which only
  // the Apply Pilot browser window opens signed out. Google refuses to sign in there, so the
  // page then leads with the code and keeps Google as a secondary choice.
  codeSignIn?: React.ReactNode;
};

const copy = {
  signup: {
    heading: "Your next opportunity starts here.",
    supporting: "Use an approved Google account to organize a more focused job search and review every application detail before use.",
    cardHeading: "Create your account.",
    cardCopy: "Continue with an approved Google account. Access remains subject to this deployment's sign-in policy.",
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
      <div><span>Illustrative Apply Pilot job-fit estimate</span><strong>86</strong><em>Strong fit</em></div>
    </div>
  );
}

function GoogleUnavailableNotice() {
  return (
    <div className="public-auth-unavailable" role="status">
      <ShieldCheck aria-hidden="true" />
      <span><strong>Google sign-in is temporarily unavailable.</strong><small>Please try again later.</small></span>
    </div>
  );
}

function GoogleAccessNote() {
  return (
    <div className="public-auth-note"><ShieldCheck aria-hidden="true" /><p>Google is used for account access. Gmail permissions are separate and are not requested here.</p></div>
  );
}

function CodeFirstAuthPage({
  authState,
  googleAction,
  deniedAction,
  codeSignIn
}: Omit<PublicAuthPageProps, "mode">) {
  return (
    <div className="public-auth-page public-auth-login public-auth-code-first">
      <header className="public-auth-header public-container">
        <PublicBrand />
        <Link href={copy.login.linkHref}>{copy.login.linkLabel}</Link>
      </header>
      <main id="public-main" className="public-auth-main public-container">
        <section className="public-auth-card" aria-labelledby="auth-card-title">
          <div className="public-auth-card-content">
            <h1 id="auth-card-title">Sign in this window with a code</h1>
            <p>Get a one-time code from this job&apos;s application page in your usual browser, where you&apos;re signed in to Apply Pilot.</p>
            {codeSignIn}
            <details className="public-auth-google-fallback">
              <summary>Not in the Apply Pilot browser? Sign in with Google</summary>
              <p>Google blocks automated browsers, so it won&apos;t work in the Apply Pilot browser window.</p>
              {authState === "available" ? googleAction : null}
              {authState === "unavailable" ? <GoogleUnavailableNotice /> : null}
              <GoogleAccessNote />
            </details>
          </div>
          {authState === "denied" ? <AccessDeniedNotice action={deniedAction} /> : null}
        </section>
      </main>
    </div>
  );
}

export function PublicAuthPage({ mode, authState, googleAction, deniedAction, codeSignIn }: PublicAuthPageProps) {
  if (mode === "login" && codeSignIn) {
    return <CodeFirstAuthPage authState={authState} googleAction={googleAction} deniedAction={deniedAction} codeSignIn={codeSignIn} />;
  }

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
            {authState === "unavailable" ? <GoogleUnavailableNotice /> : null}
            <div className="public-auth-alternate"><span>{content.prompt}</span> <Link href={content.linkHref}>{content.linkLabel}</Link></div>
            <GoogleAccessNote />
          </div>
          {authState === "denied" ? <AccessDeniedNotice action={deniedAction} /> : null}
        </section>
      </main>
    </div>
  );
}
