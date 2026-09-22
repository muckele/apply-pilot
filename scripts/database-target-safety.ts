import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const LOCAL_DESTRUCTIVE_MARKER = "1";
export const LOCAL_DEVELOPMENT_DATABASE_NAME = "apply_pilot_local_dev";

const ALLOWED_PROTOCOLS = new Set(["postgres:", "postgresql:"]);
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const DEFAULT_POSTGRES_PORT = "5432";

export type LocalDatabaseEnvironment = Readonly<Record<string, string | undefined>>;

export type ValidatedDisposableLocalPostgresTarget = {
  url: string;
  hostname: string;
  effectivePort: string;
  databaseName: string;
  schema: "public";
};

export type ValidatedDisposableLocalPostgresPair = {
  database: ValidatedDisposableLocalPostgresTarget;
  direct: ValidatedDisposableLocalPostgresTarget;
};

export type HostLookup = (
  hostname: string
) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export class DatabaseTargetSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseTargetSafetyError";
  }
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  return hostname.toLowerCase();
}

function decodedDatabaseName(label: string, url: URL): string {
  const encoded = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
  try {
    return decodeURIComponent(encoded);
  } catch {
    throw new DatabaseTargetSafetyError(
      `${label} must be a valid PostgreSQL URL with a decodable database name.`
    );
  }
}

function effectivePort(label: string, url: URL): string {
  const port = url.port || DEFAULT_POSTGRES_PORT;
  const numericPort = Number.parseInt(port, 10);
  if (!/^\d+$/.test(port) || numericPort < 1 || numericPort > 65_535) {
    throw new DatabaseTargetSafetyError(`${label} contains an invalid PostgreSQL port.`);
  }
  return String(numericPort);
}

export function validateDisposableLocalPostgresUrl(
  label: string,
  sourceUrl: string | undefined,
  expectedDatabase = LOCAL_DEVELOPMENT_DATABASE_NAME
): ValidatedDisposableLocalPostgresTarget {
  if (!sourceUrl) throw new DatabaseTargetSafetyError(`${label} is required for guarded local database work.`);

  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new DatabaseTargetSafetyError(`${label} must be a valid PostgreSQL URL.`);
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new DatabaseTargetSafetyError(`${label} must use the postgres: or postgresql: protocol.`);
  }
  if (parsed.hash) throw new DatabaseTargetSafetyError(`${label} must not contain a fragment.`);

  const hostname = normalizedHostname(parsed);
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new DatabaseTargetSafetyError(
      `${label} must target an exact loopback host: localhost, 127.0.0.1, or ::1.`
    );
  }

  const databaseName = decodedDatabaseName(label, parsed);
  if (databaseName !== expectedDatabase) {
    throw new DatabaseTargetSafetyError(`${label} must target exactly ${expectedDatabase}.`);
  }

  const parameters = [...parsed.searchParams.entries()];
  const unsupportedParameter = parameters.find(([name]) => name !== "schema");
  if (unsupportedParameter) {
    throw new DatabaseTargetSafetyError(
      `${label} query parameter ${unsupportedParameter[0]} is not allowed; only schema=public is accepted.`
    );
  }
  const schemas = parsed.searchParams.getAll("schema");
  if (schemas.length > 1 || (schemas.length === 1 && schemas[0] !== "public")) {
    throw new DatabaseTargetSafetyError(`${label} schema must be absent or exactly schema=public.`);
  }

  return {
    url: sourceUrl,
    hostname,
    effectivePort: effectivePort(label, parsed),
    databaseName,
    // PostgreSQL and Prisma both use public when the parameter is absent.
    schema: "public"
  };
}

export function validateMatchingDisposableLocalPostgresPair(
  databaseUrl: string | undefined,
  directUrl: string | undefined,
  expectedDatabase = LOCAL_DEVELOPMENT_DATABASE_NAME
): ValidatedDisposableLocalPostgresPair {
  const database = validateDisposableLocalPostgresUrl("LOCAL_DATABASE_URL", databaseUrl, expectedDatabase);
  const direct = validateDisposableLocalPostgresUrl("LOCAL_DIRECT_URL", directUrl, expectedDatabase);
  if (
    database.hostname !== direct.hostname ||
    database.effectivePort !== direct.effectivePort ||
    database.databaseName !== direct.databaseName ||
    database.schema !== direct.schema
  ) {
    throw new DatabaseTargetSafetyError(
      "LOCAL_DATABASE_URL and LOCAL_DIRECT_URL must identify the same local target, port, database, and schema."
    );
  }
  return { database, direct };
}

export function validateLocalDestructiveEnvironment(
  environment: LocalDatabaseEnvironment = process.env
): ValidatedDisposableLocalPostgresPair {
  if (environment.APPLY_PILOT_LOCAL_DESTRUCTIVE !== LOCAL_DESTRUCTIVE_MARKER) {
    throw new DatabaseTargetSafetyError('APPLY_PILOT_LOCAL_DESTRUCTIVE must be exactly "1".');
  }
  if (environment.TEST_DATABASE_URL !== undefined) {
    throw new DatabaseTargetSafetyError(
      "TEST_DATABASE_URL must be unset for guarded local migrate and seed workflows."
    );
  }
  return validateMatchingDisposableLocalPostgresPair(
    environment.LOCAL_DATABASE_URL,
    environment.LOCAL_DIRECT_URL
  );
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) return normalized.split(".")[0] === "127";
  if (isIP(normalized) !== 6) return false;
  return (
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

const defaultHostLookup: HostLookup = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true }) as Promise<Array<{ address: string; family: number }>>;

export async function assertLoopbackHostResolution(
  targets: readonly ValidatedDisposableLocalPostgresTarget[],
  resolveHost: HostLookup = defaultHostLookup
): Promise<void> {
  const hostnames = [...new Set(targets.map((target) => target.hostname))];
  for (const hostname of hostnames) {
    if (hostname !== "localhost") continue;
    let addresses: ReadonlyArray<{ address: string; family: number }>;
    try {
      addresses = await resolveHost(hostname);
    } catch {
      throw new DatabaseTargetSafetyError("localhost resolution failed closed before database access.");
    }
    if (addresses.length === 0 || addresses.some(({ address }) => !isLoopbackAddress(address))) {
      throw new DatabaseTargetSafetyError(
        "localhost must resolve to loopback-only addresses before local database access."
      );
    }
  }
}
