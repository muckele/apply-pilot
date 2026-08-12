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
    coverLetter: `Dear ${payload.job.company} Hiring Team,\n\nI am interested in the ${payload.job.title} role because it sits at the intersection of technical problem solving, customer communication, and operational follow-through. My background combines full-stack software engineering training with business development, recruiting, scheduling, payer coordination, and small-business operations.\n\nI would bring a practical, customer-facing technical perspective to the team: translating requirements, troubleshooting workflows, communicating clearly with stakeholders, and staying honest about what is supported by the data and systems in front of me.\n\nThank you for your time and consideration.\n\nMathew Uckele`,
    angle:
      "Position Mathew as a bridge between engineering, customers, and operations without overstating seniority.",
    claimsUsed: [
      "Full-stack software engineering training",
      "Customer-facing sales and business development background",
      "Operations leadership across scheduling, compliance, and billing workflows"
    ]
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
  const fallback = {
    summary: "Recruiter or hiring-team email requiring user review.",
    requestedAction: "Review the message and confirm the appropriate next step.",
    deadline: null,
    draftResponse:
      "Hi,\n\nThank you for reaching out. I appreciate the update and would be happy to continue the conversation. Please let me know the best next step and any details I should prepare in advance.\n\nBest,\nMathew",
    suggestedFollowUpTask: "Review and personalize the draft before sending."
  };

  const generated = await generateJson({
    promptName: "emailReplyPrompt",
    systemPrompt: emailReplyPrompt,
    payload,
    fallback,
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
    prepBrief:
      "Prepare to connect the job requirements to customer-facing technical problem solving, software fundamentals, and operations ownership.",
    likelyQuestions: [
      "Tell me about your transition into technical roles.",
      "How do you explain technical concepts to non-technical stakeholders?",
      "Describe a time you improved an operational workflow."
    ],
    starStories: [
      {
        theme: "Operations ownership",
        situation: "A service workflow involved multiple moving parts across people, payers, and documentation.",
        task: "Improve coordination and reduce operational ambiguity.",
        action: "Organized hiring, compliance, scheduling, billing workflow, and payer communication responsibilities.",
        result: "Created clearer accountability and more reliable follow-through."
      }
    ],
    questionsToAsk: [
      "What does success look like in the first 90 days?",
      "How does the team balance implementation work with customer support escalations?"
    ],
    risksToPrepareFor: ["Be clear about hands-on production engineering depth versus training and project experience."]
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
    summary: "Interview notes saved. Add a transcript or detailed notes for stronger feedback.",
    questionsAsked: [],
    strongMoments: [],
    weakAnswers: [],
    betterAnswers: [],
    thankYouEmailDraft:
      "Hi,\n\nThank you for taking the time to speak with me today. I appreciated learning more about the role and the team. The conversation reinforced my interest in contributing a mix of technical problem solving, customer communication, and operational follow-through.\n\nBest,\nMathew"
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
