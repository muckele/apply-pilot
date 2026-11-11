// The sign-in code's alphabet and length, shared by the server (lib/companion-sign-in.ts)
// and the code box in the browser. This file must stay free of server-only imports.

// 32 symbols without I, O, 0 or 1, so a typed code is never ambiguous. 12 symbols = 60 bits.
export const COMPANION_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const COMPANION_CODE_LENGTH = 12;

const SEPARATORS = /[\s-]/g;

// What the code box shows: uppercase, spaces and dashes removed, at most 12 characters,
// grouped in fours ("ABCD-EFGH-JKMN"). Characters codes never use are kept, so you can
// see which one to fix.
export function formatCompanionCodeInput(raw: string): string {
  const characters = Array.from(raw.toUpperCase().replace(SEPARATORS, "")).slice(0, COMPANION_CODE_LENGTH);
  const groups: string[] = [];
  for (let start = 0; start < characters.length; start += 4) {
    groups.push(characters.slice(start, start + 4).join(""));
  }
  return groups.join("-");
}

export function hasImpossibleCompanionCodeCharacter(value: string): boolean {
  return Array.from(value.replace(SEPARATORS, "")).some((character) => !COMPANION_CODE_ALPHABET.includes(character));
}

// Where the caret belongs in the formatted value so it stays after the same code character.
export function companionCodeCaret(raw: string, caret: number, formatted: string): number {
  const charactersBefore = Array.from(raw.slice(0, caret).replace(SEPARATORS, "")).length;
  if (charactersBefore === 0) return 0;
  let seen = 0;
  for (let index = 0; index < formatted.length; index += 1) {
    if (formatted[index] !== "-") seen += 1;
    if (seen === charactersBefore) return index + 1;
  }
  return formatted.length;
}
