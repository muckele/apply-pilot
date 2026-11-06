import { STANDARD_FONT_WINANSI_WIDTHS } from "@/lib/documents/standard-font-widths";

export type StandardPdfFontName =
  | "Helvetica" | "Helvetica-Bold" | "Helvetica-Oblique"
  | "Times-Roman" | "Times-Bold" | "Times-Italic";
export type TextStyle = "regular" | "bold" | "italic";
export type DocumentFontSet = Readonly<{
  regular: StandardPdfFontName;
  bold: StandardPdfFontName;
  italic: StandardPdfFontName;
  // Widens measurement when a word processor substitutes a wider face (DOCX Georgia).
  widthScale: number;
}>;
export type StyledRun = Readonly<{ text: string; style: TextStyle }>;
export type PlacedFragment = Readonly<{ text: string; style: TextStyle; x: number; width: number }>;
export type MeasureText = (text: string, style: TextStyle) => number;

// WinAnsi bytes 128-159 in code order. The PDF writer encodes with this exact table.
export const WIN_ANSI_HIGH_CHARACTERS = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";

export function winAnsiCode(character: string): number | null {
  const code = character.codePointAt(0)!;
  if (code <= 255) return code;
  const index = WIN_ANSI_HIGH_CHARACTERS.indexOf(character);
  return index >= 0 ? 128 + index : null;
}

function widthTable(font: StandardPdfFontName) {
  return STANDARD_FONT_WINANSI_WIDTHS[font === "Helvetica-Oblique" ? "Helvetica" : font];
}

// Exact advance width, in points, of text drawn with a standard PDF font (no kerning applies to Tj).
// A character outside WinAnsi cannot be drawn by the PDF writer; it is measured as a full em so DOCX
// and preview layouts stay conservative for it.
export function measureStandardFontText(text: string, font: StandardPdfFontName, fontSize: number) {
  const table = widthTable(font);
  let units = 0;
  for (const character of text) {
    const code = winAnsiCode(character);
    const width = code !== null && code >= 32 ? table[code - 32]! : 0;
    units += width > 0 ? width : 1000;
  }
  return (units * fontSize) / 1000;
}

export function documentFontMeasure(fonts: DocumentFontSet, fontSize: number): MeasureText {
  return (text, style) => measureStandardFontText(text, fonts[style], fontSize) * fonts.widthScale;
}

type WordPart = { text: string; style: TextStyle };
type Word = WordPart[];

function wordsOf(runs: readonly StyledRun[]) {
  const words: Word[] = [];
  let separated = true;
  for (const run of runs) {
    for (const piece of run.text.split(/(\s+)/u)) {
      if (!piece) continue;
      if (/^\s+$/u.test(piece)) {
        separated = true;
        continue;
      }
      // Runs that meet without whitespace continue the same word; no break may fall between them.
      if (separated || !words.length) words.push([{ text: piece, style: run.style }]);
      else words.at(-1)!.push({ text: piece, style: run.style });
      separated = false;
    }
  }
  return words;
}

function splitOversizedWord(word: Word, width: number, measure: MeasureText) {
  const chunks: Word[] = [];
  let chunk: Word = [];
  let chunkWidth = 0;
  for (const part of word) {
    for (const character of part.text) {
      const characterWidth = measure(character, part.style);
      if (chunk.length && chunkWidth + characterWidth > width) {
        chunks.push(chunk);
        chunk = [];
        chunkWidth = 0;
      }
      const last = chunk.at(-1);
      if (last?.style === part.style) last.text += character;
      else chunk.push({ text: character, style: part.style });
      chunkWidth += characterWidth;
    }
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

// Greedy line breaking on measured widths. Whitespace between words is drawn as one space in the
// preceding word's style, so a style change keeps its separating space at the end of the left
// fragment (PDF text extraction then reads the words apart).
export function wrapStyledRuns(runs: readonly StyledRun[], width: number, measure: MeasureText): PlacedFragment[][] {
  const wordWidth = (word: Word) => word.reduce((sum, part) => sum + measure(part.text, part.style), 0);
  const spaceWidth = (word: Word) => measure(" ", word.at(-1)!.style);
  const lines: Word[][] = [];
  let line: Word[] = [];
  let lineWidth = 0;
  for (const word of wordsOf(runs)) {
    const currentWidth = wordWidth(word);
    if (currentWidth > width) {
      if (line.length) lines.push(line);
      const chunks = splitOversizedWord(word, width, measure);
      lines.push(...chunks.slice(0, -1).map((chunk) => [chunk]));
      line = [chunks.at(-1)!];
      lineWidth = wordWidth(chunks.at(-1)!);
      continue;
    }
    const added = line.length ? spaceWidth(line.at(-1)!) + currentWidth : currentWidth;
    if (line.length && lineWidth + added > width) {
      lines.push(line);
      line = [word];
      lineWidth = currentWidth;
    } else {
      line.push(word);
      lineWidth += added;
    }
  }
  if (line.length) lines.push(line);
  return lines.map((words) => {
    const fragments: WordPart[] = [];
    words.forEach((word, index) => {
      if (index > 0) fragments.at(-1)!.text += " ";
      for (const part of word) {
        const last = fragments.at(-1);
        if (last?.style === part.style) last.text += part.text;
        else fragments.push({ ...part });
      }
    });
    let x = 0;
    return fragments.map((fragment) => {
      const placed = Object.freeze({ text: fragment.text, style: fragment.style, x, width: measure(fragment.text, fragment.style) });
      x += placed.width;
      return placed;
    });
  });
}
