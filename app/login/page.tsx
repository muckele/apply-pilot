import { redirect } from "next/navigation";
import { ShieldCheck } from "lucide-react";

import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const session = await auth();

  if (session?.user) {
    redirect("/dashboard");
  }

  const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const allowedEmails = (process.env.AUTH_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);

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
            {googleConfigured ? (
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
                      : "Set AUTH_ALLOWED_EMAILS in .env to restrict sign-in to your own Google account."}
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
