import { normalizeText } from "@/lib/normalize";

export const interviewQuestionCategories = [
  "GENERAL",
  "BEHAVIORAL",
  "TECHNICAL",
  "ROLE_SPECIFIC",
  "COMPANY",
  "CANDIDATE_QUESTION"
] as const;

export function normalizeInterviewQuestion(question: string) {
  return normalizeText(question).replace(/\?$/, "");
}

export function formatInterviewCategory(value: string) {
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^\w/, (letter) => letter.toUpperCase());
}
