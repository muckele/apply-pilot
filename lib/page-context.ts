import { redirect } from "next/navigation";

import { UnauthorizedError, requireUserId } from "@/lib/user-context";

export async function requirePageUserId() {
  try {
    return await requireUserId();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      redirect("/login");
    }

    throw error;
  }
}
