import { LogIn } from "lucide-react";

import { signIn } from "@/lib/auth";

function GoogleMark() {
  return (
    <svg className="public-google-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.91h5.38a4.6 4.6 0 0 1-1.99 3.02v2.54h3.22c1.89-1.74 2.99-4.3 2.99-7.4Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.61-2.43l-3.22-2.54c-.9.6-2.04.96-3.39.96-2.6 0-4.81-1.76-5.6-4.13H3.08v2.62A10 10 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.4 13.86A6 6 0 0 1 6.09 12c0-.65.11-1.28.31-1.86V7.52H3.08A10 10 0 0 0 2 12c0 1.61.39 3.13 1.08 4.48l3.32-2.62Z" />
      <path fill="#EA4335" d="M12 6.01c1.47 0 2.79.51 3.83 1.5l2.86-2.87A9.61 9.61 0 0 0 12 2a10 10 0 0 0-8.92 5.52l3.32 2.62C7.19 7.77 9.4 6.01 12 6.01Z" />
    </svg>
  );
}

export function GoogleSignInButton({
  disabled = false,
  variant = "product"
}: {
  disabled?: boolean;
  variant?: "product" | "public";
}) {
  return (
    <form
      action={async () => {
        "use server";
        await signIn("google", { redirectTo: "/dashboard" });
      }}
    >
      <button
        disabled={disabled}
        className={
          variant === "public"
            ? "public-google-button"
            : "inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-slate-300"
        }
      >
        {variant === "public" ? <GoogleMark /> : <LogIn size={16} aria-hidden="true" />}
        Continue with Google
      </button>
    </form>
  );
}
