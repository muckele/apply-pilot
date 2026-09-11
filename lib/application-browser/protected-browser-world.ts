import {
  APPLICATION_FORM_AUTOCOMPLETE_VALUES,
  FORM_INSPECTION_SCHEMA_VERSION,
  FORM_INSPECTION_TEXT_LIMITS,
  MAX_CHOICES_PER_FIELD,
  MAX_CHOICES_TOTAL,
  MAX_FIELDS_TOTAL,
  MAX_FORMS,
  MAX_SECTIONS_PER_FORM
} from "@/lib/application-runs/form-inspection";

export const PROTECTED_BROWSER_CAPABILITY_PROPERTY = "__applyPilotProtectedBrowserCapabilityV2";

export const PROTECTED_BROWSER_OPERATION_WORK_LIMIT = 131_072;

export const PROTECTED_BROWSER_CAPABILITY_METHODS = [
  "handshake",
  "extract",
  "sealCandidateWriterTargets",
  "verifyCandidate",
  "writeCandidateField",
  "disposeCandidate",
  "snapshot",
  "waitForChange",
  "dispose"
] as const;

export const PROTECTED_WRITABLE_FIELD_TYPES = [
  "TEXT",
  "EMAIL",
  "TEL",
  "URL",
  "TEXTAREA",
  "SELECT_ONE"
] as const;

const PROTECTED_WORLD_LIMITS = {
  schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
  maxForms: MAX_FORMS,
  maxSectionsPerForm: MAX_SECTIONS_PER_FORM,
  maxFieldsTotal: MAX_FIELDS_TOTAL,
  maxChoicesPerField: MAX_CHOICES_PER_FIELD,
  maxChoicesTotal: MAX_CHOICES_TOTAL,
  text: FORM_INSPECTION_TEXT_LIMITS,
  autocomplete: APPLICATION_FORM_AUTOCOMPLETE_VALUES,
  writableFieldTypes: PROTECTED_WRITABLE_FIELD_TYPES,
  operationWorkLimit: PROTECTED_BROWSER_OPERATION_WORK_LIMIT
} as const;

function installProtectedBrowserWorld(input: Readonly<{
  property: string;
  methods: readonly string[];
  limits: typeof PROTECTED_WORLD_LIMITS;
}>): void {
  try {
    if (globalThis.window !== globalThis.top) return;

    const protectedWindow = globalThis.window;
    const NativeError = Error;
    const NativeElement = Element;
    const NativeNode = Node;
    const NativeShadowRoot = ShadowRoot;
    const NativeMutationObserver = MutationObserver;
    const NativeHTMLInputElement = HTMLInputElement;
    const NativeHTMLTextAreaElement = HTMLTextAreaElement;
    const NativeHTMLSelectElement = HTMLSelectElement;
    const NativeHTMLOptionElement = HTMLOptionElement;
    const NativeEvent = Event;
    const nativeApply = Reflect.apply;
    const nativeCreate = Object.create;
    const nativeDefineProperty = Object.defineProperty;
    const nativeFreeze = Object.freeze;
    const nativeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
    const nativeKeys = Object.keys;
    const nativeStringify = JSON.stringify;
    const nativeObserve = NativeMutationObserver.prototype.observe;
    const nativeTakeRecords = NativeMutationObserver.prototype.takeRecords;
    const nativeDisconnect = NativeMutationObserver.prototype.disconnect;
    const nativeAddEventListener = EventTarget.prototype.addEventListener;
    const nativeRemoveEventListener = EventTarget.prototype.removeEventListener;
    const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
    const nativeMatches = Element.prototype.matches;
    const inputValueDescriptor = nativeGetOwnPropertyDescriptor(NativeHTMLInputElement.prototype, "value");
    const inputReadOnlyDescriptor = nativeGetOwnPropertyDescriptor(NativeHTMLInputElement.prototype, "readOnly");
    const inputDisabledDescriptor = nativeGetOwnPropertyDescriptor(NativeHTMLInputElement.prototype, "disabled");
    const inputTypeDescriptor = nativeGetOwnPropertyDescriptor(NativeHTMLInputElement.prototype, "type");
    const textAreaValueDescriptor = nativeGetOwnPropertyDescriptor(NativeHTMLTextAreaElement.prototype, "value");
    const textAreaReadOnlyDescriptor = nativeGetOwnPropertyDescriptor(NativeHTMLTextAreaElement.prototype, "readOnly");
    const textAreaDisabledDescriptor = nativeGetOwnPropertyDescriptor(NativeHTMLTextAreaElement.prototype, "disabled");
    const selectMultipleDescriptor = nativeGetOwnPropertyDescriptor(NativeHTMLSelectElement.prototype, "multiple");
    const selectDisabledDescriptor = nativeGetOwnPropertyDescriptor(NativeHTMLSelectElement.prototype, "disabled");
    const optionSelectedDescriptor = nativeGetOwnPropertyDescriptor(NativeHTMLOptionElement.prototype, "selected");
    const optionValueDescriptor = nativeGetOwnPropertyDescriptor(NativeHTMLOptionElement.prototype, "value");
    const optionDisabledDescriptor = nativeGetOwnPropertyDescriptor(NativeHTMLOptionElement.prototype, "disabled");
    if (
      typeof inputValueDescriptor?.get !== "function" ||
      typeof inputValueDescriptor.set !== "function" ||
      typeof inputReadOnlyDescriptor?.get !== "function" ||
      typeof inputDisabledDescriptor?.get !== "function" ||
      typeof inputTypeDescriptor?.get !== "function" ||
      typeof textAreaValueDescriptor?.get !== "function" ||
      typeof textAreaValueDescriptor.set !== "function" ||
      typeof textAreaReadOnlyDescriptor?.get !== "function" ||
      typeof textAreaDisabledDescriptor?.get !== "function" ||
      typeof selectMultipleDescriptor?.get !== "function" ||
      typeof selectDisabledDescriptor?.get !== "function" ||
      typeof optionSelectedDescriptor?.get !== "function" ||
      typeof optionSelectedDescriptor.set !== "function" ||
      typeof optionValueDescriptor?.get !== "function" ||
      typeof optionDisabledDescriptor?.get !== "function" ||
      typeof nativeDispatchEvent !== "function" ||
      typeof nativeMatches !== "function"
    ) throw new NativeError("required protected writer intrinsics are unavailable");
    const nativeInputValueGet = inputValueDescriptor.get;
    const nativeInputValueSet = inputValueDescriptor.set;
    const nativeInputReadOnlyGet = inputReadOnlyDescriptor.get;
    const nativeInputDisabledGet = inputDisabledDescriptor.get;
    const nativeInputTypeGet = inputTypeDescriptor.get;
    const nativeTextAreaValueGet = textAreaValueDescriptor.get;
    const nativeTextAreaValueSet = textAreaValueDescriptor.set;
    const nativeTextAreaReadOnlyGet = textAreaReadOnlyDescriptor.get;
    const nativeTextAreaDisabledGet = textAreaDisabledDescriptor.get;
    const nativeSelectMultipleGet = selectMultipleDescriptor.get;
    const nativeSelectDisabledGet = selectDisabledDescriptor.get;
    const nativeOptionSelectedGet = optionSelectedDescriptor.get;
    const nativeOptionSelectedSet = optionSelectedDescriptor.set;
    const nativeOptionValueGet = optionValueDescriptor.get;
    const nativeOptionDisabledGet = optionDisabledDescriptor.get;
    const limits = input.limits;
    type ProtectedWriterFieldType = (typeof limits.writableFieldTypes)[number];
    const classifyNativeWriterFieldType = [(
      control: Element,
      inputType: string | null,
      selectMultiple: boolean | null
    ): ProtectedWriterFieldType | null => {
      if (control instanceof NativeHTMLInputElement) {
        switch (inputType?.toLowerCase()) {
          case "text":
          case "search":
            return "TEXT";
          case "email":
            return "EMAIL";
          case "tel":
            return "TEL";
          case "url":
            return "URL";
          default:
            return null;
        }
      }
      if (control instanceof NativeHTMLTextAreaElement) return "TEXTAREA";
      if (control instanceof NativeHTMLSelectElement && selectMultiple === false) return "SELECT_ONE";
      return null;
    }][0];
    // One document plus the existing form/field/choice capacity: 1,205 total
    // roots. This shared retention budget does not add shadow control support.
    const maxObservationRoots = 1 + limits.maxForms + limits.maxFieldsTotal + limits.maxChoicesTotal;
    const methodNames = nativeFreeze([...input.methods]);
    const errorCodes = nativeFreeze([
      "FORM_STRUCTURE_UNSUPPORTED",
      "FORM_INSPECTION_OVERSIZE",
      "FORM_INSPECTION_INVALID",
      "EMPLOYER_AUTH_REQUIRED_UNSUPPORTED"
    ]);
    type ErrorCode =
      | "FORM_STRUCTURE_UNSUPPORTED"
      | "FORM_INSPECTION_OVERSIZE"
      | "FORM_INSPECTION_INVALID"
      | "EMPLOYER_AUTH_REQUIRED_UNSUPPORTED";
    type WorkBudget = { remaining: number };
    type OperationContext = {
      work: WorkBudget;
      roleTokens: WeakMap<Element, readonly string[]>;
      customElementNames: WeakMap<Element, boolean>;
      stylesheetRelationships: WeakMap<HTMLLinkElement, boolean>;
      contentEditableStates: WeakMap<HTMLElement, boolean>;
    };
    const safeErrorPrefix = "__APPLY_PILOT_SAFE_FORM_INSPECTION__";
    const workErrorMessage = safeErrorPrefix + "WORK_BUDGET_EXHAUSTED";
    const fail = [(code: ErrorCode): never => {
      throw new NativeError(safeErrorPrefix + code);
    }][0];
    const operationContext = [(): OperationContext => ({
      work: { remaining: limits.operationWorkLimit },
      roleTokens: new WeakMap<Element, readonly string[]>(),
      customElementNames: new WeakMap<Element, boolean>(),
      stylesheetRelationships: new WeakMap<HTMLLinkElement, boolean>(),
      contentEditableStates: new WeakMap<HTMLElement, boolean>()
    })][0];
    const charge = [(context: OperationContext, amount = 1): void => {
      if (!Number.isSafeInteger(amount) || amount < 0 || context.work.remaining < amount) {
        throw new NativeError(workErrorMessage);
      }
      context.work.remaining -= amount;
    }][0];
    const chargeString = [(context: OperationContext, value: string): void => {
      charge(context, value.length);
    }][0];
    const isWorkExhaustion = [(error: unknown): boolean =>
      error instanceof NativeError && error.message.includes(workErrorMessage)
    ][0];
    const roleEncoder = new TextEncoder();
    const emptyRoleTokens = nativeFreeze([] as string[]);
    const roleTokens = [(context: OperationContext, element: Element): readonly string[] => {
      const cached = context.roleTokens.get(element);
      if (cached) return cached;
      const raw = element.getAttribute("role");
      if (raw === null) {
        context.roleTokens.set(element, emptyRoleTokens);
        return emptyRoleTokens;
      }
      if (raw.length > 4_096 || roleEncoder.encode(raw).byteLength > 4_096) {
        fail("FORM_INSPECTION_OVERSIZE");
      }
      const parsed: string[] = [];
      for (const token of raw.trim().toLowerCase().split(/\s+/u)) {
        if (!token) continue;
        charge(context);
        parsed.push(token);
      }
      const frozen = nativeFreeze(parsed);
      context.roleTokens.set(element, frozen);
      return frozen;
    }][0];
    const hasRole = [(context: OperationContext, element: Element, role: string): boolean =>
      roleTokens(context, element).includes(role)
    ][0];
    const composedParent = [(node: Node): Node | null | false => {
      const assignedSlot = (node as Node & { assignedSlot?: HTMLSlotElement | null }).assignedSlot;
      if (assignedSlot) return assignedSlot;
      const parent = node.parentNode;
      if (!(parent instanceof NativeShadowRoot)) return parent;
      return parent.mode === "open" ? parent.host : false;
    }][0];
    const applicantCurrentTextRoles = new Set(["combobox", "searchbox", "textbox"]);
    const hasCustomElementName = [(context: OperationContext, element: Element): boolean => {
      const cached = context.customElementNames.get(element);
      if (cached !== undefined) return cached;
      const localName = element.localName;
      chargeString(context, localName);
      const result = localName.includes("-");
      context.customElementNames.set(element, result);
      return result;
    }][0];
    const hasInaccessibleCustomComposition = [(
      context: OperationContext,
      element: Element
    ): boolean => hasCustomElementName(context, element) && element.shadowRoot === null][0];
    const meteredContentEditable = [(
      context: OperationContext,
      element: HTMLElement
    ): boolean => {
      const cached = context.contentEditableStates.get(element);
      if (cached !== undefined) return cached;
      let current: Node | null | false = element;
      while (current && current !== document) {
        charge(context);
        current = composedParent(current);
      }
      const result = element.isContentEditable;
      context.contentEditableStates.set(element, result);
      return result;
    }][0];
    const meteredNativeLabelControl = [(
      context: OperationContext,
      label: HTMLLabelElement
    ): HTMLElement | null => {
      const explicitFor = label.getAttribute("for");
      if (explicitFor !== null) {
        chargeString(context, explicitFor);
      } else {
        const walker = document.createTreeWalker(label, NodeFilter.SHOW_ALL);
        for (let current = walker.nextNode(); current; current = walker.nextNode()) {
          charge(context);
        }
      }
      return label.control;
    }][0];
    const isApplicantCurrentContent = [(
      context: OperationContext,
      node: Node,
      nativeOptionLabelRoot: HTMLOptionElement | null,
      nativeOptionOwner: HTMLSelectElement | null
    ): boolean => {
      let current: Node | null | false = node;
      while (current && current !== document) {
        charge(context);
        if (current instanceof NativeElement) {
          if (current instanceof HTMLInputElement || current instanceof HTMLTextAreaElement) return true;
          if (current instanceof HTMLSelectElement) {
            if (nativeOptionLabelRoot !== null && current === nativeOptionOwner) {
              current = composedParent(current);
              continue;
            }
            return true;
          }
          if (current instanceof HTMLElement && meteredContentEditable(context, current)) return true;
          for (const role of roleTokens(context, current)) {
            if (applicantCurrentTextRoles.has(role)) return true;
          }
          if (hasInaccessibleCustomComposition(context, current)) return true;
        }
        const assignedSlot = (current as Node & { assignedSlot?: HTMLSlotElement | null }).assignedSlot;
        const parent = current.parentNode;
        if (
          !assignedSlot &&
          parent instanceof NativeElement &&
          (parent.shadowRoot !== null || hasInaccessibleCustomComposition(context, parent))
        ) {
          return true;
        }
        current = composedParent(current);
      }
      // A connected document ancestry is the only composition we can prove.
      return current !== document;
    }][0];
    const extractGraph = [(context: OperationContext) => {
      type TextLimit = Readonly<{ codePoints: number; utf8Bytes: number }>;
      type RawChoice = { label: string; disabled: boolean };
      type RawConstraints = {
        minLength: number | null;
        maxLength: number | null;
        min: string | null;
        max: string | null;
        step: string | null;
        acceptedFileTypes: Array<"PDF" | "DOC" | "DOCX" | "RTF" | "TXT">;
        multiple: boolean;
      };
      type RawField = {
        question: string | null;
        helpText: string | null;
        fieldType: string;
        unsupportedReason: string | null;
        required: boolean;
        autocomplete: string | null;
        constraints: RawConstraints;
        choices: RawChoice[];
      };
      type FieldSource = {
        field: RawField;
        control: Element;
        choices: Element[];
        section: HTMLFieldSetElement | null;
      };

      const encoder = new TextEncoder();
      const semanticReferenceIds = new Set<string>();
      const nativeLabelControls = new Set<Element>();
      const nativeLabels = new Set<HTMLLabelElement>();
      const documentLabels: HTMLLabelElement[] = [];
      const exceedsCodePointLimit = [(value: string, maximum: number): boolean => {
        let count = 0;
        for (let offset = 0; offset < value.length;) {
          const codePoint = value.codePointAt(offset);
          offset += codePoint !== undefined && codePoint > 0xFFFF ? 2 : 1;
          count += 1;
          if (count > maximum) return true;
        }
        return false;
      }][0];
      const assertBounded = [(value: string, limit: TextLimit): string => {
        if (exceedsCodePointLimit(value, limit.codePoints) || encoder.encode(value).byteLength > limit.utf8Bytes) {
          fail("FORM_INSPECTION_OVERSIZE");
        }
        return value;
      }][0];
      const boundedAttribute = [(element: Element, name: string, limit: TextLimit): string | null => {
        const value = element.getAttribute(name);
        if (value === null) return null;
        const trimmed = assertBounded(value, limit).trim();
        return trimmed.length > 0 ? trimmed : null;
      }][0];
      const boundedElementText = [(element: Element, limit: TextLimit): string | null => {
        const nativeOptionLabelRoot = element instanceof HTMLOptionElement ? element : null;
        let nativeOptionOwner: HTMLSelectElement | null = null;
        if (nativeOptionLabelRoot) {
          for (let current = nativeOptionLabelRoot.parentElement; current; current = current.parentElement) {
            charge(context);
            if (current instanceof HTMLSelectElement) {
              nativeOptionOwner = current;
              break;
            }
          }
        }
        if (isApplicantCurrentContent(context, element, nativeOptionLabelRoot, nativeOptionOwner)) return null;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_ALL);
        let value = "";
        let codePoints = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          charge(context);
          if (node.nodeType !== 3) continue;
          const parent = node.parentElement;
          let excluded = false;
          for (let current = parent; current; current = current.parentElement) {
            charge(context);
            if (current.matches("script,style,template")) {
              excluded = true;
              break;
            }
            if (current === element) break;
          }
          if (excluded) continue;
          if (isApplicantCurrentContent(context, node, nativeOptionLabelRoot, nativeOptionOwner)) continue;
          const part = node.nodeValue ?? "";
          for (let offset = 0; offset < part.length;) {
            const codePoint = part.codePointAt(offset);
            offset += codePoint !== undefined && codePoint > 0xFFFF ? 2 : 1;
            codePoints += 1;
            if (codePoints > limit.codePoints) fail("FORM_INSPECTION_OVERSIZE");
          }
          value += part;
          if (encoder.encode(value).byteLength > limit.utf8Bytes) fail("FORM_INSPECTION_OVERSIZE");
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : null;
      }][0];
      const appendJoinedText = [(current: string | null, next: string | null, limit: TextLimit): string | null => {
        if (next === null) return current;
        return assertBounded(current === null ? next : `${current} ${next}`, limit);
      }][0];
      const ariaReferencedText = [(element: Element, attribute: string, limit: TextLimit): string | null => {
        const raw = element.getAttribute(attribute);
        if (!raw) return null;
        const ids = assertBounded(raw, limit).trim().split(/\s+/u);
        let joined: string | null = null;
        for (const id of ids) {
          if (!id) continue;
          charge(context);
          chargeString(context, id);
          semanticReferenceIds.add(id);
          chargeString(context, id);
          const target = document.getElementById(id);
          joined = appendJoinedText(joined, target ? boundedElementText(target, limit) : null, limit);
        }
        return joined;
      }][0];
      const directLegend = [(fieldset: HTMLFieldSetElement | null): HTMLLegendElement | null => {
        if (!fieldset) return null;
        for (const child of fieldset.children) {
          charge(context);
          if (child instanceof HTMLLegendElement) return child;
        }
        return null;
      }][0];
      const nearestSection = [(control: Element, form: HTMLFormElement): HTMLFieldSetElement | null => {
        let current = control.parentElement;
        while (current) {
          charge(context);
          if (current instanceof HTMLFieldSetElement) return current.form === form ? current : null;
          if (current === form) return null;
          current = current.parentElement;
        }
        return null;
      }][0];
      const semanticGroup = [(control: Element): Element | null => {
        let current: Node | null | false = control;
        while (current && current !== document) {
          charge(context);
          if (
            current instanceof NativeElement &&
            (hasRole(context, current, "group") || hasRole(context, current, "radiogroup"))
          ) return current;
          current = composedParent(current);
        }
        return null;
      }][0];
      const groupBoundary = [(control: Element, form: HTMLFormElement): Element | null =>
        nearestSection(control, form) ?? semanticGroup(control)][0];

      const isVisible = [(element: Element): boolean => {
        if (!element.isConnected) return false;
        let current: Node | null | false = element;
        while (current && current !== document) {
          charge(context);
          if (!(current instanceof NativeElement)) {
            current = composedParent(current);
            continue;
          }
          if (current.hasAttribute("hidden") || current.hasAttribute("inert")) return false;
          const style = getComputedStyle(current);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            Number.parseFloat(style.opacity) === 0
          ) return false;
          current = composedParent(current);
        }
        if (current !== document) return false;
        return element.getClientRects().length > 0;
      }][0];
      const isEffectivelyDisabled = [(element: Element): boolean => element.matches(":disabled")][0];
      const inputKind = [(input: HTMLInputElement): string => input.type.toLowerCase()][0];
      const groupingName = [(input: HTMLInputElement): string => {
        const value = input.getAttribute("name") ?? "";
        chargeString(context, value);
        return value;
      }][0];
      const isIgnoredInput = [(input: HTMLInputElement): boolean =>
        ["hidden", "submit", "button", "reset", "image"].includes(inputKind(input))][0];
      const isNativeControl = [(element: Element): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
        element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement][0];
      const isQuestionLikeNative = [(element: Element): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
        isNativeControl(element) && !(element instanceof HTMLInputElement && isIgnoredInput(element))][0];
      const visitElements = [(
        root: Document | Element | ShadowRoot,
        includeRoot: boolean,
        visit: (element: Element) => void
      ): void => {
        if (includeRoot && root instanceof Element) {
          charge(context);
          visit(root);
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          charge(context);
          if (node instanceof Element) visit(node);
        }
      }][0];
      const obviousInteractionRoles = new Set([
        "button", "checkbox", "combobox", "link", "radio", "textbox",
        "searchbox", "spinbutton", "slider", "listbox", "switch"
      ]);
      const isObviousInteraction = [(element: Element): boolean => {
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLButtonElement ||
          (element instanceof HTMLAnchorElement && element.hasAttribute("href"))
        ) return true;
        if (element instanceof HTMLElement && meteredContentEditable(context, element)) return true;
        for (const role of roleTokens(context, element)) {
          if (obviousInteractionRoles.has(role)) return true;
        }
        return element instanceof HTMLElement && element.tabIndex >= 0;
      }][0];
      const isOrdinaryFormAction = [(element: Element): boolean => {
        const roles = roleTokens(context, element);
        const recognized = roles.filter((role) => obviousInteractionRoles.has(role));
        return (
          (element instanceof HTMLButtonElement && (recognized.length === 0 ||
            (recognized.length === 1 && recognized[0] === "button"))) ||
          (element instanceof HTMLAnchorElement && element.hasAttribute("href") && (recognized.length === 0 ||
            (recognized.length === 1 && recognized[0] === "link")))
        );
      }][0];
      const isPassiveInheritedRichTextNode = [(
        element: Element,
        richTextRoot: HTMLElement | null
      ): boolean => {
        if (
          richTextRoot === null ||
          element === richTextRoot ||
          !(element instanceof HTMLElement) ||
          !meteredContentEditable(context, element) ||
          element.hasAttribute("contenteditable") ||
          roleTokens(context, element).length > 0 ||
          element.tabIndex >= 0 ||
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLButtonElement ||
          element instanceof HTMLIFrameElement ||
          (element instanceof HTMLAnchorElement && element.hasAttribute("href"))
        ) return false;
        return true;
      }][0];
      const isRelevantCustomHost = [(element: Element): boolean => {
        if (!hasCustomElementName(context, element)) return false;
        const roles = roleTokens(context, element);
        return (
          "form" in element ||
          roles.some((role) => obviousInteractionRoles.has(role) || role === "group" || role === "radiogroup") ||
          (element instanceof HTMLElement && (meteredContentEditable(context, element) || element.tabIndex >= 0)) ||
          ["aria-label", "aria-labelledby", "aria-describedby", "form", "name", "required"]
            .some((attribute) => element.hasAttribute(attribute))
        );
      }][0];
      const containsStrictInteraction = [(
        root: Element | ShadowRoot,
        richTextRoot: HTMLElement | null = null
      ): boolean => {
        const roots = new Set<Element | ShadowRoot>([root]);
        for (const currentRoot of roots) {
          charge(context);
          const walker = document.createTreeWalker(currentRoot, NodeFilter.SHOW_ALL);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            charge(context);
            if (!(node instanceof Element)) continue;
            if (node.shadowRoot && !roots.has(node.shadowRoot)) {
              if (roots.size >= maxObservationRoots) fail("FORM_INSPECTION_OVERSIZE");
              charge(context);
              roots.add(node.shadowRoot);
            }
            if (!isVisible(node)) continue;
            if (isRelevantCustomHost(node) && node.shadowRoot === null) return true;
            if (isPassiveInheritedRichTextNode(node, richTextRoot)) continue;
            if (node instanceof HTMLIFrameElement || isObviousInteraction(node)) return true;
          }
        }
        return false;
      }][0];
      const assertInspectableCustomElement = [(element: Element): void => {
        const shadow = element.shadowRoot;
        if (shadow && containsStrictInteraction(shadow)) fail("FORM_STRUCTURE_UNSUPPORTED");
        if (isRelevantCustomHost(element) && shadow === null) {
          fail("FORM_STRUCTURE_UNSUPPORTED");
        }
      }][0];

      const wrappingLabel = [(control: Element): HTMLLabelElement | null => {
        for (let current = control.parentElement; current; current = current.parentElement) {
          charge(context);
          if (current instanceof HTMLLabelElement) {
            return meteredNativeLabelControl(context, current) === control ? current : null;
          }
        }
        return null;
      }][0];
      const questionFor = [(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string | null => {
        nativeLabelControls.add(control);
        let explicit: string | null = null;
        for (const label of documentLabels) {
          charge(context);
          if (label.hasAttribute("for") && meteredNativeLabelControl(context, label) === control) {
            nativeLabels.add(label);
            explicit = appendJoinedText(
              explicit,
              boundedElementText(label, limits.text.question),
              limits.text.question
            );
          }
        }
        if (explicit) return explicit;
        const wrapper = wrappingLabel(control);
        if (wrapper) {
          nativeLabels.add(wrapper);
          const text = boundedElementText(wrapper, limits.text.question);
          if (text) return text;
        }
        return ariaReferencedText(control, "aria-labelledby", limits.text.question) ??
          boundedAttribute(control, "aria-label", limits.text.question);
      }][0];
      const questionForCustom = [(control: Element): string | null =>
        ariaReferencedText(control, "aria-labelledby", limits.text.question) ??
        boundedAttribute(control, "aria-label", limits.text.question)][0];
      const helpFor = [(control: Element): string | null =>
        ariaReferencedText(control, "aria-describedby", limits.text.helpText)][0];
      const formTitle = [(form: HTMLFormElement): string | null =>
        ariaReferencedText(form, "aria-labelledby", limits.text.formOrSection) ??
        boundedAttribute(form, "aria-label", limits.text.formOrSection)][0];
      const groupQuestion = [(members: Element[], boundary: Element | null): string | null => {
        const nearestFieldset = [(member: Element): HTMLFieldSetElement | null => {
          for (let current = member.parentElement; current; current = current.parentElement) {
            charge(context);
            if (current instanceof HTMLFieldSetElement) return current;
          }
          return null;
        }][0];
        const section = nearestFieldset(members[0]);
        let sameSection = section !== null;
        for (const member of members) {
          charge(context);
          if (nearestFieldset(member) !== section) sameSection = false;
        }
        if (section instanceof HTMLFieldSetElement && sameSection) {
          const legend = directLegend(section);
          const legendText = legend ? boundedElementText(legend, limits.text.question) : null;
          if (legendText) return legendText;
        }
        const roleGroup = semanticGroup(members[0]);
        let sameRoleGroup = roleGroup !== null;
        for (const member of members) {
          charge(context);
          if (semanticGroup(member) !== roleGroup) sameRoleGroup = false;
        }
        if (roleGroup && sameRoleGroup) {
          return ariaReferencedText(roleGroup, "aria-labelledby", limits.text.question) ??
            boundedAttribute(roleGroup, "aria-label", limits.text.question);
        }
        if (boundary && (hasRole(context, boundary, "group") || hasRole(context, boundary, "radiogroup"))) {
          return ariaReferencedText(boundary, "aria-labelledby", limits.text.question) ??
            boundedAttribute(boundary, "aria-label", limits.text.question);
        }
        return null;
      }][0];

      const emptyConstraints = [(): RawConstraints => ({
        minLength: null,
        maxLength: null,
        min: null,
        max: null,
        step: null,
        acceptedFileTypes: [],
        multiple: false
      })][0];
      const unsupportedField = [(
        question: string | null,
        helpText: string | null,
        reason: "RICH_TEXT" | "CUSTOM_COMBOBOX" | "UNSUPPORTED_CONTROL",
        required: boolean
      ): RawField => ({
        question,
        helpText,
        fieldType: "UNSUPPORTED",
        unsupportedReason: reason,
        required,
        autocomplete: null,
        constraints: emptyConstraints(),
        choices: []
      })][0];
      const autocompleteFor = [(control: Element): string | null => {
        const raw = control.getAttribute("autocomplete");
        if (!raw) return null;
        chargeString(context, raw);
        const candidate = raw.trim().toLowerCase();
        return (limits.autocomplete as readonly string[]).includes(candidate) ? candidate : null;
      }][0];
      const lengthConstraints = [(control: HTMLInputElement | HTMLTextAreaElement): Pick<RawConstraints, "minLength" | "maxLength"> | null => {
        const minLength = control.minLength >= 0 ? control.minLength : null;
        const maxLength = control.maxLength >= 0 ? control.maxLength : null;
        if (
          (minLength !== null && minLength > 4_000) ||
          (maxLength !== null && maxLength > 4_000) ||
          (minLength !== null && maxLength !== null && minLength > maxLength)
        ) return null;
        return { minLength, maxLength };
      }][0];
      const constraintAttribute = [(control: Element, name: string): string | null => {
        const raw = control.getAttribute(name);
        if (raw === null || raw === "") return null;
        if (exceedsCodePointLimit(raw, 64) || encoder.encode(raw).byteLength > 256) {
          fail("FORM_STRUCTURE_UNSUPPORTED");
        }
        return raw;
      }][0];
      const acceptedFileTypes = [(control: HTMLInputElement): {
        accepted: RawConstraints["acceptedFileTypes"];
        unknown: boolean;
      } => {
        const mapping: Record<string, RawConstraints["acceptedFileTypes"][number]> = {
          ".pdf": "PDF",
          "application/pdf": "PDF",
          ".doc": "DOC",
          "application/msword": "DOC",
          ".docx": "DOCX",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
          ".rtf": "RTF",
          "application/rtf": "RTF",
          "text/rtf": "RTF",
          ".txt": "TXT",
          "text/plain": "TXT"
        };
        const raw = control.getAttribute("accept");
        if (!raw) return { accepted: [], unknown: false };
        if (raw.length > 4_096 || encoder.encode(raw).byteLength > 4_096) {
          fail("FORM_INSPECTION_OVERSIZE");
        }
        if (raw.trim() === "") return { accepted: [], unknown: false };
        const accepted: RawConstraints["acceptedFileTypes"] = [];
        let unknown = false;
        let tokenStart = 0;
        let tokenOversize = false;
        for (let index = 0; index <= raw.length; index += 1) {
          if (index < raw.length && raw[index] !== ",") {
            if (index - tokenStart >= 256) tokenOversize = true;
            continue;
          }
          const wasOversize = tokenOversize;
          const token = wasOversize ? "" : raw.slice(tokenStart, index)
            .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu, "").toLowerCase();
          tokenStart = index + 1;
          tokenOversize = false;
          if (wasOversize) unknown = true;
          if (!token) continue;
          charge(context);
          const category = mapping[token];
          if (!category) {
            unknown = true;
          } else if (!accepted.includes(category)) {
            accepted.push(category);
          }
        }
        return { accepted, unknown };
      }][0];
      const optionVisible = [(option: HTMLOptionElement): boolean => {
        const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
        if (option.hasAttribute("hidden") || group?.hasAttribute("hidden")) return false;
        const optionStyle = getComputedStyle(option);
        const groupStyle = group ? getComputedStyle(group) : null;
        return optionStyle.display !== "none" && optionStyle.visibility !== "hidden" &&
          optionStyle.visibility !== "collapse" && groupStyle?.display !== "none" &&
          groupStyle?.visibility !== "hidden" && groupStyle?.visibility !== "collapse";
      }][0];
      const optionLabel = [(option: HTMLOptionElement): string | null => {
        const explicit = boundedAttribute(option, "label", limits.text.choiceLabel);
        const own = explicit ?? boundedElementText(option, limits.text.choiceLabel);
        if (!own) return null;
        const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
        const groupLabel = group ? boundedAttribute(group, "label", limits.text.choiceLabel) : null;
        return groupLabel ? assertBounded(`${groupLabel}: ${own}`, limits.text.choiceLabel) : own;
      }][0];

      const nativeByForm = new Map<HTMLFormElement, Array<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>>();
      const documentElements: Element[] = [];
      let retainedNativeControls = 0;
      visitElements(document, false, (element) => {
        documentElements.push(element);
        if (element instanceof HTMLLabelElement) documentLabels.push(element);
        if (!isQuestionLikeNative(element) || !isVisible(element)) return;
        if (element instanceof HTMLInputElement && inputKind(element) === "password") {
          fail("EMPLOYER_AUTH_REQUIRED_UNSUPPORTED");
        }
        const kind = element instanceof HTMLInputElement ? inputKind(element) : "";
        // Human-Submit MVP: an initially effectively disabled text/select
        // control remains outside the candidate. Radio/checkbox members stay
        // only so their grouped inspection semantics remain truthful.
        const canContribute = !isEffectivelyDisabled(element) || kind === "radio" || kind === "checkbox";
        if (element.form === null) {
          if (canContribute) fail("FORM_STRUCTURE_UNSUPPORTED");
          return;
        }
        if (!canContribute) return;
        retainedNativeControls += 1;
        if (retainedNativeControls > limits.maxFieldsTotal + limits.maxChoicesTotal) {
          fail("FORM_INSPECTION_OVERSIZE");
        }
        let controls = nativeByForm.get(element.form);
        if (!controls) {
          if (nativeByForm.size >= limits.maxForms) fail("FORM_INSPECTION_OVERSIZE");
          controls = [];
          nativeByForm.set(element.form, controls);
        }
        controls.push(element);
      });

      let totalFields = 0;
      let totalChoices = 0;
      const reportForms: Array<{ title: string | null; sections: Array<{ heading: string | null; fields: RawField[] }> }> = [];
      const referenceForms: Array<{
        form: HTMLFormElement;
        sections: Array<{ fields: Array<{ control: Element; choices: Element[] }> }>;
      }> = [];

      const forms: HTMLFormElement[] = [];
      for (const form of document.forms) {
        charge(context);
        forms.push(form);
        for (const member of form.elements) {
          charge(context);
          if (
            member instanceof NativeElement &&
            hasCustomElementName(context, member) &&
            !isNativeControl(member)
          ) fail("FORM_STRUCTURE_UNSUPPORTED");
        }
      }

      for (const form of forms) {
        charge(context);
        const nativeControls = nativeByForm.get(form) ?? [];
        const nativeControlSet = new Set<Element>(nativeControls);
        const representableCustom = new Set<Element>();
        visitElements(form, false, (candidate) => {
          if (isNativeControl(candidate) || !isVisible(candidate)) return;
          const recognizedRoles = roleTokens(context, candidate)
            .filter((role) => obviousInteractionRoles.has(role));
          if (recognizedRoles.length > 1) fail("FORM_STRUCTURE_UNSUPPORTED");
          const isCombobox = recognizedRoles.length === 1 && recognizedRoles[0] === "combobox";
          let inheritsEditable = false;
          for (let current = candidate.parentElement; current; current = current.parentElement) {
            charge(context);
            if (current instanceof HTMLElement && meteredContentEditable(context, current)) {
              inheritsEditable = true;
              break;
            }
            if (current === form) break;
          }
          const isRichText =
            candidate instanceof HTMLElement &&
            meteredContentEditable(context, candidate) &&
            !inheritsEditable;
          if (!isCombobox && !isRichText) return;
          if (containsStrictInteraction(candidate, isRichText ? candidate : null)) {
            fail("FORM_STRUCTURE_UNSUPPORTED");
          }
          assertInspectableCustomElement(candidate);
          if (!questionForCustom(candidate)) fail("FORM_STRUCTURE_UNSUPPORTED");
          if (representableCustom.size >= limits.maxFieldsTotal) fail("FORM_INSPECTION_OVERSIZE");
          representableCustom.add(candidate);
        });

        const visibleRadios: HTMLInputElement[] = [];
        const visibleCheckboxes: HTMLInputElement[] = [];
        for (const control of nativeControls) {
          charge(context);
          if (!(control instanceof HTMLInputElement)) continue;
          const kind = inputKind(control);
          if (kind === "radio") visibleRadios.push(control);
          if (kind === "checkbox") visibleCheckboxes.push(control);
        }

        const consumed = new Set<Element>();
        const completenessRoots = new Set<Element>([form]);
        const sectionOrder: Array<HTMLFieldSetElement | null> = [];
        const sectionFields = new Map<HTMLFieldSetElement | null, FieldSource[]>();
        let formFieldCount = 0;
        const addCompletenessRoot = [(boundary: Element | null): void => {
          if (!boundary) return;
          let current: Element | null = boundary;
          while (current) {
            charge(context);
            if (current === form) return;
            current = current.parentElement;
          }
          completenessRoots.add(boundary);
        }][0];
        const addField = [(source: FieldSource): void => {
          if (totalFields >= limits.maxFieldsTotal) fail("FORM_INSPECTION_OVERSIZE");
          let sources = sectionFields.get(source.section);
          if (!sources) {
            if (sectionFields.size >= limits.maxSectionsPerForm) fail("FORM_INSPECTION_OVERSIZE");
            sources = [];
            sectionFields.set(source.section, sources);
            sectionOrder.push(source.section);
          }
          totalFields += 1;
          formFieldCount += 1;
          sources.push(source);
        }][0];
        const commitChoices = [(count: number): void => {
          if (count > limits.maxChoicesPerField || totalChoices > limits.maxChoicesTotal - count) {
            fail("FORM_INSPECTION_OVERSIZE");
          }
          totalChoices += count;
        }][0];

        for (const source of documentElements) {
          charge(context);
          const includedNative = isNativeControl(source) && nativeControlSet.has(source);
          const includedCustom = representableCustom.has(source);
          if (!includedNative && !includedCustom) continue;
          if (consumed.has(source)) continue;
          if (!isNativeControl(source)) {
            const field = unsupportedField(
              questionForCustom(source),
              helpFor(source),
              source instanceof HTMLElement && meteredContentEditable(context, source) ? "RICH_TEXT" : "CUSTOM_COMBOBOX",
              source.hasAttribute("required")
            );
            completenessRoots.add(source);
            addField({ field, control: source, choices: [], section: nearestSection(source, form) });
            continue;
          }

          if (source instanceof HTMLInputElement && inputKind(source) === "radio") {
            const name = groupingName(source);
            if (!name) fail("FORM_STRUCTURE_UNSUPPORTED");
            const boundary = groupBoundary(source, form);
            if (!boundary) fail("FORM_STRUCTURE_UNSUPPORTED");
            const sameName: HTMLInputElement[] = [];
            for (const member of visibleRadios) {
              charge(context);
              if (groupingName(member) !== name) continue;
              if (groupBoundary(member, form) !== boundary) fail("FORM_STRUCTURE_UNSUPPORTED");
              if (sameName.length >= limits.maxChoicesPerField) fail("FORM_INSPECTION_OVERSIZE");
              sameName.push(member);
            }
            for (const member of sameName) {
              charge(context);
              consumed.add(member);
            }
            let hasEnabledRadio = false;
            for (const member of sameName) {
              charge(context);
              if (!isEffectivelyDisabled(member)) hasEnabledRadio = true;
            }
            if (!hasEnabledRadio) continue;
            const question = groupQuestion(sameName, boundary);
            if (!question) fail("FORM_STRUCTURE_UNSUPPORTED");
            const choices: RawChoice[] = [];
            for (const member of sameName) {
              charge(context);
              const label = questionFor(member);
              if (!label) fail("FORM_STRUCTURE_UNSUPPORTED");
              choices.push({ label: label as string, disabled: isEffectivelyDisabled(member) });
            }
            commitChoices(choices.length);
            addCompletenessRoot(boundary);
            let required = false;
            for (const member of sameName) {
              charge(context);
              if (!isEffectivelyDisabled(member) && member.hasAttribute("required")) required = true;
            }
            addField({
              field: {
                question: question as string,
                helpText: helpFor(boundary as Element),
                fieldType: "RADIO_GROUP",
                unsupportedReason: null,
                required,
                autocomplete: null,
                constraints: emptyConstraints(),
                choices
              },
              control: source,
              choices: sameName,
              section: nearestSection(source, form)
            });
            continue;
          }

          if (source instanceof HTMLInputElement && inputKind(source) === "checkbox") {
            const name = groupingName(source);
            const boundary = groupBoundary(source, form);
            const sameGroup: HTMLInputElement[] = [];
            if (name) {
              for (const member of visibleCheckboxes) {
                charge(context);
                if (
                  groupingName(member) !== name ||
                  groupBoundary(member, form) !== boundary
                ) continue;
                if (sameGroup.length >= limits.maxChoicesPerField) fail("FORM_INSPECTION_OVERSIZE");
                sameGroup.push(member);
              }
            }
            let hasActiveMember = false;
            for (const member of sameGroup) {
              charge(context);
              if (!isEffectivelyDisabled(member)) hasActiveMember = true;
            }
            const groupTitle = sameGroup.length >= 2 ? groupQuestion(sameGroup, boundary) : null;
            if (sameGroup.length >= 2 && hasActiveMember && groupTitle) {
              const required = sameGroup[0].hasAttribute("required");
              for (const member of sameGroup) {
                charge(context);
                if (member.hasAttribute("required") !== required) {
                  fail("FORM_STRUCTURE_UNSUPPORTED");
                }
              }
              for (const member of sameGroup) {
                charge(context);
                consumed.add(member);
              }
              const choices: RawChoice[] = [];
              for (const member of sameGroup) {
                charge(context);
                const label = questionFor(member);
                if (!label) fail("FORM_STRUCTURE_UNSUPPORTED");
                choices.push({ label: label as string, disabled: isEffectivelyDisabled(member) });
              }
              commitChoices(choices.length);
              addCompletenessRoot(boundary);
              addField({
                field: {
                  question: groupTitle,
                  helpText: helpFor(boundary ?? source),
                  fieldType: "CHECKBOX_GROUP",
                  unsupportedReason: null,
                  required,
                  autocomplete: null,
                  constraints: emptyConstraints(),
                  choices
                },
                control: source,
                choices: sameGroup,
                section: nearestSection(source, form)
              });
              continue;
            }
            if (isEffectivelyDisabled(source)) continue;
            addField({
              field: {
                question: questionFor(source),
                helpText: helpFor(source),
                fieldType: "CHECKBOX_BOOLEAN",
                unsupportedReason: null,
                required: source.hasAttribute("required"),
                autocomplete: autocompleteFor(source),
                constraints: emptyConstraints(),
                choices: []
              },
              control: source,
              choices: [],
              section: nearestSection(source, form)
            });
            continue;
          }

          const question = questionFor(source);
          const helpText = helpFor(source);
          const required = source.hasAttribute("required");
          const autocomplete = autocompleteFor(source);
          const section = nearestSection(source, form);

          if (source instanceof HTMLSelectElement) {
            const writerFieldType = classifyNativeWriterFieldType(source, null, source.multiple);
            const rawChoices: RawChoice[] = [];
            const choiceElements: Element[] = [];
            let invalidChoice = false;
            for (const option of source.options) {
              charge(context);
              if (!optionVisible(option)) continue;
              const label = optionLabel(option);
              if (!label) {
                invalidChoice = true;
                break;
              }
              const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
              if (rawChoices.length >= limits.maxChoicesPerField) fail("FORM_INSPECTION_OVERSIZE");
              rawChoices.push({ label, disabled: isEffectivelyDisabled(option) || Boolean(group?.disabled) });
              choiceElements.push(option);
            }
            if (invalidChoice || rawChoices.length === 0) {
              addField({
                field: unsupportedField(question, helpText, "UNSUPPORTED_CONTROL", required),
                control: source,
                choices: [],
                section
              });
            } else {
              commitChoices(rawChoices.length);
              addField({
                field: {
                  question,
                  helpText,
                  fieldType: writerFieldType ?? "SELECT_MANY",
                  unsupportedReason: null,
                  required,
                  autocomplete,
                  constraints: emptyConstraints(),
                  choices: rawChoices
                },
                control: source,
                choices: choiceElements,
                section
              });
            }
            continue;
          }

          if (source instanceof HTMLTextAreaElement) {
            const writerFieldType = classifyNativeWriterFieldType(source, null, null);
            if (writerFieldType !== "TEXTAREA") return fail("FORM_INSPECTION_INVALID");
            const lengths = lengthConstraints(source);
            const field: RawField = lengths ? {
              question,
              helpText,
              fieldType: writerFieldType,
              unsupportedReason: null,
              required,
              autocomplete,
              constraints: { ...emptyConstraints(), ...lengths },
              choices: []
            } : unsupportedField(question, helpText, "UNSUPPORTED_CONTROL", required);
            addField({ field, control: source, choices: [], section });
            continue;
          }

          const kind = inputKind(source);
          const writerFieldType = classifyNativeWriterFieldType(source, kind, null);
          if (writerFieldType !== null) {
            const lengths = lengthConstraints(source);
            const field: RawField = lengths ? {
              question,
              helpText,
              fieldType: writerFieldType,
              unsupportedReason: null,
              required,
              autocomplete,
              constraints: { ...emptyConstraints(), ...lengths },
              choices: []
            } : unsupportedField(question, helpText, "UNSUPPORTED_CONTROL", required);
            addField({ field, control: source, choices: [], section });
          } else if (kind === "number" || kind === "date") {
            addField({
              field: {
                question,
                helpText,
                fieldType: kind.toUpperCase(),
                unsupportedReason: null,
                required,
                autocomplete,
                constraints: {
                  ...emptyConstraints(),
                  min: constraintAttribute(source, "min"),
                  max: constraintAttribute(source, "max"),
                  step: constraintAttribute(source, "step")
                },
                choices: []
              },
              control: source,
              choices: [],
              section
            });
          } else if (kind === "file") {
            const restrictions = acceptedFileTypes(source);
            const multiple = source.hasAttribute("multiple");
            if (multiple && restrictions.unknown) fail("FORM_STRUCTURE_UNSUPPORTED");
            const field = restrictions.unknown ? unsupportedField(
              question, helpText, "UNSUPPORTED_CONTROL", required
            ) : {
              question,
              helpText,
              fieldType: "FILE_UPLOAD",
              unsupportedReason: null,
              required,
              autocomplete,
              constraints: { ...emptyConstraints(), acceptedFileTypes: restrictions.accepted, multiple },
              choices: []
            };
            addField({ field, control: source, choices: [], section });
          } else {
            addField({
              field: unsupportedField(question, helpText, "UNSUPPORTED_CONTROL", required),
              control: source,
              choices: [],
              section
            });
          }
        }

        for (const root of completenessRoots) {
          charge(context);
          visitElements(root, true, (element) => {
            if (!isVisible(element)) return;
            if (element instanceof HTMLIFrameElement) fail("FORM_STRUCTURE_UNSUPPORTED");
            if (isNativeControl(element)) return;
            if (representableCustom.has(element)) return;
            let representedRichTextAncestor: HTMLElement | null = null;
            for (let current = element.parentElement; current; current = current.parentElement) {
              charge(context);
              if (
                current instanceof HTMLElement &&
                meteredContentEditable(context, current) &&
                representableCustom.has(current)
              ) {
                representedRichTextAncestor = current;
                break;
              }
              if (current === form) break;
            }
            if (isPassiveInheritedRichTextNode(element, representedRichTextAncestor)) return;
            assertInspectableCustomElement(element);
            if (isObviousInteraction(element) && !isOrdinaryFormAction(element)) {
              fail("FORM_STRUCTURE_UNSUPPORTED");
            }
          });
        }

        if (formFieldCount === 0) continue;
        if (reportForms.length >= limits.maxForms) fail("FORM_INSPECTION_OVERSIZE");

        const reportSections: Array<{ heading: string | null; fields: RawField[] }> = [];
        const referenceSections: Array<{ fields: Array<{ control: Element; choices: Element[] }> }> = [];
        for (const section of sectionOrder) {
          charge(context);
          const sources = sectionFields.get(section) ?? [];
          const legend = directLegend(section);
          const reportFields: RawField[] = [];
          const referenceFields: Array<{ control: Element; choices: Element[] }> = [];
          for (const source of sources) {
            charge(context);
            reportFields.push(source.field);
            referenceFields.push({ control: source.control, choices: source.choices });
          }
          reportSections.push({
            heading: legend ? boundedElementText(legend, limits.text.formOrSection) : null,
            fields: reportFields
          });
          referenceSections.push({
            fields: referenceFields
          });
        }
        reportForms.push({ title: formTitle(form), sections: reportSections });
        referenceForms.push({ form, sections: referenceSections });
      }

      if (reportForms.length === 0) fail("FORM_STRUCTURE_UNSUPPORTED");
      const retainedSemanticReferenceIds: string[] = [];
      for (const id of semanticReferenceIds) {
        charge(context);
        retainedSemanticReferenceIds.push(id);
      }
      const retainedLabelControls: Element[] = [];
      for (const control of nativeLabelControls) {
        charge(context);
        retainedLabelControls.push(control);
      }
      const retainedLabels: HTMLLabelElement[] = [];
      for (const label of nativeLabels) {
        charge(context);
        retainedLabels.push(label);
      }
      return {
        report: { schemaVersion: limits.schemaVersion, forms: reportForms },
        references: {
          forms: referenceForms,
          semanticReferenceIds: retainedSemanticReferenceIds,
          nativeLabelControls: retainedLabelControls,
          nativeLabels: retainedLabels
        }
      };
    }][0];

    type ExtractedGraph = ReturnType<typeof extractGraph>;
    type FlatField = Readonly<{
      sourceOrdinal: Readonly<{ form: number; section: number; field: number }>;
      fieldType: string;
      ownerForm: HTMLFormElement;
      control: Element;
      choices: readonly Element[];
    }>;
    type SealedWriterChoice = Readonly<{
      choiceKey: string;
      sourceOrdinal: Readonly<{ form: number; section: number; field: number; choice: number }>;
      option: HTMLOptionElement;
    }>;
    type SealedWriterTarget = Readonly<{
      normalizedFieldKey: string;
      fieldFingerprint: string;
      fieldType: string;
      sourceOrdinal: Readonly<{ form: number; section: number; field: number }>;
      fieldIndex: number;
      control: Element;
      choices: readonly SealedWriterChoice[];
      choicesByKey: ReadonlyMap<string, SealedWriterChoice>;
    }>;
    type Candidate = Readonly<{
      id: number;
      reportCanonical: string;
      fields: readonly FlatField[];
      nodes: readonly Node[];
      ownerDocument: Document;
    }> & {
      semanticReferenceIds: readonly string[];
      nativeLabelControls: readonly Element[];
      nativeLabels: readonly HTMLLabelElement[];
      stickyDetached: boolean;
      writerTargets: ReadonlyMap<string, SealedWriterTarget> | null;
      writerEpoch: number | null;
    };
    type OwnedWriterEventWindow = {
      readonly target: EventTarget;
      readonly expected: readonly string[];
      index: number;
      unexpected: boolean;
    };

    let semanticRevision = 0;
    let applicantStateEpoch = 0;
    let disposed = false;
    let nextCandidateId = 1;
    let ownedWriterEventWindow: OwnedWriterEventWindow | null = null;
    const candidates = new Map<number, Candidate>();
    const waiters = new Set<{
      resolve(value: Readonly<{ semanticRevision: number; applicantStateEpoch: number }>): void;
      timer: ReturnType<typeof setTimeout>;
    }>();

    const plain = [(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> => {
      const value = nativeCreate(null) as Record<string, unknown>;
      for (const [key, item] of entries) {
        nativeDefineProperty(value, key, {
          configurable: true,
          enumerable: true,
          value: item,
          writable: true
        });
      }
      return value;
    }][0];
    const snapshotValue = [() => plain([
      ["semanticRevision", semanticRevision],
      ["applicantStateEpoch", applicantStateEpoch]
    ])][0];
    const wake = [() => {
      const value = snapshotValue();
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(value as Readonly<{ semanticRevision: number; applicantStateEpoch: number }>);
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
    const flattened = [(context: OperationContext, graph: ExtractedGraph): FlatField[] | null => {
      const fields: FlatField[] = [];
      if (graph.references.forms.length !== graph.report.forms.length) return null;
      for (let formIndex = 0; formIndex < graph.report.forms.length; formIndex += 1) {
        charge(context);
        const reportForm = graph.report.forms[formIndex];
        const referenceForm = graph.references.forms[formIndex];
        if (
          !referenceForm ||
          !(referenceForm.form instanceof HTMLFormElement) ||
          referenceForm.sections.length !== reportForm.sections.length
        ) return null;
        for (let sectionIndex = 0; sectionIndex < reportForm.sections.length; sectionIndex += 1) {
          charge(context);
          const reportSection = reportForm.sections[sectionIndex];
          const referenceSection = referenceForm.sections[sectionIndex];
          if (!referenceSection || referenceSection.fields.length !== reportSection.fields.length) return null;
          for (let fieldIndex = 0; fieldIndex < reportSection.fields.length; fieldIndex += 1) {
            charge(context);
            const reportField = reportSection.fields[fieldIndex];
            const referenceField = referenceSection.fields[fieldIndex];
            if (
              !referenceField ||
              !(referenceField.control instanceof NativeElement) ||
              referenceField.choices.length !== reportField.choices.length
            ) return null;
            const choices: Element[] = [];
            for (const choice of referenceField.choices) {
              charge(context);
              if (!(choice instanceof NativeElement)) return null;
              choices.push(choice);
            }
            fields.push({
              sourceOrdinal: { form: formIndex, section: sectionIndex, field: fieldIndex },
              fieldType: reportField.fieldType,
              ownerForm: referenceForm.form,
              control: referenceField.control,
              choices
            });
          }
        }
      }
      return fields;
    }][0];
    const candidateNodes = [(context: OperationContext, fields: readonly FlatField[]): Node[] => {
      const nodes: Node[] = [];
      for (const field of fields) {
        charge(context);
        nodes.push(field.ownerForm);
        nodes.push(field.control);
        for (const choice of field.choices) {
          charge(context);
          nodes.push(choice);
        }
      }
      return nodes;
    }][0];
    const removedContains = [(context: OperationContext, removed: Node, retained: Node): boolean => {
      let current: Node | null = retained;
      while (current) {
        charge(context);
        if (current === removed) return true;
        current = current.parentNode;
      }
      return false;
    }][0];
    const hasStylesheetRelationship = [(
      context: OperationContext,
      link: HTMLLinkElement
    ): boolean => {
      const cached = context.stylesheetRelationships.get(link);
      if (cached !== undefined) return cached;
      const raw = link.getAttribute("rel") ?? "";
      chargeString(context, raw);
      let result = false;
      for (const token of raw.toLowerCase().split(/[\t\n\f\r ]+/u)) {
        if (!token) continue;
        charge(context);
        if (token === "stylesheet") result = true;
      }
      context.stylesheetRelationships.set(link, result);
      return result;
    }][0];
    const isStructuralSurface = [(context: OperationContext, element: Element): boolean =>
      element instanceof HTMLFormElement ||
      element.hasAttribute("form") ||
      element.matches("style") ||
      (element instanceof HTMLLinkElement && hasStylesheetRelationship(context, element))
    ][0];
    const isStructuralIntroduction = [(context: OperationContext, element: Element): boolean =>
      element instanceof HTMLFormElement ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
      element.hasAttribute("form") ||
      element.matches("style") ||
      (element instanceof HTMLLinkElement && hasStylesheetRelationship(context, element))
    ][0];
    const semanticAttributes = new Set([
      "accept", "aria-describedby", "aria-label", "aria-labelledby", "autocomplete",
      "class", "contenteditable", "disabled", "for", "form", "hidden", "href", "id",
      "inert", "label", "max", "maxlength", "min", "minlength", "multiple", "name", "rel",
      "required", "role", "slot", "step", "style", "tabindex", "type"
    ]);
    const maxSemanticAttributeNameLength = 32;
    const semanticAncestorAttributes = new Set([
      "class", "contenteditable", "hidden", "inert", "name", "role", "slot", "style"
    ]);
    const semanticGroupLabelAttributes = new Set([
      "aria-describedby", "aria-label", "aria-labelledby"
    ]);
    let explicitSemanticNodes = new WeakSet<Node>();
    let semanticAncestors = new WeakSet<Node>();
    let unresolvedSemanticReferenceIds = new Set<string>();
    let retainedNativeLabelControls = new WeakSet<Element>();
    let retainedAriaWinners = new Map<string, Element | null>();
    const rootObservers = new Map<Document | ShadowRoot, MutationObserver>();

    const markStickyDetachments = [(context: OperationContext, record: MutationRecord) => {
      if (candidates.size === 0) return;
      if (record.type !== "childList" || record.removedNodes.length === 0) return;
      for (const removed of record.removedNodes) {
        charge(context);
        for (const candidate of candidates.values()) {
          charge(context);
          if (candidate.stickyDetached) continue;
          for (const node of candidate.nodes) {
            charge(context);
            if (removedContains(context, removed, node)) {
              candidate.stickyDetached = true;
              break;
            }
          }
          if (candidate.stickyDetached) continue;
        }
      }
    }][0];
    const elementMayIntroduceSemantics = [(context: OperationContext, element: Element): boolean => {
      const roots = new Set<Element | ShadowRoot>([element]);
      for (const root of roots) {
        charge(context);
        if (root instanceof NativeElement && isStructuralIntroduction(context, root)) return true;
        if (root instanceof NativeElement && root.shadowRoot && !roots.has(root.shadowRoot)) {
          if (roots.size >= maxObservationRoots) fail("FORM_INSPECTION_OVERSIZE");
          charge(context);
          roots.add(root.shadowRoot);
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
        for (let current = walker.nextNode(); current; current = walker.nextNode()) {
          charge(context);
          if (!(current instanceof NativeElement)) continue;
          if (isStructuralIntroduction(context, current)) return true;
          if (current.shadowRoot && !roots.has(current.shadowRoot)) {
            if (roots.size >= maxObservationRoots) fail("FORM_INSPECTION_OVERSIZE");
            charge(context);
            roots.add(current.shadowRoot);
          }
        }
      }
      return false;
    }][0];
    const isCurrentContentText = [(context: OperationContext, node: Node): boolean => {
      let nativeOptionLabelRoot: HTMLOptionElement | null = null;
      for (
        let current = node instanceof NativeElement ? node : node.parentElement;
        current;
        current = current.parentElement
      ) {
        charge(context);
        if (current instanceof HTMLOptionElement) {
          nativeOptionLabelRoot = current;
          break;
        }
        if (current instanceof HTMLSelectElement) break;
      }
      let nativeOptionOwner: HTMLSelectElement | null = null;
      if (nativeOptionLabelRoot) {
        for (let current = nativeOptionLabelRoot.parentElement; current; current = current.parentElement) {
          charge(context);
          if (current instanceof HTMLSelectElement) {
            nativeOptionOwner = current;
            break;
          }
        }
      }
      return isApplicantCurrentContent(context, node, nativeOptionLabelRoot, nativeOptionOwner);
    }][0];
    const isRelated = [(context: OperationContext, node: Node | null): boolean => {
      if (!node) return false;
      if (explicitSemanticNodes.has(node)) return true;
      if (semanticAncestors.has(node)) return true;
      let current: Node | null | false = node instanceof NativeElement ? node : node.parentNode;
      while (current && current !== document) {
        charge(context);
        if (
          explicitSemanticNodes.has(current) ||
          current === document.head ||
          (current instanceof NativeElement && isStructuralSurface(context, current))
        ) return true;
        current = composedParent(current);
      }
      return false;
    }][0];
    const containsExplicitSemanticNode = [(context: OperationContext, node: Node): boolean => {
      // Retained identity survives removal/reinsertion; document lookup and
      // connectivity checks would lose the evidence in pending removal records.
      if (explicitSemanticNodes.has(node)) return true;
      if (!(node instanceof NativeElement)) return false;
      const roots = new Set<Element | ShadowRoot>([node]);
      for (const root of roots) {
        charge(context);
        if (root instanceof NativeElement && root.shadowRoot && !roots.has(root.shadowRoot)) {
          if (roots.size >= maxObservationRoots) fail("FORM_INSPECTION_OVERSIZE");
          charge(context);
          roots.add(root.shadowRoot);
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
        for (let current = walker.nextNode(); current; current = walker.nextNode()) {
          charge(context);
          if (explicitSemanticNodes.has(current)) return true;
          if (current instanceof NativeElement && current.shadowRoot && !roots.has(current.shadowRoot)) {
            if (roots.size >= maxObservationRoots) fail("FORM_INSPECTION_OVERSIZE");
            charge(context);
            roots.add(current.shadowRoot);
          }
        }
      }
      return false;
    }][0];
    const elementMatchesIntroducedSemanticDependency = [(
      context: OperationContext,
      element: Element
    ): boolean => {
      const id = element.getAttribute("id");
      if (id !== null) {
        chargeString(context, id);
        if (unresolvedSemanticReferenceIds.has(id)) {
          chargeString(context, id);
          if (document.getElementById(id) === element) return true;
        }
      }
      if (element instanceof HTMLLabelElement) {
        const control = meteredNativeLabelControl(context, element);
        if (control !== null && retainedNativeLabelControls.has(control)) return true;
      }
      return false;
    }][0];
    const addedSubtreeIntroducesSemanticDependency = [(context: OperationContext, element: Element): boolean => {
      if (elementMatchesIntroducedSemanticDependency(context, element)) return true;
      const roots = new Set<Element | ShadowRoot>([element]);
      for (const root of roots) {
        charge(context);
        if (root instanceof NativeElement && root.shadowRoot && !roots.has(root.shadowRoot)) {
          if (roots.size >= maxObservationRoots) fail("FORM_INSPECTION_OVERSIZE");
          charge(context);
          roots.add(root.shadowRoot);
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
        for (let current = walker.nextNode(); current; current = walker.nextNode()) {
          charge(context);
          if (!(current instanceof NativeElement)) continue;
          if (elementMatchesIntroducedSemanticDependency(context, current)) return true;
          if (current.shadowRoot && !roots.has(current.shadowRoot)) {
            if (roots.size >= maxObservationRoots) fail("FORM_INSPECTION_OVERSIZE");
            charge(context);
            roots.add(current.shadowRoot);
          }
        }
      }
      return false;
    }][0];
    const refreshSelectedAriaWinners = [(context: OperationContext): boolean => {
      let changed = false;
      for (const [id, selected] of retainedAriaWinners) {
        charge(context);
        chargeString(context, id);
        const current = document.getElementById(id);
        if (current === selected) continue;
        chargeString(context, id);
        retainedAriaWinners.set(id, current);
        changed = true;
      }
      return changed;
    }][0];
    const isSemanticContainerAttribute = [(
      context: OperationContext,
      target: Node,
      attributeName: string
    ): boolean => {
      if (!(target instanceof NativeElement)) return false;
      if (target instanceof HTMLFieldSetElement) {
        if (attributeName === "disabled" || attributeName === "aria-describedby") return true;
      }
      if (target instanceof HTMLOptGroupElement) {
        if (attributeName === "disabled" || attributeName === "label") return true;
      }
      return semanticGroupLabelAttributes.has(attributeName) &&
        (hasRole(context, target, "group") || hasRole(context, target, "radiogroup"));
    }][0];
    const recordIsRelevant = [(context: OperationContext, record: MutationRecord): boolean => {
      if (record.type === "attributes") {
        if (record.attributeName === "value" || record.attributeName === "checked" || record.attributeName === "selected") {
          return false;
        }
        if (
          record.attributeName === null ||
          record.attributeName.length > maxSemanticAttributeNameLength ||
          !semanticAttributes.has(record.attributeName)
        ) return false;
        if (
          record.target instanceof NativeElement &&
          (record.attributeName === "id" || record.attributeName === "for") &&
          elementMatchesIntroducedSemanticDependency(context, record.target)
        ) return true;
        if (
          semanticAncestors.has(record.target) &&
          !explicitSemanticNodes.has(record.target) &&
          !semanticAncestorAttributes.has(record.attributeName) &&
          !isSemanticContainerAttribute(context, record.target, record.attributeName)
        ) return false;
        return isRelated(context, record.target);
      }
      if (record.type === "characterData") {
        return !isCurrentContentText(context, record.target) && isRelated(context, record.target);
      }
      const targetElement = record.target instanceof NativeElement
        ? record.target
        : record.target.parentElement;
      let targetIsDirectSurface = explicitSemanticNodes.has(record.target);
      if (!targetIsDirectSurface && record.target instanceof NativeShadowRoot) {
        targetIsDirectSurface = isRelated(context, record.target.host);
      }
      if (!targetIsDirectSurface && targetElement !== null) {
        let current: Node | null | false = targetElement;
        while (current && current !== document) {
          charge(context);
          if (
            explicitSemanticNodes.has(current) ||
            current === document.head ||
            (current instanceof NativeElement && isStructuralSurface(context, current))
          ) {
            targetIsDirectSurface = true;
            break;
          }
          current = composedParent(current);
        }
      }
      if (targetIsDirectSurface) {
        if (isCurrentContentText(context, record.target)) {
          for (const node of record.addedNodes) {
            charge(context);
            if (node instanceof NativeElement) return true;
          }
          for (const node of record.removedNodes) {
            charge(context);
            if (node instanceof NativeElement) return true;
          }
          return false;
        }
        return true;
      }
      for (const node of record.addedNodes) {
        charge(context);
        if (
          containsExplicitSemanticNode(context, node) ||
          node instanceof NativeElement && (
            elementMayIntroduceSemantics(context, node) ||
            addedSubtreeIntroducesSemanticDependency(context, node)
          )
        ) return true;
      }
      for (const node of record.removedNodes) {
        charge(context);
        if (
          containsExplicitSemanticNode(context, node) ||
          node instanceof NativeElement && elementMayIntroduceSemantics(context, node)
        ) return true;
      }
      return false;
    }][0];
    const onRecords = [(context: OperationContext, records: readonly MutationRecord[]) => {
      let relevant = refreshSelectedAriaWinners(context);
      for (const record of records) {
        charge(context);
        markStickyDetachments(context, record);
        if (recordIsRelevant(context, record)) relevant = true;
      }
      if (relevant) bumpSemantic();
    }][0];
    const failClosedWorkExhaustion = [() => {
      candidates.clear();
      explicitSemanticNodes = new WeakSet<Node>();
      semanticAncestors = new WeakSet<Node>();
      unresolvedSemanticReferenceIds = new Set<string>();
      retainedNativeLabelControls = new WeakSet<Element>();
      retainedAriaWinners = new Map<string, Element | null>();
      for (const [root, observer] of rootObservers) {
        if (root === document) continue;
        nativeApply(nativeDisconnect, observer, []);
        rootObservers.delete(root);
      }
      bumpSemantic();
    }][0];
    const observeRoot = [(
      context: OperationContext,
      root: Document | ShadowRoot,
      workPrecharged = false
    ) => {
      if (rootObservers.has(root)) return;
      if (!workPrecharged) charge(context);
      const observer = new NativeMutationObserver((records) => {
        const callbackContext = operationContext();
        try {
          onRecords(callbackContext, records);
        } catch {
          failClosedWorkExhaustion();
        }
      });
      nativeApply(nativeObserve, observer, [root, {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true
      }]);
      rootObservers.set(root, observer);
    }][0];
    const discoverOpenRootsIncrementally = [(
      context: OperationContext,
      node: Element | ShadowRoot,
      roots: Set<Document | ShadowRoot>,
      scanned: WeakSet<Node>
    ) => {
      const pending: Array<Element | ShadowRoot> = [];
      const scheduled = new WeakSet<Node>();
      const schedule = [(current: Element | ShadowRoot) => {
        if (scanned.has(current) || scheduled.has(current)) return;
        scheduled.add(current);
        pending.push(current);
      }][0];
      const addProspectiveRoot = [(root: ShadowRoot) => {
        if (!roots.has(root)) {
          if (roots.size >= maxObservationRoots) {
            fail("FORM_INSPECTION_OVERSIZE");
          }
          charge(context);
          roots.add(root);
        }
        schedule(root);
      }][0];
      schedule(node);
      for (let index = 0; index < pending.length; index += 1) {
        const currentRoot = pending[index];
        charge(context);
        if (scanned.has(currentRoot)) continue;
        scanned.add(currentRoot);
        if (currentRoot instanceof NativeElement && currentRoot.shadowRoot) {
          addProspectiveRoot(currentRoot.shadowRoot);
        }
        const walker = document.createTreeWalker(currentRoot, NodeFilter.SHOW_ALL);
        for (let current = walker.nextNode(); current; current = walker.nextNode()) {
          charge(context);
          scanned.add(current);
          if (current instanceof NativeElement && current.shadowRoot) addProspectiveRoot(current.shadowRoot);
        }
      }
    }][0];
    const drainRecords = [(context: OperationContext) => {
      for (const observer of rootObservers.values()) {
        charge(context);
        const records = nativeApply(nativeTakeRecords, observer, []) as MutationRecord[];
        if (records.length > 0) onRecords(context, records);
      }
    }][0];
    const refreshObservation = [(context: OperationContext) => {
      drainRecords(context);
      const prospectiveSemanticNodes = new WeakSet<Node>();
      const prospectiveAncestors = new WeakSet<Node>();
      const prospectiveUnresolvedIds = new Set<string>();
      const prospectiveLabelControls = new WeakSet<Element>();
      const prospectiveAriaWinners = new Map<string, Element | null>();
      const scanSurfaces = new Set<Element>();
      const composedAncestorRoots = new Set<ShadowRoot>();
      const retainNodeAndAncestors = [(node: Node) => {
        prospectiveSemanticNodes.add(node);
        let current: Node | null | false = node;
        while (current && current !== document) {
          charge(context);
          const parent = current.parentNode;
          if (
            parent instanceof NativeShadowRoot &&
            parent.mode === "open" &&
            !composedAncestorRoots.has(parent)
          ) {
            charge(context);
            composedAncestorRoots.add(parent);
          }
          current = composedParent(current);
          if (current && current !== document) prospectiveAncestors.add(current);
        }
        if (current !== document) fail("FORM_STRUCTURE_UNSUPPORTED");
      }][0];
      for (const candidate of candidates.values()) {
        charge(context);
        for (const control of candidate.nativeLabelControls) {
          charge(context);
          prospectiveLabelControls.add(control);
        }
        for (const label of candidate.nativeLabels) {
          charge(context);
          retainNodeAndAncestors(label);
        }
        for (const id of candidate.semanticReferenceIds) {
          charge(context);
          chargeString(context, id);
          const referenced = document.getElementById(id);
          chargeString(context, id);
          prospectiveAriaWinners.set(id, referenced);
          if (referenced) {
            retainNodeAndAncestors(referenced);
          } else {
            chargeString(context, id);
            prospectiveUnresolvedIds.add(id);
          }
        }
        for (const node of candidate.nodes) {
          charge(context);
          retainNodeAndAncestors(node);
          if (node instanceof NativeElement) scanSurfaces.add(node);
        }
      }

      const desiredRoots = new Set<Document | ShadowRoot>([document]);
      for (const root of composedAncestorRoots) {
        charge(context);
        if (desiredRoots.has(root)) continue;
        if (desiredRoots.size >= maxObservationRoots) fail("FORM_INSPECTION_OVERSIZE");
        desiredRoots.add(root);
      }
      const scannedObservationNodes = new WeakSet<Node>();
      for (const root of composedAncestorRoots) {
        charge(context);
        discoverOpenRootsIncrementally(context, root, desiredRoots, scannedObservationNodes);
      }
      for (const surface of scanSurfaces) {
        charge(context);
        if (surface.isConnected) {
          discoverOpenRootsIncrementally(context, surface, desiredRoots, scannedObservationNodes);
        }
      }
      // Validate the complete prospective union before changing retained
      // identities or observers. Discovery stops early only to reject overflow.
      const rootsToRemove: Array<readonly [Document | ShadowRoot, MutationObserver]> = [];
      for (const [root, observer] of rootObservers) {
        charge(context);
        if (!desiredRoots.has(root)) rootsToRemove.push([root, observer]);
      }
      const rootsToAdd: Array<Document | ShadowRoot> = [];
      for (const root of desiredRoots) {
        charge(context);
        if (!rootObservers.has(root)) rootsToAdd.push(root);
      }
      charge(context, rootsToRemove.length + rootsToAdd.length);
      for (const [root, observer] of rootsToRemove) {
        nativeApply(nativeDisconnect, observer, []);
        rootObservers.delete(root);
      }
      for (const root of rootsToAdd) observeRoot(context, root, true);
      explicitSemanticNodes = prospectiveSemanticNodes;
      semanticAncestors = prospectiveAncestors;
      unresolvedSemanticReferenceIds = prospectiveUnresolvedIds;
      retainedNativeLabelControls = prospectiveLabelControls;
      retainedAriaWinners = prospectiveAriaWinners;
    }][0];
    const refreshAfterCandidateRemoval = [(context: OperationContext) => {
      try {
        refreshObservation(context);
      } catch {
        failClosedWorkExhaustion();
      }
    }][0];
    observeRoot(operationContext(), document);
    const onApplicantState = [(event: Event) => {
      const owned = ownedWriterEventWindow;
      if (owned) {
        if (
          event.target !== owned.target ||
          owned.index >= owned.expected.length ||
          event.type !== owned.expected[owned.index]
        ) {
          owned.unexpected = true;
        } else {
          owned.index += 1;
        }
      }
      bumpApplicant();
    }][0];
    nativeApply(nativeAddEventListener, protectedWindow, ["input", onApplicantState, true]);
    nativeApply(nativeAddEventListener, protectedWindow, ["change", onApplicantState, true]);

    const isStyleRiskRelated = [(context: OperationContext, target: EventTarget | null): boolean => {
      return target instanceof NativeNode && isRelated(context, target);
    }][0];
    const onStyleRisk = [(event: Event) => {
      const context = operationContext();
      try {
        if (event.type === "resize" || isStyleRiskRelated(context, event.target)) bumpSemantic();
      } catch {
        failClosedWorkExhaustion();
      }
    }][0];
    nativeApply(nativeAddEventListener, document, ["load", onStyleRisk, true]);
    const styleRiskEvents = nativeFreeze([
      "resize",
      "animationstart",
      "animationiteration",
      "animationend",
      "animationcancel",
      "transitionrun",
      "transitionstart",
      "transitionend",
      "transitioncancel"
    ]);
    for (const eventName of styleRiskEvents) {
      nativeApply(nativeAddEventListener, protectedWindow, [eventName, onStyleRisk, true]);
    }

    const codeFor = [(error: unknown): string => {
      const rendered = error instanceof NativeError ? error.message : "";
      if (rendered.includes(workErrorMessage)) return "FORM_INSPECTION_OVERSIZE";
      for (const code of errorCodes) {
        if (rendered.includes("__APPLY_PILOT_SAFE_FORM_INSPECTION__" + code)) return code;
      }
      return "FORM_INSPECTION_INVALID";
    }][0];
    const sameGraph = [(
      context: OperationContext,
      candidate: Candidate,
      graph: ExtractedGraph,
      fields: readonly FlatField[]
    ): boolean => {
      if (
        candidate.ownerDocument !== document ||
        candidate.stickyDetached ||
        candidate.reportCanonical !== nativeStringify(graph.report) ||
        candidate.fields.length !== fields.length
      ) return false;
      for (let index = 0; index < fields.length; index += 1) {
        charge(context);
        const retained = candidate.fields[index];
        const current = fields[index];
        if (
          retained.ownerForm !== current.ownerForm ||
          retained.ownerForm.ownerDocument !== document ||
          !retained.ownerForm.isConnected ||
          retained.control !== current.control ||
          retained.control.ownerDocument !== document ||
          !retained.control.isConnected ||
          retained.choices.length !== current.choices.length
        ) return false;
        for (let choiceIndex = 0; choiceIndex < current.choices.length; choiceIndex += 1) {
          charge(context);
          const retainedChoice = retained.choices[choiceIndex];
          if (
            retainedChoice !== current.choices[choiceIndex] ||
            retainedChoice.ownerDocument !== document ||
            !retainedChoice.isConnected
          ) return false;
        }
      }
      return true;
    }][0];
    const exactInput = [(value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const actual = nativeKeys(value).sort();
      const expected = [...keys].sort();
      return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
    }][0];

    const methods = {
      handshake() {
        return plain([["version", 2], ["state", "READY"], ["methods", [...methodNames]]]);
      },
      extract() {
        const context = operationContext();
        let insertedCandidateId: number | null = null;
        try {
          drainRecords(context);
          if (disposed) return plain([["kind", "ERROR"], ["code", "FORM_INSPECTION_INVALID"]]);
          if (candidates.size >= 16 || !Number.isSafeInteger(nextCandidateId)) {
            return plain([["kind", "ERROR"], ["code", "FORM_INSPECTION_OVERSIZE"]]);
          }
          const graph = extractGraph(context);
          const fields = flattened(context, graph);
          if (!fields) return plain([["kind", "ERROR"], ["code", "FORM_INSPECTION_INVALID"]]);
          const id = nextCandidateId;
          nextCandidateId += 1;
          const candidate: Candidate = {
            id,
            reportCanonical: nativeStringify(graph.report),
            fields,
            nodes: candidateNodes(context, fields),
            ownerDocument: document,
            semanticReferenceIds: graph.references.semanticReferenceIds,
            nativeLabelControls: graph.references.nativeLabelControls,
            nativeLabels: graph.references.nativeLabels,
            stickyDetached: false,
            writerTargets: null,
            writerEpoch: null
          };
          candidates.set(id, candidate);
          insertedCandidateId = id;
          refreshObservation(context);
          return plain([["kind", "OK"], ["candidateId", id], ["report", graph.report]]);
        } catch (error) {
          if (insertedCandidateId !== null) candidates.delete(insertedCandidateId);
          if (isWorkExhaustion(error)) failClosedWorkExhaustion();
          return plain([["kind", "ERROR"], ["code", codeFor(error)]]);
        }
      },
      sealCandidateWriterTargets(value: unknown) {
        const context = operationContext();
        let candidate: Candidate | undefined;
        const reject = [() => {
          if (candidate) candidates.delete(candidate.id);
          refreshAfterCandidateRemoval(context);
          return "INVALID";
        }][0];
        try {
          drainRecords(context);
          if (
            disposed ||
            !exactInput(value, ["candidateId", "bindings"]) ||
            !Number.isSafeInteger(value.candidateId) ||
            (value.candidateId as number) <= 0 ||
            !Array.isArray(value.bindings) ||
            value.bindings.length > limits.maxFieldsTotal
          ) return reject();
          candidate = candidates.get(value.candidateId as number);
          if (
            !candidate ||
            candidate.stickyDetached ||
            candidate.writerTargets !== null ||
            candidate.writerEpoch !== null
          ) return reject();

          const graph = extractGraph(context);
          const currentFields = flattened(context, graph);
          if (!currentFields || !sameGraph(context, candidate, graph, currentFields)) return reject();

          const seenFieldKeys = new Set<string>();
          const seenFingerprints = new Set<string>();
          const seenFieldOrdinals = new Set<string>();
          const targets = new Map<string, SealedWriterTarget>();
          let choiceCount = 0;
          for (const rawBinding of value.bindings) {
            charge(context);
            if (!exactInput(rawBinding, [
              "normalizedFieldKey",
              "fieldFingerprint",
              "fieldType",
              "sourceOrdinal",
              "choices"
            ])) return reject();
            if (
              typeof rawBinding.normalizedFieldKey !== "string" ||
              !/^[a-f0-9]{64}$/u.test(rawBinding.normalizedFieldKey) ||
              typeof rawBinding.fieldFingerprint !== "string" ||
              !/^[a-f0-9]{64}$/u.test(rawBinding.fieldFingerprint) ||
              typeof rawBinding.fieldType !== "string" ||
              !(limits.writableFieldTypes as readonly string[]).includes(rawBinding.fieldType) ||
              !exactInput(rawBinding.sourceOrdinal, ["form", "section", "field"]) ||
              !Number.isSafeInteger(rawBinding.sourceOrdinal.form) ||
              !Number.isSafeInteger(rawBinding.sourceOrdinal.section) ||
              !Number.isSafeInteger(rawBinding.sourceOrdinal.field) ||
              (rawBinding.sourceOrdinal.form as number) < 0 ||
              (rawBinding.sourceOrdinal.section as number) < 0 ||
              (rawBinding.sourceOrdinal.field as number) < 0 ||
              !Array.isArray(rawBinding.choices) ||
              rawBinding.choices.length > limits.maxChoicesPerField
            ) return reject();
            const fieldOrdinal = `${rawBinding.sourceOrdinal.form}/${rawBinding.sourceOrdinal.section}/${rawBinding.sourceOrdinal.field}`;
            if (
              seenFieldKeys.has(rawBinding.normalizedFieldKey) ||
              seenFingerprints.has(rawBinding.fieldFingerprint) ||
              seenFieldOrdinals.has(fieldOrdinal)
            ) return reject();
            seenFieldKeys.add(rawBinding.normalizedFieldKey);
            seenFingerprints.add(rawBinding.fieldFingerprint);
            seenFieldOrdinals.add(fieldOrdinal);

            let fieldIndex = -1;
            for (let index = 0; index < candidate.fields.length; index += 1) {
              charge(context);
              const source = candidate.fields[index].sourceOrdinal;
              if (
                source.form === rawBinding.sourceOrdinal.form &&
                source.section === rawBinding.sourceOrdinal.section &&
                source.field === rawBinding.sourceOrdinal.field
              ) {
                fieldIndex = index;
                break;
              }
            }
            if (fieldIndex < 0) return reject();
            const field = candidate.fields[fieldIndex];
            if (field.fieldType !== rawBinding.fieldType) return reject();
            const liveFieldType = classifyNativeWriterFieldType(
              field.control,
              field.control instanceof NativeHTMLInputElement ? field.control.type : null,
              field.control instanceof NativeHTMLSelectElement ? field.control.multiple : null
            );
            if (liveFieldType !== rawBinding.fieldType) return reject();

            const sealedChoices: SealedWriterChoice[] = [];
            const choicesByKey = new Map<string, SealedWriterChoice>();
            if (rawBinding.fieldType === "SELECT_ONE") {
              if (rawBinding.choices.length !== field.choices.length || rawBinding.choices.length === 0) {
                return reject();
              }
              const choicesByIndex: Array<SealedWriterChoice | undefined> = new Array(field.choices.length);
              for (const rawChoice of rawBinding.choices) {
                charge(context);
                if (
                  !exactInput(rawChoice, ["choiceKey", "sourceOrdinal"]) ||
                  typeof rawChoice.choiceKey !== "string" ||
                  !/^[a-f0-9]{64}$/u.test(rawChoice.choiceKey) ||
                  choicesByKey.has(rawChoice.choiceKey) ||
                  !exactInput(rawChoice.sourceOrdinal, ["form", "section", "field", "choice"]) ||
                  rawChoice.sourceOrdinal.form !== rawBinding.sourceOrdinal.form ||
                  rawChoice.sourceOrdinal.section !== rawBinding.sourceOrdinal.section ||
                  rawChoice.sourceOrdinal.field !== rawBinding.sourceOrdinal.field ||
                  !Number.isSafeInteger(rawChoice.sourceOrdinal.choice) ||
                  (rawChoice.sourceOrdinal.choice as number) < 0 ||
                  (rawChoice.sourceOrdinal.choice as number) >= field.choices.length ||
                  choicesByIndex[rawChoice.sourceOrdinal.choice as number] !== undefined
                ) return reject();
                const option = field.choices[rawChoice.sourceOrdinal.choice as number];
                if (!(option instanceof HTMLOptionElement)) return reject();
                const sealedChoice: SealedWriterChoice = {
                  choiceKey: rawChoice.choiceKey,
                  sourceOrdinal: {
                    form: rawChoice.sourceOrdinal.form as number,
                    section: rawChoice.sourceOrdinal.section as number,
                    field: rawChoice.sourceOrdinal.field as number,
                    choice: rawChoice.sourceOrdinal.choice as number
                  },
                  option
                };
                choicesByIndex[rawChoice.sourceOrdinal.choice as number] = sealedChoice;
                choicesByKey.set(sealedChoice.choiceKey, sealedChoice);
              }
              if (choicesByIndex.some((choice) => choice === undefined)) return reject();
              sealedChoices.push(...choicesByIndex as SealedWriterChoice[]);
            } else if (rawBinding.choices.length !== 0 || field.choices.length !== 0) {
              return reject();
            }
            choiceCount += sealedChoices.length;
            if (choiceCount > limits.maxChoicesTotal) return reject();

            const target: SealedWriterTarget = {
              normalizedFieldKey: rawBinding.normalizedFieldKey,
              fieldFingerprint: rawBinding.fieldFingerprint,
              fieldType: rawBinding.fieldType,
              sourceOrdinal: {
                form: rawBinding.sourceOrdinal.form as number,
                section: rawBinding.sourceOrdinal.section as number,
                field: rawBinding.sourceOrdinal.field as number
              },
              fieldIndex,
              control: field.control,
              choices: sealedChoices,
              choicesByKey
            };
            targets.set(target.normalizedFieldKey, target);
          }

          candidate.semanticReferenceIds = graph.references.semanticReferenceIds;
          candidate.nativeLabelControls = graph.references.nativeLabelControls;
          candidate.nativeLabels = graph.references.nativeLabels;
          refreshObservation(context);
          candidate.writerTargets = targets;
          candidate.writerEpoch = applicantStateEpoch;
          return "SEALED";
        } catch (error) {
          if (isWorkExhaustion(error)) failClosedWorkExhaustion();
          return reject();
        }
      },
      verifyCandidate(value: unknown) {
        const context = operationContext();
        try {
          drainRecords(context);
        } catch {
          failClosedWorkExhaustion();
          return plain([["status", "INVALID"]]);
        }
        if (!exactInput(value, ["candidateId"]) || !Number.isSafeInteger(value.candidateId)) {
          return plain([["status", "INVALID"]]);
        }
        const candidate = candidates.get(value.candidateId as number);
        if (!candidate || disposed) return plain([["status", "INVALID"]]);
        if (candidate.stickyDetached) {
          candidates.delete(candidate.id);
          refreshAfterCandidateRemoval(context);
          return plain([["status", "INVALID"]]);
        }
        try {
          const graph = extractGraph(context);
          const fields = flattened(context, graph);
          if (!fields || !sameGraph(context, candidate, graph, fields)) {
            candidates.delete(candidate.id);
            refreshAfterCandidateRemoval(context);
            return plain([["status", "INVALID"]]);
          }
          // A same-looking dependency may have a new identity even when the
          // exact candidate graph is current. Drain history, then track it.
          candidate.semanticReferenceIds = graph.references.semanticReferenceIds;
          candidate.nativeLabelControls = graph.references.nativeLabelControls;
          candidate.nativeLabels = graph.references.nativeLabels;
          refreshObservation(context);
          return plain([["status", "CURRENT"], ["report", graph.report], ["fence", snapshotValue()]]);
        } catch (error) {
          candidates.delete(candidate.id);
          if (isWorkExhaustion(error)) {
            failClosedWorkExhaustion();
          } else {
            refreshAfterCandidateRemoval(context);
          }
          return plain([["status", "INVALID"]]);
        }
      },
      writeCandidateField(value: unknown) {
        const context = operationContext();
        let candidate: Candidate | undefined;
        let mutationStarted = false;
        const failed = [(reason: "CANDIDATE_INVALID" | "TARGET_INVALID" | "UNEXPECTED_ACTIVITY" | "WRITE_FAILED") => {
          ownedWriterEventWindow = null;
          if (candidate) candidates.delete(candidate.id);
          refreshAfterCandidateRemoval(context);
          return plain([["status", "FAILED"], ["reason", reason]]);
        }][0];
        try {
          drainRecords(context);
          if (
            disposed ||
            !exactInput(value, ["candidateId", "request"]) ||
            !Number.isSafeInteger(value.candidateId) ||
            (value.candidateId as number) <= 0 ||
            !exactInput(value.request, ["normalizedFieldKey", "fieldFingerprint", "fieldType", "proposal"])
          ) return failed("CANDIDATE_INVALID");
          candidate = candidates.get(value.candidateId as number);
          if (
            !candidate ||
            candidate.stickyDetached ||
            candidate.writerTargets === null ||
            candidate.writerEpoch === null ||
            candidate.writerEpoch !== applicantStateEpoch
          ) return failed("CANDIDATE_INVALID");

          const request = value.request;
          if (
            typeof request.normalizedFieldKey !== "string" ||
            !/^[a-f0-9]{64}$/u.test(request.normalizedFieldKey) ||
            typeof request.fieldFingerprint !== "string" ||
            !/^[a-f0-9]{64}$/u.test(request.fieldFingerprint) ||
            typeof request.fieldType !== "string" ||
            !(limits.writableFieldTypes as readonly string[]).includes(request.fieldType)
          ) return failed("TARGET_INVALID");
          const isSelect = request.fieldType === "SELECT_ONE";
          if (
            isSelect
              ? !exactInput(request.proposal, ["kind", "optionKeys"]) ||
                request.proposal.kind !== "OPTIONS" ||
                !Array.isArray(request.proposal.optionKeys) ||
                request.proposal.optionKeys.length !== 1 ||
                typeof request.proposal.optionKeys[0] !== "string" ||
                !/^[a-f0-9]{64}$/u.test(request.proposal.optionKeys[0])
              : !exactInput(request.proposal, ["kind", "value"]) ||
                request.proposal.kind !== "SCALAR" ||
                typeof request.proposal.value !== "string" ||
                request.proposal.value.length === 0 ||
                request.proposal.value.length > 8_192
          ) return failed("TARGET_INVALID");

          const graph = extractGraph(context);
          const currentFields = flattened(context, graph);
          if (!currentFields || !sameGraph(context, candidate, graph, currentFields)) {
            return failed("CANDIDATE_INVALID");
          }
          const target = candidate.writerTargets.get(request.normalizedFieldKey);
          if (
            !target ||
            target.normalizedFieldKey !== request.normalizedFieldKey ||
            target.fieldFingerprint !== request.fieldFingerprint ||
            target.fieldType !== request.fieldType ||
            currentFields[target.fieldIndex]?.control !== target.control
          ) return failed("TARGET_INVALID");
          const liveFieldType = classifyNativeWriterFieldType(
            target.control,
            target.control instanceof NativeHTMLInputElement
              ? nativeApply(nativeInputTypeGet, target.control, []) as string
              : null,
            target.control instanceof NativeHTMLSelectElement
              ? Boolean(nativeApply(nativeSelectMultipleGet, target.control, []))
              : null
          );
          if (liveFieldType !== target.fieldType) return failed("TARGET_INVALID");
          candidate.semanticReferenceIds = graph.references.semanticReferenceIds;
          candidate.nativeLabelControls = graph.references.nativeLabelControls;
          candidate.nativeLabels = graph.references.nativeLabels;
          refreshObservation(context);
          if (candidate.writerEpoch !== applicantStateEpoch) return failed("CANDIDATE_INVALID");

          if (!isSelect) {
            const proposalValue = (request.proposal as Readonly<{ value: string }>).value;
            let currentValue: string;
            let isUnwritable: boolean;
            if (target.fieldType === "TEXTAREA") {
              if (!(target.control instanceof NativeHTMLTextAreaElement)) return failed("TARGET_INVALID");
              currentValue = nativeApply(nativeTextAreaValueGet, target.control, []) as string;
              isUnwritable = Boolean(
                nativeApply(nativeTextAreaReadOnlyGet, target.control, []) ||
                nativeApply(nativeTextAreaDisabledGet, target.control, []) ||
                nativeApply(nativeMatches, target.control, [":disabled"])
              );
            } else {
              if (!(target.control instanceof NativeHTMLInputElement)) return failed("TARGET_INVALID");
              currentValue = nativeApply(nativeInputValueGet, target.control, []) as string;
              isUnwritable = Boolean(
                nativeApply(nativeInputReadOnlyGet, target.control, []) ||
                nativeApply(nativeInputDisabledGet, target.control, []) ||
                nativeApply(nativeMatches, target.control, [":disabled"])
              );
            }
            if (isUnwritable) return plain([["status", "MANUAL"], ["reason", "UNWRITABLE"]]);
            if (currentValue.length > 0) return plain([["status", "PRESERVED_EXISTING"]]);

            const owned: OwnedWriterEventWindow = {
              target: target.control,
              expected: nativeFreeze(["input"]),
              index: 0,
              unexpected: false
            };
            if (ownedWriterEventWindow !== null) return failed("UNEXPECTED_ACTIVITY");
            ownedWriterEventWindow = owned;
            mutationStarted = true;
            if (target.fieldType === "TEXTAREA") {
              nativeApply(nativeTextAreaValueSet, target.control, [proposalValue]);
            } else {
              nativeApply(nativeInputValueSet, target.control, [proposalValue]);
            }
            const inputEvent = new NativeEvent("input", {
              bubbles: true,
              cancelable: false,
              composed: false
            });
            nativeApply(nativeDispatchEvent, target.control, [inputEvent]);

            drainRecords(context);
            const postGraph = extractGraph(context);
            const postFields = flattened(context, postGraph);
            if (
              ownedWriterEventWindow !== owned ||
              owned.unexpected ||
              owned.index !== owned.expected.length ||
              !postFields ||
              !sameGraph(context, candidate, postGraph, postFields) ||
              postFields[target.fieldIndex]?.control !== target.control
            ) return failed("UNEXPECTED_ACTIVITY");
            const postValue = target.fieldType === "TEXTAREA"
              ? nativeApply(nativeTextAreaValueGet, target.control, []) as string
              : nativeApply(nativeInputValueGet, target.control, []) as string;
            if (postValue !== proposalValue) return failed("UNEXPECTED_ACTIVITY");
            candidate.semanticReferenceIds = postGraph.references.semanticReferenceIds;
            candidate.nativeLabelControls = postGraph.references.nativeLabelControls;
            candidate.nativeLabels = postGraph.references.nativeLabels;
            refreshObservation(context);
            if (owned.unexpected || owned.index !== owned.expected.length) {
              return failed("UNEXPECTED_ACTIVITY");
            }
            candidate.writerEpoch = applicantStateEpoch;
            ownedWriterEventWindow = null;
            return plain([["status", "FILLED"]]);
          }

          if (!(target.control instanceof NativeHTMLSelectElement)) return failed("TARGET_INVALID");
          if (
            nativeApply(nativeSelectMultipleGet, target.control, []) ||
            nativeApply(nativeSelectDisabledGet, target.control, []) ||
            nativeApply(nativeMatches, target.control, [":disabled"])
          ) return plain([["status", "MANUAL"], ["reason", "UNWRITABLE"]]);
          let selectedChoice: SealedWriterChoice | null = null;
          for (const choice of target.choices) {
            charge(context);
            if (!(choice.option instanceof NativeHTMLOptionElement)) return failed("TARGET_INVALID");
            if (nativeApply(nativeOptionSelectedGet, choice.option, [])) {
              if (selectedChoice !== null) return failed("TARGET_INVALID");
              selectedChoice = choice;
            }
          }
          if (selectedChoice === null) return failed("TARGET_INVALID");
          const selectedIsDisabled = Boolean(
            nativeApply(nativeOptionDisabledGet, selectedChoice.option, []) ||
            nativeApply(nativeMatches, selectedChoice.option, [":disabled"])
          );
          const selectedRawValue = nativeApply(nativeOptionValueGet, selectedChoice.option, []) as string;
          if (!selectedIsDisabled || selectedRawValue !== "") {
            return plain([["status", "PRESERVED_EXISTING"]]);
          }

          const proposal = request.proposal as Readonly<{ kind: "OPTIONS"; optionKeys: readonly [string] }>;
          const proposedChoice = target.choicesByKey.get(proposal.optionKeys[0]);
          if (!proposedChoice || !(proposedChoice.option instanceof NativeHTMLOptionElement)) {
            return failed("TARGET_INVALID");
          }
          if (
            nativeApply(nativeOptionDisabledGet, proposedChoice.option, []) ||
            nativeApply(nativeMatches, proposedChoice.option, [":disabled"])
          ) return plain([["status", "MANUAL"], ["reason", "UNWRITABLE"]]);

          const owned: OwnedWriterEventWindow = {
            target: target.control,
            expected: nativeFreeze(["input", "change"]),
            index: 0,
            unexpected: false
          };
          if (ownedWriterEventWindow !== null) return failed("UNEXPECTED_ACTIVITY");
          ownedWriterEventWindow = owned;
          mutationStarted = true;
          nativeApply(nativeOptionSelectedSet, proposedChoice.option, [true]);
          const inputEvent = new NativeEvent("input", {
            bubbles: true,
            cancelable: false,
            composed: false
          });
          nativeApply(nativeDispatchEvent, target.control, [inputEvent]);
          const changeEvent = new NativeEvent("change", {
            bubbles: true,
            cancelable: false,
            composed: false
          });
          nativeApply(nativeDispatchEvent, target.control, [changeEvent]);

          drainRecords(context);
          const postGraph = extractGraph(context);
          const postFields = flattened(context, postGraph);
          if (
            ownedWriterEventWindow !== owned ||
            owned.unexpected ||
            owned.index !== owned.expected.length ||
            !postFields ||
            !sameGraph(context, candidate, postGraph, postFields) ||
            postFields[target.fieldIndex]?.control !== target.control
          ) return failed("UNEXPECTED_ACTIVITY");
          let postSelected: SealedWriterChoice | null = null;
          for (const choice of target.choices) {
            charge(context);
            if (nativeApply(nativeOptionSelectedGet, choice.option, [])) {
              if (postSelected !== null) return failed("UNEXPECTED_ACTIVITY");
              postSelected = choice;
            }
          }
          if (postSelected !== proposedChoice) return failed("UNEXPECTED_ACTIVITY");
          candidate.semanticReferenceIds = postGraph.references.semanticReferenceIds;
          candidate.nativeLabelControls = postGraph.references.nativeLabelControls;
          candidate.nativeLabels = postGraph.references.nativeLabels;
          refreshObservation(context);
          if (owned.unexpected || owned.index !== owned.expected.length) {
            return failed("UNEXPECTED_ACTIVITY");
          }
          candidate.writerEpoch = applicantStateEpoch;
          ownedWriterEventWindow = null;
          return plain([["status", "FILLED"]]);
        } catch (error) {
          if (isWorkExhaustion(error)) failClosedWorkExhaustion();
          return failed(mutationStarted ? "WRITE_FAILED" : "CANDIDATE_INVALID");
        }
      },
      disposeCandidate(value: unknown) {
        if (!exactInput(value, ["candidateId"]) || !Number.isSafeInteger(value.candidateId)) return "MISSING";
        const context = operationContext();
        const existed = candidates.has(value.candidateId as number);
        try {
          drainRecords(context);
        } catch {
          failClosedWorkExhaustion();
          return existed ? "DISPOSED" : "MISSING";
        }
        if (!candidates.delete(value.candidateId as number)) return "MISSING";
        refreshAfterCandidateRemoval(context);
        return "DISPOSED";
      },
      snapshot() {
        try {
          drainRecords(operationContext());
        } catch {
          failClosedWorkExhaustion();
        }
        return snapshotValue();
      },
      waitForChange(value: unknown) {
        try {
          drainRecords(operationContext());
        } catch {
          failClosedWorkExhaustion();
        }
        if (
          !exactInput(value, ["semanticRevision", "applicantStateEpoch", "timeoutMs"]) ||
          !Number.isSafeInteger(value.semanticRevision) ||
          !Number.isSafeInteger(value.applicantStateEpoch) ||
          !Number.isSafeInteger(value.timeoutMs) ||
          (value.timeoutMs as number) < 0 ||
          (value.timeoutMs as number) > 10_000
        ) return Promise.resolve(snapshotValue());
        if (
          disposed ||
          semanticRevision !== value.semanticRevision ||
          applicantStateEpoch !== value.applicantStateEpoch
        ) return Promise.resolve(snapshotValue());
        return new Promise<Readonly<{ semanticRevision: number; applicantStateEpoch: number }>>((resolve) => {
          const waiter = {
            resolve,
            timer: setTimeout(() => {
              waiters.delete(waiter);
              resolve(snapshotValue() as Readonly<{ semanticRevision: number; applicantStateEpoch: number }>);
            }, value.timeoutMs as number)
          };
          waiters.add(waiter);
        });
      },
      dispose() {
        if (disposed) return "DISPOSED";
        const context = operationContext();
        try {
          drainRecords(context);
          charge(context, rootObservers.size);
        } catch {
          failClosedWorkExhaustion();
        }
        disposed = true;
        candidates.clear();
        for (const observer of rootObservers.values()) {
          nativeApply(nativeDisconnect, observer, []);
        }
        rootObservers.clear();
        nativeApply(nativeRemoveEventListener, protectedWindow, ["input", onApplicantState, true]);
        nativeApply(nativeRemoveEventListener, protectedWindow, ["change", onApplicantState, true]);
        nativeApply(nativeRemoveEventListener, document, ["load", onStyleRisk, true]);
        for (const eventName of styleRiskEvents) {
          nativeApply(nativeRemoveEventListener, protectedWindow, [eventName, onStyleRisk, true]);
        }
        wake();
        return "DISPOSED";
      }
    };

    const capability = nativeCreate(null) as Record<string, unknown>;
    nativeDefineProperty(capability, "version", {
      configurable: false,
      enumerable: false,
      value: 2,
      writable: false
    });
    for (const name of methodNames) {
      const implementation = methods[name as keyof typeof methods];
      if (typeof implementation !== "function") throw new NativeError("incomplete protected method table");
      nativeDefineProperty(capability, name, {
        configurable: false,
        enumerable: false,
        value: implementation,
        writable: false
      });
    }
    nativeFreeze(capability);
    nativeDefineProperty(globalThis, input.property, {
      configurable: false,
      enumerable: false,
      value: capability,
      writable: false
    });
  } catch {
    // A partially constructed bootstrap exposes no capability.
  }
}

export function protectedBrowserWorldBootstrapSource(): string {
  return ";(" + installProtectedBrowserWorld.toString() + ")(" + JSON.stringify({
    property: PROTECTED_BROWSER_CAPABILITY_PROPERTY,
    methods: PROTECTED_BROWSER_CAPABILITY_METHODS,
    limits: PROTECTED_WORLD_LIMITS
  }) + ");";
}

export function protectedBrowserCapabilityExpression(): string {
  return "globalThis[" + JSON.stringify(PROTECTED_BROWSER_CAPABILITY_PROPERTY) + "]";
}
