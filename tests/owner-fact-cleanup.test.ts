import assert from "node:assert/strict";
import test from "node:test";

import { PublicApiError } from "@/lib/api-errors";
import { readApplicationDocumentEvidence } from "@/lib/jobs/application-document-evidence";
import { buildEvidenceCorrectionReview, createReviewedEvidenceSnapshot } from "@/lib/jobs/evidence-correction-review";
import {
  assertOwnerFactClean,
  assertReviewedOwnerFactsClean,
  ownerFactProblems
} from "@/lib/jobs/owner-fact-cleanup";

// Synthetic facts shaped like the live case of 2026-11-06: suggested wording pasted together with
// its closing quote mark and the coaching note that followed it.
const pastedWithNote = "At Northwind, worked with sales, product and data science to launch programs.” Your resume already names those partners, so this stays consistent. Only mention Legal if you actually worked with them.";
const pastedWithInstruction = "At Fabrikam, owned onboarding through go-live after each close.” Adjust it to what actually happened.";
const trailingStraightQuote = "I managed a recurring book of 60 merchants and kept churn low.\"";

const codes = (text: string) => ownerFactProblems(text).map((problem) => problem.kind);

test("pasted notes, instructions and stray quote marks are found", () => {
  assert.deepEqual(codes(pastedWithNote), ["stray_quote", "note_to_you", "instruction"]);
  assert.deepEqual(codes(pastedWithInstruction), ["stray_quote", "instruction"]);
  assert.deepEqual(codes(trailingStraightQuote), ["stray_quote"]);
});

test("each problem names the text to remove", () => {
  const [quote, note] = ownerFactProblems(pastedWithNote);
  assert.match(quote!.excerpt, /launch programs\.”$/u);
  assert.equal(note!.excerpt, "Your resume already names those partners, so this stays consistent.");
  assert.equal(ownerFactProblems(pastedWithInstruction)[1]!.excerpt, "Adjust it to what actually happened.");
});

test("placeholders and a fact wrapped whole in quotation marks are found", () => {
  assert.deepEqual(codes("Grew territory revenue by [X]% in one year."), ["placeholder"]);
  assert.deepEqual(codes("Grew territory revenue by XX% in one year."), ["placeholder"]);
  assert.deepEqual(codes("Closed $X in new annual contracts."), ["placeholder"]);
  assert.deepEqual(codes("Managed onboarding for TODO accounts."), ["placeholder"]);
  assert.deepEqual(codes("“Managed 40 merchant accounts end to end.”"), ["wrapped_in_quotes"]);
  assert.deepEqual(codes("\"Managed 40 merchant accounts end to end.\""), ["wrapped_in_quotes"]);
});

test("ordinary facts pass, including first person, quoted names and apostrophes", () => {
  for (const fact of [
    "I hold an active Spanish medical interpreting certificate.",
    "I managed a book of 60 merchants. I ran quarterly reviews with each owner.",
    "Won the “Rookie of the Year” award in 2019.",
    "Won the \"Rookie of the Year\" award in 2019.",
    "Led the team’s onboarding program; trained 12 new hires.",
    "Do not require visa sponsorship to work in the United States.",
    "Considered the top closer on a 40-person team by revenue.",
    "Mentioned in the 2022 company all-hands for renewal results.",
    "Adjusted pricing for 30 enterprise renewals.",
    "Replaced a spreadsheet process with Salesforce dashboards.",
    "Worked with YourMechanic and Yousician as channel partners.",
    "Negotiated payer rates with UnitedHealthcare (Optum) — a 12% increase.",
    "Grew revenue 140% at Example Co [subsidiary of Example Group]."
  ]) {
    assert.deepEqual(ownerFactProblems(fact), [], fact);
  }
});

test("every owner fact with problems is named in one message, and excerpts start on a whole word", () => {
  const facts = [pastedWithNote, "I hold an active Spanish medical interpreting certificate.", pastedWithInstruction].map((fact, index) => ({
    gapId: `gap:${index}`, fact, provenance: "OWNER_ATTESTED" as const, sourceRef: null
  }));
  assert.throws(
    () => assertReviewedOwnerFactsClean({ schema: "apply-pilot/job-match-reviewed-evidence/v1", snapshotId: "s", snapshotHash: "a".repeat(64), facts, unresolvedGapIds: [] }),
    (error: unknown) => error instanceof PublicApiError &&
      JSON.stringify(error.details?.gapIds) === JSON.stringify(["gap:0", "gap:2"]) &&
      error.message.startsWith("2 facts you added for this job have text") &&
      error.message.includes("In the fact starting \u201cAt Northwind, worked with sales, product\u2026\u201d") &&
      error.message.includes("In the fact starting \u201cAt Fabrikam, owned onboarding through\u2026\u201d") &&
      !error.message.includes("Spanish")
  );
  assert.equal(ownerFactProblems(trailingStraightQuote)[0]!.excerpt, "\u2026of 60 merchants and kept churn low.\"");
});

test("saving a fact with problems is refused with a message that names them", () => {
  assert.throws(
    () => assertOwnerFactClean(pastedWithNote),
    (error: unknown) => error instanceof PublicApiError &&
      error.status === 422 &&
      error.details?.code === "OWNER_FACT_NEEDS_CLEANUP" &&
      /quotation mark/u.test(error.message) &&
      /note addressed to you/u.test(error.message) &&
      error.message.includes("Your resume already names those partners")
  );
  assert.doesNotThrow(() => assertOwnerFactClean("I hold an active Spanish medical interpreting certificate."));
});

test("before a paid document, saved owner facts with problems stop the request with a way to fix them", () => {
  const evidence = (fact: string, provenance: "OWNER_ATTESTED" | "SUBMITTED_RESUME") => ({
    schema: "apply-pilot/job-match-reviewed-evidence/v1" as const,
    snapshotId: "snapshot-1",
    snapshotHash: "a".repeat(64),
    facts: [{ gapId: "gap:1", fact, provenance, sourceRef: provenance === "SUBMITTED_RESUME" ? "resume.rawText" : null }],
    unresolvedGapIds: []
  });
  assert.throws(
    () => assertReviewedOwnerFactsClean(evidence(pastedWithInstruction, "OWNER_ATTESTED")),
    (error: unknown) => error instanceof PublicApiError &&
      error.status === 422 &&
      error.details?.code === "OWNER_FACT_NEEDS_CLEANUP" &&
      JSON.stringify(error.details?.gapIds) === JSON.stringify(["gap:1"]) &&
      /Change/u.test(error.message)
  );
  // Résumé lines are the applicant's own source text and are never second-guessed here.
  assert.doesNotThrow(() => assertReviewedOwnerFactsClean(evidence(pastedWithInstruction, "SUBMITTED_RESUME")));
  assert.doesNotThrow(() => assertReviewedOwnerFactsClean(null));
});

test("the review save refuses a new owner fact with pasted text, and accepts a clean one", async () => {
  const review = buildEvidenceCorrectionReview({
    jobId: "job-1",
    resumeId: "resume-1",
    resumeUpdatedAt: "2026-10-08T12:00:00.000Z",
    resume: { rawText: "SUMMARY\nCustomer-facing operator.", summary: "Customer-facing operator." },
    analysisId: "analysis-1",
    analysisOutput: {
      contractVersion: "3",
      promptVersion: "3.4",
      requirementGaps: [{
        requirement: "Merchant onboarding ownership",
        jobRequirement: { ref: "job.requirements[0]", excerpt: "Merchant onboarding ownership" },
        missingKeywords: ["onboarding"]
      }]
    }
  });
  const decision = (attestedFact: string) => [{
    gapId: review.gaps[0]!.id, kind: "OWNER_ATTESTATION" as const, attestedFact,
    ownerAttested: true, reuseScope: "JOB_ONLY" as const, masterProfileOptIn: false
  }];
  await assert.rejects(
    createReviewedEvidenceSnapshot(review, decision(pastedWithInstruction), { reviewedAt: "2026-10-08T12:30:00.000Z" }),
    (error: unknown) => error instanceof PublicApiError && error.details?.code === "OWNER_FACT_NEEDS_CLEANUP"
  );
  const saved = await createReviewedEvidenceSnapshot(review, decision("At Fabrikam, owned onboarding through go-live after each close."),
    { reviewedAt: "2026-10-08T12:30:00.000Z" });
  assert.equal(saved.decisions[0]!.fact, "At Fabrikam, owned onboarding through go-live after each close.");
});

function fakeEvidenceClient(fact: string) {
  const updatedAt = new Date("2026-11-01T00:00:00.000Z");
  const resume = { id: "resume-1", updatedAt, rawText: "SUMMARY\nCustomer-facing operator.", summary: "Customer-facing operator." };
  const job = {
    id: "job-1", title: "Account Executive", company: "Example", description: "Sell.", requirements: [],
    preferredQualifications: [], detectedTechStack: [], currentEvidenceSnapshotId: "snapshot-1", evidenceSnapshotGeneration: 1,
    currentEvidenceSnapshot: {
      id: "snapshot-1", resumeId: "resume-1", sourceResumeUpdatedAt: updatedAt, snapshotHash: "a".repeat(64),
      reviewPayload: {
        schema: "apply-pilot/evidence-snapshot-payload/v2",
        facts: [{ factId: "fact:1", originGapId: "gap:1", fact, provenance: { kind: "OWNER_ATTESTED", ownerAttested: true },
          reuseScope: "JOB_ONLY", masterProfileOptIn: false }],
        unresolvedGapIds: []
      }
    }
  };
  return {
    jobPosting: { findFirstOrThrow: async () => job },
    resume: { findFirst: async () => resume },
    userProfile: { findUnique: async () => null }
  } as unknown as Parameters<typeof readApplicationDocumentEvidence>[0];
}

test("reading a job's evidence for a paid document stops on a saved owner fact with pasted text", async () => {
  await assert.rejects(
    readApplicationDocumentEvidence(fakeEvidenceClient(pastedWithInstruction), "user-1", "job-1"),
    (error: unknown) => error instanceof PublicApiError && error.details?.code === "OWNER_FACT_NEEDS_CLEANUP"
  );
  const clean = await readApplicationDocumentEvidence(fakeEvidenceClient("At Fabrikam, owned onboarding through go-live."), "user-1", "job-1");
  assert.deepEqual(clean.payload.reviewedEvidence?.facts, [{ gapId: "gap:1", fact: "At Fabrikam, owned onboarding through go-live.",
    provenance: "OWNER_ATTESTED", sourceRef: null }]);
});
