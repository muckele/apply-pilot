// Only plain http(s) links without embedded credentials are offered, and the hostname is shown so
// the user knows where they are going before they leave Apply Pilot.
export function parseApplyLink(applyUrl: string | null | undefined, sourceUrl: string | null | undefined) {
  const candidate = applyUrl?.trim() || sourceUrl?.trim() || "";
  if (!candidate) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname) return null;
  return { href: url.toString(), hostname: url.hostname, secure: url.protocol === "https:" };
}
