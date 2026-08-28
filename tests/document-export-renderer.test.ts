import assert from "node:assert/strict";
import test from "node:test";

import JSZip from "jszip";
import { NextRequest } from "next/server";

import { createDocumentExportRouteHandlers } from "@/app/api/documents/export/route";
import { PublicApiError } from "@/lib/api-errors";
import {
  CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1,
  renderCanonicalApplicationDocumentV1
} from "@/lib/documents/export-renderer";
import { defaultResumeFormat } from "@/lib/documents/resume-format";

const USER_ID = "user-export-test";
const DOCUMENT_ID = "document-export-test";
const RESUME_VERSION_ID = "resume-export-test";

type GeneratedDocumentRow = {
  id: string;
  userId: string;
  title: string;
  content: string;
};

type ResumeVersionRow = {
  id: string;
  userId: string;
  title: string;
  fullText: string;
  template: string;
  pageSize: string;
  fontFamily: string;
  accentColor: string;
  fontSize: number;
  lineSpacing: number;
};

function generatedDocument(overrides: Partial<GeneratedDocumentRow> = {}): GeneratedDocumentRow {
  return {
    id: DOCUMENT_ID,
    userId: USER_ID,
    title: "Generated Cover Letter",
    content: "Generated body only",
    ...overrides
  };
}

function resumeVersion(overrides: Partial<ResumeVersionRow> = {}): ResumeVersionRow {
  return {
    id: RESUME_VERSION_ID,
    userId: USER_ID,
    title: "Mutable Resume Title",
    fullText: "SUMMARY\nResume body only",
    template: "MODERN",
    pageSize: "A4",
    fontFamily: "GEORGIA",
    accentColor: "#A1B2C3",
    fontSize: 11,
    lineSpacing: 120,
    ...overrides
  };
}

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/documents/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function route(options: {
  document?: GeneratedDocumentRow | null;
  resume?: ResumeVersionRow | null;
  requireUserId?: () => Promise<string>;
  checkRateLimit?: (key: string, limit?: number, windowMs?: number) => Promise<void>;
} = {}) {
  const calls = {
    rate: [] as Array<[string, number, number]>,
    document: [] as Array<{ id: string; userId: string }>,
    resume: [] as Array<{ id: string; userId: string }>
  };
  const handlers = createDocumentExportRouteHandlers({
    requireUserId: options.requireUserId ?? (async () => USER_ID),
    checkRateLimit: options.checkRateLimit ?? (async (key, limit, windowMs) => {
      calls.rate.push([key, limit ?? Number.NaN, windowMs ?? Number.NaN]);
    }),
    findGeneratedDocument: async (input) => {
      calls.document.push(input);
      return options.document === undefined ? generatedDocument() : options.document;
    },
    findResumeVersion: async (input) => {
      calls.resume.push(input);
      return options.resume === undefined ? resumeVersion() : options.resume;
    }
  });
  return { handlers, calls };
}

async function responseBytes(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'");
}

async function docxXml(bytes: Buffer): Promise<{ document: string; styles: string }> {
  const zip = await JSZip.loadAsync(bytes);
  const document = await zip.file("word/document.xml")?.async("string");
  const styles = await zip.file("word/styles.xml")?.async("string");
  assert.ok(document, "DOCX must contain word/document.xml");
  assert.ok(styles, "DOCX must contain word/styles.xml");
  return { document, styles };
}

async function docxEntries(bytes: Buffer): Promise<Map<string, Buffer>> {
  const zip = await JSZip.loadAsync(bytes);
  const entries = new Map<string, Buffer>();
  for (const name of Object.keys(zip.files).sort()) {
    entries.set(name, await zip.files[name].async("nodebuffer"));
  }
  return entries;
}

function normalizeApprovedDocxClockMetadata(name: string, bytes: Buffer): Buffer {
  if (name !== "docProps/core.xml") return bytes;
  return Buffer.from(
    bytes
      .toString("utf8")
      .replace(/(<dcterms:created\b[^>]*>)[^<]*(<\/dcterms:created>)/g, "$1CLOCK$2")
      .replace(/(<dcterms:modified\b[^>]*>)[^<]*(<\/dcterms:modified>)/g, "$1CLOCK$2"),
    "utf8"
  );
}

function docxParagraphs(documentXml: string): string[] {
  return [...documentXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((paragraph) =>
    decodeXml([...paragraph[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((text) => text[1])
      .join(""))
  );
}

test("generic resume Markdown returns exact fullText without prepending its title", async () => {
  const { handlers, calls } = route({ document: null });

  const response = await handlers.POST(request({ resumeVersionId: RESUME_VERSION_ID, format: "markdown" }));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "SUMMARY\nResume body only");
  assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="Mutable_Resume_Title.md"');
  assert.deepEqual(calls.resume, [{ id: RESUME_VERSION_ID, userId: USER_ID }]);
  assert.deepEqual(calls.rate, [[`documents:export:${USER_ID}`, 30, 60_000]]);
});

test("generic resume DOCX uses current resume formatting and excludes its title", async () => {
  const { handlers } = route({ document: null });

  const response = await handlers.POST(request({ resumeVersionId: RESUME_VERSION_ID, format: "docx" }));
  const xml = await docxXml(await responseBytes(response));

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-type"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="Mutable_Resume_Title.docx"');
  assert.deepEqual(docxParagraphs(xml.document), ["SUMMARY", "Resume body only"]);
  assert.doesNotMatch(xml.document, /Mutable Resume Title/);
  assert.match(xml.styles, /w:ascii="Georgia"/);
  assert.match(xml.styles, /w:sz w:val="22"/);
  assert.match(xml.styles, /w:line="264"/);
  assert.match(xml.document, /w:pgSz w:w="11909" w:h="16834"/);
  assert.match(xml.document, /w:color w:val="A1B2C3"/);
  assert.match(xml.document, /w:left w:val="single"/);
});

test("generic resume PDF uses current resume PDF formatting and excludes its title", async () => {
  const { handlers } = route({ document: null });

  const response = await handlers.POST(request({ resumeVersionId: RESUME_VERSION_ID, format: "pdf" }));
  const pdf = (await responseBytes(response)).toString("utf8");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="Mutable_Resume_Title.pdf"');
  assert.match(pdf, /\/MediaBox \[0 0 595 842\]/);
  assert.match(pdf, /\/BaseFont \/Times-Roman/);
  assert.match(pdf, /\/F1 11 Tf/);
  assert.match(pdf, /\(SUMMARY\) Tj/);
  assert.match(pdf, /\(Resume body only\) Tj/);
  assert.doesNotMatch(pdf, /Mutable Resume Title/);
});

test("generic generated-document Markdown returns exact content without prepending its title", async () => {
  const { handlers, calls } = route({ resume: null });

  const response = await handlers.POST(request({ documentId: DOCUMENT_ID, format: "markdown" }));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Generated body only");
  assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="Generated_Cover_Letter.md"');
  assert.deepEqual(calls.document, [{ id: DOCUMENT_ID, userId: USER_ID }]);
});

test("generic generated-document DOCX prepends title and uses the current generic default format", async () => {
  const { handlers } = route({ resume: null });

  const response = await handlers.POST(request({ documentId: DOCUMENT_ID, format: "docx" }));
  const xml = await docxXml(await responseBytes(response));

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-type"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="Generated_Cover_Letter.docx"');
  assert.deepEqual(docxParagraphs(xml.document), ["Generated Cover Letter", "", "Generated body only"]);
  assert.match(xml.styles, /w:ascii="Arial"/);
  assert.match(xml.styles, /w:sz w:val="20"/);
  assert.match(xml.styles, /w:line="230"/);
  assert.match(xml.document, /w:pgSz w:w="12240" w:h="15840"/);
});

test("generic generated-document PDF prepends title and uses current generic PDF defaults", async () => {
  const { handlers } = route({ resume: null });

  const response = await handlers.POST(request({ documentId: DOCUMENT_ID, format: "pdf" }));
  const pdf = (await responseBytes(response)).toString("utf8");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="Generated_Cover_Letter.pdf"');
  assert.match(pdf, /\/MediaBox \[0 0 612 792\]/);
  assert.match(pdf, /\/BaseFont \/Helvetica/);
  assert.match(pdf, /\/F1 10 Tf/);
  assert.match(pdf, /\(Generated Cover Letter\) Tj\nT\*\n\(\) Tj\nT\*\n\(Generated body only\) Tj/);
});

test("generic export keeps Markdown as the omitted-format default", async () => {
  const { handlers } = route({ resume: null });

  const response = await handlers.POST(request({ documentId: DOCUMENT_ID }));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Generated body only");
  assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="Generated_Cover_Letter.md"');
});

test("generic export authentication failure prevents rate, lookup, and rendering dispatch", async () => {
  const { handlers, calls } = route({
    requireUserId: async () => {
      throw new PublicApiError("Authentication required.", 401);
    }
  });

  const response = await handlers.POST(request({ documentId: DOCUMENT_ID, format: "docx" }));

  assert.equal(response.status, 401);
  assert.deepEqual(calls.rate, []);
  assert.deepEqual(calls.document, []);
  assert.deepEqual(calls.resume, []);
});

test("generic export rate-limit failure prevents owner lookup and rendering dispatch", async () => {
  const { handlers, calls } = route({
    checkRateLimit: async (key, limit, windowMs) => {
      calls.rate.push([key, limit ?? Number.NaN, windowMs ?? Number.NaN]);
      throw new PublicApiError("Too many requests.", 429);
    }
  });

  const response = await handlers.POST(request({ documentId: DOCUMENT_ID, format: "docx" }));

  assert.equal(response.status, 429);
  assert.deepEqual(calls.rate, [[`documents:export:${USER_ID}`, 30, 60_000]]);
  assert.deepEqual(calls.document, []);
  assert.deepEqual(calls.resume, []);
});

test("generic export preserves owner-scoped no-match not-found behavior", async () => {
  const { handlers, calls } = route({ document: null, resume: null });

  const response = await handlers.POST(request({ documentId: DOCUMENT_ID, format: "docx" }));

  assert.equal(response.status, 404);
  assert.deepEqual(calls.document, [{ id: DOCUMENT_ID, userId: USER_ID }]);
  assert.deepEqual(calls.resume, []);
});

test("canonical application document profile V1 is exact and independent from mutable generic defaults", async () => {
  const original = { ...defaultResumeFormat };
  Object.assign(defaultResumeFormat, {
    template: "MODERN",
    pageSize: "A4",
    fontFamily: "GEORGIA",
    accentColor: "#ABCDEF",
    fontSize: 14,
    lineSpacing: 150
  });

  try {
    const bytes = await renderCanonicalApplicationDocumentV1({
      artifactType: "RESUME",
      content: "SUMMARY\nCanonical résumé"
    });
    const xml = await docxXml(bytes);

    assert.deepEqual(CANONICAL_APPLICATION_DOCUMENT_PROFILE_V1, {
      profileVersion: 1,
      template: "CLASSIC",
      pageSize: "LETTER",
      fontFamily: "ARIAL",
      accentColor: "#0F766E",
      fontSize: 10,
      lineSpacing: 115,
      format: "docx",
      includeSourceTitle: false
    });
    assert.match(xml.styles, /w:ascii="Arial"/);
    assert.match(xml.styles, /w:sz w:val="20"/);
    assert.match(xml.styles, /w:line="230"/);
    assert.match(xml.document, /w:pgSz w:w="12240" w:h="15840"/);
    assert.match(xml.document, /w:color w:val="0F766E"/);
    assert.match(xml.document, /w:bottom w:val="single"/);
    assert.doesNotMatch(xml.document, /w:left w:val="single"/);
  } finally {
    Object.assign(defaultResumeFormat, original);
  }
});

test("canonical resume DOCX contains the exact approved Unicode source content", async () => {
  const content = "Café résumé\n中文经历\nBuilt launch tooling 🚀";

  const bytes = await renderCanonicalApplicationDocumentV1({ artifactType: "RESUME", content });
  const xml = await docxXml(bytes);

  assert.deepEqual(docxParagraphs(xml.document), content.split("\n"));
});

test("canonical cover-letter DOCX contains exact Unicode content without a source title", async () => {
  const content = "Bonjour, équipe\n我很期待加入。\nThank you 👋";

  const bytes = await renderCanonicalApplicationDocumentV1({ artifactType: "COVER_LETTER", content });
  const xml = await docxXml(bytes);

  assert.deepEqual(docxParagraphs(xml.document), content.split("\n"));
  assert.doesNotMatch(xml.document, /Mutable|Title|Cover Letter/);
});

test("canonical DOCX is semantically deterministic except for exact created and modified clock metadata", async () => {
  const input = {
    artifactType: "COVER_LETTER" as const,
    content: "Café résumé 中文 🚀"
  };
  const first = await renderCanonicalApplicationDocumentV1(input);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await renderCanonicalApplicationDocumentV1(input);
  const firstEntries = await docxEntries(first);
  const secondEntries = await docxEntries(second);

  assert.deepEqual([...firstEntries.keys()], [...secondEntries.keys()]);
  for (const [name, firstBytes] of firstEntries) {
    const secondBytes = secondEntries.get(name);
    assert.ok(secondBytes, `second DOCX is missing ${name}`);
    assert.deepEqual(
      normalizeApprovedDocxClockMetadata(name, firstBytes),
      normalizeApprovedDocxClockMetadata(name, secondBytes),
      `${name} changed outside approved clock metadata`
    );
  }

  const firstXml = await docxXml(first);
  const secondXml = await docxXml(second);
  assert.deepEqual(docxParagraphs(firstXml.document), [input.content]);
  assert.deepEqual(docxParagraphs(secondXml.document), [input.content]);
});
