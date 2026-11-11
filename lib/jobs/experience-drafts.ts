// Experience-step drafts live in this browser only (localStorage), never in the account.
// Every storage call is wrapped: storage can be missing, blocked or full.
export type ExperienceDraft = { line: string; resumeLine: string };
export type ExperienceDrafts = Record<string, ExperienceDraft>;

const PREFIX = "apply-pilot:experience:";

export function experienceDraftKey(userKey: string, jobId: string): string {
  return `${PREFIX}${userKey}:${jobId}`;
}

function resolveStorage(storage: Storage | null | undefined): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readExperienceDrafts(key: string, storage?: Storage | null): { drafts: ExperienceDrafts; available: boolean } {
  const store = resolveStorage(storage);
  if (!store) return { drafts: {}, available: false };
  try {
    const raw = store.getItem(key);
    if (!raw) return { drafts: {}, available: true };
    try {
      const parsed = JSON.parse(raw) as { v?: unknown; drafts?: unknown };
      if (parsed?.v !== 1 || !parsed.drafts || typeof parsed.drafts !== "object") return { drafts: {}, available: true };
      return { drafts: parsed.drafts as ExperienceDrafts, available: true };
    } catch {
      return { drafts: {}, available: true };
    }
  } catch {
    return { drafts: {}, available: false };
  }
}

export function writeExperienceDrafts(key: string, drafts: ExperienceDrafts, storage?: Storage | null): boolean {
  const store = resolveStorage(storage);
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify({ v: 1, drafts }));
    return true;
  } catch {
    return false;
  }
}

export function clearExperienceDrafts(key: string, storage?: Storage | null): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    // Nothing to clear if storage is blocked.
  }
}

export function clearAllExperienceDrafts(storage?: Storage | null): void {
  const store = resolveStorage(storage);
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const name = store.key(index);
      if (name && name.startsWith(PREFIX)) keys.push(name);
    }
    for (const name of keys) store.removeItem(name);
  } catch {
    // Best effort: sign-out must never be blocked.
  }
}
