export const syntheticAnswerValues = ["yes", "no", "not_sure", "skip"] as const;

export type SyntheticAnswerValue = (typeof syntheticAnswerValues)[number];

export type SyntheticQuestion = Readonly<{
  id: string;
  title: string;
  question: string;
  whyItMatters: string;
  requirementLabels: readonly string[];
  yesEvidencePrompt?: string;
}>;

export type SyntheticAnswer = Readonly<{
  questionId: string;
  answer: SyntheticAnswerValue | "";
  evidence: string;
}>;

export type SyntheticSupportedChange = Readonly<{
  id: string;
  summary: string;
  sourceRefs: readonly string[];
  sourceExcerpts: readonly string[];
}>;

export type SyntheticReviewState = Readonly<{
  selectedResumeId: string;
  selectedCoverLetterId: string;
  resumeText: string;
  coverLetterText: string;
  validatedBaseline: Readonly<{
    resumeId: string;
    coverLetterId: string;
    resumeText: string;
    coverLetterText: string;
  }>;
  questions: readonly SyntheticQuestion[];
  answers: readonly SyntheticAnswer[];
  changes: readonly SyntheticSupportedChange[];
}>;

export type SyntheticReviewIssue = Readonly<{
  path: string;
  message: string;
}>;

export function validateSyntheticReview(review: SyntheticReviewState): SyntheticReviewIssue[] {
  const expectedQuestionIds = review.questions.map((question) => question.id);
  const actualQuestionIds = review.answers.map((answer) => answer.questionId);
  const unexpectedOrDuplicateAnswer = actualQuestionIds.some((questionId, index) =>
    !expectedQuestionIds.includes(questionId) || actualQuestionIds.indexOf(questionId) !== index);
  const completeButReordered = expectedQuestionIds.length === actualQuestionIds.length
    && !expectedQuestionIds.every((questionId, index) => actualQuestionIds[index] === questionId);
  const answers = new Map(review.answers.map((answer) => [answer.questionId, answer]));
  const issues: SyntheticReviewIssue[] = [];
  if (unexpectedOrDuplicateAnswer || completeButReordered || actualQuestionIds.length > expectedQuestionIds.length) {
    issues.push({ path: "answers", message: "Answer every material question exactly once in source order." });
    return issues;
  }
  for (const question of review.questions) {
    const answer = answers.get(question.id);
    if (!answer?.answer) {
      issues.push({ path: `answers.${question.id}`, message: `Answer ${question.title}.` });
    } else if (answer.answer === "yes" && question.yesEvidencePrompt && !answer.evidence.trim()) {
      issues.push({
        path: `answers.${question.id}.evidence`,
        message: question.yesEvidencePrompt
      });
    }
  }
  for (const change of review.changes) {
    if (change.sourceRefs.length === 0 || change.sourceExcerpts.length === 0) {
      issues.push({
        path: `changes.${change.id}.sourceRefs`,
        message: `Change ${change.id} must show its source reference and excerpt.`
      });
    }
  }
  if (!review.selectedResumeId) {
    issues.push({ path: "selectedResumeId", message: "Select a resume." });
  } else if (review.selectedResumeId !== review.validatedBaseline.resumeId) {
    issues.push({ path: "selectedResumeId", message: "The selected resume has not been source validated for this fixture." });
  }
  if (!review.selectedCoverLetterId) {
    issues.push({ path: "selectedCoverLetterId", message: "Select a cover letter." });
  } else if (review.selectedCoverLetterId !== review.validatedBaseline.coverLetterId) {
    issues.push({ path: "selectedCoverLetterId", message: "The selected cover letter has not been source validated for this fixture." });
  }
  if (!review.resumeText.trim()) {
    issues.push({ path: "resumeText", message: "Resume text is required." });
  } else if (review.resumeText !== review.validatedBaseline.resumeText) {
    issues.push({ path: "resumeText", message: "Restore the validated resume before document approval." });
  }
  if (!review.coverLetterText.trim()) {
    issues.push({ path: "coverLetterText", message: "Cover-letter text is required." });
  } else if (review.coverLetterText !== review.validatedBaseline.coverLetterText) {
    issues.push({ path: "coverLetterText", message: "Restore the validated cover letter before document approval." });
  }
  return issues;
}

export function buildSyntheticReviewSnapshot(review: SyntheticReviewState): string {
  return JSON.stringify({
    selectedResumeId: review.selectedResumeId,
    selectedCoverLetterId: review.selectedCoverLetterId,
    resumeText: review.resumeText,
    coverLetterText: review.coverLetterText,
    answers: review.questions.map((question) => {
      const answer = review.answers.find((entry) => entry.questionId === question.id);
      return {
        questionId: question.id,
        answer: answer?.answer ?? "",
        evidence: answer?.evidence ?? ""
      };
    }),
    changes: review.changes.map((change) => ({
      id: change.id,
      summary: change.summary,
      sourceRefs: [...change.sourceRefs],
      sourceExcerpts: [...change.sourceExcerpts]
    }))
  });
}
