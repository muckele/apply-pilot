import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every place the app, its scripts and Prisma read configuration from.
const SOURCE_ROOTS = [
  "app",
  "components",
  "lib",
  "scripts",
  "prisma",
  "proxy.ts",
  "instrumentation.ts",
  "next.config.mjs"
];
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|prisma)$/;

// Set by the runtime or hosting platform, never by an operator, so they stay out of the examples.
const PLATFORM_VARIABLES = new Set([
  "NODE_ENV",
  "NEXT_RUNTIME",
  "CI",
  "GITHUB_ACTIONS",
  "VERCEL",
  "AWS_LAMBDA_FUNCTION_NAME",
  "K_SERVICE"
]);
const PLATFORM_PREFIXES = ["VERCEL_"];

// Names the guarded migrate runner only deletes from its child environment. They are never read,
// and remote credentials must never be written into repository files (AGENTS.md).
const SCRUBBED_ONLY_VARIABLES = new Set([
  "PRODUCTION_DATABASE_URL",
  "PRODUCTION_DIRECT_URL",
  "RECOVERY_DATABASE_URL",
  "RECOVERY_DIRECT_URL"
]);

// Reads the regular expressions below cannot see (a constant or alias holds the name), plus flags
// introduced by in-flight work packages. Each entry must still appear verbatim in the code or be
// listed in PENDING_FLAGS, so stale entries fail.
const INDIRECT_READS = [
  "NEXTAUTH_URL",
  "MAX_DIRECT_AUDIO_UPLOAD_MB",
  "APPLICATION_RUN_ANSWER_LEGACY_AUDIT",
  "APPLICATION_RUN_ANSWER_LEGACY_AUDIT_DATABASE_URL",
  "COMMIT5_POSTGRES_TEST"
];
const PENDING_FLAGS = ["JOB_SOURCE_REMOTIVE_ENABLED", "JOB_SOURCE_ADZUNA_ENABLED"];

// Local-only tooling and preview switches. Documented in .env.example, never assigned in production.
const LOCAL_ONLY_VARIABLES = new Set([
  "APPLY_PILOT_LOCAL_DESTRUCTIVE",
  "LOCAL_DATABASE_URL",
  "LOCAL_DIRECT_URL",
  "TEST_DATABASE_URL",
  "COMMIT5_POSTGRES_TEST",
  "APPLICATION_RUN_ANSWER_LEGACY_AUDIT",
  "APPLICATION_RUN_ANSWER_LEGACY_AUDIT_DATABASE_URL",
  "APPLY_PILOT_SYNTHETIC_EVIDENCE_PREVIEW",
  "APPLY_PILOT_SYNTHETIC_GENERATED_DOCUMENTS_PREVIEW",
  "APPLY_PILOT_SYNTHETIC_ONE_JOB_PREVIEW"
]);

const READ_PATTERNS = [
  // process.env.NAME and process.env["NAME"]
  /process\.env\??\.([A-Z][A-Z0-9_]*)\b/g,
  /process\.env\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\]/g,
  // injected env objects: env.NAME, environment?.NAME, env["NAME"]
  /\b[A-Za-z]*(?:[eE]nv|[eE]nvironment)\??\.([A-Z][A-Z0-9_]*)\b/g,
  /\b[A-Za-z]*(?:[eE]nv|[eE]nvironment)\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\]/g,
  // helpers such as readPositiveIntEnv("NAME", ...) and Prisma's env("NAME")
  /\bread[A-Za-z]*\(\s*["'`]([A-Z][A-Z0-9_]*)["'`]/g,
  /\benv\(\s*"([A-Z][A-Z0-9_]*)"\s*\)/g
];

function sourceFiles(): string[] {
  const files: string[] = [];
  const visit = (absolute: string) => {
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolute)) {
        if (entry === "node_modules" || entry === ".next") continue;
        visit(path.join(absolute, entry));
      }
    } else if (SOURCE_EXTENSIONS.test(absolute)) {
      files.push(absolute);
    }
  };
  for (const root of SOURCE_ROOTS) {
    const absolute = path.join(repositoryRoot, root);
    if (existsSync(absolute)) visit(absolute);
  }
  return files;
}

// The guarded PostgreSQL runner reads COMMIT5_POSTGRES_TEST through the harness it imports.
const INDIRECT_READ_EXTRA_FILES = ["package.json", "tests/postgres/postgres-test-harness.ts"];

function allSourceText(): string {
  const extra = INDIRECT_READ_EXTRA_FILES.map((file) => path.join(repositoryRoot, file));
  return [...sourceFiles(), ...extra].map((file) => readFileSync(file, "utf8")).join("\n");
}

function referencedVariables(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles()) {
    // `delete env.NAME` scrubs a variable; it is not a read.
    const text = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*delete\s/.test(line))
      .join("\n");
    for (const pattern of READ_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const name = match[1];
        const files = found.get(name) ?? [];
        files.push(path.relative(repositoryRoot, file));
        found.set(name, files);
      }
    }
  }
  return found;
}

function isPlatformVariable(name: string) {
  return PLATFORM_VARIABLES.has(name) || PLATFORM_PREFIXES.some((prefix) => name.startsWith(prefix));
}

type EnvExample = { assigned: Map<string, string>; commented: Set<string>; text: string };

function readEnvExample(name: string): EnvExample {
  const text = readFileSync(path.join(repositoryRoot, name), "utf8");
  const assigned = new Map<string, string>();
  const commented = new Set<string>();
  for (const line of text.split("\n")) {
    const live = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (live) {
      assert.equal(assigned.has(live[1]), false, `${name} assigns ${live[1]} twice`);
      assigned.set(live[1], live[2].replace(/^"(.*)"$/, "$1"));
      continue;
    }
    const documented = /^#\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (documented) commented.add(documented[1]);
  }
  return { assigned, commented, text };
}

function declares(example: EnvExample, name: string) {
  return example.assigned.has(name) || example.commented.has(name);
}

function expectedVariables() {
  const names = new Set<string>([...referencedVariables().keys(), ...INDIRECT_READS, ...PENDING_FLAGS]);
  return [...names].filter((name) => !isPlatformVariable(name) && !SCRUBBED_ONLY_VARIABLES.has(name)).sort();
}

test("the source scan sees direct, injected-env, helper and Prisma reads", () => {
  const names = referencedVariables();
  for (const name of [
    "GEMINI_API_KEY",
    "AUTH_ALLOWED_EMAILS",
    "APPLICATION_AUTOMATION_ENABLED",
    "AI_HARD_CAP_CENTS",
    "CRON_MAX_SOURCES_PER_RUN",
    "LOCAL_DATABASE_URL",
    "DATABASE_URL",
    "DIRECT_URL"
  ]) {
    assert.ok(names.has(name), `scan should find ${name}`);
  }
  assert.equal(names.has("PRODUCTION_DATABASE_URL"), false, "scrub-only deletes are not reads");
});

test("indirect reads in the allowlist are still present in the code", () => {
  const source = allSourceText();
  for (const name of INDIRECT_READS) {
    assert.ok(source.includes(name), `${name} is no longer referenced; remove it from INDIRECT_READS`);
  }
});

test(".env.example documents every environment variable the code reads", () => {
  const example = readEnvExample(".env.example");
  const missing = expectedVariables().filter((name) => !declares(example, name));
  assert.deepEqual(missing, [], `add these to .env.example: ${missing.join(", ")}`);
});

test(".env.production.example documents every runtime variable and assigns no local-only tooling", () => {
  const example = readEnvExample(".env.production.example");
  const missing = expectedVariables().filter(
    (name) => !LOCAL_ONLY_VARIABLES.has(name) && !declares(example, name)
  );
  assert.deepEqual(missing, [], `add these to .env.production.example: ${missing.join(", ")}`);

  const assignedLocalOnly = [...LOCAL_ONLY_VARIABLES].filter((name) => example.assigned.has(name));
  assert.deepEqual(assignedLocalOnly, [], "local-only tooling must never be assigned in production");
});

test("the env examples contain the MVP-critical AI, automation, auth and cron settings", () => {
  for (const file of [".env.example", ".env.production.example"]) {
    const example = readEnvExample(file);
    for (const name of [
      "AI_ENABLED",
      "AI_MOCK_MODE",
      "AI_PROVIDER",
      "GEMINI_API_KEY",
      "GEMINI_FAST_MODEL",
      "GEMINI_QUALITY_MODEL",
      "AI_HARD_CAP_CENTS",
      "AI_AUTOMATION_CAP_CENTS",
      "AI_MAX_REQUEST_COST_CENTS",
      "AI_CONFIRMATION_THRESHOLD_CENTS",
      "APPLICATION_AUTOMATION_ENABLED",
      "CRON_SECRET",
      "AUTH_SECRET",
      "AUTH_URL",
      "AUTH_ALLOWED_EMAILS",
      "AUTH_ALLOW_PUBLIC_SIGNUPS"
    ]) {
      assert.ok(example.assigned.has(name), `${file} should assign ${name}`);
    }
    assert.equal(example.assigned.get("APPLICATION_AUTOMATION_ENABLED"), "false", `${file} automation default`);
    assert.equal(example.assigned.get("AUTH_ALLOW_PUBLIC_SIGNUPS"), "false", `${file} public signups default`);
    assert.equal(example.assigned.get("ALLOW_DEMO_USER"), "false", `${file} demo fallback default`);
  }
});

test("restricted job sources default to off with a compliance pointer", () => {
  for (const file of [".env.example", ".env.production.example"]) {
    const example = readEnvExample(file);
    for (const name of PENDING_FLAGS) {
      assert.equal(example.assigned.get(name), "false", `${file} should default ${name} to false`);
      const lines = example.text.split("\n");
      const index = lines.findIndex((line) => line.startsWith(`${name}=`));
      const comment = lines.slice(Math.max(0, index - 3), index).join("\n");
      assert.match(comment, /compliance: see MVP Bible §6/, `${file} ${name} needs the compliance comment`);
    }
  }
});

test("the env examples hold placeholders only, never real values", () => {
  for (const file of [".env.example", ".env.production.example"]) {
    const example = readEnvExample(file);

    // Connection-string credentials (scheme://USER:PASSWORD@HOST) are checked separately below.
    const withoutUrls = example.text.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "");
    for (const email of withoutUrls.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []) {
      assert.match(email, /@example\.(?:com|org|net)$/, `${file} contains a non-example email address`);
    }

    for (const [name, value] of example.assigned) {
      if (!/(?:SECRET|_KEY|TOKEN|PASSWORD)$/.test(name)) continue;
      assert.ok(
        value === "" || /^(?:replace-with|generate-)/.test(value),
        `${file} ${name} must be empty or an obvious placeholder`
      );
    }

    for (const [name, value] of example.assigned) {
      if (!/DATABASE_URL$|DIRECT_URL$/.test(name)) continue;
      assert.ok(
        /@(?:localhost|127\.0\.0\.1|HOST|DIRECT_HOST)[.:/]/.test(value) || value === "",
        `${file} ${name} must point at localhost or a HOST placeholder`
      );
    }

    // Common live-credential shapes: Google API keys, OpenAI keys, Vercel Blob tokens.
    assert.doesNotMatch(example.text, /AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{16,}|vercel_blob_rw_[A-Za-z0-9]{8,}/);
  }
});
