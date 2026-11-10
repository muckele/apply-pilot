import type { Metadata } from "next";
import Link from "next/link";

import { CompanionSignInForm } from "@/components/companion-sign-in-form";
import { runIdFromCompanionCallback } from "@/lib/companion-sign-in";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in the companion — Apply Pilot",
  robots: { index: false, follow: false }
};

// Opened in the companion's automated window, where Google refuses to sign in. The code
// comes from the run's application page in the owner's own signed-in browser.
export default async function CompanionSignInPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requested = typeof params.callbackUrl === "string" ? params.callbackUrl : null;
  const callbackUrl = runIdFromCompanionCallback(requested) ? requested : null;

  return (
    <div className="public-auth-page public-auth-login">
      <main id="public-main" className="public-auth-main public-container">
        <section className="public-auth-card" aria-labelledby="companion-sign-in-title">
          <div className="public-auth-card-content">
            <h2 id="companion-sign-in-title">Sign in the Apply Pilot companion</h2>
            {callbackUrl ? (
              <>
                <p>
                  Google won&apos;t sign in inside this automated window. In your usual browser, where you&apos;re
                  signed in to Apply Pilot, open this job&apos;s application page and click &ldquo;Get a companion
                  sign-in code&rdquo;. Then type the code here.
                </p>
                <CompanionSignInForm callbackUrl={callbackUrl} />
              </>
            ) : (
              <p>
                Open this page from the companion window&apos;s sign-in screen, so Apply Pilot knows which browser
                run to open.
              </p>
            )}
            <div className="public-auth-alternate"><Link href="/login">Back to sign-in</Link></div>
          </div>
        </section>
      </main>
    </div>
  );
}
