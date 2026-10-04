const DOCX_BREAK_STYLE_MAP = [
  "br[type='page'] => hr:fresh",
  "br[type='column'] => hr:fresh"
];

function decodeHtmlText(value: string) {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined, named: string | undefined) => {
      if (decimal || hexadecimal) {
        const codePoint = Number.parseInt(decimal ?? hexadecimal!, decimal ? 10 : 16);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      return {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " "
      }[named!.toLowerCase()]!;
    }
  );
}

/**
 * Convert Mammoth's generated HTML to the lossless plain-text shape used by
 * the resume parsing contract. Tags only contribute document boundaries;
 * facts come exclusively from decoded text nodes.
 */
export function mammothResumeHtmlToText(html: string) {
  const output: string[] = [];
  const lists: Array<{ ordered: boolean; next: number }> = [];
  const noteItems: boolean[] = [];
  let committedTrailingNewlines = 0;
  let pendingNewlines = 0;
  let tableCellDepth = 0;
  let skippingGeneratedNoteBacklink = false;

  const ensureNewlines = (count: number) => {
    if (output.length === 0) return;
    pendingNewlines = Math.max(pendingNewlines, count);
  };
  const setNewlines = (count: number) => {
    if (output.length === 0) return;
    pendingNewlines = count;
  };
  const countTrailingNewlines = (value: string) => {
    let count = 0;
    for (let index = value.length - 1; index >= 0 && value[index] === "\n"; index -= 1) {
      count += 1;
    }
    return count;
  };
  const append = (value: string) => {
    if (!value) return;
    const addedNewlines = Math.max(0, pendingNewlines - committedTrailingNewlines);
    if (addedNewlines > 0) {
      output.push("\n".repeat(addedNewlines));
      committedTrailingNewlines += addedNewlines;
    }
    pendingNewlines = 0;
    output.push(value);
    const valueTrailingNewlines = countTrailingNewlines(value);
    committedTrailingNewlines = valueTrailingNewlines === value.length
      ? committedTrailingNewlines + valueTrailingNewlines
      : valueTrailingNewlines;
  };
  const removeTrailingCharacter = (character: string) => {
    const lastIndex = output.length - 1;
    const last = output[lastIndex];
    if (!last?.endsWith(character)) return;
    const trimmed = last.slice(0, -character.length);
    if (trimmed) output[lastIndex] = trimmed;
    else output.pop();
    committedTrailingNewlines = 0;
    for (let index = output.length - 1; index >= 0; index -= 1) {
      const part = output[index]!;
      const partTrailingNewlines = countTrailingNewlines(part);
      committedTrailingNewlines += partTrailingNewlines;
      if (partTrailingNewlines < part.length) break;
    }
  };

  for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (!token.startsWith("<")) {
      if (!skippingGeneratedNoteBacklink) append(decodeHtmlText(token));
      continue;
    }

    const tag = token.match(/^<\s*\/?\s*([a-z\d]+)/i)?.[1]?.toLowerCase();
    if (!tag) continue;
    const closing = /^<\s*\//.test(token);

    if (skippingGeneratedNoteBacklink) {
      if (closing && tag === "a") skippingGeneratedNoteBacklink = false;
      continue;
    }
    if (
      !closing &&
      tag === "a" &&
      noteItems.at(-1) === true &&
      /\bhref\s*=\s*(["'])#[^"']*(?:footnote|endnote)-ref-[^"']+\1/i.test(token)
    ) {
      removeTrailingCharacter(" ");
      skippingGeneratedNoteBacklink = true;
      continue;
    }

    if (!closing && tag === "br") {
      ensureNewlines(1);
    } else if (!closing && tag === "hr") {
      ensureNewlines(2);
    } else if (!closing && tag === "table") {
      ensureNewlines(2);
    } else if (closing && tag === "table") {
      ensureNewlines(2);
    } else if (!closing && (tag === "td" || tag === "th")) {
      tableCellDepth += 1;
    } else if (!closing && (tag === "ul" || tag === "ol")) {
      setNewlines(1);
      lists.push({ ordered: tag === "ol", next: 1 });
    } else if (closing && (tag === "ul" || tag === "ol")) {
      lists.pop();
      ensureNewlines(2);
    } else if (!closing && tag === "li") {
      ensureNewlines(1);
      noteItems.push(/\bid\s*=\s*(["'])[^"']*(?:footnote|endnote)-[^"']+\1/i.test(token));
      const list = lists.at(-1);
      if (list?.ordered) {
        append(`${list.next}. `);
        list.next += 1;
      } else {
        append("• ");
      }
    } else if (closing && tag === "li") {
      ensureNewlines(1);
      noteItems.pop();
    } else if (closing && (tag === "td" || tag === "th")) {
      pendingNewlines = 0;
      append("\t");
      tableCellDepth = Math.max(0, tableCellDepth - 1);
    } else if (closing && tag === "tr") {
      removeTrailingCharacter("\t");
      ensureNewlines(1);
    } else if (
      closing &&
      (tag === "p" || /^h[1-6]$/.test(tag) || tag === "blockquote" || tag === "pre")
    ) {
      ensureNewlines(tableCellDepth > 0 ? 1 : 2);
    }
  }

  return `${output.join("")}${"\n".repeat(
    Math.max(0, pendingNewlines - committedTrailingNewlines)
  )}`;
}

export async function extractResumeDocxText(buffer: Buffer) {
  const mammoth = await import("mammoth");
  const parsed = await mammoth.convertToHtml(
    { buffer },
    { styleMap: DOCX_BREAK_STYLE_MAP }
  );
  return mammothResumeHtmlToText(parsed.value);
}
