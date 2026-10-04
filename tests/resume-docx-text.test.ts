import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  Document,
  PageBreak,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun
} from "docx";

import {
  extractResumeDocxText,
  mammothResumeHtmlToText
} from "@/lib/resume-docx-text";

test("DOCX extraction preserves line, page, list, and escaped-text evidence", async () => {
  const document = new Document({
    sections: [{
      children: [
        new Paragraph({
          children: [
            new TextRun("R&D <Operations>"),
            new TextRun({ text: '"quoted" evidence', break: 1 }),
            new PageBreak(),
            new TextRun("Adjacent record")
          ]
        }),
        new Paragraph({ text: "Pipe | evidence & context", bullet: { level: 0 } }),
        new Paragraph({ text: "Second list record", bullet: { level: 0 } })
      ]
    }]
  });
  const buffer = await Packer.toBuffer(document);

  assert.equal(
    await extractResumeDocxText(buffer),
    "R&D <Operations>\n\"quoted\" evidence\n\nAdjacent record\n" +
      "• Pipe | evidence & context\n• Second list record\n\n"
  );
});

test("DOCX extraction keeps table cells on their source row", async () => {
  const document = new Document({
    sections: [{
      children: [
        new Table({
          rows: [
            new TableRow({ children: [
              new TableCell({ children: [new Paragraph("Role")] }),
              new TableCell({ children: [new Paragraph("Company")] })
            ] }),
            new TableRow({ children: [
              new TableCell({ children: [new Paragraph("Jan 2022")] }),
              new TableCell({ children: [new Paragraph("Present")] })
            ] })
          ]
        }),
        new Paragraph("AFTER TABLE")
      ]
    }]
  });

  assert.equal(
    await extractResumeDocxText(await Packer.toBuffer(document)),
    "Role\tCompany\nJan 2022\tPresent\n\nAFTER TABLE\n\n"
  );
});

test("DOCX literal trailing newlines satisfy rather than amplify paragraph boundaries", async () => {
  const document = new Document({
    sections: [{ children: [
      new Paragraph({ children: [new TextRun("foo\n")] }),
      new Paragraph("bar")
    ] }]
  });

  assert.equal(
    await extractResumeDocxText(await Packer.toBuffer(document)),
    "foo\n\nbar\n\n"
  );
});

test("DOCX extraction excludes Mammoth-generated note backlinks", () => {
  const html = '<p>Ouch<sup><a href="#doc-42-footnote-1" id="doc-42-footnote-ref-1">[1]</a></sup>.</p>' +
    '<ol><li id="doc-42-footnote-1"><p> A tachyon walks into a bar. ' +
    '<a href="#doc-42-footnote-ref-1">↑</a></p></li>' +
    '<li id="doc-42-footnote-2"><p> Fin. ' +
    '<a href="#doc-42-footnote-ref-2">↑</a></p></li></ol>';

  assert.equal(
    mammothResumeHtmlToText(html),
    "Ouch[1].\n1.  A tachyon walks into a bar.\n\n2.  Fin.\n\n"
  );
});

test("DOCX structural conversion remains linear across many paragraphs", () => {
  const html = "<p>x</p>".repeat(20_000);
  const startedAt = performance.now();

  const extracted = mammothResumeHtmlToText(html);

  assert.equal(extracted.length, 60_000);
  assert.ok(
    performance.now() - startedAt < 1_000,
    "20,000 short paragraphs must convert in under one second"
  );
});
