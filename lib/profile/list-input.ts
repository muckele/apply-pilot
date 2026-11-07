// Profile list boxes take one entry per line. Commas also separate entries,
// except for locations, where "New York, NY" is one entry (use a new line or ";").
export function splitListInput(value: string, separators: "commas" | "lines") {
  return value
    .split(separators === "commas" ? /[\n,;]/u : /[\n;]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}
