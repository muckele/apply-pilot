// "Apply Pilot sends this to Google Gemini" is said once per account on each browser (owner's call,
// 2026-11-13: no database change). Storage that is missing or refuses shows the notice again
// rather than never.
export function geminiNoticeKey(accountKey: string) {
  return `apply-pilot:gemini-notice:v1:${accountKey}`;
}

export function hasSeenGeminiNotice(storage: Storage | null, accountKey: string): boolean {
  try {
    return storage?.getItem(geminiNoticeKey(accountKey)) === "seen";
  } catch {
    return false;
  }
}

export function rememberGeminiNotice(storage: Storage | null, accountKey: string) {
  try {
    storage?.setItem(geminiNoticeKey(accountKey), "seen");
  } catch {
    // Not kept: the notice shows again next time.
  }
}
