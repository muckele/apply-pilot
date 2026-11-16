import { normalizeBoardTokenInput } from "@/lib/job-sources/board-fetch";
import { boardPageUrl } from "@/lib/job-sources/board-url";

/**
 * Whether an Ashby board's hosted job pages (jobs.ashbyhq.com/<board>, where the Apply Pilot browser
 * opens a job's application) are switched on. A company can switch them off and take applications on
 * its own careers site while Ashby's public posting API still lists the jobs, and nothing in that API
 * says so. The board page itself does: probed 2026-11-15, a switched-off board answers HTTP 404 with
 * page data naming no organization and no job board; a working one answers 200 with both.
 *
 * Only the board page is read, never Ashby's internal /api/ (robots.txt disallows it). Anything that
 * isn't clearly one or the other is "unknown", which changes nothing.
 */
export type HostedPageState = "served" | "off" | "unknown";

const APP_DATA_MARKER = "window.__appData";
const READ_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The object literal after `window.__appData =`, found by a string-aware brace scan, or null. */
export function readAshbyAppData(html: string): Record<string, unknown> | null {
  const marker = html.indexOf(APP_DATA_MARKER);
  if (marker < 0) return null;
  const start = html.indexOf("{", marker + APP_DATA_MARKER.length);
  if (start < 0 || html.slice(marker + APP_DATA_MARKER.length, start).trim() !== "=") return null;

  let depth = 0;
  let inString = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(html.slice(start, index + 1));
          return isRecord(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function classifyAshbyHostedPage(status: number, html: string): HostedPageState {
  const data = readAshbyAppData(html);
  if (!data || data.maintenanceMode === true) return "unknown";
  if (status === 404 && data.organization === null && data.jobBoard === null) return "off";
  if (status === 200 && isRecord(data.organization) && isRecord(data.jobBoard)) return "served";
  return "unknown";
}

/**
 * One read of the board's hosted page. Takes a stored token (or a pasted board link saved as one, as the
 * listing fetch does). Never throws: a bad token or a failed read is "unknown".
 */
export async function checkAshbyHostedPage(token: string, fetchImpl: typeof fetch = fetch): Promise<HostedPageState> {
  let url: string;
  try {
    url = boardPageUrl({ ats: "ASHBY", token: normalizeBoardTokenInput("ASHBY", token), region: "global" });
  } catch {
    return "unknown";
  }

  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    return classifyAshbyHostedPage(response.status, await response.text());
  } catch {
    return "unknown";
  }
}
