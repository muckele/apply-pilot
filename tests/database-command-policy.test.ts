import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import ts from "typescript";

const repositoryRoot = process.cwd();
const localUrl = "postgresql://postgres:postgres@127.0.0.1:55433/apply_pilot_local_dev?schema=public";
const neonUrl = "postgresql://user:SUBPROCESS_SECRET@ep-example.us-east-1.aws.neon.tech/apply_pilot_local_dev?sslmode=require";

const approvedSourceHashes = {
  "scripts/run-local-prisma-migrate.ts": "9dd734a6a59519ff788735c67570bb95c5414e343af49ee35b1e3d44a40e6d78",
  "scripts/run-postgres-tests.ts": "824337659cfde24eea93d4680a42972ea39993f298f36a9200024f98c97cfbe1"
} as const;

type ApprovedSourcePath = keyof typeof approvedSourceHashes;

const databaseAuthorityVariables = [
  "DATABASE_URL",
  "DIRECT_URL",
  "TEST_DATABASE_URL",
  "LOCAL_DATABASE_URL",
  "LOCAL_DIRECT_URL",
  "PRODUCTION_DATABASE_URL",
  "PRODUCTION_DIRECT_URL",
  "RECOVERY_DATABASE_URL",
  "RECOVERY_DIRECT_URL",
  "APPLY_PILOT_LOCAL_DESTRUCTIVE"
] as const;

const executableScriptExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".yml",
  ".yaml"
]);
const ignoredExecutableDirectories = new Set([".git", ".next", "build", "coverage", "dist", "node_modules"]);

type CapturedProcess = {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
};

type EnvironmentOverrides = Readonly<Record<string, string | undefined>>;
type DestructiveCommand = "db-push" | "migrate-deploy" | "migrate-dev" | "migrate-reset";

type PrismaInvocation = {
  argumentsArray: ts.ArrayLiteralExpression | undefined;
  calleeName: string;
  environment: ts.Expression | undefined;
  functionName: string | undefined;
  kind: DestructiveCommand;
  tokens: string[];
};

function normalizedSourceSha256(source: string): string {
  return createHash("sha256").update(source.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

function withCrlfLineEndings(source: string): string {
  return source.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

function assertApprovedSourceIntegrity(pathname: ApprovedSourcePath, source: string): void {
  assert.equal(
    normalizedSourceSha256(source),
    approvedSourceHashes[pathname],
    `${pathname} changed; require explicit database-safety review before updating its integrity pin.`
  );
}

function isExecutableScriptFilename(filename: string): boolean {
  const extension = path.extname(filename).toLowerCase();
  return extension === "" || executableScriptExtensions.has(extension);
}

async function executableFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return ignoredExecutableDirectories.has(entry.name) ? [] : executableFiles(entryPath);
      }
      return entry.isFile() && isExecutableScriptFilename(entry.name) ? [entryPath] : [];
    })
  );
  return nested.flat();
}

function cleanEnvironment(
  overrides: EnvironmentOverrides = {},
  parentEnvironment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...parentEnvironment };
  for (const name of databaseAuthorityVariables) delete environment[name];

  // Keep Prisma and dotenv pinned to a synthetic loopback target if a guard regresses far enough to load them.
  environment.DATABASE_URL = localUrl;
  environment.DIRECT_URL = localUrl;

  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  return environment;
}

function detectedProhibitedCommands(source: string): Set<Exclude<DestructiveCommand, "migrate-deploy">> {
  const detected = new Set<Exclude<DestructiveCommand, "migrate-deploy">>();
  const quoted = String.raw`["'\x60]`;
  const token = (value: string) => `${quoted}${value}${quoted}`;
  const separated = (values: string[]) => values.map(token).join(String.raw`\s*,\s*`);
  const patterns: Array<[Exclude<DestructiveCommand, "migrate-deploy">, RegExp[]]> = [
    [
      "migrate-reset",
      [
        /\b(?:npx(?:\.cmd)?\s+)?prisma(?:\.cmd)?\s+migrate\s+reset\b/i,
        new RegExp(separated(["prisma", "migrate", "reset"]), "i"),
        new RegExp(separated(["migrate", "reset"]), "i")
      ]
    ],
    [
      "migrate-dev",
      [
        /\b(?:npx(?:\.cmd)?\s+)?prisma(?:\.cmd)?\s+migrate\s+dev\b/i,
        new RegExp(separated(["prisma", "migrate", "dev"]), "i"),
        new RegExp(separated(["migrate", "dev"]), "i")
      ]
    ],
    [
      "db-push",
      [
        /\b(?:npx(?:\.cmd)?\s+)?prisma(?:\.cmd)?\s+db\s+push\b/i,
        new RegExp(separated(["prisma", "db", "push"]), "i"),
        new RegExp(separated(["db", "push"]), "i")
      ]
    ]
  ];

  for (const [kind, matchers] of patterns) {
    if (matchers.some((matcher) => matcher.test(source))) detected.add(kind);
  }
  return detected;
}

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function stringValue(expression: ts.Expression | undefined): string | undefined {
  return expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    ? expression.text
    : undefined;
}

function dottedName(expression: ts.Expression | undefined): string | undefined {
  if (!expression) return undefined;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const left = dottedName(expression.expression);
    return left ? `${left}.${expression.name.text}` : undefined;
  }
  return undefined;
}

function objectPropertyInitializer(
  objectLiteral: ts.ObjectLiteralExpression | undefined,
  propertyName: string
): ts.Expression | undefined {
  if (!objectLiteral) return undefined;
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
      ? property.name.text
      : undefined;
    if (name !== propertyName) continue;
    return ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
  }
  return undefined;
}

function classifyTokens(tokens: readonly string[]): DestructiveCommand | undefined {
  const commandTokens = tokens[0] === "prisma" ? tokens.slice(1) : [...tokens];
  if (commandTokens[0] === "migrate" && commandTokens[1] === "reset") return "migrate-reset";
  if (commandTokens[0] === "migrate" && commandTokens[1] === "dev") return "migrate-dev";
  if (commandTokens[0] === "migrate" && commandTokens[1] === "deploy") return "migrate-deploy";
  if (commandTokens[0] === "db" && commandTokens[1] === "push") return "db-push";
  return undefined;
}

function classifyStringCommand(command: string): DestructiveCommand | undefined {
  const normalized = command.trim().replace(/^npx(?:\.cmd)?\s+/i, "").replace(/^prisma(?:\.cmd)?\s+/i, "");
  if (/^migrate\s+reset(?:\s|$)/i.test(normalized)) return "migrate-reset";
  if (/^migrate\s+dev(?:\s|$)/i.test(normalized)) return "migrate-dev";
  if (/^migrate\s+deploy(?:\s|$)/i.test(normalized)) return "migrate-deploy";
  if (/^db\s+push(?:\s|$)/i.test(normalized)) return "db-push";
  return undefined;
}

function invocationEnvironment(call: ts.CallExpression, name: string): ts.Expression | undefined {
  if (name === "runCommand") return call.arguments[2];
  const options = name === "exec" || name === "execSync" ? call.arguments[1] : call.arguments[2];
  return ts.isObjectLiteralExpression(options) ? objectPropertyInitializer(options, "env") : undefined;
}

function collectPrismaInvocations(source: string, filename: string): PrismaInvocation[] {
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const invocations: PrismaInvocation[] = [];

  function visit(node: ts.Node, currentFunction: string | undefined): void {
    let functionName = currentFunction;
    if (ts.isFunctionDeclaration(node) && node.name) functionName = node.name.text;

    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (
        name &&
        ["exec", "execFile", "execFileSync", "execSync", "runCommand", "spawn", "spawnSync"].includes(name)
      ) {
        const command = stringValue(node.arguments[0]);
        const argumentArray = ts.isArrayLiteralExpression(node.arguments[1]) ? node.arguments[1] : undefined;
        const arrayTokens = argumentArray
          ? argumentArray.elements.map((element) => stringValue(element as ts.Expression)).filter((value): value is string => value !== undefined)
          : [];
        let tokens = arrayTokens;
        if (command === "prisma" || command === "prisma.cmd") tokens = ["prisma", ...arrayTokens];
        const kind = command && (name === "exec" || name === "execSync")
          ? classifyStringCommand(command)
          : classifyTokens(tokens);
        if (kind) {
          invocations.push({
            argumentsArray: argumentArray,
            calleeName: name,
            environment: invocationEnvironment(node, name),
            functionName,
            kind,
            tokens
          });
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, functionName));
  }

  visit(sourceFile, undefined);
  return invocations;
}

function findFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  let match: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) match = node;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  assert.ok(match, `Expected function ${name}.`);
  return match;
}

function findVariableDeclaration(node: ts.Node, name: string): ts.VariableDeclaration {
  let match: ts.VariableDeclaration | undefined;
  function visit(child: ts.Node): void {
    if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.name.text === name) match = child;
    ts.forEachChild(child, visit);
  }
  visit(node);
  assert.ok(match, `Expected variable ${name}.`);
  return match;
}

function findCalls(node: ts.Node, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  function visit(child: ts.Node): void {
    if (ts.isCallExpression(child) && calleeName(child.expression) === name) calls.push(child);
    ts.forEachChild(child, visit);
  }
  visit(node);
  return calls;
}

function returnedObject(functionDeclaration: ts.FunctionDeclaration): ts.ObjectLiteralExpression {
  let result: ts.ObjectLiteralExpression | undefined;
  function visit(node: ts.Node): void {
    if (ts.isReturnStatement(node)) {
      const expression = node.expression;
      if (expression && ts.isObjectLiteralExpression(expression)) result = expression;
    }
    ts.forEachChild(node, visit);
  }
  visit(functionDeclaration);
  assert.ok(result, `Expected ${functionDeclaration.name?.text ?? "function"} to return an object literal.`);
  return result;
}

function assertCall(
  expression: ts.Expression | undefined,
  expectedCallee: string,
  expectedArgument: string
): void {
  assert.ok(expression && ts.isCallExpression(expression), `Expected ${expectedCallee}(...) call.`);
  assert.equal(calleeName(expression.expression), expectedCallee);
  assert.equal(dottedName(expression.arguments[0]), expectedArgument);
}

function assertRunCommandSpawnSafety(sourceFile: ts.SourceFile): void {
  const runCommand = findFunction(sourceFile, "runCommand");
  assert.deepEqual(runCommand.parameters.map((parameter) => dottedName(parameter.name as ts.Expression)), [
    "command",
    "args",
    "environment"
  ]);
  const spawnCalls = findCalls(runCommand, "spawn");
  assert.equal(spawnCalls.length, 1, "runCommand must have exactly one spawn call.");
  const spawnCall = spawnCalls[0];
  assert.equal(dottedName(spawnCall.arguments[0]), "command");
  assert.ok(ts.isArrayLiteralExpression(spawnCall.arguments[1]));
  const options = spawnCall.arguments[2];
  assert.ok(ts.isObjectLiteralExpression(options));
  assert.equal(dottedName(objectPropertyInitializer(options, "env")), "environment");
  assert.equal(objectPropertyInitializer(options, "shell")?.kind, ts.SyntaxKind.FalseKeyword);
}

function verifyOfficialResetRunner(source: string): void {
  const filename = "scripts/run-postgres-tests.ts";
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const invocations = collectPrismaInvocations(source, filename);
  const resets = invocations.filter(({ kind }) => kind === "migrate-reset");
  assert.equal(resets.length, 1, "Official runner must contain exactly one migrate-reset invocation.");
  assert.equal(invocations.filter(({ kind }) => kind !== "migrate-reset").length, 0);

  const reset = resets[0];
  assert.equal(reset.functionName, "main");
  assert.equal(reset.calleeName, "runCommand");
  assert.deepEqual(reset.tokens, ["prisma", "migrate", "reset", "--force", "--skip-seed"]);
  assert.equal(dottedName(reset.environment), "environment");

  const safeEnvironment = findFunction(sourceFile, "safeChildEnvironment");
  assert.deepEqual(safeEnvironment.parameters.map((parameter) => dottedName(parameter.name as ts.Expression)), [
    "testDatabaseUrl"
  ]);
  const safeEnvironmentObject = returnedObject(safeEnvironment);
  assert.equal(dottedName(objectPropertyInitializer(safeEnvironmentObject, "DATABASE_URL")), "testDatabaseUrl");
  assert.equal(dottedName(objectPropertyInitializer(safeEnvironmentObject, "DIRECT_URL")), "testDatabaseUrl");

  const main = findFunction(sourceFile, "main");
  const config = findVariableDeclaration(main, "config");
  assertCall(config.initializer, "validatePostgresTestEnvironment", "process.env");
  const environment = findVariableDeclaration(main, "environment");
  assertCall(environment.initializer, "safeChildEnvironment", "config.url");
  assertRunCommandSpawnSafety(sourceFile);
}

function verifyGuardedMigrateWrapper(source: string): void {
  const filename = "scripts/run-local-prisma-migrate.ts";
  const sourceFile = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const invocations = collectPrismaInvocations(source, filename);
  const migrateDev = invocations.filter(({ kind }) => kind === "migrate-dev");
  assert.equal(migrateDev.length, 1, "Guarded wrapper must contain exactly one migrate-dev invocation.");
  assert.equal(invocations.filter(({ kind }) => kind !== "migrate-dev").length, 0);

  const invocation = migrateDev[0];
  assert.equal(invocation.functionName, "runPrisma");
  assert.equal(invocation.calleeName, "spawn");
  assert.deepEqual(invocation.tokens.slice(0, 3), ["prisma", "migrate", "dev"]);
  assert.ok(invocation.argumentsArray);
  assert.equal(invocation.argumentsArray.elements.length, 4);
  const forwardedArguments = invocation.argumentsArray.elements[3];
  assert.ok(ts.isSpreadElement(forwardedArguments));
  assert.equal(dottedName(forwardedArguments.expression), "args");
  assert.equal(dottedName(invocation.environment), "environment");

  const runPrisma = findFunction(sourceFile, "runPrisma");
  assert.deepEqual(runPrisma.parameters.map((parameter) => dottedName(parameter.name as ts.Expression)), [
    "args",
    "environment"
  ]);
  const spawnCalls = findCalls(runPrisma, "spawn");
  assert.equal(spawnCalls.length, 1, "runPrisma must have exactly one spawn call.");
  const options = spawnCalls[0].arguments[2];
  assert.ok(ts.isObjectLiteralExpression(options));
  assert.equal(dottedName(objectPropertyInitializer(options, "env")), "environment");
  assert.equal(objectPropertyInitializer(options, "shell")?.kind, ts.SyntaxKind.FalseKeyword);

  const main = findFunction(sourceFile, "main");
  const childEnvironment = findVariableDeclaration(main, "childEnvironment");
  assert.ok(childEnvironment.initializer && ts.isObjectLiteralExpression(childEnvironment.initializer));
  assert.equal(
    dottedName(objectPropertyInitializer(childEnvironment.initializer, "DATABASE_URL")),
    "pair.database.url"
  );
  assert.equal(
    dottedName(objectPropertyInitializer(childEnvironment.initializer, "DIRECT_URL")),
    "pair.direct.url"
  );
  const runPrismaCalls = findCalls(main, "runPrisma");
  assert.equal(runPrismaCalls.length, 1, "main must call runPrisma exactly once.");
  assert.equal(dottedName(runPrismaCalls[0].arguments[0]), "migrateArguments");
  assert.equal(dottedName(runPrismaCalls[0].arguments[1]), "childEnvironment");
}

function verifyApprovedResetRunner(source: string): void {
  assertApprovedSourceIntegrity("scripts/run-postgres-tests.ts", source);
  verifyOfficialResetRunner(source);
}

function verifyApprovedMigrateWrapper(source: string): void {
  assertApprovedSourceIntegrity("scripts/run-local-prisma-migrate.ts", source);
  verifyGuardedMigrateWrapper(source);
}

function replaceOnce(source: string, search: string, replacement: string): string {
  assert.ok(source.includes(search), `Mutation target was not found: ${search}`);
  return source.replace(search, replacement);
}

async function runTypeScriptEntry(entry: string, environment: NodeJS.ProcessEnv): Promise<CapturedProcess> {
  return new Promise<CapturedProcess>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
      cwd: repositoryRoot,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", reject);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 10_000);
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, output, timedOut });
    });
  });
}

function assertSafeRejection(result: CapturedProcess): void {
  assert.equal(result.timedOut, false);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.output.includes("SUBPROCESS_SECRET"), false);
  assert.equal(result.output.includes(neonUrl), false);
}

test("subprocess environments remove every inherited database authority", () => {
  const sentinelPrefix = "PARENT_DATABASE_AUTHORITY_SENTINEL_";
  const parentEnvironment: NodeJS.ProcessEnv = { NODE_ENV: "test", SAFE_PARENT_VALUE: "preserved" };
  for (const name of databaseAuthorityVariables) parentEnvironment[name] = `${sentinelPrefix}${name}`;

  const sanitized = cleanEnvironment({}, parentEnvironment);
  assert.equal(sanitized.SAFE_PARENT_VALUE, "preserved");
  assert.equal(sanitized.DATABASE_URL, localUrl);
  assert.equal(sanitized.DIRECT_URL, localUrl);
  for (const name of databaseAuthorityVariables) {
    if (name === "DATABASE_URL" || name === "DIRECT_URL") continue;
    assert.equal(name in sanitized, false, name);
  }
  assert.equal(JSON.stringify(sanitized).includes(sentinelPrefix), false);

  const explicit = cleanEnvironment(
    {
      APPLY_PILOT_LOCAL_DESTRUCTIVE: "1",
      LOCAL_DATABASE_URL: localUrl,
      LOCAL_DIRECT_URL: localUrl,
      TEST_DATABASE_URL: "synthetic-test-authority"
    },
    parentEnvironment
  );
  assert.equal(explicit.APPLY_PILOT_LOCAL_DESTRUCTIVE, "1");
  assert.equal(explicit.LOCAL_DATABASE_URL, localUrl);
  assert.equal(explicit.LOCAL_DIRECT_URL, localUrl);
  assert.equal(explicit.TEST_DATABASE_URL, "synthetic-test-authority");
  assert.equal(JSON.stringify(explicit).includes(sentinelPrefix), false);
});

test("command detector rejects ordinary string, direct executable, and package-runner forms", () => {
  const fixtures: Array<[string, Exclude<DestructiveCommand, "migrate-deploy">]> = [
    ['exec("prisma migrate reset")', "migrate-reset"],
    ['exec("npx prisma migrate reset")', "migrate-reset"],
    ['exec("prisma migrate dev")', "migrate-dev"],
    ['exec("npx prisma migrate dev")', "migrate-dev"],
    ['exec("prisma db push")', "db-push"],
    ['exec("npx prisma db push")', "db-push"],
    ['spawn("prisma", ["migrate", "reset"])', "migrate-reset"],
    ['execFile("prisma", ["migrate", "reset"])', "migrate-reset"],
    ['spawn("prisma", ["migrate", "dev"])', "migrate-dev"],
    ['execFile("prisma", ["migrate", "dev"])', "migrate-dev"],
    ['spawn("prisma", ["db", "push"])', "db-push"],
    ['execFile("prisma", ["db", "push"])', "db-push"],
    ['spawn("npx", ["prisma", "migrate", "reset"])', "migrate-reset"],
    ['execFile("npx.cmd", ["prisma", "migrate", "reset"])', "migrate-reset"],
    ['spawn("npx", ["prisma", "migrate", "dev"])', "migrate-dev"],
    ['execFile("npx.cmd", ["prisma", "migrate", "dev"])', "migrate-dev"],
    ['spawn("npx", ["prisma", "db", "push"])', "db-push"],
    ['execFile("npx.cmd", ["prisma", "db", "push"])', "db-push"],
    ['execSync("npx prisma migrate reset")', "migrate-reset"],
    ['spawnSync("prisma", ["migrate", "dev"])', "migrate-dev"],
    ['execFileSync("npx.cmd", ["prisma", "db", "push"])', "db-push"]
  ];
  for (const [source, expected] of fixtures) {
    assert.equal(detectedProhibitedCommands(source).has(expected), true, source);
  }
});

test("script discovery includes ordinary executable extensions and extensionless files", () => {
  for (const filename of [
    "unsafe.ts",
    "unsafe.tsx",
    "unsafe.js",
    "unsafe.mjs",
    "unsafe.cjs",
    "unsafe.sh",
    "unsafe.bash",
    "unsafe.zsh",
    "unsafe.py",
    "unsafe"
  ]) {
    assert.equal(isExecutableScriptFilename(filename), true, filename);
    assert.equal(detectedProhibitedCommands('spawn("prisma", ["migrate", "reset"])').has("migrate-reset"), true);
  }
});

test("package commands and executable files preserve the destructive database allowlist", async () => {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts["test:postgres"], "tsx scripts/run-postgres-tests.ts");
  assert.equal(packageJson.scripts["prisma:migrate"], "tsx scripts/run-local-prisma-migrate.ts");
  assert.equal(packageJson.scripts["prisma:seed"], "tsx prisma/seed.ts");
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    assert.deepEqual([...detectedProhibitedCommands(command)], [], name);
  }

  const scriptsDirectory = path.join(repositoryRoot, "scripts");
  const workflowDirectory = path.join(repositoryRoot, ".github", "workflows");
  const runnerPath = path.join(scriptsDirectory, "run-postgres-tests.ts");
  const migrateWrapperPath = path.join(scriptsDirectory, "run-local-prisma-migrate.ts");
  const files = [
    ...(await executableFiles(scriptsDirectory)),
    ...(await executableFiles(workflowDirectory)),
    path.join(repositoryRoot, "prisma", "seed.ts")
  ];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    if (file === runnerPath) {
      verifyApprovedResetRunner(source);
      continue;
    }
    if (file === migrateWrapperPath) {
      verifyApprovedMigrateWrapper(source);
      continue;
    }
    assert.deepEqual([...detectedProhibitedCommands(source)], [], file);
  }
});

test("approved source integrity rejects every in-memory runner mutation", async () => {
  const approvedPath = "scripts/run-postgres-tests.ts";
  const runner = await readFile(path.join(repositoryRoot, approvedPath), "utf8");
  assert.doesNotThrow(() => assertApprovedSourceIntegrity(approvedPath, runner));
  assert.doesNotThrow(() => assertApprovedSourceIntegrity(approvedPath, withCrlfLineEndings(runner)));

  const afterEnvironmentCreation = "  const environment = safeChildEnvironment(config.url);\n";
  const runnerMutations: Array<[string, string]> = [
    ["comment", `${runner}\n// unreviewed runner change`],
    [
      "trailing process.env spread",
      replaceOnce(
        runner,
        "    DIRECT_URL: testDatabaseUrl,\n",
        "    DIRECT_URL: testDatabaseUrl,\n    ...process.env,\n"
      )
    ],
    [
      "later DATABASE_URL reassignment",
      replaceOnce(
        runner,
        afterEnvironmentCreation,
        `${afterEnvironmentCreation}  environment.DATABASE_URL = process.env.DATABASE_URL;\n`
      )
    ],
    [
      "later DIRECT_URL reassignment",
      replaceOnce(
        runner,
        afterEnvironmentCreation,
        `${afterEnvironmentCreation}  environment.DIRECT_URL = process.env.DIRECT_URL;\n`
      )
    ],
    [
      "Object.assign inherited environment",
      replaceOnce(
        runner,
        afterEnvironmentCreation,
        `${afterEnvironmentCreation}  Object.assign(environment, process.env);\n`
      )
    ],
    [
      "duplicate unsafe DATABASE_URL",
      replaceOnce(
        runner,
        "    DIRECT_URL: testDatabaseUrl,\n",
        "    DIRECT_URL: testDatabaseUrl,\n    DATABASE_URL: process.env.DATABASE_URL,\n"
      )
    ],
    [
      "duplicate unsafe DIRECT_URL",
      replaceOnce(
        runner,
        "    DIRECT_URL: testDatabaseUrl,\n",
        "    DIRECT_URL: testDatabaseUrl,\n    DIRECT_URL: process.env.DIRECT_URL,\n"
      )
    ],
    [
      "hidden reset arguments",
      `${runner}\nconst hiddenResetArgs = ["prisma", "migrate", "reset", "--force"];\n` +
        `runCommand("npx", hiddenResetArgs, process.env);\n`
    ],
    [
      "hidden db-push arguments",
      `${runner}\nconst hiddenDbPushArgs = ["prisma", "db", "push"];\n` +
        `runCommand("npx", hiddenDbPushArgs, process.env);\n`
    ],
    [
      "changed environment mapping",
      replaceOnce(runner, "    DIRECT_URL: testDatabaseUrl,\n", "    DIRECT_URL: process.env.DIRECT_URL,\n")
    ],
    [
      "changed command token",
      replaceOnce(
        runner,
        '["prisma", "migrate", "reset", "--force", "--skip-seed"]',
        '["prisma", "migrate", "dev", "--create-only"]'
      )
    ],
    [
      "appended unsafe command",
      `${runner}\nspawn("npx", ["prisma", "migrate", "reset"], { env: process.env, shell: false });\n`
    ]
  ];

  for (const [name, mutation] of runnerMutations) {
    assert.throws(() => assertApprovedSourceIntegrity(approvedPath, mutation), name);
  }
});

test("approved source integrity rejects every in-memory migrate-wrapper mutation", async () => {
  const approvedPath = "scripts/run-local-prisma-migrate.ts";
  const wrapper = await readFile(path.join(repositoryRoot, approvedPath), "utf8");
  assert.doesNotThrow(() => assertApprovedSourceIntegrity(approvedPath, wrapper));
  assert.doesNotThrow(() => assertApprovedSourceIntegrity(approvedPath, withCrlfLineEndings(wrapper)));

  const beforeAuthorityRemoval = "  delete childEnvironment.TEST_DATABASE_URL;\n";
  const wrapperMutations: Array<[string, string]> = [
    ["comment", `${wrapper}\n// unreviewed migrate-wrapper change`],
    [
      "trailing process.env spread",
      replaceOnce(
        wrapper,
        "    DIRECT_URL: pair.direct.url\n",
        "    DIRECT_URL: pair.direct.url,\n    ...process.env\n"
      )
    ],
    [
      "later DATABASE_URL reassignment",
      replaceOnce(
        wrapper,
        beforeAuthorityRemoval,
        `  childEnvironment.DATABASE_URL = process.env.DATABASE_URL;\n${beforeAuthorityRemoval}`
      )
    ],
    [
      "later DIRECT_URL reassignment",
      replaceOnce(
        wrapper,
        beforeAuthorityRemoval,
        `  childEnvironment.DIRECT_URL = process.env.DIRECT_URL;\n${beforeAuthorityRemoval}`
      )
    ],
    [
      "Object.assign inherited environment",
      replaceOnce(
        wrapper,
        beforeAuthorityRemoval,
        `  Object.assign(childEnvironment, process.env);\n${beforeAuthorityRemoval}`
      )
    ],
    [
      "duplicate unsafe DATABASE_URL",
      replaceOnce(
        wrapper,
        "    DIRECT_URL: pair.direct.url\n",
        "    DIRECT_URL: pair.direct.url,\n    DATABASE_URL: process.env.DATABASE_URL\n"
      )
    ],
    [
      "duplicate unsafe DIRECT_URL",
      replaceOnce(
        wrapper,
        "    DIRECT_URL: pair.direct.url\n",
        "    DIRECT_URL: pair.direct.url,\n    DIRECT_URL: process.env.DIRECT_URL\n"
      )
    ],
    [
      "hidden migrate-dev arguments",
      `${wrapper}\nconst hiddenMigrateArgs = ["prisma", "migrate", "dev"];\n` +
        `spawn("npx", hiddenMigrateArgs, { env: process.env, shell: false });\n`
    ],
    [
      "hidden reset arguments",
      `${wrapper}\nconst hiddenResetArgs = ["prisma", "migrate", "reset"];\n` +
        `spawn("npx", hiddenResetArgs, { env: process.env, shell: false });\n`
    ],
    [
      "hidden db-push arguments",
      `${wrapper}\nconst hiddenDbPushArgs = ["prisma", "db", "push"];\n` +
        `spawn("npx", hiddenDbPushArgs, { env: process.env, shell: false });\n`
    ],
    [
      "hidden deploy arguments",
      `${wrapper}\nconst hiddenDeployArgs = ["prisma", "migrate", "deploy"];\n` +
        `spawn("npx", hiddenDeployArgs, { env: process.env, shell: false });\n`
    ],
    [
      "changed environment mapping",
      replaceOnce(wrapper, "    DIRECT_URL: pair.direct.url\n", "    DIRECT_URL: process.env.DIRECT_URL\n")
    ],
    [
      "changed command token",
      replaceOnce(
        wrapper,
        '["prisma", "migrate", "dev", ...args]',
        '["prisma", "migrate", "deploy", ...args]'
      )
    ],
    [
      "appended unsafe command",
      `${wrapper}\nspawn("npx", ["prisma", "db", "push"], { env: process.env, shell: false });\n`
    ]
  ];

  for (const [name, mutation] of wrapperMutations) {
    assert.throws(() => assertApprovedSourceIntegrity(approvedPath, mutation), name);
  }
});

test("official runner structural policy rejects unsafe in-memory mutations", async () => {
  const runner = await readFile(path.join(repositoryRoot, "scripts", "run-postgres-tests.ts"), "utf8");
  assert.doesNotThrow(() => verifyOfficialResetRunner(runner));

  const mutations = [
    `${runner}\nspawn("npx", ["prisma", "migrate", "reset", "--force"], { env: process.env, shell: false });`,
    replaceOnce(
      runner,
      "    environment\n  );\n  if (migrationExitCode",
      "    process.env\n  );\n  if (migrationExitCode"
    ),
    replaceOnce(
      runner,
      "    environment\n  );\n  if (migrationExitCode",
      "    otherEnvironment\n  );\n  if (migrationExitCode"
    ),
    replaceOnce(runner, "    DATABASE_URL: testDatabaseUrl,\n", ""),
    replaceOnce(runner, "    DIRECT_URL: testDatabaseUrl,\n", ""),
    `${runner}\nrunCommand("npx", ["prisma", "migrate", "reset", "--force", "--skip-seed"], process.env);`,
    replaceOnce(
      runner,
      '["prisma", "migrate", "reset", "--force", "--skip-seed"]',
      '["prisma", "db", "push"]'
    )
  ];
  for (const mutation of mutations) assert.throws(() => verifyOfficialResetRunner(mutation));
});

test("guarded migrate structural policy rejects unsafe in-memory mutations", async () => {
  const wrapper = await readFile(path.join(repositoryRoot, "scripts", "run-local-prisma-migrate.ts"), "utf8");
  assert.doesNotThrow(() => verifyGuardedMigrateWrapper(wrapper));

  const mutations = [
    `${wrapper}\nspawn("npx", ["prisma", "migrate", "dev"], { env: process.env, shell: false });`,
    replaceOnce(wrapper, "      env: environment,\n", "      env: process.env,\n"),
    `${wrapper}\nspawn("prisma", ["migrate", "reset"], { env: process.env, shell: false });`,
    `${wrapper}\nexecFile("npx", ["prisma", "db", "push"], { env: process.env, shell: false });`,
    `${wrapper}\nspawn("npx.cmd", ["prisma", "migrate", "deploy"], { env: process.env, shell: false });`
  ];
  for (const mutation of mutations) assert.throws(() => verifyGuardedMigrateWrapper(mutation));
});

test("guarded migrate and seed entry points reject unsafe environments before database access", async () => {
  const migrateEntry = path.join(repositoryRoot, "scripts", "run-local-prisma-migrate.ts");
  const seedEntry = path.join(repositoryRoot, "prisma", "seed.ts");
  const cases: Array<[string, string, EnvironmentOverrides]> = [
    ["migrate missing marker", migrateEntry, { LOCAL_DATABASE_URL: localUrl, LOCAL_DIRECT_URL: localUrl }],
    [
      "migrate Neon pair",
      migrateEntry,
      { APPLY_PILOT_LOCAL_DESTRUCTIVE: "1", LOCAL_DATABASE_URL: neonUrl, LOCAL_DIRECT_URL: neonUrl }
    ],
    [
      "migrate mixed pair",
      migrateEntry,
      { APPLY_PILOT_LOCAL_DESTRUCTIVE: "1", LOCAL_DATABASE_URL: localUrl, LOCAL_DIRECT_URL: neonUrl }
    ],
    ["seed missing marker", seedEntry, { LOCAL_DATABASE_URL: localUrl, LOCAL_DIRECT_URL: localUrl }],
    [
      "seed Neon pair",
      seedEntry,
      { APPLY_PILOT_LOCAL_DESTRUCTIVE: "1", LOCAL_DATABASE_URL: neonUrl, LOCAL_DIRECT_URL: neonUrl }
    ],
    [
      "seed mixed pair",
      seedEntry,
      { APPLY_PILOT_LOCAL_DESTRUCTIVE: "1", LOCAL_DATABASE_URL: localUrl, LOCAL_DIRECT_URL: neonUrl }
    ]
  ];

  for (const [name, entry, overrides] of cases) {
    const result = await runTypeScriptEntry(entry, cleanEnvironment(overrides));
    assertSafeRejection(result);
    assert.match(result.output, /safety|must|local/i, name);
  }
});
