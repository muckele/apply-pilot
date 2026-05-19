import { ShieldCheck } from "lucide-react";

import { ButtonLink, PageHeader, Panel, PanelHeader, StatusBadge } from "@/components/ui";
import { getGmailIntegrationStatus } from "@/lib/gmail/status";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const gmailStatus = await getGmailIntegrationStatus();
  const ready = gmailStatus.issues.length === 0;

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Connect external services with narrow scopes and explicit review controls."
      />

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel>
          <PanelHeader
            title="Gmail"
            action={<StatusBadge status={gmailStatus.connected ? "Connected" : ready ? "Ready" : "Setup needed"} />}
          />
          <div className="space-y-4 p-5 text-sm leading-6 text-slate-700">
            <p>
              Gmail search requests readonly access so JobMatch CRM can find recruiter and hiring-team messages, show snippets,
              and let you explicitly save selected emails to application records.
            </p>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              Requested scope: <span className="font-mono text-xs">{gmailStatus.scope}</span>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              Redirect URI: <span className="font-mono text-xs">{gmailStatus.redirectUri}</span>
            </div>
            {gmailStatus.issues.length ? (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-900">
                <p className="font-semibold">Setup incomplete</p>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {gmailStatus.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {gmailStatus.connected ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-800">
                Connected as {gmailStatus.googleAccountEmail ?? "Gmail account"}.
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {ready ? (
                <ButtonLink href="/api/gmail/connect">Connect Gmail</ButtonLink>
              ) : (
                <button
                  disabled
                  className="rounded-lg bg-slate-200 px-3 py-2 text-sm font-semibold text-slate-500"
                >
                  Connect Gmail
                </button>
              )}
              <button className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700">Disconnect</button>
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Privacy controls" action={<ShieldCheck className="text-brand-600" size={18} />} />
          <div className="space-y-3 p-5 text-sm text-slate-700">
            <p>No emails are sent automatically.</p>
            <p>No emails are deleted by the app.</p>
            <p>Full email bodies are not stored unless you explicitly save them to a CRM record.</p>
            <p>Disconnected Gmail tokens are cleared, and synced data can be deleted.</p>
          </div>
        </Panel>
      </div>
    </>
  );
}
