export const applicationAnswerCategories = [
  "GENERAL",
  "WORK_AUTHORIZATION",
  "AVAILABILITY",
  "COMPENSATION",
  "EXPERIENCE",
  "CONTACT",
  "LINKS",
  "EEO",
  "OTHER"
] as const;

export function formatApplicationAnswerCategory(value: string) {
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^\w/, (letter) => letter.toUpperCase());
}
