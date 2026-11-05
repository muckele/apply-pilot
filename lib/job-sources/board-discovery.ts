import type { JobPosting, JobSource, UserProfile } from "@prisma/client";

import {
  directoryBoardKey,
  directoryPreferencesFrom,
  loadJobBoardDirectory,
  matchDirectoryBoards,
  selectBoardsForRun,
  type DirectoryMatch,
  type JobBoardDirectoryEntry
} from "@/lib/job-sources/board-directory";
import { normalizeBoardTokenInput } from "@/lib/job-sources/board-fetch";
import {
  createBoardListingCache,
  syncBoard,
  type BoardListingCache,
  type BoardSyncResult,
  type BoardTarget
} from "@/lib/job-sources/board-sync";
import { boardAtsTypes, isBoardAts, type BoardAts } from "@/lib/job-sources/board-url";
import type { RunDedupeIndex } from "@/lib/job-sources/ingestion";
import { readPositiveIntegerEnv } from "@/lib/job-sources/prefilter";
import type { DiscoverySourceReport } from "@/lib/job-sources/types";
import { prisma } from "@/lib/prisma";

/**
 * Preference discovery over public ATS boards: the user's followed boards first, then boards
 * from the reviewed seed directory, those whose tags match the user's preferences ahead of the
 * rest. The number of boards per run is capped; the rest rotate into later runs.
 */

export const directorySourceNames: Record<BoardAts, string> = {
  GREENHOUSE: "Apply Pilot board directory (Greenhouse)",
  LEVER: "Apply Pilot board directory (Lever)",
  ASHBY: "Apply Pilot board directory (Ashby)"
};

const atsLabels: Record<BoardAts, string> = { GREENHOUSE: "Greenhouse", LEVER: "Lever", ASHBY: "Ashby" };
const boardFetchConcurrency = 4;
const defaultMaxBoardsPerRun = 40;

export function maxBoardsPerRun() {
  return Math.min(100, readPositiveIntegerEnv("JOB_DISCOVERY_MAX_BOARDS_PER_RUN", defaultMaxBoardsPerRun));
}

export type BoardDiscoveryResult = {
  reports: DiscoverySourceReport[];
  imported: JobPosting[];
  unchanged: JobPosting[];
  /** deferred: over the per-run cap; timeDeferred: not started because the run's time budget ran out. */
  boards: { followed: number; directory: number; deferred: number; timeDeferred: number };
};

type PlannedBoard =
  | { origin: "followed"; source: JobSource & { type: BoardAts }; target: BoardTarget }
  | { origin: "directory"; match: DirectoryMatch; target: BoardTarget };

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function getOrCreateDirectorySource(userId: string, ats: BoardAts) {
  const name = directorySourceNames[ats];
  const existing = await prisma.jobSource.findFirst({ where: { userId, type: ats, name } });

  return (
    existing ??
    prisma.jobSource.create({
      data: {
        userId,
        name,
        type: ats,
        allowlisted: true,
        robotsChecked: true,
        syncEnabled: false,
        lastSyncStatus: "MANAGED",
        notes:
          "Holds jobs Apply Pilot found on public boards from its reviewed company directory that match your preferences. Managed automatically; follow a company to sync its board directly."
      }
    })
  );
}

function boardReport(planned: PlannedBoard, result: BoardSyncResult): DiscoverySourceReport {
  const { target } = planned;
  const origin =
    planned.origin === "followed"
      ? "Synced a company board you follow (target-search keywords are not required; your location, remote and relevance filters still apply)."
      : `Matched from the Apply Pilot board directory. ${planned.match.reasons.join(" ")}`;
  const notes = [
    result.unchanged.length ? `${result.unchanged.length} unchanged.` : "",
    result.duplicates ? `${result.duplicates} already found through another source.` : "",
    result.capped ? `${result.capped} more matches over the per-board limit.` : "",
    result.otherLocations ? `${result.otherLocations} more locations for the same role kept as one job.` : "",
    result.closed ? `${result.closed} no longer listed and marked expired.` : "",
    !result.imported.length && !result.unchanged.length && result.skipped ? "No jobs passed the current relevance filter." : ""
  ].filter(Boolean);

  return {
    name: `${target.company} (${atsLabels[target.ats]})`,
    type: target.ats,
    status: "imported",
    imported: result.imported.length,
    skipped: result.skipped,
    unchanged: result.unchanged.length,
    duplicates: result.duplicates,
    closed: result.closed,
    bestRelevanceScore: result.bestRelevanceScore,
    details: [origin, ...notes].join(" ")
  };
}

export async function runBoardDiscovery({
  userId,
  profile,
  queries,
  location,
  remoteOnly,
  limitPerBoard,
  maxBoards = maxBoardsPerRun(),
  index,
  listingCache = createBoardListingCache(),
  directory = loadJobBoardDirectory(),
  deadline,
  now = new Date()
}: {
  userId: string;
  profile: UserProfile | null;
  queries: readonly string[];
  location?: string | null;
  remoteOnly?: boolean;
  limitPerBoard: number;
  maxBoards?: number;
  index: RunDedupeIndex;
  listingCache?: BoardListingCache;
  directory?: readonly JobBoardDirectoryEntry[];
  /** Epoch ms after which no new board is started (checked with Date.now()). */
  deadline?: number;
  now?: Date;
}): Promise<BoardDiscoveryResult> {
  const rows = await prisma.jobSource.findMany({ where: { userId, type: { in: [...boardAtsTypes] } } });
  const directorySources = new Map<BoardAts, JobSource>();
  const knownBoards = new Set<string>();
  const followed: Array<JobSource & { type: BoardAts }> = [];

  for (const row of rows) {
    if (!isBoardAts(row.type)) {
      continue;
    }
    if (!row.boardToken?.trim()) {
      if (row.name === directorySourceNames[row.type]) {
        directorySources.set(row.type, row);
      }
      continue;
    }

    // Any row the user has for a board, enabled or not, takes it out of the directory set:
    // enabled rows sync as followed boards and disabled rows are the user's opt-out.
    knownBoards.add(directoryBoardKey({ ats: row.type, token: normalizeBoardTokenInput(row.type, row.boardToken) }));
    if (row.syncEnabled) {
      followed.push(row as JobSource & { type: BoardAts });
    }
  }

  const matches = matchDirectoryBoards(directory, directoryPreferencesFrom({ profile, location, remoteOnly })).filter(
    (match) => !knownBoards.has(directoryBoardKey(match.entry))
  );
  const selection = selectBoardsForRun({
    followed,
    directory: matches,
    maxBoards,
    now,
    // Tag-matched boards run first; the rest rotate through the remaining slots.
    priority: (match) => (match.score > 0 ? 1 : 0)
  });

  for (const ats of new Set(selection.directory.map((match) => match.entry.ats))) {
    if (!directorySources.has(ats)) {
      directorySources.set(ats, await getOrCreateDirectorySource(userId, ats));
    }
  }

  const planned: PlannedBoard[] = [
    ...selection.followed.map((source): PlannedBoard => {
      const directorySource = directorySources.get(source.type);
      return {
        origin: "followed",
        source,
        target: {
          ats: source.type,
          token: normalizeBoardTokenInput(source.type, source.boardToken ?? ""),
          baseUrl: source.baseUrl,
          company: source.name,
          jobSourceId: source.id,
          closureScopes: [
            { jobSourceId: source.id },
            ...(directorySource ? [{ jobSourceId: directorySource.id, company: source.name }] : [])
          ]
        }
      };
    }),
    ...selection.directory.map((match): PlannedBoard => {
      const directorySource = directorySources.get(match.entry.ats) as JobSource;
      return {
        origin: "directory",
        match,
        target: {
          ats: match.entry.ats,
          token: match.entry.token,
          company: match.entry.company,
          jobSourceId: directorySource.id,
          closureScopes: [{ jobSourceId: directorySource.id, company: match.entry.company }]
        }
      };
    })
  ];

  const outcomes = await mapWithConcurrency(planned, boardFetchConcurrency, async (board) => {
    if (deadline !== undefined && Date.now() >= deadline) {
      return { board, timeDeferred: true as const };
    }

    try {
      const result = await syncBoard({
        userId,
        target: board.target,
        // A company the user chose to follow shows every relevant role, not only keyword
        // matches; location, remote-only and the relevance prefilter still apply.
        queries: board.origin === "followed" ? [] : queries,
        remoteOnly,
        profile,
        maxImports: limitPerBoard,
        index,
        listingCache,
        now
      });
      if (board.origin === "followed") {
        await prisma.jobSource.update({
          where: { id: board.source.id },
          data: { lastSyncedAt: now, lastSyncStatus: "SUCCESS", lastSyncError: null }
        });
      }
      return { board, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Board sync failed.";
      if (board.origin === "followed") {
        await prisma.jobSource.update({
          where: { id: board.source.id },
          data: { lastSyncStatus: "ERROR", lastSyncError: message }
        });
      }
      return { board, error: message };
    }
  });

  const reports: DiscoverySourceReport[] = [];
  const imported: JobPosting[] = [];
  const unchanged: JobPosting[] = [];
  let timeDeferred = 0;

  for (const outcome of outcomes) {
    if ("timeDeferred" in outcome) {
      timeDeferred += 1;
      continue;
    }
    if ("error" in outcome) {
      reports.push({
        name: `${outcome.board.target.company} (${atsLabels[outcome.board.target.ats]})`,
        type: outcome.board.target.ats,
        status: "error",
        imported: 0,
        details: outcome.error ?? "Board sync failed."
      });
      continue;
    }
    imported.push(...outcome.result.imported);
    unchanged.push(...outcome.result.unchanged);
    reports.push(boardReport(outcome.board, outcome.result));
  }

  if (timeDeferred > 0) {
    reports.push({
      name: "Company boards (time budget)",
      type: "BOARDS",
      status: "skipped",
      imported: 0,
      details: `Stopped scheduling ${timeDeferred} boards because this run reached its time budget; they are checked in later runs.`
    });
  }

  if (selection.deferred > 0) {
    reports.push({
      name: "Company boards",
      type: "BOARDS",
      status: "skipped",
      imported: 0,
      details: `Checked ${planned.length - timeDeferred} boards this run; ${selection.deferred} more boards rotate into later runs (JOB_DISCOVERY_MAX_BOARDS_PER_RUN is ${maxBoards}).`
    });
  } else if (!planned.length) {
    reports.push({
      name: "Company boards",
      type: "BOARDS",
      status: "skipped",
      imported: 0,
      details: "No followed company boards or matching directory boards. Follow a company from Job sources to add one."
    });
  }

  return {
    reports,
    imported,
    unchanged,
    boards: {
      followed: selection.followed.length,
      directory: selection.directory.length,
      deferred: selection.deferred,
      timeDeferred
    }
  };
}
