import crypto from "node:crypto";

const secret = process.env.AUTH_SECRET ?? "jobmatch-local-dev";

export function createOAuthState(userId: string) {
  const payload = Buffer.from(
    JSON.stringify({ userId, nonce: crypto.randomUUID(), issuedAt: Date.now() })
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");

  return `${payload}.${signature}`;
}

export function verifyOAuthState(state: string) {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) {
    throw new Error("OAuth state is malformed.");
  }

  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error("OAuth state signature is invalid.");
  }

  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    userId: string;
    issuedAt: number;
  };

  if (Date.now() - parsed.issuedAt > 10 * 60 * 1000) {
    throw new Error("OAuth state expired.");
  }

  return parsed.userId;
}
