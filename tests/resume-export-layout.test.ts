import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import pdf from "pdf-parse";
import { authoredDocumentQualityLetter } from "@/evaluation/authored-document-quality-samples";
import { syntheticCorrectionFlowDocumentPayload, syntheticTailoredResumeOutput } from "@/evaluation/correction-flow-provider-stub";
import { RESUME_EXPORT_LAYOUT_FIXTURE } from "@/evaluation/resume-export-layout-fixture";
import { assembleCoverLetterProviderOutput, assembleTailoredResumeProviderOutput } from "@/lib/ai/application-document-facts";
import { verifyCorrectionFlowDocumentExports } from "@/lib/ai/correction-flow-document-review-bundle";
import { buildProductDocumentLayout, type ProductDocumentInput } from "@/lib/documents/product-document-layout";
import { renderProductDocument } from "@/lib/documents/product-document-renderer";
import { defaultResumeFormat } from "@/lib/documents/resume-format";
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

test("a parenthetical organization description stays regular weight and wraps beside fixed dates", async () => {
  const line = "Riverbend Behavioral Partners (ABA therapy practice, Hudson Valley/Westchester, New York) Mar 2023 – Apr 2026";
  const input = resume(`Synthetic Owner\nEXPERIENCE\n${line}\nFounder and Operations Director`);
  const layout = buildProductDocumentLayout(input);
  const bytes = await renderProductDocument({ ...input, format: "pdf" });
  const runs = drawnRuns(bytes);
  const { items } = await pdfItems(bytes);
  const organization = runs.find((run) => run.text.trim() === "Riverbend Behavioral Partners")!;
  assert.equal(organization.baseFont, "Helvetica-Bold");
  const aside = runs.filter((run) => run.y <= organization.y && run !== organization && /ABA|Valley|York\)/u.test(run.text));
  assert.ok(aside.length >= 2, "the parenthetical wraps onto a second line");
  assert.ok(aside.every((run) => run.baseFont === "Helvetica"), "the parenthetical is regular weight");
  const dateItem = items.find((item) => item.str === "Mar 2023 – Apr 2026")!;
  assert.equal(dateItem.y, organization.y, "dates stay on the organization's first line");
  assert.ok(Math.abs(dateItem.x + dateItem.width - (layout.pageWidth - layout.margin)) < 0.5);
  for (const item of items.filter((entry) => /Riverbend|ABA|Valley|York\)/u.test(entry.str))) {
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
  const owner = "Hudson Valley, NY | (555) 010-0147 | jordan.sample@example.test | linkedin.com/in/jordan-sample-example | jordansample.example";
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
