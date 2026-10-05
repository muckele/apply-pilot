import { JOB_MATCH_QUALIFICATION_CASES } from "@/evaluation/job-match-qualification-corpus";
import { SYNTHETIC_QUALIFICATION_SNAPSHOT } from "@/evaluation/job-match-qualification-synthetic-preview";
import { buildSyntheticQualificationReviewGuides } from "@/evaluation/job-match-qualification-synthetic-review-guides";
import { buildQualificationPreparation, type QualificationExpectedCheckpoint } from "@/lib/ai/job-match-qualification";
import { buildOwnerBrowserHandoffSnippet } from "@/lib/ai/job-match-qualification-bridge";
import { startJobMatchQualificationOwnerReview } from "@/lib/ai/job-match-qualification-owner-review";

function argument(name: string) {
  return process.argv.slice(2).find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3).trim();
}

function exactCheckpoint(): QualificationExpectedCheckpoint {
  const manifestHash = argument("expected-manifest");
  const resumeProjectionHash = argument("expected-resume");
  const profileProjectionHash = argument("expected-profile");
  if (!manifestHash || !resumeProjectionHash || !profileProjectionHash) {
    throw new Error("Real review requires --expected-manifest, --expected-resume, and --expected-profile from the prior safe checkpoint.");
  }
  return { manifestHash, resumeProjectionHash, profileProjectionHash };
}

function timeoutArgument() {
  const value = argument("timeout-ms");
  if (!value) return undefined;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60 * 60_000) {
    throw new Error("--timeout-ms must be a whole number from 1 through 3600000.");
  }
  return timeout;
}

async function main() {
  const syntheticPreview = process.argv.includes("--synthetic-preview");
  const origin = argument("origin");
  if (syntheticPreview === Boolean(origin)) {
    throw new Error("Choose exactly one of --synthetic-preview or --origin=<exact authenticated origin>.");
  }
  const now = new Date();
  const syntheticPreparation = syntheticPreview
    ? buildQualificationPreparation(
        SYNTHETIC_QUALIFICATION_SNAPSHOT,
        JOB_MATCH_QUALIFICATION_CASES,
        now
      )
    : null;
  const checkpoint = syntheticPreview
    ? (() => {
        const manifest = syntheticPreparation?.safeManifest;
        if (!manifest) throw new Error("Synthetic preparation is unavailable.");
        return {
          manifestHash: manifest.manifestHash,
          resumeProjectionHash: manifest.resumeProjectionHash,
          profileProjectionHash: manifest.profileProjectionHash
        };
      })()
    : exactCheckpoint();
  const timeout = timeoutArgument();
  const workflow = await startJobMatchQualificationOwnerReview({
    expectedCheckpoint: checkpoint,
    cases: JOB_MATCH_QUALIFICATION_CASES,
    ...(syntheticPreparation
      ? { reviewGuides: buildSyntheticQualificationReviewGuides(syntheticPreparation) }
      : {}),
    ...(syntheticPreview
      ? { syntheticSnapshot: SYNTHETIC_QUALIFICATION_SNAPSHOT }
      : { allowedOrigin: origin }),
    now,
    ...(timeout ? { captureTimeoutMs: Math.min(timeout, 5 * 60_000), sessionTimeoutMs: timeout } : {})
  });

  const closeFromSignal = () => workflow.close("closed");
  process.once("SIGINT", closeFromSignal);
  process.once("SIGTERM", closeFromSignal);

  process.stdout.write(`${JSON.stringify({
    status: syntheticPreview ? "synthetic_preview_ready" : "awaiting_exact_recapture",
    reviewUrl: workflow.reviewUrl,
    memoryLifetime: "The admitted input lives in this loopback server process and is rendered transiently in the open review tab. The app does not persist it. An acknowledged cancel releases server references; navigation clears the tab and sends best-effort cancellation, with server timeout or process exit as fallback. JavaScript cannot prove physical zeroization. A later hash match proves recapture equality, not retention.",
    checkpoint,
    ...(workflow.captureUrl && origin ? {
      browserSnippet: buildOwnerBrowserHandoffSnippet({
        bridgeUrl: workflow.captureUrl,
        expectedAppOrigin: origin
      })
    } : {})
  })}\n`);

  try {
    const ready = await workflow.readyForConsent;
    process.stdout.write(`${JSON.stringify({
      status: "awaiting_separate_google_consent",
      safeManifest: ready.preparation.safeManifest,
      reviewArtifactCount: ready.reviewArtifacts.length,
      providerCallCount: 0,
      nextApprovalRequired: "Separate owner approval bound to this final manifest is required before credential access or any Google request. Keep this exact process running; exit requires a new exact-equality recapture and review."
    })}\n`);
    const outcome = await workflow.closed;
    process.stdout.write(`${JSON.stringify({ status: "local_review_closed", reason: outcome.reason })}\n`);
  } catch {
    const outcome = await workflow.closed;
    process.stderr.write(`${JSON.stringify({
      status: "local_review_closed_before_consent_gate",
      reason: outcome.reason,
      providerCallCount: 0
    })}\n`);
    process.exitCode = outcome.reason === "navigation_or_owner_cancel" ? 0 : 1;
  } finally {
    process.off("SIGINT", closeFromSignal);
    process.off("SIGTERM", closeFromSignal);
    workflow.close("closed");
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Qualification owner review failed."}\n`);
  process.exitCode = 1;
});
