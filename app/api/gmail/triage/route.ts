import { google } from "googleapis";
import { NextRequest, NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { decryptToken, encryptToken } from "@/lib/security/crypto";
import { writeAuditLog } from "@/lib/security/audit-log";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { apiErrorResponse, requireUserId } from "@/lib/user-context";
import { gmailTriageSchema } from "@/lib/validators";

const DEFAULT_TRIAGE_QUERIES = [
  'newer_than:90d from:(greenhouse.io OR lever.co OR ashbyhq.com OR workable.com OR smartrecruiters.com OR icims.com OR jobvite.com OR bamboohr.com) -subject:("job alert" OR newsletter OR digest)',
  'newer_than:90d subject:(interview OR "phone screen" OR "recruiter screen" OR "hiring manager" OR assessment OR offer OR "next steps") -from:(linkedin.com OR mail.linkedin.com)',
  'newer_than:90d ("thank you for applying" OR "application received" OR "your application" OR "not moving forward" OR "talent acquisition" OR "hiring team" OR recruiter OR sourcer) -from:(linkedin.com OR mail.linkedin.com)'
];

const atsDomains = [
  "greenhouse.io",
  "greenhouse-mail.io",
  "lever.co",
  "ashbyhq.com",
  "workable.com",
  "smartrecruiters.com",
  "icims.com",
  "jobvite.com",
  "bamboohr.com"
];

const socialOrContentDomains = [
  "linkedin.com",
  "mail.linkedin.com",
  "facebookmail.com",
  "twitter.com",
  "x.com",
  "instagram.com",
  "youtube.com",
  "substack.com",
  "medium.com",
  "quora.com"
];

type GmailHeaders = Array<{ name?: string | null; value?: string | null }> | undefined;

type TriageMessage = {
  gmailMessageId: string;
  threadId: string | null;
  gmailUrl: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labels: string[];
  flagged: boolean;
  category: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  confidence: number;
  reason: string;
  requestedAction: string;
  matchedApplicationId?: string;
  matchedJobPostingId?: string;
};

function headerValue(headers: GmailHeaders, name: string) {
  return headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parseEmailAddress(value: string) {
  return value.match(/<([^>]+)>/)?.[1] ?? value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] ?? "";
}

function senderDomain(from: string) {
  return parseEmailAddress(from).split("@")[1]?.toLowerCase() ?? "";
}

function hasAny(text: string, terms: string[]) {
  return terms.some((term) => text.includes(term));
}

function isDomainMatch(domain: string, domains: string[]) {
  return domains.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`));
}

function parseReceivedAt(value: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function buildGmailUrl(threadId: string | null, messageId: string, googleAccountEmail?: string | null) {
  const baseUrl = new URL("https://mail.google.com/mail/");

  if (googleAccountEmail) {
    baseUrl.searchParams.set("authuser", googleAccountEmail);
  }

  return `${baseUrl.toString()}#all/${encodeURIComponent(threadId || messageId)}`;
}

function classifyMessage(message: Pick<TriageMessage, "from" | "subject" | "snippet">, matchedApplication = false) {
  const subject = normalize(message.subject);
  const text = normalize(`${message.from} ${message.subject} ${message.snippet}`);
  const domain = senderDomain(message.from);
  const fromAts = isDomainMatch(domain, atsDomains);
  const fromSocialOrContent = isDomainMatch(domain, socialOrContentDomains);
  const categoryReasons: string[] = [];
  let category = "OTHER_OPPORTUNITY";
  let priority: TriageMessage["priority"] = "LOW";
  let confidence = fromAts ? 45 : 20;
  let requestedAction = "Review the message and decide whether it belongs in an application timeline.";

  const employmentTerms = [
    "job",
    "role",
    "position",
    "opening",
    "opportunity",
    "candidate",
    "application",
    "apply",
    "applying",
    "interview",
    "hiring",
    "recruiter",
    "sourcer",
    "talent acquisition"
  ];
  const hasEmploymentContext = hasAny(text, employmentTerms) || fromAts || matchedApplication;
  const jobBoardNoise = hasAny(text, [
    "job alert",
    "jobs matching",
    "recommended jobs",
    "new jobs for you",
    "newsletter",
    "digest",
    "unsubscribe"
  ]);
  const socialNotificationNoise =
    fromSocialOrContent ||
    hasAny(text, [
      "posted on linkedin",
      "shared a post",
      "commented on",
      "liked your",
      "new post from",
      "people are viewing",
      "connection request"
    ]);
  const vendorOrCommerceNoise = hasAny(text, [
    "quote",
    "quoted",
    "estimate",
    "invoice",
    "receipt",
    "order confirmation",
    "appointment",
    "consultation",
    "sleep expert",
    "mattress",
    "shipping",
    "delivery",
    "subscription"
  ]);

  if (socialNotificationNoise) {
    return {
      flagged: false,
      category: "SOCIAL_OR_CONTENT_NOTIFICATION",
      priority: "LOW" as const,
      confidence: 15,
      reason: "ignored because it appears to be a LinkedIn/social/content notification, not a direct employer email",
      requestedAction: "No CRM action recommended."
    };
  }

  if (vendorOrCommerceNoise && !hasEmploymentContext) {
    return {
      flagged: false,
      category: "VENDOR_OR_QUOTE",
      priority: "LOW" as const,
      confidence: 15,
      reason: "ignored because it appears to be a quote, invoice, appointment, or vendor message without job context",
      requestedAction: "No CRM action recommended."
    };
  }

  if (jobBoardNoise && !matchedApplication && !fromAts && !subject.includes("interview")) {
    return {
      flagged: false,
      category: "JOB_ALERT_OR_NEWSLETTER",
      priority: "LOW" as const,
      confidence: 25,
      reason: "ignored because it looks like a job alert, newsletter, or digest instead of a direct employer message",
      requestedAction: "Review manually only if it names a target company."
    };
  }

  if (
    hasAny(text, [
      "interview",
      "phone screen",
      "recruiter screen",
      "hiring manager",
      "technical screen",
      "panel",
      "final round",
      "next steps"
    ])
  ) {
    category = "INTERVIEW_OR_NEXT_STEPS";
    priority = "HIGH";
    confidence += 30;
    requestedAction = "Review scheduling details and respond after approval.";
    categoryReasons.push("mentions interview, scheduling, availability, or next steps");
  }

  if (hasAny(text, ["availability", "schedule", "calendar", "time slot"]) && hasEmploymentContext) {
    category = category === "OTHER_OPPORTUNITY" ? "SCHEDULING_REVIEW" : category;
    priority = priority === "LOW" ? "MEDIUM" : priority;
    confidence += 15;
    categoryReasons.push("mentions scheduling in an employment context");
  }

  if (hasAny(text, ["assessment", "take home", "take-home", "coding challenge", "technical exercise"])) {
    category = "ASSESSMENT";
    priority = "HIGH";
    confidence += 25;
    requestedAction = "Review the assessment request and add any deadline to tasks.";
    categoryReasons.push("mentions an assessment or technical exercise");
  }

  if (hasAny(text, ["offer", "compensation", "salary", "background check", "references"])) {
    category = "OFFER_OR_LATE_STAGE";
    priority = "HIGH";
    confidence += 25;
    requestedAction = "Review offer or late-stage details before taking action.";
    categoryReasons.push("mentions offer, compensation, references, or background checks");
  }

  if (hasAny(text, ["unfortunately", "not moving forward", "pursue other candidates", "other candidates", "declined"])) {
    category = "REJECTION_OR_CLOSED";
    priority = priority === "HIGH" ? "HIGH" : "MEDIUM";
    confidence += 20;
    requestedAction = "Update the application outcome if this matches an active CRM record.";
    categoryReasons.push("appears to be a rejection or closed-loop application update");
  }

  if (hasAny(text, ["application received", "thank you for applying", "application submitted", "received your application"])) {
    category = category === "OTHER_OPPORTUNITY" ? "APPLICATION_UPDATE" : category;
    confidence += 15;
    categoryReasons.push("appears to be an application status update");
  }

  if (
    hasAny(text, ["recruiter", "talent acquisition", "sourcer", "hiring team"])
  ) {
    category = category === "OTHER_OPPORTUNITY" ? "RECRUITER_OR_EMPLOYER_OUTREACH" : category;
    priority = priority === "LOW" ? "MEDIUM" : priority;
    confidence += 20;
    categoryReasons.push("mentions recruiter, talent acquisition, sourcer, or hiring team");
  }

  if (hasAny(text, ["role", "position", "opening", "opportunity"]) && (fromAts || matchedApplication || hasAny(text, ["job", "hiring", "recruiter", "candidate"]))) {
    category = category === "OTHER_OPPORTUNITY" ? "ROLE_OR_OPPORTUNITY_REVIEW" : category;
    priority = priority === "LOW" ? "MEDIUM" : priority;
    confidence += 10;
    categoryReasons.push("mentions a role or opportunity with job context");
  }

  if (fromAts) {
    confidence += 20;
    categoryReasons.push(`sender is from a known applicant tracking domain (${domain})`);
  }

  if (matchedApplication) {
    confidence += 15;
    categoryReasons.push("matches an existing CRM application");
  }

  const flagged = confidence >= (fromAts || matchedApplication ? 55 : 65) && category !== "OTHER_OPPORTUNITY";

  return {
    flagged,
    category,
    priority,
    confidence: Math.min(confidence, 95),
    reason: categoryReasons.length
      ? categoryReasons.join("; ")
      : "did not contain enough direct employment context to flag",
    requestedAction: flagged ? requestedAction : "No CRM action recommended unless you manually confirm this is employment-related."
  };
}

function matchApplication(
  message: Pick<TriageMessage, "from" | "subject" | "snippet">,
  applications: Array<{ id: string; jobPostingId: string; jobPosting: { company: string; title: string } }>
) {
  const text = normalize(`${message.from} ${message.subject} ${message.snippet}`);
  const domain = normalize(senderDomain(message.from));

  return applications.find((application) => {
    const company = normalize(application.jobPosting.company);
    const title = normalize(application.jobPosting.title);
    const companyDomainToken = company.replaceAll(" ", "");

    return (
      (company.length > 2 && text.includes(company)) ||
      (companyDomainToken.length > 2 && domain.includes(companyDomainToken)) ||
      (title.length > 8 && text.includes(title))
    );
  });
}

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    checkRateLimit(`gmail-triage:${userId}`, 5, 60_000);
    const input = gmailTriageSchema.parse(await request.json().catch(() => ({})));
    const integration = await prisma.gmailIntegration.findUniqueOrThrow({ where: { userId } });

    if (integration.disconnectedAt || (!integration.encryptedAccessToken && !integration.encryptedRefreshToken)) {
      throw new Error("Gmail is not connected.");
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI
    );
    oauth2Client.setCredentials({
      access_token: integration.encryptedAccessToken
        ? decryptToken(integration.encryptedAccessToken)
        : undefined,
      refresh_token: integration.encryptedRefreshToken
        ? decryptToken(integration.encryptedRefreshToken)
        : undefined,
      expiry_date: integration.tokenExpiresAt?.getTime()
    });

    const { credentials } = await oauth2Client.refreshAccessToken();
    if (credentials.access_token) {
      await prisma.gmailIntegration.update({
        where: { userId },
        data: {
          encryptedAccessToken: encryptToken(credentials.access_token),
          tokenExpiresAt: credentials.expiry_date ? new Date(credentials.expiry_date) : undefined
        }
      });
    }

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const queries = input.queries?.length ? input.queries : DEFAULT_TRIAGE_QUERIES;
    const messageIds = new Map<string, string>();

    for (const query of queries) {
      const list = await gmail.users.messages.list({
        userId: "me",
        q: query,
        maxResults: input.maxResultsPerQuery
      });

      for (const message of list.data.messages ?? []) {
        if (message.id) {
          messageIds.set(message.id, message.threadId ?? "");
        }
      }
    }

    const applications = await prisma.application.findMany({
      where: { userId },
      include: { jobPosting: { select: { company: true, title: true } } },
      orderBy: { updatedAt: "desc" },
      take: 100
    });

    const messages: TriageMessage[] = await Promise.all(
      [...messageIds.keys()].map(async (id) => {
        const details = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"]
        });
        const headers = details.data.payload?.headers;
        const baseMessage = {
          gmailMessageId: details.data.id ?? id,
          threadId: details.data.threadId ?? messageIds.get(id) ?? null,
          gmailUrl: buildGmailUrl(
            details.data.threadId ?? messageIds.get(id) ?? null,
            details.data.id ?? id,
            integration.googleAccountEmail
          ),
          from: headerValue(headers, "From"),
          to: headerValue(headers, "To"),
          subject: headerValue(headers, "Subject") || "(no subject)",
          date: headerValue(headers, "Date"),
          snippet: details.data.snippet ?? "",
          labels: details.data.labelIds ?? []
        };
        const matchedApplication = matchApplication(baseMessage, applications);
        const classification = classifyMessage(baseMessage, Boolean(matchedApplication));

        return {
          ...baseMessage,
          ...classification,
          matchedApplicationId: matchedApplication?.id,
          matchedJobPostingId: matchedApplication?.jobPostingId
        };
      })
    );

    const sortedMessages = messages.sort((a, b) => {
      const priorityRank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      return priorityRank[a.priority] - priorityRank[b.priority] || b.confidence - a.confidence;
    });

    let savedCount = 0;
    if (input.saveFlagged) {
      const flaggedMessages = sortedMessages.filter((message) => message.flagged);

      await Promise.all(
        flaggedMessages.map(async (message) => {
          await prisma.emailMessage.upsert({
            where: {
              userId_gmailMessageId: {
                userId,
                gmailMessageId: message.gmailMessageId
              }
            },
            update: {
              jobPostingId: message.matchedJobPostingId,
              applicationId: message.matchedApplicationId,
              threadId: message.threadId,
              fromEmail: parseEmailAddress(message.from),
              toEmail: parseEmailAddress(message.to),
              subject: message.subject,
              snippet: message.snippet,
              receivedAt: parseReceivedAt(message.date),
              labels: [...message.labels, `triage:${message.category}`, `priority:${message.priority}`],
              aiSummary: message.reason,
              requestedAction: message.requestedAction
            },
            create: {
              userId,
              jobPostingId: message.matchedJobPostingId,
              applicationId: message.matchedApplicationId,
              gmailMessageId: message.gmailMessageId,
              threadId: message.threadId,
              direction: "INBOUND",
              fromEmail: parseEmailAddress(message.from),
              toEmail: parseEmailAddress(message.to),
              subject: message.subject,
              snippet: message.snippet,
              bodySaved: false,
              receivedAt: parseReceivedAt(message.date),
              labels: [...message.labels, `triage:${message.category}`, `priority:${message.priority}`],
              aiSummary: message.reason,
              requestedAction: message.requestedAction
            }
          });
          savedCount += 1;
        })
      );

      await writeAuditLog({
        userId,
        action: "gmail.triage.save_flagged",
        resource: "EmailMessage",
        metadata: { savedCount, scannedCount: sortedMessages.length }
      });
    }

    return NextResponse.json({
      queries,
      scannedCount: sortedMessages.length,
      flaggedCount: sortedMessages.filter((message) => message.flagged).length,
      savedCount,
      messages: sortedMessages
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
