type VersionEnv = Record<string, string | undefined> & {
  APP_VERSION?: string;
  VERCEL_GIT_COMMIT_SHA?: string;
};

export function getAppVersion(env: VersionEnv = process.env) {
  const vercelCommit = env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (vercelCommit) {
    return vercelCommit.slice(0, 12);
  }

  return env.APP_VERSION?.trim() || null;
}
