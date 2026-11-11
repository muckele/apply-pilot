import { parseApplyPilotOrigin } from "@/lib/application-browser/types";

type OriginEnv = {
  APP_BASE_URL?: string;
  AUTH_URL?: string;
  NODE_ENV?: string;
};

type OriginHeaders = { get(name: string): string | null };

function validOrigin(candidate: string | undefined | null): string | null {
  if (!candidate || candidate.trim() === "") return null;
  try {
    return parseApplyPilotOrigin(new URL(candidate.trim()).origin);
  } catch {
    return null;
  }
}

// The origin the companion is told to use: the configured app URL (blank values skipped), and only
// outside production this request's own host. parseApplyPilotOrigin is the companion's own
// validator, so an origin it would refuse is never returned.
export function resolveAppOrigin(input: { env: OriginEnv; headers: OriginHeaders }): string | null {
  const configured = validOrigin(input.env.APP_BASE_URL) ?? validOrigin(input.env.AUTH_URL);
  if (configured) return configured;
  if (input.env.NODE_ENV === "production") return null;
  const host = input.headers.get("x-forwarded-host") ?? input.headers.get("host");
  const proto = input.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  return host ? validOrigin(`${proto}://${host}`) : null;
}
