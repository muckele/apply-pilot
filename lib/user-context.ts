import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { captureException, logger } from "@/lib/monitoring/logger";
import { prisma } from "@/lib/prisma";

export class UnauthorizedError extends Error {
  constructor(message = "Authentication required") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export async function requireUserId() {
  const session = await auth();

  if (session?.user?.id) {
    return session.user.id;
  }

  if (process.env.ALLOW_DEMO_USER === "true") {
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

  if (error instanceof Error) {
    const status = error.name === "ZodError" ? 422 : 400;

    logger.warn("api.handled_error", {
      status,
      error: {
        name: error.name,
        message: error.message
      }
    });

    return NextResponse.json({ error: error.message }, { status });
  }

  captureException(error, {
    source: "apiErrorResponse"
  });

  return NextResponse.json({ error: "Unexpected error" }, { status: 500 });
}
