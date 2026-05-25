type AuthEnv = {
  AUTH_ALLOWED_EMAILS?: string;
  AUTH_ALLOW_PUBLIC_SIGNUPS?: string;
  NODE_ENV?: string;
};

export function getAllowedAuthEmails(env: AuthEnv = process.env) {
  return (env.AUTH_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function requiresEmailAllowlist(env: AuthEnv = process.env) {
  return env.NODE_ENV === "production" && env.AUTH_ALLOW_PUBLIC_SIGNUPS !== "true";
}

export function isEmailAllowedForAuth(email: string | null | undefined, env: AuthEnv = process.env) {
  const allowedEmails = getAllowedAuthEmails(env);

  if (!allowedEmails.length) {
    return !requiresEmailAllowlist(env);
  }

  return Boolean(email && allowedEmails.includes(email.toLowerCase()));
}
