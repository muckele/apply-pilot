import { normalizeText } from "@/lib/normalize";

// Pure types, limits, parsers, and the deterministic session summary for text mock
// interviews (WP1.8). No server imports: client components read this module too.
// The AI calls live in lib/ai/mock-interview.ts.

export const MOCK_QUESTION_CATEGORIES = ["BEHAVIORAL", "ROLE_SPECIFIC", "WHY_COMPANY"] as const;
export type MockQuestionCategory = (typeof MOCK_QUESTION_CATEGORIES)[number];

export const MOCK_FEEDBACK_DIMENSIONS = ["structure", "specificity", "relevance", "evidence"] as const;
export type MockFeedbackDimension = (typeof MOCK_FEEDBACK_DIMENSIONS)[number];

export const STAR_PARTS = ["situation", "task", "action", "result"] as const;
export type StarPart = (typeof STAR_PARTS)[number];

export const JOB_LINE_SOURCES = ["requirement", "preferred", "description"] as const;
export type JobLineSource = (typeof JOB_LINE_SOURCES)[number];

export const MOCK_MIN_QUESTIONS = 6;
export const MOCK_MAX_QUESTIONS = 10;
export const MOCK_ANSWER_MIN_CHARS = 20;
export const MOCK_ANSWER_MAX_CHARS = 6_000;
// An answer is "strong" enough to save as a STAR story when it covers all four STAR
// parts and averages at least this score across the four dimensions.
export const STRONG_ANSWER_AVERAGE = 3.5;

export const MOCK_CATEGORY_LABELS: Record<MockQuestionCategory, string> = {
  BEHAVIORAL: "Behavioural",
  ROLE_SPECIFIC: "Role-specific",
  WHY_COMPANY: "Why this company"
};

export const MOCK_DIMENSION_LABELS: Record<MockFeedbackDimension, string> = {
  structure: "Structure (STAR)",
  specificity: "Specificity",
  relevance: "Relevance",
  evidence: "Evidence"
};

export type JobLine = { lineId: string; text: string; source: JobLineSource };

export type MockInterviewQuestion = {
  questionId: string;
  category: MockQuestionCategory;
  question: string;
  lookingFor: string;
  jobLine: JobLine;
  factIds: string[];
};

export type MockAnswerFeedback = {
  scores: Record<MockFeedbackDimension, { score: number; note: string }>;
  starCoverage: Record<StarPart, boolean>;
  strengths: string[];
  tips: Array<{ dimension: MockFeedbackDimension; tip: string }>;
  unsupportedClaims: Array<{ quote: string; note: string }>;
  unverifiedNumbers: string[];
  starBreakdown: Record<StarPart, string>;
  strongerVersion: {
    text: string;
    sources: Array<{ factId: string; excerpt: string }>;
    metricGaps: string[];
  } | null;
};

export type MockAnswerRecord = {
  answer: string;
  answeredAt: string;
  attempts: number;
  savedStoryId: string | null;
  savedStoryAttempt: number | null;
  requestHash: string;
  feedback: MockAnswerFeedback;
};

export type MockAnswerMap = Record<string, MockAnswerRecord>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function parseJobLine(value: unknown): JobLine | null {
  if (!isRecord(value)) return null;
  if (typeof value.lineId !== "string" || typeof value.text !== "string" || !isOneOf(JOB_LINE_SOURCES, value.source)) {
    return null;
  }
  return { lineId: value.lineId, text: value.text, source: value.source };
}

export function parseMockQuestions(value: unknown): MockInterviewQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): MockInterviewQuestion[] => {
    if (!isRecord(item)) return [];
    const jobLine = parseJobLine(item.jobLine);
    if (
      typeof item.questionId !== "string" ||
      !isOneOf(MOCK_QUESTION_CATEGORIES, item.category) ||
      typeof item.question !== "string" ||
      !item.question.trim() ||
      !jobLine
    ) {
      return [];
    }
    return [{
      questionId: item.questionId,
      category: item.category,
      question: item.question,
      lookingFor: typeof item.lookingFor === "string" ? item.lookingFor : "",
      jobLine,
      factIds: stringList(item.factIds)
    }];
  });
}

function parseFeedback(value: unknown): MockAnswerFeedback | null {
  if (!isRecord(value) || !isRecord(value.scores) || !isRecord(value.starBreakdown)) return null;
  const rawScores = value.scores;
  const scores = {} as MockAnswerFeedback["scores"];
  for (const dimension of MOCK_FEEDBACK_DIMENSIONS) {
    const entry = rawScores[dimension];
    if (!isRecord(entry) || typeof entry.score !== "number" || entry.score < 1 || entry.score > 5) return null;
    scores[dimension] = { score: entry.score, note: typeof entry.note === "string" ? entry.note : "" };
  }
  const coverage = isRecord(value.starCoverage) ? value.starCoverage : {};
  const breakdown = value.starBreakdown;
  const starCoverage = {} as MockAnswerFeedback["starCoverage"];
  const starBreakdown = {} as MockAnswerFeedback["starBreakdown"];
  for (const part of STAR_PARTS) {
    starBreakdown[part] = typeof breakdown[part] === "string" ? breakdown[part] as string : "";
    starCoverage[part] = coverage[part] === true;
  }
  const tips = Array.isArray(value.tips)
    ? value.tips.flatMap((tip) => isRecord(tip) && isOneOf(MOCK_FEEDBACK_DIMENSIONS, tip.dimension) && typeof tip.tip === "string"
      ? [{ dimension: tip.dimension, tip: tip.tip }]
      : [])
    : [];
  const unsupportedClaims = Array.isArray(value.unsupportedClaims)
    ? value.unsupportedClaims.flatMap((claim) => isRecord(claim) && typeof claim.quote === "string"
      ? [{ quote: claim.quote, note: typeof claim.note === "string" ? claim.note : "" }]
      : [])
    : [];
  const stronger = isRecord(value.strongerVersion) && typeof value.strongerVersion.text === "string"
    ? {
        text: value.strongerVersion.text,
        sources: Array.isArray(value.strongerVersion.sources)
          ? value.strongerVersion.sources.flatMap((source) => isRecord(source) &&
            typeof source.factId === "string" && typeof source.excerpt === "string"
            ? [{ factId: source.factId, excerpt: source.excerpt }]
            : [])
          : [],
        metricGaps: stringList(value.strongerVersion.metricGaps)
      }
    : null;
  return {
    scores,
    starCoverage,
    strengths: stringList(value.strengths),
    tips,
    unsupportedClaims,
    unverifiedNumbers: stringList(value.unverifiedNumbers),
    starBreakdown,
    strongerVersion: stronger
  };
}

export function parseMockAnswers(value: unknown): MockAnswerMap {
  if (!isRecord(value)) return {};
  const answers: MockAnswerMap = {};
  for (const [questionId, item] of Object.entries(value)) {
    if (!isRecord(item) || typeof item.answer !== "string") continue;
    const feedback = parseFeedback(item.feedback);
    if (!feedback) continue;
    answers[questionId] = {
      answer: item.answer,
      answeredAt: typeof item.answeredAt === "string" ? item.answeredAt : "",
      attempts: typeof item.attempts === "number" && item.attempts >= 1 ? item.attempts : 1,
      savedStoryId: typeof item.savedStoryId === "string" ? item.savedStoryId : null,
      savedStoryAttempt: typeof item.savedStoryAttempt === "number" ? item.savedStoryAttempt : null,
      requestHash: typeof item.requestHash === "string" ? item.requestHash : "",
      feedback
    };
  }
  return answers;
}

export function averageMockScore(feedback: MockAnswerFeedback) {
  const total = MOCK_FEEDBACK_DIMENSIONS.reduce((sum, dimension) => sum + feedback.scores[dimension].score, 0);
  return total / MOCK_FEEDBACK_DIMENSIONS.length;
}

export function isStrongMockAnswer(feedback: MockAnswerFeedback) {
  return STAR_PARTS.every((part) => feedback.starCoverage[part] && feedback.starBreakdown[part].trim().length > 0) &&
    averageMockScore(feedback) >= STRONG_ANSWER_AVERAGE;
}

export function isMockStorySaved(record: MockAnswerRecord) {
  return Boolean(record.savedStoryId) && record.savedStoryAttempt === record.attempts;
}

// The STAR story holds the user's own words from their answer, split by the coach.
export function starStoryFromMockAnswer(question: MockInterviewQuestion, record: MockAnswerRecord) {
  if (!isStrongMockAnswer(record.feedback)) return null;
  const part = (name: StarPart) => record.feedback.starBreakdown[name].trim().slice(0, 5_000);
  return {
    title: question.question.trim().slice(0, 200),
    situation: part("situation"),
    task: part("task"),
    action: part("action"),
    result: part("result")
  };
}

export function mockSessionRequestHashes(session: { requestHash: string; answers: unknown }) {
  const hashes = [session.requestHash, ...Object.values(parseMockAnswers(session.answers)).map((record) => record.requestHash)];
  return [...new Set(hashes.filter((hash) => /^[0-9a-f]{64}$/u.test(hash)))];
}

export type MockLibraryStory = {
  id: string;
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  skills: string[];
};

export type MockSessionSummary = {
  answeredCount: number;
  questionCount: number;
  averages: Record<MockFeedbackDimension, number | null>;
  strengths: string[];
  focusAreas: Array<{ dimension: MockFeedbackDimension; tip: string; questionId: string; question: string; score: number }>;
  storyLinks: Array<{ storyId: string; title: string; questionIds: string[]; reason: "saved_from_session" | "related" }>;
};

const STOPWORDS = new Set([
  "about", "after", "again", "also", "been", "before", "being", "could", "describe", "does", "doing", "example",
  "from", "give", "have", "having", "here", "into", "just", "more", "most", "other", "over", "some", "such",
  "tell", "than", "that", "their", "them", "then", "there", "these", "they", "this", "those", "through", "time",
  "very", "walk", "were", "what", "when", "where", "which", "while", "will", "with", "would", "your", "yours"
]);

function keywords(...texts: string[]) {
  return new Set(normalizeText(texts.join(" ")).split(" ").filter((word) => word.length >= 4 && !STOPWORDS.has(word)));
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

const MAX_SUMMARY_STRENGTHS = 5;
const MAX_FOCUS_AREAS = 3;
const MAX_STORY_LINKS = 6;
const RELATED_STORY_MIN_OVERLAP = 2;

// Deterministic: aggregates the per-answer AI feedback already saved on the session and
// matches the user's own STAR library. It never calls AI and never writes new feedback.
export function buildMockSessionSummary(input: {
  questions: MockInterviewQuestion[];
  answers: MockAnswerMap;
  stories: MockLibraryStory[];
}): MockSessionSummary {
  const answered = input.questions
    .map((question, index) => ({ question, index, record: input.answers[question.questionId] }))
    .filter((entry): entry is { question: MockInterviewQuestion; index: number; record: MockAnswerRecord } => Boolean(entry.record));

  const averages = Object.fromEntries(MOCK_FEEDBACK_DIMENSIONS.map((dimension) => {
    if (!answered.length) return [dimension, null];
    const total = answered.reduce((sum, entry) => sum + entry.record.feedback.scores[dimension].score, 0);
    return [dimension, round1(total / answered.length)];
  })) as MockSessionSummary["averages"];

  const strengths: string[] = [];
  const strongDimensions = MOCK_FEEDBACK_DIMENSIONS
    .filter((dimension) => (averages[dimension] ?? 0) >= 4)
    .sort((left, right) => (averages[right] ?? 0) - (averages[left] ?? 0));
  for (const dimension of strongDimensions) {
    strengths.push(`Strong ${MOCK_DIMENSION_LABELS[dimension].toLowerCase()} across your answers (average ${averages[dimension]!.toFixed(1)} of 5).`);
  }
  const depth = Math.max(0, ...answered.map((entry) => entry.record.feedback.strengths.length));
  for (let position = 0; position < depth; position += 1) {
    for (const entry of answered) {
      const strength = entry.record.feedback.strengths[position]?.trim();
      if (strength && !strengths.includes(strength)) strengths.push(strength);
    }
  }

  const tips = answered.flatMap((entry) => entry.record.feedback.tips.map((tip, tipIndex) => ({
    dimension: tip.dimension,
    tip: tip.tip.trim(),
    questionId: entry.question.questionId,
    question: entry.question.question,
    score: entry.record.feedback.scores[tip.dimension].score,
    order: entry.index * 10 + tipIndex
  }))).filter((tip) => tip.tip)
    .sort((left, right) =>
      left.score - right.score ||
      (averages[left.dimension] ?? 0) - (averages[right.dimension] ?? 0) ||
      left.order - right.order);
  const focus: typeof tips = [];
  for (const tip of tips) {
    if (focus.length < MAX_FOCUS_AREAS && !focus.some((chosen) => chosen.dimension === tip.dimension)) focus.push(tip);
  }
  for (const tip of tips) {
    if (focus.length < MAX_FOCUS_AREAS && !focus.includes(tip)) focus.push(tip);
  }

  const storiesById = new Map(input.stories.map((story) => [story.id, story]));
  const links = new Map<string, MockSessionSummary["storyLinks"][number]>();
  for (const entry of answered) {
    const storyId = entry.record.savedStoryId;
    const story = storyId ? storiesById.get(storyId) : undefined;
    if (!story) continue;
    const existing = links.get(story.id);
    if (existing) existing.questionIds.push(entry.question.questionId);
    else links.set(story.id, { storyId: story.id, title: story.title, questionIds: [entry.question.questionId], reason: "saved_from_session" });
  }
  const storyKeywords = input.stories
    .filter((story) => !links.has(story.id))
    .map((story) => ({
      story,
      words: keywords(story.title, story.situation, story.task, story.action, story.result, ...story.skills)
    }));
  for (const question of input.questions) {
    const words = keywords(question.question, question.jobLine.text);
    let best: { story: MockLibraryStory; overlap: number } | null = null;
    for (const candidate of storyKeywords) {
      let overlap = 0;
      for (const word of words) if (candidate.words.has(word)) overlap += 1;
      if (overlap >= RELATED_STORY_MIN_OVERLAP && (!best || overlap > best.overlap)) best = { story: candidate.story, overlap };
    }
    if (!best) continue;
    const existing = links.get(best.story.id);
    if (existing) existing.questionIds.push(question.questionId);
    else links.set(best.story.id, { storyId: best.story.id, title: best.story.title, questionIds: [question.questionId], reason: "related" });
  }

  return {
    answeredCount: answered.length,
    questionCount: input.questions.length,
    averages,
    strengths: strengths.slice(0, MAX_SUMMARY_STRENGTHS),
    focusAreas: focus.map((area) => ({
      dimension: area.dimension,
      tip: area.tip,
      questionId: area.questionId,
      question: area.question,
      score: area.score
    })),
    storyLinks: [...links.values()].slice(0, MAX_STORY_LINKS)
  };
}
