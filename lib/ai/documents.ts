import { coverLetterPrompt } from "@/prompts/coverLetterPrompt";
import { emailReplyPrompt } from "@/prompts/emailReplyPrompt";
import { interviewFeedbackPrompt } from "@/prompts/interviewFeedbackPrompt";
import { interviewPrepPrompt } from "@/prompts/interviewPrepPrompt";
import { generateJson, getOpenAIModel } from "@/lib/ai/client";

export async function draftCoverLetter(payload: {
  job: { title: string; company: string };
  resume?: unknown;
  profile?: unknown;
}) {
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

  return {
    ...(await generateJson({
      promptName: "coverLetterPrompt",
      systemPrompt: coverLetterPrompt,
      payload,
      fallback
    })),
    model: getOpenAIModel()
  };
}

export async function draftEmailReply(payload: {
  emailText: string;
  tone: string;
  job?: unknown;
}) {
  const fallback = {
    summary: "Recruiter or hiring-team email requiring user review.",
    requestedAction: "Review the message and confirm the appropriate next step.",
    deadline: null,
    draftResponse:
      "Hi,\n\nThank you for reaching out. I appreciate the update and would be happy to continue the conversation. Please let me know the best next step and any details I should prepare in advance.\n\nBest,\nMathew",
    suggestedFollowUpTask: "Review and personalize the draft before sending."
  };

  return {
    ...(await generateJson({
      promptName: "emailReplyPrompt",
      systemPrompt: emailReplyPrompt,
      payload,
      fallback
    })),
    model: getOpenAIModel()
  };
}

export async function generateInterviewPrep(payload: unknown) {
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

  return {
    ...(await generateJson({
      promptName: "interviewPrepPrompt",
      systemPrompt: interviewPrepPrompt,
      payload,
      fallback
    })),
    model: getOpenAIModel()
  };
}

export async function generateInterviewFeedback(payload: unknown) {
  const fallback = {
    summary: "Interview notes saved. Add a transcript or detailed notes for stronger feedback.",
    questionsAsked: [],
    strongMoments: [],
    weakAnswers: [],
    betterAnswers: [],
    thankYouEmailDraft:
      "Hi,\n\nThank you for taking the time to speak with me today. I appreciated learning more about the role and the team. The conversation reinforced my interest in contributing a mix of technical problem solving, customer communication, and operational follow-through.\n\nBest,\nMathew"
  };

  return {
    ...(await generateJson({
      promptName: "interviewFeedbackPrompt",
      systemPrompt: interviewFeedbackPrompt,
      payload,
      fallback
    })),
    model: getOpenAIModel()
  };
}
