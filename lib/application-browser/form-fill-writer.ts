import type { ElementHandle } from "playwright";

import {
  authorizeTrustedFormFillHandles,
  classifyCheckboxBoolean,
  classifyRadioGroup,
  classifySelectOneControl,
  classifyTextLikeControl,
  verifyCheckboxBoolean,
  verifyRadioGroup,
  verifySelectOneControl,
  verifyTextLikeControl,
  writeNativeOptionInputChange,
  writeNativeValueInput,
  type TextLikeFieldType
} from "@/lib/application-browser/form-fill-dom";
import {
  parseApplicationAnswerProposal,
  type ApplicationAnswerProposal
} from "@/lib/application-runs/answer-packet-domain";
import type { FillErrorCode, FillStepResult } from "@/lib/application-runs/fill-attempt-domain";

type ScalarProposal = Extract<ApplicationAnswerProposal, { kind: "SCALAR" }>;
type BooleanProposal = Extract<ApplicationAnswerProposal, { kind: "BOOLEAN" }>;
type OptionsProposal = Extract<ApplicationAnswerProposal, { kind: "OPTIONS" }>;

type TextLikeWriteInput = Readonly<{
  fieldType: TextLikeFieldType;
  handle: ElementHandle;
  proposal: ApplicationAnswerProposal;
}>;

type ChoiceWriteInput = Readonly<{
  fieldType: "SELECT_ONE" | "RADIO_GROUP";
  handle: ElementHandle;
  choiceHandles: readonly ElementHandle[];
  proposedChoiceHandle: ElementHandle;
  proposal: ApplicationAnswerProposal;
}>;

type CheckboxWriteInput = Readonly<{
  fieldType: "CHECKBOX_BOOLEAN";
  handle: ElementHandle;
  proposal: ApplicationAnswerProposal;
}>;

export type ApplicationFormFieldWriteInput = TextLikeWriteInput | ChoiceWriteInput | CheckboxWriteInput;

type TerminalWriterResult = Extract<FillStepResult, "FILLED" | "PRESERVED_EXISTING" | "MANUAL">;
type WriterErrorCode = Extract<FillErrorCode, "FILL_UNEXPECTED_MUTATION" | "FILL_WRITE_FAILED" | "FILL_INTERNAL">;

export type ApplicationFormFieldWriteResult =
  | Readonly<{ result: TerminalWriterResult; errorCode: null }>
  | Readonly<{ result: "FAILED"; errorCode: WriterErrorCode }>;

const FILLED = { result: "FILLED", errorCode: null } as const;
const PRESERVED = { result: "PRESERVED_EXISTING", errorCode: null } as const;
const MANUAL = { result: "MANUAL", errorCode: null } as const;
const INTERNAL = { result: "FAILED", errorCode: "FILL_INTERNAL" } as const;
const WRITE_FAILED = { result: "FAILED", errorCode: "FILL_WRITE_FAILED" } as const;
const UNEXPECTED_MUTATION = { result: "FAILED", errorCode: "FILL_UNEXPECTED_MUTATION" } as const;

function isScalarProposal(proposal: ApplicationAnswerProposal): proposal is ScalarProposal {
  return proposal.kind === "SCALAR";
}

function isBooleanProposal(proposal: ApplicationAnswerProposal): proposal is BooleanProposal {
  return proposal.kind === "BOOLEAN";
}

function isSingleOptionProposal(proposal: ApplicationAnswerProposal): proposal is OptionsProposal {
  return proposal.kind === "OPTIONS" && proposal.optionKeys.length === 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isElementHandle(value: unknown): value is ElementHandle {
  return isRecord(value) && typeof value.ownerFrame === "function" &&
    typeof value.evaluate === "function" && typeof value.check === "function";
}

function hasChoiceGraphMaterial(input: Record<string, unknown>): boolean {
  return "choiceHandles" in input || "proposedChoiceHandle" in input;
}

function ownDataValue(input: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function validateRuntimeInput(input: unknown): ApplicationFormFieldWriteInput | null {
  if (!isRecord(input)) return null;
  const fieldType = ownDataValue(input, "fieldType");
  const handle = ownDataValue(input, "handle");
  const proposal = ownDataValue(input, "proposal") as ApplicationAnswerProposal;
  if (typeof fieldType !== "string" || !isElementHandle(handle) || proposal === undefined) return null;

  switch (fieldType) {
    case "TEXT":
    case "EMAIL":
    case "TEL":
    case "URL":
    case "TEXTAREA":
      return hasChoiceGraphMaterial(input) ? null : Object.freeze({ fieldType, handle, proposal });
    case "CHECKBOX_BOOLEAN":
      return hasChoiceGraphMaterial(input) ? null : Object.freeze({ fieldType, handle, proposal });
    case "SELECT_ONE":
    case "RADIO_GROUP": {
      const choiceHandlesValue = ownDataValue(input, "choiceHandles");
      const proposedChoiceHandle = ownDataValue(input, "proposedChoiceHandle");
      if (
        !Array.isArray(choiceHandlesValue) || choiceHandlesValue.length === 0 ||
        Object.hasOwn(choiceHandlesValue, "every") || Object.hasOwn(choiceHandlesValue, "includes") ||
        !isElementHandle(proposedChoiceHandle)
      ) return null;
      const choiceHandles: ElementHandle[] = [];
      let containsHandle = false;
      let containsProposed = false;
      for (let index = 0; index < choiceHandlesValue.length; index += 1) {
        const choice = ownDataValue(choiceHandlesValue as unknown as Record<string, unknown>, String(index));
        if (!isElementHandle(choice)) return null;
        for (let prior = 0; prior < choiceHandles.length; prior += 1) {
          if (choiceHandles[prior] === choice) return null;
        }
        if (choice === handle) containsHandle = true;
        if (choice === proposedChoiceHandle) containsProposed = true;
        choiceHandles.push(choice);
      }
      if (!containsProposed || (fieldType === "RADIO_GROUP" && !containsHandle)) return null;
      return Object.freeze({
        fieldType,
        handle,
        choiceHandles: Object.freeze(choiceHandles),
        proposedChoiceHandle,
        proposal
      });
    }
    default:
      return null;
  }
}

function classifyStableState(classification: string): ApplicationFormFieldWriteResult | null {
  if (classification === "CAPABILITY_MISSING") return INTERNAL;
  if (classification === "OCCUPIED" || classification === "ALREADY_EQUAL") return PRESERVED;
  if (classification === "OCCUPIED_DIFFERENT" || classification === "UNWRITABLE") return MANUAL;
  if (classification === "DETACHED" || classification === "INVALID") return UNEXPECTED_MUTATION;
  return null;
}

function verifiedResult(verification: string): ApplicationFormFieldWriteResult {
  if (verification === "CAPABILITY_MISSING") return INTERNAL;
  return verification === "MATCHED" ? FILLED : UNEXPECTED_MUTATION;
}

export async function writeApplicationFormField(
  input: ApplicationFormFieldWriteInput
): Promise<ApplicationFormFieldWriteResult> {
  let runtimeInput: ApplicationFormFieldWriteInput;
  try {
    const validated = validateRuntimeInput(input);
    if (!validated) return INTERNAL;
    runtimeInput = validated;
  } catch {
    return INTERNAL;
  }

  let proposal: ApplicationAnswerProposal;
  try {
    proposal = parseApplicationAnswerProposal(runtimeInput.proposal);
  } catch {
    return INTERNAL;
  }
  try {
    switch (runtimeInput.fieldType) {
      case "TEXT":
      case "EMAIL":
      case "TEL":
      case "URL":
      case "TEXTAREA": {
        if (!isScalarProposal(proposal)) return INTERNAL;
        const classification = await classifyTextLikeControl(runtimeInput.handle, runtimeInput.fieldType);
        const terminal = classifyStableState(classification);
        if (terminal) return terminal;
        try {
          const write = await writeNativeValueInput(runtimeInput.handle, runtimeInput.fieldType, proposal.value);
          if (write === "CAPABILITY_MISSING") return INTERNAL;
          if (write !== "WRITTEN") return WRITE_FAILED;
        } catch {
          return WRITE_FAILED;
        }
        return verifiedResult(await verifyTextLikeControl(runtimeInput.handle, runtimeInput.fieldType, proposal.value));
      }
      case "SELECT_ONE": {
        if (!isSingleOptionProposal(proposal)) return INTERNAL;
        const graph = { choiceHandles: runtimeInput.choiceHandles, proposedChoiceHandle: runtimeInput.proposedChoiceHandle };
        const classification = await classifySelectOneControl(runtimeInput.handle, graph);
        const terminal = classifyStableState(classification);
        if (terminal) return terminal;
        try {
          const write = await writeNativeOptionInputChange(runtimeInput.handle, graph);
          if (write === "CAPABILITY_MISSING") return INTERNAL;
          if (write !== "WRITTEN") return WRITE_FAILED;
        } catch {
          return WRITE_FAILED;
        }
        return verifiedResult(await verifySelectOneControl(runtimeInput.handle, graph));
      }
      case "RADIO_GROUP": {
        if (!isSingleOptionProposal(proposal)) return INTERNAL;
        const graph = { choiceHandles: runtimeInput.choiceHandles, proposedChoiceHandle: runtimeInput.proposedChoiceHandle };
        const classification = await classifyRadioGroup(runtimeInput.handle, graph);
        const terminal = classifyStableState(classification);
        if (terminal) return terminal;
        if (!await authorizeTrustedFormFillHandles(runtimeInput.choiceHandles)) return INTERNAL;
        if (!await authorizeTrustedFormFillHandles([runtimeInput.proposedChoiceHandle])) return INTERNAL;
        try {
          await runtimeInput.proposedChoiceHandle.check();
        } catch {
          return WRITE_FAILED;
        }
        return verifiedResult(await verifyRadioGroup(runtimeInput.handle, graph));
      }
      case "CHECKBOX_BOOLEAN": {
        if (!isBooleanProposal(proposal)) return INTERNAL;
        const classification = await classifyCheckboxBoolean(runtimeInput.handle, proposal.value);
        const terminal = classifyStableState(classification);
        if (terminal) return terminal;
        if (!await authorizeTrustedFormFillHandles([runtimeInput.handle])) return INTERNAL;
        try {
          await runtimeInput.handle.check();
        } catch {
          return WRITE_FAILED;
        }
        return verifiedResult(await verifyCheckboxBoolean(runtimeInput.handle));
      }
    }
  } catch {
    return UNEXPECTED_MUTATION;
  }
  return INTERNAL;
}
