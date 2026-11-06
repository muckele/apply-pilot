import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import pdf from "pdf-parse";
import { authoredDocumentQualityLetter } from "@/evaluation/authored-document-quality-samples";
import { syntheticCorrectionFlowDocumentPayload, syntheticTailoredResumeOutput } from "@/evaluation/correction-flow-provider-stub";
import { RESUME_EXPORT_LAYOUT_FIXTURE } from "@/evaluation/resume-export-layout-fixture";
import { assembleCoverLetterProviderOutput, assembleTailoredResumeProviderOutput } from "@/lib/ai/application-document-facts";
import { verifyCorrectionFlowDocumentExports } from "@/lib/ai/correction-flow-document-review-bundle";
import { buildProductDocument, buildProductDocumentLayout, type ProductDocumentInput } from "@/lib/documents/product-document-layout";
import { renderProductDocument } from "@/lib/documents/product-document-renderer";
import { defaultResumeFormat } from "@/lib/documents/resume-format";
import { parseDatedRecordHeading } from "@/lib/documents/resume-line-structure";
import { extractResumeDocxText } from "@/lib/resume-docx-text";

type PdfItem = { page: number; str: string; x: number; y: number; width: number };
type DrawnRun = { page: number; baseFont: string; size: number; x: number; y: number; text: string };

// Geometry from PDF.js (independent of the layout's own arithmetic), in content-stream order.
async function pdfItems(bytes: Buffer) {
  const items: PdfItem[] = [];
  let page = 0;
  const parsed = await pdf(new Uint8Array(bytes) as unknown as Buffer, { version: "v2.0.550", pagerender: async (pageData) => {
    page += 1;
    const { items: pageItems } = await pageData.getTextContent() as { items: Array<{ str: string; transform: number[]; width: number }> };
    for (const item of pageItems) items.push({ page, str: item.str, x: item.transform[4]!, y: item.transform[5]!, width: item.width });
    return pageItems.map((item) => item.str).join("\n");
  } });
  return { items, numpages: parsed.numpages };
}

const winAnsi = new TextDecoder("windows-1252");

// Fonts as actually drawn, read from the uncompressed product PDF content streams.
function drawnRuns(bytes: Buffer): DrawnRun[] {
  const source = bytes.toString("latin1");
  const fonts = new Map<string, string>();
  for (const match of source.matchAll(/(\d+) 0 obj\n<< \/Type \/Font \/Subtype \/Type1 \/BaseFont \/([\w-]+)/gu)) fonts.set(match[1]!, match[2]!);
  const runs: DrawnRun[] = [];
  let page = 0;
  for (const pageMatch of source.matchAll(/\/Resources << \/Font << ([^>]*) >> >> \/Contents (\d+) 0 R >>/gu)) {
    page += 1;
    const resources = new Map([...pageMatch[1]!.matchAll(/\/(F\d+) (\d+) 0 R/gu)].map((entry) => [entry[1]!, fonts.get(entry[2]!)!]));
    const stream = new RegExp(`\\n${pageMatch[2]} 0 obj\\n<< /Length \\d+ >>\\nstream\\n([\\s\\S]*?)\\nendstream`, "u").exec(source)![1]!;
    for (const run of stream.matchAll(/\/(F\d+) ([\d.]+) Tf\n([\d.-]+) ([\d.-]+) Td\n\(((?:\\.|[^\\)])*)\) Tj/gu)) {
      const text = run[5]!.replace(/\\(\d{3}|.)/gu, (_, escaped: string) =>
        /^\d{3}$/u.test(escaped) ? winAnsi.decode(Uint8Array.of(Number.parseInt(escaped, 8))) : escaped);
      runs.push({ page, baseFont: resources.get(run[1]!)!, size: Number(run[2]), x: Number(run[3]), y: Number(run[4]), text });
    }
  }
  return runs;
}

const comparable = (value: string) => value.replace(/\s+/gu, " ").trim();
const resume = (content: string, overrides: Partial<ProductDocumentInput> = {}): ProductDocumentInput =>
  ({ artifactType: "RESUME", content, resumeFormat: defaultResumeFormat, pdfFont: "HELVETICA", ...overrides });
const shortWords = Array.from({ length: 60 }, (_, index) => ["data", "team", "ops", "plan"][index % 4]).join(" ");

for (const pdfFont of ["HELVETICA", "TIMES"] as const) {
  test(`${pdfFont} bullets and body text fill at least 95% of the measured content width before wrapping`, async () => {
    const input = resume(`Synthetic Owner\nSUMMARY\nSummary ${shortWords}\nEXPERIENCE\n• Bullet ${shortWords}`, { pdfFont });
    const layout = buildProductDocumentLayout(input);
    const { items } = await pdfItems(await renderProductDocument({ ...input, format: "pdf" }));
    const right = layout.pageWidth - layout.margin;
    for (const start of ["Summary", "Bullet"]) {
      const first = items.find((item) => item.str.startsWith(start))!;
      const lineEnd = Math.max(...items.filter((item) => item.y === first.y).map((item) => item.x + item.width));
      const fill = (lineEnd - first.x) / (right - first.x);
      assert.ok(fill >= 0.95, `${start} line fills only ${(fill * 100).toFixed(1)}% of its width`);
      assert.ok(lineEnd <= right + 0.01, `${start} line overflows the right margin`);
      const second = items.filter((item) => item.y < first.y).sort((a, b) => b.y - a.y)[0]!;
      assert.equal(second.x, first.x, `${start} continuation must align with its first text line`);
    }
  });
}

test("measured layout widths match the glyph widths PDF.js reports for every PDF font and weight", async () => {
  for (const pdfFont of ["HELVETICA", "TIMES"] as const) {
    const input = resume(RESUME_EXPORT_LAYOUT_FIXTURE, { pdfFont });
    const layout = buildProductDocumentLayout(input);
    const blocks = layout.pages.flatMap((page) => page.blocks);
    const { items } = await pdfItems(await renderProductDocument({ ...input, format: "pdf" }));
    assert.equal(items.length, blocks.length);
    items.forEach((item, index) => {
      assert.equal(item.str, blocks[index]!.text);
      assert.ok(Math.abs(item.width - blocks[index]!.width) < 0.01, `${pdfFont} width differs for ${item.str}`);
    });
  }
});

test("an organization line renders a bold organization, right-aligned dates and an italic title", async () => {
  const input = resume("Synthetic Owner\nEXPERIENCE\nTripadvisor Feb 2022 – Sep 2023\nBusiness Development Executive, SMB Hotels\n• Owned a regional hotel territory.");
  const layout = buildProductDocumentLayout(input);
  const bytes = await renderProductDocument({ ...input, format: "pdf" });
  const runs = drawnRuns(bytes);
  const { items } = await pdfItems(bytes);
  const organization = runs.find((run) => run.text.trim() === "Tripadvisor")!;
  const dates = runs.find((run) => run.text === "Feb 2022 – Sep 2023")!;
  const title = runs.find((run) => run.text === "Business Development Executive, SMB Hotels")!;
  assert.equal(organization.baseFont, "Helvetica-Bold");
  assert.equal(dates.baseFont, "Helvetica");
  assert.equal(title.baseFont, "Helvetica-Oblique");
  assert.equal(dates.y, organization.y, "dates share the organization line");
  assert.ok(title.y < organization.y, "the title sits on the next line");
  assert.equal(organization.x, layout.margin);
  const dateItem = items.find((item) => item.str === "Feb 2022 – Sep 2023")!;
  assert.ok(Math.abs(dateItem.x + dateItem.width - (layout.pageWidth - layout.margin)) < 0.5, "dates are right-aligned to the margin");
  assert.equal(comparable((await pdf(new Uint8Array(bytes) as unknown as Buffer, { version: "v2.0.550" })).text), comparable(input.content));
});

test("a parenthetical organization description stays regular weight and moves under the organization beside fixed dates", async () => {
  const line = "Riverbend Dental Partners (community dental and orthodontic practice, Riverbend/Lakeside, North Carolina) Mar 2021 – Apr 2024";
  const input = resume(`Synthetic Owner\nEXPERIENCE\n${line}\nFounder and Operations Director`);
  const layout = buildProductDocumentLayout(input);
  const bytes = await renderProductDocument({ ...input, format: "pdf" });
  const runs = drawnRuns(bytes);
  const { items } = await pdfItems(bytes);
  const organization = runs.find((run) => run.text.trim() === "Riverbend Dental Partners")!;
  assert.equal(organization.baseFont, "Helvetica-Bold");
  // The whole lead does not fit beside the dates, so the parenthetical starts its own line rather
  // than stranding "Carolina)" (or "North Carolina)") under a crowded first line.
  const aside = runs.filter((run) => run !== organization && /dental|Lakeside|Carolina\)/u.test(run.text));
  assert.deepEqual(aside.map((run) => run.text), ["(community dental and orthodontic practice, Riverbend/Lakeside, North Carolina)"]);
  assert.ok(aside[0]!.y < organization.y, "the parenthetical sits under the organization");
  assert.equal(aside[0]!.x, organization.x);
  assert.ok(aside.every((run) => run.baseFont === "Helvetica"), "the parenthetical is regular weight");
  const dateItem = items.find((item) => item.str === "Mar 2021 – Apr 2024")!;
  assert.equal(dateItem.y, organization.y, "dates stay on the organization's first line");
  assert.ok(Math.abs(dateItem.x + dateItem.width - (layout.pageWidth - layout.margin)) < 0.5);
  for (const item of items.filter((entry) => /Riverbend|dental|Lakeside|Carolina\)/u.test(entry.str))) {
    assert.ok(item.x + item.width <= dateItem.x - 6, `${item.str} runs into the dates`);
    assert.ok(item.x >= layout.margin - 0.01);
  }
  assert.equal(comparable((await pdf(new Uint8Array(bytes) as unknown as Buffer, { version: "v2.0.550" })).text), comparable(input.content));
  // DOCX breaks where the PDF wraps, so Word right-aligns the dates on the last line instead of
  // squeezing them against a long lead; the run text still concatenates to the exact source line.
  const xml = await (await JSZip.loadAsync(await renderProductDocument({ ...input, format: "docx" }))).file("word/document.xml")!.async("string");
  const heading = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>/gu)].map((match) => match[0]).find((paragraph) => paragraph.includes("Riverbend"))!;
  assert.match(heading, /<w:br\/>/u);
  assert.equal([...heading.matchAll(/<w:t xml:space="preserve">([^<]*)<\/w:t>/gu)].map((match) => match[1]).join(""), line);
});

test("every supported bullet marker renders a bullet with a visible gap and a hanging indent", async () => {
  const fact = "Founded a home- and school-based therapy practice and grew it to 38 active client families across two counties within eighteen months of opening.";
  // A spaced marker draws the canonical bullet; a no-space ASCII marker keeps its exact glyph so the
  // text layer still matches the source (the WinAnsi PDF fonts cannot draw "▪", so it becomes "•").
  for (const [marker, glyph] of [["•", "•"], ["• ", "•"], ["▪", "•"], ["▪ ", "•"], ["-", "-"], ["- ", "•"], ["*", "*"], ["* ", "•"]]) {
    const input = resume(`Synthetic Owner\nEXPERIENCE\n${marker}${fact}`);
    const layout = buildProductDocumentLayout(input);
    const bytes = await renderProductDocument({ ...input, format: "pdf" });
    const runs = drawnRuns(bytes).filter((run) => !["Synthetic Owner", "EXPERIENCE"].includes(run.text));
    const bullet = runs.find((run) => run.text.trim() === glyph);
    assert.ok(bullet, `${JSON.stringify(marker)} draws ${glyph}`);
    const lines = runs.filter((run) => run !== bullet);
    assert.ok(lines.length >= 2, `${JSON.stringify(marker)} fact wraps`);
    assert.ok(lines[0]!.text.startsWith("Founded"), `${JSON.stringify(marker)} text starts after the marker`);
    assert.equal(lines[0]!.y, bullet.y);
    assert.ok(lines[0]!.x >= bullet.x + 8, "a visible gap separates the bullet from its text");
    assert.ok(lines.every((run) => run.x === lines[0]!.x), "wrapped lines align with the text, not the bullet");
    assert.ok(bullet.x >= layout.margin);
  }
  for (const text of ["-20% churn in two quarters", "—identifier", "**Highlights**", "*nix administration"]) {
    const runs = drawnRuns(await renderProductDocument({ ...resume(`Synthetic Owner\nEXPERIENCE\n${text}`), format: "pdf" }));
    assert.ok(!runs.some((run) => run.text.trim() === "•"), `${text} is not a bullet`);
    assert.ok(runs.some((run) => run.text === text), `${text} keeps its text`);
  }
});

test("a no-space bullet keeps its exact source text in the PDF text layer", async () => {
  const content = "Synthetic Owner\nEXPERIENCE\n•Founded a practice.\n• Grew it to 38 families.";
  const parsed = await pdf(new Uint8Array(await renderProductDocument({ ...resume(content), format: "pdf" })) as unknown as Buffer, { version: "v2.0.550" });
  assert.equal(comparable(parsed.text), comparable(content));
});

test("contact lines prefer slightly smaller type and break only after a separator", async () => {
  const owner = "Lakeside, NC | (555) 010-0147 | jordan.sample@example.test | linkedin.com/in/jordan-sample-example | jordansample.example";
  const oneLine = buildProductDocumentLayout(resume(`Jordan Sample\n${owner}\nSUMMARY\nSynthetic summary.`));
  const contact = oneLine.pages[0]!.blocks.filter((block) => block.role === "contact");
  assert.equal(new Set(contact.map((block) => block.y)).size, 1, "the owner-sized contact line fits on one line");
  assert.ok(contact.every((block) => block.fontSize >= 8));
  const long = Array.from({ length: 9 }, (_, index) => `segment-${index + 1}.contact.example.test`).join(" | ");
  const input = resume(`Jordan Sample\n${long}\nSUMMARY\nSynthetic summary.`);
  const bytes = await renderProductDocument({ ...input, format: "pdf" });
  const { items } = await pdfItems(bytes);
  const lines = [...new Set(items.filter((item) => item.str.includes("contact.example")).map((item) => item.y))]
    .map((y) => items.filter((item) => item.y === y).map((item) => item.str).join(""));
  assert.ok(lines.length >= 2, "the long contact line wraps");
  for (const line of lines) {
    assert.doesNotMatch(line.trim(), /^\|/u, `contact line starts with a separator: ${line}`);
    assert.match(line.trim(), /(?:\.test \||\.test)$/u, `contact line breaks inside a segment: ${line}`);
  }
  assert.equal(comparable((await pdf(new Uint8Array(bytes) as unknown as Buffer, { version: "v2.0.550" })).text), comparable(input.content));
});

test("grouped skill lines render the category label in bold and leave single skills alone", async () => {
  const input = resume("Synthetic Owner\nSKILLS\nSales: Prospecting, discovery, negotiation\nSalesforce\nHubSpot");
  const runs = drawnRuns(await renderProductDocument({ ...input, format: "pdf" }));
  assert.equal(runs.find((run) => run.text.trim() === "Sales:")?.baseFont, "Helvetica-Bold");
  assert.equal(runs.find((run) => run.text === "Prospecting, discovery, negotiation")?.baseFont, "Helvetica");
  assert.equal(runs.find((run) => run.text === "Salesforce")?.baseFont, "Helvetica");
  assert.equal(runs.find((run) => run.text === "HubSpot")?.baseFont, "Helvetica");
});

test("the owner-sized synthetic résumé fits on two pages and keeps every word in order", async () => {
  const input = resume(RESUME_EXPORT_LAYOUT_FIXTURE);
  const layout = buildProductDocumentLayout(input);
  assert.ok(layout.pages.length <= 2, `expected at most 2 pages, got ${layout.pages.length}`);
  const bytes = await renderProductDocument({ ...input, format: "pdf" });
  const parsed = await pdf(new Uint8Array(bytes) as unknown as Buffer, { version: "v2.0.550" });
  assert.equal(parsed.numpages, layout.pages.length);
  assert.equal(comparable(parsed.text), comparable(RESUME_EXPORT_LAYOUT_FIXTURE));
  const { items } = await pdfItems(bytes);
  for (const item of items) assert.ok(item.x + item.width <= layout.pageWidth - layout.margin + 0.01, `${item.str} overflows`);
  const docx = await renderProductDocument({ ...input, format: "docx" });
  const xml = await (await JSZip.loadAsync(docx)).file("word/document.xml")!.async("string");
  assert.equal((xml.match(/<w:pageBreakBefore\/>/gu) ?? []).length, layout.pages.length - 1);
  const extracted = comparable(await extractResumeDocxText(docx));
  for (const line of RESUME_EXPORT_LAYOUT_FIXTURE.split("\n").filter(Boolean)) {
    assert.ok(extracted.includes(comparable(line)), `DOCX is missing ${line}`);
  }
});

test("DOCX shows the same hierarchy with a right tab stop, italic title and a real hanging bullet list", async () => {
  const input = resume("Synthetic Owner\nEXPERIENCE\nTripadvisor Feb 2022 – Sep 2023\nBusiness Development Executive, SMB Hotels\n• Owned a regional hotel territory.\n•Founded a practice.\nSKILLS\nSales: Prospecting, discovery");
  const zip = await JSZip.loadAsync(await renderProductDocument({ ...input, format: "docx" }));
  const xml = await zip.file("word/document.xml")!.async("string");
  const paragraphs = [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>|<w:p [\s\S]*?<\/w:p>/gu)].map((match) => match[0]);
  const heading = paragraphs.find((paragraph) => paragraph.includes("Tripadvisor"))!;
  assert.match(heading, /<w:tab w:val="right" w:pos="\d+"\/>/u, "record heading has a right tab stop");
  assert.match(heading, /<w:b\/>[\s\S]*?<w:t xml:space="preserve">Tripadvisor <\/w:t>/u, "organization is bold");
  assert.match(heading, /<w:tab\/>[\s\S]*?<w:t xml:space="preserve">Feb 2022 – Sep 2023<\/w:t>/u, "dates follow a tab");
  const title = paragraphs.find((paragraph) => paragraph.includes("Business Development Executive"))!;
  assert.match(title, /<w:i\/>/u, "title is italic");
  const bullet = paragraphs.find((paragraph) => paragraph.includes("Owned a regional hotel territory."))!;
  assert.match(bullet, /<w:numPr>/u, "spaced bullet is a real list item");
  assert.doesNotMatch(bullet, /•/u, "the list supplies the bullet glyph");
  const numbering = await zip.file("word/numbering.xml")!.async("string");
  assert.match(numbering, /<w:lvlText w:val="•"\/>/u);
  assert.match(numbering, /<w:ind w:left="\d+" w:hanging="\d+"\/>/u);
  const noSpace = paragraphs.find((paragraph) => paragraph.includes("Founded a practice."))!;
  assert.match(noSpace, /w:hanging="\d+"/u, "no-space bullet uses the same hanging indent");
  assert.match(noSpace, /<w:spacing w:val="\d+"\/>[\s\S]*?<w:t xml:space="preserve">•<\/w:t>/u, "no-space marker is widened, not followed by inserted text");
  const skill = paragraphs.find((paragraph) => paragraph.includes("Sales:"))!;
  assert.match(skill, /<w:b\/>[\s\S]*?<w:t xml:space="preserve">Sales:<\/w:t>/u);
});

test("the review export verifier still proves exact PDF and DOCX text for the hierarchical layout", async () => {
  const payload = syntheticCorrectionFlowDocumentPayload();
  const tailoredResume = assembleTailoredResumeProviderOutput(payload, syntheticTailoredResumeOutput());
  const coverLetter = assembleCoverLetterProviderOutput(payload, authoredDocumentQualityLetter(payload));
  const result = await verifyCorrectionFlowDocumentExports({
    tailoredResume: { ...tailoredResume, resumeText: RESUME_EXPORT_LAYOUT_FIXTURE },
    coverLetter
  });
  assert.equal(result.resume.pdfCriticalFactsPresent, true);
  assert.equal(result.resume.docxRoundTripExact, true);
  assert.equal(result.resume.docxCriticalFactsPresent, true);
  // Lines the verifier accepted before the hanging-indent change still verify exactly.
  for (const marker of ["•", "-", "*", "• ", "- ", "* "]) {
    const lines = await verifyCorrectionFlowDocumentExports({
      tailoredResume: { ...tailoredResume, resumeText: `Synthetic Owner\nEXPERIENCE\n${marker}Founded a practice.` },
      coverLetter
    });
    assert.deepEqual([lines.resume.pdfCriticalFactsPresent, lines.resume.docxRoundTripExact, lines.resume.docxCriticalFactsPresent], [true, true, true], marker);
  }
});

const docxParagraphs = async (bytes: Buffer) => {
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
  return [...xml.matchAll(/<w:p>[\s\S]*?<\/w:p>|<w:p [\s\S]*?<\/w:p>/gu)].map((match) => match[0]);
};
const docxText = (paragraph: string) => [...paragraph.matchAll(/<w:t xml:space="preserve">([^<]*)<\/w:t>/gu)].map((match) => match[1]).join("");

test("every all-caps section heading the résumé parser recognizes renders as a section heading", async () => {
  const headings = ["KEY ACHIEVEMENTS", "TECHNICAL PROJECTS", "LICENSES:", "CERTIFICATIONS & LICENSES", "VOLUNTEER EXPERIENCE"];
  const ordinary = ["HARBOR LABS", "NASA", "Projects delivered on schedule for every sample client.", "Licensed in 3 sample states"];
  const content = [
    "Jordan Sample",
    "jordan.sample@example.test | (555) 010-0147",
    "SUMMARY",
    "Synthetic summary of sample experience.",
    "KEY ACHIEVEMENTS",
    "• Ranked first of 40 sample representatives.",
    "TECHNICAL PROJECTS",
    "Sample Tracker",
    "• Built a sample referral tracker.",
    "LICENSES:",
    "• Sample license in 3 states.",
    "CERTIFICATIONS & LICENSES",
    "Licensed in 3 sample states",
    "VOLUNTEER EXPERIENCE",
    "HARBOR LABS",
    "NASA",
    "Projects delivered on schedule for every sample client."
  ].join("\n");
  const input = resume(content);
  const { layout, paragraphs } = buildProductDocument(input);
  const roleOf = (text: string) => paragraphs.find((paragraph) => paragraph.runs.map((run) => run.text).join("") === text)?.role;
  for (const heading of headings) assert.equal(roleOf(heading), "section_heading", heading);
  for (const line of ordinary) assert.notEqual(roleOf(line), "section_heading", line);
  const blocks = layout.pages.flatMap((page) => page.blocks);
  const summary = blocks.find((block) => block.text === "SUMMARY")!;
  for (const heading of headings) {
    const block = blocks.find((entry) => entry.text === heading)!;
    assert.deepEqual([block.bold, block.color, block.fontSize, block.headingRule], [summary.bold, summary.color, summary.fontSize, "bottom"], heading);
  }
  const runs = drawnRuns(await renderProductDocument({ ...input, format: "pdf" }));
  assert.equal(runs.find((run) => run.text === "KEY ACHIEVEMENTS")?.baseFont, "Helvetica-Bold");
  const docx = await docxParagraphs(await renderProductDocument({ ...input, format: "docx" }));
  for (const heading of ["KEY ACHIEVEMENTS", "TECHNICAL PROJECTS", "LICENSES:"]) {
    assert.match(docx.find((paragraph) => docxText(paragraph) === heading)!, /<w:pStyle w:val="Heading1"\/>/u, heading);
  }
});

test("skill category labels render bold up to six words while bullets and sentences stay plain", async () => {
  const labels = ["Sales and business development:", "Revenue operations and customer success:", "Technical:", "Partner operations and program management tools:"];
  const content = [
    "Jordan Sample",
    "SKILLS",
    "Sales and business development: Prospecting, discovery, negotiation",
    "Revenue operations and customer success: Onboarding, quarterly reviews, renewals",
    "Technical: TypeScript, SQL",
    "CORE COMPETENCIES",
    "Partner operations and program management tools: Looker",
    "EXPERIENCE",
    "Harbor Labs Jan 2020 – Present",
    "Account Manager",
    "• Results: renewals rose 20% in the first quarter, and churn fell by half.",
    "The sample team grew its partner base across three regions: hotels, venues and agencies"
  ].join("\n");
  const input = resume(content);
  const runs = drawnRuns(await renderProductDocument({ ...input, format: "pdf" }));
  for (const label of labels) assert.equal(runs.find((run) => run.text.trim() === label)?.baseFont, "Helvetica-Bold", label);
  const bullet = runs.filter((run) => /Results:|renewals rose|churn fell/u.test(run.text));
  assert.ok(bullet.length > 0 && bullet.every((run) => run.baseFont === "Helvetica"), "a bullet never gets a bold label");
  const sentence = runs.filter((run) => /sample team|partner base|venues and agencies/u.test(run.text));
  assert.ok(sentence.length > 0 && sentence.every((run) => run.baseFont === "Helvetica"), "a sentence outside SKILLS is not a label");
  const docx = await docxParagraphs(await renderProductDocument({ ...input, format: "docx" }));
  const skill = docx.find((paragraph) => paragraph.includes("Revenue operations and customer success:"))!;
  assert.match(skill, /<w:b\/>[\s\S]*?<w:t xml:space="preserve">Revenue operations and customer success:<\/w:t>/u);
});

test("a dated organization line never strands one word on a line of its own", async () => {
  const dates = "Mar 2021 – Apr 2024";
  const aside = "(community dental and orthodontic practice, Riverbend/Lakeside, North Carolina)";
  for (const line of [
    `Bright Sample Collective ${aside} ${dates}`,
    `Riverbend Dental Partners ${aside} ${dates}`,
    `Northlake Regional Travel Marketplace and Hospitality Partner Programs Group International ${dates}`,
    `Northlake Regional Travel Marketplace and Hospitality Partner Programs Group International (Boston) ${dates}`
  ]) {
    const input = resume(`Synthetic Owner\nEXPERIENCE\n${line}\nFounder`);
    const { layout, paragraphs } = buildProductDocument(input);
    const heading = paragraphs.find((paragraph) => paragraph.role === "record_heading")!;
    const blocks = layout.pages[0]!.blocks.filter((block) => block.paragraphId === heading.id && block.text !== dates);
    const lines = [...new Set(blocks.map((block) => block.y))].map((y) => blocks.filter((block) => block.y === y).map((block) => block.text).join("").trim());
    assert.ok(lines.length >= 2, `${line} wraps`);
    for (const text of lines) assert.ok(text.split(/\s+/u).length > 1, `${line} strands "${text}"`);
    if (!line.includes(aside)) continue;
    assert.deepEqual(lines, [line.slice(0, line.indexOf(" (")), aside], "the parenthetical moves whole under the organization");
    const docx = (await docxParagraphs(await renderProductDocument({ ...input, format: "docx" }))).find((paragraph) => paragraph.includes("community dental and orthodontic"))!;
    assert.match(docxText(docx.split("<w:br/>")[1]!), /^\(community dental and orthodontic/u, "DOCX breaks before the parenthetical too");
  }
});

test("separator punctuation before right-aligned dates is not left dangling in PDF or DOCX", async () => {
  const records = [
    { line: "Data Analytics Certificate (evening program), Example Academy, Oct 2019 – Feb 2020", lead: "Data Analytics Certificate (evening program), Example Academy", dates: "Oct 2019 – Feb 2020" },
    { line: "Harbor Labs – Jan 2020 – Present", lead: "Harbor Labs", dates: "Jan 2020 – Present" },
    { line: "Summit Ridge Software - Aug 2016 - May 2019", lead: "Summit Ridge Software", dates: "Aug 2016 - May 2019" }
  ];
  for (const { line, lead, dates } of records) {
    const parts = parseDatedRecordHeading(line)!;
    assert.equal(`${parts.organization}${parts.aside}`, lead);
    assert.equal(parts.dates, dates);
    assert.equal(`${parts.organization}${parts.aside}${parts.separator}${parts.dates}`, line, "the parse still covers every source character");
  }
  const input = resume(`Synthetic Owner\nEDUCATION\n${records.map((record) => record.line).join("\n")}`);
  const bytes = await renderProductDocument({ ...input, format: "pdf" });
  const runs = drawnRuns(bytes);
  for (const { lead, dates } of records) {
    const dateRun = runs.find((run) => run.text === dates)!;
    assert.equal(runs.filter((run) => run.y === dateRun.y && run !== dateRun).map((run) => run.text).join("").trimEnd(), lead);
  }
  const expected = records.reduce((text, { line, lead, dates }) => text.replace(line, `${lead} ${dates}`), input.content);
  assert.equal(comparable((await pdf(new Uint8Array(bytes) as unknown as Buffer, { version: "v2.0.550" })).text), comparable(expected));
  const docx = await docxParagraphs(await renderProductDocument({ ...input, format: "docx" }));
  for (const { lead, dates } of records) {
    const paragraph = docx.find((entry) => docxText(entry).startsWith(lead))!;
    const [beforeTab, afterTab] = paragraph.split("<w:tab/>");
    assert.equal(docxText(beforeTab!), `${lead} `);
    assert.equal(docxText(afterTab!), dates);
  }
});

test("a paragraph that fits above the bottom margin is not pushed to the next page by its trailing space", () => {
  for (const lead of [["SUMMARY"], ["SUMMARY", "SKILLS"], ["", "", "SUMMARY"], ["", "", "", "", "SUMMARY", "SKILLS"]]) {
    const content = ["Synthetic Owner", ...lead, ...Array.from({ length: 60 }, (_, index) => `Sample fact ${index + 1}.`)].join("\n");
    const layout = buildProductDocumentLayout(resume(content));
    assert.ok(layout.pages.length >= 2);
    const facts = layout.pages[0]!.blocks.filter((block) => block.text.startsWith("Sample fact"));
    const last = facts.at(-1)!;
    const spaceAfter = facts[1]!.y - facts[0]!.y - facts[0]!.height;
    const next = layout.pages[1]!.blocks[0]!;
    assert.ok(last.y + last.height + spaceAfter + next.height > layout.pageHeight - layout.margin,
      `${next.text} fits under ${last.text} on page 1 (${JSON.stringify(lead)})`);
  }
});

test("the review export verifier accepts dated headings whose separator the layout drops", async () => {
  const payload = syntheticCorrectionFlowDocumentPayload();
  const tailoredResume = assembleTailoredResumeProviderOutput(payload, syntheticTailoredResumeOutput());
  const coverLetter = assembleCoverLetterProviderOutput(payload, authoredDocumentQualityLetter(payload));
  // The bullet is not a dated heading: it keeps its comma, even where its wrapped tail looks like one.
  const resumeText = [
    "Synthetic Owner",
    "EXPERIENCE",
    "Bright Sample Collective (community dental and orthodontic practice, Riverbend/Lakeside, North Carolina), Mar 2021 – Apr 2024",
    "Founder",
    "• Promoted to regional account manager for the sample hotel portfolio of the Northeast at Harbor Labs, Jan 2020 – Present",
    "EDUCATION",
    "Data Analytics Certificate (evening program), Example Academy, Oct 2019 – Feb 2020",
    "Harbor Labs – Jan 2020 – Present"
  ].join("\n");
  const result = await verifyCorrectionFlowDocumentExports({ tailoredResume: { ...tailoredResume, resumeText }, coverLetter });
  assert.deepEqual(
    [result.resume.pdfCriticalFactsPresent, result.resume.docxRoundTripExact, result.resume.docxCriticalFactsPresent],
    [true, true, true]
  );
});
