import type {
  ApplicationAutomationPolicy,
  ApplicationRun,
  ApplicationRunAnswer
} from "@prisma/client";
import { z } from "zod";

import { applicationAutomationPolicyPatchSchema } from "@/lib/application-runs/policy";
import { PLAN_REVIEW_REASONS } from "@/lib/application-runs/review-reasons";

export const cuidPathIdSchema = z.string().cuid();

export const applicationRunPathSchema = z
  .object({
    id: cuidPathIdSchema
  })
  .strict();

export const applicationRunAnswerPathSchema = z
  .object({
    id: cuidPathIdSchema,
    answerId: cuidPathIdSchema
  })
  .strict();

export const applicationRunExecutionTokenPathSchema = z
  .object({
    id: cuidPathIdSchema,
    tokenId: cuidPathIdSchema
  })
  .strict();

export const createApplicationRunBodySchema = z
  .object({
    applicationId: cuidPathIdSchema,
    idempotencyKey: z
      .string()
      .trim()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/)
  })
  .strict();

export const strictEmptyBodySchema = z.object({}).strict();

export const resolveApplicationRunReviewBodySchema = z
  .object({
    stateVersion: z.number().int().nonnegative(),
    acknowledgedReviewReasons: z.array(z.enum(PLAN_REVIEW_REASONS)),
    answerPacketVersion: z.number().int().nonnegative(),
    packetHash: z.string().regex(/^[a-f0-9]{64}$/).nullable()
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.acknowledgedReviewReasons).size !== value.acknowledgedReviewReasons.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acknowledgedReviewReasons"],
        message: "Review reasons must not contain duplicates."
      });
    }
    if (
      (value.answerPacketVersion === 0 && value.packetHash !== null) ||
      (value.answerPacketVersion > 0 && value.packetHash === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["packetHash"],
        message: "Packet hash must match the answer packet version."
      });
    }
  });

export const reviewApplicationRunAnswerBodySchema = z
  .object({
    status: z.enum(["APPROVED", "REJECTED"]),
    answerPacketVersion: z.number().int().nonnegative()
  })
  .strict();

export const automationPolicyPatchContract = applicationAutomationPolicyPatchSchema;

export type CreateApplicationRunBody = z.infer<typeof createApplicationRunBodySchema>;
export type ResolveApplicationRunReviewBody = z.infer<typeof resolveApplicationRunReviewBodySchema>;
export type ReviewApplicationRunAnswerBody = z.infer<typeof reviewApplicationRunAnswerBodySchema>;

export type AutomationPolicyValues = Pick<
  ApplicationAutomationPolicy,
  | "enabled"
  | "mode"
  | "minimumFitScore"
  | "minimumConfidenceScore"
  | "dailyApplicationCap"
  | "allowedHosts"
  | "blockedHosts"
  | "permittedAdapters"
  | "coverLetterRequired"
  | "sensitiveAnswerPolicy"
  | "finalReviewRequired"
>;

export type AutomationPolicyDto = AutomationPolicyValues & {
  persisted: boolean;
  effectiveEnabled: boolean;
};

export type ApplicationRunDto = Pick<
  ApplicationRun,
  | "id"
  | "applicationId"
  | "jobPostingId"
  | "state"
  | "stateVersion"
  | "applyHost"
  | "detectedAdapter"
  | "prepareLeaseExpiresAt"
  | "reviewReasons"
  | "reviewAcknowledgedAt"
  | "blockingReason"
  | "errorCategory"
  | "preparedAt"
  | "cancelledAt"
  | "createdAt"
  | "updatedAt"
>;

export type ApplicationRunAnswerDto = Pick<
  ApplicationRunAnswer,
  | "id"
  | "runId"
  | "status"
  | "reviewedByUser"
  | "reviewedAt"
  | "sensitive"
  | "valueRedacted"
>;
