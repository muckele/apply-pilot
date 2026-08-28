import type { ApplicationRunState } from "@prisma/client";

import { parseApplyPilotOrigin, parseImmutableRunId } from "@/lib/application-browser/types";

type ResponseLike = {
  url(): string;
  status(): number;
  json(): Promise<unknown>;
};

export type ContextRequestLike = {
  get(
    url: string,
    options: { failOnStatusCode: false; maxRedirects: 0 }
  ): Promise<ResponseLike>;
};

export type BrowserApplicationRun = {
  id: string;
  state: ApplicationRunState;
  applyHost: string;
  applyUrlSnapshot: string;
};

export type BrowserAutomationPolicy = {
  effectiveEnabled: boolean;
  allowedHosts: readonly string[];
  blockedHosts: readonly string[];
};

export type SameOriginClient = {
  getApplicationRun(runId: string): Promise<BrowserApplicationRun>;
  getAutomationPolicy(): Promise<BrowserAutomationPolicy>;
};

export class SameOriginClientError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "SameOriginClientError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactResponse(response: ResponseLike, expectedUrl: string): void {
  const status = response.status();
  if (status >= 300 && status < 400) {
    throw new SameOriginClientError("The same-origin request redirect was rejected.", "SAME_ORIGIN_REDIRECT_REJECTED");
  }
  if (response.url() !== expectedUrl) {
    throw new SameOriginClientError("The same-origin response did not match the fixed route.", "SAME_ORIGIN_RESPONSE_MISMATCH");
  }
  if (status === 401) {
    throw new SameOriginClientError("Apply Pilot authentication is required.", "APPLY_PILOT_AUTH_REQUIRED");
  }
  if (status < 200 || status >= 300) {
    throw new SameOriginClientError("The same-origin request failed.", "SAME_ORIGIN_REQUEST_FAILED");
  }
}

function parseRunResponse(value: unknown, immutableRunId: string): BrowserApplicationRun {
  if (!isRecord(value) || !isRecord(value.run)) {
    throw new SameOriginClientError("Invalid run response.", "INVALID_RUN_RESPONSE");
  }
  const run = value.run;
  if (
    run.id !== immutableRunId ||
    typeof run.state !== "string" ||
    typeof run.applyHost !== "string" ||
    !run.applyHost ||
    typeof run.applyUrlSnapshot !== "string" ||
    !run.applyUrlSnapshot
  ) {
    throw new SameOriginClientError("Invalid run response.", "INVALID_RUN_RESPONSE");
  }
  return {
    id: run.id,
    state: run.state as ApplicationRunState,
    applyHost: run.applyHost,
    applyUrlSnapshot: run.applyUrlSnapshot
  };
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function parsePolicyResponse(value: unknown): BrowserAutomationPolicy {
  if (
    !isRecord(value) ||
    typeof value.effectiveEnabled !== "boolean" ||
    !stringArray(value.allowedHosts) ||
    !stringArray(value.blockedHosts)
  ) {
    throw new SameOriginClientError("Invalid policy response.", "INVALID_POLICY_RESPONSE");
  }
  return {
    effectiveEnabled: value.effectiveEnabled,
    allowedHosts: [...value.allowedHosts],
    blockedHosts: [...value.blockedHosts]
  };
}

export function createSameOriginClient(input: {
  configuredApplyPilotOrigin: string;
  immutableRunId: string;
  requestContext: ContextRequestLike;
}): SameOriginClient {
  const origin = parseApplyPilotOrigin(input.configuredApplyPilotOrigin);
  const immutableRunId = parseImmutableRunId(input.immutableRunId);
  const runUrl = `${origin}/api/application-runs/${immutableRunId}`;
  const policyUrl = `${origin}/api/application-automation-policy`;
  const requestOptions = { failOnStatusCode: false, maxRedirects: 0 } as const;

  return Object.freeze({
    async getApplicationRun(runId: string) {
      if (runId !== immutableRunId) {
        throw new SameOriginClientError("The requested run does not match the immutable run.", "RUN_IDENTITY_MISMATCH");
      }
      const response = await input.requestContext.get(runUrl, requestOptions);
      assertExactResponse(response, runUrl);
      return parseRunResponse(await response.json(), immutableRunId);
    },
    async getAutomationPolicy() {
      const response = await input.requestContext.get(policyUrl, requestOptions);
      assertExactResponse(response, policyUrl);
      return parsePolicyResponse(await response.json());
    }
  });
}
