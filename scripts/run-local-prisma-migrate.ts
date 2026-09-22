import { spawn } from "node:child_process";

import { PrismaClient } from "@prisma/client";

import {
  DatabaseTargetSafetyError,
  LOCAL_DEVELOPMENT_DATABASE_NAME,
  assertLoopbackHostResolution,
  validateLocalDestructiveEnvironment
} from "./database-target-safety";

const LIVE_CHECK_TIMEOUT_MS = 10_000;
const ALLOWED_FLAG_ARGUMENTS = new Set(["--create-only", "--skip-generate"]);

function withTimeout<T>(operation: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DatabaseTargetSafetyError(message)), LIVE_CHECK_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function validatedMigrateArguments(args: readonly string[]): string[] {
  const validated: string[] = [];
  let sawName = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (ALLOWED_FLAG_ARGUMENTS.has(argument)) {
      if (validated.includes(argument)) {
        throw new DatabaseTargetSafetyError(`Duplicate migrate-dev option ${argument} is not allowed.`);
      }
      validated.push(argument);
      continue;
    }
    if (argument === "--name") {
      if (sawName) throw new DatabaseTargetSafetyError("Duplicate migrate-dev option --name is not allowed.");
      const name = args[index + 1];
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name)) {
        throw new DatabaseTargetSafetyError(
          "Migrate-dev --name must contain 1-80 letters, digits, underscores, or hyphens."
        );
      }
      validated.push(argument, name);
      sawName = true;
      index += 1;
      continue;
    }
    throw new DatabaseTargetSafetyError(
      "Guarded migrate-dev accepts only --name <value>, --create-only, and --skip-generate."
    );
  }
  return validated;
}

async function verifyLiveDatabase(databaseUrl: string): Promise<void> {
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await withTimeout(client.$connect(), "Local database connection timed out before migrate-dev.");
    const rows = await withTimeout(
      client.$queryRawUnsafe<Array<{ current_database: string }>>("SELECT current_database()"),
      "Local database identity check timed out before migrate-dev."
    );
    if (rows[0]?.current_database !== LOCAL_DEVELOPMENT_DATABASE_NAME) {
      throw new DatabaseTargetSafetyError(
        `Live local database identity must be exactly ${LOCAL_DEVELOPMENT_DATABASE_NAME}.`
      );
    }
  } finally {
    await Promise.race([
      client.$disconnect().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000))
    ]);
  }
}

async function runPrisma(args: readonly string[], environment: NodeJS.ProcessEnv): Promise<number> {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, ["prisma", "migrate", "dev", ...args], {
      cwd: process.cwd(),
      env: environment,
      shell: false,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Guarded migrate-dev terminated by signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  const pair = validateLocalDestructiveEnvironment(process.env);
  const migrateArguments = validatedMigrateArguments(process.argv.slice(2));
  await assertLoopbackHostResolution([pair.database, pair.direct]);
  await verifyLiveDatabase(pair.database.url);

  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: pair.database.url,
    DIRECT_URL: pair.direct.url
  };
  delete childEnvironment.TEST_DATABASE_URL;
  delete childEnvironment.PRODUCTION_DATABASE_URL;
  delete childEnvironment.PRODUCTION_DIRECT_URL;
  delete childEnvironment.RECOVERY_DATABASE_URL;
  delete childEnvironment.RECOVERY_DIRECT_URL;

  const exitCode = await runPrisma(migrateArguments, childEnvironment);
  if (exitCode !== 0) process.exitCode = exitCode;
}

main().catch((error: unknown) => {
  if (error instanceof DatabaseTargetSafetyError) {
    console.error(`[local-prisma-migrate] safety check failed: ${error.message}`);
  } else {
    console.error("[local-prisma-migrate] Local verification or Prisma execution failed.");
  }
  process.exitCode = 1;
});
