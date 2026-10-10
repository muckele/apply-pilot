import assert from "node:assert/strict";
import test from "node:test";

import {
  SYNTHETIC_CORRECTION_FLOW_FIXTURE
} from "@/evaluation/correction-flow-qualification-fixture";
import {
  syntheticCoverLetterOutput,
  syntheticTailoredResumeOutput
} from "@/evaluation/correction-flow-provider-stub";
import {
  CANONICAL_APPLICATION_DOCUMENT_PROFILE_V2,
  buildCanonicalApplicationDocumentLayoutV2,
  renderCanonicalApplicationDocumentPdfV2
} from "@/lib/documents/application-document-layout-v2";

test("resume and cover letter use distinct professional layout systems", () => {
  const resume = syntheticTailoredResumeOutput().resumeText;
  const coverLetter = syntheticCoverLetterOutput().coverLetter;
  const resumeLayout = buildCanonicalApplicationDocumentLayoutV2({ artifactType: "RESUME", content: resume });
  const coverLayout = buildCanonicalApplicationDocumentLayoutV2({ artifactType: "COVER_LETTER", content: coverLetter });

  assert.equal(CANONICAL_APPLICATION_DOCUMENT_PROFILE_V2.profileVersion, 2);
  assert.equal(resumeLayout.variant, "resume");
  assert.equal(coverLayout.variant, "cover_letter");
  assert.ok(resumeLayout.pages[0]?.blocks.some((block) => block.role === "candidate_name"));
  assert.ok(resumeLayout.pages[0]?.blocks.some((block) => block.role === "section_heading"));
  assert.ok(coverLayout.pages[0]?.blocks.some((block) => block.role === "salutation"));
  assert.ok(coverLayout.pages[0]?.blocks.some((block) => block.role === "body"));
  const sectionHeadings = resumeLayout.pages.flatMap((page) => page.blocks)
    .filter((block) => block.role === "section_heading")
    .map((block) => block.text);
  assert.deepEqual(sectionHeadings, [
    "SUMMARY",
    "SKILLS",
    "EXPERIENCE",
    "PROJECTS",
    "EDUCATION",
    "CERTIFICATIONS",
    "ACHIEVEMENTS",
    "ADDITIONAL INFORMATION"
  ]);
});

test("every rendered page remains inside printable bounds and contains visible content", () => {
  const longContent = [
    SYNTHETIC_CORRECTION_FLOW_FIXTURE.resume.rawText,
    "",
    "ADDITIONAL INFORMATION",
    ...Array.from({ length: 90 }, (_, index) =>
      `• Supplemental professional evidence line ${index + 1} remains readable in the visual export.`)
  ].join("\n");
  const layout = buildCanonicalApplicationDocumentLayoutV2({ artifactType: "RESUME", content: longContent });
  assert.ok(layout.pages.length >= 2);
  for (const [index, page] of layout.pages.entries()) {
    assert.ok(page.blocks.length > 0, `page ${index + 1} is blank`);
    for (const block of page.blocks) {
      assert.ok(block.x >= layout.margin);
      assert.ok(block.y >= layout.margin);
      assert.ok(block.x + block.width <= layout.pageWidth - layout.margin + 0.01);
      assert.ok(block.y + block.height <= layout.pageHeight - layout.margin + 0.01);
    }
  }

  const pdf = renderCanonicalApplicationDocumentPdfV2({ artifactType: "RESUME", content: longContent });
  const source = pdf.toString("utf8");
  assert.match(source, /^%PDF-1\.4/u);
  assert.match(source, /\/BaseFont \/Helvetica-Bold/u);
  assert.equal((source.match(/\/Type \/Page\b/gu) ?? []).length, layout.pages.length);
  assert.equal((source.match(/\nstream\n/gu) ?? []).length, layout.pages.length);
});

test("PDF text preserves common professional punctuation with ASCII-safe glyphs", () => {
  const pdf = renderCanonicalApplicationDocumentPdfV2({
    artifactType: "RESUME",
    content: "Taylor Boundary\nContact\nLeader\n\nEXPERIENCE\nContoso | Director | 2021–Present\n• Led “customer-first” delivery—without invented claims."
  });
  const source = pdf.toString("utf8");
  assert.match(source, /2021-Present/u);
  assert.match(source, /Led "customer-first" delivery-without invented claims\./u);
  assert.doesNotMatch(source, /2021\?Present/u);
});
