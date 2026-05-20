import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeForLog, serializeError } from "@/lib/monitoring/logger";

test("sanitizeForLog redacts sensitive keys and common secret strings", () => {
  const output = sanitizeForLog({
    authorization: "Bearer abc123",
    nested: {
      accessToken: "ya29.secret-token",
      databaseUrl: "postgresql://user:password@example.neon.tech/db",
      message: "Contact test@example.com with sk-testsecret1234567890"
    }
  }) as Record<string, unknown>;

  assert.equal(output.authorization, "[REDACTED]");
  assert.deepEqual(output.nested, {
    accessToken: "[REDACTED]",
    databaseUrl: "postgresql://user:[REDACTED]@example.neon.tech/db",
    message: "Contact [EMAIL] with [REDACTED_OPENAI_KEY]"
  });
});

test("serializeError redacts sensitive error message content", () => {
  const output = serializeError(new Error("Failed with token ya29.secret-token for test@example.com"));

  assert.equal(output.name, "Error");
  assert.equal(output.message, "Failed with token [REDACTED_GOOGLE_OAUTH_TOKEN] for [EMAIL]");
});
