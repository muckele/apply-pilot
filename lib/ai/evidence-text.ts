// Text form used to check that a model's quoted excerpt occurs in the source. Models
// often retype typography (en dash → hyphen, curly → straight quotes, no-break spaces),
// so those variants compare equal. Letters, digits and word order must still match.
export function comparableEvidenceText(value: string) {
  return value
    .replace(/[‐-―−]/gu, "-")
    .replace(/[‘’‚‛′]/gu, "'")
    .replace(/[“”„‟″]/gu, "\"")
    .replace(/…/gu, "...")
    .replace(/\s*-\s*/gu, " - ")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase();
}
