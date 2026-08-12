import type { ApplicationStatus, PostingStatus } from "@prisma/client";

export type ApplicationPipelineLane = {
  key: string;
  label: string;
  description: string;
  statuses: ApplicationStatus[];
};

export type ApplicationAttention = {
  level: "high" | "medium" | "low";
  label: string;
  detail: string;
};

type AttentionEmail = {
  direction: "INBOUND" | "OUTBOUND" | "DRAFT";
  subject: string;
  requestedAction: string | null;
  receivedAt: Date | null;
  createdAt: Date;
};

type AttentionInterview = {
  scheduledAt: Date | null;
};

type AttentionApplication = {
  status: ApplicationStatus;
  dateSaved: Date;
  dateApplied: Date | null;
  followUpDueAt: Date | null;
  updatedAt: Date;
  emails?: AttentionEmail[];
  interviews?: AttentionInterview[];
};

const dayMs = 86_400_000;

export const applicationStatusOptions: Array<{ value: ApplicationStatus; label: string }> = [
  { value: "SAVED", label: "Saved" },
  { value: "INTERESTED", label: "Interested" },
  { value: "APPLIED", label: "Applied" },
  { value: "RECRUITER_SCREEN", label: "Recruiter screen" },
  { value: "HIRING_MANAGER_SCREEN", label: "Hiring manager" },
  { value: "TECHNICAL_INTERVIEW", label: "Technical interview" },
  { value: "FINAL_INTERVIEW", label: "Final interview" },
  { value: "OFFER", label: "Offer" },
  { value: "REJECTED", label: "Rejected" },
  { value: "GHOSTED", label: "Ghosted" },
  { value: "ARCHIVED", label: "Archived" }
];

export const applicationPipelineLanes: ApplicationPipelineLane[] = [
  {
    key: "saved",
    label: "Saved",
    description: "Jobs parked for later review.",
    statuses: ["SAVED"]
  },
  {
    key: "interested",
    label: "Interested",
    description: "Worth packet work before applying.",
    statuses: ["INTERESTED"]
  },
  {
    key: "applied",
    label: "Applied",
    description: "Submitted and waiting for response.",
    statuses: ["APPLIED"]
  },
  {
    key: "screens",
    label: "Screens",
    description: "Recruiter and hiring manager calls.",
    statuses: ["RECRUITER_SCREEN", "HIRING_MANAGER_SCREEN"]
  },
  {
    key: "interviews",
    label: "Interviews",
    description: "Technical and final rounds.",
    statuses: ["TECHNICAL_INTERVIEW", "FINAL_INTERVIEW"]
  },
  {
    key: "offers",
    label: "Offers",
    description: "Offer review and negotiation.",
    statuses: ["OFFER"]
  },
  {
    key: "closed",
    label: "Closed",
    description: "Rejected, ghosted, or archived records.",
    statuses: ["REJECTED", "GHOSTED", "ARCHIVED"]
  }
];

export const activeApplicationStatuses: ApplicationStatus[] = [
  "SAVED",
  "INTERESTED",
  "APPLIED",
  "RECRUITER_SCREEN",
  "HIRING_MANAGER_SCREEN",
  "TECHNICAL_INTERVIEW",
  "FINAL_INTERVIEW",
  "OFFER"
];

export const terminalApplicationStatuses = new Set<ApplicationStatus>(["REJECTED", "GHOSTED", "ARCHIVED"]);

export function formatApplicationStatus(status: ApplicationStatus) {
  return applicationStatusOptions.find((option) => option.value === status)?.label ?? status.replaceAll("_", " ");
}

export function suggestApplicationNextAction(status: ApplicationStatus) {
  switch (status) {
    case "SAVED":
      return "Review fit analysis and decide whether to apply.";
    case "INTERESTED":
      return "Build the apply packet and decide whether to apply.";
    case "APPLIED":
      return "Watch for recruiter response and send a follow-up if there is no reply.";
    case "RECRUITER_SCREEN":
      return "Prepare recruiter talking points and confirm next steps after the screen.";
    case "HIRING_MANAGER_SCREEN":
      return "Prepare role-fit stories and send a thank-you note after the conversation.";
    case "TECHNICAL_INTERVIEW":
      return "Prepare technical examples, projects, and STAR stories for the interview.";
    case "FINAL_INTERVIEW":
      return "Prepare final-round questions, compensation notes, and closing points.";
    case "OFFER":
      return "Compare compensation, benefits, commute/remote fit, and negotiation notes.";
    case "REJECTED":
      return "Record lessons learned and archive any related follow-up tasks.";
    case "GHOSTED":
      return "Job posting archived as ghosted. Reopen the application if the hiring team responds.";
    case "ARCHIVED":
      return "No next action.";
  }
}

export function defaultFollowUpDueAt(status: ApplicationStatus, now = new Date()) {
  if (status === "SAVED") return addDays(now, 5);
  if (status === "INTERESTED") return addDays(now, 3);
  if (status === "APPLIED") return addDays(now, 7);
  if (["RECRUITER_SCREEN", "HIRING_MANAGER_SCREEN", "TECHNICAL_INTERVIEW", "FINAL_INTERVIEW"].includes(status)) {
    return addDays(now, 2);
  }
  if (status === "OFFER") return addDays(now, 1);
  return null;
}

export function resolvePostingStatusForApplicationStatus(status: ApplicationStatus): PostingStatus | null {
  if (status === "APPLIED") return "APPLIED";
  if (["RECRUITER_SCREEN", "HIRING_MANAGER_SCREEN", "TECHNICAL_INTERVIEW", "FINAL_INTERVIEW"].includes(status)) {
    return "INTERVIEW";
  }
  if (status === "OFFER") return "OFFER";
  if (status === "REJECTED") return "REJECTED";
  if (status === "GHOSTED" || status === "ARCHIVED") return "ARCHIVED";
  return null;
}

export function getApplicationAttention(application: AttentionApplication, now = new Date()): ApplicationAttention | null {
  if (application.status === "OFFER") {
    return {
      level: "high",
      label: "Offer needs decision",
      detail: "Review compensation, constraints, and negotiation notes."
    };
  }

  if (terminalApplicationStatuses.has(application.status)) {
    return null;
  }

  if (application.followUpDueAt && application.followUpDueAt.getTime() <= endOfDay(now).getTime()) {
    return {
      level: "high",
      label: "Follow-up due",
      detail: `Due ${formatShortDate(application.followUpDueAt)}.`
    };
  }

  const actionableEmail = latestActionableInboundEmail(application.emails ?? []);
  if (actionableEmail) {
    return {
      level: "high",
      label: "Email needs response",
      detail: actionableEmail.requestedAction ?? actionableEmail.subject
    };
  }

  const upcomingInterview = (application.interviews ?? [])
    .filter((interview) => interview.scheduledAt && interview.scheduledAt.getTime() >= now.getTime())
    .sort((a, b) => Number(a.scheduledAt) - Number(b.scheduledAt))[0];
  if (upcomingInterview?.scheduledAt && upcomingInterview.scheduledAt.getTime() <= addDays(now, 2).getTime()) {
    return {
      level: "medium",
      label: "Interview prep due",
      detail: `Interview scheduled ${formatShortDate(upcomingInterview.scheduledAt)}.`
    };
  }

  if (application.status === "APPLIED" && application.dateApplied) {
    const hasInboundAfterApply = (application.emails ?? []).some(
      (email) =>
        email.direction === "INBOUND" &&
        (email.receivedAt ?? email.createdAt).getTime() >= application.dateApplied!.getTime()
    );

    const daysSinceApply = daysSince(application.dateApplied, now);

    if (!hasInboundAfterApply && daysSinceApply >= 21) {
      return {
        level: "medium",
        label: "Consider ghosted",
        detail: "Applied at least 21 days ago with no saved inbound recruiter email. Send a final follow-up or mark ghosted."
      };
    }

    if (!hasInboundAfterApply && daysSinceApply >= 7) {
      return {
        level: "medium",
        label: "No response yet",
        detail: "Applied at least 7 days ago with no saved inbound recruiter email."
      };
    }
  }

  if (["SAVED", "INTERESTED"].includes(application.status) && daysSince(application.updatedAt, now) >= 5) {
    return {
      level: "low",
      label: "Decision stale",
      detail: "Review whether this job still deserves attention."
    };
  }

  return null;
}

function latestActionableInboundEmail(emails: AttentionEmail[]) {
  return emails
    .filter((email) => email.direction === "INBOUND" && Boolean(email.requestedAction))
    .sort((a, b) => (b.receivedAt ?? b.createdAt).getTime() - (a.receivedAt ?? a.createdAt).getTime())[0];
}

function addDays(value: Date, days: number) {
  return new Date(value.getTime() + days * dayMs);
}

function daysSince(value: Date, now: Date) {
  return Math.floor((startOfDay(now).getTime() - startOfDay(value).getTime()) / dayMs);
}

function startOfDay(value: Date) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfDay(value: Date) {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

function formatShortDate(value: Date) {
  return value.toISOString().slice(0, 10);
}
