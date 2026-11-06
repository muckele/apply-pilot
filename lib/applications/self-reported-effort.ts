import { z } from "zod";

// Self-reported effort (MVP Bible §11, WP1.9). The Apply Kit's "I applied" step can ask how many
// minutes the application took. The answer is kept in the APPLIED timeline event's metadata next
// to the "what I sent" snapshot, so no schema change is needed. Events are append-only, so the
// number is recorded once, when the application enters Applied. It is the user's own estimate,
// not a timer, and it feeds only their Insights page.

export const SELF_REPORTED_EFFORT_SCHEMA = "apply-pilot/self-reported-effort/v1" as const;
export const SELF_REPORTED_EFFORT_METADATA_KEY = "selfReportedEffort" as const;
export const MAX_EFFORT_MINUTES = 600;

export const effortMinutesSchema = z.number().int().min(1).max(MAX_EFFORT_MINUTES);

const selfReportedEffortSchema = z.object({
  schema: z.literal(SELF_REPORTED_EFFORT_SCHEMA),
  minutes: effortMinutesSchema,
  recordedAt: z.string().datetime({ offset: true })
}).strict();

export type SelfReportedEffort = z.infer<typeof selfReportedEffortSchema>;

export function buildSelfReportedEffort(input: { minutes: number; recordedAt: Date }): SelfReportedEffort {
  return {
    schema: SELF_REPORTED_EFFORT_SCHEMA,
    minutes: effortMinutesSchema.parse(input.minutes),
    recordedAt: input.recordedAt.toISOString()
  };
}

// The Apply Kit's optional minutes box: blank means "not reported"; anything else must be whole
// minutes in range, so a typo is caught before it is recorded.
export function parseEffortMinutesInput(raw: string): { ok: true; minutes: number | null } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, minutes: null };
  const parsed = effortMinutesSchema.safeParse(/^\d+$/u.test(trimmed) ? Number(trimmed) : Number.NaN);
  return parsed.success ? { ok: true, minutes: parsed.data } : { ok: false };
}

export function readSelfReportedEffort(metadata: unknown): SelfReportedEffort | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const parsed = selfReportedEffortSchema.safeParse((metadata as Record<string, unknown>)[SELF_REPORTED_EFFORT_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

export function latestSelfReportedEffort(events: ReadonlyArray<{ occurredAt: Date; metadata: unknown }>) {
  let latest: { occurredAt: Date; effort: SelfReportedEffort } | null = null;
  for (const event of events) {
    const effort = readSelfReportedEffort(event.metadata);
    if (!effort) continue;
    if (!latest || event.occurredAt.getTime() > latest.occurredAt.getTime()) latest = { occurredAt: event.occurredAt, effort };
  }
  return latest?.effort ?? null;
}
