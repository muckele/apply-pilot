import { z } from "zod";

import directoryData from "@/data/job-board-directory.json";
import { boardAtsTypes, isValidBoardToken, type BoardAts } from "@/lib/job-sources/board-url";
import { locationPreferenceMatch, preferredLocationsFromProfile } from "@/lib/job-sources/location-match";
import { normalizeText } from "@/lib/normalize";

/**
 * Reviewed seed directory of public Greenhouse, Lever and Ashby boards (MVP Bible §6).
 * The data file is curated by hand and each entry was verified with one public GET to its
 * board endpoint; it is never scraped or extended automatically.
 */

const directoryEntrySchema = z
  .object({
    company: z.string().trim().min(1).max(120),
    ats: z.enum(boardAtsTypes),
    token: z.string().min(1).max(100),
    industries: z.array(z.string().trim().min(1).max(60)).min(1).max(8),
    locations: z.array(z.string().trim().min(1).max(80)).max(12),
    remote: z.boolean(),
    verifiedAt: z.string().datetime()
  })
  .strict()
  .refine((entry) => isValidBoardToken(entry.ats, entry.token), {
    message: "Board token is not valid for its ATS.",
    path: ["token"]
  });

const directoryFileSchema = z
  .object({
    version: z.literal(1),
    notes: z.string().max(2000).optional(),
    boards: z.array(directoryEntrySchema).min(1).max(1000)
  })
  .strict()
  .superRefine((value, context) => {
    const seen = new Set<string>();
    value.boards.forEach((board, index) => {
      const key = directoryBoardKey(board);
      if (seen.has(key)) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate board ${key}.`, path: ["boards", index] });
      }
      seen.add(key);
    });
  });

export type JobBoardDirectoryEntry = z.infer<typeof directoryEntrySchema>;

export type DirectoryPreferences = {
  industries: string[];
  locations: string[];
  remote: boolean;
  remoteOnly: boolean;
};

export type DirectoryMatch = {
  entry: JobBoardDirectoryEntry;
  score: number;
  reasons: string[];
};

export function directoryBoardKey(board: { ats: BoardAts; token: string }) {
  return `${board.ats}:${board.token.toLowerCase()}`;
}

export function parseJobBoardDirectory(value: unknown): JobBoardDirectoryEntry[] {
  return directoryFileSchema.parse(value).boards;
}

let cachedDirectory: JobBoardDirectoryEntry[] | null = null;

export function loadJobBoardDirectory() {
  cachedDirectory ??= parseJobBoardDirectory(directoryData);
  return cachedDirectory;
}

export function findDirectoryEntry(ats: BoardAts, token: string) {
  const key = directoryBoardKey({ ats, token });
  return loadJobBoardDirectory().find((entry) => directoryBoardKey(entry) === key) ?? null;
}

const industrySynonymGroups: string[][] = [
  ["ai", "artificial intelligence", "machine learning", "ml", "generative ai", "genai", "llm", "llms"],
  ["healthcare", "health tech", "healthtech", "health", "digital health", "health care", "medtech"],
  ["fintech", "financial services", "financial technology", "finance", "banking", "payments"],
  ["saas", "software as a service", "b2b saas", "b2b software", "cloud software"],
  ["enterprise software", "enterprise", "b2b"],
  ["developer tools", "devtools", "dev tools", "developer platform", "developer productivity"],
  ["security", "cybersecurity", "cyber security", "infosec", "information security"],
  ["e commerce", "ecommerce", "online retail", "retail"],
  ["crypto", "web3", "blockchain", "cryptocurrency"],
  ["education", "edtech", "education technology", "learning"],
  ["hr tech", "hr", "human resources", "people tech", "recruiting"],
  ["data analytics", "data", "analytics", "big data", "data infrastructure"],
  ["transportation", "mobility", "autonomous vehicles", "rideshare"],
  ["consumer", "consumer tech", "consumer internet"],
  ["media", "entertainment", "streaming", "music"],
  ["productivity", "collaboration", "workplace software"],
  ["cloud infrastructure", "cloud", "infrastructure", "devops"],
  ["social media", "social", "community"]
];

const canonicalIndustry = new Map<string, string>();
for (const group of industrySynonymGroups) {
  for (const term of group) {
    canonicalIndustry.set(term, group[0]);
  }
}

function industryKey(value: string) {
  const normalized = normalizeText(value);
  return canonicalIndustry.get(normalized) ?? normalized;
}

function containsPhrase(haystack: string, needle: string) {
  return needle.length >= 3 && ` ${haystack} `.includes(` ${needle} `);
}

function industriesMatch(userIndustry: string, boardIndustry: string) {
  const userKey = industryKey(userIndustry);
  const boardKey = industryKey(boardIndustry);

  if (!userKey || !boardKey) {
    return false;
  }

  return userKey === boardKey || containsPhrase(normalizeText(boardIndustry), normalizeText(userIndustry));
}

/** Directory tags only count a city-level match; a shared state is too broad to rank boards. */
function locationsMatch(userLocation: string, boardLocation: string) {
  return locationPreferenceMatch(boardLocation, [userLocation]) === "exact";
}

function uniqueTrimmed(values: Array<string | null | undefined>) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(trimmed);
    }
  }

  return result;
}

export function directoryPreferencesFrom({
  profile,
  location,
  remoteOnly
}: {
  profile:
    | {
        industriesOfInterest?: string[] | null;
        preferredLocations?: string[] | null;
        location?: string | null;
        remotePreference?: string | null;
      }
    | null
    | undefined;
  location?: string | null;
  remoteOnly?: boolean;
}): DirectoryPreferences {
  const allLocations = uniqueTrimmed([location, ...(profile?.preferredLocations ?? []), profile?.location]);
  const wantsRemoteLocation = allLocations.some((value) => normalizeText(value).includes("remote"));
  const placeLocations = new Set(
    preferredLocationsFromProfile({ preferredLocations: allLocations }).map((value) => value.toLowerCase())
  );

  return {
    industries: uniqueTrimmed(profile?.industriesOfInterest ?? []),
    locations: allLocations.filter((value) => placeLocations.has(value.toLowerCase())),
    remote: Boolean(remoteOnly) || profile?.remotePreference === "REMOTE" || wantsRemoteLocation,
    remoteOnly: Boolean(remoteOnly)
  };
}

export function matchDirectoryBoards(
  entries: readonly JobBoardDirectoryEntry[],
  preferences: DirectoryPreferences
): DirectoryMatch[] {
  const hasSignals = preferences.industries.length > 0 || preferences.locations.length > 0 || preferences.remote;
  const matches: DirectoryMatch[] = [];

  for (const entry of entries) {
    if (preferences.remoteOnly && !entry.remote) {
      continue;
    }

    const reasons: string[] = [];
    let score = 0;
    const industry = entry.industries.find((boardIndustry) =>
      preferences.industries.some((userIndustry) => industriesMatch(userIndustry, boardIndustry))
    );
    if (industry) {
      score += 2;
      reasons.push(`Industry matches ${industry}.`);
    }

    const location = entry.locations.find((boardLocation) =>
      preferences.locations.some((userLocation) => locationsMatch(userLocation, boardLocation))
    );
    if (location) {
      score += 1;
      reasons.push(`Location matches ${location}.`);
    }

    if (preferences.remote && entry.remote) {
      score += 1;
      reasons.push("Board lists remote roles.");
    }

    if (score > 0 || !hasSignals) {
      matches.push({ entry, score, reasons: reasons.length ? reasons : ["No industry or location preference set."] });
    }
  }

  return matches.sort(
    (left, right) => right.score - left.score || left.entry.company.localeCompare(right.entry.company)
  );
}

const rotationWindowMs = 86_400_000;

/**
 * Picks the boards for one discovery run: followed boards first (least recently synced first),
 * then directory boards in a daily rotating window so a capped run still reaches every
 * matching board over consecutive days without storing a cursor.
 */
export function selectBoardsForRun<F extends { lastSyncedAt: Date | null }, D>({
  followed,
  directory,
  maxBoards,
  now = new Date()
}: {
  followed: readonly F[];
  directory: readonly D[];
  maxBoards: number;
  now?: Date;
}) {
  const cap = Math.max(0, Math.trunc(maxBoards));
  const orderedFollowed = [...followed].sort(
    (left, right) => (left.lastSyncedAt?.getTime() ?? 0) - (right.lastSyncedAt?.getTime() ?? 0)
  );
  const selectedFollowed = orderedFollowed.slice(0, cap);
  const slots = cap - selectedFollowed.length;
  let selectedDirectory: D[] = [];

  if (slots >= directory.length) {
    selectedDirectory = [...directory];
  } else if (slots > 0) {
    const window = Math.floor(now.getTime() / rotationWindowMs);
    const offset = (window * slots) % directory.length;
    selectedDirectory = Array.from({ length: slots }, (_, index) => directory[(offset + index) % directory.length]);
  }

  return {
    followed: selectedFollowed,
    directory: selectedDirectory,
    deferred: followed.length - selectedFollowed.length + directory.length - selectedDirectory.length
  };
}
