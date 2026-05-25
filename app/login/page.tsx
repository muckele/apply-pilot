import { redirect } from "next/navigation";
import { LogOut, ShieldAlert, ShieldCheck } from "lucide-react";

import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { auth, signOut } from "@/lib/auth";
import { getAllowedAuthEmails, isEmailAllowedForAuth, requiresEmailAllowlist } from "@/lib/auth-access";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const session = await auth();
  const sessionEmailAllowed = session?.user ? isEmailAllowedForAuth(session.user.email) : false;

  if (session?.user && sessionEmailAllowed) {
    redirect("/dashboard");
  }

  const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const allowedEmails = getAllowedAuthEmails();
  const allowlistRequired = requiresEmailAllowlist();

  return (
    <>
      <PageHeader
        title="Sign in"
        description="Use your Google account to access JobMatch CRM. Gmail permissions are separate and requested only from the integrations page."
      />

      <div className="mx-auto max-w-xl">
        <Panel>
          <PanelHeader
            title="Google OAuth"
            action={<StatusBadge status={googleConfigured ? "Configured" : "Setup needed"} />}
          />
          <div className="space-y-5 p-5">
            {session?.user && !sessionEmailAllowed ? (
              <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm leading-6 text-red-900">
                <div className="flex items-start gap-3">
                  <ShieldAlert className="mt-0.5 shrink-0 text-red-600" size={18} aria-hidden="true" />
                  <div>
                    <p className="font-semibold">Access not approved</p>
                    <p className="mt-1">
                      {session.user.email ?? "This Google account"} is signed in but is not approved for this private
                      deployment. Sign out, then use an approved Google account.
                    </p>
                    <form
                      className="mt-3"
                      action={async () => {
                        "use server";
                        await signOut({ redirectTo: "/login" });
                      }}
                    >
                      <button className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700">
                        <LogOut size={15} aria-hidden="true" />
                        Sign out
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            ) : googleConfigured ? (
              <GoogleSignInButton />
            ) : (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
                Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to `.env`, then restart the dev server.
              </div>
            )}

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm leading-6 text-slate-700">
              <div className="flex items-start gap-3">
                <ShieldCheck className="mt-0.5 text-brand-600" size={18} aria-hidden="true" />
                <div>
                  <p className="font-semibold text-slate-950">Personal access control</p>
                  <p className="mt-1">
                    {allowedEmails.length
                      ? `Only these Google accounts are allowed: ${allowedEmails.join(", ")}.`
                      : allowlistRequired
                        ? "Production private mode requires AUTH_ALLOWED_EMAILS before anyone can sign in."
                        : "Set AUTH_ALLOWED_EMAILS in .env to restrict sign-in to selected Google accounts."}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
