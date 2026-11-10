import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { PublicAuthPage } from "@/components/public-auth/public-auth-page";
import { auth, signOut } from "@/lib/auth";
import { isEmailAllowedForAuth } from "@/lib/auth-access";
import { companionSignInHref } from "@/lib/companion-sign-in";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in — Apply Pilot",
  description: "Continue your job search with Apply Pilot using your Google account."
};

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const companionHref = companionSignInHref(params.callbackUrl);
  const session = await auth();
  const sessionEmailAllowed = session?.user ? isEmailAllowedForAuth(session.user.email) : false;

  if (session?.user && sessionEmailAllowed) {
    redirect("/dashboard");
  }

  const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const authState = session?.user && !sessionEmailAllowed
    ? "denied"
    : googleConfigured
      ? "available"
      : "unavailable";

  return (
    <PublicAuthPage
      mode="login"
      authState={authState}
      googleAction={googleConfigured ? <GoogleSignInButton variant="public" /> : undefined}
      companionAction={companionHref ? (
        <p className="public-auth-companion">
          <Link href={companionHref}>Signing in the Apply Pilot companion? Use a sign-in code instead.</Link>
        </p>
      ) : undefined}
      deniedAction={
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/login" });
          }}
        >
          <button className="public-button public-button-secondary public-denied-button">
            Sign out
          </button>
        </form>
      }
    />
  );
}
