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
  [SESSION_PATH]: "7a700c97bf940796167396c96f1626143e25381dac83e84c33f1652676c76ea7",
  [WORLD_PATH]: "a84acce8abc338002c4fc0bcf7b21fe7d026ff84ccfb3ecd6a155f1b051c8d0d"
};

const EXPECTED_CAPABILITY_METHODS = [
  "handshake",
  "extract",
  "sealCandidateWriterTargets",
  "verifyCandidate",
  "writeCandidateField",
  "disposeCandidate",
  "snapshot",
  "waitForChange",
  "dispose"
] as const;

const EXPECTED_PROTECTED_SESSION_METHODS = [
  "waitUntilReady",
  "extractApplicationForm",
  "verifyCandidate",
  "writeCandidateField",
  "snapshot",
  "waitForChange",
  "subscribe",
  "close"
] as const;

/*
 * The protected V2 contract exports semantic labels, constraints, and option
 * labels, never live/default control contents or selection/file state. The
 * atomic writer may read current value/selection only through its exact sealed
 * native-accessor paths; direct control member reads remain prohibited.
 * Contenteditable and role-based applicant text must pass through the world's
 * node-by-node applicant-content filter, so unfiltered bulk text getters are
 * also forbidden. This is a deliberately syntactic, protected-world-only rule;
 * the exact source seal separately preserves the reviewed filtering algorithm.
 */
const PROHIBITED_PROTECTED_APPLICANT_READ_MEMBERS = [
  "value",
  "defaultValue",
  "valueAsDate",
  "valueAsNumber",
  "checked",
  "defaultChecked",
  "files",
  "selected",
  "defaultSelected",
  "selectedIndex",
  "selectedOptions",
  "textContent",
  "innerText"
] as const;

const PROHIBITED_PROTECTED_APPLICANT_STATE_ATTRIBUTES = [
  "value",
  "checked",
  "selected"
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
const REACHABILITY_EXCLUDED_SOURCE_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".superpowers",
  "node_modules"
]);

type SourceFixture = Readonly<{ path: string; source: string }>;

function productionInspectionAuthorityViolations(
  fixtures: readonly SourceFixture[],
  rootPath = "scripts/application-browser-companion.ts"
): string[] {
  const sources = new Map(fixtures.map((fixture) => [fixture.path, fixture.source]));
  const forbiddenIdentifiers = new Set([
    "extractSafeApplicationForm",
    "SafeApplicationFormExtraction",
    "SafeDomFieldReference",
    "createPageSemanticObserver",
    "OwnedFormSemanticObserver",
    "ElementHandle",
    "isHandleAttached"
  ]);
  const violations = new Set<string>();
  const reachable = new Set<string>();

  if (!sources.has(rootPath)) {
    violations.add(`${rootPath}: production inspection graph root is missing`);
  }

  const normalizedRepositoryPath = (value: string): string =>
    value.replaceAll("\\", "/").replace(/^\.\//u, "");

  const isRepositoryLocalSpecifier = (specifier: string): boolean =>
    specifier.startsWith("@/") || specifier.startsWith(".");

  const resolveLocalModule = (importer: string, specifier: string): string | null => {
    let base: string;
    if (specifier.startsWith("@/")) {
      base = specifier.slice(2);
    } else if (specifier.startsWith(".")) {
      base = normalizedRepositoryPath(join(dirname(importer), specifier));
    } else {
      return null;
    }
    if (base === ".." || base.startsWith("../") || base.startsWith("/")) return null;
    const withoutRuntimeExtension = base.replace(/\.[cm]?js$/u, "");
    const candidates = /\.[cm]?[jt]sx?$/u.test(base)
      ? [base]
      : [
          `${withoutRuntimeExtension}.ts`,
          `${withoutRuntimeExtension}.tsx`,
          `${withoutRuntimeExtension}/index.ts`,
          `${withoutRuntimeExtension}/index.tsx`
        ];
    return candidates.map(normalizedRepositoryPath).find((candidate) => sources.has(candidate)) ?? null;
  };

  const importedSpecifiers = (path: string, sourceText: string): string[] => {
    const sourceFile = ts.createSourceFile(
      path,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const specifiers: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        specifiers.push(node.moduleSpecifier.text);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteralLike(node.moduleReference.expression)
      ) {
        specifiers.push(node.moduleReference.expression.text);
      } else if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLike(node.argument.literal)
      ) {
        specifiers.push(node.argument.literal.text);
      } else if (
        ts.isCallExpression(node) &&
        node.arguments.length >= 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        if (
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (
            node.arguments.length === 1 &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "require"
          )
        ) {
          specifiers.push(node.arguments[0].text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return specifiers;
  };

  const visitReachability = (path: string): void => {
    if (reachable.has(path)) return;
    reachable.add(path);
    const sourceText = sources.get(path);
    if (sourceText === undefined) return;
    for (const specifier of importedSpecifiers(path, sourceText)) {
      const resolved = resolveLocalModule(path, specifier);
      if (resolved) {
        visitReachability(resolved);
      } else if (isRepositoryLocalSpecifier(specifier)) {
        violations.add(`${path}: unresolved repository-local import ${specifier}`);
      }
    }
  };
  visitReachability(rootPath);

  for (const path of [...reachable].sort()) {
    const sourceText = sources.get(path);
    if (sourceText === undefined) continue;
    if (path === "lib/application-browser/form-inspection-dom.ts") {
      violations.add(`${path}: reachable legacy inspection module form-inspection-dom.ts`);
    }
    const sourceFile = ts.createSourceFile(
      path,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const inspect = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) {
        violations.add(`${path}: forbidden inspection authority ${node.text}`);
      }
      if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        const propertyName = node.propertyName;
        const member = propertyName
          ? ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName)
            ? propertyName.text
            : ts.isComputedPropertyName(propertyName) &&
                ts.isStringLiteralLike(propertyName.expression)
              ? propertyName.expression.text
              : null
          : !node.dotDotDotToken && ts.isIdentifier(node.name)
            ? node.name.text
            : null;
        if (member === "evaluate" || member === "evaluateHandle") {
          violations.add(`${path}: forbidden inspection authority .${member}`);
        }
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const member = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)
            ? node.argumentExpression.text
            : null;
        if (member === "evaluate" || member === "evaluateHandle") {
          violations.add(`${path}: forbidden inspection authority .${member}`);
        }
      }
      if (ts.isCallExpression(node)) {
        let method: string | null = null;
        if (ts.isPropertyAccessExpression(node.expression)) {
          method = node.expression.name.text;
        } else if (
          ts.isElementAccessExpression(node.expression) &&
          node.expression.argumentExpression &&
          ts.isStringLiteralLike(node.expression.argumentExpression)
        ) {
          method = node.expression.argumentExpression.text;
        }
        if (method === "evaluate" || method === "evaluateHandle") {
          violations.add(`${path}: forbidden inspection call .${method}()`);
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(sourceFile);
  }

  return [...violations].sort();
}

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
    "Protected browser capability methods must match the exact reviewed V2 allowlist."
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

function protectedWorldApplicantReadViolations(sourceText: string): string[] {
  const prohibitedMembers = new Set<string>(PROHIBITED_PROTECTED_APPLICANT_READ_MEMBERS);
  const prohibitedAttributes = new Set<string>(PROHIBITED_PROTECTED_APPLICANT_STATE_ATTRIBUTES);
  const source = ts.createSourceFile(
    WORLD_PATH,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const violations = new Set<string>();

  const staticName = (node: ts.Node | undefined): string | null => {
    if (!node) return null;
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
    if (ts.isComputedPropertyName(node)) return staticName(node.expression);
    return null;
  };
  const memberName = (node: ts.Expression): string | null => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) return staticName(node.argumentExpression);
    return null;
  };
  const isInsideAtomicWriter = (node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (ts.isMethodDeclaration(current)) {
        return staticName(current.name) === "writeCandidateField";
      }
    }
    return false;
  };
  const isApprovedProposalValueRead = (node: ts.Expression): boolean => {
    if (!ts.isPropertyAccessExpression(node) || node.name.text !== "value" || !isInsideAtomicWriter(node)) {
      return false;
    }
    let proposal: ts.Expression = node.expression;
    while (
      ts.isAsExpression(proposal) ||
      ts.isTypeAssertionExpression(proposal) ||
      ts.isParenthesizedExpression(proposal) ||
      ts.isNonNullExpression(proposal)
    ) {
      proposal = proposal.expression;
    }
    return ts.isPropertyAccessExpression(proposal) &&
      proposal.name.text === "proposal" &&
      ts.isIdentifier(proposal.expression) &&
      proposal.expression.text === "request";
  };
  const addViolation = (node: ts.Node, detail: string): void => {
    const location = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.add(`${WORLD_PATH}:${location.line + 1}:${location.character + 1}: ${detail}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const member = memberName(node);
      if (member && prohibitedMembers.has(member) && !isApprovedProposalValueRead(node)) {
        addViolation(node, `prohibited applicant-current member read ${member}`);
      }
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const member = node.propertyName
        ? staticName(node.propertyName)
        : ts.isIdentifier(node.name)
          ? node.name.text
          : null;
      if (member && prohibitedMembers.has(member)) {
        addViolation(node, `prohibited applicant-current destructuring read ${member}`);
      }
    }

    if (ts.isCallExpression(node)) {
      const method = memberName(node.expression);
      if (
        method === "get" &&
        (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Reflect"
      ) {
        const member = staticName(node.arguments[1]);
        if (member && prohibitedMembers.has(member)) {
          addViolation(node, `prohibited reflected applicant-current read ${member}`);
        }
      }

      const attributeNameArgument = method === "getAttribute" || method === "hasAttribute"
        ? node.arguments[0]
        : method === "getAttributeNS" || method === "hasAttributeNS"
          ? node.arguments[1]
          : undefined;
      const attribute = staticName(attributeNameArgument);
      if (attribute && prohibitedAttributes.has(attribute.toLowerCase())) {
        addViolation(node, `prohibited applicant-state attribute read ${attribute.toLowerCase()}`);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...violations].sort();
}

const WRITER_ONLY_CURRENT_INTRINSICS = [
  "nativeInputValueGet",
  "nativeInputValueSet",
  "nativeInputReadOnlyGet",
  "nativeInputDisabledGet",
  "nativeInputTypeGet",
  "nativeTextAreaValueGet",
  "nativeTextAreaValueSet",
  "nativeTextAreaReadOnlyGet",
  "nativeTextAreaDisabledGet",
  "nativeSelectMultipleGet",
  "nativeSelectDisabledGet",
  "nativeOptionSelectedGet",
  "nativeOptionSelectedSet",
  "nativeOptionValueGet",
  "nativeOptionDisabledGet",
  "nativeMatches"
] as const;

function protectedWorldAtomicWriterViolations(sourceText: string): string[] {
  const source = ts.createSourceFile(
    WORLD_PATH,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const violations = new Set<string>();
  const writers: ts.MethodDeclaration[] = [];
  const writerOnlyIntrinsics = new Set<string>(WRITER_ONLY_CURRENT_INTRINSICS);
  const prohibitedCalls = new Set([
    "assign", "back", "blur", "check", "click", "dispatchEvent", "evaluate",
    "fill", "focus", "forward", "getElementById", "getElementsByClassName",
    "getElementsByName", "getElementsByTagName", "getRootNode", "go", "hover",
    "matches", "navigate", "open", "press", "querySelector", "querySelectorAll",
    "reload", "replace", "requestSubmit", "selectOption", "setInputFiles",
    "submit", "tap", "then", "catch", "closest", "dblclick", "finally",
    "type", "uncheck"
  ]);
  const prohibitedIdentifiers = new Set([
    "BroadcastChannel", "CustomEvent", "Event", "EventSource", "Function",
    "InputEvent", "KeyboardEvent", "MouseEvent", "PointerEvent", "Promise",
    "SharedWorker", "TouchEvent", "Worker", "XMLHttpRequest", "WebSocket",
    "eval", "fetch", "queueMicrotask", "requestAnimationFrame",
    "requestIdleCallback", "sendBeacon", "setImmediate", "setInterval", "setTimeout"
  ]);
  const staticName = (node: ts.Node | undefined): string | null => {
    if (!node) return null;
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
    if (ts.isComputedPropertyName(node)) return staticName(node.expression);
    return null;
  };
  const enclosingWriter = (node: ts.Node): ts.MethodDeclaration | null => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (ts.isMethodDeclaration(current) && staticName(current.name) === "writeCandidateField") {
        return current;
      }
    }
    return null;
  };
  const memberName = (node: ts.Expression): string | null => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node)) return staticName(node.argumentExpression);
    return ts.isIdentifier(node) ? node.text : null;
  };
  const addViolation = (node: ts.Node, detail: string): void => {
    const location = source.getLineAndCharacterOfPosition(node.getStart(source));
    violations.add(`${WORLD_PATH}:${location.line + 1}:${location.character + 1}: ${detail}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && staticName(node.name) === "writeCandidateField") {
      writers.push(node);
      if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
        addViolation(node, "atomic writer must be synchronous");
      }
    }
    const writer = enclosingWriter(node);
    if (writer) {
      if (
        ts.isFunctionLike(node) &&
        ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      ) {
        addViolation(node, "atomic writer may not contain an async function");
      }
      if (
        (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)) &&
        node.asteriskToken
      ) {
        addViolation(node, "atomic writer may not contain a generator");
      }
      if (ts.isAwaitExpression(node) || ts.isYieldExpression(node)) {
        addViolation(node, "atomic writer may not await or yield");
      }
      if (
        (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "Promise" || prohibitedIdentifiers.has(node.expression.text))
      ) {
        addViolation(node, `atomic writer prohibited call ${node.expression.text}`);
      }
      if (ts.isCallExpression(node)) {
        const called = memberName(node.expression);
        if (called && prohibitedCalls.has(called)) {
          addViolation(node, `atomic writer prohibited method ${called}`);
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "Promise"
        ) {
          addViolation(node, "atomic writer prohibited call Promise");
        }
      }
      if (ts.isIdentifier(node) && prohibitedIdentifiers.has(node.text)) {
        addViolation(node, `atomic writer prohibited authority ${node.text}`);
      }
    }
    if (ts.isIdentifier(node) && writerOnlyIntrinsics.has(node.text)) {
      const isDeclaration = ts.isVariableDeclaration(node.parent) && node.parent.name === node;
      const isAvailabilityCheck = ts.isTypeOfExpression(node.parent);
      if (!isDeclaration && !isAvailabilityCheck && !writer) {
        addViolation(node, `writer current-state intrinsic escaped atomic writer: ${node.text}`);
      }
      if (writer && !(
        ts.isCallExpression(node.parent) &&
        node.parent.arguments[0] === node &&
        ts.isIdentifier(node.parent.expression) &&
        node.parent.expression.text === "nativeApply"
      )) {
        addViolation(node, `writer current-state intrinsic has non-nativeApply use: ${node.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  if (writers.length !== 1) {
    violations.add(`${WORLD_PATH}: expected exactly one atomic writeCandidateField method`);
  } else {
    const writer = writers[0];
    const setterCounts = new Map<string, number>([
      ["nativeInputValueSet", 0],
      ["nativeTextAreaValueSet", 0],
      ["nativeOptionSelectedSet", 0]
    ]);
    let dispatchCount = 0;
    const eventTypes: string[] = [];
    const count = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "nativeApply" &&
        ts.isIdentifier(node.arguments[0])
      ) {
        const name = node.arguments[0].text;
        if (setterCounts.has(name)) setterCounts.set(name, (setterCounts.get(name) ?? 0) + 1);
        if (name === "nativeDispatchEvent") dispatchCount += 1;
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "NativeEvent"
      ) {
        const eventType = node.arguments?.[0];
        eventTypes.push(eventType && ts.isStringLiteralLike(eventType) ? eventType.text : "<dynamic>");
      }
      ts.forEachChild(node, count);
    };
    count(writer);
    for (const [name, countValue] of setterCounts) {
      if (countValue !== 1) violations.add(`${WORLD_PATH}: atomic writer must contain exactly one ${name} call site`);
    }
    if (dispatchCount !== 3) {
      violations.add(`${WORLD_PATH}: atomic writer must contain exactly three bounded event dispatch call sites`);
    }
    if (JSON.stringify(eventTypes) !== JSON.stringify(["input", "input", "change"])) {
      violations.add(`${WORLD_PATH}: atomic writer event constructors must remain [input,input,change]`);
    }
  }
  return [...violations].sort();
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

async function sourceFixtures(input: Readonly<{
  excludedDirectories: ReadonlySet<string>;
  excludeHiddenDirectories: boolean;
}>): Promise<SourceFixture[]> {
  const fixtures: SourceFixture[] = [];
  const walk = async (absoluteDirectory: string): Promise<void> => {
    for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
      if (
        entry.isDirectory() && (
          input.excludedDirectories.has(entry.name) ||
          (input.excludeHiddenDirectories && entry.name.startsWith("."))
        )
      ) {
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

async function productionSourceFixtures(): Promise<SourceFixture[]> {
  return sourceFixtures({
    excludedDirectories: EXCLUDED_SOURCE_DIRECTORIES,
    excludeHiddenDirectories: true
  });
}

async function productionReachabilityFixtures(): Promise<SourceFixture[]> {
  return sourceFixtures({
    excludedDirectories: REACHABILITY_EXCLUDED_SOURCE_DIRECTORIES,
    excludeHiddenDirectories: false
  });
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

test("the protected isolated world confines applicant-current reads to the atomic writer", async () => {
  assert.deepEqual(
    protectedWorldApplicantReadViolations(await readFile(repositoryPath(WORLD_PATH), "utf8")),
    [],
    "Protected inspection must not read current/default control state outside the reviewed writer-local native-accessor paths."
  );
});

test("representative protected applicant-current reads are rejected", () => {
  for (const member of PROHIBITED_PROTECTED_APPLICANT_READ_MEMBERS) {
    const violations = protectedWorldApplicantReadViolations(
      `function syntheticProtectedInspection(surface: object) { void surface.${member}; }`
    );
    assert.ok(
      violations.some((violation) => violation.includes(member)),
      `missing synthetic applicant-current violation for ${member}`
    );
  }

  for (const attribute of PROHIBITED_PROTECTED_APPLICANT_STATE_ATTRIBUTES) {
    const violations = protectedWorldApplicantReadViolations(
      `function syntheticProtectedInspection(input: Element) { void input.getAttribute("${attribute}"); }`
    );
    assert.ok(
      violations.some((violation) => violation.includes(`attribute read ${attribute}`)),
      `missing synthetic applicant-state attribute violation for ${attribute}`
    );
  }

  const alternateForms = protectedWorldApplicantReadViolations(`
    function syntheticProtectedInspection(input: object, option: object) {
      void input["checked"];
      const { files } = input as { files: unknown };
      void Reflect.get(option, "selected");
    }
  `);
  for (const member of ["checked", "files", "selected"]) {
    assert.ok(
      alternateForms.some((violation) => violation.includes(member)),
      `missing alternate-syntax applicant-current violation for ${member}`
    );
  }

  const writerDirectRead = protectedWorldApplicantReadViolations(`
    class SyntheticCapability {
      writeCandidateField(control: HTMLInputElement) {
        void control.value;
      }
    }
  `);
  assert.ok(
    writerDirectRead.some((violation) => violation.includes("member read value")),
    "the writer may not bypass its reviewed native-accessor path"
  );
});

test("protected semantic, filtered text, and proposal payload reads remain permitted", () => {
  assert.deepEqual(protectedWorldApplicantReadViolations(`
    class SyntheticCapability {
      writeCandidateField(request: { proposal: { value: string } }) {
        void (request.proposal as Readonly<{ value: string }>).value;
      }
      inspect(
        input: HTMLInputElement,
        option: HTMLOptionElement,
        node: Node,
        element: HTMLElement
      ) {
        void input.type;
        void input.required;
        void input.getAttribute("autocomplete");
        void option.getAttribute("label");
        void node.nodeValue;
        void element.isContentEditable;
      }
    }
  `), []);
});

test("the protected world preserves the exact synchronous atomic-writer shape", async () => {
  assert.deepEqual(
    protectedWorldAtomicWriterViolations(await readFile(repositoryPath(WORLD_PATH), "utf8")),
    [],
    "The protected writer must remain synchronous, selector-free, one-mutation, and bounded to its exact native event paths."
  );
});

test("representative asynchronous and generic browser writer authority is rejected", () => {
  const violations = protectedWorldAtomicWriterViolations(`
    class SyntheticCapability {
      async writeCandidateField(control: HTMLElement, form: HTMLFormElement) {
        await Promise.resolve();
        setTimeout(() => undefined, 0);
        void fetch("/");
        document.querySelector("input");
        document.getElementById("target");
        control.click();
        control.focus();
        control.dispatchEvent(new MouseEvent("click"));
        form.submit();
      }
    }
  `);

  for (const expected of [
    "must be synchronous",
    "may not await",
    "prohibited call Promise",
    "prohibited call setTimeout",
    "prohibited call fetch",
    "prohibited method querySelector",
    "prohibited method getElementById",
    "prohibited method click",
    "prohibited method focus",
    "prohibited method dispatchEvent",
    "prohibited authority MouseEvent",
    "prohibited method submit"
  ]) {
    assert.ok(
      violations.some((violation) => violation.includes(expected)),
      `missing synthetic atomic-writer violation: ${expected}`
    );
  }
});

test("writer current-state intrinsics cannot escape or bypass nativeApply", () => {
  const violations = protectedWorldAtomicWriterViolations(`
    const nativeInputValueGet = () => "";
    const nativeInputValueSet = () => undefined;
    const nativeTextAreaValueGet = () => "";
    const nativeTextAreaValueSet = () => undefined;
    const nativeOptionSelectedGet = () => false;
    const nativeOptionSelectedSet = () => undefined;
    const nativeOptionValueGet = () => "";
    function leak() { void nativeInputValueGet; }
    class SyntheticCapability {
      writeCandidateField() { void nativeOptionValueGet; }
    }
  `);

  assert.ok(
    violations.some((violation) => violation.includes("escaped atomic writer: nativeInputValueGet")),
    "current-state getters must not escape the atomic writer"
  );
  assert.ok(
    violations.some((violation) => violation.includes("non-nativeApply use: nativeOptionValueGet")),
    "current-state access inside the writer must use nativeApply"
  );
});

test("the protected capability bootstrap exposes exactly the reviewed V2 methods", () => {
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
    /exact reviewed V2 allowlist/u
  );
});

test("the protected session public API remains the exact reviewed V2 surface", async () => {
  const methods = protectedSessionPublicMethods(await readFile(repositoryPath(SESSION_PATH), "utf8"));
  assert.deepEqual(
    methods,
    [...EXPECTED_PROTECTED_SESSION_METHODS],
    "Protected session public methods must match the exact bounded V2 surface and must not add generic interaction, navigation, submission, upload, keyboard, or caller-supplied evaluation authority."
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

test("synthetic alias and relative reachability detects the legacy DOM inspection module", () => {
  const violations = productionInspectionAuthorityViolations([
    {
      path: "scripts/application-browser-companion.ts",
      source: 'import "@/lib/application-browser/inspection-entry";'
    },
    {
      path: "lib/application-browser/inspection-entry.ts",
      source: 'export * from "./form-inspection-dom";'
    },
    {
      path: "lib/application-browser/form-inspection-dom.ts",
      source: "export function extractSafeApplicationForm() {}"
    }
  ]);

  assert.ok(violations.some((violation) => violation.includes("form-inspection-dom.ts")));
  assert.ok(violations.some((violation) => violation.includes("extractSafeApplicationForm")));
});

test("synthetic extensionless index TSX reachability detects every forbidden inspection authority", () => {
  const violations = productionInspectionAuthorityViolations([
    {
      path: "scripts/application-browser-companion.ts",
      source: 'import "../lib/inspection-authority";'
    },
    {
      path: "lib/inspection-authority/index.tsx",
      source: `
        type A = SafeApplicationFormExtraction;
        type B = SafeDomFieldReference;
        type C = OwnedFormSemanticObserver;
        type D = ElementHandle;
        const observer = createPageSemanticObserver;
        const attached = isHandleAttached;
        page.evaluateHandle(() => null);
        remoteHandle.evaluate(() => null);
      `
    }
  ]);

  for (const authority of [
    "SafeApplicationFormExtraction",
    "SafeDomFieldReference",
    "OwnedFormSemanticObserver",
    "ElementHandle",
    "createPageSemanticObserver",
    "isHandleAttached",
    ".evaluateHandle()",
    ".evaluate()"
  ]) {
    assert.ok(
      violations.some((violation) => violation.includes(authority)),
      `missing synthetic violation for ${authority}`
    );
  }
});

test("synthetic bound and indirect evaluate access cannot alias forbidden inspection authority", () => {
  const violations = productionInspectionAuthorityViolations([
    {
      path: "scripts/application-browser-companion.ts",
      source: 'import "@/lib/application-browser/inspection-alias";'
    },
    {
      path: "lib/application-browser/inspection-alias.ts",
      source: `
        const invoke = page.evaluate.bind(page);
        const invokeHandle = remoteHandle["evaluateHandle"].call(remoteHandle, () => null);
        void invoke;
        void invokeHandle;
      `
    }
  ]);

  assert.ok(violations.some((violation) => violation.includes(".evaluate")));
  assert.ok(violations.some((violation) => violation.includes(".evaluateHandle")));
});

test("synthetic object destructuring cannot alias forbidden inspection authority", () => {
  const violations = productionInspectionAuthorityViolations([
    {
      path: "scripts/application-browser-companion.ts",
      source: 'import "@/lib/application-browser/destructured-inspection";'
    },
    {
      path: "lib/application-browser/destructured-inspection.ts",
      source: `
        const { evaluate: invoke } = page;
        const { evaluateHandle } = remoteHandle;
        void invoke;
        void evaluateHandle;
      `
    }
  ]);

  assert.ok(violations.some((violation) => violation.includes(".evaluate")));
  assert.ok(violations.some((violation) => violation.includes(".evaluateHandle")));
});

test("synthetic unresolved repository-local imports fail the reachability graph closed", () => {
  const violations = productionInspectionAuthorityViolations([{
    path: "scripts/application-browser-companion.ts",
    source: 'export * from "@/tests/inspection-bridge";'
  }]);

  assert.ok(violations.some((violation) => violation.includes("unresolved repository-local import")));
});

test("synthetic two-argument dynamic imports remain in the reachability graph", () => {
  const violations = productionInspectionAuthorityViolations([
    {
      path: "scripts/application-browser-companion.ts",
      source: 'void import("@/lib/application-browser/dynamic-inspection", {});'
    },
    {
      path: "lib/application-browser/dynamic-inspection.ts",
      source: "type LegacyAuthority = ElementHandle;"
    }
  ]);

  assert.ok(violations.some((violation) => violation.includes("ElementHandle")));
});

test("synthetic import type nodes remain in the reachability graph", () => {
  const violations = productionInspectionAuthorityViolations([
    {
      path: "scripts/application-browser-companion.ts",
      source: 'type LegacyOracle = typeof import("@/lib/application-browser/form-inspection-dom");'
    },
    {
      path: "lib/application-browser/form-inspection-dom.ts",
      source: "export const legacyOracle = true;"
    }
  ]);

  assert.ok(violations.some((violation) => violation.includes("form-inspection-dom.ts")));
});

test("reachability inventory retains repository-local TS and TSX bridge directories", async () => {
  const inventory = new Set((await productionReachabilityFixtures()).map((fixture) => fixture.path));

  assert.equal(inventory.has("tests/application-browser-no-submit-policy.test.ts"), true);
});

test("synthetic reachability traverses a repository-local tests-directory bridge", () => {
  const violations = productionInspectionAuthorityViolations([
    {
      path: "scripts/application-browser-companion.ts",
      source: 'import "@/tests/inspection-bridge";'
    },
    {
      path: "tests/inspection-bridge.ts",
      source: 'export * from "../lib/application-browser/form-inspection-dom";'
    },
    {
      path: "lib/application-browser/form-inspection-dom.ts",
      source: "export function extractSafeApplicationForm() {}"
    }
  ]);

  assert.ok(violations.some((violation) => violation.includes("form-inspection-dom.ts")));
});

test("sealed CDP Runtime.evaluate strings are not mistaken for Playwright or handle authority", () => {
  assert.deepEqual(productionInspectionAuthorityViolations([
    {
      path: "scripts/application-browser-companion.ts",
      source: 'import "@/lib/application-browser/protected-browser-session";'
    },
    {
      path: "lib/application-browser/protected-browser-session.ts",
      source: 'cdp.send("Runtime.evaluate", { expression: "safe sealed source" });'
    }
  ]), []);
});

test("the companion production graph cannot reach legacy inspection authority", async () => {
  assert.deepEqual(
    productionInspectionAuthorityViolations(await productionReachabilityFixtures()),
    [],
    "Production INSPECT_FORM reachability must remain protected-only."
  );
});
