import { NextResponse } from "next/server";

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

  if (isDemoUserFallbackEnabled()) {
    const demoUserId = process.env.DEFAULT_DEMO_USER_ID ?? "demo-user";

    await prisma.user.upsert({
      where: { id: demoUserId },
      update: {},
      create: {
        id: demoUserId,
        name: "Mathew Uckele",
        email: "mathew@example.com",
        profile: {
          create: {
            careerGoals:
              "Find high-fit customer-facing technical roles that combine software, SaaS operations, implementation, and sales engineering.",
            preferredRoles: [
              "Sales Engineer",
              "Solutions Engineer",
              "Technical Account Manager",
              "Customer Success Engineer",
              "Implementation Specialist",
              "Full-Stack Developer",
              "Junior Software Engineer",
              "Operations / SaaS operations"
            ],
            preferredLocations: ["Los Angeles, CA", "Fontana, CA", "Remote", "Hybrid"],
            industriesOfInterest: ["SaaS", "Health tech", "Developer tools", "Operations"],
            dealBreakers: ["Commission-only roles", "Unclear role expectations"],
            skillsToEmphasize: [
              "JavaScript",
              "React",
              "Node.js",
              "Python",
              "SQL",
              "REST APIs",
              "Customer discovery",
              "Operations leadership"
            ],
            skillsNotToExaggerate: ["Enterprise-scale production ownership", "Deep DevOps ownership"]
          }
        }
      }
    });

    return demoUserId;
  }

  throw new UnauthorizedError();
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

    return NextResponse.json({ error: error.message }, { status: error.status });
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
