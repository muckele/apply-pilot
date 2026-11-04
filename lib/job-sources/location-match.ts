import { normalizeText } from "@/lib/normalize";

/**
 * Location matching driven by each user's own preferred and home locations. A city match is
 * "exact"; a match on the same US state (via the state code/name alias table below) is "state".
 * There are no built-in metro areas, so no user's locale is privileged.
 */

export type LocationPreferenceMatch = "exact" | "state" | "none";

const usStates: Record<string, string> = {
  AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado",
  CT: "connecticut", DE: "delaware", DC: "district of columbia", FL: "florida", GA: "georgia",
  HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky",
  LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts", MI: "michigan", MN: "minnesota",
  MS: "mississippi", MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire",
  NJ: "new jersey", NM: "new mexico", NY: "new york", NC: "north carolina", ND: "north dakota",
  OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania", RI: "rhode island", SC: "south carolina",
  SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont", VA: "virginia",
  WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming"
};

const stateCodeByName = new Map(Object.entries(usStates).map(([code, name]) => [name, code]));
const workStyleTerms = new Set(["remote", "hybrid", "anywhere", "onsite", "on site", "in office", "flexible"]);
const districtOfColumbia = /\b(dc|d c|district of columbia)\b/;

function segments(location: string) {
  return location
    .split(/[,;|•/]|\s-\s|\(|\)/)
    .map((segment) => normalizeText(segment))
    .filter(Boolean);
}

export function extractUsStateCodes(location: string | null | undefined) {
  const codes = new Set<string>();
  const raw = location ?? "";
  const mentionsDc = districtOfColumbia.test(normalizeText(raw));

  for (const segment of segments(raw)) {
    const upper = segment.toUpperCase();
    if (segment.length === 2 && usStates[upper]) {
      codes.add(upper);
      continue;
    }

    const code = stateCodeByName.get(segment);
    // "Washington, DC" names the capital, not Washington state.
    if (code && !(code === "WA" && mentionsDc)) {
      codes.add(code);
    }
  }

  return codes;
}

function isWorkStyleLocation(value: string) {
  return workStyleTerms.has(normalizeText(value));
}

export function preferredLocationsFromProfile(
  profile: { preferredLocations?: string[] | null; location?: string | null } | null | undefined
) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of [...(profile?.preferredLocations ?? []), profile?.location]) {
    const trimmed = value?.trim();
    if (!trimmed || isWorkStyleLocation(trimmed)) {
      continue;
    }
    const key = normalizeText(trimmed);
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(trimmed);
    }
  }

  return result;
}

function containsPhrase(haystack: string, needle: string) {
  return needle.length >= 3 && ` ${haystack} `.includes(` ${needle} `);
}

function isStateSegment(segment: string) {
  return stateCodeByName.has(segment) || (segment.length === 2 && Boolean(usStates[segment.toUpperCase()]));
}

/** "New York, NY" has the city "new york"; a lone state such as "California" or "CA" has none. */
function cityOf(location: string) {
  const parts = segments(location);
  if (!parts.length || (parts.length === 1 && isStateSegment(parts[0]))) {
    return "";
  }
  return parts[0];
}

export function locationPreferenceMatch(
  jobLocation: string | null | undefined,
  preferredLocations: readonly string[]
): LocationPreferenceMatch {
  const normalizedJob = normalizeText(jobLocation);
  if (!normalizedJob || !preferredLocations.length) {
    return "none";
  }

  const jobStates = extractUsStateCodes(jobLocation);
  let match: LocationPreferenceMatch = "none";

  for (const preferred of preferredLocations) {
    const city = cityOf(preferred);
    if (city && containsPhrase(normalizedJob, city)) {
      return "exact";
    }

    for (const state of extractUsStateCodes(preferred)) {
      if (jobStates.has(state)) {
        match = "state";
      }
    }
  }

  return match;
}
