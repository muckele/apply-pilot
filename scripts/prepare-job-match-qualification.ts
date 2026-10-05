import { JOB_MATCH_QUALIFICATION_CASES } from "@/evaluation/job-match-qualification-corpus";
import {
  buildOwnerBrowserHandoffSnippet,
  startJobMatchQualificationBridge
} from "@/lib/ai/job-match-qualification-bridge";

function exactOriginArgument() {
  const entry = process.argv.slice(2).find((value) => value.startsWith("--origin="));
  const origin = entry?.slice("--origin=".length).trim();
  if (!origin) {
    throw new Error("Usage: npm run job-match:qualify:prepare -- --origin=https://your-apply-pilot-origin.example");
  }
  return origin;
}

async function main() {
  const origin = exactOriginArgument();
  const bridge = await startJobMatchQualificationBridge({
    allowedOrigin: origin,
    cases: JOB_MATCH_QUALIFICATION_CASES
  });
  process.stdout.write(`${JSON.stringify({
    status: "awaiting_owner_handoff",
    expiresWithinMinutes: 5,
    instructions: "Open the authenticated Apply Pilot origin, open its browser console, and run the one-shot snippet below. It performs two read-only same-origin GETs and sends only the JOB_MATCH projection to 127.0.0.1 memory.",
    browserSnippet: buildOwnerBrowserHandoffSnippet({
      bridgeUrl: bridge.url,
      expectedAppOrigin: origin
    })
  }, null, 2)}\n`);
  try {
    const manifest = await bridge.done;
    process.stdout.write(`${JSON.stringify({
      status: "prepared_no_provider_call",
      safeManifest: manifest,
      privateInputRetained: false,
      nextAction: "This hash-only process now exits and cannot continue into review. Start job-match:qualify:review with this manifest, resume, and profile hash; recapture must match all three exactly before the owner screen opens."
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "The qualification bridge failed."}\n`);
    process.exitCode = 1;
  } finally {
    bridge.close();
  }
}

void main();
