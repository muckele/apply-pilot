import { applicationDocumentFactStartsWithAction } from "@/lib/ai/application-document-facts";

// Owner's live test 2026-11-06: owner-attested facts written as résumé fragments ("At <Org>, owned
// onboarding …", "Owned renewals …") stayed subjectless in the cover letter. This module decides
// where an added I may stand and writes those fragments in the first person.
//
// Owner decisions 2026-11-06 (D033) made these the cover-letter grammar itself
// (lib/ai/application-document-claims.ts checks them):
//   - an added I stands only directly before a verb that is active with the applicant as its
//     subject, at the start of the sentence or after up to three leading framing phrases;
//   - an added was or were stands only before a passive past participle ("I was promoted to …",
//     "<Team> playbooks were adopted by …").
//
// Verbs that résumés often use in the passive ("Promoted to …", "Selected as …", "Trained in …",
// "Converted to full-time", "Hired as …") are deliberately absent from the active list, so an I
// never turns a passive fragment into a different claim ("I promoted …"). A verb followed by "by"
// is passive too.
const ACTIVE_PAST_VERBS = new Set([
  "accelerated", "achieved", "administered", "advised", "advocated", "analyzed", "architected", "arranged",
  "assembled", "audited", "authored", "automated", "balanced", "boosted", "budgeted", "built",
  "championed", "closed", "coached", "collaborated", "completed", "conceived", "conducted", "consolidated",
  "consulted", "contributed", "coordinated", "created", "cultivated", "debugged", "decreased", "defined",
  "delivered", "deployed", "designed", "developed", "devised", "directed", "documented", "doubled",
  "drafted", "drove", "earned", "edited", "eliminated", "enabled", "engineered", "enhanced",
  "established", "evaluated", "exceeded", "executed", "expanded", "facilitated", "forecasted", "founded",
  "generated", "grew", "guided", "handled", "headed", "helped", "identified", "implemented",
  "improved", "increased", "initiated", "integrated", "introduced", "invented", "investigated", "joined",
  "launched", "led", "lowered", "maintained", "managed", "mapped", "marketed", "maximized",
  "measured", "mentored", "migrated", "minimized", "modeled", "modernized", "monitored", "motivated",
  "negotiated", "onboarded", "operated", "optimized", "orchestrated", "organized", "outperformed", "overhauled",
  "owned", "oversaw", "partnered", "performed", "piloted", "pioneered", "planned", "prepared",
  "presented", "prioritized", "processed", "produced", "programmed", "prospected", "proposed", "prototyped",
  "provided", "raised", "ran", "rebuilt", "received", "recommended", "reconciled", "redesigned",
  "reduced", "refactored", "refined", "reorganized", "reported", "researched", "resolved", "restructured",
  "revamped", "reviewed", "revitalized", "saved", "scaled", "scheduled", "secured", "served",
  "shaped", "shipped", "simplified", "sold", "solved", "sourced", "spearheaded", "standardized",
  "started", "steered", "streamlined", "strengthened", "structured", "supervised", "supported", "surpassed",
  "taught", "tested", "tracked", "transformed", "translated", "tripled", "unified", "upgraded",
  "upsold", "used", "utilized", "validated", "won", "worked", "wrote"
]);

// Verbs résumés use in the passive before a preposition ("Recognized for …", "Promoted to …"). With
// that preposition after them they read "I was <verb> …"; otherwise no I is added.
const PASSIVE_VERBS = new Set([
  "appointed", "awarded", "chosen", "elected", "honored", "honoured", "invited", "named", "nominated",
  "promoted", "recognized", "recognised", "selected"
]);
const PASSIVE_PREPOSITIONS = new Set(["among", "as", "at", "by", "for", "from", "in", "into", "to", "with"]);

const IRREGULAR_PARTICIPLES = new Set([
  "begun", "bought", "brought", "built", "caught", "chosen", "done", "drawn", "driven", "found", "given",
  "grown", "heard", "held", "kept", "known", "led", "left", "made", "met", "overseen", "paid", "put",
  "rebuilt", "run", "said", "seen", "sent", "set", "shown", "sold", "sought", "spent", "taken", "taught",
  "told", "understood", "upheld", "won", "written"
]);

// Present forms of the irregular active verbs ("I lead …" from a source that says "Lead …").
const IRREGULAR_PRESENT = new Set([
  "build", "drive", "grow", "lead", "oversee", "rebuild", "run", "sell", "teach", "upsell", "win", "write"
]);

const BE_OR_HAVE = new Set(["am", "are", "be", "been", "being", "had", "has", "have", "is", "was", "were"]);

// A leading framing phrase that ends at its first comma: "At <Org>, …", "After closing a client, …".
const FRAME = /^(?:at|in|for|during|after|before|while|when|with|across|on|over|from|within|throughout|through|since|as)\s[^,;:.!?]{1,120},\s+/iu;
const MAX_FRAMES = 3;

const bare = (word: string) => word.toLocaleLowerCase().replace(/[^\p{L}-]+$/u, "");
const lowerFirst = (value: string) => /^\p{Lu}(?!\p{Lu})/u.test(value) ? `${value[0]!.toLocaleLowerCase()}${value.slice(1)}` : value;

export function isPastParticiple(word: string) {
  return (word.length >= 5 && word.endsWith("ed")) || IRREGULAR_PARTICIPLES.has(word);
}

// A participle that is passive here: never one of the active résumé verbs unless "by" follows it,
// so "was" cannot turn "Managed onboarding …" into "I was managed onboarding …".
export function isPassiveParticiple(word: string, next: string) {
  return isPastParticiple(word) && (!ACTIVE_PAST_VERBS.has(word) || next === "by");
}

export function isActiveCoverVerb(word: string) {
  if (ACTIVE_PAST_VERBS.has(word)) return true;
  if (PASSIVE_VERBS.has(word)) return false;
  if (IRREGULAR_PRESENT.has(word)) return true;
  const regular = [`${word}ed`, `${word}d`, `${word}${word.at(-1)}ed`, word.endsWith("y") ? `${word.slice(0, -1)}ied` : ""];
  return regular.some((value) => value && ACTIVE_PAST_VERBS.has(value)) || applicationDocumentFactStartsWithAction(word);
}

// The words after an added I: an active verb (one -ly adverb may come first), "was" before a
// passive participle, or am/have/had/"do not", whose own placement the claim grammar checks.
function verbFollowsI(words: readonly string[]) {
  const all = words.map(bare);
  const adverb = (all[0] ?? "").length > 3 && (all[0] ?? "").endsWith("ly") ? 1 : 0;
  const [first = "", second = "", third = ""] = all.slice(adverb);
  if (first === "was") return isPassiveParticiple(second, third);
  if (first === "am" || first === "have" || first === "had") return true;
  if (first === "do" || first === "does") return second === "not";
  return isActiveCoverVerb(first) && second !== "by";
}

// Whether the sentence has an I where the verb rule puts one: at its start or after up to three
// leading framing phrases, directly before a verb the applicant performs.
export function firstPersonPlaced(text: string): boolean {
  let rest = text.trim();
  for (let frames = 0; frames <= MAX_FRAMES; frames += 1) {
    const subject = rest.match(/^i\s+/iu);
    if (subject) return verbFollowsI(rest.slice(subject[0].length).split(/\s+/u));
    const frame = rest.match(FRAME);
    if (!frame) return false;
    rest = rest.slice(frame[0].length);
  }
  return false;
}

// The sentence with I inserted before its leading verb (after any framing phrases), or with "I was"
// before a passive verb and its preposition ("Recognized for …" -> "I was recognized for …"), or
// null when there is no safe place for it. The caller still runs the truth check on the result.
export function firstPersonCoverSentence(text: string): string | null {
  const sentence = text.trim();
  if (!sentence || /^i\s/iu.test(sentence)) return null;
  let prefix = "";
  let rest = sentence;
  for (let frames = 0; frames <= MAX_FRAMES; frames += 1) {
    const [verb = "", next = ""] = rest.split(/\s+/u, 2).map(bare);
    if (PASSIVE_VERBS.has(verb) && PASSIVE_PREPOSITIONS.has(next)) return `${prefix}I was ${lowerFirst(rest)}`;
    const leading = !prefix && !PASSIVE_VERBS.has(verb) && applicationDocumentFactStartsWithAction(rest);
    if ((leading || ACTIVE_PAST_VERBS.has(verb)) && next !== "by") return `${prefix}I ${lowerFirst(rest)}`;
    const frame = rest.match(FRAME);
    if (!frame) return null;
    prefix += frame[0];
    rest = rest.slice(frame[0].length);
  }
  return null;
}

// A noun-phrase fact whose verb is a passive participle followed by "by" reads as a sentence with
// was or were before it ("<Team> playbooks adopted by 60+ coordinators: …" -> "… were adopted by
// …"); were after a plural noun, was otherwise. Null when anything before the participle could be a
// verb or a clause boundary.
export function pastPassiveCoverSentence(text: string): string | null {
  const words = text.trim().split(/\s+/u);
  for (let index = 1; index < Math.min(words.length - 1, 9); index += 1) {
    const word = bare(words[index]!);
    if (bare(words[index + 1]!) !== "by" || !isPastParticiple(word)) continue;
    const subject = words.slice(0, index);
    if (subject.some((value) => /[,;:]$/u.test(value) || /^i$/iu.test(value) || BE_OR_HAVE.has(bare(value)) ||
      ACTIVE_PAST_VERBS.has(bare(value)) || isPastParticiple(bare(value)))) return null;
    const be = /[^s]s$/u.test(bare(subject.at(-1)!)) ? "were" : "was";
    return [...subject, be, ...words.slice(index)].join(" ");
  }
  return null;
}
