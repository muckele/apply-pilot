export type GradeLetter = "A" | "B" | "C" | "D";

export const GRADE_EXPLANATION = "Apply Pilot's grade of how well your résumé fits this job. Not the employer's.";

/** A from 85, B from 70, C from 55, D below. Anything but an integer 0-100 gives null. */
export function gradeLetter(score: number | null | undefined): GradeLetter | null {
  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) return null;
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  return "D";
}
