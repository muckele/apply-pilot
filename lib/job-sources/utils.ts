import { uniqueStrings } from "@/lib/normalize";

export const prohibitedJobBoardHosts = [
  "linkedin.com",
  "www.linkedin.com",
  "indeed.com",
  "www.indeed.com",
  "ziprecruiter.com",
  "www.ziprecruiter.com",
  "careerbuilder.com",
  "www.careerbuilder.com",
  "glassdoor.com",
  "www.glassdoor.com"
];

export function assertNotProhibitedHost(url: string) {
  const host = new URL(url).hostname.toLowerCase();

  if (prohibitedJobBoardHosts.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) {
    throw new Error(
      "This source is intentionally blocked. Use manual paste/bookmarklet import for job boards that prohibit automated access."
    );
  }
}

const namedEntities: Record<string, string> = {
  nbsp: " ",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  bull: "•"
};

function decodeCodePoint(value: number) {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
}

/** Decodes common named and numeric HTML entities; `&amp;` is decoded last so it is not double-decoded. */
export function decodeHtmlEntities(text: string) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => decodeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => decodeCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => namedEntities[name.toLowerCase()] ?? entity)
    .replace(/&amp;/g, "&");
}

export function htmlToText(html: string) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  return decodeHtmlEntities(text).replace(/\s+/g, " ").trim();
}

/** Plain text of every `<li>` in an HTML document, in order. */
export function htmlBulletItems(html: string) {
  return [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => htmlToText(match[1] ?? ""))
    .filter(Boolean);
}

/** Plain-text items of an HTML list fragment such as `<li>One</li><li>Two</li>`. */
export function htmlListItems(html: string) {
  return html
    .split(/<\/li>/i)
    .map((item) => htmlToText(item))
    .filter(Boolean);
}

/** Maps ATS workplace values (remote, hybrid, onsite/OnSite/on-site) to a display work style. */
export function workStyleLabel(value: unknown) {
  const normalized = typeof value === "string" ? value.toLowerCase().replace(/[\s_-]/g, "") : "";

  if (normalized === "remote") {
    return "Remote";
  }
  if (normalized === "hybrid") {
    return "Hybrid";
  }
  if (normalized === "onsite" || normalized === "inoffice") {
    return "On-site";
  }

  return undefined;
}

export function detectTechStack(text: string) {
  const terms = [
    "JavaScript",
    "TypeScript",
    "React",
    "Node.js",
    "Express",
    "Python",
    "Django",
    "SQL",
    "PostgreSQL",
    "MongoDB",
    "AWS",
    "REST",
    "GraphQL",
    "Salesforce",
    "HubSpot",
    "Zendesk",
    "APIs"
  ];
  const lower = text.toLowerCase();

  return uniqueStrings(terms.filter((term) => lower.includes(term.toLowerCase().replace(".", ""))));
}

// Free text splits on lines and bullet marks; one long line is usually prose, not a
// requirement. A real list item can be a long must-have, so callers splitting known
// bullets may allow more.
export function splitRequirementText(text: string, maxLength = 220) {
  return uniqueStrings(
    text
      .split(/\n|•|- |\* /)
      .map((item) => item.trim())
      .filter((item) => item.length > 12 && item.length < maxLength)
  ).slice(0, 24);
}

export function parseSalaryRange(text?: string | null) {
  if (!text) {
    return {};
  }

  const normalized = text.replace(/,/g, "").toLowerCase();
  const matches = [...normalized.matchAll(/\$?\s*(\d{2,3})(k|000)?/g)]
    .map((match) => {
      const value = Number(match[1]);
      return match[2] === "k" || value < 1000 ? value * 1000 : value;
    })
    .filter((value) => value >= 20000 && value <= 500000);

  if (!matches.length) {
    return {};
  }

  return {
    salaryMin: Math.min(...matches),
    salaryMax: Math.max(...matches)
  };
}

export function pickFirstText(...values: Array<unknown>) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}
