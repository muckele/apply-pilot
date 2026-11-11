import { redirect } from "next/navigation";

import { companionLoginPath } from "@/lib/companion-sign-in";

export const dynamic = "force-dynamic";

// The sign-in code form now leads the login page on the way to a run's control page, so this
// older address forwards there. The login page never links back here, so this cannot loop.
export default async function CompanionSignInPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  redirect(companionLoginPath(params.callbackUrl));
}
