import { LogIn } from "lucide-react";

import { signIn } from "@/lib/auth";

export function GoogleSignInButton({ disabled = false }: { disabled?: boolean }) {
  return (
    <form
      action={async () => {
        "use server";
        await signIn("google", { redirectTo: "/dashboard" });
      }}
    >
      <button
        disabled={disabled}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
      >
        <LogIn size={16} aria-hidden="true" />
        Continue with Google
      </button>
    </form>
  );
}
