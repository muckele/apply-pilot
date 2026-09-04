import { randomBytes } from "node:crypto";

import type { ElementHandle, Frame, Page } from "playwright";

export type FormFillPreWriteClassification =
  | "EMPTY" | "OCCUPIED" | "ALREADY_EQUAL" | "OCCUPIED_DIFFERENT"
  | "UNWRITABLE" | "INVALID" | "DETACHED" | "CAPABILITY_MISSING";

export type FormFillPostWriteVerification =
  | "MATCHED" | "MISMATCHED" | "INVALID" | "DETACHED" | "CAPABILITY_MISSING";

export type FormFillNativeWriteResult = "WRITTEN" | "REJECTED" | "CAPABILITY_MISSING";
export type TextLikeFieldType = "TEXT" | "EMAIL" | "TEL" | "URL" | "TEXTAREA";

type TextLikeShape = Readonly<{ element: "INPUT" | "TEXTAREA"; inputTypes: readonly string[] }>;
type ChoiceHandleGraph = Readonly<{ choiceHandles: readonly ElementHandle[]; proposedChoiceHandle: ElementHandle }>;

type TrustedFormFillDomCapability = Readonly<{
  version: "APPLY_PILOT_TRUSTED_FORM_FILL_DOM_V1";
  classifyTextLike(node: Node, shape: TextLikeShape): FormFillPreWriteClassification;
  writeTextLike(node: Node, shape: TextLikeShape, proposal: string): FormFillNativeWriteResult;
  verifyTextLike(node: Node, shape: TextLikeShape, proposal: string): FormFillPostWriteVerification;
  classifySelectOne(node: Node, choices: readonly Node[], proposed: Node): FormFillPreWriteClassification;
  writeSelectOne(node: Node, choices: readonly Node[], proposed: Node): FormFillNativeWriteResult;
  verifySelectOne(node: Node, choices: readonly Node[], proposed: Node): FormFillPostWriteVerification;
  classifyRadio(node: Node, choices: readonly Node[], proposed: Node): FormFillPreWriteClassification;
  verifyRadio(node: Node, choices: readonly Node[], proposed: Node): FormFillPostWriteVerification;
  classifyCheckbox(node: Node, proposal: boolean): FormFillPreWriteClassification;
  verifyCheckbox(node: Node): FormFillPostWriteVerification;
}>;

type TrustedFormFillPageRegistration = {
  capabilityKey: string;
  mainFrame: Frame;
  phase: "INSTALLING" | "AWAITING_NAVIGATION" | "READY" | "INVALID";
  navigationRaced: boolean;
};

const TRUSTED_CAPABILITY_KEY_PREFIX = "__applyPilotTrustedFormFillDomV1_";
const registeredCapabilityPages = new WeakMap<Page, TrustedFormFillPageRegistration>();

function trustedFormFillDomInit(capabilityKey: string): void {
  const globalObject = window;
  let trustedImplementation: TrustedFormFillDomCapability | null = null;
  const gate: TrustedFormFillDomCapability = Object.freeze({
    version: "APPLY_PILOT_TRUSTED_FORM_FILL_DOM_V1",
    classifyTextLike(node, shape) {
      return trustedImplementation === null ? "CAPABILITY_MISSING" : trustedImplementation.classifyTextLike(node, shape);
    },
    writeTextLike(node, shape, proposal) {
      return trustedImplementation === null ? "CAPABILITY_MISSING" : trustedImplementation.writeTextLike(node, shape, proposal);
    },
    verifyTextLike(node, shape, proposal) {
      return trustedImplementation === null ? "CAPABILITY_MISSING" : trustedImplementation.verifyTextLike(node, shape, proposal);
    },
    classifySelectOne(node, choices, proposed) {
      return trustedImplementation === null ? "CAPABILITY_MISSING" : trustedImplementation.classifySelectOne(node, choices, proposed);
    },
    writeSelectOne(node, choices, proposed) {
      return trustedImplementation === null ? "CAPABILITY_MISSING" : trustedImplementation.writeSelectOne(node, choices, proposed);
    },
    verifySelectOne(node, choices, proposed) {
      return trustedImplementation === null ? "CAPABILITY_MISSING" : trustedImplementation.verifySelectOne(node, choices, proposed);
    },
    classifyRadio(node, choices, proposed) {
      return trustedImplementation === null ? "CAPABILITY_MISSING" : trustedImplementation.classifyRadio(node, choices, proposed);
    },
    verifyRadio(node, choices, proposed) {
      return trustedImplementation === null ? "CAPABILITY_MISSING" : trustedImplementation.verifyRadio(node, choices, proposed);
    },
    classifyCheckbox(node, proposal) {
      return trustedImplementation === null ? "CAPABILITY_MISSING" : trustedImplementation.classifyCheckbox(node, proposal);
    },
    verifyCheckbox(node) {
      return trustedImplementation === null ? "CAPABILITY_MISSING" : trustedImplementation.verifyCheckbox(node);
    }
  });
  try {
    Object.defineProperty(globalObject, capabilityKey, {
      configurable: false, enumerable: false, writable: false, value: gate
    });
  } catch {
    return;
  }

  try {
  const nativeApply = Reflect.apply;
  const nativeConstruct = Reflect.construct;
  const nativeCreate = Object.create;
  const nativeDefineProperty = Object.defineProperty;
  const nativeFreeze = Object.freeze;
  const nativeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  const nativeGetPrototypeOf = Object.getPrototypeOf;

  const nodePrototype = Node.prototype;
  const elementPrototype = Element.prototype;
  const inputPrototype = HTMLInputElement.prototype;
  const textAreaPrototype = HTMLTextAreaElement.prototype;
  const selectPrototype = HTMLSelectElement.prototype;
  const optionPrototype = HTMLOptionElement.prototype;
  const optGroupPrototype = HTMLOptGroupElement.prototype;
  const formPrototype = HTMLFormElement.prototype;
  const collectionPrototype = HTMLCollection.prototype;
  const NativeEvent = Event;

  const isConnectedGet = nativeGetOwnPropertyDescriptor(nodePrototype, "isConnected")?.get;
  const parentElementGet = nativeGetOwnPropertyDescriptor(nodePrototype, "parentElement")?.get;
  const nativeMatches = elementPrototype.matches;
  const inputTypeGet = nativeGetOwnPropertyDescriptor(inputPrototype, "type")?.get;
  const inputReadOnlyGet = nativeGetOwnPropertyDescriptor(inputPrototype, "readOnly")?.get;
  const inputValueGet = nativeGetOwnPropertyDescriptor(inputPrototype, "value")?.get;
  const inputValueSet = nativeGetOwnPropertyDescriptor(inputPrototype, "value")?.set;
  const inputCheckedGet = nativeGetOwnPropertyDescriptor(inputPrototype, "checked")?.get;
  const inputNameGet = nativeGetOwnPropertyDescriptor(inputPrototype, "name")?.get;
  const inputFormGet = nativeGetOwnPropertyDescriptor(inputPrototype, "form")?.get;
  const textAreaReadOnlyGet = nativeGetOwnPropertyDescriptor(textAreaPrototype, "readOnly")?.get;
  const textAreaValueGet = nativeGetOwnPropertyDescriptor(textAreaPrototype, "value")?.get;
  const textAreaValueSet = nativeGetOwnPropertyDescriptor(textAreaPrototype, "value")?.set;
  const selectMultipleGet = nativeGetOwnPropertyDescriptor(selectPrototype, "multiple")?.get;
  const selectOptionsGet = nativeGetOwnPropertyDescriptor(selectPrototype, "options")?.get;
  const optionDisabledGet = nativeGetOwnPropertyDescriptor(optionPrototype, "disabled")?.get;
  const optionSelectedGet = nativeGetOwnPropertyDescriptor(optionPrototype, "selected")?.get;
  const optionSelectedSet = nativeGetOwnPropertyDescriptor(optionPrototype, "selected")?.set;
  const optionValueGet = nativeGetOwnPropertyDescriptor(optionPrototype, "value")?.get;
  const optGroupDisabledGet = nativeGetOwnPropertyDescriptor(optGroupPrototype, "disabled")?.get;
  const formElementsGet = nativeGetOwnPropertyDescriptor(formPrototype, "elements")?.get;
  const collectionLengthGet = nativeGetOwnPropertyDescriptor(collectionPrototype, "length")?.get;
  const collectionItem = collectionPrototype.item;
  const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;

  if (
    !isConnectedGet || !parentElementGet || typeof nativeMatches !== "function" ||
    !inputTypeGet || !inputReadOnlyGet || !inputValueGet || !inputValueSet || !inputCheckedGet ||
    !inputNameGet || !inputFormGet || !textAreaReadOnlyGet || !textAreaValueGet || !textAreaValueSet ||
    !selectMultipleGet || !selectOptionsGet || !optionDisabledGet || !optionSelectedGet ||
    !optionSelectedSet || !optionValueGet || !optGroupDisabledGet || !formElementsGet || !collectionLengthGet ||
    typeof collectionItem !== "function" || typeof nativeDispatchEvent !== "function"
  ) return;

  const eventInit = nativeCreate(null) as { bubbles?: boolean };
  nativeDefineProperty(eventInit, "bubbles", { configurable: false, enumerable: true, writable: false, value: true });
  nativeFreeze(eventInit);

  type BrowserIntrinsic = (...args: never[]) => unknown;
  const call = <T>(fn: unknown, receiver: unknown, args: readonly unknown[] = []): T =>
    nativeApply(fn as BrowserIntrinsic, receiver, args) as T;
  const hasPrototype = (value: unknown, expected: object): boolean => {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
    let current = nativeGetPrototypeOf(value);
    while (current !== null) {
      if (current === expected) return true;
      current = nativeGetPrototypeOf(current);
    }
    return false;
  };
  const connected = (node: Node): boolean => call<boolean>(isConnectedGet, node);
  const disabled = (element: Element): boolean => call<boolean>(nativeMatches, element, [":disabled"]);
  const nativeInputType = (value: unknown): string | null => {
    try {
      return call<string>(inputTypeGet, value);
    } catch {
      return null;
    }
  };
  const parentGroup = (option: HTMLOptionElement): HTMLOptGroupElement | null => {
    const parent = call<Element | null>(parentElementGet, option);
    return hasPrototype(parent, optGroupPrototype) ? parent as HTMLOptGroupElement : null;
  };
  const unavailableOption = (option: HTMLOptionElement): boolean => {
    if (call<boolean>(optionDisabledGet, option)) return true;
    const group = parentGroup(option);
    return group !== null && call<boolean>(optGroupDisabledGet, group);
  };
  const optionAt = (collection: object, index: number): Element | null =>
    call<Element | null>(collectionItem, collection, [index]);
  const createEvent = (type: "input" | "change"): Event =>
    nativeConstruct(NativeEvent, [type, eventInit]) as Event;
  const dispatch = (target: EventTarget, dispatched: Event): void => {
    call<boolean>(nativeDispatchEvent, target, [dispatched]);
  };

  const acceptsInputType = (node: Node, shape: TextLikeShape): boolean => {
    const type = call<string>(inputTypeGet, node);
    for (let index = 0; index < shape.inputTypes.length; index += 1) {
      if (shape.inputTypes[index] === type) return true;
    }
    return false;
  };
  const classifyTextLike = (node: Node, shape: TextLikeShape): FormFillPreWriteClassification => {
    if (!connected(node)) return "DETACHED";
    const input = hasPrototype(node, inputPrototype);
    const textArea = hasPrototype(node, textAreaPrototype);
    if (shape.element === "TEXTAREA" ? !textArea : !input) return "INVALID";
    if (input) {
      if (!acceptsInputType(node, shape)) return "INVALID";
      if (disabled(node as HTMLInputElement) || call<boolean>(inputReadOnlyGet, node)) return "UNWRITABLE";
      return call<string>(inputValueGet, node).length === 0 ? "EMPTY" : "OCCUPIED";
    }
    if (disabled(node as HTMLTextAreaElement) || call<boolean>(textAreaReadOnlyGet, node)) return "UNWRITABLE";
    return call<string>(textAreaValueGet, node).length === 0 ? "EMPTY" : "OCCUPIED";
  };
  const verifyTextLike = (node: Node, shape: TextLikeShape, proposal: string): FormFillPostWriteVerification => {
    if (!connected(node)) return "DETACHED";
    const input = hasPrototype(node, inputPrototype);
    const textArea = hasPrototype(node, textAreaPrototype);
    if (shape.element === "TEXTAREA" ? !textArea : !input) return "INVALID";
    if (input) {
      if (!acceptsInputType(node, shape)) return "INVALID";
      return call<string>(inputValueGet, node) === proposal ? "MATCHED" : "MISMATCHED";
    }
    return call<string>(textAreaValueGet, node) === proposal ? "MATCHED" : "MISMATCHED";
  };

  const exactGraph = (
    node: Node, choices: readonly Node[], proposed: Node, kind: "SELECT" | "RADIO"
  ): FormFillPreWriteClassification | null => {
    if (!connected(node)) return "DETACHED";
    let containsNode = false;
    let containsProposed = false;
    for (let index = 0; index < choices.length; index += 1) {
      const choice = choices[index];
      if (!connected(choice)) return "DETACHED";
      if (choice === node) containsNode = true;
      if (choice === proposed) containsProposed = true;
      for (let prior = 0; prior < index; prior += 1) if (choices[prior] === choice) return "INVALID";
      if (kind === "SELECT" && !hasPrototype(choice, optionPrototype)) return "INVALID";
      if (kind === "RADIO" && (!hasPrototype(choice, inputPrototype) || nativeInputType(choice) !== "radio")) {
        return "INVALID";
      }
    }
    if (choices.length === 0 || !containsProposed || (kind === "RADIO" && !containsNode)) return "INVALID";
    return null;
  };
  const selectStructure = (
    node: Node, choices: readonly Node[], proposed: Node
  ): FormFillPreWriteClassification | null => {
    const graph = exactGraph(node, choices, proposed, "SELECT");
    if (graph) return graph;
    if (!hasPrototype(node, selectPrototype) || call<boolean>(selectMultipleGet, node)) return "INVALID";
    if (disabled(node as HTMLSelectElement)) return "UNWRITABLE";
    const options = call<HTMLCollection>(selectOptionsGet, node);
    const length = call<number>(collectionLengthGet, options);
    if (length !== choices.length) return "DETACHED";
    for (let index = 0; index < length; index += 1) if (optionAt(options, index) !== choices[index]) return "DETACHED";
    if (unavailableOption(proposed as HTMLOptionElement)) return "UNWRITABLE";
    return null;
  };
  const classifySelectOne = (
    node: Node, choices: readonly Node[], proposed: Node
  ): FormFillPreWriteClassification => {
    const structure = selectStructure(node, choices, proposed);
    if (structure) return structure;
    const options = call<HTMLCollection>(selectOptionsGet, node);
    const length = call<number>(collectionLengthGet, options);
    let selected: HTMLOptionElement | null = null;
    let selectedCount = 0;
    for (let index = 0; index < length; index += 1) {
      const option = optionAt(options, index) as HTMLOptionElement;
      if (call<boolean>(optionSelectedGet, option)) {
        selected = option;
        selectedCount += 1;
      }
    }
    if (selectedCount !== 1 || selected === null) return "INVALID";
    const disabledEmptyPlaceholder =
      call<boolean>(optionDisabledGet, selected) && call<string>(optionValueGet, selected).length === 0;
    return disabledEmptyPlaceholder ? "EMPTY" : "OCCUPIED";
  };
  const verifySelectOne = (
    node: Node, choices: readonly Node[], proposed: Node
  ): FormFillPostWriteVerification => {
    const structure = selectStructure(node, choices, proposed);
    if (structure === "DETACHED") return "DETACHED";
    if (structure) return "INVALID";
    let count = 0;
    let proposedSelected = false;
    for (let index = 0; index < choices.length; index += 1) {
      const selected = call<boolean>(optionSelectedGet, choices[index]);
      if (selected) count += 1;
      if (choices[index] === proposed) proposedSelected = selected;
    }
    return proposedSelected && count === 1 ? "MATCHED" : "MISMATCHED";
  };

  const radioStructure = (
    node: Node, choices: readonly Node[], proposed: Node
  ): FormFillPreWriteClassification | null => {
    const graph = exactGraph(node, choices, proposed, "RADIO");
    if (graph) return graph;
    const firstName = call<string>(inputNameGet, choices[0]);
    const firstForm = call<HTMLFormElement | null>(inputFormGet, choices[0]);
    if (firstName.length === 0) return "INVALID";
    for (let index = 1; index < choices.length; index += 1) {
      if (call<string>(inputNameGet, choices[index]) !== firstName ||
        call<HTMLFormElement | null>(inputFormGet, choices[index]) !== firstForm) return "INVALID";
    }
    if (firstForm === null) return "INVALID";
    const controls = call<HTMLFormControlsCollection>(formElementsGet, firstForm);
    const controlCount = call<number>(collectionLengthGet, controls);
    let currentGroupCount = 0;
    for (let index = 0; index < controlCount; index += 1) {
      const control = optionAt(controls, index);
      if (nativeInputType(control) !== "radio" || call<string>(inputNameGet, control) !== firstName) continue;
      currentGroupCount += 1;
      let retained = false;
      for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
        if (choices[choiceIndex] === control) retained = true;
      }
      if (!retained) return "DETACHED";
    }
    if (currentGroupCount !== choices.length) return "DETACHED";
    if (disabled(proposed as HTMLInputElement)) return "UNWRITABLE";
    return null;
  };
  const classifyRadio = (
    node: Node, choices: readonly Node[], proposed: Node
  ): FormFillPreWriteClassification => {
    const structure = radioStructure(node, choices, proposed);
    if (structure) return structure;
    for (let index = 0; index < choices.length; index += 1) {
      if (call<boolean>(inputCheckedGet, choices[index])) return "OCCUPIED";
    }
    return "EMPTY";
  };
  const verifyRadio = (
    node: Node, choices: readonly Node[], proposed: Node
  ): FormFillPostWriteVerification => {
    const structure = radioStructure(node, choices, proposed);
    if (structure === "DETACHED") return "DETACHED";
    if (structure) return "INVALID";
    let count = 0;
    let proposedSelected = false;
    for (let index = 0; index < choices.length; index += 1) {
      const selected = call<boolean>(inputCheckedGet, choices[index]);
      if (selected) count += 1;
      if (choices[index] === proposed) proposedSelected = selected;
    }
    return proposedSelected && count === 1 ? "MATCHED" : "MISMATCHED";
  };

  trustedImplementation = nativeFreeze({
    version: "APPLY_PILOT_TRUSTED_FORM_FILL_DOM_V1",
    classifyTextLike,
    writeTextLike(node, shape, proposal) {
      const classification = classifyTextLike(node, shape);
      if (classification === "CAPABILITY_MISSING") return classification;
      if (classification !== "EMPTY") return "REJECTED";
      if (shape.element === "TEXTAREA") call<void>(textAreaValueSet, node, [proposal]);
      else call<void>(inputValueSet, node, [proposal]);
      dispatch(node, createEvent("input"));
      return "WRITTEN";
    },
    verifyTextLike,
    classifySelectOne,
    writeSelectOne(node, choices, proposed) {
      const classification = classifySelectOne(node, choices, proposed);
      if (classification === "CAPABILITY_MISSING") return classification;
      if (classification !== "EMPTY") return "REJECTED";
      for (let index = 0; index < choices.length; index += 1) {
        call<void>(optionSelectedSet, choices[index], [choices[index] === proposed]);
      }
      dispatch(node, createEvent("input"));
      dispatch(node, createEvent("change"));
      return "WRITTEN";
    },
    verifySelectOne,
    classifyRadio,
    verifyRadio,
    classifyCheckbox(node, proposal) {
      if (!connected(node)) return "DETACHED";
      if (!hasPrototype(node, inputPrototype) || call<string>(inputTypeGet, node) !== "checkbox") return "INVALID";
      if (disabled(node as HTMLInputElement)) return "UNWRITABLE";
      const current = call<boolean>(inputCheckedGet, node);
      if (!current && proposal) return "EMPTY";
      if (current === proposal) return "ALREADY_EQUAL";
      return "OCCUPIED_DIFFERENT";
    },
    verifyCheckbox(node) {
      if (!connected(node)) return "DETACHED";
      if (!hasPrototype(node, inputPrototype) || call<string>(inputTypeGet, node) !== "checkbox") return "INVALID";
      return call<boolean>(inputCheckedGet, node) ? "MATCHED" : "MISMATCHED";
    }
  });
  } catch {
    trustedImplementation = null;
  }
}

export async function installTrustedFormFillDomCapability(page: Page): Promise<void> {
  const mainFrame = page.mainFrame();
  if (page.url() !== "about:blank" || mainFrame.url() !== "about:blank" || registeredCapabilityPages.has(page)) {
    throw new Error("FORM_FILL_CAPABILITY_REQUIRES_FRESH_PAGE");
  }
  const registration: TrustedFormFillPageRegistration = {
    capabilityKey: `${TRUSTED_CAPABILITY_KEY_PREFIX}${randomBytes(24).toString("hex")}`,
    mainFrame,
    phase: "INSTALLING",
    navigationRaced: false
  };
  const onFrameNavigated = (frame: Frame): void => {
    if (frame === mainFrame && registration.phase === "INSTALLING") registration.navigationRaced = true;
  };
  const onDomContentLoaded = (): void => {
    if (registration.phase === "AWAITING_NAVIGATION" && !page.url().startsWith("about:blank")) {
      registration.phase = "READY";
    }
  };
  registeredCapabilityPages.set(page, registration);
  page.on("framenavigated", onFrameNavigated);
  page.on("domcontentloaded", onDomContentLoaded);
  const initializer = trustedFormFillDomInit.toString();
  const content = `{ const __name = (target) => target; (${initializer})(${JSON.stringify(registration.capabilityKey)}); }`;
  try {
    await page.addInitScript({ content });
  } catch (error) {
    registration.phase = "INVALID";
    registeredCapabilityPages.delete(page);
    page.off("framenavigated", onFrameNavigated);
    page.off("domcontentloaded", onDomContentLoaded);
    throw error;
  }
  page.off("framenavigated", onFrameNavigated);
  if (registration.navigationRaced) {
    registration.phase = "INVALID";
    registeredCapabilityPages.delete(page);
    page.off("domcontentloaded", onDomContentLoaded);
    throw new Error("FORM_FILL_CAPABILITY_INSTALLATION_NAVIGATION_RACE");
  }
  registration.phase = "AWAITING_NAVIGATION";
}

async function capabilityKeyForHandles(handles: readonly ElementHandle[]): Promise<string | null> {
  try {
    let capabilityKey: string | null = null;
    for (let index = 0; index < handles.length; index += 1) {
      const frame = await handles[index].ownerFrame();
      if (frame === null) return null;
      const page = frame.page();
      const registration = registeredCapabilityPages.get(page);
      if (!registration || registration.phase !== "READY" || frame !== registration.mainFrame ||
        page.mainFrame() !== registration.mainFrame) return null;
      if (capabilityKey !== null && capabilityKey !== registration.capabilityKey) return null;
      capabilityKey = registration.capabilityKey;
    }
    return capabilityKey;
  } catch {
    return null;
  }
}

function graphHandles(handle: ElementHandle, graph: ChoiceHandleGraph): ElementHandle[] {
  const handles = [handle];
  for (let index = 0; index < graph.choiceHandles.length; index += 1) handles.push(graph.choiceHandles[index]);
  handles.push(graph.proposedChoiceHandle);
  return handles;
}

export async function authorizeTrustedFormFillHandles(handles: readonly ElementHandle[]): Promise<boolean> {
  return await capabilityKeyForHandles(handles) !== null;
}

function textLikeShape(fieldType: TextLikeFieldType): TextLikeShape {
  if (fieldType === "TEXTAREA") return { element: "TEXTAREA", inputTypes: [] };
  return { element: "INPUT", inputTypes: fieldType === "TEXT" ? ["text", "search"] : [fieldType.toLowerCase()] };
}

export async function classifyTextLikeControl(handle: ElementHandle, fieldType: TextLikeFieldType): Promise<FormFillPreWriteClassification> {
  const capabilityKey = await capabilityKeyForHandles([handle]);
  if (capabilityKey === null) return "CAPABILITY_MISSING";
  return handle.evaluate((node, input) => {
    const capability = (window as unknown as Record<string, TrustedFormFillDomCapability | undefined>)[input.capabilityKey];
    if (!capability || typeof capability.classifyTextLike !== "function") return "CAPABILITY_MISSING";
    return capability.classifyTextLike(node, input.shape);
  }, { capabilityKey, shape: textLikeShape(fieldType) });
}

export async function writeNativeValueInput(handle: ElementHandle, fieldType: TextLikeFieldType, proposal: string): Promise<FormFillNativeWriteResult> {
  const capabilityKey = await capabilityKeyForHandles([handle]);
  if (capabilityKey === null) return "CAPABILITY_MISSING";
  return handle.evaluate((node, input) => {
    const capability = (window as unknown as Record<string, TrustedFormFillDomCapability | undefined>)[input.capabilityKey];
    if (!capability || typeof capability.writeTextLike !== "function") return "CAPABILITY_MISSING";
    return capability.writeTextLike(node, input.shape, input.proposal);
  }, { capabilityKey, shape: textLikeShape(fieldType), proposal });
}

export async function verifyTextLikeControl(handle: ElementHandle, fieldType: TextLikeFieldType, proposal: string): Promise<FormFillPostWriteVerification> {
  const capabilityKey = await capabilityKeyForHandles([handle]);
  if (capabilityKey === null) return "CAPABILITY_MISSING";
  return handle.evaluate((node, input) => {
    const capability = (window as unknown as Record<string, TrustedFormFillDomCapability | undefined>)[input.capabilityKey];
    if (!capability || typeof capability.verifyTextLike !== "function") return "CAPABILITY_MISSING";
    return capability.verifyTextLike(node, input.shape, input.proposal);
  }, { capabilityKey, shape: textLikeShape(fieldType), proposal });
}

export async function classifySelectOneControl(handle: ElementHandle, graph: ChoiceHandleGraph): Promise<FormFillPreWriteClassification> {
  const capabilityKey = await capabilityKeyForHandles(graphHandles(handle, graph));
  if (capabilityKey === null) return "CAPABILITY_MISSING";
  return handle.evaluate((node, input) => {
    const capability = (window as unknown as Record<string, TrustedFormFillDomCapability | undefined>)[input.capabilityKey];
    if (!capability || typeof capability.classifySelectOne !== "function") return "CAPABILITY_MISSING";
    return capability.classifySelectOne(node, input.choiceHandles, input.proposedChoiceHandle);
  }, { capabilityKey, ...graph });
}

export async function writeNativeOptionInputChange(handle: ElementHandle, graph: ChoiceHandleGraph): Promise<FormFillNativeWriteResult> {
  const capabilityKey = await capabilityKeyForHandles(graphHandles(handle, graph));
  if (capabilityKey === null) return "CAPABILITY_MISSING";
  return handle.evaluate((node, input) => {
    const capability = (window as unknown as Record<string, TrustedFormFillDomCapability | undefined>)[input.capabilityKey];
    if (!capability || typeof capability.writeSelectOne !== "function") return "CAPABILITY_MISSING";
    return capability.writeSelectOne(node, input.choiceHandles, input.proposedChoiceHandle);
  }, { capabilityKey, ...graph });
}

export async function verifySelectOneControl(handle: ElementHandle, graph: ChoiceHandleGraph): Promise<FormFillPostWriteVerification> {
  const capabilityKey = await capabilityKeyForHandles(graphHandles(handle, graph));
  if (capabilityKey === null) return "CAPABILITY_MISSING";
  return handle.evaluate((node, input) => {
    const capability = (window as unknown as Record<string, TrustedFormFillDomCapability | undefined>)[input.capabilityKey];
    if (!capability || typeof capability.verifySelectOne !== "function") return "CAPABILITY_MISSING";
    return capability.verifySelectOne(node, input.choiceHandles, input.proposedChoiceHandle);
  }, { capabilityKey, ...graph });
}

export async function classifyRadioGroup(handle: ElementHandle, graph: ChoiceHandleGraph): Promise<FormFillPreWriteClassification> {
  const capabilityKey = await capabilityKeyForHandles(graphHandles(handle, graph));
  if (capabilityKey === null) return "CAPABILITY_MISSING";
  return handle.evaluate((node, input) => {
    const capability = (window as unknown as Record<string, TrustedFormFillDomCapability | undefined>)[input.capabilityKey];
    if (!capability || typeof capability.classifyRadio !== "function") return "CAPABILITY_MISSING";
    return capability.classifyRadio(node, input.choiceHandles, input.proposedChoiceHandle);
  }, { capabilityKey, ...graph });
}

export async function verifyRadioGroup(handle: ElementHandle, graph: ChoiceHandleGraph): Promise<FormFillPostWriteVerification> {
  const capabilityKey = await capabilityKeyForHandles(graphHandles(handle, graph));
  if (capabilityKey === null) return "CAPABILITY_MISSING";
  return handle.evaluate((node, input) => {
    const capability = (window as unknown as Record<string, TrustedFormFillDomCapability | undefined>)[input.capabilityKey];
    if (!capability || typeof capability.verifyRadio !== "function") return "CAPABILITY_MISSING";
    return capability.verifyRadio(node, input.choiceHandles, input.proposedChoiceHandle);
  }, { capabilityKey, ...graph });
}

export async function classifyCheckboxBoolean(handle: ElementHandle, proposal: boolean): Promise<FormFillPreWriteClassification> {
  const capabilityKey = await capabilityKeyForHandles([handle]);
  if (capabilityKey === null) return "CAPABILITY_MISSING";
  return handle.evaluate((node, input) => {
    const capability = (window as unknown as Record<string, TrustedFormFillDomCapability | undefined>)[input.capabilityKey];
    if (!capability || typeof capability.classifyCheckbox !== "function") return "CAPABILITY_MISSING";
    return capability.classifyCheckbox(node, input.proposal);
  }, { capabilityKey, proposal });
}

export async function verifyCheckboxBoolean(handle: ElementHandle): Promise<FormFillPostWriteVerification> {
  const capabilityKey = await capabilityKeyForHandles([handle]);
  if (capabilityKey === null) return "CAPABILITY_MISSING";
  return handle.evaluate((node, key) => {
    const capability = (window as unknown as Record<string, TrustedFormFillDomCapability | undefined>)[key];
    if (!capability || typeof capability.verifyCheckbox !== "function") return "CAPABILITY_MISSING";
    return capability.verifyCheckbox(node);
  }, capabilityKey);
}
