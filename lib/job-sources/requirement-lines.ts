import { uniqueStrings } from "@/lib/normalize";

// Requirement lines from a posting pasted as plain text (manual import). A pasted page carries its
// section headings, pay details and benefits as lines of their own, and splitting every line into
// a requirement turned those into "requirements" the owner was asked about. Headings are matched
// as whole lines from short known phrases, never by a word inside a line, so a real requirement
// such as "Experience administering employee benefits platforms" stays a requirement.

type LineKind = "requirement_heading" | "closing_heading" | "context_heading" | "plain_heading" | "pay" | "tag" | "text";

const REQUIREMENT_HEADINGS = [
  /^what you(?:'ll| will)(?: be)? do(?:ing)?$/u,
  /^what you(?:'ll| will) (?:bring|need|work on|own)$/u,
  /^what we(?:'re| are)? look(?:ing)? for(?: in you)?$/u,
  /^(?:key |core |main |primary |your |job |role )?(?:responsibilities|duties)$/u,
  /^(?:job |role |minimum |basic |required |preferred |desired |additional )?(?:requirements|qualifications)$/u,
  /^(?:requirements|qualifications|skills|experience) (?:and|&) (?:qualifications|requirements|skills|experience)$/u,
  /^(?:who you are|about you|you have|you are|you will|you bring|you might also have|you may also have)$/u,
  /^(?:skills|experience|must[- ]haves?|nice[- ]to[- ]haves?|bonus points?(?: if you have)?|pluses|it's a plus if you have)$/u,
  /^(?:about the role|the role|role overview|your role|the opportunity|your impact|in this role(?:,? you will)?|a day in the life|day to day)$/u
];

// Headings after which a posting stops listing requirements: benefits, pay and legal notices.
const CLOSING_HEADINGS = [
  /^(?:our |employee |your )?(?:benefits|perks)(?: (?:and|&) (?:perks|benefits))?$/u,
  /^(?:benefits|perks) (?:designed|built|made|tailored) for you$/u,
  /^what we offer(?: you)?$/u,
  /^what's in it for you$/u,
  /^(?:compensation|salary|pay|total rewards)(?: (?:and|&) benefits| range| details| transparency)?$/u,
  /^(?:equal (?:employment )?opportunity(?: employer)?|eeo statement|accommodations?|how to apply|privacy notice)$/u
];

// Headings that introduce the company rather than the work.
const CONTEXT_HEADINGS = [
  /^about (?:us|[\p{L}\p{N} .&'-]{1,40})$/u,
  /^(?:who we are|our (?:culture|values|mission|story)|company overview|life at [\p{L}\p{N} .&'-]{1,40})$/u,
  /^why (?:join|work (?:at|with|for)) [\p{L}\p{N} .&'-]{1,40}$/u,
  /^remote[- ]first(?: [\p{L} ]{1,40})?$/u
];

const CURRENCY_AMOUNT = String.raw`[$£€]\s?\d[\d,.]*\s?[kKmM]?`;
const PAY_RANGE = new RegExp(`${CURRENCY_AMOUNT}\\s*(?:-|–|—|to)\\s*[$£€]?\\s?\\d`, "u");
const PAY_AMOUNT = new RegExp(CURRENCY_AMOUNT, "u");
const PAY_CONTEXT = /\b(?:base pay|base salary|pay range|salary range|compensation range|pay rate|hourly rate|wage range|per (?:year|annum|hour)|an? (?:year|hour)|annually|hourly)\b|\/\s?(?:yr|year|hr|hour)\b/u;

function comparable(line: string) {
  return line.replace(/[‘’`´]/gu, "'").replace(/\s+/gu, " ").trim().toLowerCase();
}

function isPayLine(line: string) {
  const text = comparable(line);
  if (/^(?:[\p{L}]+ ){0,2}(?:pay|equity|salary|job) grade\b/u.test(text)) return true;
  if (/^(?:salary|compensation|pay|wages?)\s*:/u.test(text) && PAY_AMOUNT.test(text)) return true;
  return PAY_RANGE.test(text) || (PAY_AMOUNT.test(text) && PAY_CONTEXT.test(text));
}

function classify(line: string): LineKind {
  if (/^#[\p{L}][\p{L}\p{N}_-]*$/u.test(line)) return "tag";
  if (isPayLine(line)) return "pay";
  const text = comparable(line);
  const colon = text.endsWith(":");
  const phrase = text.replace(/\s*:$/u, "");
  if (phrase.length <= 60 && !/[.!?;,]$/u.test(phrase)) {
    if (REQUIREMENT_HEADINGS.some((pattern) => pattern.test(phrase))) return "requirement_heading";
    if (CLOSING_HEADINGS.some((pattern) => pattern.test(phrase))) return "closing_heading";
    if (CONTEXT_HEADINGS.some((pattern) => pattern.test(phrase))) return "context_heading";
    if (colon && phrase.split(" ").length <= 8) return "plain_heading";
  }
  return "text";
}

// Whether one stored requirement line could be a requirement at all. It sees the line alone, so
// it only rules out what never is one: a section heading, a pay line or a hashtag.
export function isRequirementLine(line: string) {
  return classify(line.trim()) === "text";
}

function postingLines(text: string) {
  return text
    .split(/\r?\n|•/u)
    .map((line) => line.replace(/^\s*(?:[-*–·▪◦]\s+)+/u, "").trim())
    .filter(Boolean);
}

// With requirement headings, only the lines under them count, until a benefits, pay or company
// heading or a pay line. Without any, every line counts except headings, pay lines and whatever
// follows a benefits or pay heading. Same length limits and cap as splitRequirementText.
export function extractRequirementLines(text: string, maxLength = 220) {
  const lines = postingLines(text).map((line) => ({ line, kind: classify(line) }));
  const sectioned = lines.some((item) => item.kind === "requirement_heading");
  let section: "before" | "requirements" | "other" = "before";
  const kept: string[] = [];
  for (const { line, kind } of lines) {
    if (kind === "requirement_heading") section = "requirements";
    else if (kind === "closing_heading") section = "other";
    else if ((kind === "context_heading" || kind === "pay") && sectioned) section = "other";
    else if (kind === "text" && (sectioned ? section === "requirements" : section !== "other")) kept.push(line);
  }
  return uniqueStrings(kept.filter((item) => item.length > 12 && item.length < maxLength)).slice(0, 24);
}
