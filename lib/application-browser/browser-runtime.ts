import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export const MISSING_CHROMIUM_MESSAGE = "Apply Pilot Chromium is not installed. Run: npm run browser:install";

type PageLike = Pick<Page, "close">;
type ContextLike = Pick<BrowserContext, "close"> & { newPage(): Promise<PageLike> };
type BrowserLike = Pick<Browser, "close"> & { newContext(): Promise<ContextLike> };
type ChromiumLauncherLike = {
  launch(options: { headless: false }): Promise<BrowserLike>;
};

export type ApplicationBrowserRuntime = {
  browser: BrowserLike;
  context: ContextLike;
  controlPage: PageLike;
  close(): Promise<void>;
};

function isMissingChromiumError(error: unknown): boolean {
  return error instanceof Error &&
    /executable.*(doesn'?t exist|missing|not found)|playwright install/i.test(error.message);
}

export async function launchApplicationBrowserRuntimeWithLauncherForTest(
  launcher: ChromiumLauncherLike
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
  try {
    context = await browser.newContext();
    controlPage = await context.newPage();
  } catch (error) {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw error;
  }

  let closed = false;
  return {
    browser,
    context,
    controlPage,
    async close() {
      if (closed) return;
      closed = true;
      await controlPage.close().catch(() => undefined);
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  };
}

export async function launchApplicationBrowserRuntime(): Promise<ApplicationBrowserRuntime> {
  return launchApplicationBrowserRuntimeWithLauncherForTest(chromium);
}
