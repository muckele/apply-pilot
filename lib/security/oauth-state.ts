import crypto from "node:crypto";

type OAuthStateEnv = {
  AUTH_SECRET?: string;
  NODE_ENV?: string;
};

export function getOAuthStateSecret(env: OAuthStateEnv = process.env) {
  const secret = env.AUTH_SECRET?.trim();

  if (secret) {
    return secret;
  }

  if (env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET must be configured before OAuth can be used in production.");
  }

  return "jobmatch-local-dev";
}

export function createOAuthState(userId: string) {
  const secret = getOAuthStateSecret();
  const payload = Buffer.from(
    JSON.stringify({ userId, nonce: crypto.randomUUID(), issuedAt: Date.now() })
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");

  return `${payload}.${signature}`;
}

export function verifyOAuthState(state: string) {
  const secret = getOAuthStateSecret();
  const [payload, signature] = state.split(".");
  if (!payload || !signature) {
    throw new Error("OAuth state is malformed.");
  }

  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(payload).digest("base64url"));
  const provided = Buffer.from(signature);
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new Error("OAuth state signature is invalid.");
  }

  const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    userId?: unknown;
    nonce?: unknown;
    issuedAt?: unknown;
  };

  if (
    typeof parsed.userId !== "string" ||
    !parsed.userId ||
    typeof parsed.nonce !== "string" ||
    !parsed.nonce ||
    typeof parsed.issuedAt !== "number" ||
    !Number.isFinite(parsed.issuedAt)
  ) {
    throw new Error("OAuth state payload is invalid.");
  }

  const age = Date.now() - parsed.issuedAt;
  if (age < -60_000 || age > 10 * 60 * 1000) {
    throw new Error("OAuth state expired.");
  }

  return parsed.userId;
}
