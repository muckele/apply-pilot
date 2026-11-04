const evidenceNegationCue = /\b(?:no|none|not|never|without|lack|lacks|lacking|cannot|can't|don't|doesn't|didn't|haven't|hasn't|hadn't|zero|0)\b/iu;

export function hasEvidenceNegationCue(value: string) {
  return evidenceNegationCue.test(value.replace(/\bnot\s+only\b/giu, ""));
}
