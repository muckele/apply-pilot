export const APPLICATION_QUESTION_CLASSIFICATIONS = [
  "CONTACT",
  "PROFESSIONAL_LINK",
  "EXPERIENCE",
  "EDUCATION",
  "SKILL",
  "CITIZENSHIP_IMMIGRATION",
  "WORK_AUTHORIZATION",
  "SPONSORSHIP",
  "AVAILABILITY",
  "RELOCATION",
  "COMPENSATION",
  "DEMOGRAPHIC",
  "DISABILITY",
  "VETERAN",
  "CRIMINAL_HISTORY",
  "LEGAL_ATTESTATION",
  "DOCUMENT",
  "UNKNOWN"
] as const;

export type ApplicationQuestionClassification =
  (typeof APPLICATION_QUESTION_CLASSIFICATIONS)[number];

export const APPLICATION_ANSWER_DISPOSITIONS = [
  "PROPOSABLE",
  "MANUAL_ONLY",
  "EXCLUDED",
  "UNSUPPORTED"
] as const;

export type ApplicationAnswerDisposition = (typeof APPLICATION_ANSWER_DISPOSITIONS)[number];

export const APPLICATION_ANSWER_DISPOSITION_REASONS = [
  "NO_ELIGIBLE_SOURCE",
  "INVALID_SOURCE_VALUE",
  "AMBIGUOUS_SOURCE",
  "UNCONFIRMED_APPLICANT_CONTACT",
  "POLICY_EXCLUDED",
  "LEGAL_ATTESTATION",
  "V1_MANUAL_POLICY",
  "UNSUPPORTED_CONTROL",
  "AMBIGUOUS_FIELD",
  "AMBIGUOUS_CHOICES",
  "MULTIPLE_FILE_UPLOAD",
  "NO_SELECTED_DOCUMENT",
  "UNKNOWN_QUESTION"
] as const;

export type ApplicationAnswerDispositionReason =
  (typeof APPLICATION_ANSWER_DISPOSITION_REASONS)[number];

export const CLASSIFIER_VERSION = 1 as const;

type ClassifierFieldType =
  | "TEXT"
  | "EMAIL"
  | "TEL"
  | "URL"
  | "TEXTAREA"
  | "SELECT_ONE"
  | "SELECT_MANY"
  | "RADIO_GROUP"
  | "CHECKBOX_BOOLEAN"
  | "CHECKBOX_GROUP"
  | "NUMBER"
  | "DATE"
  | "FILE_UPLOAD"
  | "UNSUPPORTED";

export type ClassificationInput = Readonly<{
  question: string | null;
  sectionHeading: string | null;
  helpText: string | null;
  autocomplete: string | null;
  fieldType: ClassifierFieldType;
}>;

export type ClassificationResult = Readonly<{
  classification: ApplicationQuestionClassification;
  semanticFieldKey: string | null;
  permittedDisposition: ApplicationAnswerDisposition;
  dispositionReason: ApplicationAnswerDispositionReason | null;
}>;

type Tokens = readonly string[];
type Evidence = Readonly<{
  question: Tokens;
  section: Tokens;
  help: Tokens;
  autocomplete: string | null;
}>;
type SemanticMatch = Readonly<{
  classification: ApplicationQuestionClassification;
  semanticFieldKey: string | null;
}>;

const AMBIGUOUS_SEMANTIC_MATCH_KEY = "\0ambiguous";

const DISPOSITION_BY_CLASSIFICATION: Readonly<
  Record<ApplicationQuestionClassification, ApplicationAnswerDisposition>
> = {
  CONTACT: "MANUAL_ONLY",
  PROFESSIONAL_LINK: "PROPOSABLE",
  EXPERIENCE: "MANUAL_ONLY",
  EDUCATION: "MANUAL_ONLY",
  SKILL: "MANUAL_ONLY",
  CITIZENSHIP_IMMIGRATION: "EXCLUDED",
  WORK_AUTHORIZATION: "EXCLUDED",
  SPONSORSHIP: "EXCLUDED",
  AVAILABILITY: "PROPOSABLE",
  RELOCATION: "MANUAL_ONLY",
  COMPENSATION: "EXCLUDED",
  DEMOGRAPHIC: "EXCLUDED",
  DISABILITY: "EXCLUDED",
  VETERAN: "EXCLUDED",
  CRIMINAL_HISTORY: "EXCLUDED",
  LEGAL_ATTESTATION: "MANUAL_ONLY",
  DOCUMENT: "PROPOSABLE",
  UNKNOWN: "UNSUPPORTED"
};

const REASON_BY_CLASSIFICATION: Readonly<
  Record<ApplicationQuestionClassification, ApplicationAnswerDispositionReason | null>
> = {
  CONTACT: "UNCONFIRMED_APPLICANT_CONTACT",
  PROFESSIONAL_LINK: null,
  EXPERIENCE: "V1_MANUAL_POLICY",
  EDUCATION: "V1_MANUAL_POLICY",
  SKILL: "V1_MANUAL_POLICY",
  CITIZENSHIP_IMMIGRATION: "POLICY_EXCLUDED",
  WORK_AUTHORIZATION: "POLICY_EXCLUDED",
  SPONSORSHIP: "POLICY_EXCLUDED",
  AVAILABILITY: null,
  RELOCATION: "V1_MANUAL_POLICY",
  COMPENSATION: "POLICY_EXCLUDED",
  DEMOGRAPHIC: "POLICY_EXCLUDED",
  DISABILITY: "POLICY_EXCLUDED",
  VETERAN: "POLICY_EXCLUDED",
  CRIMINAL_HISTORY: "POLICY_EXCLUDED",
  LEGAL_ATTESTATION: "LEGAL_ATTESTATION",
  DOCUMENT: null,
  UNKNOWN: "UNKNOWN_QUESTION"
};

const GENERIC_QUESTIONS: readonly Tokens[] = [
  [],
  ["status"],
  ["response"],
  ["select"],
  ["select", "one"],
  ["please", "select"],
  ["choose", "one"]
];

const CLASSIFIER_IGNORABLE_CODE_POINTS = /[\p{Default_Ignorable_Code_Point}\u2800]/gu;
const CLASSIFIER_IGNORABLE_CODE_POINT = /^[\p{Default_Ignorable_Code_Point}\u2800]$/u;
const UNICODE_MARK = /^\p{M}$/u;
const UNICODE_MARKS = /\p{M}/gu;
const UNICODE_MARK_RUNS = /\p{M}+/gu;
const UNICODE_ORIGINAL_AMBIGUITY_CHARACTER = /^[\p{M}\p{P}\p{S}\p{C}]$/u;
const UNICODE_SYMBOL_CHARACTER = /^\p{S}$/u;
const UNICODE_SCRIPT_OR_SYMBOL = /^[\p{L}\p{M}\p{S}]$/u;
const UNICODE_TOKEN_SEQUENCE = /[\p{L}\p{M}\p{N}]+/gu;
const ASCII_ALPHANUMERIC_TOKEN = /^[A-Za-z0-9]+$/u;
const ASCII_ALPHANUMERIC_CHARACTER = /^[A-Za-z0-9]$/u;
const LATIN_SCRIPT_CHARACTER = /^\p{Script=Latin}$/u;
const NON_LATIN_WRAPPER_BASE_CHARACTER = /^[\p{L}\p{N}]$/u;
const UNICODE_WHITESPACE_CHARACTER = /^\p{White_Space}$/u;
const UNICODE_WHITESPACE_RUNS = /\p{White_Space}+/gu;
const APOSTROPHE_LIKE_CHARACTER = /^[\u0027\u02bb\u02bc\u2018\u2019\uff07]$/u;
const APOSTROPHE_LIKE_CHARACTERS = /[\u02bb\u02bc\u2018\u2019\uff07]/gu;
const MAX_ASCII_POLICY_AMBIGUITY_RUNS = 8;

function projectClassifierSecurityValue(
  value: string | null,
  replacement: "" | " "
): string | null {
  return value === null
    ? null
    : value.normalize("NFKC").replace(CLASSIFIER_IGNORABLE_CODE_POINTS, replacement);
}

function hasClassifierIgnorable(value: string | null): boolean {
  if (value === null) return false;
  const normalized = value.normalize("NFKC");
  return normalized.replace(CLASSIFIER_IGNORABLE_CODE_POINTS, "") !== normalized;
}

function codePointIsInRange(character: string | undefined, minimum: number, maximum: number): boolean {
  const codePoint = character?.codePointAt(0);
  return codePoint !== undefined && codePoint >= minimum && codePoint <= maximum;
}

function isNonAsciiScriptOrSymbol(character: string | undefined): boolean {
  const codePoint = character?.codePointAt(0);
  return (
    codePoint !== undefined &&
    codePoint > 0x7f &&
    !CLASSIFIER_IGNORABLE_CODE_POINT.test(character ?? "") &&
    UNICODE_SCRIPT_OR_SYMBOL.test(character ?? "")
  );
}

function isClassifierIgnorableCharacter(character: string | undefined): boolean {
  return character !== undefined && CLASSIFIER_IGNORABLE_CODE_POINT.test(character);
}

function isVariationSelector(character: string | undefined): boolean {
  return (
    codePointIsInRange(character, 0xfe00, 0xfe0f) ||
    codePointIsInRange(character, 0xe0100, 0xe01ef)
  );
}

function isWellFormedEmojiTagSequence(
  characters: readonly string[],
  index: number
): boolean {
  let start = index;
  while (start > 0 && codePointIsInRange(characters[start - 1], 0xe0020, 0xe007f)) {
    start -= 1;
  }

  let end = index;
  while (
    end + 1 < characters.length &&
    codePointIsInRange(characters[end + 1], 0xe0020, 0xe007f)
  ) {
    end += 1;
  }

  if (characters[start - 1]?.codePointAt(0) !== 0x1f3f4 || end === start) return false;
  if (characters[end]?.codePointAt(0) !== 0xe007f) return false;

  for (let cursor = start; cursor < end; cursor += 1) {
    if (!codePointIsInRange(characters[cursor], 0xe0020, 0xe007e)) return false;
  }
  return true;
}

function isMeaningfulBrailleBlankSequence(
  characters: readonly string[],
  index: number
): boolean {
  let start = index;
  while (start > 0 && characters[start - 1]?.codePointAt(0) === 0x2800) {
    start -= 1;
  }

  let end = index;
  while (end + 1 < characters.length && characters[end + 1]?.codePointAt(0) === 0x2800) {
    end += 1;
  }

  return (
    codePointIsInRange(characters[start - 1], 0x2801, 0x28ff) ||
    codePointIsInRange(characters[end + 1], 0x2801, 0x28ff)
  );
}

function isMeaningfulCgjSequence(characters: readonly string[], index: number): boolean {
  let start = index;
  while (start > 0 && characters[start - 1]?.codePointAt(0) === 0x034f) {
    start -= 1;
  }

  let end = index;
  while (end + 1 < characters.length && characters[end + 1]?.codePointAt(0) === 0x034f) {
    end += 1;
  }

  return (
    UNICODE_MARK.test(characters[start - 1] ?? "") ||
    UNICODE_MARK.test(characters[end + 1] ?? "")
  );
}

function isMeaningfulMusicalControlSequence(
  characters: readonly string[],
  index: number
): boolean {
  let start = index;
  while (start > 0 && codePointIsInRange(characters[start - 1], 0x1d173, 0x1d17a)) {
    start -= 1;
  }

  let end = index;
  while (
    end + 1 < characters.length &&
    codePointIsInRange(characters[end + 1], 0x1d173, 0x1d17a)
  ) {
    end += 1;
  }

  const isVisibleMusicalSymbol = (character: string | undefined): boolean => {
    const codePoint = character?.codePointAt(0);
    return (
      codePoint !== undefined &&
      codePoint >= 0x1d100 &&
      codePoint <= 0x1d1ff &&
      (codePoint < 0x1d173 || codePoint > 0x1d17a)
    );
  };
  return (
    isVisibleMusicalSymbol(characters[start - 1]) ||
    isVisibleMusicalSymbol(characters[end + 1])
  );
}

function isMeaningfulClassifierIgnorable(
  character: string,
  index: number,
  characters: readonly string[]
): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return false;

  const previous = characters[index - 1];
  const next = characters[index + 1];
  const hasAdjacentIgnorable =
    isClassifierIgnorableCharacter(previous) || isClassifierIgnorableCharacter(next);

  if (codePoint === 0x034f) {
    return isMeaningfulCgjSequence(characters, index);
  }
  if (codePoint === 0x17b4 || codePoint === 0x17b5) {
    return (
      !hasAdjacentIgnorable &&
      (codePointIsInRange(previous, 0x1780, 0x17ff) ||
        codePointIsInRange(next, 0x1780, 0x17ff))
    );
  }
  if ((codePoint >= 0x180b && codePoint <= 0x180d) || codePoint === 0x180f) {
    return (
      !hasAdjacentIgnorable &&
      codePointIsInRange(previous, 0x1800, 0x18af)
    );
  }
  if (codePoint === 0x200c) {
    return isNonAsciiScriptOrSymbol(previous) && isNonAsciiScriptOrSymbol(next);
  }
  if (codePoint === 0x200d) {
    const leftBase = isVariationSelector(previous) ? characters[index - 2] : previous;
    return isNonAsciiScriptOrSymbol(leftBase) && isNonAsciiScriptOrSymbol(next);
  }
  if (
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return (
      isNonAsciiScriptOrSymbol(previous) ||
      (/^[#*0-9]$/u.test(previous ?? "") && next?.codePointAt(0) === 0x20e3)
    );
  }
  if (codePoint >= 0xe0020 && codePoint <= 0xe007f) {
    return isWellFormedEmojiTagSequence(characters, index);
  }
  if (codePoint >= 0x1d173 && codePoint <= 0x1d17a) {
    return isMeaningfulMusicalControlSequence(characters, index);
  }
  if (codePoint === 0x2800) {
    return isMeaningfulBrailleBlankSequence(characters, index);
  }
  return false;
}

function hasUnsafeClassifierIgnorable(value: string | null): boolean {
  if (value === null) return false;
  const characters = [...value.normalize("NFKC")];
  return characters.some(
    (character, index) =>
      CLASSIFIER_IGNORABLE_CODE_POINT.test(character) &&
      !isMeaningfulClassifierIgnorable(character, index, characters)
  );
}

function projectClassifierInput(
  input: ClassificationInput,
  replacement: "" | " "
): ClassificationInput {
  return {
    question: projectClassifierSecurityValue(input.question, replacement),
    sectionHeading: projectClassifierSecurityValue(input.sectionHeading, replacement),
    helpText: projectClassifierSecurityValue(input.helpText, replacement),
    autocomplete: projectClassifierSecurityValue(input.autocomplete, replacement),
    fieldType: input.fieldType
  };
}

type AsciiPolicySkeletonPart = string | number;
type AsciiPolicySkeletonTemplate = Readonly<{
  parts: readonly AsciiPolicySkeletonPart[];
  slotCount: number;
}>;

const ORDINARY_APOSTROPHE_WORDS = new Set([
  "applicant's",
  "aren't",
  "can't",
  "candidate's",
  "couldn't",
  "didn't",
  "doesn't",
  "don't",
  "hadn't",
  "hasn't",
  "haven't",
  "he'd",
  "he'll",
  "he's",
  "how's",
  "i'd",
  "i'll",
  "i'm",
  "i've",
  "isn't",
  "it's",
  "let's",
  "she'd",
  "she'll",
  "she's",
  "shouldn't",
  "that's",
  "there's",
  "they'd",
  "they'll",
  "they're",
  "they've",
  "wasn't",
  "we'd",
  "we'll",
  "we're",
  "we've",
  "weren't",
  "what's",
  "who's",
  "won't",
  "wouldn't",
  "you'd",
  "you'll",
  "you're",
  "you've"
]);

const SECURITY_POLICY_EDGE_WORDS = [
  "account", "address", "agency", "applicant", "application", "arrest", "availability",
  "background", "bank", "birthdate", "business", "candidate", "career", "citizen",
  "citizenship", "client", "company", "compensation", "conviction", "criminal",
  "demographic", "disability", "disabled", "diversity", "document", "education", "eeo",
  "eligibility", "employee", "employer", "employment", "equal", "ethnicity", "felony",
  "financial", "firm", "gender", "government", "history", "identity", "immigration",
  "interview", "interviewer", "inventory", "job", "letter", "manager", "military",
  "misdemeanor", "national", "nationality", "office", "opportunity", "organization",
  "passport", "payment", "phone", "platform", "portfolio", "position", "postal",
  "pregnancy", "product", "professional", "project", "pronouns", "race", "record",
  "recruiter", "repository", "resume", "role", "salary", "sample", "security", "social",
  "source", "sponsorship", "status", "store", "tax", "taxpayer", "transcript", "vacancy",
  "veteran", "visa", "website", "work", "writing"
] as const;

function isAsciiSubsequence(candidate: string, value: string): boolean {
  let cursor = 0;
  for (const character of value) {
    if (character === candidate[cursor]) cursor += 1;
  }
  return cursor === candidate.length;
}

function hasSuspiciousPolicyEdgeSkeleton(
  characters: readonly string[],
  start: number,
  end: number
): boolean {
  let left = start;
  while (left > 0 && ASCII_ALPHANUMERIC_CHARACTER.test(characters[left - 1])) left -= 1;
  let right = end;
  while (right < characters.length && ASCII_ALPHANUMERIC_CHARACTER.test(characters[right])) {
    right += 1;
  }
  const skeleton = [...characters.slice(left, start), ...characters.slice(end, right)]
    .join("")
    .toLowerCase();
  if (skeleton.length < 2) return false;
  return SECURITY_POLICY_EDGE_WORDS.some(
    (word) =>
      word.length >= skeleton.length &&
      word.length - skeleton.length <= 2 &&
      isAsciiSubsequence(skeleton, word)
  );
}

function joinsToExactSecurityPolicyWord(value: string, start: number, end: number): boolean {
  let left = start;
  while (left > 0 && ASCII_ALPHANUMERIC_CHARACTER.test(value[left - 1])) left -= 1;
  let right = end;
  while (right < value.length && ASCII_ALPHANUMERIC_CHARACTER.test(value[right])) right += 1;
  const skeleton = `${value.slice(left, start)}${value.slice(end, right)}`.toLowerCase();
  return SECURITY_POLICY_EDGE_WORDS.some((word) => word === skeleton);
}

function canonicalApostropheWord(prefix: string, suffix: string): string {
  return `${prefix}'${suffix}`.toLowerCase();
}

function isOrdinaryAsciiApostropheRun(value: string, start: number, end: number): boolean {
  const run = value.slice(start, end);
  if ([...run].length !== 1 || !APOSTROPHE_LIKE_CHARACTER.test(run)) return false;

  let prefixStart = start;
  while (prefixStart > 0 && /^[A-Za-z]$/u.test(value[prefixStart - 1])) {
    prefixStart -= 1;
  }
  let suffixEnd = end;
  while (suffixEnd < value.length && /^[A-Za-z]$/u.test(value[suffixEnd])) {
    suffixEnd += 1;
  }
  const word = canonicalApostropheWord(
    value.slice(prefixStart, start),
    value.slice(end, suffixEnd)
  );
  return ORDINARY_APOSTROPHE_WORDS.has(word);
}

function hasEmbeddedNonLatinAsciiWrapper(value: string | null): boolean {
  if (value === null) return false;
  const characters = [...value.normalize("NFKD")];
  let cursor = 0;
  while (cursor < characters.length) {
    if (
      ASCII_ALPHANUMERIC_CHARACTER.test(characters[cursor]) ||
      UNICODE_WHITESPACE_CHARACTER.test(characters[cursor])
    ) {
      cursor += 1;
      continue;
    }

    const start = cursor;
    while (
      cursor < characters.length &&
      !ASCII_ALPHANUMERIC_CHARACTER.test(characters[cursor]) &&
      !UNICODE_WHITESPACE_CHARACTER.test(characters[cursor])
    ) {
      cursor += 1;
    }
    const hasAsciiLeft =
      start > 0 && ASCII_ALPHANUMERIC_CHARACTER.test(characters[start - 1]);
    const hasAsciiRight =
      cursor < characters.length && ASCII_ALPHANUMERIC_CHARACTER.test(characters[cursor]);
    if (!hasAsciiLeft && !hasAsciiRight) continue;

    const wrapper = characters.slice(start, cursor);
    if (
      wrapper.some(
        (character) =>
          NON_LATIN_WRAPPER_BASE_CHARACTER.test(character) &&
          !LATIN_SCRIPT_CHARACTER.test(character) &&
          !APOSTROPHE_LIKE_CHARACTER.test(character)
      )
    ) {
      return true;
    }
    if (
      wrapper.some(
        (character) =>
          UNICODE_SYMBOL_CHARACTER.test(character) ||
          APOSTROPHE_LIKE_CHARACTER.test(character)
      ) &&
      hasSuspiciousPolicyEdgeSkeleton(characters, start, cursor)
    ) {
      return true;
    }
  }
  return false;
}

type SecurityDecomposition = Readonly<{
  value: string;
  originalAmbiguityRanges: readonly Readonly<{
    normalizedStart: number;
    normalizedEnd: number;
    originalStart: number;
    originalEnd: number;
  }>[];
}>;

function decomposeClassifierSecurityValue(value: string): SecurityDecomposition {
  const segments: Array<{
    normalizedStart: number;
    normalizedEnd: number;
    originalStart: number;
    originalEnd: number;
    ambiguous: boolean;
  }> = [];
  let normalized = "";
  let originalCursor = 0;
  for (const character of value) {
    const normalizedStart = normalized.length;
    normalized += character.normalize("NFKD");
    const originalEnd = originalCursor + character.length;
    segments.push({
      normalizedStart,
      normalizedEnd: normalized.length,
      originalStart: originalCursor,
      originalEnd,
      ambiguous:
        UNICODE_ORIGINAL_AMBIGUITY_CHARACTER.test(character) ||
        APOSTROPHE_LIKE_CHARACTER.test(character)
    });
    originalCursor = originalEnd;
  }

  const originalAmbiguityRanges: Array<{
    normalizedStart: number;
    normalizedEnd: number;
    originalStart: number;
    originalEnd: number;
  }> = [];
  let cursor = 0;
  while (cursor < segments.length) {
    if (!segments[cursor].ambiguous) {
      cursor += 1;
      continue;
    }
    const start = cursor;
    while (cursor < segments.length && segments[cursor].ambiguous) cursor += 1;
    originalAmbiguityRanges.push({
      normalizedStart: segments[start].normalizedStart,
      normalizedEnd: segments[cursor - 1].normalizedEnd,
      originalStart: segments[start].originalStart,
      originalEnd: segments[cursor - 1].originalEnd
    });
  }
  return { value: normalized, originalAmbiguityRanges };
}

function buildAsciiPolicySkeletonTemplate(value: string | null): AsciiPolicySkeletonTemplate {
  if (value === null) return { parts: [""], slotCount: 0 };

  const decomposition = decomposeClassifierSecurityValue(value);
  const decomposed = decomposition.value;
  const ambiguityRanges: Array<{ start: number; end: number }> = [];
  const atomicResumeRanges: Array<{ start: number; end: number }> = [];
  const addAmbiguityRange = (start: number, end: number): void => {
    ambiguityRanges.push({ start, end });
  };

  // Marks in an ASCII-derived token may either decorate a legitimate Latin
  // spelling or replace a policy-token boundary. Preserve both bounded
  // interpretations without folding marks in non-Latin script tokens.
  for (const match of decomposed.matchAll(UNICODE_TOKEN_SEQUENCE)) {
    const matchIndex = match.index;
    const token = match[0];
    // Résumé is an explicit V1 document keyword in both precomposed and
    // combining-mark spellings. Treat that complete known token atomically;
    // other marked ASCII-derived tokens retain both security interpretations.
    if (token.normalize("NFKC").toLowerCase() === "résumé") {
      atomicResumeRanges.push({ start: matchIndex, end: matchIndex + token.length });
      continue;
    }
    const unmarked = token.replace(UNICODE_MARKS, "");
    if (unmarked.length !== 0 && !ASCII_ALPHANUMERIC_TOKEN.test(unmarked)) continue;

    for (const markMatch of token.matchAll(UNICODE_MARK_RUNS)) {
      const markStart = matchIndex + markMatch.index;
      const markEnd = markStart + markMatch[0].length;
      let expandedStart = markStart;
      let expandedEnd = markEnd;
      while (
        expandedStart > 0 &&
        UNICODE_WHITESPACE_CHARACTER.test(decomposed[expandedStart - 1])
      ) {
        expandedStart -= 1;
      }
      while (
        expandedEnd < decomposed.length &&
        UNICODE_WHITESPACE_CHARACTER.test(decomposed[expandedEnd])
      ) {
        expandedEnd += 1;
      }
      if (
        expandedStart !== markStart ||
        expandedEnd !== markEnd
      ) {
        if (
          ASCII_ALPHANUMERIC_CHARACTER.test(decomposed[expandedStart - 1] ?? "") &&
          ASCII_ALPHANUMERIC_CHARACTER.test(decomposed[expandedEnd] ?? "")
        ) {
          addAmbiguityRange(expandedStart, expandedEnd);
          continue;
        }
      }
      addAmbiguityRange(markStart, markEnd);
    }
  }

  // Select punctuation/symbol/control ambiguity from original scalar
  // provenance before compatibility normalization can erase or expand it.
  // This keeps a spacing accent's introduced space, or a circled letter's
  // ASCII expansion, inside the same bounded join/space interpretation.
  for (const range of decomposition.originalAmbiguityRanges) {
    if (
      atomicResumeRanges.some(
        (atomic) =>
          range.normalizedStart >= atomic.start && range.normalizedEnd <= atomic.end
      )
    ) {
      continue;
    }
    const previous = decomposed[range.normalizedStart - 1];
    const next = decomposed[range.normalizedEnd];
    if (
      ASCII_ALPHANUMERIC_CHARACTER.test(previous ?? "") &&
      ASCII_ALPHANUMERIC_CHARACTER.test(next ?? "") &&
      !isOrdinaryAsciiApostropheRun(
        value,
        range.originalStart,
        range.originalEnd
      )
    ) {
      addAmbiguityRange(range.normalizedStart, range.normalizedEnd);
    }
  }

  // The form canonicalizer intentionally collapses presentation whitespace.
  // Only a whitespace run whose removal reconstructs one exact bounded policy
  // word receives the joined interpretation; ordinary "LinkedIn URL"-style
  // word boundaries remain presentation-only and do not consume slots.
  for (const match of decomposed.matchAll(UNICODE_WHITESPACE_RUNS)) {
    if (joinsToExactSecurityPolicyWord(decomposed, match.index, match.index + match[0].length)) {
      addAmbiguityRange(match.index, match.index + match[0].length);
    }
  }

  ambiguityRanges.sort((left, right) => left.start - right.start || left.end - right.end);
  const mergedRanges: Array<{ start: number; end: number }> = [];
  for (const range of ambiguityRanges) {
    const previous = mergedRanges.at(-1);
    if (previous !== undefined && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      mergedRanges.push({ ...range });
    }
  }

  const parts: AsciiPolicySkeletonPart[] = [];
  let sourceCursor = 0;
  for (const [slot, range] of mergedRanges.entries()) {
    parts.push(decomposed.slice(sourceCursor, range.start));
    parts.push(slot);
    sourceCursor = range.end;
  }
  parts.push(decomposed.slice(sourceCursor));
  return { parts, slotCount: mergedRanges.length };
}

function renderAsciiPolicySkeleton(
  template: AsciiPolicySkeletonTemplate,
  mask: number,
  offset: number
): string {
  return template.parts
    .map((part) =>
      typeof part === "string" ? part : (mask & (1 << (part + offset))) === 0 ? "" : " "
    )
    .join("")
    .normalize("NFKC");
}

function comparisonValue(value: string | null): string | null {
  if (value === null) return null;
  // Storage and hashing preserve legitimate joiners, variation selectors,
  // combining controls, and emoji tags. The classifier alone removes Unicode
  // default-ignorables (plus blank Braille U+2800) from its security comparison
  // projection so none can split an English policy token such as "company" or
  // "recruiter" and increase answer authority.
  return value
    .normalize("NFKC")
    .replace(CLASSIFIER_IGNORABLE_CODE_POINTS, "")
    .replace(APOSTROPHE_LIKE_CHARACTERS, "'")
    // Preserve a plural-possessive boundary as semantic context so a following
    // noun homograph (systems' contacts, processes' resumes) cannot be mistaken
    // for a finite verb and mask its non-applicant owner.
    .replace(/([A-Za-z]+s)'(?=[^A-Za-z0-9]|$)/gu, "$1 possessive")
    .toLowerCase()
    .trim();
}

// Token matching avoids ASCII-only word boundaries and substring mistakes such as
// matching "race" inside "trace". Inputs are bounded by the inspection contract;
// the single flat Unicode expression has no attacker-controlled pattern or nested
// quantifier. Employer text is always inert data.
function tokenize(value: string | null): Tokens {
  return comparisonValue(value)?.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

function sameTokens(left: Tokens, right: Tokens): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function containsPhrase(tokens: Tokens, phrase: Tokens): boolean {
  if (phrase.length === 0 || phrase.length > tokens.length) return false;
  for (let start = 0; start <= tokens.length - phrase.length; start += 1) {
    if (phrase.every((token, offset) => tokens[start + offset] === token)) return true;
  }
  return false;
}

function containsAnyPhrase(tokens: Tokens, phrases: readonly Tokens[]): boolean {
  return phrases.some((phrase) => containsPhrase(tokens, phrase));
}

function containsAnyToken(tokens: Tokens, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => tokens.includes(candidate));
}

function isGenericQuestion(tokens: Tokens): boolean {
  return GENERIC_QUESTIONS.some((candidate) => sameTokens(tokens, candidate));
}

function questionOrGenericContext(evidence: Evidence, phrases: readonly Tokens[]): boolean {
  if (containsAnyPhrase(evidence.question, phrases)) return true;
  return (
    isGenericQuestion(evidence.question) &&
    (containsAnyPhrase(evidence.section, phrases) || containsAnyPhrase(evidence.help, phrases))
  );
}

function exactQuestionOrGenericContext(evidence: Evidence, labels: readonly Tokens[]): boolean {
  if (labels.some((label) => sameTokens(evidence.question, label))) return true;
  return (
    isGenericQuestion(evidence.question) &&
    labels.some((label) => sameTokens(evidence.section, label) || sameTokens(evidence.help, label))
  );
}

function exactQuestionOrEmptyContext(evidence: Evidence, labels: readonly Tokens[]): boolean {
  if (labels.some((label) => sameTokens(evidence.question, label))) return true;
  return (
    evidence.question.length === 0 &&
    labels.some((label) => sameTokens(evidence.section, label) || sameTokens(evidence.help, label))
  );
}

const FIELD_REQUEST_ACTIONS = [
  "add",
  "attach",
  "choose",
  "enter",
  "paste",
  "provide",
  "select",
  "share",
  "submit",
  "upload"
] as const;

function matchesExactFieldRequest(tokens: Tokens, labels: readonly Tokens[]): boolean {
  let cursor = 0;
  if (tokens[cursor] === "please") cursor += 1;
  if (tokens[cursor] === "what" && tokens[cursor + 1] === "is") {
    cursor += 2;
    if (tokens[cursor] !== "your") return false;
    cursor += 1;
  } else if (FIELD_REQUEST_ACTIONS.includes(tokens[cursor] as (typeof FIELD_REQUEST_ACTIONS)[number])) {
    cursor += 1;
    if (["a", "an", "the", "your"].includes(tokens[cursor] ?? "")) cursor += 1;
  } else if (["a", "an", "the", "your"].includes(tokens[cursor] ?? "")) {
    cursor += 1;
  }
  return labels.some((label) => sameTokens(tokens.slice(cursor), label));
}

const PROFESSIONAL_LINK_REQUEST_ACTIONS = [
  "add",
  "enter",
  "paste",
  "provide",
  "share",
  "submit"
] as const;

function matchesProfessionalLinkRequest(tokens: Tokens, labels: readonly Tokens[]): boolean {
  let cursor = 0;
  if (tokens[cursor] === "please") cursor += 1;
  if (tokens[cursor] === "what" && tokens[cursor + 1] === "is") {
    cursor += 2;
    if (tokens[cursor] !== "your") return false;
    cursor += 1;
  } else if (
    PROFESSIONAL_LINK_REQUEST_ACTIONS.includes(
      tokens[cursor] as (typeof PROFESSIONAL_LINK_REQUEST_ACTIONS)[number]
    )
  ) {
    cursor += 1;
    if (["a", "an", "the", "your"].includes(tokens[cursor] ?? "")) cursor += 1;
  } else if (tokens[cursor] === "your") {
    cursor += 1;
  } else {
    return false;
  }
  return labels.some((label) => sameTokens(tokens.slice(cursor), label));
}

const DOCUMENT_TRANSFER_SUFFIXES: readonly Tokens[] = [
  [],
  ["below"],
  ["here"],
  ["file"],
  ["document"],
  ["in", "pdf", "format"],
  ["in", "doc", "format"],
  ["in", "docx", "format"],
  ["as", "a", "pdf"],
  ["as", "a", "doc"],
  ["as", "a", "docx"],
  ["as", "a", "file"],
  ["as", "a", "document"]
];

function matchesDocumentTransferRequest(tokens: Tokens, labels: readonly Tokens[]): boolean {
  let cursor = 0;
  if (tokens[cursor] === "please") cursor += 1;
  if (!FIELD_REQUEST_ACTIONS.includes(tokens[cursor] as (typeof FIELD_REQUEST_ACTIONS)[number])) {
    return false;
  }
  cursor += 1;
  if (["a", "an", "the", "your"].includes(tokens[cursor] ?? "")) cursor += 1;

  return labels.some((label) => {
    if (!sameTokens(tokens.slice(cursor, cursor + label.length), label)) return false;
    const suffix = tokens.slice(cursor + label.length);
    return DOCUMENT_TRANSFER_SUFFIXES.some((candidate) => sameTokens(suffix, candidate));
  });
}

function semanticMatch(
  classification: ApplicationQuestionClassification,
  semanticFieldKey: string | null
): SemanticMatch {
  return { classification, semanticFieldKey };
}

function ambiguousSemanticMatch(): SemanticMatch {
  return semanticMatch("UNKNOWN", AMBIGUOUS_SEMANTIC_MATCH_KEY);
}

function isAmbiguousSemanticMatch(match: SemanticMatch | null): boolean {
  return match?.semanticFieldKey === AMBIGUOUS_SEMANTIC_MATCH_KEY;
}

function isIncidentalLegalWrapper(match: SemanticMatch): boolean {
  return (
    match.classification === "LEGAL_ATTESTATION" &&
    (match.semanticFieldKey === "attestation.certification" ||
      match.semanticFieldKey === "attestation.acknowledgment")
  );
}

function uniqueSemanticMatch(
  classification: ApplicationQuestionClassification,
  semanticFieldKeys: readonly (string | null)[]
): SemanticMatch | null {
  const uniqueKeys = [...new Set(semanticFieldKeys)];
  if (uniqueKeys.length === 0) return null;
  if (uniqueKeys.length > 1) return ambiguousSemanticMatch();
  return semanticMatch(classification, uniqueKeys[0]);
}

function sponsorshipMatch(evidence: Evidence): SemanticMatch | null {
  const phrases = [
    ["require", "sponsorship"],
    ["requires", "sponsorship"],
    ["need", "sponsorship"],
    ["needs", "sponsorship"],
    ["visa", "sponsorship"],
    ["employment", "sponsorship"],
    ["sponsor", "your", "visa"],
    ["sponsor", "you"],
    ["immigration", "sponsorship"]
  ] as const;
  if (!questionOrGenericContext(evidence, phrases)) return null;
  return semanticMatch("SPONSORSHIP", "eligibility.sponsorship");
}

function workAuthorizationMatch(evidence: Evidence): SemanticMatch | null {
  const phrases = [
    ["authorized", "to", "work"],
    ["authorised", "to", "work"],
    ["authorization", "to", "work"],
    ["authorisation", "to", "work"],
    ["work", "authorization"],
    ["work", "authorisation"],
    ["eligible", "to", "work"],
    ["right", "to", "work"],
    ["permission", "to", "work"]
  ] as const;
  if (!questionOrGenericContext(evidence, phrases)) return null;
  return semanticMatch("WORK_AUTHORIZATION", "eligibility.work_authorization");
}

function citizenshipMatch(evidence: Evidence): SemanticMatch | null {
  const immigrationPhrases = [
    ["immigration", "status"],
    ["visa", "status"],
    ["permanent", "resident"],
    ["green", "card"]
  ] as const;
  const semanticFieldKeys: Array<string | null> = [];
  if (questionOrGenericContext(evidence, immigrationPhrases)) {
    semanticFieldKeys.push("eligibility.immigration_status");
  }

  const citizenshipPhrases = [
    ["your", "citizenship"],
    ["citizenship", "status"],
    ["country", "of", "citizenship"],
    ["your", "nationality"],
    ["are", "you", "a", "citizen"],
    ["are", "you", "an", "american", "citizen"],
    ["proof", "of", "citizenship"]
  ] as const;
  if (
    questionOrGenericContext(evidence, citizenshipPhrases) ||
    exactQuestionOrGenericContext(evidence, [["citizen"], ["citizenship"], ["nationality"]])
  ) {
    semanticFieldKeys.push("eligibility.citizenship");
  }
  return uniqueSemanticMatch("CITIZENSHIP_IMMIGRATION", semanticFieldKeys);
}

function compensationMatch(evidence: Evidence): SemanticMatch | null {
  const expectationPhrases = [
    ["salary", "expectation"],
    ["salary", "expectations"],
    ["expected", "salary"],
    ["desired", "salary"],
    ["expected", "compensation"],
    ["desired", "compensation"],
    ["compensation", "expectation"],
    ["compensation", "expectations"],
    ["desired", "pay"],
    ["expected", "pay"],
    ["hourly", "rate"],
    ["pay", "rate"],
    ["salary", "range"]
  ] as const;
  const exactLabels = [["salary"], ["compensation"], ["wage"], ["pay"]] as const;
  if (
    !questionOrGenericContext(evidence, expectationPhrases) &&
    !exactQuestionOrGenericContext(evidence, exactLabels)
  ) {
    return null;
  }
  return semanticMatch("COMPENSATION", "compensation.expectation");
}

function demographicMatch(evidence: Evidence): SemanticMatch | null {
  const semanticFieldKeys: string[] = [];
  const autocomplete = evidence.autocomplete;
  if (autocomplete === "bday" || autocomplete?.startsWith("bday-") === true) {
    semanticFieldKeys.push("demographic.date_of_birth");
  }

  const rules: readonly Readonly<{ phrases: readonly Tokens[]; key: string }>[] = [
    {
      phrases: [["race", "ethnicity"], ["racial", "or", "ethnic", "identity"]],
      key: "demographic.race_ethnicity"
    },
    {
      phrases: [["ethnic", "identity"]],
      key: "demographic.race_ethnicity"
    },
    {
      phrases: [["gender", "identity"], ["sex", "assigned", "at", "birth"]],
      key: "demographic.gender"
    },
    {
      phrases: [["sexual", "orientation"]],
      key: "demographic.sexual_orientation"
    },
    {
      phrases: [["preferred", "pronouns"]],
      key: "demographic.pronouns"
    },
    {
      phrases: [["date", "of", "birth"], ["birth", "date"], ["years", "old"]],
      key: "demographic.date_of_birth"
    },
    {
      phrases: [
        ["marital", "status"],
        ["religious", "affiliation"],
        ["equal", "employment", "opportunity"],
        ["equal", "opportunity", "employer"],
        ["eeo"]
      ],
      key: "demographic.other"
    }
  ];
  for (const rule of rules) {
    if (questionOrGenericContext(evidence, rule.phrases)) {
      semanticFieldKeys.push(rule.key);
    }
  }
  if (exactQuestionOrGenericContext(evidence, [["race"], ["ethnicity"]])) {
    semanticFieldKeys.push("demographic.race_ethnicity");
  }
  if (exactQuestionOrGenericContext(evidence, [["gender"]])) {
    semanticFieldKeys.push("demographic.gender");
  }
  if (exactQuestionOrGenericContext(evidence, [["pronouns"]])) {
    semanticFieldKeys.push("demographic.pronouns");
  }
  if (exactQuestionOrGenericContext(evidence, [["age"], ["religion"]])) {
    semanticFieldKeys.push("demographic.other");
  }
  return uniqueSemanticMatch("DEMOGRAPHIC", semanticFieldKeys);
}

function disabilityMatch(evidence: Evidence): SemanticMatch | null {
  const statusPhrases = [
    ["disability", "status"],
    ["your", "disability"],
    ["have", "a", "disability"],
    ["have", "a", "history", "of", "disability"],
    ["person", "with", "a", "disability"],
    ["are", "you", "disabled"],
    ["identify", "as", "disabled"],
    ["self", "identify", "disability"],
    ["self", "identification", "of", "disability"],
    ["protected", "disability"]
  ] as const;
  if (!questionOrGenericContext(evidence, statusPhrases)) return null;
  return semanticMatch("DISABILITY", "eligibility.disability_status");
}

function veteranMatch(evidence: Evidence): SemanticMatch | null {
  const statusPhrases = [
    ["veteran", "status"],
    ["protected", "veteran"],
    ["are", "you", "a", "veteran"],
    ["have", "you", "served", "in", "the", "military"],
    ["have", "you", "served", "in", "the", "armed", "forces"],
    ["military", "service", "status"]
  ] as const;
  if (!questionOrGenericContext(evidence, statusPhrases)) return null;
  return semanticMatch("VETERAN", "eligibility.veteran_status");
}

function criminalHistoryMatch(evidence: Evidence): SemanticMatch | null {
  const semanticEvidence: Evidence = {
    question: contextAliasTokens(evidence.question),
    section: contextAliasTokens(evidence.section),
    help: contextAliasTokens(evidence.help),
    autocomplete: evidence.autocomplete
  };
  const historyPhrases = [
    ["criminal", "history"],
    ["criminal", "record"],
    ["arrest", "history"],
    ["arrest", "record"],
    ["conviction", "history"],
    ["conviction", "record"],
    ["criminal", "conviction"],
    ["been", "convicted"],
    ["felony", "conviction"],
    ["felony", "record"],
    ["misdemeanor", "conviction"],
    ["misdemeanor", "record"],
    ["felony", "or", "misdemeanor"],
    ["pending", "criminal", "charge"]
  ] as const;
  const backgroundCheckSources = [
    semanticEvidence.question,
    ...(isGenericQuestion(semanticEvidence.question)
      ? [semanticEvidence.section, semanticEvidence.help]
      : [])
  ].filter((tokens) => containsAnyPhrase(tokens, [["background", "check"]]));
  const isConsentToBackgroundCheck = backgroundCheckSources.some((tokens) =>
    containsAnyToken(tokens, ["acknowledge", "agree", "authorise", "authorize", "consent"])
  );
  if (questionOrGenericContext(semanticEvidence, historyPhrases)) {
    return semanticMatch("CRIMINAL_HISTORY", "eligibility.criminal_history");
  }
  if (isConsentToBackgroundCheck) return null;
  if (
    !questionOrGenericContext(semanticEvidence, [["criminal", "background"]]) &&
    backgroundCheckSources.length === 0
  ) {
    return null;
  }
  return semanticMatch("CRIMINAL_HISTORY", "eligibility.criminal_history");
}

function legalAttestationMatch(evidence: Evidence): SemanticMatch | null {
  const rules: readonly Readonly<{ phrases: readonly Tokens[]; key: string }>[] = [
    {
      phrases: [["electronic", "signature"], ["your", "signature"]],
      key: "attestation.signature"
    },
    {
      phrases: [["i", "certify"], ["you", "certify"], ["i", "attest"], ["you", "attest"]],
      key: "attestation.certification"
    },
    {
      phrases: [["i", "acknowledge"], ["you", "acknowledge"]],
      key: "attestation.acknowledgment"
    },
    {
      phrases: [["consent", "to"], ["do", "you", "consent"]],
      key: "attestation.consent"
    },
    {
      phrases: [["arbitration", "agreement"], ["agree", "to", "arbitration"]],
      key: "attestation.arbitration"
    },
    {
      phrases: [["privacy", "policy"], ["privacy", "notice"]],
      key: "attestation.privacy"
    },
    {
      phrases: [
        ["agree", "to", "a", "background", "check"],
        ["consent", "to", "a", "background", "check"],
        ["authorize", "a", "background", "check"]
      ],
      key: "attestation.background_check"
    },
    {
      phrases: [["agree", "to", "a", "drug", "test"], ["consent", "to", "drug", "testing"]],
      key: "attestation.drug_test"
    }
  ];
  const semanticFieldKeys: string[] = [];
  if (exactQuestionOrGenericContext(evidence, [["signature"], ["initials"]])) {
    semanticFieldKeys.push("attestation.signature");
  }
  for (const rule of rules) {
    if (questionOrGenericContext(evidence, rule.phrases)) {
      semanticFieldKeys.push(rule.key);
    }
  }
  const hasSpecificConsent = semanticFieldKeys.some(
    (key) => key === "attestation.background_check" || key === "attestation.drug_test"
  );
  return uniqueSemanticMatch(
    "LEGAL_ATTESTATION",
    hasSpecificConsent
      ? semanticFieldKeys.filter((key) => key !== "attestation.consent")
      : semanticFieldKeys
  );
}

function documentMatch(evidence: Evidence, fieldType: ClassifierFieldType): SemanticMatch | null {
  const resumeLabels = [["resume"], ["résumé"], ["curriculum", "vitae"], ["cv"]] as const;
  const coverLetterLabels = [["cover", "letter"]] as const;
  const semanticEvidence: Evidence = {
    question: withoutFiniteVerbHomographs(evidence.question),
    section: withoutFiniteVerbHomographs(evidence.section),
    help: withoutFiniteVerbHomographs(evidence.help),
    autocomplete: evidence.autocomplete
  };
  const resumeSignal = questionOrGenericContext(semanticEvidence, resumeLabels);
  const coverLetterSignal = questionOrGenericContext(semanticEvidence, coverLetterLabels);
  const firstRequestToken =
    semanticEvidence.question[0] === "please"
      ? semanticEvidence.question[1]
      : semanticEvidence.question[0];
  const hasRequestAction = FIELD_REQUEST_ACTIONS.includes(
    firstRequestToken as (typeof FIELD_REQUEST_ACTIONS)[number]
  );
  if (resumeSignal && coverLetterSignal && hasRequestAction) return ambiguousSemanticMatch();

  const semanticFieldKeys: Array<string | null> = [];
  if (
    resumeSignal &&
    (exactQuestionOrGenericContext(semanticEvidence, resumeLabels) ||
      matchesExactFieldRequest(semanticEvidence.question, resumeLabels) ||
      matchesDocumentTransferRequest(semanticEvidence.question, resumeLabels))
  ) {
    semanticFieldKeys.push("document.resume");
  }
  if (
    coverLetterSignal &&
    (exactQuestionOrGenericContext(semanticEvidence, coverLetterLabels) ||
      matchesExactFieldRequest(semanticEvidence.question, coverLetterLabels) ||
      matchesDocumentTransferRequest(semanticEvidence.question, coverLetterLabels))
  ) {
    semanticFieldKeys.push("document.cover_letter");
  }
  if (semanticFieldKeys.length === 0 && fieldType === "FILE_UPLOAD") {
    semanticFieldKeys.push(null);
  }
  return uniqueSemanticMatch("DOCUMENT", semanticFieldKeys);
}

function relocationMatch(evidence: Evidence): SemanticMatch | null {
  const phrases = [
    ["willing", "to", "relocate"],
    ["able", "to", "relocate"],
    ["open", "to", "relocation"],
    ["relocation", "required"],
    ["relocation", "preference"]
  ] as const;
  if (!questionOrGenericContext(evidence, phrases)) return null;
  return semanticMatch("RELOCATION", "relocation.willingness");
}

function contactMatch(evidence: Evidence, fieldType: ClassifierFieldType): SemanticMatch | null {
  const confirmationTokens = isGenericQuestion(evidence.question)
    ? [...evidence.question, ...evidence.section, ...evidence.help]
    : evidence.question;
  const confirmation = containsAnyToken(confirmationTokens, [
    "confirm",
    "confirmation",
    "reenter",
    "repeat",
    "verify",
    "again"
  ]);
  const semanticFieldKeys: string[] = [];
  if (
    evidence.autocomplete === "email" ||
    fieldType === "EMAIL" ||
    questionOrGenericContext(evidence, [["email", "address"], ["your", "email"], ["contact", "email"]])
  ) {
    semanticFieldKeys.push(confirmation ? "contact.email.confirmation" : "contact.email");
  }
  if (
    evidence.autocomplete === "tel" ||
    evidence.autocomplete?.startsWith("tel-") === true ||
    fieldType === "TEL" ||
    questionOrGenericContext(evidence, [
      ["cell"],
      ["cell", "no"],
      ["contact", "no"],
      ["phone", "number"],
      ["telephone", "number"],
      ["mobile", "number"],
      ["your", "phone"]
    ])
  ) {
    semanticFieldKeys.push(confirmation ? "contact.phone.confirmation" : "contact.phone");
  }

  const autocompleteKeys: Readonly<Record<string, string>> = {
    name: "contact.name.full",
    "given-name": "contact.name.given",
    "family-name": "contact.name.family",
    "additional-name": "contact.name.additional",
    nickname: "contact.name.preferred",
    "street-address": "contact.address.street",
    "address-line1": "contact.address.street",
    "address-line2": "contact.address.street",
    "address-line3": "contact.address.street",
    "address-level1": "contact.address.region",
    "address-level2": "contact.address.city",
    "address-level3": "contact.address.locality",
    "address-level4": "contact.address.locality",
    "postal-code": "contact.address.postal_code",
    country: "contact.address.country",
    "country-name": "contact.address.country"
  };
  if (
    evidence.autocomplete !== null &&
    Object.prototype.hasOwnProperty.call(autocompleteKeys, evidence.autocomplete)
  ) {
    semanticFieldKeys.push(autocompleteKeys[evidence.autocomplete]);
  }

  const rules: readonly Readonly<{ phrases: readonly Tokens[]; key: string }>[] = [
    { phrases: [["full", "name"], ["legal", "name"]], key: "contact.name.full" },
    { phrases: [["first", "name"], ["given", "name"]], key: "contact.name.given" },
    { phrases: [["last", "name"], ["family", "name"], ["surname"]], key: "contact.name.family" },
    { phrases: [["preferred", "name"]], key: "contact.name.preferred" },
    {
      phrases: [["street", "address"], ["mailing", "address"], ["postal", "address"]],
      key: "contact.address.street"
    },
    { phrases: [["postal", "code"], ["zip", "code"]], key: "contact.address.postal_code" }
  ];
  for (const rule of rules) {
    if (questionOrGenericContext(evidence, rule.phrases)) semanticFieldKeys.push(rule.key);
  }
  return uniqueSemanticMatch("CONTACT", semanticFieldKeys);
}

function professionalLinkMatch(evidence: Evidence, fieldType: ClassifierFieldType): SemanticMatch | null {
  if (fieldType !== "URL" && fieldType !== "TEXT" && fieldType !== "UNSUPPORTED") {
    return null;
  }
  const linkedInLabels = [
    ["linkedin"],
    ["linkedin", "profile"],
    ["linkedin", "url"],
    ["linkedin", "link"],
    ["linkedin", "account"],
    ["linkedin", "username"],
    ["linkedin", "profile", "url"],
    ["linked", "in", "profile"]
  ] as const;
  const githubLabels = [
    ["github"],
    ["github", "profile"],
    ["github", "url"],
    ["github", "link"],
    ["github", "account"],
    ["github", "username"],
    ["github", "profile", "url"]
  ] as const;
  const gitlabLabels = [
    ["gitlab"],
    ["gitlab", "profile"],
    ["gitlab", "url"],
    ["gitlab", "link"],
    ["gitlab", "account"],
    ["gitlab", "username"],
    ["gitlab", "profile", "url"]
  ] as const;
  const portfolioLabels = [
    ["portfolio", "url"],
    ["portfolio", "link"],
    ["portfolio", "website"],
    ["portfolio", "site"],
    ["link", "to", "portfolio"]
  ] as const;
  const websiteLabels = [
    ["website"],
    ["website", "url"],
    ["professional", "website"],
    ["professional", "website", "url"],
    ["professional", "website", "link"],
    ["personal", "website"],
    ["personal", "website", "url"],
    ["personal", "website", "link"]
  ] as const;
  const semanticFieldKeys: string[] = [];

  const acceptsLinkLabels = (labels: readonly Tokens[]): boolean =>
    exactQuestionOrEmptyContext(evidence, labels) ||
    matchesProfessionalLinkRequest(evidence.question, labels);

  const linkedInSignal = questionOrGenericContext(evidence, linkedInLabels);
  const githubSignal = questionOrGenericContext(evidence, githubLabels);
  const gitlabSignal = questionOrGenericContext(evidence, gitlabLabels);
  const portfolioSignal = questionOrGenericContext(evidence, portfolioLabels);
  const rawWebsiteSignal = questionOrGenericContext(evidence, websiteLabels);
  const websiteEvidence = [
    evidence.question,
    ...(isGenericQuestion(evidence.question) ? [evidence.section, evidence.help] : [])
  ];
  const hasIndependentWebsiteOccurrence = websiteEvidence.some((tokens) =>
    tokens.some(
      (token, index) =>
        token === "website" &&
        tokens[index - 1] !== "portfolio" &&
        !(tokens[index - 1] === "s" && tokens[index - 2] === "portfolio")
    )
  );
  const websiteSignal =
    rawWebsiteSignal && (!portfolioSignal || hasIndependentWebsiteOccurrence);
  const distinctLinkMeanings = [
    linkedInSignal,
    githubSignal || gitlabSignal,
    portfolioSignal,
    websiteSignal
  ].filter(Boolean).length;
  if ((githubSignal && gitlabSignal) || distinctLinkMeanings > 1) {
    return ambiguousSemanticMatch();
  }

  const linkedIn = linkedInSignal && acceptsLinkLabels(linkedInLabels);
  const github = githubSignal && acceptsLinkLabels(githubLabels);
  const gitlab = gitlabSignal && acceptsLinkLabels(gitlabLabels);
  if (linkedIn) semanticFieldKeys.push("professional.linkedin");
  if (github || gitlab) semanticFieldKeys.push("professional.code_profile");
  if (portfolioSignal && acceptsLinkLabels(portfolioLabels)) {
    semanticFieldKeys.push("professional.portfolio");
  }
  if (fieldType === "URL" && exactQuestionOrEmptyContext(evidence, [["portfolio"]])) {
    semanticFieldKeys.push("professional.portfolio");
  }
  if (
    websiteSignal &&
    acceptsLinkLabels(websiteLabels)
  ) {
    semanticFieldKeys.push("professional.website");
  }
  return uniqueSemanticMatch("PROFESSIONAL_LINK", semanticFieldKeys);
}

function hasProfessionalLinkCandidate(evidence: Evidence): boolean {
  return questionOrGenericContext(evidence, [
    ["linkedin"],
    ["linked", "in", "profile"],
    ["github"],
    ["gitlab"],
    ["portfolio", "url"],
    ["portfolio", "link"],
    ["portfolio", "website"],
    ["professional", "website"],
    ["personal", "website"],
    ["website", "url"]
  ]);
}

function availabilityCandidateMeanings(evidence: Evidence): readonly boolean[] {
  const availabilityEvidence = [
    evidence.question,
    ...(isGenericQuestion(evidence.question) ? [evidence.section, evidence.help] : [])
  ];
  const hasIndependentGeneralAvailability = availabilityEvidence.some((tokens) =>
    tokens.some(
      (token, index) =>
        token === "availability" &&
        tokens[index - 1] !== "interview" &&
        tokens[index - 1] !== "schedule"
    )
  );

  return [
    questionOrGenericContext(evidence, [
      ["start", "date"],
      ["when", "can", "you", "start"],
      ["available", "to", "start"]
    ]),
    questionOrGenericContext(evidence, [["notice", "period"]]),
    questionOrGenericContext(evidence, [
      ["days", "available"],
      ["days", "are", "you", "available"],
      ["hours", "available"],
      ["hours", "are", "you", "available"],
      ["schedule", "availability"],
      ["your", "work", "schedule"]
    ]),
    questionOrGenericContext(evidence, [
      ["interview", "availability"],
      ["available", "for", "an", "interview"]
    ]),
    hasIndependentGeneralAvailability
  ];
}

function availabilityMatch(evidence: Evidence): SemanticMatch | null {
  const semanticFieldKeys: string[] = [];
  if (availabilityCandidateMeanings(evidence).filter(Boolean).length > 1) {
    return ambiguousSemanticMatch();
  }

  const startDateLabels = [
    ["start", "date"],
    ["available", "start", "date"],
    ["earliest", "start", "date"]
  ] as const;
  const startDatePrompts = [
    ...startDateLabels,
    ["when", "can", "you", "start"],
    ["when", "are", "you", "available", "to", "start"],
    ["date", "you", "are", "available", "to", "start"],
    ["employment", "start", "date"],
    ["work", "start", "date"]
  ] as const;
  if (
    exactQuestionOrGenericContext(evidence, startDatePrompts) ||
    matchesExactFieldRequest(evidence.question, startDateLabels)
  ) {
    semanticFieldKeys.push("availability.start_date");
  }
  if (
    exactQuestionOrGenericContext(evidence, [["notice", "period"]]) ||
    matchesExactFieldRequest(evidence.question, [["notice", "period"]])
  ) {
    semanticFieldKeys.push("availability.notice_period");
  }
  const scheduleLabels = [
    ["work", "days", "available"],
    ["work", "hours", "available"],
    ["work", "schedule", "availability"],
    ["your", "work", "schedule"]
  ] as const;
  if (
    exactQuestionOrGenericContext(evidence, [
      ...scheduleLabels,
      ["days", "are", "you", "available", "to", "work"],
      ["which", "days", "are", "you", "available"],
      ["which", "days", "are", "you", "available", "to", "work"],
      ["what", "days", "are", "you", "available", "to", "work"],
      ["hours", "are", "you", "available", "to", "work"],
      ["which", "hours", "are", "you", "available", "to", "work"],
      ["what", "hours", "are", "you", "available", "to", "work"]
    ]) ||
    matchesExactFieldRequest(evidence.question, scheduleLabels)
  ) {
    semanticFieldKeys.push("availability.schedule");
  }
  const interviewLabels = [["interview", "availability"]] as const;
  if (
    exactQuestionOrGenericContext(evidence, [
      ...interviewLabels,
      ["available", "for", "an", "interview"],
      ["are", "you", "available", "for", "an", "interview"],
      ["when", "are", "you", "available", "for", "an", "interview"]
    ]) ||
    matchesExactFieldRequest(evidence.question, interviewLabels)
  ) {
    semanticFieldKeys.push("availability.interview");
  }
  if (exactQuestionOrGenericContext(evidence, [["availability"]])) {
    semanticFieldKeys.push("availability.general");
  }
  return uniqueSemanticMatch("AVAILABILITY", semanticFieldKeys);
}

function hasAvailabilityCandidate(evidence: Evidence): boolean {
  return availabilityCandidateMeanings(evidence).some(Boolean);
}

function experienceMatch(evidence: Evidence): SemanticMatch | null {
  const experiencePhrases = [
    ["years", "of", "experience"],
    ["work", "experience"],
    ["employment", "history"],
    ["professional", "experience"],
    ["previous", "employer"],
    ["current", "employer"],
    ["current", "job", "title"],
    ["describe", "your", "experience"]
  ] as const;
  if (
    !questionOrGenericContext(evidence, experiencePhrases) &&
    !containsAnyToken(evidence.question, ["experience"])
  ) {
    return null;
  }
  const semanticFieldKeys: string[] = [];
  if (containsAnyPhrase(evidence.question, [["years", "of", "experience"]])) {
    semanticFieldKeys.push("experience.years");
  }
  if (containsAnyPhrase(evidence.question, [["employer"], ["company"]])) {
    semanticFieldKeys.push("experience.employer");
  }
  if (containsAnyPhrase(evidence.question, [["job", "title"], ["current", "title"]])) {
    semanticFieldKeys.push("experience.job_title");
  }
  if (semanticFieldKeys.length === 0) semanticFieldKeys.push("experience.general");
  return uniqueSemanticMatch("EXPERIENCE", semanticFieldKeys);
}

function educationMatch(evidence: Evidence): SemanticMatch | null {
  const rules: readonly Readonly<{ phrases: readonly Tokens[]; key: string }>[] = [
    {
      phrases: [
        ["highest", "degree"],
        ["education", "level"],
        ["level", "of", "education"],
        ["studies", "degree"],
        ["degree", "earned"],
        ["degree", "obtained"]
      ],
      key: "education.degree"
    },
    {
      phrases: [["school", "name"], ["college", "name"], ["university", "name"], ["educational", "institution"]],
      key: "education.institution"
    },
    { phrases: [["field", "of", "study"], ["college", "major"], ["academic", "major"]], key: "education.field_of_study" },
    { phrases: [["graduation", "date"], ["graduation", "year"]], key: "education.graduation_date" },
    { phrases: [["grade", "point", "average"], ["gpa"]], key: "education.gpa" }
  ];
  const semanticFieldKeys: string[] = [];
  if (exactQuestionOrGenericContext(evidence, [["degree"], ["education"]])) {
    semanticFieldKeys.push("education.degree");
  }
  for (const rule of rules) {
    if (questionOrGenericContext(evidence, rule.phrases)) semanticFieldKeys.push(rule.key);
  }
  return uniqueSemanticMatch("EDUCATION", semanticFieldKeys);
}

function skillMatch(evidence: Evidence): SemanticMatch | null {
  const rules: readonly Readonly<{ phrases: readonly Tokens[]; key: string }>[] = [
    {
      phrases: [["programming", "languages"], ["languages", "spoken"], ["language", "proficiency"]],
      key: "skill.languages"
    },
    {
      phrases: [["professional", "certification"], ["professional", "certifications"], ["certifications", "held"]],
      key: "skill.certifications"
    },
    {
      phrases: [["technical", "skills"], ["relevant", "skills"], ["skills"], ["proficient", "in"]],
      key: "skill.general"
    }
  ];
  const semanticFieldKeys = rules
    .filter((rule) => questionOrGenericContext(evidence, rule.phrases))
    .map((rule) => rule.key);
  return uniqueSemanticMatch("SKILL", semanticFieldKeys);
}

function ambiguousMatch(): ClassificationResult {
  return {
    classification: "UNKNOWN",
    semanticFieldKey: null,
    permittedDisposition: "UNSUPPORTED",
    dispositionReason: "AMBIGUOUS_FIELD"
  };
}

function finalizeMatch(match: SemanticMatch, fieldType: ClassifierFieldType): ClassificationResult {
  const baseDisposition = permittedDispositionForClassification(match.classification);
  if (fieldType === "UNSUPPORTED" && baseDisposition !== "EXCLUDED") {
    return {
      ...match,
      permittedDisposition: "UNSUPPORTED",
      dispositionReason: "UNSUPPORTED_CONTROL"
    };
  }
  if (
    match.classification === "DOCUMENT" &&
    (fieldType !== "FILE_UPLOAD" || match.semanticFieldKey === null)
  ) {
    return {
      ...match,
      permittedDisposition: "MANUAL_ONLY",
      dispositionReason: "V1_MANUAL_POLICY"
    };
  }
  return {
    ...match,
    permittedDisposition: baseDisposition,
    dispositionReason: dispositionReasonForClassification(match.classification)
  };
}

export function permittedDispositionForClassification(
  classification: ApplicationQuestionClassification
): ApplicationAnswerDisposition {
  return DISPOSITION_BY_CLASSIFICATION[classification];
}

export function dispositionReasonForClassification(
  classification: ApplicationQuestionClassification
): ApplicationAnswerDispositionReason | null {
  return REASON_BY_CLASSIFICATION[classification];
}

export function isDispositionWithinPermitted(
  permittedDisposition: ApplicationAnswerDisposition,
  candidateDisposition: ApplicationAnswerDisposition
): boolean {
  switch (permittedDisposition) {
    case "PROPOSABLE":
      return candidateDisposition === "PROPOSABLE" ||
        candidateDisposition === "MANUAL_ONLY" ||
        candidateDisposition === "UNSUPPORTED";
    case "MANUAL_ONLY":
      return candidateDisposition === "MANUAL_ONLY" || candidateDisposition === "UNSUPPORTED";
    case "EXCLUDED":
      return candidateDisposition === "EXCLUDED";
    case "UNSUPPORTED":
      return candidateDisposition === "UNSUPPORTED";
  }
}

function classifyEvidence(evidence: Evidence, fieldType: ClassifierFieldType): ClassificationResult {
  const sponsorship = sponsorshipMatch(evidence);
  const excludedMatches = [
    workAuthorizationMatch(evidence),
    citizenshipMatch(evidence),
    compensationMatch(evidence),
    demographicMatch(evidence),
    disabilityMatch(evidence),
    veteranMatch(evidence),
    criminalHistoryMatch(evidence)
  ].filter((match): match is SemanticMatch => match !== null);
  if (isAmbiguousSemanticMatch(sponsorship) || excludedMatches.some(isAmbiguousSemanticMatch)) {
    return ambiguousMatch();
  }
  const distinctExcluded = excludedMatches.filter(
    (match, index, matches) =>
      matches.findIndex((candidate) => candidate.classification === match.classification) === index
  );

  const lowerMatches = [
    legalAttestationMatch(evidence),
    relocationMatch(evidence),
    contactMatch(evidence, fieldType),
    documentMatch(evidence, fieldType),
    experienceMatch(evidence),
    educationMatch(evidence),
    skillMatch(evidence),
    professionalLinkMatch(evidence, fieldType),
    availabilityMatch(evidence)
  ].filter((match): match is SemanticMatch => match !== null);
  if (lowerMatches.some(isAmbiguousSemanticMatch)) return ambiguousMatch();
  const distinctLower = lowerMatches.filter(
    (match, index, matches) =>
      matches.findIndex(
        (candidate) =>
          candidate.classification === match.classification &&
          candidate.semanticFieldKey === match.semanticFieldKey
      ) === index
  );
  const unresolvedCandidates = [
    hasProfessionalLinkCandidate(evidence) &&
      !distinctLower.some((match) => match.classification === "PROFESSIONAL_LINK"),
    hasAvailabilityCandidate(evidence) &&
      !distinctLower.some((match) => match.classification === "AVAILABILITY")
  ].filter(Boolean).length;
  const hasResolvedMeaning =
    sponsorship !== null || distinctExcluded.length > 0 || distinctLower.length > 0;
  if (unresolvedCandidates > 1 || (unresolvedCandidates === 1 && hasResolvedMeaning)) {
    return ambiguousMatch();
  }
  const textOnlyEvidence: Evidence = { ...evidence, autocomplete: null };
  const textualLowerMatches = [
    legalAttestationMatch(textOnlyEvidence),
    relocationMatch(textOnlyEvidence),
    contactMatch(textOnlyEvidence, "TEXT"),
    documentMatch(textOnlyEvidence, "TEXT"),
    experienceMatch(textOnlyEvidence),
    educationMatch(textOnlyEvidence),
    skillMatch(textOnlyEvidence),
    professionalLinkMatch(textOnlyEvidence, "TEXT"),
    availabilityMatch(textOnlyEvidence)
  ].filter((match): match is SemanticMatch => match !== null);
  if (textualLowerMatches.some(isAmbiguousSemanticMatch)) return ambiguousMatch();
  const distinctTextualLower = textualLowerMatches.filter(
    (match, index, matches) =>
      matches.findIndex(
        (candidate) =>
          candidate.classification === match.classification &&
          candidate.semanticFieldKey === match.semanticFieldKey
      ) === index
  );

  // Sponsorship is the most specific eligibility rule and intentionally wins over
  // incidental visa/work-authorization wording and a certification wrapper. An
  // independent second meaning is still ambiguous and cannot gain authority.
  if (sponsorship) {
    const independentExcluded = distinctExcluded.filter(
      (match) => match.classification !== "WORK_AUTHORIZATION"
    );
    const independentLower = distinctTextualLower.filter(
      (match) => !isIncidentalLegalWrapper(match)
    );
    if (independentExcluded.length > 0 || independentLower.length > 0) return ambiguousMatch();
    return finalizeMatch(sponsorship, fieldType);
  }

  // A specific excluded eligibility/status meaning wins over a certification or
  // consent wrapper. All other independent compounds fail closed.
  if (distinctExcluded.length > 1) return ambiguousMatch();
  if (distinctExcluded.length === 1) {
    const independentLower = distinctTextualLower.filter(
      (match) => !isIncidentalLegalWrapper(match)
    );
    if (independentLower.length > 0) return ambiguousMatch();
    return finalizeMatch(distinctExcluded[0], fieldType);
  }

  if (distinctLower.length > 1) return ambiguousMatch();
  if (distinctLower.length === 1) return finalizeMatch(distinctLower[0], fieldType);

  return finalizeMatch(semanticMatch("UNKNOWN", null), fieldType);
}

type EvidenceSource = "question" | "section" | "help";
type SourceObservation = Readonly<{
  source: EvidenceSource;
  tokens: Tokens;
  result: ClassificationResult;
}>;

const EXCLUDED_CLASSIFICATIONS = new Set<ApplicationQuestionClassification>([
  "CITIZENSHIP_IMMIGRATION",
  "WORK_AUTHORIZATION",
  "SPONSORSHIP",
  "COMPENSATION",
  "DEMOGRAPHIC",
  "DISABILITY",
  "VETERAN",
  "CRIMINAL_HISTORY"
]);

const PROPOSABLE_CLASSIFICATIONS = new Set<ApplicationQuestionClassification>([
  "PROFESSIONAL_LINK",
  "AVAILABILITY",
  "DOCUMENT"
]);

function observeSource(
  source: EvidenceSource,
  tokens: Tokens,
  fieldType: ClassifierFieldType = "TEXT"
): SourceObservation | null {
  if (tokens.length === 0) return null;
  const semanticTokens = withoutFiniteVerbHomographs(tokens);
  if (semanticTokens.length === 0) return null;
  // Context lanes are interpreted as text-only evidence. This deliberately
  // prevents an EMAIL or FILE_UPLOAD control type from manufacturing a meaning
  // for unrelated section/help text while retaining source provenance. The
  // primary question may use the actual control type for direct-label grammar.
  const result = classifyEvidence(
    { question: semanticTokens, section: [], help: [], autocomplete: null },
    fieldType
  );
  return result.classification === "UNKNOWN" ||
    (result.classification === "DOCUMENT" && result.semanticFieldKey === null)
    ? null
    : { source, tokens, result };
}

function sameObservedMeaning(left: SourceObservation, right: SourceObservation): boolean {
  return (
    left.result.classification === right.result.classification &&
    left.result.semanticFieldKey === right.result.semanticFieldKey
  );
}

function isCompatibleContextObservation(
  base: ClassificationResult,
  observation: SourceObservation
): boolean {
  if (
    observation.result.classification === base.classification &&
    observation.result.semanticFieldKey === base.semanticFieldKey
  ) {
    return true;
  }
  return (
    observation.source !== "question" &&
    base.classification === "AVAILABILITY" &&
    base.semanticFieldKey?.startsWith("availability.") === true &&
    observation.result.classification === "AVAILABILITY" &&
    observation.result.semanticFieldKey === "availability.general"
  );
}

function containsApplicantOrientation(tokens: Tokens): boolean {
  return containsAnyToken(tokens, ["you", "your", "applicant", "candidate"]);
}

function isAuthoritativeProposerObservation(observation: SourceObservation): boolean {
  if (!PROPOSABLE_CLASSIFICATIONS.has(observation.result.classification)) return false;
  // A concrete primary field label is itself an applicant request. Context may
  // grant proposal authority only when that same source names the applicant.
  return observation.source === "question"
    ? !isGenericQuestion(observation.tokens)
    : containsApplicantOrientation(observation.tokens);
}

type ConceptOwnership = "DIRECT_APPLICANT" | "APPLICANT" | "NON_APPLICANT" | "UNKNOWN";

const APPLICANT_OWNER_TOKENS = ["you", "your", "yours", "applicant", "candidate"] as const;
const NON_APPLICANT_PRONOUN_TOKENS = [
  "we",
  "us",
  "our",
  "ours",
  "he",
  "they",
  "them",
  "their",
  "theirs",
  "his",
  "him",
  "she",
  "her",
  "hers",
  "its",
  "it"
] as const;

function isNonApplicantOwnerToken(token: string, nonApplicantOwners: readonly string[]): boolean {
  if (nonApplicantOwners.includes(token)) return true;
  let singular = token;
  if (token.endsWith("ies")) {
    singular = `${token.slice(0, -3)}y`;
  } else if (/(?:sses|xes|zes|ches|shes)$/u.test(token)) {
    singular = token.slice(0, -2);
  } else if (token.endsWith("s") && !token.endsWith("ss")) {
    singular = token.slice(0, -1);
  }
  return nonApplicantOwners.includes(singular);
}

function hasExplicitOtherApplicantScope(tokens: Tokens): boolean {
  const qualifiers = ["all", "another", "any", "different", "each", "every", "multiple", "other"];
  const directApplicantOwners = new Set(["you", "your", "yours"]);
  const clauseBoundaries = new Set(["although", "but", "except", "however", "instead", "then", "whereas"]);
  return tokens.some((token, index) => {
    if (token === "applicants" || token === "candidates") return true;
    if (token !== "applicant" && token !== "candidate") return false;
    for (let qualifierIndex = index - 1; qualifierIndex >= 0; qualifierIndex -= 1) {
      if (clauseBoundaries.has(tokens[qualifierIndex])) return false;
      // The nearest explicit owner binds the singular noun. Do not carry a
      // remote quantifier from an unrelated noun phrase through "your" in,
      // for example, "Every field ... for your applicant profile".
      if (directApplicantOwners.has(tokens[qualifierIndex])) return false;
      if (qualifiers.includes(tokens[qualifierIndex])) return true;
    }
    return false;
  });
}

const ACTIVE_NON_APPLICANT_RELATION_TOKENS = new Set([
  "administer",
  "administering",
  "administers",
  "attach",
  "attaches",
  "attaching",
  "author",
  "authoring",
  "authors",
  "belong",
  "belonged",
  "belonging",
  "belongs",
  "control",
  "controlling",
  "controls",
  "create",
  "creates",
  "creating",
  "determine",
  "determines",
  "determining",
  "issue",
  "issues",
  "issuing",
  "maintain",
  "maintaining",
  "maintains",
  "manage",
  "manages",
  "managing",
  "operate",
  "operates",
  "operating",
  "own",
  "owning",
  "owns",
  "provide",
  "provides",
  "providing",
  "request",
  "requesting",
  "requests",
  "set",
  "sets",
  "setting",
  "submit",
  "submits",
  "submitting",
  "upload",
  "uploading",
  "uploads",
  "use",
  "uses",
  "using",
  "write",
  "wrote",
  "writes",
  "writing"
]);

const NON_APPLICANT_RELATION_TOKENS = new Set([
  ...ACTIVE_NON_APPLICANT_RELATION_TOKENS,
  "administered",
  "attached",
  "authored",
  "by",
  "controlled",
  "created",
  "determined",
  "for",
  "from",
  "issued",
  "maintained",
  "managed",
  "of",
  "operated",
  "owned",
  "provided",
  "requested",
  "submitted",
  "uploaded",
  "used",
  "written"
]);

function hasExplicitNonApplicantPronounRelation(tokens: Tokens): boolean {
  return (
    containsAnyToken(tokens, NON_APPLICANT_PRONOUN_TOKENS) &&
    tokens.some((token) => NON_APPLICANT_RELATION_TOKENS.has(token))
  );
}

function ownershipBeforeConcept(
  tokens: Tokens,
  conceptIndex: number,
  nonApplicantOwners: readonly string[]
): ConceptOwnership {
  let weakApplicantOwner = false;
  for (let index = conceptIndex - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (containsAnyToken([token], APPLICANT_OWNER_TOKENS)) {
      if (token !== "applicant" && token !== "candidate") return "DIRECT_APPLICANT";
    }
    if (["applicant", "applicants", "candidate", "candidates"].includes(token)) {
      if (
        containsAnyToken(tokens.slice(Math.max(0, index - 2), index), [
          "another",
          "all",
          "any",
          "different",
          "each",
          "every",
          "multiple",
          "other"
        ])
      ) {
        return "NON_APPLICANT";
      }
      // Applicant/candidate can be a descriptive noun (for example in
      // "recruiter's ... candidate résumé"), so keep looking for an explicit
      // possessive owner. Direct you/your above remains decisive.
      weakApplicantOwner = true;
      continue;
    }
    if (containsAnyToken([token], NON_APPLICANT_PRONOUN_TOKENS)) {
      return "NON_APPLICANT";
    }
    if (isNonApplicantOwnerToken(token, nonApplicantOwners)) {
      if (!weakApplicantOwner || tokens[index + 1] === "s") return "NON_APPLICANT";
    }
  }
  return weakApplicantOwner ? "APPLICANT" : "UNKNOWN";
}

function ownershipAfterConnector(
  tokens: Tokens,
  connectorIndex: number,
  nonApplicantOwners: readonly string[]
): ConceptOwnership {
  const clauseBoundaries = new Set(["but", "except", "however", "instead", "then", "whereas"]);
  let applicantOwner = false;
  for (let index = connectorIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (clauseBoundaries.has(token)) break;
    if (["applicant", "applicants", "candidate", "candidates"].includes(token)) {
      if (
        containsAnyToken(tokens.slice(Math.max(connectorIndex + 1, index - 2), index), [
          "another",
          "all",
          "any",
          "different",
          "each",
          "every",
          "multiple",
          "other"
        ])
      ) {
        return "NON_APPLICANT";
      }
      applicantOwner = true;
      continue;
    }
    if (containsAnyToken([token], ["you", "your", "yours"])) {
      applicantOwner = true;
      continue;
    }
    if (
      containsAnyToken([token], NON_APPLICANT_PRONOUN_TOKENS) ||
      isNonApplicantOwnerToken(token, nonApplicantOwners)
    ) {
      return "NON_APPLICANT";
    }
  }
  return applicantOwner ? "APPLICANT" : "UNKNOWN";
}

function hasNonApplicantOwnedConcept(
  tokens: Tokens,
  nonApplicantOwners: readonly string[],
  conceptTokens: readonly string[]
): boolean {
  return tokens.some((token, conceptIndex) => {
    if (!conceptTokens.includes(token)) return false;
    if (hasExplicitOtherApplicantScope(tokens)) return true;
    const ownership = ownershipBeforeConcept(tokens, conceptIndex, nonApplicantOwners);
    if (ownership === "DIRECT_APPLICANT") return false;
    if (ownership === "NON_APPLICANT") return true;

    for (let connectorIndex = conceptIndex + 1; connectorIndex < tokens.length; connectorIndex += 1) {
      if (!NON_APPLICANT_RELATION_TOKENS.has(tokens[connectorIndex])) continue;
      const connectorOwnership = ownershipAfterConnector(tokens, connectorIndex, nonApplicantOwners);
      if (connectorOwnership === "NON_APPLICANT") return true;
    }

    // Active postpositive possession ("website that we own") is resolved at
    // the verb so the closest subject wins ("website we want you to own").
    for (let verbIndex = conceptIndex + 1; verbIndex < tokens.length; verbIndex += 1) {
      if (!ACTIVE_NON_APPLICANT_RELATION_TOKENS.has(tokens[verbIndex])) continue;
      if (ownershipBeforeConcept(tokens, verbIndex, nonApplicantOwners) === "NON_APPLICANT") {
        return true;
      }
    }
    return false;
  });
}

const SENSITIVE_IDENTIFIER_PHRASES: readonly Tokens[] = [
  ["ssn"],
  ["ssns"],
  ["s", "s", "n"],
  ["your", "sin"],
  ["sins"],
  ["sin", "number"],
  ["sin", "no"],
  ["s", "i", "n"],
  ["your", "tin"],
  ["tins"],
  ["tin", "number"],
  ["tin", "no"],
  ["t", "i", "n"],
  ["your", "pin"],
  ["pins"],
  ["pin", "number"],
  ["pin", "no"],
  ["p", "i", "n"],
  ["cvv"],
  ["cvvs"],
  ["c", "v", "v"],
  ["social", "security"],
  ["social", "security", "number"],
  ["social", "security", "no"],
  ["social", "security", "id"],
  ["social", "insurance", "number"],
  ["social", "insurance", "no"],
  ["national", "insurance", "number"],
  ["national", "insurance", "no"],
  ["national", "insurance"],
  ["national", "identification", "number"],
  ["national", "identity", "number"],
  ["national", "id"],
  ["national", "ids"],
  ["taxpayer", "identification", "number"],
  ["taxpayer", "identification", "numbers"],
  ["taxpayer", "id"],
  ["taxpayer", "ids"],
  ["tax", "identification", "number"],
  ["tax", "identification", "numbers"],
  ["tax", "id"],
  ["tax", "ids"],
  ["personal", "identification", "number"],
  ["personal", "identification", "numbers"],
  ["government", "identification", "number"],
  ["government", "id"],
  ["government", "ids"],
  ["government", "issued", "id"],
  ["passport"],
  ["passport", "number"],
  ["passport", "no"],
  ["passport", "id"],
  ["driver", "s", "license"],
  ["driver", "s", "licence"],
  ["drivers", "license"],
  ["drivers", "licence"],
  ["driver", "license"],
  ["driver", "licence"],
  ["driver", "license", "number"],
  ["driver", "licence", "number"],
  ["driving", "license"],
  ["driving", "licence"],
  ["bank", "account"],
  ["bank", "accounts"],
  ["bank", "details"],
  ["bank", "information"],
  ["account", "number"],
  ["account", "numbers"],
  ["account", "details"],
  ["routing", "number"],
  ["routing", "no"],
  ["routing"],
  ["aba", "code"],
  ["sort", "code"],
  ["iban"],
  ["ibans"],
  ["swift", "code"],
  ["swift", "codes"],
  ["credit", "card"],
  ["debit", "card"],
  ["card", "number"],
  ["card", "numbers"],
  ["card", "details"],
  ["banking", "details"],
  ["banking", "information"],
  ["aba", "codes"],
  ["sort", "codes"]
];

const SENSITIVE_PROHIBITION_OBJECT_TOKENS = new Set([
  ...SENSITIVE_IDENTIFIER_PHRASES.flat(),
  "a",
  "an",
  "and",
  "any",
  "as",
  "circumstances",
  "details",
  "field",
  "fields",
  "for",
  "in",
  "information",
  "no",
  "number",
  "numbers",
  "of",
  "or",
  "the",
  "this",
  "to",
  "under",
  "your"
]);

function sensitiveIdentifierStartIndices(tokens: Tokens): readonly number[] {
  const starts: number[] = [];
  for (let start = 0; start < tokens.length; start += 1) {
    if (
      SENSITIVE_IDENTIFIER_PHRASES.some((phrase) =>
        phrase.every((token, offset) => tokens[start + offset] === token)
      )
    ) {
      starts.push(start);
    }
  }
  return starts;
}

function containsSensitiveIdentifier(tokens: Tokens): boolean {
  // PIN/SIN/TIN are sensitive only as exact standalone field labels here.
  // Treating the bare token as a phrase would misclassify ordinary instructions
  // such as "Pin this field" and non-identifier uses of "sin" or "tin".
  return (
    (tokens.length === 1 && containsAnyToken(tokens, ["pin", "sin", "tin"])) ||
    sensitiveIdentifierStartIndices(tokens).length > 0
  );
}

function isClearSensitiveProhibitionClause(tokens: Tokens): boolean {
  const actions = new Set([
    "add",
    "adding",
    "ask",
    "disclose",
    "disclosing",
    "enter",
    "entering",
    "include",
    "including",
    "paste",
    "pasting",
    "provide",
    "providing",
    "send",
    "sending",
    "share",
    "sharing",
    "submit",
    "submitting",
    "upload",
    "uploading",
    "use",
    "using"
  ]);
  if (!containsSensitiveIdentifier(tokens)) return false;

  // This exception deliberately recognizes only whole, source-local negative
  // clauses. Parsing a small complete grammar is safer than inferring that a
  // distant negator governs arbitrary trailing employer text.
  if (
    tokens.length >= 3 &&
    tokens[tokens.length - 3] === "is" &&
    (tokens[tokens.length - 2] === "not" || tokens[tokens.length - 2] === "never") &&
    tokens[tokens.length - 1] === "required"
  ) {
    const subject = tokens.slice(0, -3);
    return (
      containsSensitiveIdentifier(subject) &&
      subject.every((token) => SENSITIVE_PROHIBITION_OBJECT_TOKENS.has(token))
    );
  }

  let cursor = tokens[0] === "please" ? 1 : 0;
  if (tokens[cursor] === "do" && tokens[cursor + 1] === "not") {
    cursor += 2;
    if (tokens[cursor] === "ever") cursor += 1;
  } else if (tokens[cursor] === "never") {
    cursor += 1;
  } else if (
    tokens[cursor] === "you" &&
    tokens[cursor + 1] === "should" &&
    tokens[cursor + 2] === "not"
  ) {
    cursor += 3;
  } else if (
    tokens[cursor] === "you" &&
    tokens[cursor + 1] === "must" &&
    tokens[cursor + 2] === "never"
  ) {
    cursor += 3;
  } else if (tokens[cursor] === "we" && tokens[cursor + 1] === "never") {
    cursor += 2;
  } else if (
    tokens[cursor] === "we" &&
    tokens[cursor + 1] === "do" &&
    tokens[cursor + 2] === "not"
  ) {
    cursor += 3;
  } else if (
    tokens[cursor] === "you" &&
    tokens[cursor + 1] === "must" &&
    tokens[cursor + 2] === "not"
  ) {
    cursor += 3;
  } else if (
    sameTokens(tokens.slice(cursor, cursor + 5), ["under", "no", "circumstances", "should", "you"])
  ) {
    cursor += 5;
  } else if (tokens[cursor] === "refrain" && tokens[cursor + 1] === "from") {
    cursor += 2;
  } else if (
    sameTokens(tokens.slice(cursor, cursor + 5), ["there", "is", "no", "need", "to"])
  ) {
    cursor += 5;
  } else {
    return false;
  }

  if (!actions.has(tokens[cursor])) return false;
  cursor += 1;
  while (
    (tokens[cursor] === "and" || tokens[cursor] === "or") &&
    actions.has(tokens[cursor + 1])
  ) {
    cursor += 2;
  }

  const governed = tokens.slice(cursor);
  return (
    containsSensitiveIdentifier(governed) &&
    governed.every((token) => SENSITIVE_PROHIBITION_OBJECT_TOKENS.has(token))
  );
}

function tokenizeSourceClauses(value: string | null): readonly Tokens[] {
  if (value === null) return [];
  // Keep sentence/clause boundaries for this proof. General classification
  // remains punctuation-insensitive, but a negator may not govern a sensitive
  // identifier that appears only after a new raw clause begins. Collapse dots
  // only in known identifier acronyms first so their punctuation is not
  // mistaken for a sentence boundary.
  const clauseValue = value
    .replace(/\bS\.\s*S\.\s*N\./giu, "SSN")
    .replace(/\bS\.\s*I\.\s*N\./giu, "SIN")
    .replace(/\bT\.\s*I\.\s*N\./giu, "TIN")
    .replace(/\bP\.\s*I\.\s*N\./giu, "PIN")
    .replace(/\bC\.\s*V\.\s*V\./giu, "CVV");
  return clauseValue
    .split(/[.!?;:\r\n]+/u)
    .map((clause) => tokenize(clause))
    .filter((clause) => clause.length > 0);
}

function isClearSensitiveProhibition(value: string | null): boolean {
  const sensitiveClauses = tokenizeSourceClauses(value).filter(containsSensitiveIdentifier);
  return (
    sensitiveClauses.length > 0 && sensitiveClauses.every(isClearSensitiveProhibitionClause)
  );
}

function isClearSensitiveProhibitionWithOnlyBenignRemainder(
  value: string | null,
  base: ClassificationResult,
  source: EvidenceSource
): boolean {
  const clauses = tokenizeSourceClauses(value);
  let sawSensitiveClause = false;
  const allClausesAllowed = clauses.every((clause) => {
    if (containsSensitiveIdentifier(clause)) {
      sawSensitiveClause = true;
      return isClearSensitiveProhibitionClause(clause);
    }
    const assessment = assessProposerContextTokens(base, source, clause);
    return !assessment.unsafe && assessment.recognized;
  });
  return sawSensitiveClause && allClausesAllowed;
}

function hasUnsafeClauseObservation(
  base: ClassificationResult,
  source: EvidenceSource,
  raw: string | null
): boolean {
  const sourceTokens = tokenize(raw);
  return (
    assessProposerContextTokens(base, source, sourceTokens).unsafe ||
    tokenizeSourceClauses(raw).some(
      (tokens) => assessProposerContextTokens(base, source, tokens).unsafe
    )
  );
}

const NON_APPLICANT_SYSTEM_SCOPES = [
  "application",
  "applications",
  "assignment",
  "automation",
  "browser",
  "browsers",
  "campaign",
  "contract",
  "course",
  "database",
  "event",
  "flow",
  "flows",
  "guide",
  "guides",
  "job",
  "operation",
  "operations",
  "page",
  "pages",
  "pipeline",
  "pipelines",
  "platform",
  "policy",
  "policies",
  "process",
  "processes",
  "processing",
  "product",
  "program",
  "project",
  "scheduler",
  "schedulers",
  "school",
  "service",
  "subscription",
  "system",
  "tool",
  "tools",
  "university",
  "workflow",
  "workflows"
] as const;

const PROFESSIONAL_LINK_NON_APPLICANT_OWNERS = [
  ...NON_APPLICANT_SYSTEM_SCOPES,
  "agency", "another", "boss", "business", "ceo", "client", "colleague", "company", "corporate",
  "corporation", "coworker", "customer", "department", "director", "employee", "employer",
  "executive", "firm", "founder", "hr", "interviewer", "job", "manager", "organization", "organisation",
  "other", "owner", "partner", "president", "project", "recommender", "recruiter", "referee", "reviewer", "someone", "staff", "supervisor", "team",
  "third", "vendor", "worker"
] as const;

const AVAILABILITY_NON_APPLICANT_OWNERS = [
  ...NON_APPLICANT_SYSTEM_SCOPES,
  "agency", "another", "assignment", "boss", "business", "campaign", "ceo", "client", "colleague",
  "company", "contract", "corporate", "corporation", "course", "coworker", "customer",
  "database", "department", "director", "employee", "employer", "event", "executive", "firm",
  "founder", "hr", "interviewer", "inventory", "job", "maintenance", "manager", "office", "opening", "organization", "organisation", "other", "owner",
  "partner", "platform", "president", "product", "program", "project", "recruiter", "reviewer",
  "recommender", "referee", "school", "service", "someone", "staff", "subscription", "supervisor", "system", "team", "third",
  "store", "university", "vendor", "worker"
] as const;

const DOCUMENT_NON_APPLICANT_OWNERS = [
  ...NON_APPLICANT_SYSTEM_SCOPES,
  "agency", "another", "boss", "business", "ceo", "client", "colleague", "company", "corporation",
  "coworker", "customer", "department", "director", "employee", "employer", "executive", "firm",
  "founder", "hr", "interviewer", "manager", "organization", "organisation", "other", "owner",
  "partner", "president", "recommender", "recruiter", "referee", "reviewer", "someone", "staff",
  "supervisor", "team", "third", "vendor", "worker"
] as const;

function hasNonApplicantProfessionalLinkRisk(tokens: Tokens): boolean {
  return (
    containsAnyPhrase(tokens, [
      ["company", "website"],
      ["company", "profile"],
      ["employer", "website"],
      ["employer", "profile"],
      ["business", "website"],
      ["business", "profile"],
      ["job", "posting"],
      ["job", "description"],
      ["project", "website"],
      ["project", "url"],
      ["project", "link"],
      ["project", "repository"],
      ["vacancy", "link"],
      ["vacancy", "url"],
      ["vacancy", "page"],
      ["vacancy", "site"],
      ["position", "link"],
      ["position", "url"],
      ["position", "page"],
      ["position", "site"],
      ["role", "link"],
      ["role", "url"],
      ["role", "page"],
      ["role", "site"],
      ["third", "party"],
      ["another", "applicant"],
      ["someone", "else"]
    ]) ||
    hasNonApplicantOwnedConcept(
      tokens,
      PROFESSIONAL_LINK_NON_APPLICANT_OWNERS,
      [
        "linkedin",
        "github",
        "gitlab",
        "portfolio",
        "website",
        "site",
        "homepage",
        "page",
        "profile",
        "account",
        "handle",
        "url",
        "link",
        "repository",
        "repo"
      ]
    ) ||
    (containsAnyToken(tokens, ["example", "reference", "documentation"]) &&
      containsAnyToken(tokens, ["link", "profile", "url", "website"]))
  );
}

function hasNonApplicantAvailabilityRisk(tokens: Tokens): boolean {
  const hasHistoricalSubject =
    containsAnyToken(tokens, ["historical", "last", "former", "past", "previous", "prior"]) &&
    containsAnyToken(tokens, [
      "employment",
      "employer",
      "company",
      "job",
      "role",
      "position",
      "university",
      "college",
      "school"
    ]) &&
    containsAnyToken(tokens, ["availability", "available", "start", "schedule", "interview", "notice", "date"]);
  return (
    hasHistoricalSubject ||
    containsAnyPhrase(tokens, [
      ["employment", "history"],
      ["previous", "employment"],
      ["previous", "employer"],
      ["current", "employer"],
      ["historical", "availability"],
      ["manager", "availability"],
      ["interviewer", "availability"],
      ["third", "party", "availability"],
      ["another", "person", "availability"],
      ["launch", "date"],
      ["launch", "schedule"],
      ["release", "date"],
      ["release", "schedule"],
      ["deployment", "date"],
      ["deployment", "schedule"],
      ["go", "live", "date"],
      ["go", "live", "schedule"],
      ["rollout", "date"],
      ["rollout", "schedule"]
    ]) ||
    hasNonApplicantOwnedConcept(
      tokens,
      AVAILABILITY_NON_APPLICANT_OWNERS,
      ["availability", "available", "start", "schedule", "interview", "notice", "date", "timing"]
    ) ||
    (containsAnyToken(tokens, ["product", "project", "system", "service", "platform", "database"]) &&
      containsAnyToken(tokens, ["availability", "configuration", "migration", "schedule", "start"]))
  );
}

function hasHistoricalEmploymentContext(tokens: Tokens): boolean {
  const aliases = contextAliasTokens(tokens);
  return ["employment", "work", "job", "career", "professional"].some((subject) =>
    ["history", "record"].some((record) => containsPhrase(aliases, [subject, record]))
  );
}

function hasNonApplicantDocumentRisk(tokens: Tokens): boolean {
  if (isBenignPresentationContext(tokens) || isFullyConsumedBoundPresentationContext(tokens)) {
    return false;
  }
  const aliases = contextAliasTokens(tokens);
  return containsAnyPhrase(aliases, [
    ["writing", "sample"],
    ["work", "sample"],
    ["academic", "transcript"],
    ["school", "transcript"],
    ["another", "applicant"],
    ["third", "party"],
    ["someone", "else"],
    ["analyze", "your", "resume"],
    ["analyse", "your", "resume"],
    ["describe", "your", "resume"],
    ["previously", "wrote"],
    ["position", "description"],
    ["role", "description"],
    ["vacancy", "description"],
    ["consent", "form"],
    ["academic", "certificate"],
    ["identity", "document"],
    ["government", "document"],
    ["code", "sample"],
    ["coding", "sample"],
    ["technical", "sample"],
    ["case", "study"],
    ["assessment", "document"]
  ]) ||
    containsAnyToken(aliases, ["transcript"]) ||
    hasNonApplicantOwnedConcept(
      aliases,
      DOCUMENT_NON_APPLICANT_OWNERS,
      ["resume", "resumes", "résumé", "cv", "curriculum", "vitae", "letter", "document", "transcript", "sample"]
    ) ||
    containsAnyPhrase(aliases, [
      ["resume", "analysis"],
      ["résumé", "analysis"],
      ["cover", "letter", "analysis"]
    ]);
}

function hasProtectedDataContext(tokens: Tokens): boolean {
  const aliases = contextAliasTokens(tokens);
  const protectedPhrases: readonly Tokens[] = [
      ["affirmative", "action"],
      ["diversity", "questionnaire"],
      ["diversity", "survey"],
      ["demographic", "information"],
      ["demographic", "questionnaire"],
      ["demographic", "survey"],
      ["equal", "employment", "opportunity"],
      ["equal", "opportunity", "employer"],
      ["equal", "opportunity"],
      ["equal", "opportunities"],
      ["equal", "opportunity", "information"],
      ["diversity", "and", "inclusion"],
      ["diversity", "equity", "and", "inclusion"],
      ["dei", "survey"],
      ["protected", "characteristic"],
      ["protected", "characteristics"],
      ["racial", "identity"],
      ["indigenous", "identity"],
      ["transgender", "status"],
      ["lgbtq", "status"],
      ["accommodation", "status"],
      ["national", "origin"],
      ["national", "origins"],
      ["voluntary", "self", "identification"],
      ["genetic", "information"],
      ["genetic", "data"],
      ["pregnancy", "status"],
      ["pregnancy", "statuses"],
      ["religious", "beliefs"],
      ["e", "e", "o"],
      ["e", "e", "o", "c"],
      ["o", "f", "c", "c", "p"],
      ["employment", "eligibility"],
      ["work", "permit"],
      ["visa", "support"],
      ["date", "of", "birth"],
      ["birth", "year"],
      ["birth", "date"],
      ["military", "status"],
      ["military", "service"],
      ["armed", "forces", "status"],
      ["criminal", "background"],
      ["arrest", "background"],
      ["conviction", "background"],
      ["conviction", "history"],
      ["arrest", "check"],
      ["conviction", "check"],
      ["misdemeanor", "background"],
      ["tax", "number"],
      ["taxpayer", "number"],
      ["fiscal", "number"],
      ["government", "identifier"],
      ["identity", "number"],
      ["id", "number"],
      ["personal", "id"],
      ["payment", "information"],
      ["financial", "information"],
      ["ethnic", "background"],
      ["disabled", "status"],
      ["salary", "requirement"],
      ["salary", "requirements"],
      ["expected", "annual", "salary"],
      ["race", "information"],
      ["race", "questionnaire"],
      ["race", "survey"],
      ["protected", "class"],
      ["protected", "classes"]
    ];
  const hasProtectedPhrase = [tokens, aliases].some((view) =>
    containsAnyPhrase(view, protectedPhrases)
  );
  const hasCriminalRecordPhrase = [
    "criminal",
    "arrest",
    "conviction",
    "felony",
    "misdemeanor"
  ].some((subject) =>
    ["history", "record", "background", "check"].some((record) =>
      containsPhrase(aliases, [subject, record])
    )
  );
  const exactProtectedLabels: readonly Tokens[] = [
    ["color"],
    ["colour"],
    ["ancestry"],
    ["caste"]
  ];
  const hasExactProtectedLabel = exactProtectedLabels.some(
    (label) => sameTokens(tokens, label) || sameTokens(aliases, label)
  );
  if (hasProtectedPhrase || hasCriminalRecordPhrase || hasExactProtectedLabel) return true;

  const detectedTokens = [
    "age",
    "birthdate",
    "citizen",
    "citizens",
    "citizenship",
    "compensation",
    "demographic",
    "disability",
    "disabilities",
    "disabled",
    "dob",
    "eeo",
    "eeoc",
    "eligibility",
    "ethnicity",
    "felony",
    "gender",
    "military",
    "nationality",
    "ofccp",
    "pay",
    "pregnancies",
    "pregnancy",
    "pronouns",
    "race",
    "religion",
    "salary",
    "sex",
    "sponsorship",
    "veteran",
    "veterans",
    "visa",
    "wage"
  ].filter((token) => aliases.includes(token));
  return detectedTokens.some((token) => {
    if (token === "pay" && containsAnyPhrase(aliases, [["pay", "attention"]])) return false;
    if (token === "race" && containsAnyPhrase(aliases, [["race", "condition"]])) return false;
    if (
      (token === "citizen" || token === "citizens") &&
      containsAnyPhrase(aliases, [["citizen", "developer"], ["citizens", "developer"]])
    ) {
      return false;
    }
    return true;
  });
}

function hasCrossSourceCodePlatformConflict(sourceTokens: readonly Tokens[]): boolean {
  return (
    sourceTokens.some((tokens) => tokens.includes("github")) &&
    sourceTokens.some((tokens) => tokens.includes("gitlab"))
  );
}

function hasProposerConcept(
  classification: ApplicationQuestionClassification,
  tokens: Tokens
): boolean {
  switch (classification) {
    case "PROFESSIONAL_LINK":
      return containsAnyToken(tokens, [
        "github",
        "gitlab",
        "homepage",
        "linkedin",
        "link",
        "portfolio",
        "profile",
        "repo",
        "repository",
        "site",
        "url",
        "website"
      ]);
    case "AVAILABILITY":
      return containsAnyToken(tokens, [
        "availability",
        "available",
        "date",
        "hours",
        "interview",
        "notice",
        "schedule",
        "start",
        "timing"
      ]);
    case "DOCUMENT":
      return containsAnyToken(tokens, [
        "attachment",
        "cover",
        "cv",
        "document",
        "letter",
        "resume",
        "résumé",
        "upload",
        "vitae"
      ]);
    default:
      return false;
  }
}

function isRecruitingDataUseNotice(tokens: Tokens): boolean {
  let cursor = 0;
  if (tokens[cursor] !== "we") return false;
  cursor += 1;
  if (tokens[cursor] === "only" || tokens[cursor] === "solely") cursor += 1;
  if (tokens[cursor] !== "use") return false;
  cursor += 1;
  if (!containsAnyToken([tokens[cursor]], ["the", "this", "your"])) return false;
  cursor += 1;
  if (!containsAnyToken([tokens[cursor]], ["data", "information"])) return false;
  cursor += 1;
  if (tokens[cursor] === "only" || tokens[cursor] === "solely") cursor += 1;
  if (tokens[cursor] !== "for") return false;
  cursor += 1;
  if (!containsAnyToken([tokens[cursor]], ["recruiting", "recruitment"])) return false;
  cursor += 1;
  if (tokens[cursor] === "purposes") cursor += 1;
  return cursor === tokens.length;
}

function directApplicantDocumentTransferControlMatch(tokens: Tokens): SemanticMatch | null {
  if (!containsAnyToken([tokens[0]], ["they", "we"]) || tokens[1] !== "upload" || tokens[2] !== "your") {
    return null;
  }
  const document = tokens.slice(3);
  if (
    sameTokens(document, ["resume"]) ||
    sameTokens(document, ["résumé"]) ||
    sameTokens(document, ["cv"])
  ) {
    return semanticMatch("DOCUMENT", "document.resume");
  }
  return sameTokens(document, ["cover", "letter"])
    ? semanticMatch("DOCUMENT", "document.cover_letter")
    : null;
}

function exactApplicantManagedWebsiteControlMatch(tokens: Tokens): SemanticMatch | null {
  return sameTokens(tokens, [
      "your",
      "professional",
      "website",
      "is",
      "managed",
      "by",
      "our",
      "hosting",
      "team"
    ])
    ? semanticMatch("PROFESSIONAL_LINK", "professional.website")
    : null;
}

function directApplicantRecipientControlMatch(tokens: Tokens): SemanticMatch | null {
  const controls: readonly Readonly<{
    tokens: Tokens;
    match: SemanticMatch;
  }>[] = [
    {
      tokens: ["your", "start", "date", "for", "the", "company"],
      match: semanticMatch("AVAILABILITY", "availability.start_date")
    },
    {
      tokens: ["your", "linkedin", "profile", "for", "the", "hiring", "manager"],
      match: semanticMatch("PROFESSIONAL_LINK", "professional.linkedin")
    },
    {
      tokens: ["your", "linkedin", "profile", "for", "hiring", "manager"],
      match: semanticMatch("PROFESSIONAL_LINK", "professional.linkedin")
    },
    {
      tokens: ["your", "resume", "for", "the", "recruiter"],
      match: semanticMatch("DOCUMENT", "document.resume")
    },
    {
      tokens: ["your", "start", "date", "will", "be", "confirmed", "by", "the", "hiring", "manager"],
      match: semanticMatch("AVAILABILITY", "availability.start_date")
    },
    {
      tokens: ["your", "start", "date", "will", "be", "set", "by", "the", "company"],
      match: semanticMatch("AVAILABILITY", "availability.start_date")
    },
    {
      tokens: ["your", "resume", "will", "be", "submitted", "by", "the", "recruiter"],
      match: semanticMatch("DOCUMENT", "document.resume")
    }
  ];
  return controls.find((control) => sameTokens(tokens, control.tokens))?.match ?? null;
}

function directApplicantActorControlMatch(tokens: Tokens): SemanticMatch | null {
  const actorPrefixes: readonly Tokens[] = [
    ["our", "hosting", "team"],
    ["the", "hiring", "manager"],
    ["the", "recruiter"],
    ["he"],
    ["she"],
    ["they"],
    ["we"]
  ];
  const actor = actorPrefixes.find((candidate) =>
    sameTokens(tokens.slice(0, candidate.length), candidate)
  );
  if (actor === undefined) return null;
  const verb = tokens[actor.length];
  const concept = tokens.slice(actor.length + 1);

  if (containsAnyToken([verb], ["maintain", "maintains", "manage", "manages"])) {
    if (sameTokens(concept, ["your", "linkedin", "profile"])) {
      return semanticMatch("PROFESSIONAL_LINK", "professional.linkedin");
    }
    if (sameTokens(concept, ["your", "portfolio", "website"])) {
      return semanticMatch("PROFESSIONAL_LINK", "professional.portfolio");
    }
    if (sameTokens(concept, ["your", "professional", "website"])) {
      return semanticMatch("PROFESSIONAL_LINK", "professional.website");
    }
  }
  if (containsAnyToken([verb], ["determine", "determines", "request", "requests", "set", "sets"])) {
    if (sameTokens(concept, ["your", "availability"])) {
      return semanticMatch("AVAILABILITY", "availability.general");
    }
    if (sameTokens(concept, ["your", "interview", "availability"])) {
      return semanticMatch("AVAILABILITY", "availability.interview");
    }
    if (sameTokens(concept, ["your", "start", "date"])) {
      return semanticMatch("AVAILABILITY", "availability.start_date");
    }
    if (sameTokens(concept, ["your", "work", "schedule"])) {
      return semanticMatch("AVAILABILITY", "availability.schedule");
    }
  }
  if (containsAnyToken([verb], ["attach", "attaches", "submit", "submits", "upload", "uploads"])) {
    if (sameTokens(concept, ["your", "cover", "letter"])) {
      return semanticMatch("DOCUMENT", "document.cover_letter");
    }
    if (
      sameTokens(concept, ["your", "cv"]) ||
      sameTokens(concept, ["your", "resume"]) ||
      sameTokens(concept, ["your", "résumé"])
    ) {
      return semanticMatch("DOCUMENT", "document.resume");
    }
  }
  return null;
}

function isBoundReviewerReferenceNotice(tokens: Tokens): boolean {
  const reviewActions = new Set([
    "check",
    "checked",
    "checks",
    "confirm",
    "confirmed",
    "confirms",
    "review",
    "reviewed",
    "reviews"
  ]);
  const actionIndices = tokens
    .map((token, index) => (reviewActions.has(token) ? index : -1))
    .filter((index) => index >= 0);
  if (actionIndices.length !== 1 || actionIndices[0] === 0) return false;

  const actorTokens = new Set([
    "can",
    "company",
    "he",
    "hiring",
    "it",
    "manager",
    "managers",
    "may",
    "our",
    "recommender",
    "recommenders",
    "recruiter",
    "recruiters",
    "referee",
    "referees",
    "reviewer",
    "reviewers",
    "she",
    "team",
    "teams",
    "the",
    "they",
    "we",
    "will"
  ]);
  const actionIndex = actionIndices[0];
  if (!tokens.slice(0, actionIndex).every((token) => actorTokens.has(token))) return false;

  const reference = tokens.slice(actionIndex + 1);
  const references: readonly Tokens[] = [
    ["this", "field"],
    ["this", "file"],
    ["this", "later"],
    ["this", "response"],
    ["this", "submission"],
    ["this", "value"],
    ["your", "application"],
    ["your", "field"],
    ["your", "file"],
    ["your", "response"],
    ["your", "submission"],
    ["your", "value"]
  ];
  return references.some((candidate) => sameTokens(reference, candidate));
}

function isNarrowRelationBearingBenignContext(tokens: Tokens): boolean {
  return isRecruitingDataUseNotice(tokens);
}

function isBenignPresentationContext(tokens: Tokens): boolean {
  if (isNarrowRelationBearingBenignContext(tokens) || isBoundReviewerReferenceNotice(tokens)) {
    return true;
  }

  const exactStructuralContexts: readonly Tokens[] = [
    ["application"],
    ["application", "details"],
    ["candidate", "details"],
    ["personal", "details"],
    ["additional", "information"],
    ["this", "field", "is", "optional"],
    ["used", "to", "review", "your", "application"],
    ["we", "use", "this", "information", "only", "for", "recruiting"]
  ];
  if (exactStructuralContexts.some((candidate) => sameTokens(tokens, candidate))) return true;

  const presentationTokens = new Set([
    "above",
    "below",
    "character",
    "characters",
    "choose",
    "field",
    "format",
    "full",
    "include",
    "including",
    "maximum",
    "minimum",
    "mm",
    "one",
    "optional",
    "please",
    "required",
    "select",
    "shown",
    "the",
    "use",
    "using",
    "value",
    "word",
    "words"
  ]);
  return tokens.length > 0 && tokens.every((token) => presentationTokens.has(token) || /^\p{N}+$/u.test(token));
}

function semanticReviewerReferenceMatch(tokens: Tokens): SemanticMatch | null {
  if (!sameTokens(tokens.slice(-2), ["your", "resume"])) return null;
  const genericReference = [...tokens.slice(0, -2), "your", "response"];
  return isBoundReviewerReferenceNotice(genericReference)
    ? semanticMatch("DOCUMENT", "document.resume")
    : null;
}

function boundApplicantControlMatch(tokens: Tokens): SemanticMatch | null {
  return (
    directApplicantDocumentTransferControlMatch(tokens) ??
    exactApplicantManagedWebsiteControlMatch(tokens) ??
    directApplicantRecipientControlMatch(tokens) ??
    directApplicantActorControlMatch(tokens) ??
    semanticReviewerReferenceMatch(tokens)
  );
}

function singularizeContextAliasToken(token: string): string {
  if (token === "curricula") return "curriculum";
  if (token === "cvs") return "cv";
  if (token === "contacts" || token === "degrees" || token === "resumes") return token;
  if (token.endsWith("ies") && token.length > 3) return `${token.slice(0, -3)}y`;
  if (/(?:sses|xes|zes|ches|shes)$/u.test(token)) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

function contextAliasTokens(tokens: Tokens): Tokens {
  return tokens.map(singularizeContextAliasToken);
}

function boundPresentationClassifications(
  tokens: Tokens
): readonly ApplicationQuestionClassification[] {
  const aliases = contextAliasTokens(tokens);
  const classifications: ApplicationQuestionClassification[] = [];
  const professionalHeadings: readonly Tokens[] = [
    ["professional", "link"],
    ["professional", "links"],
    ["professional", "profile"],
    ["professional", "profiles"],
    ["personal", "profile"],
    ["social", "profile"],
    ["online", "account"],
    ["online", "profile"],
    ["online", "presence"],
    ["source", "repository"],
    ["web", "address"]
  ];
  const availabilityHeadings: readonly Tokens[] = [
    ["availability"],
    ["availability", "details"],
    ["interview", "time"],
    ["job", "preference"],
    ["job", "preferences"],
    ["notice", "duration"]
  ];
  if (containsAnyPhrase(aliases, professionalHeadings)) {
    classifications.push("PROFESSIONAL_LINK");
  }
  if (containsAnyPhrase(aliases, availabilityHeadings)) {
    classifications.push("AVAILABILITY");
  }
  if (containsAnyPhrase(aliases, [["application", "document"]])) {
    classifications.push("DOCUMENT");
  }

  const urlFormatSignal =
    containsAnyToken(aliases, ["http", "https", "url"]) ||
    hasContextConceptOccurrence(tokens, ["link", "links"]);
  const fileFormatSignal =
    containsAnyToken(aliases, ["attachment", "doc", "docx", "pdf"]) ||
    hasContextConceptOccurrence(tokens, ["document", "documents", "file", "files"]);
  const dateFormatSignal =
    containsAnyToken(aliases, ["yyyy"]) ||
    hasContextConceptOccurrence(tokens, ["date", "dates", "schedule", "schedules"]);
  if (urlFormatSignal) classifications.push("PROFESSIONAL_LINK");
  if (fileFormatSignal) classifications.push("DOCUMENT");
  if (dateFormatSignal) classifications.push("AVAILABILITY");

  return classifications.filter(
    (classification, index, all) => all.indexOf(classification) === index
  );
}

function isFullyConsumedBoundPresentationContext(tokens: Tokens): boolean {
  const contexts: readonly Tokens[] = [
    ["professional", "link"],
    ["professional", "links"],
    ["professional", "profile"],
    ["professional", "profiles"],
    ["online", "profile"],
    ["online", "profiles"],
    ["online", "presence"],
    ["availability"],
    ["availability", "details"],
    ["job", "preference"],
    ["job", "preferences"],
    ["application", "document"],
    ["application", "documents"],
    ["must", "be", "a", "valid", "url"],
    ["paste", "a", "complete", "url", "beginning", "with", "https"],
    ["pdf", "or", "docx", "files", "only"]
  ];
  return contexts.some((context) => sameTokens(tokens, context));
}

const CONTEXT_FINITE_VERB_FORMS = new Set([
  "contact",
  "contacts",
  "date",
  "dates",
  "document",
  "documents",
  "file",
  "files",
  "link",
  "links",
  "resume",
  "resumes",
  "schedule",
  "schedules"
]);

const MASKED_FINITE_VERB_TOKEN = "\0finite-verb";

const CONTEXT_FINITE_VERB_SUBJECTS = new Set([
  "application",
  "applications",
  "automation",
  "browser",
  "browsers",
  "database",
  "databases",
  "flow",
  "flows",
  "guide",
  "guides",
  "operation",
  "operations",
  "page",
  "pages",
  "platform",
  "platforms",
  "pipeline",
  "pipelines",
  "policy",
  "policies",
  "process",
  "processes",
  "processing",
  "program",
  "programs",
  "scheduler",
  "schedulers",
  "service",
  "services",
  "system",
  "systems",
  "tool",
  "tools",
  "workflow",
  "workflows"
]);

const CONTEXT_BARE_VERB_PREDECESSORS = new Set([
  "can",
  "could",
  "did",
  "do",
  "does",
  "he",
  "i",
  "it",
  "may",
  "might",
  "must",
  "please",
  "she",
  "should",
  "they",
  "to",
  "we",
  "will",
  "would",
  "you"
]);

const CONTEXT_VERB_MODIFIERS = new Set([
  "actively",
  "again",
  "carefully",
  "automatically",
  "clearly",
  "consistently",
  "correctly",
  "currently",
  "directly",
  "dynamically",
  "efficiently",
  "eventually",
  "explicitly",
  "frequently",
  "immediately",
  "manually",
  "normally",
  "periodically",
  "promptly",
  "properly",
  "quickly",
  "regularly",
  "reliably",
  "repeatedly",
  "routinely",
  "safely",
  "securely",
  "seamlessly",
  "silently",
  "simply",
  "slowly",
  "smoothly",
  "subsequently",
  "successfully",
  "then",
  "unexpectedly"
]);

const CONTEXT_UNAMBIGUOUS_SENTENCE_FINAL_SUBJECTS = new Set([
  "database",
  "databases",
  "guide",
  "guides",
  "page",
  "pages",
  "policy",
  "policies",
  "process",
  "processes",
  "processing",
  "scheduler",
  "schedulers",
  "service",
  "services",
  "system",
  "systems",
  "workflow",
  "workflows"
]);

const CONTEXT_NOUN_PRESENTATION_FOLLOWERS = new Set([
  "above",
  "below",
  "field",
  "format",
  "optional",
  "required",
  "shown"
]);

function isContextVerbModifier(token: string): boolean {
  return CONTEXT_VERB_MODIFIERS.has(token);
}

function isClearlyFiniteVerbUse(tokens: Tokens, index: number): boolean {
  const token = tokens[index];
  if (!CONTEXT_FINITE_VERB_FORMS.has(token) || index === 0) {
    return false;
  }
  if (CONTEXT_NOUN_PRESENTATION_FOLLOWERS.has(tokens[index + 1] ?? "")) return false;
  let predecessorIndex = index - 1;
  while (
    predecessorIndex >= 0 &&
    isContextVerbModifier(tokens[predecessorIndex])
  ) {
    predecessorIndex -= 1;
  }
  if (predecessorIndex < 0) return false;
  const predecessor = tokens[predecessorIndex];
  if (CONTEXT_BARE_VERB_PREDECESSORS.has(predecessor)) return true;
  if (
    predecessor === "work" &&
    (token === "resume" || token === "resumes") &&
    index < tokens.length - 1
  ) {
    return true;
  }
  if (!CONTEXT_FINITE_VERB_SUBJECTS.has(predecessor)) return false;
  if (index < tokens.length - 1) return true;
  return CONTEXT_UNAMBIGUOUS_SENTENCE_FINAL_SUBJECTS.has(predecessor);
}

function hasFiniteVerbHomograph(tokens: Tokens): boolean {
  return tokens.some((_, index) => isClearlyFiniteVerbUse(tokens, index));
}

function withoutFiniteVerbHomographs(tokens: Tokens): Tokens {
  return tokens.map((token, index) =>
    isClearlyFiniteVerbUse(tokens, index) ? MASKED_FINITE_VERB_TOKEN : token
  );
}

function withoutFiniteVerbActorsAndHomographs(tokens: Tokens): Tokens {
  const suppressed = new Set<number>();
  tokens.forEach((_, index) => {
    if (!isClearlyFiniteVerbUse(tokens, index)) return;
    suppressed.add(index);
    let actorIndex = index - 1;
    while (actorIndex >= 0 && isContextVerbModifier(tokens[actorIndex])) {
      suppressed.add(actorIndex);
      actorIndex -= 1;
    }
    if (actorIndex >= 0) suppressed.add(actorIndex);
  });
  return tokens.filter((_, index) => !suppressed.has(index));
}

const FINITE_VERB_BOUND_OBJECT_TOKENS = new Set([
  "answer",
  "application",
  "availability",
  "contact",
  "contacts",
  "date",
  "dates",
  "document",
  "documents",
  "field",
  "file",
  "files",
  "link",
  "links",
  "profile",
  "question",
  "response",
  "resume",
  "resumes",
  "schedule",
  "schedules",
  "submission",
  "value"
]);

function hasUnsafeFiniteVerbDirectObject(tokens: Tokens): boolean {
  return tokens.some((_, verbIndex) => {
    if (!isClearlyFiniteVerbUse(tokens, verbIndex)) return false;
    let objectIndex = verbIndex + 1;
    if (["as", "to"].includes(tokens[objectIndex] ?? "")) objectIndex += 1;
    const firstObjectToken = tokens[objectIndex];
    if (firstObjectToken === "it") return true;
    if (
      (firstObjectToken === "this" || firstObjectToken === "that") &&
      (objectIndex === tokens.length - 1 ||
        FINITE_VERB_BOUND_OBJECT_TOKENS.has(tokens[objectIndex + 1] ?? ""))
    ) {
      return true;
    }
    if (["a", "an", "our", "the", "their", "this", "that", "your"].includes(firstObjectToken)) {
      objectIndex += 1;
    }
    return FINITE_VERB_BOUND_OBJECT_TOKENS.has(tokens[objectIndex] ?? "");
  });
}

const FINITE_VERB_INERT_OBJECT_TOKENS = new Set([
  "guidance",
  "process",
  "processes",
  "record",
  "records",
  "report",
  "reports",
  "task",
  "tasks",
  "validator",
  "validators",
  "workflow",
  "workflows"
]);

function isFullyConsumedFiniteInertObjectContext(tokens: Tokens): boolean {
  if (!hasFiniteVerbHomograph(tokens)) return false;
  const remainder = withoutFiniteVerbActorsAndHomographs(tokens);
  let cursor = 0;
  if (["a", "an", "the"].includes(remainder[cursor] ?? "")) cursor += 1;
  if (remainder[cursor] === "to") cursor += 1;
  if (["her", "his", "its", "our", "their"].includes(remainder[cursor] ?? "")) cursor += 1;
  if (["a", "an", "the"].includes(remainder[cursor] ?? "")) cursor += 1;
  return (
    cursor === remainder.length - 1 &&
    FINITE_VERB_INERT_OBJECT_TOKENS.has(remainder[cursor] ?? "")
  );
}

function hasContextConceptOccurrence(tokens: Tokens, forms: readonly string[]): boolean {
  return tokens.some(
    (token, index) => forms.includes(token) && !isClearlyFiniteVerbUse(tokens, index)
  );
}

function hasResumeContextNoun(tokens: Tokens): boolean {
  return hasContextConceptOccurrence(tokens, ["resume", "resumes"]);
}

function hasDegreeContextNoun(tokens: Tokens): boolean {
  const blockedFollowers = new Set([
    "angle",
    "celsius",
    "fahrenheit",
    "latitude",
    "longitude",
    "of",
    "precision",
    "rotation"
  ]);
  return tokens.some((token, index) => {
    if (token !== "degree" && token !== "degrees") return false;
    if (blockedFollowers.has(tokens[index + 1] ?? "")) return false;
    if (/^\p{N}+$/u.test(tokens[index - 1] ?? "")) return false;
    if (
      tokens[index - 1] === "a" &&
      ["in", "to"].includes(tokens[index - 2] ?? "")
    ) {
      return false;
    }
    return true;
  });
}

function hasContactContextNoun(tokens: Tokens): boolean {
  return hasContextConceptOccurrence(tokens, ["contact", "contacts"]);
}

function proposerContextCandidateMatches(tokens: Tokens): readonly SemanticMatch[] {
  const aliases = contextAliasTokens(tokens);
  const matches: SemanticMatch[] = [];
  if (
    containsAnyToken(aliases, ["email"]) ||
    containsAnyPhrase(aliases, [
      ["e", "mail"],
      ["electronic", "mail"],
      ["mail", "address"]
    ])
  ) {
    matches.push(semanticMatch("CONTACT", "contact.email"));
  }
  if (
    containsAnyToken(aliases, ["cellphone", "mobile", "phone", "tel", "telephone"]) ||
    sameTokens(tokens, ["cell"]) ||
    containsAnyPhrase(aliases, [
      ["cell", "no"],
      ["cell", "number"],
      ["cell", "s", "number"],
      ["contact", "no"],
      ["contact", "number"],
      ["sms", "number"],
      ["text", "number"]
    ])
  ) {
    matches.push(semanticMatch("CONTACT", "contact.phone"));
  }
  if (
    hasContactContextNoun(tokens) ||
    containsAnyToken(aliases, ["surname"]) ||
    containsAnyPhrase(aliases, [
      ["family", "name"],
      ["first", "name"],
      ["full", "name"],
      ["given", "name"],
      ["last", "name"],
      ["legal", "name"],
      ["mailing", "address"],
      ["postal", "address"],
      ["postal", "code"],
      ["preferred", "name"],
      ["street", "address"],
      ["zip", "code"]
    ])
  ) {
    matches.push(semanticMatch("CONTACT", null));
  }
  if (containsAnyToken(aliases, ["relocation"])) {
    matches.push(semanticMatch("RELOCATION", "relocation.willingness"));
  }
  if (containsAnyToken(aliases, ["education"])) {
    matches.push(semanticMatch("EDUCATION", "education.degree"));
  }
  if (hasDegreeContextNoun(tokens)) {
    matches.push(semanticMatch("EDUCATION", "education.degree"));
  }
  if (containsAnyToken(tokens, ["initials"]) || containsAnyToken(aliases, ["signature"])) {
    matches.push(semanticMatch("LEGAL_ATTESTATION", "attestation.signature"));
  }
  if (containsAnyToken(aliases, ["linkedin"]) || containsAnyPhrase(aliases, [["linked", "in", "profile"]])) {
    matches.push(semanticMatch("PROFESSIONAL_LINK", "professional.linkedin"));
  }
  if (containsAnyToken(aliases, ["github", "gitlab"])) {
    matches.push(semanticMatch("PROFESSIONAL_LINK", "professional.code_profile"));
  }
  if (containsAnyToken(aliases, ["portfolio"])) {
    matches.push(semanticMatch("PROFESSIONAL_LINK", "professional.portfolio"));
  }
  const hasIndependentWebsiteToken = aliases.some(
    (token, index) =>
      (token === "website" || token === "homepage") && aliases[index - 1] !== "portfolio"
  );
  const hasIndependentWebsitePhrase = aliases.some(
    (token, index) =>
      ((token === "web" && aliases[index + 1] === "site") ||
        (token === "home" && aliases[index + 1] === "page")) &&
      aliases[index - 1] !== "portfolio"
  );
  if (hasIndependentWebsiteToken || hasIndependentWebsitePhrase) {
    matches.push(semanticMatch("PROFESSIONAL_LINK", "professional.website"));
  }
  if (
    containsAnyPhrase(aliases, [
      ["code", "repository"],
      ["source", "repository"],
      ["source", "code", "profile"],
      ["source", "code", "repository"]
    ])
  ) {
    matches.push(semanticMatch("PROFESSIONAL_LINK", "professional.code_profile"));
  }
  if (containsAnyPhrase(aliases, [["web", "address"]])) {
    matches.push(semanticMatch("PROFESSIONAL_LINK", "professional.website"));
  }

  const originalAvailabilityCandidates = availabilityCandidateMeanings({
    question: tokens,
    section: [],
    help: [],
    autocomplete: null
  });
  const aliasAvailabilityCandidates = availabilityCandidateMeanings({
    question: aliases,
    section: [],
    help: [],
    autocomplete: null
  });
  const availabilityKeys = [
    "availability.start_date",
    "availability.notice_period",
    "availability.schedule",
    "availability.interview",
    "availability.general"
  ] as const;
  originalAvailabilityCandidates.forEach((candidate, index) => {
    if (candidate || aliasAvailabilityCandidates[index]) {
      matches.push(semanticMatch("AVAILABILITY", availabilityKeys[index]));
    }
  });
  if (containsAnyPhrase(aliases, [["work", "schedule"], ["work", "schedules"]])) {
    matches.push(semanticMatch("AVAILABILITY", "availability.schedule"));
  }

  if (
    hasResumeContextNoun(tokens) ||
    containsAnyToken(aliases, ["cv", "résumé"]) ||
    containsAnyPhrase(aliases, [["curriculum", "vitae"]])
  ) {
    matches.push(semanticMatch("DOCUMENT", "document.resume"));
  }
  if (containsAnyPhrase(aliases, [["cover", "letter"]])) {
    matches.push(semanticMatch("DOCUMENT", "document.cover_letter"));
  }
  return matches;
}

function collectContextSemanticMatches(tokens: Tokens): readonly SemanticMatch[] {
  const semanticTokens = withoutFiniteVerbHomographs(tokens);
  if (semanticTokens.length === 0) return [];
  const evidence: Evidence = {
    question: semanticTokens,
    section: [],
    help: [],
    autocomplete: null
  };
  const matches = [
    sponsorshipMatch(evidence),
    workAuthorizationMatch(evidence),
    citizenshipMatch(evidence),
    compensationMatch(evidence),
    demographicMatch(evidence),
    disabilityMatch(evidence),
    veteranMatch(evidence),
    criminalHistoryMatch(evidence),
    legalAttestationMatch(evidence),
    relocationMatch(evidence),
    contactMatch(evidence, "TEXT"),
    documentMatch(evidence, "TEXT"),
    experienceMatch(evidence),
    educationMatch(evidence),
    skillMatch(evidence),
    professionalLinkMatch(evidence, "TEXT"),
    availabilityMatch(evidence),
    ...proposerContextCandidateMatches(semanticTokens)
  ].filter((match): match is SemanticMatch => match !== null);
  return matches.filter(
    (match, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.classification === match.classification &&
          candidate.semanticFieldKey === match.semanticFieldKey
      ) === index
  );
}

function isCompatibleContextSemanticMatch(
  base: ClassificationResult,
  source: EvidenceSource,
  tokens: Tokens,
  match: SemanticMatch
): boolean {
  return isCompatibleContextObservation(base, {
    source,
    tokens,
    result: finalizeMatch(match, "TEXT")
  });
}

type ProposerContextAssessment = Readonly<{
  unsafe: boolean;
  recognized: boolean;
}>;

function assessProposerContextTokens(
  base: ClassificationResult,
  source: EvidenceSource,
  tokens: Tokens
): ProposerContextAssessment {
  const semanticTokens = withoutFiniteVerbHomographs(tokens);
  const finiteVerbHomographWasMasked = hasFiniteVerbHomograph(tokens);
  if (finiteVerbHomographWasMasked && hasUnsafeFiniteVerbDirectObject(tokens)) {
    return { unsafe: true, recognized: true };
  }
  const genericBenign = isBenignPresentationContext(tokens);
  const boundControl = boundApplicantControlMatch(semanticTokens);
  const boundControlIsCompatible =
    boundControl !== null && isCompatibleContextSemanticMatch(base, source, tokens, boundControl);
  if (boundControl !== null && !boundControlIsCompatible) {
    return { unsafe: true, recognized: true };
  }

  const presentationClassifications = boundPresentationClassifications(tokens);
  if (presentationClassifications.some((classification) => classification !== base.classification)) {
    return { unsafe: true, recognized: true };
  }

  const semanticMatches = collectContextSemanticMatches(semanticTokens);
  if (finiteVerbHomographWasMasked && semanticMatches.length > 0) {
    return { unsafe: true, recognized: true };
  }
  if (
    semanticMatches.some(isAmbiguousSemanticMatch) ||
    semanticMatches.some(
      (match) => !isCompatibleContextSemanticMatch(base, source, tokens, match)
    )
  ) {
    return { unsafe: true, recognized: true };
  }

  const result = classifyEvidence(
    { question: semanticTokens, section: [], help: [], autocomplete: null },
    "TEXT"
  );
  if (result.dispositionReason === "AMBIGUOUS_FIELD") {
    return { unsafe: true, recognized: true };
  }
  const compatibleResult =
    result.classification !== "UNKNOWN" &&
    isCompatibleContextObservation(base, { source, tokens, result });
  if (result.classification !== "UNKNOWN" && !compatibleResult) {
    return { unsafe: true, recognized: true };
  }

  const relationIsFullyConsumed =
    genericBenign ||
    boundControlIsCompatible ||
    isFullyConsumedBoundPresentationContext(tokens) ||
    isFullyConsumedFiniteInertObjectContext(tokens);
  const scopeTokens = finiteVerbHomographWasMasked
    ? withoutFiniteVerbActorsAndHomographs(tokens)
    : tokens;
  if (
    !relationIsFullyConsumed &&
    (hasExplicitNonApplicantPronounRelation(scopeTokens) ||
      hasStandaloneDisqualifyingScope(base.classification, scopeTokens))
  ) {
    return { unsafe: true, recognized: semanticMatches.length > 0 };
  }
  if (
    !genericBenign &&
    !boundControlIsCompatible &&
    !compatibleResult &&
    semanticMatches.length === 0 &&
    presentationClassifications.length === 0 &&
    hasProposerConcept(base.classification, semanticTokens) &&
    !(containsApplicantOrientation(semanticTokens) || containsAnyToken(semanticTokens, FIELD_REQUEST_ACTIONS))
  ) {
    return { unsafe: true, recognized: semanticMatches.length > 0 };
  }

  return {
    unsafe: false,
    recognized:
      genericBenign ||
      boundControlIsCompatible ||
      presentationClassifications.length > 0 ||
      semanticMatches.length > 0 ||
      compatibleResult
  };
}

function hasStandaloneDisqualifyingScope(
  classification: ApplicationQuestionClassification,
  tokens: Tokens
): boolean {
  if (containsAnyPhrase(tokens, [["c", "e", "o"], ["h", "r"]])) return true;
  if (hasNonApplicantDocumentRisk(tokens)) return true;
  if (containsAnyToken(tokens, ["our", "ours", "their", "theirs", "his", "her", "hers", "its"])) {
    return true;
  }
  const explicitPronounRelation = hasExplicitNonApplicantPronounRelation(tokens);
  if (explicitPronounRelation) return true;
  const hasOwner = (owners: readonly string[]): boolean =>
    tokens.some(
      (token, index) =>
        isNonApplicantOwnerToken(token, owners) &&
        !((token === "page" || token === "pages") && tokens[index - 1] === "home")
    );
  const otherApplicant = hasExplicitOtherApplicantScope(tokens);
  switch (classification) {
    case "PROFESSIONAL_LINK":
      return hasOwner(PROFESSIONAL_LINK_NON_APPLICANT_OWNERS) || otherApplicant;
    case "AVAILABILITY":
      return (
        hasOwner(AVAILABILITY_NON_APPLICANT_OWNERS) ||
        (containsAnyToken(tokens, ["current", "historical", "last", "former", "past", "previous", "prior"]) &&
          containsAnyToken(tokens, [
            "college",
            "employment",
            "employer",
            "job",
            "role",
            "position",
            "school",
            "university"
          ])) ||
        containsAnyPhrase(tokens, [["fiscal", "year"]]) ||
        containsAnyToken(tokens, ["deployment", "launch", "migration", "release", "rollout"]) ||
        otherApplicant
      );
    case "DOCUMENT":
      return hasOwner(DOCUMENT_NON_APPLICANT_OWNERS) || otherApplicant;
    default:
      return false;
  }
}

function hasUnsafeUnresolvedProposerContext(
  base: ClassificationResult,
  evidence: Evidence,
  input: ClassificationInput
): boolean {
  if (base.permittedDisposition !== "PROPOSABLE") return false;
  if (evidence.section.length > 0 && evidence.help.length > 0) {
    const boundaryCandidates = [
      [...evidence.section, ...evidence.help],
      [...evidence.help, ...evidence.section]
    ];
    const hasUnsafeBoundary = boundaryCandidates.some((tokens) => {
      if (containsSensitiveIdentifier(tokens)) {
        return !isClearSensitiveProhibitionClause(tokens);
      }
      if (hasProtectedDataContext(tokens)) return true;
      return assessProposerContextTokens(base, "help", tokens).unsafe;
    });
    if (hasUnsafeBoundary) return true;
  }
  return ([
    ["section", evidence.section, input.sectionHeading],
    ["help", evidence.help, input.helpText]
  ] as const).some(([source, tokens, raw]) => {
    if (tokens.length === 0) return false;
    if (containsSensitiveIdentifier(tokens)) {
      return !isClearSensitiveProhibitionWithOnlyBenignRemainder(raw, base, source);
    }
    return hasUnsafeClauseObservation(base, source, raw);
  });
}

function hasTargetedSourceRisk(
  classification: ApplicationQuestionClassification,
  sourceTokens: readonly Tokens[]
): boolean {
  const semanticSourceTokens = sourceTokens.map(withoutFiniteVerbHomographs);
  if (
    semanticSourceTokens.some(
      (tokens) => hasProtectedDataContext(tokens) || hasHistoricalEmploymentContext(tokens)
    )
  ) {
    return true;
  }
  switch (classification) {
    case "PROFESSIONAL_LINK":
      return (
        hasCrossSourceCodePlatformConflict(semanticSourceTokens) ||
        semanticSourceTokens.some(hasNonApplicantProfessionalLinkRisk)
      );
    case "AVAILABILITY":
      return semanticSourceTokens.some(hasNonApplicantAvailabilityRisk);
    case "DOCUMENT":
      return semanticSourceTokens.some(hasNonApplicantDocumentRisk);
    default:
      return false;
  }
}

function classifyProjectedApplicationQuestion(input: ClassificationInput): ClassificationResult {
  const evidence: Evidence = {
    question: tokenize(input.question),
    section: tokenize(input.sectionHeading),
    help: tokenize(input.helpText),
    autocomplete: comparisonValue(input.autocomplete)
  };
  const base = classifyEvidence(evidence, input.fieldType);
  const observations = (
    [
      observeSource("question", evidence.question, input.fieldType),
      observeSource("section", evidence.section),
      observeSource("help", evidence.help)
    ] as const
  ).filter((observation): observation is SourceObservation => observation !== null);
  const distinctObservations = observations.filter(
    (observation, index, all) => all.findIndex((candidate) => sameObservedMeaning(observation, candidate)) === index
  );
  const sourceTokens = [evidence.question, evidence.section, evidence.help];

  const rawSources = [input.question, input.sectionHeading, input.helpText];
  const sensitiveSources = rawSources.filter((source) =>
    containsSensitiveIdentifier(tokenize(source))
  );
  const sensitiveMentionsAreOnlyProhibitions =
    base.permittedDisposition === "PROPOSABLE" &&
    sensitiveSources.length > 0 &&
    sensitiveSources.every(isClearSensitiveProhibition);
  if (
    base.permittedDisposition !== "EXCLUDED" &&
    sensitiveSources.length > 0 &&
    !sensitiveMentionsAreOnlyProhibitions
  ) {
    return ambiguousMatch();
  }
  if (
    base.permittedDisposition !== "EXCLUDED" &&
    [evidence.section, evidence.help].some(hasProtectedDataContext)
  ) {
    return ambiguousMatch();
  }

  // An already excluded result remains excluded. Otherwise, excluded meaning in
  // any independent source can only restrict the field; it cannot be hidden by
  // a lower-risk primary label.
  if (base.permittedDisposition !== "EXCLUDED") {
    const excluded = distinctObservations.filter((observation) =>
      EXCLUDED_CLASSIFICATIONS.has(observation.result.classification)
    );
    if (excluded.length > 0) {
      const nonExcluded = distinctObservations.filter(
        (observation) => !EXCLUDED_CLASSIFICATIONS.has(observation.result.classification)
      );
      if (base.classification !== "UNKNOWN" || excluded.length > 1 || nonExcluded.length > 0) {
        return ambiguousMatch();
      }
      return finalizeMatch(
        semanticMatch(excluded[0].result.classification, excluded[0].result.semanticFieldKey),
        input.fieldType
      );
    }
  } else {
    return base;
  }

  const orientedRefinement =
    base.semanticFieldKey === null &&
    distinctObservations.length === 1 &&
    distinctObservations[0].result.classification === base.classification &&
    distinctObservations[0].result.semanticFieldKey !== null &&
    (distinctObservations[0].source === "question" || isGenericQuestion(evidence.question)) &&
    isAuthoritativeProposerObservation(distinctObservations[0])
      ? distinctObservations[0]
      : null;
  if (orientedRefinement !== null) {
    if (hasTargetedSourceRisk(orientedRefinement.result.classification, sourceTokens)) {
      return ambiguousMatch();
    }
    const refined = classifyEvidence(
      { question: orientedRefinement.tokens, section: [], help: [], autocomplete: null },
      input.fieldType
    );
    if (
      refined.classification === orientedRefinement.result.classification &&
      refined.semanticFieldKey === orientedRefinement.result.semanticFieldKey
    ) {
      return refined;
    }
  }

  if (base.classification !== "UNKNOWN") {
    const conflictingObservation = distinctObservations.some(
      (observation) => !isCompatibleContextObservation(base, observation)
    );
    if (conflictingObservation) return ambiguousMatch();
  }

  if (
    base.permittedDisposition === "PROPOSABLE" &&
    hasTargetedSourceRisk(base.classification, sourceTokens)
  ) {
    return ambiguousMatch();
  }

  if (hasUnsafeUnresolvedProposerContext(base, evidence, input)) {
    return ambiguousMatch();
  }

  if (base.permittedDisposition === "PROPOSABLE") {
    const hasAuthority = observations.some(
      (observation) =>
        observation.result.classification === base.classification &&
        observation.result.semanticFieldKey === base.semanticFieldKey &&
        isAuthoritativeProposerObservation(observation)
    );
    if (!hasAuthority) return ambiguousMatch();
  }

  // A single explicit, source-local meaning may preserve authority when it was
  // moved into context. Ambiguous primary text is never repaired this way.
  if (
    base.classification === "UNKNOWN" &&
    base.dispositionReason === "UNKNOWN_QUESTION" &&
    distinctObservations.length === 1
  ) {
    const observation = distinctObservations[0];
    if (observation.source !== "question" && !isGenericQuestion(evidence.question)) {
      return base;
    }
    if (hasTargetedSourceRisk(observation.result.classification, sourceTokens)) {
      return ambiguousMatch();
    }
    if (
      PROPOSABLE_CLASSIFICATIONS.has(observation.result.classification) &&
      !isAuthoritativeProposerObservation(observation)
    ) {
      return base;
    }
    const reconciled = classifyEvidence(
      { question: observation.tokens, section: [], help: [], autocomplete: null },
      input.fieldType
    );
    if (
      reconciled.classification !== observation.result.classification ||
      reconciled.semanticFieldKey !== observation.result.semanticFieldKey
    ) {
      return base;
    }
    return reconciled;
  }

  return base;
}

function sameClassificationResult(
  left: ClassificationResult,
  right: ClassificationResult
): boolean {
  return (
    left.classification === right.classification &&
    left.semanticFieldKey === right.semanticFieldKey &&
    left.permittedDisposition === right.permittedDisposition &&
    left.dispositionReason === right.dispositionReason
  );
}

function reconcileClassifierSecurityProjections(
  joined: ClassificationResult,
  separated: ClassificationResult
): ClassificationResult {
  if (sameClassificationResult(joined, separated)) return joined;

  const excluded = [joined, separated].filter(
    (result) => result.permittedDisposition === "EXCLUDED"
  );
  if (excluded.length === 1) return excluded[0];
  if (excluded.length === 2) return ambiguousMatch();

  if (
    joined.permittedDisposition === "PROPOSABLE" &&
    separated.permittedDisposition === "PROPOSABLE"
  ) {
    return ambiguousMatch();
  }
  if (joined.permittedDisposition === "PROPOSABLE") return separated;
  if (separated.permittedDisposition === "PROPOSABLE") return joined;
  return ambiguousMatch();
}

function classifyWithAsciiPolicySkeleton(input: ClassificationInput): ClassificationResult {
  const exact = classifyProjectedApplicationQuestion(input);
  let reconciled = exact;
  // Exact text remains stored and hash-significant. For security vocabulary
  // only, each mark run in an ASCII-derived token and each punctuation/symbol
  // run embedded between ASCII word characters is independently interpreted as
  // joined or separated. Eight runs across all sources bound the complete 2^n
  // interpretation set; larger ambiguous inputs fail closed. Marks in Arabic,
  // Indic, and other non-ASCII script tokens are never folded. A non-Latin
  // script/symbol cluster touching an ASCII word character is an unsafe
  // mixed-script wrapper, while the same cluster as its own text remains
  // legitimate input.
  const sources = [
    ["question", input.question],
    ["sectionHeading", input.sectionHeading],
    ["helpText", input.helpText],
    ["autocomplete", input.autocomplete]
  ] as const;
  if (sources.some(([, value]) => hasEmbeddedNonLatinAsciiWrapper(value))) {
    return ambiguousMatch();
  }

  let totalSlotCount = 0;
  const templates = sources.map(([, value]) => {
    const template = buildAsciiPolicySkeletonTemplate(value);
    const offset = totalSlotCount;
    totalSlotCount += template.slotCount;
    return { value, template, offset };
  });
  if (totalSlotCount > MAX_ASCII_POLICY_AMBIGUITY_RUNS) return ambiguousMatch();

  const interpretationCount = 1 << totalSlotCount;
  for (let mask = 0; mask < interpretationCount; mask += 1) {
    const renderedSources = templates.map(({ value, template, offset }) =>
      value === null ? null : renderAsciiPolicySkeleton(template, mask, offset)
    );
    const projected: ClassificationInput = {
      question: renderedSources[0],
      sectionHeading: renderedSources[1],
      helpText: renderedSources[2],
      autocomplete: renderedSources[3],
      fieldType: input.fieldType
    };
    const projectedResult = classifyProjectedApplicationQuestion(projected);
    // Separating a genuine accent can merely destroy an already-bound safe
    // semantic label (for example résumé -> re sume). That is not hostile
    // evidence. All projections that expose a conflicting, ambiguous, or
    // excluded meaning still participate in restrictive reconciliation.
    if (
      exact.semanticFieldKey !== null &&
      projectedResult.classification === exact.classification &&
      projectedResult.semanticFieldKey === null &&
      projectedResult.permittedDisposition === "MANUAL_ONLY"
    ) {
      continue;
    }
    reconciled = reconcileClassifierSecurityProjections(reconciled, projectedResult);
  }
  return reconciled;
}

export function classifyApplicationQuestion(input: ClassificationInput): ClassificationResult {
  const inputSources = [
    input.question,
    input.sectionHeading,
    input.helpText,
    input.autocomplete
  ];
  if (inputSources.some(hasUnsafeClassifierIgnorable)) {
    return ambiguousMatch();
  }
  if (!inputSources.some(hasClassifierIgnorable)) {
    return classifyWithAsciiPolicySkeleton(input);
  }

  // An invisible may be embedded inside one policy token or replace a visible
  // inter-token separator. Analyze both interpretations with source provenance
  // intact and reconcile to the more restrictive safe result.
  const joined = classifyWithAsciiPolicySkeleton(projectClassifierInput(input, ""));
  const separated = classifyWithAsciiPolicySkeleton(projectClassifierInput(input, " "));
  return reconcileClassifierSecurityProjections(joined, separated);
}
