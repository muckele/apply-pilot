"use client";

import { LogOut } from "lucide-react";

import { clearAllExperienceDrafts } from "@/lib/jobs/experience-drafts";

// Sign-out clears every saved experience draft in this browser so the next person on a shared
// computer cannot see them. Clearing never blocks the sign-out itself.
export function SignOutButton({ action, className, withIcon = true }: { action: () => Promise<void>; className?: string; withIcon?: boolean }) {
  return (
    <form
      action={action}
      onSubmit={() => {
        try {
          clearAllExperienceDrafts();
        } catch {
          // Never block sign-out.
        }
      }}
    >
      <button className={className}>
        {withIcon ? <LogOut size={15} aria-hidden="true" /> : null}
        Sign out
      </button>
    </form>
  );
}
