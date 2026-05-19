import { uniqueStrings } from "@/lib/normalize";

export const prohibitedJobBoardHosts = [
  "linkedin.com",
  "www.linkedin.com",
  "indeed.com",
  "www.indeed.com",
  "ziprecruiter.com",
  "www.ziprecruiter.com",
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

export function htmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
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

export function splitRequirementText(text: string) {
  return uniqueStrings(
    text
      .split(/\n|•|- |\* /)
      .map((item) => item.trim())
      .filter((item) => item.length > 12 && item.length < 220)
  ).slice(0, 24);
}
