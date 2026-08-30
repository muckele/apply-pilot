import type { ElementHandle, Frame, Page } from "playwright";

import {
  ApplicationFormCorrelationError,
  correlateSafeApplicationFormExtraction,
  type CorrelatedSafeApplicationFormExtraction
} from "@/lib/application-browser/form-inspection-correlation";
import {
  extractSafeApplicationForm,
  type SafeApplicationFormExtraction,
  type SourceChoiceOrdinal,
  type SourceFieldOrdinal
} from "@/lib/application-browser/form-inspection-dom";
import {
  canonicalJson,
  FormInspectionDomainError,
  type ApplicationFormInspectionReport,
  type NormalizedApplicationFormSnapshot
} from "@/lib/application-runs/form-inspection";

export const RELEVANT_MUTATION_QUIET_MS = 500;
export const SEMANTIC_EXTRACTION_GAP_MS = 250;
export const MAX_STABILIZATION_MS = 10_000;

export const APPLICATION_FORM_INSPECTION_CONTROLLER_ERROR_CODES = [
  "FORM_STABILITY_TIMEOUT",
  "FORM_CORRELATION_INVALID",
  "FORM_INSPECTION_IN_PROGRESS",
  "FORM_INSPECTION_CANCELLED",
  "FORM_GENERATION_INVALIDATED"
] as const;

export type ApplicationFormInspectionControllerErrorCode =
  (typeof APPLICATION_FORM_INSPECTION_CONTROLLER_ERROR_CODES)[number];

export class ApplicationFormInspectionControllerError extends Error {
  readonly code: ApplicationFormInspectionControllerErrorCode;

  constructor(code: ApplicationFormInspectionControllerErrorCode) {
    super(`Application form inspection controller failed: ${code}`);
    this.name = "ApplicationFormInspectionControllerError";
    this.code = code;
  }
}

export type ApplicationFormInspectionInvalidationCode =
  | "REINSPECTION_REQUIRED"
  | "TARGET_NAVIGATED"
  | "PAGE_CLOSED";

export type FormSemanticObserverSnapshot = Readonly<{
  semanticRevision: number;
  applicantStateEpoch: number;
}>;

export type OwnedFormSemanticObserver = Readonly<{
  snapshot(): Promise<FormSemanticObserverSnapshot>;
  waitForChange(input: Readonly<{
    semanticRevision: number;
    applicantStateEpoch: number;
    timeoutMs: number;
  }>): Promise<FormSemanticObserverSnapshot>;
  refresh(extraction: SafeApplicationFormExtraction): Promise<void>;
  dispose(): Promise<void>;
}>;

export type ApplicationFormInspectionControllerRuntime = Readonly<{
  extract(page: Page): Promise<SafeApplicationFormExtraction>;
  correlate(input: Readonly<{
    extraction: SafeApplicationFormExtraction;
    authoritativeApplyHost: string;
  }>): Promise<CorrelatedSafeApplicationFormExtraction>;
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
  createObserver(page: Page): Promise<OwnedFormSemanticObserver>;
  isHandleAttached(handle: ElementHandle): Promise<boolean>;
}>;

export type TransientInspectionGeneration = Readonly<{
  generationId: symbol;
  formFingerprint: string;
  inspectionReport: ApplicationFormInspectionReport;
  normalizedSnapshot: NormalizedApplicationFormSnapshot;
  fields: ReadonlyMap<string, Readonly<{
    fieldFingerprint: string;
    sourceOrdinal: SourceFieldOrdinal;
    handle: ElementHandle;
  }>>;
  choices: ReadonlyMap<string, ReadonlyMap<string, Readonly<{
    sourceOrdinal: SourceChoiceOrdinal;
    handle: ElementHandle;
  }>>>;
  dispose(): Promise<void>;
}>;

export type ApplicationFormInspectionController = Readonly<{
  inspect(options?: Readonly<{ signal?: AbortSignal }>): Promise<TransientInspectionGeneration>;
  current(): TransientInspectionGeneration | null;
  assertCurrent(
    generationId: symbol,
    options?: Readonly<{ signal?: AbortSignal }>
  ): Promise<TransientInspectionGeneration>;
  close(): Promise<void>;
}>;

type PrivateFieldReference = Readonly<{
  canonicalKey: string;
  fieldFingerprint: string;
  sourceOrdinal: SourceFieldOrdinal;
  handle: ElementHandle;
}>;

type PrivateChoiceReference = Readonly<{
  fieldCanonicalKey: string;
  canonicalKey: string;
  sourceOrdinal: SourceChoiceOrdinal;
  handle: ElementHandle;
}>;

type AcceptedGeneration = {
  readonly generationId: symbol;
  readonly correlated: CorrelatedSafeApplicationFormExtraction;
  readonly privateReportCanonical: string;
  readonly privateFields: readonly PrivateFieldReference[];
  readonly privateChoices: readonly PrivateChoiceReference[];
  readonly facade: TransientInspectionGeneration;
  active: boolean;
  invalidationEmitted: boolean;
  disposePromise: Promise<void> | null;
};

type AttemptTerminalCode = "FORM_STABILITY_TIMEOUT" | "FORM_INSPECTION_CANCELLED";

type InspectAttempt = {
  readonly deadline: number;
  readonly navigationEpoch: number;
  terminalCode: AttemptTerminalCode | null;
  terminalPromise: Promise<never>;
  rejectTerminal: (error: ApplicationFormInspectionControllerError) => void;
  timer: unknown;
  quarantined: boolean;
};

type RemoteObserver = Readonly<{
  snapshot(): FormSemanticObserverSnapshot;
  waitForChange(input: Readonly<{
    semanticRevision: number;
    applicantStateEpoch: number;
    timeoutMs: number;
  }>): Promise<FormSemanticObserverSnapshot>;
  refresh(nodes: readonly Element[]): void;
  dispose(): void;
}>;

function cloneFieldOrdinal(source: SourceFieldOrdinal): SourceFieldOrdinal {
  return { form: source.form, section: source.section, field: source.field };
}

function cloneChoiceOrdinal(source: SourceChoiceOrdinal): SourceChoiceOrdinal {
  return {
    form: source.form,
    section: source.section,
    field: source.field,
    choice: source.choice
  };
}

function controllerError(
  code: ApplicationFormInspectionControllerErrorCode
): ApplicationFormInspectionControllerError {
  return new ApplicationFormInspectionControllerError(code);
}

function plainClone<T>(value: T): T {
  return structuredClone(value);
}

async function createPageSemanticObserver(page: Page): Promise<OwnedFormSemanticObserver> {
  const remote = await page.evaluateHandle((): RemoteObserver => {
    let semanticRevision = 0;
    let applicantStateEpoch = 0;
    let disposed = false;
    let explicitSemanticNodes = new WeakSet<Node>();
    let semanticAncestors = new WeakSet<Node>();
    const rootObservers = new Map<Document | ShadowRoot, MutationObserver>();
    const cleanupListeners: Array<() => void> = [];
    const waiters = new Set<{
      resolve: (snapshot: FormSemanticObserverSnapshot) => void;
      timer: ReturnType<typeof setTimeout>;
    }>();
    const semanticSelector = [
      "form",
      "input",
      "textarea",
      "select",
      "button",
      "label",
      "fieldset",
      "legend",
      "option",
      "optgroup",
      "[role]",
      "[contenteditable]",
      "[form]",
      "style",
      "link[rel~='stylesheet']"
    ].join(",");
    const structuralSurfaceSelector = "form,[form],style,link[rel~='stylesheet']";
    const structuralIntroductionSelector =
      "form,input,textarea,select,[form],style,link[rel~='stylesheet']";

    const snapshot = [(): FormSemanticObserverSnapshot => ({
      semanticRevision,
      applicantStateEpoch
    })][0];
    const wake = [() => {
      const value = snapshot();
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(value);
      }
      waiters.clear();
    }][0];
    const bumpSemantic = [() => {
      semanticRevision += 1;
      wake();
    }][0];
    const bumpApplicant = [() => {
      applicantStateEpoch += 1;
      wake();
    }][0];
    const elementMayIntroduceSemantics = [(element: Element): boolean =>
      element.matches(structuralIntroductionSelector) ||
      element.querySelector(structuralIntroductionSelector) !== null
    ][0];
    const isCurrentContentText = [(node: Node): boolean => {
      const element = node.nodeType === Node.ELEMENT_NODE
        ? node as Element
        : node.parentElement;
      if (!element) return false;
      if (element.matches("textarea") || element.closest("textarea")) return true;
      const editable = element.matches("[contenteditable]")
        ? element
        : element.closest("[contenteditable]");
      return editable !== null && !element.querySelector(semanticSelector);
    }][0];
    const isRelated = [(node: Node | null): boolean => {
      if (!node) return false;
      if (explicitSemanticNodes.has(node)) return true;
      const element = node.nodeType === Node.ELEMENT_NODE
        ? node as Element
        : node.parentElement;
      if (!element) return false;
      if (explicitSemanticNodes.has(element)) return true;
      if (semanticAncestors.has(element)) return true;
      if (element === document.head || document.head.contains(element)) return true;
      let surface: Element | null = element;
      while (surface) {
        if (
          explicitSemanticNodes.has(surface) ||
          semanticAncestors.has(surface) ||
          surface.matches(structuralSurfaceSelector) ||
          surface.closest("form") !== null
        ) {
          return true;
        }
        const root = surface.getRootNode();
        surface = root instanceof ShadowRoot ? root.host : null;
      }
      return false;
    }][0];
    const observeRoot = [(root: Document | ShadowRoot) => {
      if (rootObservers.has(root)) return;
      const observer = new MutationObserver(onRecords);
      observer.observe(root, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true
      });
      rootObservers.set(root, observer);
    }][0];
    const discoverOpenRootsIncrementally = [(
      node: Element | ShadowRoot,
      roots: Set<Document | ShadowRoot>
    ) => {
      if (node instanceof Element && node.shadowRoot) roots.add(node.shadowRoot);
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
      for (let current = walker.nextNode(); current; current = walker.nextNode()) {
        if (current instanceof Element && current.shadowRoot) roots.add(current.shadowRoot);
      }
    }][0];
    const mutationNodesSome = [(
      record: MutationRecord,
      predicate: (node: Node) => boolean
    ): boolean => {
      for (const node of record.addedNodes) {
        if (predicate(node)) return true;
      }
      for (const node of record.removedNodes) {
        if (predicate(node)) return true;
      }
      return false;
    }][0];
    const recordIsRelevant = [(record: MutationRecord): boolean => {
      if (record.type === "attributes") {
        if (record.attributeName === "value" || record.attributeName === "checked" || record.attributeName === "selected") {
          return false;
        }
        return isRelated(record.target);
      }
      if (record.type === "characterData") {
        return !isCurrentContentText(record.target) && isRelated(record.target);
      }
      const targetElement = record.target.nodeType === Node.ELEMENT_NODE
        ? record.target as Element
        : record.target.parentElement;
      const targetIsDirectSurface =
        explicitSemanticNodes.has(record.target) ||
        (record.target instanceof ShadowRoot && isRelated(record.target.host)) ||
        (targetElement !== null && (
          targetElement === document.head ||
          document.head.contains(targetElement) ||
          targetElement.matches(structuralSurfaceSelector) ||
          targetElement.closest("form") !== null
        ));
      if (targetIsDirectSurface) {
        if (isCurrentContentText(record.target)) {
          return mutationNodesSome(record, (node) =>
            node.nodeType === Node.ELEMENT_NODE
          );
        }
        return true;
      }
      return mutationNodesSome(record, (node) =>
        node.nodeType === Node.ELEMENT_NODE && elementMayIntroduceSemantics(node as Element)
      );
    }][0];
    const onRecords = [(records: MutationRecord[]) => {
      let relevant = false;
      for (const record of records) {
        if (recordIsRelevant(record)) relevant = true;
      }
      if (relevant) bumpSemantic();
    }][0];
    observeRoot(document);
    const onApplicantState = [() => bumpApplicant()][0];
    document.addEventListener("input", onApplicantState, true);
    document.addEventListener("change", onApplicantState, true);
    cleanupListeners.push(() => document.removeEventListener("input", onApplicantState, true));
    cleanupListeners.push(() => document.removeEventListener("change", onApplicantState, true));

    const onStyleRisk = [(event: Event) => {
      if (event.type === "resize" || isRelated(event.target as Node | null)) bumpSemantic();
    }][0];
    document.addEventListener("load", onStyleRisk, true);
    cleanupListeners.push(() => document.removeEventListener("load", onStyleRisk, true));
    const styleRiskEvents = [
      "resize",
      "animationstart",
      "animationiteration",
      "animationend",
      "animationcancel",
      "transitionrun",
      "transitionstart",
      "transitionend",
      "transitioncancel"
    ];
    for (const eventName of styleRiskEvents) {
      window.addEventListener(eventName, onStyleRisk, true);
      cleanupListeners.push(() => window.removeEventListener(eventName, onStyleRisk, true));
    }

    return {
      snapshot,
      waitForChange(input) {
        if (
          disposed ||
          semanticRevision !== input.semanticRevision ||
          applicantStateEpoch !== input.applicantStateEpoch
        ) {
          return Promise.resolve(snapshot());
        }
        return new Promise((resolve) => {
          const waiter = {
            resolve,
            timer: setTimeout(() => {
              waiters.delete(waiter);
              resolve(snapshot());
            }, input.timeoutMs)
          };
          waiters.add(waiter);
        });
      },
      refresh(nodes) {
        explicitSemanticNodes = new WeakSet<Node>();
        semanticAncestors = new WeakSet<Node>();
        const scanSurfaces = new Set<Element>();
        for (const node of nodes) {
          explicitSemanticNodes.add(node);
          scanSurfaces.add(node);
          let current: Node | null = node;
          while (current) {
            if (current instanceof Element) {
              const ownerForm = (
                current instanceof HTMLInputElement ||
                current instanceof HTMLTextAreaElement ||
                current instanceof HTMLSelectElement ||
                current instanceof HTMLButtonElement
              ) ? current.form : null;
              const containingForm = ownerForm ?? current.closest("form");
              if (containingForm) scanSurfaces.add(containingForm);
              if ("labels" in current) {
                for (const label of (current as HTMLInputElement).labels ?? []) {
                  explicitSemanticNodes.add(label);
                }
              }
              for (const attribute of ["aria-labelledby", "aria-describedby"]) {
                for (const id of (current.getAttribute(attribute) ?? "").split(/\s+/u)) {
                  if (!id) continue;
                  const referenced = document.getElementById(id);
                  if (referenced) explicitSemanticNodes.add(referenced);
                }
              }
            }
            current = current.parentNode instanceof ShadowRoot
              ? current.parentNode.host
              : current.parentNode;
            if (current) semanticAncestors.add(current);
          }
        }

        const desiredRoots = new Set<Document | ShadowRoot>([document]);
        for (const surface of scanSurfaces) {
          if (surface.isConnected) discoverOpenRootsIncrementally(surface, desiredRoots);
        }
        for (const root of desiredRoots) {
          if (root instanceof ShadowRoot && root.host.isConnected) {
            discoverOpenRootsIncrementally(root, desiredRoots);
          }
        }
        for (const [root, observer] of rootObservers) {
          if (desiredRoots.has(root)) continue;
          observer.disconnect();
          rootObservers.delete(root);
        }
        for (const root of desiredRoots) observeRoot(root);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        for (const observer of rootObservers.values()) observer.disconnect();
        rootObservers.clear();
        for (const cleanup of cleanupListeners) cleanup();
        wake();
      }
    };
  });

  let disposePromise: Promise<void> | null = null;
  return {
    async snapshot() {
      return remote.evaluate((state) => state.snapshot());
    },
    async waitForChange(input) {
      return remote.evaluate((state, value) => state.waitForChange(value), input);
    },
    async refresh(extraction) {
      const handles = extraction.fields.flatMap((field) => [
        field.handle,
        ...field.choices.map((choice) => choice.handle)
      ]);
      await remote.evaluate(
        (state, nodes) => state.refresh(nodes as unknown as readonly Element[]),
        handles
      );
    },
    dispose() {
      disposePromise ??= (async () => {
        try {
          await remote.evaluate((state) => state.dispose());
        } finally {
          await remote.dispose();
        }
      })();
      return disposePromise;
    }
  };
}

const PRODUCTION_RUNTIME: ApplicationFormInspectionControllerRuntime = {
  extract: extractSafeApplicationForm,
  correlate: correlateSafeApplicationFormExtraction,
  now: () => performance.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  createObserver: createPageSemanticObserver,
  isHandleAttached: (handle) => handle.evaluate((element) =>
    element.isConnected && element.ownerDocument === document
  )
};

function capturePrivateReferences(correlated: CorrelatedSafeApplicationFormExtraction): {
  fields: readonly PrivateFieldReference[];
  choices: readonly PrivateChoiceReference[];
} {
  const fields = [...correlated.fields].map(([canonicalKey, reference]) => ({
    canonicalKey,
    fieldFingerprint: reference.fieldFingerprint,
    sourceOrdinal: cloneFieldOrdinal(reference.sourceOrdinal),
    handle: reference.handle
  }));
  const choices = [...correlated.choices].flatMap(([fieldCanonicalKey, fieldChoices]) =>
    [...fieldChoices].map(([canonicalKey, reference]) => ({
      fieldCanonicalKey,
      canonicalKey,
      sourceOrdinal: cloneChoiceOrdinal(reference.sourceOrdinal),
      handle: reference.handle
    }))
  );
  return { fields, choices };
}

export function createApplicationFormInspectionControllerWithRuntime(
  input: Readonly<{
    page: Page;
    authoritativeApplyHost: string;
    onInvalidated?: (code: ApplicationFormInspectionInvalidationCode) => void;
  }>,
  runtime: ApplicationFormInspectionControllerRuntime
): ApplicationFormInspectionController {
  let closed = false;
  let closePromise: Promise<void> | null = null;
  let observer: OwnedFormSemanticObserver | null = null;
  let observerPromise: Promise<OwnedFormSemanticObserver> | null = null;
  let currentRecord: AcceptedGeneration | null = null;
  let activeAttempt: InspectAttempt | null = null;
  const activeVerifications = new Set<InspectAttempt>();
  let navigationEpoch = 0;
  let pageClosedEmitted = false;
  let listenersRemoved = false;

  const emitInvalidation = (code: ApplicationFormInspectionInvalidationCode): void => {
    try {
      input.onInvalidated?.(code);
    } catch {
      // Caller notification is advisory and cannot control mandatory cleanup.
    }
  };

  const ensureObserver = async (): Promise<OwnedFormSemanticObserver> => {
    if (observer) return observer;
    const observerEpoch = navigationEpoch;
    observerPromise ??= runtime.createObserver(input.page).then(async (created) => {
      if (closed || input.page.isClosed() || navigationEpoch !== observerEpoch) {
        await created.dispose().catch(() => undefined);
        throw controllerError("FORM_INSPECTION_CANCELLED");
      }
      observer = created;
      return created;
    }).finally(() => {
      observerPromise = null;
    });
    return observerPromise;
  };

  const disposeAccepted = (record: AcceptedGeneration): Promise<void> => {
    record.disposePromise ??= Promise.resolve().then(() => record.correlated.dispose()).catch(() => undefined);
    return record.disposePromise;
  };

  const releaseGeneration = (generationId: symbol): Promise<void> => {
    const record = currentRecord;
    if (!record || record.generationId !== generationId) return Promise.resolve();
    currentRecord = null;
    record.active = false;
    return disposeAccepted(record);
  };

  const invalidateAccepted = (
    record: AcceptedGeneration,
    code: ApplicationFormInspectionInvalidationCode,
    notify = true
  ): Promise<void> => {
    if (!record.active || currentRecord !== record) return record.disposePromise ?? Promise.resolve();
    currentRecord = null;
    record.active = false;
    const cleanup = disposeAccepted(record);
    if (!record.invalidationEmitted) {
      record.invalidationEmitted = true;
      if (notify) emitInvalidation(code);
    }
    return cleanup;
  };

  const makeAttempt = (): InspectAttempt => {
    let rejectTerminal!: (error: ApplicationFormInspectionControllerError) => void;
    const terminalPromise = new Promise<never>((_, reject) => {
      rejectTerminal = reject;
    });
    terminalPromise.catch(() => undefined);
    const attempt: InspectAttempt = {
      deadline: runtime.now() + MAX_STABILIZATION_MS,
      navigationEpoch,
      terminalCode: null,
      terminalPromise,
      rejectTerminal,
      timer: undefined,
      quarantined: false
    };
    attempt.timer = runtime.setTimer(() => {
      if (attempt.terminalCode) return;
      attempt.terminalCode = "FORM_STABILITY_TIMEOUT";
      attempt.rejectTerminal(controllerError("FORM_STABILITY_TIMEOUT"));
    }, MAX_STABILIZATION_MS);
    return attempt;
  };

  const terminateAttempt = (attempt: InspectAttempt, code: AttemptTerminalCode) => {
    if (attempt.terminalCode) return;
    attempt.terminalCode = code;
    runtime.clearTimer(attempt.timer);
    attempt.rejectTerminal(controllerError(code));
  };

  const finishAttempt = (attempt: InspectAttempt) => {
    runtime.clearTimer(attempt.timer);
    if (!attempt.quarantined && activeAttempt === attempt) activeAttempt = null;
  };

  const assertAttemptActive = (attempt: InspectAttempt, frame: Frame | object) => {
    if (attempt.terminalCode) throw controllerError(attempt.terminalCode);
    if (closed || input.page.isClosed()) throw controllerError("FORM_INSPECTION_CANCELLED");
    if (
      navigationEpoch !== attempt.navigationEpoch ||
      input.page.mainFrame() !== frame
    ) {
      throw controllerError("FORM_INSPECTION_CANCELLED");
    }
    if (runtime.now() >= attempt.deadline) throw controllerError("FORM_STABILITY_TIMEOUT");
  };

  const raceAttempt = <T>(attempt: InspectAttempt, operation: Promise<T>): Promise<T> =>
    Promise.race([operation, attempt.terminalPromise]);

  const disposeObserverForLifecycle = (): Promise<void> => {
    const owned = observer;
    const pending = observerPromise;
    observer = null;
    observerPromise = null;
    return Promise.all([
      owned?.dispose().catch(() => undefined) ?? Promise.resolve(),
      pending?.then((created) => created.dispose()).catch(() => undefined) ?? Promise.resolve()
    ]).then(() => undefined);
  };

  const disposeExtraction = async (extraction: SafeApplicationFormExtraction | null) => {
    if (!extraction) return;
    try {
      await extraction.dispose();
    } catch {
      // Cleanup errors never replace the bounded controller result.
    }
  };

  const extractOwned = async (attempt: InspectAttempt): Promise<SafeApplicationFormExtraction> => {
    const pending = runtime.extract(input.page);
    try {
      return await raceAttempt(attempt, pending);
    } catch (error) {
      if (attempt.terminalCode) {
        attempt.quarantined = true;
        void pending.then(disposeExtraction, () => undefined).finally(() => {
          attempt.quarantined = false;
          if (activeAttempt === attempt) activeAttempt = null;
        });
      }
      throw error;
    }
  };

  const correlateOwned = async (
    attempt: InspectAttempt,
    extraction: SafeApplicationFormExtraction
  ): Promise<CorrelatedSafeApplicationFormExtraction> => {
    const pending = runtime.correlate({
      extraction,
      authoritativeApplyHost: input.authoritativeApplyHost
    });
    try {
      return await raceAttempt(attempt, pending);
    } catch (error) {
      if (attempt.terminalCode) {
        attempt.quarantined = true;
        void pending.then(
          (candidate) => candidate.dispose().catch(() => undefined),
          () => undefined
        ).finally(() => {
          attempt.quarantined = false;
          if (activeAttempt === attempt) activeAttempt = null;
        });
      }
      throw error;
    }
  };

  const reportsEqual = (
    left: ApplicationFormInspectionReport,
    right: ApplicationFormInspectionReport
  ): boolean => canonicalJson(left) === canonicalJson(right);

  const allAttached = async (
    fields: readonly PrivateFieldReference[],
    choices: readonly PrivateChoiceReference[]
  ): Promise<boolean> => {
    for (const reference of [...fields, ...choices]) {
      try {
        if (!await runtime.isHandleAttached(reference.handle)) return false;
      } catch {
        return false;
      }
    }
    return true;
  };

  const armSemanticInvalidationWait = (
    record: AcceptedGeneration,
    initial: FormSemanticObserverSnapshot
  ) => {
    void (async () => {
      let observed = initial;
      while (!closed && record.active && currentRecord === record) {
        let changed: FormSemanticObserverSnapshot;
        try {
          changed = await (await ensureObserver()).waitForChange({
            ...observed,
            timeoutMs: MAX_STABILIZATION_MS
          });
        } catch {
          return;
        }
        if (!record.active || currentRecord !== record) return;
        if (changed.semanticRevision !== observed.semanticRevision) {
          await invalidateAccepted(record, "REINSPECTION_REQUIRED");
          return;
        }
        observed = changed;
      }
    })();
  };

  const buildFacade = (
    generationId: symbol,
    correlated: CorrelatedSafeApplicationFormExtraction,
    privateReferences: ReturnType<typeof capturePrivateReferences>
  ): TransientInspectionGeneration => {
    const fields = new Map(privateReferences.fields.map((reference) => [
      reference.canonicalKey,
      {
        fieldFingerprint: reference.fieldFingerprint,
        sourceOrdinal: cloneFieldOrdinal(reference.sourceOrdinal),
        handle: reference.handle
      }
    ]));
    const choices = new Map<string, ReadonlyMap<string, Readonly<{
      sourceOrdinal: SourceChoiceOrdinal;
      handle: ElementHandle;
    }>>>();
    for (const reference of privateReferences.choices) {
      const fieldChoices = new Map(choices.get(reference.fieldCanonicalKey) ?? []);
      fieldChoices.set(reference.canonicalKey, {
        sourceOrdinal: cloneChoiceOrdinal(reference.sourceOrdinal),
        handle: reference.handle
      });
      choices.set(reference.fieldCanonicalKey, fieldChoices);
    }
    let disposePromise: Promise<void> | null = null;
    const facade: TransientInspectionGeneration = {
      generationId,
      formFingerprint: correlated.formFingerprint,
      inspectionReport: plainClone(correlated.inspectionReport),
      normalizedSnapshot: plainClone(correlated.normalizedSnapshot),
      fields,
      choices,
      dispose() {
        disposePromise ??= releaseGeneration(generationId);
        return disposePromise;
      }
    };
    return facade;
  };

  const verifyCandidate = async (
    attempt: InspectAttempt,
    candidate: CorrelatedSafeApplicationFormExtraction,
    privateReportCanonical: string,
    privateReferences: ReturnType<typeof capturePrivateReferences>
  ): Promise<boolean> => {
    const frame = input.page.mainFrame();
    while (true) {
      assertAttemptActive(attempt, frame);
      const state = await raceAttempt(attempt, (await ensureObserver()).snapshot());
      const temporary = await extractOwned(attempt);
      let retry = false;
      try {
        assertAttemptActive(attempt, frame);
        const after = await raceAttempt(attempt, (await ensureObserver()).snapshot());
        if (
          state.semanticRevision !== after.semanticRevision ||
          state.applicantStateEpoch !== after.applicantStateEpoch
        ) {
          retry = true;
        } else {
          if (canonicalJson(temporary.report) !== privateReportCanonical) return false;
          if (!await allAttached(privateReferences.fields, privateReferences.choices)) return false;
          const afterAttachment = await raceAttempt(
            attempt,
            (await ensureObserver()).snapshot()
          );
          if (
            state.semanticRevision !== afterAttachment.semanticRevision ||
            state.applicantStateEpoch !== afterAttachment.applicantStateEpoch
          ) {
            retry = true;
          }
        }
      } finally {
        await disposeExtraction(temporary);
      }
      if (retry) continue;
      const afterDisposal = await raceAttempt(attempt, (await ensureObserver()).snapshot());
      if (
        state.semanticRevision !== afterDisposal.semanticRevision ||
        state.applicantStateEpoch !== afterDisposal.applicantStateEpoch
      ) {
        continue;
      }
      assertAttemptActive(attempt, frame);
      return true;
    }
  };

  const inspect = async (
    options: Readonly<{ signal?: AbortSignal }> = {}
  ): Promise<TransientInspectionGeneration> => {
    if (closed || input.page.isClosed() || options.signal?.aborted) {
      throw controllerError("FORM_INSPECTION_CANCELLED");
    }
    if (activeAttempt) throw controllerError("FORM_INSPECTION_IN_PROGRESS");
    const attempt = makeAttempt();
    activeAttempt = attempt;
    const onAbort = () => terminateAttempt(attempt, "FORM_INSPECTION_CANCELLED");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const ownedObserver = await raceAttempt(attempt, ensureObserver());
      const frame = input.page.mainFrame();
      while (true) {
        assertAttemptActive(attempt, frame);
        const quietStart = await raceAttempt(attempt, ownedObserver.snapshot());
        const quietEnd = await raceAttempt(attempt, ownedObserver.waitForChange({
          ...quietStart,
          timeoutMs: Math.min(RELEVANT_MUTATION_QUIET_MS, attempt.deadline - runtime.now())
        }));
        if (quietStart.semanticRevision !== quietEnd.semanticRevision) continue;

        let extractionA: SafeApplicationFormExtraction | null = null;
        let extractionB: SafeApplicationFormExtraction | null = null;
        try {
          const aFence = quietEnd;
          extractionA = await extractOwned(attempt);
          const afterA = await raceAttempt(attempt, ownedObserver.snapshot());
          if (
            aFence.semanticRevision !== afterA.semanticRevision ||
            aFence.applicantStateEpoch !== afterA.applicantStateEpoch
          ) {
            continue;
          }
          await raceAttempt(attempt, ownedObserver.refresh(extractionA));
          const gapEnd = await raceAttempt(attempt, ownedObserver.waitForChange({
            ...afterA,
            timeoutMs: Math.min(SEMANTIC_EXTRACTION_GAP_MS, attempt.deadline - runtime.now())
          }));
          if (
            afterA.semanticRevision !== gapEnd.semanticRevision ||
            afterA.applicantStateEpoch !== gapEnd.applicantStateEpoch
          ) {
            continue;
          }

          extractionB = await extractOwned(attempt);
          const afterB = await raceAttempt(attempt, ownedObserver.snapshot());
          if (
            gapEnd.semanticRevision !== afterB.semanticRevision ||
            gapEnd.applicantStateEpoch !== afterB.applicantStateEpoch
          ) {
            continue;
          }
          if (!reportsEqual(extractionA.report, extractionB.report)) continue;
          await disposeExtraction(extractionA);
          extractionA = null;
          assertAttemptActive(attempt, frame);

          const transferredExtractionB = extractionB;
          extractionB = null;
          const candidate = await correlateOwned(attempt, transferredExtractionB);
          let candidateAccepted = false;
          try {
            const privateReportCanonical = canonicalJson(candidate.inspectionReport);
            const privateReferences = capturePrivateReferences(candidate);
            if (!await verifyCandidate(attempt, candidate, privateReportCanonical, privateReferences)) {
              continue;
            }
            const commitFence = await raceAttempt(attempt, ownedObserver.snapshot());

            const previous = currentRecord;
            if (previous) {
              currentRecord = null;
              previous.active = false;
              await disposeAccepted(previous);
              const afterOldDisposal = await raceAttempt(attempt, ownedObserver.snapshot());
              if (
                afterOldDisposal.semanticRevision !== commitFence.semanticRevision ||
                afterOldDisposal.applicantStateEpoch !== commitFence.applicantStateEpoch
              ) {
                throw controllerError("FORM_GENERATION_INVALIDATED");
              }
              if (!await verifyCandidate(attempt, candidate, privateReportCanonical, privateReferences)) {
                throw controllerError("FORM_GENERATION_INVALIDATED");
              }
            }
            assertAttemptActive(attempt, frame);
            const acceptanceFence = await raceAttempt(attempt, ownedObserver.snapshot());
            assertAttemptActive(attempt, frame);
            const generationId = Symbol();
            const facade = buildFacade(generationId, candidate, privateReferences);
            const accepted: AcceptedGeneration = {
              generationId,
              correlated: candidate,
              privateReportCanonical,
              privateFields: privateReferences.fields,
              privateChoices: privateReferences.choices,
              facade,
              active: true,
              invalidationEmitted: false,
              disposePromise: null
            };
            currentRecord = accepted;
            armSemanticInvalidationWait(accepted, acceptanceFence);
            candidateAccepted = true;
            return facade;
          } finally {
            if (!candidateAccepted) await candidate.dispose().catch(() => undefined);
          }
        } finally {
          await Promise.all([
            disposeExtraction(extractionA),
            disposeExtraction(extractionB)
          ]);
        }
      }
    } catch (error) {
      if (error instanceof ApplicationFormInspectionControllerError) throw error;
      if (
        error instanceof FormInspectionDomainError &&
        error.code === "AMBIGUOUS_DUPLICATE_FIELD"
      ) {
        throw error;
      }
      if (error instanceof ApplicationFormCorrelationError) {
        throw controllerError("FORM_CORRELATION_INVALID");
      }
      throw controllerError("FORM_CORRELATION_INVALID");
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      finishAttempt(attempt);
    }
  };

  const assertCurrent = async (
    generationId: symbol,
    options: Readonly<{ signal?: AbortSignal }> = {}
  ): Promise<TransientInspectionGeneration> => {
    const record = currentRecord;
    if (closed || input.page.isClosed() || options.signal?.aborted) {
      throw controllerError("FORM_INSPECTION_CANCELLED");
    }
    if (!record || !record.active || record.generationId !== generationId) {
      throw controllerError("FORM_GENERATION_INVALIDATED");
    }
    const attempt = makeAttempt();
    activeVerifications.add(attempt);
    const frame = input.page.mainFrame();
    const onAbort = () => terminateAttempt(attempt, "FORM_INSPECTION_CANCELLED");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const ownedObserver = await raceAttempt(attempt, ensureObserver());
      while (true) {
        assertAttemptActive(attempt, frame);
        if (!record.active || currentRecord !== record) {
          throw controllerError("FORM_GENERATION_INVALIDATED");
        }
        const before = await raceAttempt(attempt, ownedObserver.snapshot());
        const pending = runtime.extract(input.page);
        let temporary: SafeApplicationFormExtraction;
        try {
          temporary = await raceAttempt(attempt, pending);
        } catch (error) {
          if (attempt.terminalCode) {
            void pending.then(disposeExtraction, () => undefined);
            throw error;
          }
          await invalidateAccepted(record, "REINSPECTION_REQUIRED");
          throw controllerError("FORM_GENERATION_INVALIDATED");
        }
        let retry = false;
        try {
          assertAttemptActive(attempt, frame);
          const afterExtraction = await raceAttempt(attempt, ownedObserver.snapshot());
          if (
            before.semanticRevision !== afterExtraction.semanticRevision ||
            before.applicantStateEpoch !== afterExtraction.applicantStateEpoch
          ) {
            retry = true;
          } else if (canonicalJson(temporary.report) !== record.privateReportCanonical) {
            await invalidateAccepted(record, "REINSPECTION_REQUIRED");
            throw controllerError("FORM_GENERATION_INVALIDATED");
          } else if (!await allAttached(record.privateFields, record.privateChoices)) {
            await invalidateAccepted(record, "REINSPECTION_REQUIRED");
            throw controllerError("FORM_GENERATION_INVALIDATED");
          } else {
            const afterAttachment = await raceAttempt(attempt, ownedObserver.snapshot());
            if (
              afterExtraction.semanticRevision !== afterAttachment.semanticRevision ||
              afterExtraction.applicantStateEpoch !== afterAttachment.applicantStateEpoch
            ) {
              retry = true;
            }
          }
        } finally {
          await disposeExtraction(temporary);
        }
        if (retry) continue;
        const afterDisposal = await raceAttempt(attempt, ownedObserver.snapshot());
        if (
          before.semanticRevision !== afterDisposal.semanticRevision ||
          before.applicantStateEpoch !== afterDisposal.applicantStateEpoch
        ) {
          continue;
        }
        assertAttemptActive(attempt, frame);
        if (!record.active || currentRecord !== record) {
          throw controllerError("FORM_GENERATION_INVALIDATED");
        }
        return record.facade;
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      runtime.clearTimer(attempt.timer);
      activeVerifications.delete(attempt);
    }
  };

  const terminateAllActive = () => {
    if (activeAttempt) terminateAttempt(activeAttempt, "FORM_INSPECTION_CANCELLED");
    for (const verification of activeVerifications) {
      terminateAttempt(verification, "FORM_INSPECTION_CANCELLED");
    }
  };

  const onFrameNavigated = (frame: Frame) => {
    if (frame !== input.page.mainFrame()) return;
    navigationEpoch += 1;
    terminateAllActive();
    const accepted = currentRecord;
    if (accepted) void invalidateAccepted(accepted, "TARGET_NAVIGATED");
    void disposeObserverForLifecycle();
  };

  const removePageListeners = () => {
    if (listenersRemoved) return;
    listenersRemoved = true;
    input.page.off("framenavigated", onFrameNavigated);
    input.page.off("close", onPageClose);
  };

  const onPageClose = () => {
    if (closed) return;
    closed = true;
    terminateAllActive();
    removePageListeners();
    const accepted = currentRecord;
    const acceptedCleanup = accepted
      ? invalidateAccepted(accepted, "PAGE_CLOSED", false)
      : Promise.resolve();
    const shouldEmitPageClosed = !pageClosedEmitted;
    pageClosedEmitted = true;
    const observerCleanup = disposeObserverForLifecycle();
    closePromise = Promise.all([acceptedCleanup, observerCleanup]).then(() => undefined);
    if (shouldEmitPageClosed) emitInvalidation("PAGE_CLOSED");
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    terminateAllActive();
    removePageListeners();
    const accepted = currentRecord;
    currentRecord = null;
    if (accepted) accepted.active = false;
    const ownedObserver = observer;
    const pendingObserver = observerPromise;
    observer = null;
    observerPromise = null;
    closePromise = (async () => {
      await Promise.all([
        accepted ? disposeAccepted(accepted) : Promise.resolve(),
        ownedObserver?.dispose() ?? pendingObserver?.then((created) => created.dispose()).catch(() => undefined)
      ]);
    })();
    return closePromise;
  };

  input.page.on("framenavigated", onFrameNavigated);
  input.page.on("close", onPageClose);

  return {
    inspect,
    current: () => currentRecord?.facade ?? null,
    assertCurrent,
    close
  };
}

export function createApplicationFormInspectionController(input: Readonly<{
  page: Page;
  authoritativeApplyHost: string;
  onInvalidated?: (code: ApplicationFormInspectionInvalidationCode) => void;
}>): ApplicationFormInspectionController {
  return createApplicationFormInspectionControllerWithRuntime(input, PRODUCTION_RUNTIME);
}
