import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import {
  PROTECTED_BROWSER_CAPABILITY_METHODS,
  protectedBrowserWorldBootstrapSource
} from "@/lib/application-browser/protected-browser-world";

const REPOSITORY_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const SESSION_PATH = "lib/application-browser/protected-browser-session.ts";
const WORLD_PATH = "lib/application-browser/protected-browser-world.ts";
const PROTECTED_SOURCE_PATHS = [SESSION_PATH, WORLD_PATH] as const;
type ProtectedSourcePath = (typeof PROTECTED_SOURCE_PATHS)[number];

const BASELINE_MISMATCH_MESSAGE =
  "Protected browser source changed. Review the protected-source diff before updating the baseline.";

/*
 * Security model: these hashes deliberately seal the exact, reviewed source
 * bytes. Accidental drift fails CI, any protected-module change requires an
 * explicit baseline edit, and that edit is visible during review.
 *
 * This is not semantic analysis of arbitrary JavaScript, protection against a
 * developer intentionally changing both source and hash, or a substitute for
 * code review.
 *
 * Baseline update rule: change a digest only when its protected module changes,
 * the protected diff receives focused security review, the behavioral
 * protected-session/browser tests are green, and the baseline update is
 * included in that reviewed change. Manual editing is intentional friction.
 */
const SEALED_SOURCE_SHA256: Readonly<Record<ProtectedSourcePath, string>> = {
  [SESSION_PATH]: "723fd0c48d18b46fb4b97fe14b4e46dceccc2cb0b665ef739a1e31dd036ccc39",
  [WORLD_PATH]: "c0134dc427848335d7df7e8689bc95bf8d2b74e834e504001e751f10b86997e3"
};

const EXPECTED_CAPABILITY_METHODS = [
  "handshake",
  "extract",
  "verifyCandidate",
  "disposeCandidate",
  "snapshot",
  "waitForChange",
  "dispose"
] as const;

const EXPECTED_PROTECTED_SESSION_METHODS = [
  "waitUntilReady",
  "extractApplicationForm",
  "verifyCandidate",
  "snapshot",
  "waitForChange",
  "subscribe",
  "close"
] as const;

const REMOVED_WRITER_PATHS = [
  "lib/application-browser/form-fill-dom.ts",
  "lib/application-browser/form-fill-writer.ts"
] as const;

const REMOVED_WRITER_AUTHORITY_NAMES = [
  "form-fill-dom",
  "form-fill-writer",
  "FormFillPreWriteClassification",
  "FormFillPostWriteVerification",
  "FormFillNativeWriteResult",
  "TextLikeFieldType",
  "ApplicationFormFieldWriteInput",
  "ApplicationFormFieldWriteResult",
  "trustedFormFillDomInit",
  "installTrustedFormFillDomCapability",
  "capabilityKeyForHandles",
  "graphHandles",
  "authorizeTrustedFormFillHandles",
  "classifyTextLikeControl",
  "writeNativeValueInput",
  "verifyTextLikeControl",
  "classifySelectOneControl",
  "writeNativeOptionInputChange",
  "verifySelectOneControl",
  "classifyRadioGroup",
  "verifyRadioGroup",
  "classifyCheckboxBoolean",
  "verifyCheckboxBoolean",
  "writeApplicationFormField",
  "registerTrustedFormFillGeneration",
  "armTrustedFormFillOperation"
] as const;

const PROHIBITED_EXPERIMENTAL_LITERALS = ["runImmediately", "uniqueContextId"] as const;
const EXCLUDED_SOURCE_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".superpowers",
  "docs",
  "evaluation-results",
  "node_modules",
  "output",
  "tests"
]);

type SourceFixture = Readonly<{ path: string; source: string }>;

function repositoryPath(path: string): string {
  return join(REPOSITORY_ROOT, path);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSealedSource(path: ProtectedSourcePath, bytes: Uint8Array): void {
  const actual = sha256(bytes);
  assert.equal(
    actual,
    SEALED_SOURCE_SHA256[path],
    BASELINE_MISMATCH_MESSAGE + "\nFile: " + path +
      "\nExpected SHA-256: " + SEALED_SOURCE_SHA256[path] +
      "\nActual SHA-256: " + actual
  );
}

function oneByteChanged(bytes: Uint8Array): Uint8Array {
  assert.ok(bytes.byteLength > 0, "protected source fixture must not be empty");
  const changed = Buffer.from(bytes);
  changed[0] ^= 1;
  return changed;
}

function assertExactCapabilityMethods(methods: readonly string[]): void {
  assert.deepEqual(
    [...methods],
    [...EXPECTED_CAPABILITY_METHODS],
    "Protected browser capability methods must match the exact reviewed read-only allowlist."
  );
}

function protectedSessionPublicMethods(sourceText: string): string[] {
  const source = ts.createSourceFile(SESSION_PATH, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find((statement): statement is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(statement) &&
    statement.name.text === "ProtectedApplicationBrowserSession" &&
    Boolean(statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
  );
  if (!declaration) assert.fail("Exported ProtectedApplicationBrowserSession type alias is missing.");
  const wrapper = declaration.type;
  if (
    !ts.isTypeReferenceNode(wrapper) ||
    !ts.isIdentifier(wrapper.typeName) ||
    wrapper.typeName.text !== "Readonly" ||
    wrapper.typeArguments?.length !== 1
  ) {
    assert.fail("ProtectedApplicationBrowserSession must remain a direct Readonly type literal.");
  }
  const surface = wrapper.typeArguments[0];
  if (!ts.isTypeLiteralNode(surface)) {
    assert.fail("ProtectedApplicationBrowserSession must remain a direct Readonly type literal.");
  }
  return surface.members.map((member) => {
    if (!ts.isMethodSignature(member) || !member.name) {
      assert.fail("ProtectedApplicationBrowserSession may contain only direct method signatures.");
    }
    if (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name)) return member.name.text;
    assert.fail("ProtectedApplicationBrowserSession method names must be static.");
  });
}

function obsoleteWriterViolations(fixtures: readonly SourceFixture[]): string[] {
  const violations: string[] = [];
  for (const fixture of fixtures) {
    if (REMOVED_WRITER_PATHS.includes(fixture.path as (typeof REMOVED_WRITER_PATHS)[number])) {
      violations.push(fixture.path + ": removed writer module exists");
    }
    for (const name of REMOVED_WRITER_AUTHORITY_NAMES) {
      if (fixture.source.includes(name)) violations.push(fixture.path + ": removed writer authority " + name);
    }
  }
  return violations;
}

function assertNoObsoleteWriterSurface(fixtures: readonly SourceFixture[]): void {
  assert.deepEqual(
    obsoleteWriterViolations(fixtures),
    [],
    "Production must not restore or import removed browser-write modules or writer-authority APIs."
  );
}

function assertNoExperimentalLiterals(fixtures: readonly SourceFixture[]): void {
  const violations = fixtures.flatMap((fixture) =>
    PROHIBITED_EXPERIMENTAL_LITERALS
      .filter((literal) => fixture.source.includes(literal))
      .map((literal) => fixture.path + ": prohibited experimental dependency " + literal)
  );
  assert.deepEqual(
    violations,
    [],
    "Protected browser source must not depend on runImmediately or required uniqueContextId."
  );
}

async function productionSourceFixtures(): Promise<SourceFixture[]> {
  const fixtures: SourceFixture[] = [];
  const walk = async (absoluteDirectory: string): Promise<void> => {
    for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name.startsWith(".") || EXCLUDED_SOURCE_DIRECTORIES.has(entry.name))) {
        continue;
      }
      const absolutePath = join(absoluteDirectory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile() && /\.[cm]?[jt]sx?$/u.test(entry.name)) {
        fixtures.push({
          path: relative(REPOSITORY_ROOT, absolutePath),
          source: await readFile(absolutePath, "utf8")
        });
      }
    }
  };
  await walk(REPOSITORY_ROOT);
  return fixtures;
}

test("a one-byte session-source change fails the sealed baseline", async () => {
  const bytes = await readFile(repositoryPath(SESSION_PATH));
  assert.throws(
    () => assertSealedSource(SESSION_PATH, oneByteChanged(bytes)),
    (error: unknown) => error instanceof Error && error.message.includes(BASELINE_MISMATCH_MESSAGE)
  );
});

test("a one-byte world-source change fails the sealed baseline", async () => {
  const bytes = await readFile(repositoryPath(WORLD_PATH));
  assert.throws(
    () => assertSealedSource(WORLD_PATH, oneByteChanged(bytes)),
    (error: unknown) => error instanceof Error && error.message.includes(BASELINE_MISMATCH_MESSAGE)
  );
});

test("the exact current protected production sources match their sealed baselines", async () => {
  for (const path of PROTECTED_SOURCE_PATHS) {
    assertSealedSource(path, await readFile(repositoryPath(path)));
  }
});

test("the protected capability bootstrap exposes exactly the reviewed read-only methods", () => {
  assertExactCapabilityMethods(PROTECTED_BROWSER_CAPABILITY_METHODS);
  assert.ok(
    protectedBrowserWorldBootstrapSource().includes(
      '"methods":' + JSON.stringify(EXPECTED_CAPABILITY_METHODS)
    ),
    "The generated protected-world bootstrap must receive the exact reviewed capability method list."
  );
});

test("an extra protected capability method is rejected", () => {
  assert.throws(
    () => assertExactCapabilityMethods([...EXPECTED_CAPABILITY_METHODS, "submit"]),
    /exact reviewed read-only allowlist/u
  );
});

test("the protected session public API remains the exact reviewed read-only surface", async () => {
  const methods = protectedSessionPublicMethods(await readFile(repositoryPath(SESSION_PATH), "utf8"));
  assert.deepEqual(
    methods,
    [...EXPECTED_PROTECTED_SESSION_METHODS],
    "Protected session public methods must not add filling, writing, interaction, navigation, submission, upload, keyboard, or caller-supplied evaluation authority."
  );
});

test("production contains no removed writer module or writer-authority API", async () => {
  for (const path of REMOVED_WRITER_PATHS) {
    await assert.rejects(access(repositoryPath(path)), { code: "ENOENT" });
  }
  assertNoObsoleteWriterSurface(await productionSourceFixtures());
});

test("representative removed writer paths, imports, and APIs are rejected", () => {
  for (const fixture of [
    { path: REMOVED_WRITER_PATHS[0], source: "" },
    {
      path: "lib/application-browser/coordinator.ts",
      source: 'import { installTrustedFormFillDomCapability } from "@/lib/application-browser/form-fill-dom";'
    },
    {
      path: "lib/application-browser/reintroduced-writer.ts",
      source: "export async function writeApplicationFormField() {}"
    }
  ]) {
    assert.throws(
      () => assertNoObsoleteWriterSurface([fixture]),
      /removed browser-write modules or writer-authority APIs/u
    );
  }
});

test("protected source has no runImmediately or required uniqueContextId dependency", async () => {
  assertNoExperimentalLiterals(await Promise.all(PROTECTED_SOURCE_PATHS.map(async (path) => ({
    path,
    source: await readFile(repositoryPath(path), "utf8")
  }))));
});

test("representative prohibited experimental literals are rejected", () => {
  for (const literal of PROHIBITED_EXPERIMENTAL_LITERALS) {
    assert.throws(
      () => assertNoExperimentalLiterals([{
        path: SESSION_PATH,
        source: "const registration = { " + literal + ": true };"
      }]),
      /must not depend on runImmediately or required uniqueContextId/u
    );
  }
});
