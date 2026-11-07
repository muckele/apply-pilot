import { createHash } from "node:crypto";

export function hashAiInput(promptName: string, promptVersion: string, payload: unknown) {
  return createHash("sha256")
    .update(`${promptName}:${promptVersion}:${JSON.stringify(payload)}`)
    .digest("hex");
}
