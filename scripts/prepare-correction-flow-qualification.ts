import { execFileSync } from "node:child_process";

import { SYNTHETIC_CORRECTION_FLOW_FIXTURE } from "@/evaluation/correction-flow-qualification-fixture";
import {
  buildCorrectionFlowQualificationManifest,
  hasDirtyCorrectionFlowQualificationWorktree
} from "@/lib/ai/correction-flow-qualification";

function expectedHeadArgument() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length !== 1 || !arguments_[0]?.startsWith("--expected-head=")) {
    throw new Error(
      "Usage: npm run correction-flow:qualify:prepare -- --expected-head=<full-git-sha>"
    );
  }
  const expectedHead = arguments_[0].slice("--expected-head=".length).trim();
  if (!/^[a-f0-9]{40}$/u.test(expectedHead)) {
    throw new Error("The expected qualification head must be a full Git SHA.");
  }
  return expectedHead;
}

function gitOutput(arguments_: string[]) {
  return execFileSync("git", arguments_, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
}

function main() {
  const expectedHead = expectedHeadArgument();
  const exactHead = gitOutput(["rev-parse", "HEAD"]);
  if (exactHead !== expectedHead) {
    throw new Error("The current Git head does not match the approved qualification head.");
  }
  const worktreeStatus = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (hasDirtyCorrectionFlowQualificationWorktree(worktreeStatus)) {
    throw new Error("Qualification preparation requires a clean working tree.");
  }

  const manifest = buildCorrectionFlowQualificationManifest({
    exactHead,
    providerMode: "live_synthetic",
    generatedAt: new Date(),
    fixture: SYNTHETIC_CORRECTION_FLOW_FIXTURE
  });

  process.stdout.write(`${JSON.stringify({
    status: "prepared_not_executed",
    providerCallsStarted: 0,
    executionConsentAccepted: false,
    safeManifest: manifest
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Qualification preparation failed."}\n`);
  process.exitCode = 1;
}
