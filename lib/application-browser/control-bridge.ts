import type { Frame, Page } from "playwright";

import {
  APPLICATION_BROWSER_BINDING_NAME,
  isB1CommandAllowed,
  parseB1Command,
  type B1Command,
  type B1Status,
  type B1WorkflowState
} from "@/lib/application-browser/types";

type FrameIdentity = Pick<Frame, "url" | "isDetached">;
type PageIdentity = { mainFrame(): FrameIdentity };
type BindingSource = { page: unknown; frame: unknown };

type InvocationInput = {
  controlPage: PageIdentity;
  configuredApplyPilotOrigin: string;
  immutableRunId: string;
  getState(): B1WorkflowState;
  execute(command: B1Command, assertActive: () => void): Promise<B1Status>;
  onCommandError?(): void | Promise<void>;
};

function trustedControlPath(runId: string): string {
  return `/application-runs/${runId}/browser`;
}

function isExactTrustedUrl(value: string, origin: string, runId: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.origin === origin && url.pathname === trustedControlPath(runId) && url.search === "" && url.hash === "";
}

export function createControlBridgeInvocationHandler(input: InvocationInput) {
  const generation = Symbol("application-browser-bridge-generation");
  let activeGeneration: symbol | null = generation;

  function invalidate(): void {
    activeGeneration = null;
  }

  function assertInvocation(source: BindingSource): void {
    if (activeGeneration !== generation) throw new Error("The control bridge generation is stale.");
    if (source.page !== input.controlPage) throw new Error("The binding source is not the control page.");
    const mainFrame = input.controlPage.mainFrame();
    if (source.frame !== mainFrame) throw new Error("The binding source is not the control page main frame.");
    if (mainFrame.isDetached()) throw new Error("The control page main frame is detached.");
    if (!isExactTrustedUrl(mainFrame.url(), input.configuredApplyPilotOrigin, input.immutableRunId)) {
      throw new Error("The binding source is not the exact trusted control route.");
    }
  }

  return Object.freeze({
    async invoke(source: BindingSource, rawCommand: unknown): Promise<B1Status> {
      assertInvocation(source);
      const command = parseB1Command(rawCommand);
      await Promise.resolve();
      assertInvocation(source);
      if (!isB1CommandAllowed(command, input.getState())) {
        throw new Error("This B1 command is not allowed in the current workflow state.");
      }
      try {
        return await input.execute(command, () => assertInvocation(source));
      } catch (error) {
        invalidate();
        await input.onCommandError?.();
        throw error;
      }
    },
    invalidate,
    handleTopLevelNavigation: invalidate,
    isActive: () => activeGeneration === generation
  });
}

export async function installControlBridge(input: {
  controlPage: Page;
  configuredApplyPilotOrigin: string;
  immutableRunId: string;
  getState(): B1WorkflowState;
  execute(command: B1Command, assertActive: () => void): Promise<B1Status>;
  onTrustLost(code: string): void | Promise<void>;
}) {
  const bridge = createControlBridgeInvocationHandler({
    ...input,
    onCommandError: () => input.onTrustLost("CONTROL_COMMAND_FAILED")
  });
  const mainFrame = input.controlPage.mainFrame();
  if (!isExactTrustedUrl(mainFrame.url(), input.configuredApplyPilotOrigin, input.immutableRunId)) {
    throw new Error("The control bridge cannot be installed before the exact trusted control route is loaded.");
  }

  await input.controlPage.exposeBinding(
    APPLICATION_BROWSER_BINDING_NAME,
    (source, rawCommand: unknown) => bridge.invoke(source, rawCommand)
  );
  if (!isExactTrustedUrl(input.controlPage.mainFrame().url(), input.configuredApplyPilotOrigin, input.immutableRunId)) {
    bridge.invalidate();
    throw new Error("The control page left the trusted route while the bridge was being installed.");
  }

  input.controlPage.on("framenavigated", (frame) => {
    if (frame !== input.controlPage.mainFrame()) return;
    if (isExactTrustedUrl(frame.url(), input.configuredApplyPilotOrigin, input.immutableRunId)) return;
    bridge.handleTopLevelNavigation();
    void input.onTrustLost("CONTROL_NAVIGATION_TRUST_LOST");
    let origin: string | null = null;
    try {
      origin = new URL(frame.url()).origin;
    } catch {
      origin = null;
    }
    if (origin !== input.configuredApplyPilotOrigin) {
      void input.controlPage.close().catch(() => undefined);
    }
  });
  input.controlPage.on("close", bridge.invalidate);
  return bridge;
}
