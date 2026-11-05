import { NextResponse } from "next/server";
import { ZodError, type ZodIssue } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import { auth } from "@/lib/auth";
import { isEmailAllowedForAuth } from "@/lib/auth-access";
import { captureException, logger } from "@/lib/monitoring/logger";
import { prisma } from "@/lib/prisma";

export class UnauthorizedError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export function isDemoUserFallbackEnabled(env: NodeJS.ProcessEnv = process.env) {
  return env.NODE_ENV !== "production" && env.ALLOW_DEMO_USER === "true";
}

export async function requireUserId() {
  const session = await auth();

  if (session?.user?.id) {
    if (!isEmailAllowedForAuth(session.user.email)) {
      logger.warn("auth.disallowed_existing_session", {
        userId: session.user.id
      });

      throw new UnauthorizedError("Account is not approved for this private deployment");
    }

    return session.user.id;
  }

  // Local demos only: isDemoUserFallbackEnabled() is always false in production.
  // The persona is fictional sample data and must never describe a real person.
  if (isDemoUserFallbackEnabled()) {
    const demoUserId = process.env.DEFAULT_DEMO_USER_ID ?? "demo-user";

    await prisma.user.upsert({
      where: { id: demoUserId },
      update: {},
      create: {
        id: demoUserId,
        name: "Sample User",
        email: "sample@example.com",
        profile: {
          create: {
            careerGoals:
              "Fictional sample persona for local demos: find customer-facing technical roles that combine software skills with implementation and customer onboarding.",
            preferredRoles: [
              "Solutions Engineer",
              "Implementation Specialist",
              "Customer Success Engineer",
              "Junior Software Engineer"
            ],
            preferredLocations: ["Remote", "Hybrid", "Anytown, USA"],
            industriesOfInterest: ["SaaS", "Developer tools"],
            dealBreakers: ["Commission-only roles", "Unclear role expectations"],
            skillsToEmphasize: ["JavaScript", "React", "Node.js", "SQL", "REST APIs", "Customer onboarding"],
            skillsNotToExaggerate: ["Enterprise-scale production ownership", "Deep DevOps ownership"]
          }
        }
      }
    });

    return demoUserId;
  }

  throw new UnauthorizedError();
}

// "preferredRoles", 0 → "Preferred roles #1"
function validationFieldLabel(path: ZodIssue["path"]) {
  const label = path
    .map((part) => typeof part === "number"
      ? `#${part + 1}`
      : part.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase())
    .join(" ");
  return label ? label[0]!.toUpperCase() + label.slice(1) : "This request";
}

// A field-level validation message people can act on. It names only the field
// and the rule, never the submitted value.
function describeValidationError(error: ZodError) {
  const issue = error.issues[0];
  if (!issue) return "Check the submitted fields and try again.";
  const label = validationFieldLabel(issue.path);
  if (issue.code === "too_big" && issue.type === "string") return `${label} must be ${issue.maximum} characters or fewer.`;
  if (issue.code === "too_big" && issue.type === "array") return `${label} can have at most ${issue.maximum} entries.`;
  if (issue.code === "too_small" && issue.type === "string") {
    return Number(issue.minimum) <= 1 ? `${label} is required.` : `${label} must be at least ${issue.minimum} characters.`;
  }
  return `${label}: ${issue.message.replace(/\.$/u, "")}.`;
}

export function apiErrorResponse(error: unknown) {
  if (error instanceof UnauthorizedError) {
    logger.warn("api.unauthorized", {
      error: error.message
    });

    return NextResponse.json({ error: error.message }, { status: 401 });
  }

  if (error instanceof PublicApiError) {
    logger.warn("api.client_error", {
      status: error.status,
      error: {
        name: error.name,
        message: error.message
      }
    });

    return NextResponse.json({ error: error.message, ...error.details }, { status: error.status });
  }

  if (error instanceof ZodError) {
    logger.warn("api.handled_error", {
      status: 422,
      error: { name: error.name, message: error.message }
    });

    return NextResponse.json({ error: describeValidationError(error) }, { status: 422 });
  }

  if (error instanceof Error) {
    const status = error.name === "ZodError" ? 422 : 400;
    const isProduction = process.env.NODE_ENV === "production";
    const message = isProduction
      ? error.name === "ZodError"
        ? "Invalid request. Check the submitted fields and try again."
        : "The request could not be completed."
      : error.message;

    logger.warn("api.handled_error", {
      status,
      error: {
        name: error.name,
        message: error.message
      }
    });

    return NextResponse.json({ error: message }, { status });
  }

  captureException(error, {
    source: "apiErrorResponse"
  });

  return NextResponse.json({ error: "Unexpected error" }, { status: 500 });
}
