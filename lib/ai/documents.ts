import { z } from "zod";

import { coverLetterPrompt } from "@/prompts/coverLetterPrompt";
import { emailReplyPrompt } from "@/prompts/emailReplyPrompt";
import { interviewFeedbackPrompt } from "@/prompts/interviewFeedbackPrompt";
import { interviewPrepPrompt } from "@/prompts/interviewPrepPrompt";
import { generateJson } from "@/lib/ai/client";

const coverLetterSchema = z.object({
  title: z.string(),
  coverLetter: z.string(),
  angle: z.string(),
  claimsUsed: z.array(z.string())
});

const emailReplySchema = z.object({
  summary: z.string(),
  requestedAction: z.string(),
  deadline: z.union([z.string(), z.null()]),
  draftResponse: z.string(),
  suggestedFollowUpTask: z.string()
});

const interviewPrepSchema = z.object({
  prepBrief: z.string(),
  likelyQuestions: z.array(z.string()),
  starStories: z.array(
    z.object({
      theme: z.string(),
      situation: z.string(),
      task: z.string(),
      action: z.string(),
      result: z.string()
    })
  ),
  questionsToAsk: z.array(z.string()),
  risksToPrepareFor: z.array(z.string())
});

const interviewFeedbackSchema = z.object({
  summary: z.string(),
  questionsAsked: z.array(z.string()),
  strongMoments: z.array(z.string()),
  weakAnswers: z.array(z.string()),
  betterAnswers: z.array(z.string()),
  thankYouEmailDraft: z.string()
});

export async function draftCoverLetter(payload: {
  job: { title: string; company: string };
  resume?: unknown;
  profile?: unknown;
}, userId?: string) {
  const fallback = {
    title: `${payload.job.company} ${payload.job.title} cover letter`,
    coverLetter: `Dear ${payload.job.company} Hiring Team,\n\nI am writing about the ${payload.job.title} position. I am interested in learning more about the role and how I might contribute to your team.\n\nThank you for your time and consideration.\n\nSincerely,\n[Your name]`,
    angle: "Generic draft requiring applicant personalization and review before use.",
    claimsUsed: [] as string[]
  };

  const generated = await generateJson({
    promptName: "coverLetterPrompt",
    systemPrompt: coverLetterPrompt,
    payload,
    fallback,
    schema: coverLetterSchema,
    context: userId ? { userId, feature: "COVER_LETTER", promptVersion: "2" } : undefined
  });

  return {
    ...generated.data,
    model: generated.meta.model,
    promptVersion: generated.meta.promptVersion,
    inputHash: generated.meta.requestHash,
    usage: generated.meta
  };
}

export async function draftEmailReply(payload: {
  emailText: string;
  tone: string;
  job?: unknown;
}, userId?: string) {
  const generated = await generateJson({
    promptName: "emailReplyPrompt",
    systemPrompt: emailReplyPrompt,
    payload,
    schema: emailReplySchema,
    context: userId ? { userId, feature: "EMAIL_REPLY", promptVersion: "2" } : undefined
  });

  return {
    ...generated.data,
    model: generated.meta.model,
    promptVersion: generated.meta.promptVersion,
    inputHash: generated.meta.requestHash,
    usage: generated.meta
  };
}

export async function generateInterviewPrep(payload: unknown, userId?: string) {
  const fallback = {
    prepBrief: "Review the job description and your own evidence before the interview. Prepare specific examples you can verify.",
    likelyQuestions: [
      "What interests you about this role?",
      "Which of your documented experiences best match the role requirements?",
      "What questions do you have about the team's work?"
    ],
    starStories: [],
    questionsToAsk: [
      "What does success look like in the first 90 days?",
      "What are the main priorities for this role?"
    ],
    risksToPrepareFor: ["Review your evidence for each requirement and avoid unsupported claims."]
  };

  const generated = await generateJson({
    promptName: "interviewPrepPrompt",
    systemPrompt: interviewPrepPrompt,
    payload,
    fallback,
    schema: interviewPrepSchema,
    context: userId ? { userId, feature: "INTERVIEW_PREP", promptVersion: "2" } : undefined
  });

  return {
    ...generated.data,
    model: generated.meta.model,
    promptVersion: generated.meta.promptVersion,
    inputHash: generated.meta.requestHash,
    usage: generated.meta
  };
}

export async function generateInterviewFeedback(payload: unknown, userId?: string) {
  const fallback = {
    summary: "Detailed AI feedback is unavailable in local mode. Review your interview notes before drawing conclusions.",
    questionsAsked: [],
    strongMoments: [],
    weakAnswers: [],
    betterAnswers: [],
    thankYouEmailDraft: "Hi,\n\nThank you for taking the time to speak with me. I appreciated learning more about the role and the team.\n\nBest,\n[Your name]"
  };

  const generated = await generateJson({
    promptName: "interviewFeedbackPrompt",
    systemPrompt: interviewFeedbackPrompt,
    payload,
    fallback,
    schema: interviewFeedbackSchema,
    context: userId ? { userId, feature: "INTERVIEW_FEEDBACK", promptVersion: "2" } : undefined
  });

  return {
    ...generated.data,
    model: generated.meta.model,
    promptVersion: generated.meta.promptVersion,
    inputHash: generated.meta.requestHash,
    usage: generated.meta
  };
}
