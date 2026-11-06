import { applicationDocumentFactStartsWithAction } from "@/lib/ai/application-document-facts";

// Owner's live test 2026-11-06: owner-attested facts written as résumé fragments ("At <Org>, owned
// onboarding …", "Owned renewals …") stayed subjectless in the cover letter. The claim grammar
// already lets a claim add the word I (lib/ai/application-document-claims.ts, factualTokens), so a
// fragment can read in the first person without any new word or claim. The grammar accepts an I
// anywhere, though, so this module decides where it may go: only directly before a verb that is
// active in the past tense with the applicant as its subject.
//
// Verbs that résumés often use in the passive ("Promoted to …", "Selected as …", "Trained in …",
// "Converted to full-time", "Hired as …") are deliberately absent, so "I" never turns a passive
// fragment into a different claim ("I promoted …"). A verb followed by "by" is skipped too.
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

// A leading framing phrase that ends at its first comma: "At <Org>, …", "After closing a client, …".
const FRAME = /^(?:at|in|for|during|after|before|while|when|with|across|on|over|from|within|throughout|through|since|as)\s[^,;:.!?]{1,120},\s+/iu;
const MAX_FRAMES = 3;

const bare = (word: string) => word.toLocaleLowerCase().replace(/[^\p{L}-]+$/u, "");
const lowerFirst = (value: string) => /^\p{Lu}(?!\p{Lu})/u.test(value) ? `${value[0]!.toLocaleLowerCase()}${value.slice(1)}` : value;

// The sentence with I inserted before its leading verb (after any framing phrases), or null when
// there is no safe place for it. The caller still runs the unchanged truth check on the result.
export function firstPersonCoverSentence(text: string): string | null {
  const sentence = text.trim();
  if (!sentence || /^i\s/iu.test(sentence)) return null;
  let prefix = "";
  let rest = sentence;
  for (let frames = 0; frames <= MAX_FRAMES; frames += 1) {
    const [verb = "", next = ""] = rest.split(/\s+/u, 2);
    const leading = !prefix && applicationDocumentFactStartsWithAction(rest);
    if ((leading || ACTIVE_PAST_VERBS.has(bare(verb))) && bare(next) !== "by") {
      return `${prefix}I ${lowerFirst(rest)}`;
    }
    const frame = rest.match(FRAME);
    if (!frame) return null;
    prefix += frame[0];
    rest = rest.slice(frame[0].length);
  }
  return null;
}
