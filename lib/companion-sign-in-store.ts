import { randomBytes } from "node:crypto";

import { isEmailAllowedForAuth } from "@/lib/auth-access";
import type { CompanionSignInDependencies, CompanionSignInStore } from "@/lib/companion-sign-in";
import { prisma } from "@/lib/prisma";

// Codes live in Auth.js's existing VerificationToken table under a "companion-sign-in:"
// identifier, so this feature needs no migration. Sessions are ordinary Auth.js rows.
export const prismaCompanionSignInStore: CompanionSignInStore = {
  async findOwnedRun(userId, runId) {
    return prisma.applicationRun.findFirst({
      where: { id: runId, userId },
      select: { id: true, state: true }
    });
  },
  async replaceCode(identifier, tokenHash, expires) {
    await prisma.$transaction([
      prisma.verificationToken.deleteMany({ where: { identifier } }),
      prisma.verificationToken.create({ data: { identifier, token: tokenHash, expires } })
    ]);
  },
  async consumeCode(identifier, tokenHash, now) {
    // A single conditional delete is the use: two simultaneous attempts cannot both win.
    const used = await prisma.verificationToken.deleteMany({
      where: { identifier, token: tokenHash, expires: { gt: now } }
    });
    return used.count === 1;
  },
  async findRunOwner(runId) {
    const run = await prisma.applicationRun.findUnique({
      where: { id: runId },
      select: { userId: true, state: true, user: { select: { email: true } } }
    });
    return run ? { userId: run.userId, state: run.state, email: run.user.email } : null;
  },
  async createSession(userId, sessionToken, expires) {
    await prisma.session.create({ data: { userId, sessionToken, expires } });
  }
};

export const companionSignInDependencies: CompanionSignInDependencies = {
  store: prismaCompanionSignInStore,
  now: () => new Date(),
  randomBytes: (length) => randomBytes(length),
  isEmailAllowed: (email) => isEmailAllowedForAuth(email)
};
