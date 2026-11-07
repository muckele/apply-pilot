import assert from "node:assert/strict";
import { test } from "node:test";

import { APPLY_KIT_COMMON_QUESTIONS, buildApplyKitAnswers } from "@/lib/apply-kit/answers";

type VaultRow = Parameters<typeof buildApplyKitAnswers>[0][number];

function row(id: string, question: string, answer: string, overrides: Partial<VaultRow> = {}): VaultRow {
  return { id, category: "GENERAL", question, answer, sensitive: false, isActive: true, ...overrides };
}

test("common questions are classified by the same deterministic classifier as the answer packet", () => {
  const byId = new Map(APPLY_KIT_COMMON_QUESTIONS.map((question) => [question.id, question]));
  const expected: Record<string, [string, string | null, boolean]> = {
    linkedin: ["PROFESSIONAL_LINK", "professional.linkedin", false],
    "code-profile": ["PROFESSIONAL_LINK", "professional.code_profile", false],
    portfolio: ["PROFESSIONAL_LINK", "professional.portfolio", false],
    website: ["PROFESSIONAL_LINK", "professional.website", false],
    "start-date": ["AVAILABILITY", "availability.start_date", false],
    "notice-period": ["AVAILABILITY", "availability.notice_period", false],
    relocation: ["RELOCATION", "relocation.willingness", false],
    "years-experience": ["EXPERIENCE", "experience.years", false],
    "work-authorization": ["WORK_AUTHORIZATION", "eligibility.work_authorization", true],
    sponsorship: ["SPONSORSHIP", "eligibility.sponsorship", true],
    compensation: ["COMPENSATION", "compensation.expectation", true],
    gender: ["DEMOGRAPHIC", "demographic.gender", true],
    "race-ethnicity": ["DEMOGRAPHIC", "demographic.race_ethnicity", true],
    disability: ["DISABILITY", "eligibility.disability_status", true],
    veteran: ["VETERAN", "eligibility.veteran_status", true],
    "criminal-history": ["CRIMINAL_HISTORY", "eligibility.criminal_history", true],
    attestation: ["LEGAL_ATTESTATION", "attestation.certification", true]
  };
  assert.deepEqual([...byId.keys()].sort(), Object.keys(expected).sort());
  for (const [id, [classification, semanticFieldKey, sensitive]] of Object.entries(expected)) {
    const question = byId.get(id)!;
    assert.equal(question.classification, classification, id);
    assert.equal(question.semanticFieldKey, semanticFieldKey, id);
    assert.equal(question.sensitive, sensitive, id);
  }
});

test("saved Answer Vault answers fill matching common questions with copyable values", () => {
  const answers = buildApplyKitAnswers([
    row("a-linkedin", "LinkedIn URL", "https://www.linkedin.com/in/synthetic-applicant", { category: "LINKS" }),
    row("a-start", "Earliest start date", "Two weeks after an offer", { category: "AVAILABILITY" }),
    row("a-why", "Why do you want to work here?", "I like reliable systems.")
  ]);
  const linkedin = answers.common.find((question) => question.id === "linkedin")!;
  assert.equal(linkedin.status, "SAVED");
  assert.deepEqual(linkedin.status === "SAVED" ? linkedin.answers.map((answer) => answer.answer) : [], [
    "https://www.linkedin.com/in/synthetic-applicant"
  ]);
  const start = answers.common.find((question) => question.id === "start-date")!;
  assert.equal(start.status, "SAVED");
  assert.equal(answers.common.find((question) => question.id === "portfolio")!.status, "NOT_SAVED");
  // Unmatched, non-sensitive answers stay available to copy, once.
  assert.deepEqual(answers.otherSaved.map((answer) => answer.id), ["a-why"]);
});

test("sensitive questions are always 'answer this yourself' and their saved values never leave the server", () => {
  const secretValues = [
    "SECRET-AUTH-Yes I am authorized",
    "SECRET-SPONSOR-No",
    "SECRET-GENDER-value",
    "SECRET-RACE-value",
    "SECRET-DISABILITY-value",
    "SECRET-VETERAN-value",
    "SECRET-CRIMINAL-value",
    "SECRET-CERTIFY-yes",
    "SECRET-SALARY-150000",
    "SECRET-FLAGGED-value",
    "SECRET-EEO-CATEGORY-value",
    "SECRET-HISPANIC-value"
  ];
  const answers = buildApplyKitAnswers([
    row("s1", "Are you legally authorized to work in the United States?", secretValues[0]!),
    row("s2", "Will you now or in the future require sponsorship?", secretValues[1]!),
    row("s3", "Gender", secretValues[2]!),
    row("s4", "Race/Ethnicity", secretValues[3]!),
    row("s5", "Disability status", secretValues[4]!),
    row("s6", "Veteran status", secretValues[5]!),
    row("s7", "Have you ever been convicted of a felony?", secretValues[6]!),
    row("s8", "I certify that the information provided is true", secretValues[7]!),
    row("s9", "Desired salary", secretValues[8]!),
    // The user's own sensitive flag and the vault's sensitive categories are honored even when
    // the classifier does not recognize the wording.
    row("s10", "Anything else we should know?", secretValues[9]!, { sensitive: true }),
    row("s11", "Self-identification", secretValues[10]!, { category: "EEO" }),
    row("s12", "Hispanic or Latino", secretValues[11]!, { category: "WORK_AUTHORIZATION" })
  ]);
  const serialized = JSON.stringify(answers);
  for (const value of secretValues) assert.equal(serialized.includes(value), false, value);
  for (const id of ["work-authorization", "sponsorship", "compensation", "gender", "race-ethnicity", "disability", "veteran", "criminal-history", "attestation"]) {
    const question = answers.common.find((entry) => entry.id === id)!;
    assert.equal(question.status, "ANSWER_YOURSELF", id);
    assert.ok(question.status === "ANSWER_YOURSELF" && question.reason.length > 10, id);
  }
  assert.deepEqual(answers.otherSaved, []);
  // Sensitive vault entries that are not a common question are listed by question only.
  assert.deepEqual(answers.answerYourself.map((entry) => entry.id).sort(), ["s10", "s11", "s12"]);
  for (const entry of answers.answerYourself) assert.deepEqual(Object.keys(entry).sort(), ["id", "question", "reason"]);
});

test("inactive Answer Vault rows are ignored", () => {
  const answers = buildApplyKitAnswers([row("old", "LinkedIn URL", "https://www.linkedin.com/in/old", { isActive: false })]);
  assert.equal(answers.common.find((question) => question.id === "linkedin")!.status, "NOT_SAVED");
  assert.deepEqual(answers.otherSaved, []);
});

test("several saved answers for one common question are all shown for the user to choose", () => {
  const answers = buildApplyKitAnswers([
    row("l1", "LinkedIn URL", "https://www.linkedin.com/in/one", { category: "LINKS" }),
    row("l2", "LinkedIn profile", "https://www.linkedin.com/in/two")
  ]);
  const linkedin = answers.common.find((question) => question.id === "linkedin")!;
  assert.equal(linkedin.status, "SAVED");
  assert.deepEqual(linkedin.status === "SAVED" ? linkedin.answers.map((answer) => answer.id).sort() : [], ["l1", "l2"]);
});
