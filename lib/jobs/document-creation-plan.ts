// "Create my résumé and cover letter" as one plan with one cost confirmation. The plan only
// orders the existing guarded requests (evidence-snapshot save, job match, tailored résumé,
// cover letter); every server-side check, ledger reservation and per-request ceiling still runs
// on each request exactly as before.

export type DocumentCreationStep = "save" | "rescore" | "resume" | "cover";

export type DocumentCreationPlan =
  | { ok: true; steps: DocumentCreationStep[] }
  | { ok: false; reason: "SCORE_FIRST" | "RECHECK_FIRST" };

export type DocumentCreationQuote = {
  provider: "gemini";
  model: string;
  promptVersion: string;
  jobMatchMicros: number;
  resumeMicros: number;
  coverMicros: number;
};

export function planDocumentCreation(input: {
  hasValidCurrentSnapshot: boolean;
  reviewable: boolean;
  includeCoverLetter: boolean;
  decisionKinds: ReadonlyArray<"UNRESOLVED" | "SOURCE_CORRECTION" | "OWNER_ATTESTATION">;
  acceptedFactActions: ReadonlyArray<"RETAIN" | "REMOVE" | "REPLACE_OWNER_ATTESTATION">;
}): DocumentCreationPlan {
  const factsChanged = input.decisionKinds.some((kind) => kind !== "UNRESOLVED") ||
    input.acceptedFactActions.some((action) => action !== "RETAIN");
  if (!input.hasValidCurrentSnapshot && !input.reviewable) return { ok: false, reason: "SCORE_FIRST" };
  if (factsChanged && !input.reviewable) return { ok: false, reason: "RECHECK_FIRST" };
  const steps: DocumentCreationStep[] = [];
  if (!input.hasValidCurrentSnapshot || factsChanged) steps.push("save");
  if (factsChanged) steps.push("rescore");
  steps.push("resume");
  if (input.includeCoverLetter) steps.push("cover");
  return { ok: true, steps };
}

export function stepMaximumMicros(step: DocumentCreationStep, quote: DocumentCreationQuote) {
  if (step === "rescore") return quote.jobMatchMicros;
  if (step === "resume") return quote.resumeMicros;
  if (step === "cover") return quote.coverMicros;
  return 0;
}

export function documentCreationMaximumMicros(steps: readonly DocumentCreationStep[], quote: DocumentCreationQuote) {
  return steps.reduce((total, step) => total + stepMaximumMicros(step, quote), 0);
}

export function formatUsdMicros(micros: number) {
  return `$${(micros / 1_000_000).toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "")}`;
}

// For short hints: rounded up to whole cents, so it never understates the maximum.
export function formatUsdCentsCeiling(micros: number) {
  return `$${(Math.ceil(micros / 10_000) / 100).toFixed(2)}`;
}

const STEP_PHRASES: Partial<Record<DocumentCreationStep, string>> = {
  rescore: "update your fit estimate",
  resume: "write your tailored résumé",
  cover: "write your cover letter"
};

function joinPhrases(phrases: string[]) {
  if (phrases.length <= 1) return phrases.join("");
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases.at(-1)}`;
}

export function documentCreationConfirmation(steps: readonly DocumentCreationStep[], quote: DocumentCreationQuote) {
  const paid = steps.filter((step) => step !== "save");
  const requests = paid.length === 1 ? "1 AI request" : `${paid.length} AI requests`;
  return [
    `This job, your résumé and profile details, and any lines you added will be sent to Google Gemini (${quote.model}, prompt version ${quote.promptVersion}) to ${joinPhrases(paid.map((step) => STEP_PHRASES[step]!))}.`,
    `${paid.length === 1 ? `${requests} could` : `Together, these ${requests} could`} cost up to ${formatUsdMicros(documentCreationMaximumMicros(steps, quote))}; the final charge is usually lower.`,
    "There is no automatic retry; an uncertain provider outcome may still be billed. Continue?"
  ].join(" ");
}
