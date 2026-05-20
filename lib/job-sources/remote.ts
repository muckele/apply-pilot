import { normalizeText } from "@/lib/normalize";

const exactRemoteLocations = new Set(["remote", "anywhere", "united states", "us", "usa"]);

const remoteNegativePhrases = [
  "not remote",
  "not a remote",
  "no remote",
  "non remote",
  "cannot be remote",
  "remote work is not",
  "remote is not",
  "must be onsite",
  "must be on site",
  "onsite only",
  "on site only",
  "in office only"
];

export function isRemoteLikeText(value: string | null | undefined) {
  const text = normalizeText(value);

  if (!text) {
    return false;
  }

  if (remoteNegativePhrases.some((phrase) => text.includes(phrase))) {
    return false;
  }

  if (exactRemoteLocations.has(text)) {
    return true;
  }

  return (
    text.startsWith("remote ") ||
    text.includes(" remote ") ||
    text.includes("work from home") ||
    text.includes("fully remote") ||
    text.includes("100 remote") ||
    text.includes("remote first") ||
    text.includes("remote eligible") ||
    text.includes("remote within") ||
    text.includes("remote in ") ||
    text.includes("remote us") ||
    text.includes("remote united states")
  );
}
