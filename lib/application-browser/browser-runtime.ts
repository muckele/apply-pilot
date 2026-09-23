import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export const MISSING_CHROMIUM_MESSAGE = "Apply Pilot Chromium is not installed. Run: npm run browser:install";

type PageLike = Pick<Page, "close">;
type ContextLike = Pick<BrowserContext, "close"> & { newPage(): Promise<PageLike> };
type BrowserLike = Pick<Browser, "close"> & { newContext(): Promise<ContextLike> };
type ChromiumLauncherLike = {
  launch(options: { headless: false }): Promise<BrowserLike>;
};
const OWNED_CLOSE_TIMEOUT_MS = 4_000;

function withinOwnedCloseDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Exact-owned browser close did not settle.")), timeoutMs);
    })
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

export type ApplicationBrowserRuntime = {
  browser: BrowserLike;
  /** Authenticated owner/control requests and page stay in this context. */
  context: ContextLike;
  controlPage: PageLike;
  /** Never receives the Apply Pilot owner session or control binding. */
  employerContext: ContextLike;
  close(): Promise<void>;
};

function isMissingChromiumError(error: unknown): boolean {
  return error instanceof Error &&
    /executable.*(doesn'?t exist|missing|not found)|playwright install/i.test(error.message);
}

export async function launchApplicationBrowserRuntimeWithLauncherForTest(
  launcher: ChromiumLauncherLike,
  closeTimeoutMs = OWNED_CLOSE_TIMEOUT_MS
): Promise<ApplicationBrowserRuntime> {
  let browser: BrowserLike;
  try {
    browser = await launcher.launch({ headless: false });
  } catch (error) {
    if (isMissingChromiumError(error)) throw new Error(MISSING_CHROMIUM_MESSAGE);
    throw error;
  }

  let context: ContextLike | undefined;
  let controlPage: PageLike | undefined;
  let employerContext: ContextLike | undefined;
  try {
    context = await browser.newContext();
    controlPage = await context.newPage();
    employerContext = await browser.newContext();
  } catch (error) {
    let cleanupError: unknown;
    const rollbackEmployerContext = employerContext;
    const rollbackControlContext = context;
    const rollback = await withinOwnedCloseDeadline(Promise.allSettled([
      ...(rollbackEmployerContext ? [Promise.resolve().then(() => rollbackEmployerContext.close())] : []),
      ...(rollbackControlContext ? [Promise.resolve().then(() => rollbackControlContext.close())] : [])
    ]), closeTimeoutMs).catch((failure: unknown) => { cleanupError = failure; return null; });
    if (rollback) {
      for (const result of rollback) {
        if (result.status === "rejected") cleanupError ??= result.reason;
      }
    }
    try {
      await withinOwnedCloseDeadline(Promise.resolve().then(() => browser.close()), closeTimeoutMs);
    } catch (failure) {
      cleanupError ??= failure;
    }
    if (cleanupError !== undefined) {
      throw new AggregateError([error, cleanupError], "Browser setup failed and exact-owned cleanup is uncertain.");
    }
    throw error;
  }

  let closePromise: Promise<void> | null = null;
  return {
    browser,
    context,
    controlPage,
    employerContext,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        let firstError: unknown;
        // Dispatch all page/context closures together. A stalled control page
        // cannot prevent the isolated employer context from being closed.
        const initial = await withinOwnedCloseDeadline(Promise.allSettled([
          Promise.resolve().then(() => controlPage.close()),
          Promise.resolve().then(() => employerContext.close()),
          Promise.resolve().then(() => context.close())
        ]), closeTimeoutMs).catch((error: unknown) => { firstError = error; return null; });
        if (initial) {
          for (const result of initial) {
            if (result.status === "rejected") firstError ??= result.reason;
          }
        }
        try {
          await withinOwnedCloseDeadline(Promise.resolve().then(() => browser.close()), closeTimeoutMs);
        } catch (error) {
          firstError ??= error;
        }
        if (firstError !== undefined) throw firstError;
      })();
      return closePromise;
    }
  };
}

export async function launchApplicationBrowserRuntime(): Promise<ApplicationBrowserRuntime> {
  return launchApplicationBrowserRuntimeWithLauncherForTest(chromium);
}
