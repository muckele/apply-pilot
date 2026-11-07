import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

import {
  MockInterviewPracticeNotice,
  MockInterviewSessionList,
  MockInterviewSessionRunner,
  MockInterviewStartButton
} from "@/components/mock-interview";
import type { MockAnswerRecord, MockInterviewQuestion } from "@/lib/ai/mock-interview-session";

// Server-renders the mock-interview UI with synthetic data. No network, no AI.

function render(element: ReactElement) {
  const untouched = () => { throw new Error("navigation is not expected while rendering"); };
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, {
    value: { bfcacheId: "synthetic-mock", back: untouched, forward: untouched, push: untouched, replace: untouched, refresh: untouched, prefetch: untouched }
  } as never, element));
}

const questions: MockInterviewQuestion[] = [
  {
    questionId: "q1",
    category: "BEHAVIORAL",
    question: "Tell me about a time you led an incident response.",
    lookingFor: "Calm ownership and a clear outcome.",
    jobLine: { lineId: "L2", text: "Incident response experience", source: "requirement" },
    factIds: []
  },
  {
    questionId: "q2",
    category: "WHY_COMPANY",
    question: "Why do you want to build payment infrastructure?",
    lookingFor: "Motivation tied to the posting.",
    jobLine: { lineId: "L3", text: "We build payment infrastructure that small businesses rely on.", source: "description" },
    factIds: []
  }
];

const answered: MockAnswerRecord = {
  answer: "At Prior Co our payment services had an outage. I was on call and led incident response. Service recovered.",
  answeredAt: "2026-11-03T10:01:00.000Z",
  attempts: 1,
  savedStoryId: null,
  savedStoryAttempt: null,
  requestHash: "a".repeat(64),
  feedback: {
    scores: {
      structure: { score: 4, note: "Clear STAR shape." },
      specificity: { score: 3, note: "Name the alert." },
      relevance: { score: 5, note: "On topic." },
      evidence: { score: 3, note: "One claim is not in your resume." }
    },
    starCoverage: { situation: true, task: true, action: true, result: true },
    strengths: ["You owned the response."],
    tips: [
      { dimension: "specificity", tip: "Name the alert that fired." },
      { dimension: "evidence", tip: "Add the recovery time to your resume if accurate." }
    ],
    unsupportedClaims: [{ quote: "mentored the whole team", note: "We couldn't find mentoring in your resume facts." }],
    unverifiedNumbers: ["45%"],
    starBreakdown: { situation: "Outage.", task: "On call.", action: "Led incident response.", result: "Service recovered." },
    strongerVersion: {
      text: "I led incident response for payment services and cut recovery time by [add a number here].",
      sources: [{ factId: "fact:0001", excerpt: "Led incident response for payment services." }],
      metricGaps: ["Removed \"99.99%\": it is not in your answer or your cited resume facts."]
    }
  }
};

test("the session runner shows the first open question, its posting line, prior feedback, and the summary", () => {
  const html = render(createElement(MockInterviewSessionRunner, {
    session: { id: "session-1", title: "Example Co - Platform Engineer", questions, answers: { q1: answered }, completedAt: null },
    stories: [{ id: "story-1", title: "Payment infrastructure launch", situation: "We launched payment infrastructure.", task: "t", action: "a", result: "r", skills: [] }],
    aiAvailable: true,
    unavailableMessage: "",
    backHref: "/interviews/interview-1"
  }));

  assert.match(html, /Question 2 of 2/u, "opens on the first unanswered question");
  assert.match(html, /Why do you want to build payment infrastructure\?/u);
  assert.match(html, /From the job post/u);
  assert.match(html, /We build payment infrastructure that small businesses rely on\./u);
  assert.match(html, /Get feedback/u);
  assert.match(html, /Session summary/u);
  assert.match(html, /1 of 2 answered/u);
  assert.match(html, /not an employer(?:&#x27;|')s score or a hiring prediction/u);
  assert.match(html, /href="\/interviews\/library#story-story-1"/u, "links related STAR stories in the library");
});

test("answer feedback renders scores, gentle evidence flags, the stronger version, and the save action", () => {
  const html = render(createElement(MockInterviewSessionRunner, {
    session: { id: "session-1", title: "Example Co - Platform Engineer", questions: [questions[0]], answers: { q1: answered }, completedAt: null },
    stories: [],
    aiAvailable: true,
    unavailableMessage: "",
    backHref: "/interviews"
  }));

  assert.match(html, /Structure \(STAR\)/u);
  assert.match(html, /4\/5/u);
  assert.match(html, /Not found in your resume facts yet/u);
  assert.match(html, /mentored the whole team/u);
  assert.match(html, /The number 45% doesn(?:&#x27;|')t appear in your resume facts\./u);
  assert.match(html, /\[add a number here\]/u);
  assert.match(html, /Save as STAR story/u);
  assert.match(html, /Get feedback again/u);
});

test("without Gemini the runner and start button say AI unavailable and offer no AI action", () => {
  const runner = render(createElement(MockInterviewSessionRunner, {
    session: { id: "session-1", title: "Example Co - Platform Engineer", questions, answers: {}, completedAt: null },
    stories: [],
    aiAvailable: false,
    unavailableMessage: "Gemini is not configured on this server.",
    backHref: "/interviews"
  }));
  assert.match(runner, /AI unavailable\. Gemini is not configured on this server\./u);
  assert.doesNotMatch(runner, />Get feedback</u);

  const start = render(createElement(MockInterviewStartButton, {
    source: { interviewId: "interview-1" },
    aiAvailable: false,
    unavailableMessage: "AI is turned off on this server."
  }));
  assert.match(start, /AI unavailable/u);
  assert.doesNotMatch(start, /Start a mock interview/u);
});

test("the practice notice and saved-session list render", () => {
  assert.match(render(createElement(MockInterviewPracticeNotice)),
    /For practice before your interview\. Don(?:&#x27;|')t use AI during a live interview unless the employer allows it\./u);
  const list = render(createElement(MockInterviewSessionList, {
    sessions: [{ id: "session-1", title: "Example Co - Platform Engineer", createdAt: "2026-11-03T10:00:00.000Z", completedAt: null, questionCount: 8, answeredCount: 3 }],
    emptyMessage: "No practice sessions yet."
  }));
  assert.match(list, /href="\/interviews\/mock\/session-1"/u);
  assert.match(list, /3 of 8 answered/u);
  assert.match(list, /In progress/u);
});
