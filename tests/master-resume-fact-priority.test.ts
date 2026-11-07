import assert from "node:assert/strict";
import { test } from "node:test";

import { buildMasterResumeFactCatalog } from "@/lib/ai/grounded-text";

// Live case: a résumé with 63 skills listed before its jobs. With a 50-fact cap the
// mock interview saw the summary and 49 skills, and none of the work history, so it
// warned that the applicant's own Wayfair metrics were "not in your resume facts".
const resume = {
  summary: "Sales and account management professional.",
  skills: Array.from({ length: 63 }, (_, index) => `Skill ${index + 1}`),
  achievements: ["Wayfair playbooks adopted by 100+ agents: mattress sales up nearly 30%."],
  workHistory: [{
    company: "Wayfair",
    title: "Sales Innovation Specialist",
    startDate: "Jan 2018",
    endDate: "Jan 2020",
    bullets: [
      "The playbooks were used by 100–200 agents.",
      "Results: mattress sales rose nearly 30% in the first quarter of the new program."
    ]
  }],
  education: [{ institution: "State University", credential: "B.A.", fieldOfStudy: "Business" }]
};

test("a capped fact list keeps experience and achievements before skills", () => {
  const facts = buildMasterResumeFactCatalog(resume, 50).map((fact) => fact.text);
  assert.equal(facts.length, 50);
  assert.ok(facts.some((text) => text.includes("mattress sales rose nearly 30%")), "work-history bullet kept");
  assert.ok(facts.some((text) => text.includes("100–200 agents")), "work-history bullet kept");
  assert.ok(facts.some((text) => text.includes("adopted by 100+ agents")), "achievement kept");
  assert.ok(facts.some((text) => text.includes("State University")), "education kept");
  assert.ok(facts.includes("Skill 1"), "the first skills still fit");
  assert.ok(!facts.includes("Skill 63"), "the cap trims the last skills, not the experience");
});

test("without a binding cap every fact is kept and fact IDs do not depend on order", () => {
  const all = buildMasterResumeFactCatalog(resume, 500);
  const capped = buildMasterResumeFactCatalog(resume, 50);
  const ids = new Map(all.map((fact) => [fact.text, fact.factId]));
  for (const fact of capped) assert.equal(fact.factId, ids.get(fact.text));
  assert.ok(all.some((fact) => fact.text === "Skill 63"));
});

// Shaped like the live résumé: five jobs (≈97 work-history facts) and 63 skills.
const longResume = {
  summary: "Sales and account management professional.",
  skills: Array.from({ length: 63 }, (_, index) => `Skill ${index + 1}`),
  achievements: ["Top five of 400+ advisors."],
  workHistory: Array.from({ length: 5 }, (_, job) => ({
    company: `Company ${job + 1}`,
    title: `Role ${job + 1}`,
    startDate: `Jan ${2015 + job}`,
    endDate: `Dec ${2015 + job}`,
    bullets: Array.from({ length: 6 }, (_, bullet) => job === 4 && bullet === 5
      ? "The playbooks were used by 100–200 agents."
      : `Job ${job + 1} result ${bullet + 1} with a measured outcome.`)
  })),
  education: [{ institution: "State University", credential: "B.A." }]
};

test("mock interviews and interview feedback see the last job's bullets on a long résumé", async () => {
  const { buildMockFeedbackPayload } = await import("@/lib/ai/mock-interview");
  const { buildInterviewFeedbackPayload } = await import("@/lib/ai/interview-feedback");
  const job = { title: "Account Executive", company: "Example", description: "Close deals." };
  const mock = buildMockFeedbackPayload({
    question: { questionId: "q1", category: "BEHAVIORAL", question: "Tell me about a win.", lookingFor: "Results.", jobLine: { lineId: "L1", text: "Close deals.", source: "description" }, factIds: [] },
    job,
    resume: longResume,
    answer: "The playbooks were used by 100 to 200 agents and lifted conversion."
  } as never);
  const feedback = buildInterviewFeedbackPayload({
    interview: { type: "PHONE" }, job, resume: longResume, notes: ["Went well."], transcript: null
  } as never);
  for (const payload of [mock, feedback] as Array<{ applicantFacts: Array<{ text: string }> }>) {
    assert.ok(payload.applicantFacts.some((fact) => fact.text.includes("100–200 agents")));
  }
});
