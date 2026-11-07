import { createHash } from "node:crypto";

import { z } from "zod";

import { PublicApiError } from "@/lib/api-errors";
import { isEvidenceBindingCurrent } from "@/lib/jobs/evidence-snapshot-contracts";

// D031: users may edit tailored documents. AI-written lines keep the citations recorded at
// generation; lines the user wrote are marked as theirs; user lines that add claim-bearing
// tokens not found in the cited source facts are flagged for an explicit, timestamped
// confirmation before export. The review lives beside the document text (metadata JSON) and
// is never part of the exported bytes.

export const DOCUMENT_REVIEW_SCHEMA = "apply-pilot/document-review/v1" as const;
const DOCUMENT_REVIEW_METADATA_KEY = "documentReview";

export type DocumentKind = "RESUME" | "COVER_LETTER";
export type DocumentSegmentOrigin = "GENERATED" | "USER_EDIT" | "LEGACY";
export type ClaimTokenKind = "NUMBER" | "DATE" | "CREDENTIAL" | "NAME";

const sha256Pattern = /^[0-9a-f]{64}$/u;
const isoTimestamp = z.string().datetime({ offset: true });
const citationSchema = z.object({
  ref: z.string().min(1).max(512),
  excerpt: z.string().min(1).max(4_000)
}).strict();
const baselineLineSchema = z.object({
  text: z.string().min(1).max(30_000),
  citations: z.array(citationSchema).max(50)
}).strict();
const claimSchema = z.object({
  text: z.string().min(1).max(200),
  token: z.string().min(1).max(200),
  kind: z.enum(["NUMBER", "DATE", "CREDENTIAL", "NAME"])
}).strict();
const baselineSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("GENERATED"),
    evidenceSnapshotId: z.string().min(1).max(191),
    capturedAt: isoTimestamp,
    lines: z.array(baselineLineSchema).max(1_000)
  }).strict(),
  z.object({
    kind: z.literal("LEGACY"),
    capturedAt: isoTimestamp,
    lines: z.array(baselineLineSchema).max(1_000)
  }).strict()
]);
const storedDocumentReviewSchema = z.object({
  schema: z.literal(DOCUMENT_REVIEW_SCHEMA),
  contentHash: z.string().regex(sha256Pattern),
  baseline: baselineSchema,
  segments: z.array(z.object({
    lineIndex: z.number().int().min(0),
    text: z.string().min(1).max(30_000),
    origin: z.enum(["GENERATED", "USER_EDIT", "LEGACY"]),
    citations: z.array(citationSchema).max(50)
  }).strict()).max(1_000),
  flags: z.array(z.object({
    id: z.string().regex(/^flag:[0-9a-f]{24}$/u),
    lineIndex: z.number().int().min(0),
    text: z.string().min(1).max(30_000),
    claims: z.array(claimSchema).min(1).max(100),
    confirmedAt: isoTimestamp.nullable()
  }).strict()).max(1_000),
  legacyConfirmation: z.object({
    confirmedAt: isoTimestamp,
    contentHash: z.string().regex(sha256Pattern)
  }).strict().nullable(),
  updatedAt: isoTimestamp
}).strict();

export type DocumentCitation = z.infer<typeof citationSchema>;
export type DocumentClaimToken = z.infer<typeof claimSchema>;
export type DocumentReviewBaseline = z.infer<typeof baselineSchema>;
export type StoredDocumentReview = z.infer<typeof storedDocumentReviewSchema>;
export type DocumentReviewSegment = StoredDocumentReview["segments"][number];
export type DocumentReviewFlag = StoredDocumentReview["flags"][number];

export type DocumentReadinessState =
  | "NOT_JOB_BOUND"
  | "EVIDENCE_CURRENT"
  | "EDITED_READY"
  | "EDITED_NEEDS_REVIEW"
  | "LEGACY_CONFIRMED"
  | "LEGACY_REVIEW_REQUIRED"
  | "REVIEW_OUTDATED"
  | "EVIDENCE_STALE";

export type DocumentReviewArtifact = {
  evidenceSnapshotId: string | null;
  content: string;
  metadata: unknown;
};

export type DocumentReadinessInput = {
  jobBound: boolean;
  currentEvidenceSnapshotId: string | null;
  currentEvidenceSourceValid: boolean;
  artifact: DocumentReviewArtifact;
};

// Serializable, client-safe projection for the editor UI.
export type DocumentReviewView = {
  state: DocumentReadinessState;
  exportReady: boolean;
  contentHash: string;
  segments: DocumentReviewSegment[];
  flags: DocumentReviewFlag[];
  legacyConfirmedAt: string | null;
};

export function documentContentHash(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function lineKey(value: string) {
  return value.trim().replace(/\s+/gu, " ");
}

function comparable(value: string) {
  return lineKey(value).toLocaleLowerCase();
}

// Bounds the line diff (an O(n*m) table) and the stored review size.
export const MAX_REVIEW_LINES = 1_000;

function splitDocumentLines(content: string) {
  return content.split(/\r?\n/u).flatMap((raw, lineIndex) => {
    const text = raw.trim();
    return text ? [{ lineIndex, text }] : [];
  });
}

function documentLines(content: string) {
  const lines = splitDocumentLines(content);
  if (lines.length > MAX_REVIEW_LINES) {
    throw new PublicApiError(`Documents are limited to ${MAX_REVIEW_LINES} lines of text.`, 422, {
      code: "DOCUMENT_TOO_MANY_LINES"
    });
  }
  return lines;
}

const sectionHeading = /^(?:summary|profile|objective|skills|technical skills|core skills|experience|work experience|professional experience|projects|education|certifications|licenses and certifications|achievements|awards|additional information|additional)\s*:?$/iu;

// Ordinary words that start sentences in résumés and letters. A capitalized word outside this
// list is treated as a possible name, title or employer; a false positive only costs the user a
// confirmation, while a missed invented claim could reach an employer.
const nonClaimWords = new Set([
  "a", "about", "across", "additionally", "after", "all", "also", "am", "an", "and", "any", "are", "as", "at",
  "be", "because", "before", "being", "best", "both", "but", "by", "can", "collaborative", "core", "currently",
  "dear", "dedicated", "during", "each", "every", "excellent", "extensive", "for", "from", "further", "hands-on",
  "have", "having", "here", "highly", "how", "i", "i'm", "i've", "if", "in", "into", "is", "it", "its", "key",
  "kind", "many", "me", "more", "most", "my", "of", "on", "or", "other", "our", "over", "passionate",
  "please", "previously", "professional", "proven", "recently", "regards", "relevant", "responsible", "selected",
  "since", "sincerely", "skilled", "so", "strong", "such", "thank", "thanks", "that", "the", "their", "them",
  "then", "there", "these", "this", "those", "through", "to", "together", "under", "using", "very", "warm",
  "was", "we", "well", "were", "what", "when", "where", "which", "while", "who", "why", "will", "with", "within",
  "would", "yours", "you", "your"
]);

const actionWords = new Set([
  "accelerate", "achieve", "align", "analyze", "architect", "automate", "build", "built", "coach", "collaborate",
  "coordinate", "create", "deliver", "design", "develop", "drive", "enable", "engineer", "establish", "execute",
  "expand", "facilitate", "grew", "grow", "guide", "help", "implement", "improve", "increase", "launch", "lead",
  "led", "maintain", "manage", "mentor", "migrate", "optimize", "own", "partner", "plan", "produce", "ran",
  "reduce", "resolve", "run", "scale", "ship", "shipped", "streamline", "support", "taught", "teach", "transform",
  "use", "won", "wrote", "write"
]);

const credentialWords = new Set([
  "accredited", "accreditation", "associate's", "b.a", "b.s", "ba", "bachelor", "bachelor's", "bachelors", "bs",
  "bsc", "cfa", "certificate", "certificates", "certification", "certifications", "certified", "cpa", "credential",
  "credentials", "degree", "degrees", "diploma", "doctoral", "doctorate", "jd", "license", "licensed", "licenses",
  "licensure", "m.a", "m.s", "master's", "masters", "mba", "msc", "ph.d", "phd", "pmp"
]);

const monthWords = new Set([
  "jan", "january", "feb", "february", "mar", "march", "apr", "april", "may", "jun", "june", "jul", "july", "aug",
  "august", "sep", "sept", "september", "oct", "october", "nov", "november", "dec", "december"
]);

const contactPatterns = [
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gu,
  /\bhttps?:\/\/\S+/giu,
  /\bwww\.\S+/giu,
  /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/gu
];

type RawToken = { text: string; sentenceStart: boolean };

function rawTokens(line: string): RawToken[] {
  let text = line.replace(/^[-*•▪◦–—]\s+/u, "");
  for (const pattern of contactPatterns) text = text.replace(pattern, " | ");
  text = text.replace(/(\d)-(?=\d)/gu, "$1 ");
  const tokens: RawToken[] = [];
  let sentenceStart = true;
  for (const piece of text.split(/[\s|,;:()[\]{}"“”/–—·•]+/u)) {
    const cleaned = piece
      .replace(/^[^\p{L}\p{N}$€£]+/u, "")
      .replace(/[^\p{L}\p{N}%+#]+$/u, "");
    if (cleaned) tokens.push({ text: cleaned, sentenceStart });
    if (piece) sentenceStart = /[.!?]["”’)]*$/u.test(piece);
  }
  return tokens;
}

function normalizeToken(text: string) {
  const lower = text.toLocaleLowerCase().replaceAll("’", "'");
  if (!/\d/u.test(lower)) return lower;
  return lower.replace(/^[$€£]+/u, "").replace(/,/gu, "").replace(/[%+]+$/u, "");
}

function vocabulary(texts: Iterable<string>) {
  const words = new Set<string>();
  for (const text of texts) for (const token of rawTokens(text)) words.add(normalizeToken(token.text));
  return words;
}

function looksLikeVerb(lower: string) {
  return actionWords.has(lower) || /(?:ed|ing)$/u.test(lower);
}

// Deterministic claim-bearing token extraction (D031): numbers and metrics, dates, degrees and
// credentials, and capitalized names or titles (employers, job titles, schools, certifications).
export function extractClaimTokens(line: string): DocumentClaimToken[] {
  const trimmed = line.trim();
  if (!trimmed || sectionHeading.test(trimmed)) return [];
  const headerLike = /\s[|·]\s|\s[–—]\s/u.test(trimmed);
  const claims: DocumentClaimToken[] = [];
  for (const raw of rawTokens(trimmed)) {
    const token = normalizeToken(raw.text);
    const lower = raw.text.toLocaleLowerCase().replaceAll("’", "'");
    let kind: ClaimTokenKind | null = null;
    if (/\d/u.test(raw.text)) {
      kind = /^(?:19|20)\d{2}$/u.test(token) ? "DATE" : "NUMBER";
    } else if (credentialWords.has(lower)) {
      kind = "CREDENTIAL";
    } else if (/^\p{Lu}/u.test(raw.text)) {
      const allCaps = raw.text.length > 1 && raw.text === raw.text.toLocaleUpperCase();
      if (monthWords.has(lower)) kind = "DATE";
      else if (nonClaimWords.has(lower)) kind = null;
      else if (raw.sentenceStart && !headerLike && !allCaps && looksLikeVerb(lower)) kind = null;
      else kind = "NAME";
    }
    if (kind && token) claims.push({ text: raw.text.slice(0, 200), token: token.slice(0, 200), kind });
  }
  return claims;
}

type ClaimEvidenceEntry = { claim: string; citations: DocumentCitation[] };

function claimEvidenceFromMetadata(kind: DocumentKind, metadata: unknown): ClaimEvidenceEntry[] {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  const entries = (metadata as Record<string, unknown>)[kind === "COVER_LETTER" ? "claimsUsed" : "claimEvidence"];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry): ClaimEvidenceEntry[] => {
    if (!entry || typeof entry !== "object") return [];
    const { claim, citations } = entry as Record<string, unknown>;
    if (typeof claim !== "string" || !claim.trim() || !Array.isArray(citations)) return [];
    const parsed = citations.flatMap((citation) => {
      const result = citationSchema.safeParse(citation);
      return result.success ? [result.data] : [];
    });
    return parsed.length ? [{ claim, citations: parsed }] : [];
  });
}

function citationsForLine(line: string, evidence: readonly ClaimEvidenceEntry[]) {
  const key = comparable(line.replace(/^[-*•▪◦–—]\s+/u, ""));
  const seen = new Set<string>();
  const citations: DocumentCitation[] = [];
  for (const entry of evidence) {
    const claim = comparable(entry.claim);
    if (!claim || !key.includes(claim)) continue;
    for (const citation of entry.citations) {
      const identity = `${citation.ref}\u0000${citation.excerpt}`;
      if (seen.has(identity) || citations.length >= 50) continue;
      seen.add(identity);
      citations.push(citation);
    }
  }
  return citations;
}

// The first content edit captures the pre-edit bytes as the baseline. An evidence-bound document
// was never edited (edits clear the binding), so its bytes are exactly the generated text.
export function resolveReviewBaseline(input: {
  kind: DocumentKind;
  existing: DocumentReviewArtifact;
  now: Date;
}): DocumentReviewBaseline {
  const stored = readStoredDocumentReview(input.existing.metadata);
  if (stored) return stored.baseline;
  const capturedAt = input.now.toISOString();
  if (input.existing.evidenceSnapshotId !== null) {
    const evidence = claimEvidenceFromMetadata(input.kind, input.existing.metadata);
    return {
      kind: "GENERATED",
      evidenceSnapshotId: input.existing.evidenceSnapshotId,
      capturedAt,
      lines: documentLines(input.existing.content).map(({ text }) => ({ text, citations: citationsForLine(text, evidence) }))
    };
  }
  // Legacy: no evidence binding and no recorded generation. Never invent citations for it.
  return {
    kind: "LEGACY",
    capturedAt,
    lines: documentLines(input.existing.content).map(({ text }) => ({ text, citations: [] }))
  };
}

function longestCommonSubsequence(left: readonly string[], right: readonly string[]) {
  const table = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] = left[i] === right[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function flagId(text: string, claims: readonly DocumentClaimToken[]) {
  const tokens = [...new Set(claims.map((claim) => claim.token))].sort();
  return `flag:${createHash("sha256").update(JSON.stringify([comparable(text), tokens]), "utf8").digest("hex").slice(0, 24)}`;
}

export function buildDocumentReview(input: {
  baseline: DocumentReviewBaseline;
  content: string;
  previous: StoredDocumentReview | null;
  now: Date;
}): StoredDocumentReview {
  const baselineLines = input.baseline.lines;
  const current = documentLines(input.content);
  const pairs = longestCommonSubsequence(baselineLines.map((line) => lineKey(line.text)), current.map((line) => lineKey(line.text)));
  const matched = new Map<number, number>(pairs.map(([b, c]) => [c, b]));
  const hunks: Array<{ baseline: number[]; current: number[] }> = [];
  let previousBaseline = -1;
  let previousCurrent = -1;
  for (const [b, c] of [...pairs, [baselineLines.length, current.length] as [number, number]]) {
    const hunk = {
      baseline: Array.from({ length: b - previousBaseline - 1 }, (_, offset) => previousBaseline + 1 + offset),
      current: Array.from({ length: c - previousCurrent - 1 }, (_, offset) => previousCurrent + 1 + offset)
    };
    if (hunk.baseline.length || hunk.current.length) hunks.push(hunk);
    previousBaseline = b;
    previousCurrent = c;
  }
  // A line moved elsewhere keeps its generated provenance.
  const unmatchedBaseline = new Set(hunks.flatMap((hunk) => hunk.baseline));
  for (const hunk of hunks) {
    for (const c of hunk.current) {
      const key = lineKey(current[c]!.text);
      const moved = [...unmatchedBaseline].find((b) => lineKey(baselineLines[b]!.text) === key);
      if (moved === undefined) continue;
      unmatchedBaseline.delete(moved);
      matched.set(c, moved);
    }
  }

  const generated = input.baseline.kind === "GENERATED";
  const segments: DocumentReviewSegment[] = current.map((line, c) => {
    const b = matched.get(c);
    if (b === undefined) return { lineIndex: line.lineIndex, text: line.text, origin: "USER_EDIT", citations: [] };
    return {
      lineIndex: line.lineIndex,
      text: line.text,
      origin: generated ? "GENERATED" : "LEGACY",
      citations: generated ? baselineLines[b]!.citations : []
    };
  });

  const priorConfirmations = new Map((input.previous?.flags ?? []).flatMap((flag) =>
    flag.confirmedAt ? [[flag.id, flag.confirmedAt] as const] : []));
  const flags: DocumentReviewFlag[] = [];
  if (generated) {
    const documentWide = vocabulary(baselineLines.flatMap((line) => [line.text, ...line.citations.map((citation) => citation.excerpt)]));
    for (const hunk of hunks) {
      const replaced = hunk.baseline.filter((b) => unmatchedBaseline.has(b));
      // A replaced line is compared with the facts it replaced; a new line with every cited fact.
      const reference = replaced.length
        ? vocabulary(replaced.flatMap((b) => [baselineLines[b]!.text, ...baselineLines[b]!.citations.map((citation) => citation.excerpt)]))
        : documentWide;
      for (const c of hunk.current) {
        if (matched.has(c)) continue;
        const line = current[c]!;
        const seen = new Set<string>();
        const claims = extractClaimTokens(line.text).filter((claim) => {
          if (reference.has(claim.token) || seen.has(claim.token)) return false;
          seen.add(claim.token);
          return true;
        }).slice(0, 100);
        if (!claims.length) continue;
        const id = flagId(line.text, claims);
        flags.push({ id, lineIndex: line.lineIndex, text: line.text, claims, confirmedAt: priorConfirmations.get(id) ?? null });
      }
    }
  }

  const contentHash = documentContentHash(input.content);
  const priorLegacy = input.previous?.legacyConfirmation ?? null;
  return {
    schema: DOCUMENT_REVIEW_SCHEMA,
    contentHash,
    baseline: input.baseline,
    segments,
    flags,
    legacyConfirmation: !generated && priorLegacy?.contentHash === contentHash ? priorLegacy : null,
    updatedAt: input.now.toISOString()
  };
}

export function readStoredDocumentReview(metadata: unknown): StoredDocumentReview | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const parsed = storedDocumentReviewSchema.safeParse((metadata as Record<string, unknown>)[DOCUMENT_REVIEW_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

export function withDocumentReview(metadata: unknown, review: StoredDocumentReview): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return { ...base, [DOCUMENT_REVIEW_METADATA_KEY]: review };
}

export function confirmDocumentReviewFlag(input: {
  review: StoredDocumentReview;
  flagId: string;
  now: Date;
}): StoredDocumentReview {
  if (!input.review.flags.some((flag) => flag.id === input.flagId)) {
    throw new PublicApiError("That flagged edit is no longer part of this document.", 404, {
      code: "DOCUMENT_REVIEW_FLAG_NOT_FOUND"
    });
  }
  const confirmedAt = input.now.toISOString();
  return {
    ...input.review,
    flags: input.review.flags.map((flag) => flag.id === input.flagId && !flag.confirmedAt ? { ...flag, confirmedAt } : flag),
    updatedAt: confirmedAt
  };
}

export function confirmLegacyDocumentReview(input: {
  review: StoredDocumentReview | null;
  content: string;
  now: Date;
}): StoredDocumentReview {
  if (input.review?.baseline.kind === "GENERATED") {
    throw new PublicApiError("This document has fact citations. Confirm its flagged edits instead.", 409, {
      code: "DOCUMENT_REVIEW_NOT_LEGACY"
    });
  }
  const baseline: DocumentReviewBaseline = input.review?.baseline ?? {
    kind: "LEGACY",
    capturedAt: input.now.toISOString(),
    lines: documentLines(input.content).map(({ text }) => ({ text, citations: [] }))
  };
  const rebuilt = buildDocumentReview({ baseline, content: input.content, previous: input.review, now: input.now });
  return {
    ...rebuilt,
    legacyConfirmation: { confirmedAt: input.now.toISOString(), contentHash: rebuilt.contentHash }
  };
}

export function resolveDocumentReadiness(input: DocumentReadinessInput): {
  state: DocumentReadinessState;
  exportReady: boolean;
  review: StoredDocumentReview | null;
  pendingFlagIds: string[];
} {
  const review = readStoredDocumentReview(input.artifact.metadata);
  const result = (state: DocumentReadinessState, pendingFlagIds: string[] = []) => ({
    state,
    exportReady: state === "NOT_JOB_BOUND" || state === "EVIDENCE_CURRENT" || state === "EDITED_READY" || state === "LEGACY_CONFIRMED",
    review,
    pendingFlagIds
  });
  if (!input.jobBound) return result("NOT_JOB_BOUND");
  if (isEvidenceBindingCurrent({
    currentEvidenceSnapshotId: input.currentEvidenceSnapshotId,
    currentEvidenceSourceValid: input.currentEvidenceSourceValid,
    artifactEvidenceSnapshotId: input.artifact.evidenceSnapshotId
  })) return result("EVIDENCE_CURRENT");
  if (input.artifact.evidenceSnapshotId !== null) return result("EVIDENCE_STALE");
  if (!review) return result("LEGACY_REVIEW_REQUIRED");
  const contentHash = documentContentHash(input.artifact.content);
  if (review.baseline.kind === "LEGACY") {
    return result(review.legacyConfirmation?.contentHash === contentHash && review.contentHash === contentHash
      ? "LEGACY_CONFIRMED"
      : "LEGACY_REVIEW_REQUIRED");
  }
  // AI-written lines stay grounded only while the evidence they cite is still the current review.
  if (!isEvidenceBindingCurrent({
    currentEvidenceSnapshotId: input.currentEvidenceSnapshotId,
    currentEvidenceSourceValid: input.currentEvidenceSourceValid,
    artifactEvidenceSnapshotId: review.baseline.evidenceSnapshotId
  })) return result("EVIDENCE_STALE");
  if (review.contentHash !== contentHash) return result("REVIEW_OUTDATED");
  const pending = review.flags.filter((flag) => !flag.confirmedAt).map((flag) => flag.id);
  return result(pending.length ? "EDITED_NEEDS_REVIEW" : "EDITED_READY", pending);
}

export function buildDocumentReviewView(input: DocumentReadinessInput & { kind: DocumentKind }): DocumentReviewView {
  const readiness = resolveDocumentReadiness(input);
  const contentHash = documentContentHash(input.artifact.content);
  const review = readiness.review;
  if (review && review.contentHash === contentHash) {
    return {
      state: readiness.state,
      exportReady: readiness.exportReady,
      contentHash,
      segments: review.segments,
      flags: review.flags,
      legacyConfirmedAt: review.legacyConfirmation?.contentHash === contentHash ? review.legacyConfirmation.confirmedAt : null
    };
  }
  const generated = input.artifact.evidenceSnapshotId !== null;
  const evidence = generated ? claimEvidenceFromMetadata(input.kind, input.artifact.metadata) : [];
  return {
    state: readiness.state,
    exportReady: readiness.exportReady,
    contentHash,
    segments: splitDocumentLines(input.artifact.content).slice(0, MAX_REVIEW_LINES).map(({ lineIndex, text }) => ({
      lineIndex,
      text,
      origin: generated ? "GENERATED" : "LEGACY",
      citations: generated ? citationsForLine(text, evidence) : []
    })),
    flags: [],
    legacyConfirmedAt: null
  };
}

export function documentReadinessError(state: DocumentReadinessState, action: "export" | "packet") {
  if (state === "EVIDENCE_STALE") {
    return new PublicApiError(action === "export"
      ? "Regenerate this document from the current reviewed evidence before exporting it."
      : "Regenerate documents from the current reviewed evidence before saving this packet.", 409, {
      code: "APPLICATION_DOCUMENT_EVIDENCE_STALE"
    });
  }
  const message = state === "LEGACY_REVIEW_REQUIRED"
    ? "Review this document and confirm it is accurate before using it."
    : state === "REVIEW_OUTDATED"
      ? "This document changed after its review. Save it again, then review the flagged edits."
      : "Confirm each flagged edit is accurate before using this document.";
  return new PublicApiError(message, 409, { code: "APPLICATION_DOCUMENT_REVIEW_REQUIRED", reviewState: state });
}
