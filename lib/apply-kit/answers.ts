import { formatApplicationAnswerCategory } from "@/lib/application-answers";
import {
  canonicalizeFormComparisonText,
  sanitizeFormDisplayText
} from "@/lib/application-runs/form-inspection";
import {
  classifyApplicationQuestion,
  permittedDispositionForClassification,
  type ApplicationQuestionClassification
} from "@/lib/application-runs/question-classification";

// Apply Kit answers. The deterministic answer packet needs a browser form inspection, so without
// a run the kit uses the same question classifier on a fixed set of common questions and on the
// user's own Answer Vault entries. Sensitive classes (MVP Bible §8 #3) are always "answer this
// yourself": their saved values are never included in what this module returns, so they never
// reach the page.

type KitFieldType = "TEXT" | "URL";

const COMMON_QUESTION_DEFINITIONS: ReadonlyArray<{ id: string; question: string; fieldType: KitFieldType }> = [
  { id: "linkedin", question: "LinkedIn profile", fieldType: "URL" },
  { id: "code-profile", question: "GitHub profile", fieldType: "URL" },
  { id: "portfolio", question: "Portfolio", fieldType: "URL" },
  { id: "website", question: "Personal website", fieldType: "URL" },
  { id: "start-date", question: "When can you start?", fieldType: "TEXT" },
  { id: "notice-period", question: "Notice period", fieldType: "TEXT" },
  { id: "relocation", question: "Are you willing to relocate?", fieldType: "TEXT" },
  { id: "years-experience", question: "Years of experience", fieldType: "TEXT" },
  { id: "work-authorization", question: "Are you legally authorized to work in the United States?", fieldType: "TEXT" },
  { id: "sponsorship", question: "Will you now or in the future require visa sponsorship?", fieldType: "TEXT" },
  { id: "compensation", question: "Desired salary", fieldType: "TEXT" },
  { id: "gender", question: "Gender", fieldType: "TEXT" },
  { id: "race-ethnicity", question: "Race/Ethnicity", fieldType: "TEXT" },
  { id: "disability", question: "Disability status", fieldType: "TEXT" },
  { id: "veteran", question: "Veteran status", fieldType: "TEXT" },
  { id: "criminal-history", question: "Have you ever been convicted of a felony?", fieldType: "TEXT" },
  { id: "attestation", question: "I certify that the information I provided is true and complete", fieldType: "TEXT" }
];

// Field types probed when deciding whether an Answer Vault question is sensitive. A match under
// any of them is enough: a false positive only hides a value the user can still type.
const SENSITIVITY_PROBE_FIELD_TYPES = ["TEXT", "TEXTAREA", "SELECT_ONE", "RADIO_GROUP", "CHECKBOX_BOOLEAN"] as const;
const SENSITIVE_VAULT_CATEGORIES = new Set(["WORK_AUTHORIZATION", "EEO", "COMPENSATION"]);

function isSensitiveClassification(classification: ApplicationQuestionClassification) {
  // EXCLUDED classes are never proposed by the answer packet; legal attestations are manual-only.
  return permittedDispositionForClassification(classification) === "EXCLUDED" || classification === "LEGAL_ATTESTATION";
}

function sensitiveReason(classification: ApplicationQuestionClassification | null) {
  switch (classification) {
    case "WORK_AUTHORIZATION":
    case "CITIZENSHIP_IMMIGRATION":
    case "SPONSORSHIP":
      return "Work authorization and sponsorship answers must come from you. Apply Pilot never fills or suggests them.";
    case "DEMOGRAPHIC":
    case "DISABILITY":
    case "VETERAN":
      return "Voluntary self-identification. Apply Pilot never fills, suggests or sends these answers anywhere.";
    case "CRIMINAL_HISTORY":
      return "Answer this yourself on the employer's form. Apply Pilot never fills or suggests it.";
    case "LEGAL_ATTESTATION":
      return "A legal statement only you can make. Read it on the employer's form before you agree.";
    case "COMPENSATION":
      return "Salary expectations are your call for each role. Apply Pilot does not fill them.";
    default:
      return "You marked this answer as sensitive. Answer it yourself on the employer's form.";
  }
}

function classify(question: string, fieldType: (typeof SENSITIVITY_PROBE_FIELD_TYPES)[number] | KitFieldType) {
  return classifyApplicationQuestion({
    question: canonicalizeFormComparisonText(sanitizeFormDisplayText(question)),
    sectionHeading: null,
    helpText: null,
    autocomplete: null,
    fieldType
  });
}

export type ApplyKitCommonQuestionDefinition = {
  id: string;
  question: string;
  fieldType: KitFieldType;
  classification: ApplicationQuestionClassification;
  semanticFieldKey: string | null;
  sensitive: boolean;
};

export const APPLY_KIT_COMMON_QUESTIONS: readonly ApplyKitCommonQuestionDefinition[] = Object.freeze(
  COMMON_QUESTION_DEFINITIONS.map((definition) => {
    const result = classify(definition.question, definition.fieldType);
    return Object.freeze({
      ...definition,
      classification: result.classification,
      semanticFieldKey: result.semanticFieldKey,
      sensitive: isSensitiveClassification(result.classification)
    });
  })
);

export type ApplyKitSavedAnswer = { id: string; question: string; answer: string; categoryLabel: string };

export type ApplyKitCommonQuestion =
  | { id: string; question: string; status: "SAVED"; answers: ApplyKitSavedAnswer[] }
  | { id: string; question: string; status: "NOT_SAVED" }
  | { id: string; question: string; status: "ANSWER_YOURSELF"; reason: string };

export type ApplyKitAnswers = {
  common: ApplyKitCommonQuestion[];
  otherSaved: ApplyKitSavedAnswer[];
  answerYourself: Array<{ id: string; question: string; reason: string }>;
};

export type ApplyKitVaultRow = {
  id: string;
  category: string;
  question: string;
  answer: string;
  sensitive: boolean;
  isActive: boolean;
};

type VaultSensitivity = {
  sensitive: boolean;
  classification: ApplicationQuestionClassification | null;
  semanticFieldKey: string | null;
};

function vaultSensitivity(row: ApplyKitVaultRow): VaultSensitivity {
  try {
    for (const fieldType of SENSITIVITY_PROBE_FIELD_TYPES) {
      const result = classify(row.question, fieldType);
      if (isSensitiveClassification(result.classification)) {
        return { sensitive: true, classification: result.classification, semanticFieldKey: result.semanticFieldKey };
      }
    }
  } catch {
    // Fail closed: an entry the classifier cannot read is treated as sensitive.
    return { sensitive: true, classification: null, semanticFieldKey: null };
  }
  if (row.sensitive) return { sensitive: true, classification: null, semanticFieldKey: null };
  if (SENSITIVE_VAULT_CATEGORIES.has(row.category)) {
    const classification = row.category === "COMPENSATION" ? "COMPENSATION" : row.category === "EEO" ? "DEMOGRAPHIC" : "WORK_AUTHORIZATION";
    return { sensitive: true, classification, semanticFieldKey: null };
  }
  return { sensitive: false, classification: null, semanticFieldKey: null };
}

function matchesCommonQuestion(row: ApplyKitVaultRow, question: ApplyKitCommonQuestionDefinition) {
  if (question.sensitive || question.semanticFieldKey === null) return false;
  try {
    const result = classify(row.question, question.fieldType);
    return result.classification === question.classification && result.semanticFieldKey === question.semanticFieldKey;
  } catch {
    return false;
  }
}

export function buildApplyKitAnswers(rows: readonly ApplyKitVaultRow[]): ApplyKitAnswers {
  const active = rows.filter((row) => row.isActive);
  const sensitivity = new Map(active.map((row) => [row.id, vaultSensitivity(row)] as const));
  const safeRows = active.filter((row) => !sensitivity.get(row.id)!.sensitive);
  const matched = new Set<string>();

  const common = APPLY_KIT_COMMON_QUESTIONS.map((question): ApplyKitCommonQuestion => {
    if (question.sensitive) {
      return { id: question.id, question: question.question, status: "ANSWER_YOURSELF", reason: sensitiveReason(question.classification) };
    }
    const answers = safeRows.filter((row) => matchesCommonQuestion(row, question)).map((row) => {
      matched.add(row.id);
      return { id: row.id, question: row.question, answer: row.answer, categoryLabel: formatApplicationAnswerCategory(row.category) };
    });
    return answers.length
      ? { id: question.id, question: question.question, status: "SAVED", answers }
      : { id: question.id, question: question.question, status: "NOT_SAVED" };
  });

  // A sensitive entry asking exactly a common sensitive question is covered by that question.
  const commonSensitiveKeys = new Set(
    APPLY_KIT_COMMON_QUESTIONS.flatMap((question) => question.sensitive && question.semanticFieldKey ? [question.semanticFieldKey] : [])
  );
  const answerYourself = active.flatMap((row) => {
    const { sensitive, classification, semanticFieldKey } = sensitivity.get(row.id)!;
    if (!sensitive || (semanticFieldKey !== null && commonSensitiveKeys.has(semanticFieldKey))) return [];
    return [{ id: row.id, question: row.question, reason: sensitiveReason(classification) }];
  });

  return {
    common,
    otherSaved: safeRows
      .filter((row) => !matched.has(row.id))
      .map((row) => ({ id: row.id, question: row.question, answer: row.answer, categoryLabel: formatApplicationAnswerCategory(row.category) })),
    answerYourself
  };
}
