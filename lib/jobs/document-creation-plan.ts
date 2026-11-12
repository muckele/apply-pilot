// Cost helpers for the Apply page's paid steps. Step 3 writes the tailored résumé and cover letter
// (each its own guarded request) and step 2 re-scores; every server-side check, ledger reservation
// and per-request ceiling still runs on each request exactly as before.

export type DocumentCreationStep = "resume" | "cover";

export type DocumentCreationQuote = {
  provider: "gemini";
  model: string;
  promptVersion: string;
  jobMatchMicros: number;
  resumeMicros: number;
  coverMicros: number;
};

export function stepMaximumMicros(step: DocumentCreationStep, quote: DocumentCreationQuote) {
  return step === "resume" ? quote.resumeMicros : quote.coverMicros;
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

// For button labels ("about 8¢"): whole cents rounded up; a dollar or more stays in dollars.
export function formatCentsCeiling(micros: number) {
  const cents = Math.ceil(micros / 10_000);
  return cents < 100 ? `${cents}¢` : formatUsdCentsCeiling(micros);
}
