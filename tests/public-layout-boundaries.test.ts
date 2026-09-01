import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = process.cwd();

const productPagePaths = [
  "application-runs/[id]/browser/page.tsx",
  "applications/[id]/page.tsx",
  "applications/page.tsx",
  "dashboard/page.tsx",
  "interviews/[id]/page.tsx",
  "interviews/library/page.tsx",
  "interviews/page.tsx",
  "jobs/[id]/page.tsx",
  "jobs/page.tsx",
  "jobs/review/page.tsx",
  "resumes/[id]/page.tsx",
  "resumes/page.tsx",
  "settings/ai/page.tsx",
  "settings/application-answers/page.tsx",
  "settings/integrations/page.tsx",
  "settings/job-sources/page.tsx",
  "settings/profile/page.tsx",
  "tasks/page.tsx"
] as const;

const apiRoutePaths = [
  "app/api/account/delete/route.ts",
  "app/api/account/export/route.ts",
  "app/api/ai/settings/route.ts",
  "app/api/application-answers/[id]/route.ts",
  "app/api/application-answers/route.ts",
  "app/api/application-automation-policy/route.ts",
  "app/api/application-runs/[id]/answer-packet/rebuild/route.ts",
  "app/api/application-runs/[id]/answer-packet/route.ts",
  "app/api/application-runs/[id]/answers/[answerId]/document-export/route.ts",
  "app/api/application-runs/[id]/answers/[answerId]/review/route.ts",
  "app/api/application-runs/[id]/cancel/route.ts",
  "app/api/application-runs/[id]/execution-token/route.ts",
  "app/api/application-runs/[id]/execution-tokens/[tokenId]/route.ts",
  "app/api/application-runs/[id]/form-inspection/route.ts",
  "app/api/application-runs/[id]/prepare/route.ts",
  "app/api/application-runs/[id]/resolve-review/route.ts",
  "app/api/application-runs/[id]/route.ts",
  "app/api/application-runs/route.ts",
  "app/api/applications/[id]/route.ts",
  "app/api/applications/route.ts",
  "app/api/auth/[...nextauth]/route.ts",
  "app/api/browser-capture/answers/route.ts",
  "app/api/browser-capture/route.ts",
  "app/api/browser-capture/tokens/[id]/route.ts",
  "app/api/browser-capture/tokens/route.ts",
  "app/api/contacts/route.ts",
  "app/api/cron/job-discovery/route.ts",
  "app/api/documents/export/route.ts",
  "app/api/email/draft-reply/route.ts",
  "app/api/generated-documents/[id]/route.ts",
  "app/api/gmail/callback/route.ts",
  "app/api/gmail/connect/route.ts",
  "app/api/gmail/disconnect/route.ts",
  "app/api/gmail/search/route.ts",
  "app/api/gmail/status/route.ts",
  "app/api/gmail/triage/route.ts",
  "app/api/health/readiness/route.ts",
  "app/api/health/route.ts",
  "app/api/interview-library/questions/[id]/route.ts",
  "app/api/interview-library/questions/route.ts",
  "app/api/interview-library/star-stories/[id]/route.ts",
  "app/api/interview-library/star-stories/route.ts",
  "app/api/interviews/[id]/audio/complete/route.ts",
  "app/api/interviews/[id]/audio/route.ts",
  "app/api/interviews/[id]/audio/upload/route.ts",
  "app/api/interviews/[id]/feedback/route.ts",
  "app/api/interviews/[id]/route.ts",
  "app/api/interviews/route.ts",
  "app/api/job-sources/[id]/route.ts",
  "app/api/job-sources/[id]/sync/route.ts",
  "app/api/job-sources/[id]/test/route.ts",
  "app/api/job-sources/route.ts",
  "app/api/jobs/[id]/cover-letter/route.ts",
  "app/api/jobs/[id]/match/route.ts",
  "app/api/jobs/[id]/status/route.ts",
  "app/api/jobs/[id]/tailored-resume/route.ts",
  "app/api/jobs/discover/route.ts",
  "app/api/jobs/import/route.ts",
  "app/api/jobs/sync/route.ts",
  "app/api/profile/route.ts",
  "app/api/resume-versions/[id]/route.ts",
  "app/api/resumes/parse/route.ts",
  "app/api/tasks/[id]/route.ts"
] as const;

function absolutePath(relativePath: string) {
  return path.join(repositoryRoot, relativePath);
}

function readSource(relativePath: string) {
  return readFileSync(absolutePath(relativePath), "utf8");
}

function collectRouteHandlers(directory: string): string[] {
  return readdirSync(absolutePath(directory), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(directory, entry.name);

    if (entry.isDirectory()) {
      return collectRouteHandlers(relativePath);
    }

    return entry.isFile() && entry.name === "route.ts" ? [relativePath] : [];
  });
}

test("root layout delegates AppShell ownership without pathname switching", () => {
  const source = readSource("app/layout.tsx");

  assert.doesNotMatch(source, /@\/components\/app-shell/);
  assert.doesNotMatch(source, /<AppShell\b/);
  assert.doesNotMatch(source, /\b(?:usePathname|pathname)\b/);
});

test("public layout owns the root and login pages without AppShell", () => {
  const publicLayoutPath = "app/(public)/layout.tsx";

  assert.equal(existsSync(absolutePath(publicLayoutPath)), true);
  assert.equal(existsSync(absolutePath("app/(public)/page.tsx")), true);
  assert.equal(existsSync(absolutePath("app/(public)/login/page.tsx")), true);
  assert.equal(existsSync(absolutePath("app/page.tsx")), false);
  assert.equal(existsSync(absolutePath("app/login/page.tsx")), false);

  const source = readSource(publicLayoutPath);
  assert.doesNotMatch(source, /@\/components\/app-shell/);
  assert.doesNotMatch(source, /<AppShell\b/);
});

test("product layout owns AppShell and every authenticated product page", () => {
  const productLayoutPath = "app/(product)/layout.tsx";

  assert.equal(existsSync(absolutePath(productLayoutPath)), true);

  const source = readSource(productLayoutPath);
  assert.match(source, /@\/components\/app-shell/);
  assert.match(source, /<AppShell\b/);

  for (const pagePath of productPagePaths) {
    assert.equal(existsSync(absolutePath(path.posix.join("app/(product)", pagePath))), true, pagePath);
    assert.equal(existsSync(absolutePath(path.posix.join("app", pagePath))), false, pagePath);
  }
});

test("the complete API route-handler inventory remains outside route groups", () => {
  const actualRoutes = collectRouteHandlers("app/api").sort();

  assert.deepEqual(actualRoutes, [...apiRoutePaths].sort());
  assert.equal(actualRoutes.length, 63);
  assert.equal(actualRoutes.some((routePath) => routePath.includes("/(public)/")), false);
  assert.equal(actualRoutes.some((routePath) => routePath.includes("/(product)/")), false);
});
