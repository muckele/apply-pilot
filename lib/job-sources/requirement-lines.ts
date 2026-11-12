import { decodeHtmlEntities, splitRequirementText } from "@/lib/job-sources/utils";
import { uniqueStrings } from "@/lib/normalize";

// Requirement lines from a posting: pasted as plain text (manual import) or read from a job board
// (Ashby, Lever, Greenhouse). A posting carries its section headings, company blurbs, pay details
// and benefits as lines of their own, and splitting every line into a requirement turned those
// into "requirements" the owner was asked about and the score judged. Headings are matched
// as whole lines from short known phrases, never by a word inside a line, so a real requirement
// such as "Experience administering employee benefits platforms" stays a requirement.

type LineKind = "requirement_heading" | "closing_heading" | "context_heading" | "plain_heading" | "pay" | "tag" | "text";

// A heading may name the role: "What you'll do as a Solutions Engineer at Example".
const ROLE_SUFFIX = String.raw`(?: (?:as|at|in|on) [\p{L}\p{N} .&'/-]{1,60})?`;

const REQUIREMENT_HEADINGS = [
  new RegExp(String.raw`^what you(?:'ll| will)(?: be)? do(?:ing)?${ROLE_SUFFIX}$`, "u"),
  /^what you(?:'ll| will) (?:bring|need|work on|own)$/u,
  /^(?:here's )?(?:what|who) we(?:'re| are)? look(?:ing)? for(?: in you)?$/u,
  /^how (?:to|you(?:'ll| will)) (?:be successful|succeed|thrive)(?: in (?:this|the) role)?$/u,
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
  /^what you can expect(?: as an? [\p{L}\p{N} .&'-]{1,40}| from us)?$/u,
  /^(?:compensation|salary|pay|total rewards)(?: (?:and|&) benefits| range| details| transparency)?$/u,
  /^(?:equal (?:employment )?opportunity(?: employer)?|eeo statement|accommodations?|how to apply|privacy notice)$/u
];

// Headings that introduce the company rather than the work, or say what the role is not.
const CONTEXT_HEADINGS = [
  /^(?:things|what) we (?:care about|value)$/u,
  /^what you (?:won't|will not) (?:be )?do(?:ing)?$/u,
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
  const phrase = text.replace(/\s*(?::|\.\.\.|…)$/u, "");
  if (phrase.length <= 80 && !/[.!?;,]$/u.test(phrase)) {
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

type PostingLine = { line: string; listItem: boolean };

const LEADING_BULLET = /^\s*(?:[-*–·▪◦]\s+)+/u;

function postingLines(text: string): PostingLine[] {
  return text
    .split(/\r?\n|•/u)
    .map((line) => ({ line: line.replace(LEADING_BULLET, "").trim(), listItem: false }))
    .filter((item) => item.line);
}

const LIST_ITEM_MARK = "\uE000";
const BLOCK_TAG = /<\/?(?:p|div|h[1-6]|ul|ol|li|br|hr|section|article|header|footer|table|tr|td|th|blockquote|dl|dt|dd)\b[^>]*>/giu;

// An HTML posting as lines: every block element is a line of its own, and each `<li>` is one line
// marked as a list item. htmlToText flattens all of it into one paragraph, which loses the headings.
function htmlPostingLines(html: string): PostingLine[] {
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/giu, (_, content: string) => `\n${LIST_ITEM_MARK}${content.replace(/<[^>]+>/gu, " ")}\n`)
    .replace(BLOCK_TAG, "\n")
    .replace(/<[^>]+>/gu, " ");
  return decodeHtmlEntities(text)
    .split("\n")
    .map((raw) => ({
      listItem: raw.trimStart().startsWith(LIST_ITEM_MARK),
      line: raw.replace(LIST_ITEM_MARK, "").replace(/\s+/gu, " ").trim().replace(LEADING_BULLET, "").trim()
    }))
    .filter((item) => item.line);
}

// With requirement headings, only the lines under them count, until a benefits, pay or company
// heading or a pay line. Without any, every line counts except headings, pay lines and whatever
// follows a benefits or pay heading; `withoutHeadings: "none"` keeps nothing then. Same length
// limits and cap as splitRequirementText. In HTML only list items count: its paragraphs are prose.
function requirementLinesFrom(items: PostingLine[], maxLength: number, withoutHeadings: "every_line" | "none", listItemsOnly: boolean) {
  const lines = items.map((item) => ({ ...item, kind: classify(item.line) }));
  const sectioned = lines.some((item) => item.kind === "requirement_heading");
  if (!sectioned && withoutHeadings === "none") return [];
  let section: "before" | "requirements" | "other" = "before";
  const kept: string[] = [];
  for (const { line, listItem, kind } of lines) {
    if (kind === "requirement_heading") section = "requirements";
    else if (kind === "closing_heading") section = "other";
    else if ((kind === "context_heading" || kind === "pay") && sectioned) section = "other";
    else if (kind === "text" && (!listItemsOnly || listItem) && (sectioned ? section === "requirements" : section !== "other")) kept.push(line);
  }
  return uniqueStrings(kept.filter((item) => item.length > 12 && item.length < maxLength)).slice(0, 24);
}

export function extractRequirementLines(text: string, maxLength = 220, options: { withoutHeadings?: "every_line" | "none" } = {}) {
  return requirementLinesFrom(postingLines(text), maxLength, options.withoutHeadings ?? "every_line", false);
}

export function extractRequirementLinesFromHtml(html: string, maxLength = 220) {
  return requirementLinesFrom(htmlPostingLines(html), maxLength, "every_line", true);
}

// A posting already split into titled sections (Lever's lists). Every section's items count unless
// its title is a benefits, pay or company heading, so a title worded in a way no pattern knows
// still keeps its items. Items are lines of their own, so maxLength is the list-item limit.
export function extractRequirementLinesFromSections(sections: Array<{ title?: string; items: string[] }>, maxLength = 220) {
  const kept = sections
    .filter((section) => !["closing_heading", "context_heading", "pay"].includes(classify(section.title?.trim() ?? "")))
    .flatMap((section) => section.items.map((item) => item.replace(LEADING_BULLET, "").trim()))
    .filter((item) => classify(item) === "text" && item.length > 12 && item.length < maxLength);
  return uniqueStrings(kept).slice(0, 24);
}

// Board imports. A posting with nothing to read sections from (one flattened paragraph) still
// lists every line, as before, rather than no requirements at all.
export function boardRequirementLines(sectionAware: string[], text: string, maxLength = 220) {
  return sectionAware.length ? sectionAware : splitRequirementText(text, maxLength);
}
