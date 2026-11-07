import Link from "next/link";
import { CircleHelp } from "lucide-react";

import { Panel, PanelHeader } from "@/components/ui";
import type { ApplyReturnReminders } from "@/lib/applications/apply-return-reminders";

// Dashboard reminder for "Did you apply?". Each link opens the job's Apply Kit, where the question
// and the "I applied" confirmation are.
export function ApplyReturnReminder({ reminders }: { reminders: ApplyReturnReminders }) {
  if (reminders.count === 0) return null;
  const more = reminders.count - reminders.items.length;
  return (
    <Panel tone="branded">
      <div data-apply-return-reminder>
        <PanelHeader
          title={`You opened ${reminders.count} ${reminders.count === 1 ? "application" : "applications"}. Did you apply?`}
          description={`Tell Apply Pilot whether you submitted ${reminders.count === 1 ? "it" : "them"}, so your tracker stays accurate.`}
          tone="branded"
        />
        <ul className="product-divider divide-y">
          {reminders.items.map((item) => (
            <li key={item.applicationId} className="px-5 py-3">
              <Link href={item.href} className="product-themed-link flex items-center gap-2 text-sm font-semibold underline" data-apply-return-reminder-item>
                <CircleHelp size={15} className="product-themed-accent shrink-0" aria-hidden="true" />
                {item.company} · {item.title}
              </Link>
            </li>
          ))}
        </ul>
        {more > 0 ? <p className="product-themed-muted px-5 pb-4 pt-1 text-xs">and {more} more</p> : null}
      </div>
    </Panel>
  );
}
