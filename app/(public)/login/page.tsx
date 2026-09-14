import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { PublicAuthPage } from "@/components/public-auth/public-auth-page";
import { auth, signOut } from "@/lib/auth";
import { isEmailAllowedForAuth } from "@/lib/auth-access";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in — Apply Pilot",
  description: "Continue your job search with Apply Pilot using your Google account."
};

export default async function LoginPage() {
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
