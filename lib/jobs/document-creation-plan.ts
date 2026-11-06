// "Create my résumé and cover letter" (or just the cover letter) as one plan with one cost
// confirmation. The plan only orders the existing guarded requests (evidence-snapshot save, job
// match, tailored résumé, cover letter); every server-side check, ledger reservation and
// per-request ceiling still runs on each request exactly as before.

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

type DecisionKind = "UNRESOLVED" | "SOURCE_CORRECTION" | "OWNER_ATTESTATION";
type AcceptedFactAction = "RETAIN" | "REMOVE" | "REPLACE_OWNER_ATTESTATION";

function factsChangedBy(input: { decisionKinds: ReadonlyArray<DecisionKind>; acceptedFactActions: ReadonlyArray<AcceptedFactAction> }) {
  return input.decisionKinds.some((kind) => kind !== "UNRESOLVED") ||
    input.acceptedFactActions.some((action) => action !== "RETAIN");
}

export function planDocumentCreation(input: {
  hasValidCurrentSnapshot: boolean;
  reviewable: boolean;
  includeCoverLetter: boolean;
  decisionKinds: ReadonlyArray<DecisionKind>;
  acceptedFactActions: ReadonlyArray<AcceptedFactAction>;
}): DocumentCreationPlan {
  const factsChanged = factsChangedBy(input);
  if (!input.hasValidCurrentSnapshot && !input.reviewable) return { ok: false, reason: "SCORE_FIRST" };
  if (factsChanged && !input.reviewable) return { ok: false, reason: "RECHECK_FIRST" };
  const steps: DocumentCreationStep[] = [];
  if (!input.hasValidCurrentSnapshot || factsChanged) steps.push("save");
  if (factsChanged) steps.push("rescore");
  steps.push("resume");
  if (input.includeCoverLetter) steps.push("cover");
  return { ok: true, steps };
}

export type CoverLetterOnlyPlan =
  | { ok: true; steps: ["cover"] }
  | { ok: false; reason: "NO_CURRENT_RESUME" | "FACTS_CHANGED" | "REVIEW_NOT_SAVED" };

// "Just the cover letter": for a job whose tailored résumé is already good, so it isn't rewritten
// (or paid for) again. Only when nothing would change the evidence both documents rest on — the
// saved review is in force and no line is being added, changed or removed — so the new letter and
// the existing résumé stay grounded in the same facts. The server still checks everything itself.
export function planCoverLetterOnly(input: {
  // A tailored résumé for this job that is ready to use against the current evidence.
  hasCurrentResume: boolean;
  hasValidCurrentSnapshot: boolean;
  decisionKinds: ReadonlyArray<DecisionKind>;
  acceptedFactActions: ReadonlyArray<AcceptedFactAction>;
}): CoverLetterOnlyPlan {
  if (!input.hasCurrentResume) return { ok: false, reason: "NO_CURRENT_RESUME" };
  if (factsChangedBy(input)) return { ok: false, reason: "FACTS_CHANGED" };
  if (!input.hasValidCurrentSnapshot) return { ok: false, reason: "REVIEW_NOT_SAVED" };
  return { ok: true, steps: ["cover"] };
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
