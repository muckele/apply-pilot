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

/**
 * Country reading for job and user locations. A posting's location string may list several
 * places ("San Francisco, CA; Remote - Canada"); each place is read on its own. Countries come
 * from US state names/codes, country names, and a short table of well-known non-US cities.
 * Anything the tables do not recognise stays unknown, and unknown never rejects a posting.
 */

const anyCountry = "ANY";

const countryNames: Array<[string, string]> = [
  ["united states of america", "US"], ["united states", "US"], ["usa", "US"], ["u s a", "US"], ["u s", "US"], ["us", "US"],
  ["canada", "CA"], ["mexico", "MX"], ["brazil", "BR"], ["argentina", "AR"], ["colombia", "CO"], ["chile", "CL"], ["peru", "PE"],
  ["costa rica", "CR"], ["uruguay", "UY"],
  ["united kingdom", "GB"], ["uk", "GB"], ["u k", "GB"], ["great britain", "GB"], ["britain", "GB"], ["england", "GB"],
  ["scotland", "GB"], ["wales", "GB"], ["northern ireland", "GB"], ["ireland", "IE"], ["france", "FR"], ["germany", "DE"],
  ["netherlands", "NL"], ["the netherlands", "NL"], ["belgium", "BE"], ["luxembourg", "LU"], ["switzerland", "CH"],
  ["austria", "AT"], ["spain", "ES"], ["portugal", "PT"], ["italy", "IT"], ["greece", "GR"], ["poland", "PL"],
  ["czech republic", "CZ"], ["czechia", "CZ"], ["hungary", "HU"], ["romania", "RO"], ["bulgaria", "BG"], ["serbia", "RS"],
  ["croatia", "HR"], ["ukraine", "UA"], ["estonia", "EE"], ["latvia", "LV"], ["lithuania", "LT"], ["sweden", "SE"],
  ["norway", "NO"], ["denmark", "DK"], ["finland", "FI"], ["iceland", "IS"], ["turkey", "TR"], ["turkiye", "TR"],
  ["israel", "IL"], ["united arab emirates", "AE"], ["uae", "AE"], ["saudi arabia", "SA"], ["egypt", "EG"],
  ["south africa", "ZA"], ["nigeria", "NG"], ["kenya", "KE"], ["india", "IN"], ["pakistan", "PK"], ["singapore", "SG"],
  ["japan", "JP"], ["south korea", "KR"], ["korea", "KR"], ["china", "CN"], ["hong kong", "HK"], ["taiwan", "TW"],
  ["philippines", "PH"], ["indonesia", "ID"], ["malaysia", "MY"], ["thailand", "TH"], ["vietnam", "VN"],
  ["australia", "AU"], ["new zealand", "NZ"]
];

const nonUsCities: Array<[string, string]> = [
  ["toronto", "CA"], ["vancouver", "CA"], ["montreal", "CA"], ["ottawa", "CA"], ["calgary", "CA"], ["edmonton", "CA"],
  ["mexico city", "MX"], ["guadalajara", "MX"], ["sao paulo", "BR"], ["buenos aires", "AR"], ["bogota", "CO"], ["santiago", "CL"],
  ["london", "GB"], ["manchester", "GB"], ["edinburgh", "GB"], ["cambridge uk", "GB"], ["belfast", "GB"], ["dublin", "IE"],
  ["cork", "IE"], ["paris", "FR"], ["berlin", "DE"], ["munich", "DE"], ["hamburg", "DE"], ["frankfurt", "DE"],
  ["amsterdam", "NL"], ["brussels", "BE"], ["zurich", "CH"], ["geneva", "CH"], ["vienna", "AT"], ["madrid", "ES"],
  ["barcelona", "ES"], ["lisbon", "PT"], ["milan", "IT"], ["rome", "IT"], ["athens", "GR"], ["warsaw", "PL"],
  ["krakow", "PL"], ["wroclaw", "PL"], ["prague", "CZ"], ["budapest", "HU"], ["bucharest", "RO"], ["belgrade", "RS"],
  ["kyiv", "UA"], ["tallinn", "EE"], ["stockholm", "SE"], ["oslo", "NO"], ["copenhagen", "DK"], ["helsinki", "FI"],
  ["istanbul", "TR"], ["tel aviv", "IL"], ["dubai", "AE"], ["abu dhabi", "AE"], ["riyadh", "SA"], ["cape town", "ZA"],
  ["lagos", "NG"], ["nairobi", "KE"], ["bengaluru", "IN"], ["bangalore", "IN"], ["gurugram", "IN"], ["gurgaon", "IN"],
  ["hyderabad", "IN"], ["mumbai", "IN"], ["pune", "IN"], ["chennai", "IN"], ["delhi", "IN"], ["new delhi", "IN"],
  ["noida", "IN"], ["tokyo", "JP"], ["osaka", "JP"], ["seoul", "KR"], ["beijing", "CN"], ["shanghai", "CN"],
  ["shenzhen", "CN"], ["taipei", "TW"], ["manila", "PH"], ["jakarta", "ID"], ["kuala lumpur", "MY"], ["bangkok", "TH"],
  ["ho chi minh city", "VN"], ["sydney", "AU"], ["melbourne", "AU"], ["brisbane", "AU"], ["perth", "AU"],
  ["auckland", "NZ"], ["wellington", "NZ"]
];

/** Provinces and states outside the US that postings name instead of a country. */
const nonUsRegions: Array<[string, string]> = [
  ["ontario", "CA"], ["quebec", "CA"], ["british columbia", "CA"], ["alberta", "CA"], ["saskatchewan", "CA"],
  ["manitoba", "CA"], ["nova scotia", "CA"], ["new brunswick", "CA"], ["newfoundland", "CA"],
  ["prince edward island", "CA"], ["new south wales", "AU"], ["victoria", "AU"], ["queensland", "AU"],
  ["karnataka", "IN"], ["maharashtra", "IN"], ["telangana", "IN"], ["haryana", "IN"], ["bavaria", "DE"]
];

const europe = new Set(["GB", "IE", "FR", "DE", "NL", "BE", "LU", "CH", "AT", "ES", "PT", "IT", "GR", "PL", "CZ", "HU", "RO", "BG", "RS", "HR", "UA", "EE", "LV", "LT", "SE", "NO", "DK", "FI", "IS", "TR"]);
const latinAmerica = new Set(["MX", "BR", "AR", "CO", "CL", "PE", "CR", "UY"]);
const middleEastAfrica = new Set(["IL", "AE", "SA", "EG", "ZA", "NG", "KE"]);
const asiaPacific = new Set(["IN", "PK", "SG", "JP", "KR", "CN", "HK", "TW", "PH", "ID", "MY", "TH", "VN", "AU", "NZ"]);

/** Regional phrases name the countries they cover; longer phrases are checked first. */
const regionPhrases: Array<[string, string[]]> = [
  ["north america", ["US", "CA"]],
  ["namer", ["US", "CA"]],
  ["noram", ["US", "CA"]],
  ["latin america", [...latinAmerica]],
  ["south america", [...latinAmerica]],
  ["central america", [...latinAmerica]],
  ["latam", [...latinAmerica]],
  ["americas", ["US", "CA", ...latinAmerica]],
  ["amer", ["US", "CA", ...latinAmerica]],
  ["emea", [...europe, ...middleEastAfrica]],
  ["europe", [...europe]],
  ["eu", [...europe]],
  ["apac", [...asiaPacific]],
  ["asia", [...asiaPacific]],
  ["worldwide", [anyCountry]],
  ["global", [anyCountry]],
  ["anywhere", [anyCountry]],
  ["international", [anyCountry]]
];

const remoteWords = /\b(remote|anywhere|distributed|work from home|wfh)\b/;
const negatedRemote = /\b(not|no|non) remote\b/;
const workStyleWords = /\b(remote|hybrid|anywhere|distributed|onsite|on site|in office|office|flexible|work from home|wfh|hq|headquarters|n a|tbd|multiple locations)\b/g;

/** "San Francisco, CA; Remote - Canada" lists two places. */
export function locationPlaces(location: string | null | undefined) {
  return (location ?? "")
    .split(/[;|•\n]|\bor\b/i)
    .map((place) => place.trim())
    .filter((place) => normalizeText(place));
}

function phraseHits(text: string, table: ReadonlyArray<readonly [string, string]>) {
  return table.filter(([name]) => containsPhrase(text, name) || (name.length < 3 && ` ${text} `.includes(` ${name} `)));
}

function placeCountries(place: string) {
  const countries = new Set<string>();
  const parts = segments(place);
  const text = parts.join(" ");
  // A segment that is exactly a US state name ("New Mexico", "Georgia") is a state, not a country.
  const fullStateNames = parts.filter((segment) => stateCodeByName.has(segment));
  const nonStateText = parts.filter((segment) => !stateCodeByName.has(segment)).join(" ");

  for (const [phrase, codes] of regionPhrases) {
    if (containsPhrase(nonStateText, phrase) || (phrase.length < 3 && ` ${nonStateText} `.includes(` ${phrase} `))) {
      codes.forEach((code) => countries.add(code));
    }
  }

  const named = new Set(
    [...phraseHits(nonStateText, countryNames), ...phraseHits(nonStateText, nonUsRegions)].map(([, code]) => code)
  );
  const cities = new Set(phraseHits(text, nonUsCities).map(([, code]) => code));
  // "Bengaluru, IN" is India and "Toronto, CA" is Canada; "Dublin, CA" is California.
  const stateCodes = parts.filter(
    (segment) => segment.length === 2 && usStates[segment.toUpperCase()] && !cities.has(segment.toUpperCase()) && !named.has(segment.toUpperCase())
  );
  const usByState = fullStateNames.length > 0 || stateCodes.length > 0;

  named.forEach((code) => countries.add(code));
  if (usByState) {
    countries.add("US");
  } else {
    cities.forEach((code) => countries.add(code));
  }

  return countries;
}

/** Countries a location names. "ANY" marks a worldwide posting; an empty set means unknown. */
export function locationCountries(location: string | null | undefined) {
  const countries = new Set<string>();
  for (const place of locationPlaces(location)) {
    placeCountries(place).forEach((code) => countries.add(code));
  }
  return countries;
}

/** Countries a user accepts, from their own locations. Empty means no country restriction. */
export function acceptedCountries(locations: readonly (string | null | undefined)[]) {
  const accepted = new Set<string>();
  for (const location of locations) {
    locationCountries(location).forEach((code) => accepted.add(code));
  }
  accepted.delete(anyCountry);
  return accepted;
}

function isRemotePlace(place: string) {
  const text = normalizeText(place);
  return remoteWords.test(text) && !negatedRemote.test(text);
}

function isCountryOnlyPlace(place: string) {
  const parts = segments(place).map((segment) => segment.replace(workStyleWords, " ").trim()).filter(Boolean);
  return (
    parts.length > 0 &&
    parts.every((segment) => countryNames.some(([name]) => name === segment) || regionPhrases.some(([phrase]) => phrase === segment))
  );
}

/** Whether a posting is remote, judged from its structured work style and location only. */
export function isRemotePosting(job: { location?: string | null; remoteStatus?: string | null }) {
  const status = normalizeText(job.remoteStatus);
  return (remoteWords.test(status) && !negatedRemote.test(status)) || locationPlaces(job.location).some(isRemotePlace);
}

/** Whether a posting is remote or hybrid, judged from its structured work style and location only. */
export function isRemoteOrHybridPosting(job: { location?: string | null; remoteStatus?: string | null }) {
  return isRemotePosting(job) || /\bhybrid\b/.test(normalizeText([job.remoteStatus, job.location].join(" ")));
}

/**
 * Countries a job title names ("Account Executive, Philippines", "…, Saskatchewan / Manitoba",
 * "…, Quebec, Montreal"). Used only when the location field names no country. Bare state codes,
 * "US" and worldwide words ("Global Accounts") are ignored: in a title they are rarely places.
 */
export function titleCountries(title: string | null | undefined) {
  const text = segments(title ?? "").join(" ");
  const countries = new Set<string>();
  const add = (code: string) => countries.add(code);

  for (const [name, code] of [...countryNames, ...nonUsRegions, ...nonUsCities]) {
    if (name.length >= 3 && name !== "usa" && containsPhrase(text, name)) {
      add(code);
    }
  }
  if (` ${text} `.includes(" uk ")) {
    add("GB");
  }
  for (const [phrase, codes] of regionPhrases) {
    if (!codes.includes(anyCountry) && phrase.length >= 4 && containsPhrase(text, phrase)) {
      codes.forEach(add);
    }
  }

  return countries;
}

/** "Remote" or "Hybrid" when a location string says so, for postings whose board gives no work style. */
export function workStyleFromLocation(location: string | null | undefined) {
  const places = locationPlaces(location);
  if (places.some(isRemotePlace)) {
    return "Remote";
  }
  return /\bhybrid\b/.test(normalizeText(location)) ? "Hybrid" : undefined;
}

export type JobLocationFit = "exact" | "remote" | "state" | "country" | "unspecified" | "none";

const fitRank: Record<JobLocationFit, number> = { exact: 5, remote: 4, state: 3, country: 2, unspecified: 1, none: 0 };

/**
 * How a posting's location fits the user's own locations. Description text never counts: a
 * remote place must be remote in a country the user accepts (or name no country), and a hybrid
 * or onsite place must be in the user's city or state, or be country-wide in a country they accept.
 */
export function jobLocationFit({
  location,
  remoteStatus,
  title,
  preferredLocations
}: {
  location?: string | null;
  remoteStatus?: string | null;
  /** Read for a country only when the location field names none. */
  title?: string | null;
  preferredLocations: readonly string[];
}): JobLocationFit {
  const accepted = acceptedCountries(preferredLocations);
  if (accepted.size && !locationCountries(location).size) {
    const named = titleCountries(title);
    if (named.size && ![...named].some((code) => accepted.has(code))) {
      return "none";
    }
  }

  const places = locationPlaces(location);
  if (!places.length) {
    return "unspecified";
  }

  const status = normalizeText(remoteStatus);
  const remoteJob = remoteWords.test(status) && !negatedRemote.test(status);
  let best: JobLocationFit = "none";
  const consider = (fit: JobLocationFit) => {
    if (fitRank[fit] > fitRank[best]) {
      best = fit;
    }
  };

  for (const place of places) {
    if (remoteJob || isRemotePlace(place)) {
      const countries = placeCountries(place);
      const inAcceptedCountry =
        !accepted.size || !countries.size || countries.has(anyCountry) || [...countries].some((code) => accepted.has(code));
      if (inAcceptedCountry) {
        consider("remote");
      }
      continue;
    }

    if (!normalizeText(place).replace(workStyleWords, " ").trim()) {
      consider("unspecified");
      continue;
    }
    if (!preferredLocations.length) {
      consider("unspecified");
      continue;
    }

    const match = locationPreferenceMatch(place, preferredLocations);
    if (match !== "none") {
      consider(match);
      continue;
    }
    if (isCountryOnlyPlace(place) && [...placeCountries(place)].some((code) => accepted.has(code))) {
      consider("country");
    }
  }

  return best;
}
