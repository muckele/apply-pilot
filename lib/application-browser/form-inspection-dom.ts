import type { ElementHandle, JSHandle, Page } from "playwright";

import {
  APPLICATION_FORM_AUTOCOMPLETE_VALUES,
  FORM_INSPECTION_SCHEMA_VERSION,
  FORM_INSPECTION_TEXT_LIMITS,
  MAX_CHOICES_PER_FIELD,
  MAX_CHOICES_TOTAL,
  MAX_FIELDS_TOTAL,
  MAX_FORMS,
  MAX_SECTIONS_PER_FORM,
  applicationFormInspectionReportSchema,
  type ApplicationFormInspectionReport
} from "@/lib/application-runs/form-inspection";

export const APPLICATION_FORM_DOM_EXTRACTION_ERROR_CODES = [
  "FORM_STRUCTURE_UNSUPPORTED",
  "FORM_INSPECTION_OVERSIZE",
  "FORM_INSPECTION_INVALID",
  "EMPLOYER_AUTH_REQUIRED_UNSUPPORTED"
] as const;

export type ApplicationFormDomExtractionErrorCode =
  (typeof APPLICATION_FORM_DOM_EXTRACTION_ERROR_CODES)[number];

export class ApplicationFormDomExtractionError extends Error {
  readonly code: ApplicationFormDomExtractionErrorCode;

  constructor(code: ApplicationFormDomExtractionErrorCode) {
    super(`Safe form inspection failed: ${code}`);
    this.name = "ApplicationFormDomExtractionError";
    this.code = code;
  }
}

export type SourceFieldOrdinal = Readonly<{
  form: number;
  section: number;
  field: number;
}>;

export type SourceChoiceOrdinal = Readonly<{
  form: number;
  section: number;
  field: number;
  choice: number;
}>;

export type SafeDomChoiceReference = Readonly<{
  sourceOrdinal: SourceChoiceOrdinal;
  handle: ElementHandle;
}>;

export type SafeDomFieldReference = Readonly<{
  sourceOrdinal: SourceFieldOrdinal;
  handle: ElementHandle;
  choices: readonly SafeDomChoiceReference[];
}>;

export type SafeApplicationFormExtraction = Readonly<{
  report: ApplicationFormInspectionReport;
  fields: readonly SafeDomFieldReference[];
  dispose(): Promise<void>;
}>;

const PAGE_ERROR_PREFIX = "__APPLY_PILOT_SAFE_FORM_INSPECTION__";

const PAGE_LIMITS = {
  schemaVersion: FORM_INSPECTION_SCHEMA_VERSION,
  maxForms: MAX_FORMS,
  maxSectionsPerForm: MAX_SECTIONS_PER_FORM,
  maxFieldsTotal: MAX_FIELDS_TOTAL,
  maxChoicesPerField: MAX_CHOICES_PER_FIELD,
  maxChoicesTotal: MAX_CHOICES_TOTAL,
  text: FORM_INSPECTION_TEXT_LIMITS,
  autocomplete: APPLICATION_FORM_AUTOCOMPLETE_VALUES
} as const;

function extractionCodeFromError(error: unknown): ApplicationFormDomExtractionErrorCode | null {
  const rendered = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return APPLICATION_FORM_DOM_EXTRACTION_ERROR_CODES.find((code) =>
    rendered.includes(`${PAGE_ERROR_PREFIX}${code}`)
  ) ?? null;
}

async function disposeAll(handles: Iterable<JSHandle>): Promise<void> {
  await Promise.allSettled([...handles].map((handle) => handle.dispose()));
}

export async function extractSafeApplicationForm(page: Page): Promise<SafeApplicationFormExtraction> {
  const temporaryHandles = new Set<JSHandle>();
  const retainedHandles = new Set<ElementHandle>();

  const track = <T extends JSHandle>(handle: T): T => {
    temporaryHandles.add(handle);
    return handle;
  };
  const strictArrayProperties = async (array: JSHandle, expectedLength: number): Promise<JSHandle[]> => {
    const properties = await array.getProperties();
    for (const handle of properties.values()) track(handle);
    if (properties.size !== expectedLength) {
      throw new ApplicationFormDomExtractionError("FORM_INSPECTION_INVALID");
    }
    const ordered = new Array<JSHandle>(expectedLength);
    for (const [key, handle] of properties) {
      if (!/^(0|[1-9]\d*)$/.test(key)) {
        throw new ApplicationFormDomExtractionError("FORM_INSPECTION_INVALID");
      }
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index >= expectedLength || ordered[index] !== undefined) {
        throw new ApplicationFormDomExtractionError("FORM_INSPECTION_INVALID");
      }
      ordered[index] = handle;
    }
    for (let index = 0; index < expectedLength; index += 1) {
      if (ordered[index] === undefined) {
        throw new ApplicationFormDomExtractionError("FORM_INSPECTION_INVALID");
      }
    }
    return ordered;
  };
  const retainElement = (handle: JSHandle): ElementHandle => {
    const element = handle.asElement();
    if (!element) throw new ApplicationFormDomExtractionError("FORM_INSPECTION_INVALID");
    temporaryHandles.delete(handle);
    retainedHandles.add(element);
    return element;
  };

  try {
    const compound = track(await page.mainFrame().evaluateHandle((limits) => {
      type ErrorCode =
        | "FORM_STRUCTURE_UNSUPPORTED"
        | "FORM_INSPECTION_OVERSIZE"
        | "FORM_INSPECTION_INVALID"
        | "EMPLOYER_AUTH_REQUIRED_UNSUPPORTED";
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

      const fail = [(code: ErrorCode): never => {
        throw new Error(`__APPLY_PILOT_SAFE_FORM_INSPECTION__${code}`);
      }][0];
      const encoder = new TextEncoder();
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
        if (element.matches("textarea,select,[contenteditable]")) return null;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let value = "";
        let codePoints = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const parent = node.parentElement;
          if (parent?.closest("script,style,template")) continue;
          const valueSurface = parent?.closest("input,textarea,select,[contenteditable]");
          if (valueSurface && element.contains(valueSurface)) continue;
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
          const target = document.getElementById(id);
          joined = appendJoinedText(joined, target ? boundedElementText(target, limit) : null, limit);
        }
        return joined;
      }][0];
      const directLegend = [(fieldset: HTMLFieldSetElement | null): HTMLLegendElement | null => {
        if (!fieldset) return null;
        for (const child of fieldset.children) {
          if (child instanceof HTMLLegendElement) return child;
        }
        return null;
      }][0];
      const nearestSection = [(control: Element, form: HTMLFormElement): HTMLFieldSetElement | null => {
        const fieldset = control.closest("fieldset");
        return fieldset instanceof HTMLFieldSetElement && fieldset.closest("form") === form ? fieldset : null;
      }][0];
      const semanticGroup = [(control: Element): Element | null =>
        control.closest('[role="group"],[role="radiogroup"]')][0];
      const groupBoundary = [(control: Element, form: HTMLFormElement): Element | null =>
        nearestSection(control, form) ?? semanticGroup(control)][0];

      const isVisible = [(element: Element): boolean => {
        if (!element.isConnected) return false;
        for (let current: Element | null = element; current; current = current.parentElement) {
          if (current.hasAttribute("hidden") || current.hasAttribute("inert")) return false;
          const style = getComputedStyle(current);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            Number.parseFloat(style.opacity) === 0
          ) return false;
        }
        return element.getClientRects().length > 0;
      }][0];
      const isEffectivelyDisabled = [(element: Element): boolean => element.matches(":disabled")][0];
      const inputKind = [(input: HTMLInputElement): string => input.type.toLowerCase()][0];
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
        if (includeRoot && root instanceof Element) visit(root);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node instanceof Element) visit(node);
        }
      }][0];
      const obviousInteractionRoles = new Set([
        "button", "checkbox", "combobox", "link", "radio", "textbox",
        "spinbutton", "slider", "listbox", "switch"
      ]);
      const isObviousInteraction = [(element: Element): boolean => {
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLButtonElement ||
          (element instanceof HTMLAnchorElement && element.hasAttribute("href"))
        ) return true;
        if (element instanceof HTMLElement && element.isContentEditable) return true;
        const role = element.getAttribute("role")?.trim().toLowerCase() ?? "";
        return obviousInteractionRoles.has(role) || (element instanceof HTMLElement && element.tabIndex >= 0);
      }][0];
      const isOrdinaryFormAction = [(element: Element): boolean => {
        const role = element.getAttribute("role")?.trim().toLowerCase() ?? "";
        return (
          (element instanceof HTMLButtonElement && (role === "" || role === "button")) ||
          (element instanceof HTMLAnchorElement && element.hasAttribute("href") && (role === "" || role === "link"))
        );
      }][0];
      const containsStrictInteraction = [(root: Element | ShadowRoot): boolean => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!(node instanceof Element) || !isVisible(node)) continue;
          if (node instanceof HTMLIFrameElement || isObviousInteraction(node)) return true;
        }
        return false;
      }][0];
      const assertInspectableCustomElement = [(element: Element): void => {
        const shadow = element.shadowRoot;
        if (shadow && containsStrictInteraction(shadow)) fail("FORM_STRUCTURE_UNSUPPORTED");
        if (!element.localName.includes("-")) return;
        const registered = customElements.get(element.localName) !== undefined;
        if ("form" in element || (registered && shadow === null)) {
          fail("FORM_STRUCTURE_UNSUPPORTED");
        }
      }][0];

      const wrappingLabel = [(control: Element): HTMLLabelElement | null => {
        const label = control.closest("label");
        return label instanceof HTMLLabelElement && label.control === control ? label : null;
      }][0];
      const questionFor = [(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string | null => {
        let explicit: string | null = null;
        for (const label of document.getElementsByTagName("label")) {
          if (label.hasAttribute("for") && label.control === control) {
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
        const section = members[0] instanceof Element ? members[0].closest("fieldset") : null;
        if (section instanceof HTMLFieldSetElement && members.every((member) => member.closest("fieldset") === section)) {
          const legend = directLegend(section);
          const legendText = legend ? boundedElementText(legend, limits.text.question) : null;
          if (legendText) return legendText;
        }
        const roleGroup = semanticGroup(members[0]);
        if (roleGroup && members.every((member) => semanticGroup(member) === roleGroup)) {
          return ariaReferencedText(roleGroup, "aria-labelledby", limits.text.question) ??
            boundedAttribute(roleGroup, "aria-label", limits.text.question);
        }
        if (boundary && (boundary.getAttribute("role") === "group" || boundary.getAttribute("role") === "radiogroup")) {
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
        if (!raw || raw.trim() === "") return { accepted: [], unknown: false };
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
      let retainedNativeControls = 0;
      visitElements(document, false, (element) => {
        if (!isQuestionLikeNative(element) || !isVisible(element)) return;
        if (element instanceof HTMLInputElement && inputKind(element) === "password") {
          fail("EMPLOYER_AUTH_REQUIRED_UNSUPPORTED");
        }
        const kind = element instanceof HTMLInputElement ? inputKind(element) : "";
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
      const referenceForms: Array<{ sections: Array<{ fields: Array<{ control: Element; choices: Element[] }> }> }> = [];

      for (const form of document.forms) {
        const nativeControls = nativeByForm.get(form);
        if (!nativeControls) continue;
        const nativeControlSet = new Set<Element>(nativeControls);
        const representableCustom = new Set<Element>();
        visitElements(form, false, (candidate) => {
          if (isNativeControl(candidate) || !isVisible(candidate)) return;
          const isCombobox = candidate.getAttribute("role")?.trim().toLowerCase() === "combobox";
          const isRichText = candidate instanceof HTMLElement && candidate.isContentEditable;
          if (!isCombobox && !isRichText) return;
          if (containsStrictInteraction(candidate)) fail("FORM_STRUCTURE_UNSUPPORTED");
          assertInspectableCustomElement(candidate);
          if (!questionForCustom(candidate)) fail("FORM_STRUCTURE_UNSUPPORTED");
          if (representableCustom.size >= limits.maxFieldsTotal) fail("FORM_INSPECTION_OVERSIZE");
          representableCustom.add(candidate);
        });

        const visibleRadios: HTMLInputElement[] = [];
        const visibleCheckboxes: HTMLInputElement[] = [];
        for (const control of nativeControls) {
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
          if (boundary && !form.contains(boundary)) completenessRoots.add(boundary);
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

        visitElements(document, false, (source) => {
          const includedNative = isNativeControl(source) && nativeControlSet.has(source);
          const includedCustom = representableCustom.has(source);
          if (!includedNative && !includedCustom) return;
          if (consumed.has(source)) return;
          if (!isNativeControl(source)) {
            const field = unsupportedField(
              questionForCustom(source),
              helpFor(source),
              source instanceof HTMLElement && source.isContentEditable ? "RICH_TEXT" : "CUSTOM_COMBOBOX",
              source.hasAttribute("required")
            );
            completenessRoots.add(source);
            addField({ field, control: source, choices: [], section: nearestSection(source, form) });
            return;
          }

          if (source instanceof HTMLInputElement && inputKind(source) === "radio") {
            const name = source.getAttribute("name") ?? "";
            if (!name) fail("FORM_STRUCTURE_UNSUPPORTED");
            const boundary = groupBoundary(source, form);
            if (!boundary) fail("FORM_STRUCTURE_UNSUPPORTED");
            const sameName: HTMLInputElement[] = [];
            for (const member of visibleRadios) {
              if ((member.getAttribute("name") ?? "") !== name) continue;
              if (groupBoundary(member, form) !== boundary) fail("FORM_STRUCTURE_UNSUPPORTED");
              if (sameName.length >= limits.maxChoicesPerField) fail("FORM_INSPECTION_OVERSIZE");
              sameName.push(member);
            }
            for (const member of sameName) consumed.add(member);
            if (sameName.every(isEffectivelyDisabled)) return;
            const question = groupQuestion(sameName, boundary);
            if (!question) fail("FORM_STRUCTURE_UNSUPPORTED");
            const choices: RawChoice[] = [];
            for (const member of sameName) {
              const label = questionFor(member);
              if (!label) fail("FORM_STRUCTURE_UNSUPPORTED");
              choices.push({ label: label as string, disabled: isEffectivelyDisabled(member) });
            }
            commitChoices(choices.length);
            addCompletenessRoot(boundary);
            addField({
              field: {
                question: question as string,
                helpText: helpFor(boundary as Element),
                fieldType: "RADIO_GROUP",
                unsupportedReason: null,
                required: sameName.some((member) => !isEffectivelyDisabled(member) && member.hasAttribute("required")),
                autocomplete: null,
                constraints: emptyConstraints(),
                choices
              },
              control: source,
              choices: sameName,
              section: nearestSection(source, form)
            });
            return;
          }

          if (source instanceof HTMLInputElement && inputKind(source) === "checkbox") {
            const name = source.getAttribute("name") ?? "";
            const boundary = groupBoundary(source, form);
            const sameGroup: HTMLInputElement[] = [];
            if (name) {
              for (const member of visibleCheckboxes) {
                if (
                  (member.getAttribute("name") ?? "") !== name ||
                  groupBoundary(member, form) !== boundary
                ) continue;
                if (sameGroup.length >= limits.maxChoicesPerField) fail("FORM_INSPECTION_OVERSIZE");
                sameGroup.push(member);
              }
            }
            const hasActiveMember = sameGroup.some((member) => !isEffectivelyDisabled(member));
            const groupTitle = sameGroup.length >= 2 ? groupQuestion(sameGroup, boundary) : null;
            if (sameGroup.length >= 2 && hasActiveMember && groupTitle) {
              const required = sameGroup[0].hasAttribute("required");
              if (sameGroup.some((member) => member.hasAttribute("required") !== required)) {
                fail("FORM_STRUCTURE_UNSUPPORTED");
              }
              for (const member of sameGroup) consumed.add(member);
              const choices: RawChoice[] = [];
              for (const member of sameGroup) {
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
              return;
            }
            if (isEffectivelyDisabled(source)) return;
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
            return;
          }

          const question = questionFor(source);
          const helpText = helpFor(source);
          const required = source.hasAttribute("required");
          const autocomplete = autocompleteFor(source);
          const section = nearestSection(source, form);

          if (source instanceof HTMLSelectElement) {
            const rawChoices: RawChoice[] = [];
            const choiceElements: Element[] = [];
            let invalidChoice = false;
            for (const option of source.options) {
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
                  fieldType: source.hasAttribute("multiple") ? "SELECT_MANY" : "SELECT_ONE",
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
            return;
          }

          if (source instanceof HTMLTextAreaElement) {
            const lengths = lengthConstraints(source);
            const field = lengths ? {
              question,
              helpText,
              fieldType: "TEXTAREA",
              unsupportedReason: null,
              required,
              autocomplete,
              constraints: { ...emptyConstraints(), ...lengths },
              choices: []
            } : unsupportedField(question, helpText, "UNSUPPORTED_CONTROL", required);
            addField({ field, control: source, choices: [], section });
            return;
          }

          const kind = inputKind(source);
          if (["text", "search", "email", "tel", "url"].includes(kind)) {
            const lengths = lengthConstraints(source);
            const mapped = kind === "search" ? "TEXT" : kind.toUpperCase();
            const field = lengths ? {
              question,
              helpText,
              fieldType: mapped,
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
        });

        if (formFieldCount === 0) continue;

        for (const root of completenessRoots) {
          visitElements(root, true, (element) => {
            if (!isVisible(element)) return;
            if (element instanceof HTMLIFrameElement) fail("FORM_STRUCTURE_UNSUPPORTED");
            if (isNativeControl(element)) return;
            assertInspectableCustomElement(element);
            if (representableCustom.has(element)) return;
            if (isObviousInteraction(element) && !isOrdinaryFormAction(element)) {
              fail("FORM_STRUCTURE_UNSUPPORTED");
            }
          });
        }

        const reportSections: Array<{ heading: string | null; fields: RawField[] }> = [];
        const referenceSections: Array<{ fields: Array<{ control: Element; choices: Element[] }> }> = [];
        for (const section of sectionOrder) {
          const sources = sectionFields.get(section) ?? [];
          const legend = directLegend(section);
          reportSections.push({
            heading: legend ? boundedElementText(legend, limits.text.formOrSection) : null,
            fields: sources.map((source) => source.field)
          });
          referenceSections.push({
            fields: sources.map((source) => ({ control: source.control, choices: source.choices }))
          });
        }
        reportForms.push({ title: formTitle(form), sections: reportSections });
        referenceForms.push({ sections: referenceSections });
      }

      return {
        report: { schemaVersion: limits.schemaVersion, forms: reportForms },
        references: { forms: referenceForms }
      };
    }, PAGE_LIMITS));

    const reportHandle = track(await compound.getProperty("report"));
    const rawReport = await reportHandle.jsonValue();
    const parsed = applicationFormInspectionReportSchema.safeParse(rawReport);
    if (!parsed.success) throw new ApplicationFormDomExtractionError("FORM_INSPECTION_INVALID");
    const report = parsed.data;

    const references = track(await compound.getProperty("references"));
    const formArray = track(await references.getProperty("forms"));
    const formHandles = await strictArrayProperties(formArray, report.forms.length);

    const fields: SafeDomFieldReference[] = [];
    for (const [formIndex, formHandle] of formHandles.entries()) {
      const sectionsHandle = track(await formHandle.getProperty("sections"));
      const sectionHandles = await strictArrayProperties(
        sectionsHandle,
        report.forms[formIndex].sections.length
      );
      for (const [sectionIndex, sectionHandle] of sectionHandles.entries()) {
        const fieldsHandle = track(await sectionHandle.getProperty("fields"));
        const fieldHandles = await strictArrayProperties(
          fieldsHandle,
          report.forms[formIndex].sections[sectionIndex].fields.length
        );
        for (const [fieldIndex, fieldHandle] of fieldHandles.entries()) {
          const controlHandle = track(await fieldHandle.getProperty("control"));
          const control = retainElement(controlHandle);
          const choicesHandle = track(await fieldHandle.getProperty("choices"));
          const choiceHandles = await strictArrayProperties(
            choicesHandle,
            report.forms[formIndex].sections[sectionIndex].fields[fieldIndex].choices.length
          );
          const choices = choiceHandles.map((choiceHandle, choiceIndex): SafeDomChoiceReference => ({
            sourceOrdinal: { form: formIndex, section: sectionIndex, field: fieldIndex, choice: choiceIndex },
            handle: retainElement(choiceHandle)
          }));
          fields.push({
            sourceOrdinal: { form: formIndex, section: sectionIndex, field: fieldIndex },
            handle: control,
            choices
          });
        }
      }
    }

    await disposeAll(temporaryHandles);
    temporaryHandles.clear();
    let disposed = false;
    return {
      report,
      fields,
      async dispose() {
        if (disposed) return;
        disposed = true;
        await disposeAll(retainedHandles);
        retainedHandles.clear();
      }
    };
  } catch (error) {
    await disposeAll(retainedHandles);
    await disposeAll(temporaryHandles);
    if (error instanceof ApplicationFormDomExtractionError) throw error;
    const code = extractionCodeFromError(error);
    throw new ApplicationFormDomExtractionError(code ?? "FORM_INSPECTION_INVALID");
  }
}
