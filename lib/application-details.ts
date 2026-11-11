import { z } from "zod";

import {
  classifyApplicationQuestion,
  type ClassificationInput
} from "@/lib/application-runs/question-classification";
import { normalizeText } from "@/lib/normalize";

// D034: the applicant's own contact details and links, confirmed once and stored as unmasked
// Answer Vault rows, are the source Fill may use for matching contact and link fields.

export type ApplicationDetailKey =
  | "firstName"
  | "lastName"
  | "fullName"
  | "preferredName"
  | "email"
  | "phone"
  | "linkedin"
  | "github"
  | "website"
  | "portfolio";

export type ApplicationDetailCategory = "CONTACT" | "LINKS";
export type ApplicationDetailImportance = "required" | "recommended" | "optional";

export type ApplicationDetailField = Readonly<{
  key: ApplicationDetailKey;
  label: string;
  // The saved vault question. Fill re-classifies it, so it must map to `semanticFieldKey`.
  question: string;
  category: ApplicationDetailCategory;
  fieldType: ClassificationInput["fieldType"];
  semanticFieldKey: string;
  inputType: "text" | "email" | "tel" | "url";
  importance: ApplicationDetailImportance;
  placeholder: string;
}>;

export const APPLICATION_DETAIL_FIELDS: readonly ApplicationDetailField[] = [
  { key: "firstName", label: "First name", question: "First name", category: "CONTACT", fieldType: "TEXT", semanticFieldKey: "contact.name.given", inputType: "text", importance: "required", placeholder: "" },
  { key: "lastName", label: "Last name", question: "Last name", category: "CONTACT", fieldType: "TEXT", semanticFieldKey: "contact.name.family", inputType: "text", importance: "required", placeholder: "" },
  { key: "fullName", label: "Full name", question: "Full name", category: "CONTACT", fieldType: "TEXT", semanticFieldKey: "contact.name.full", inputType: "text", importance: "required", placeholder: "" },
  { key: "preferredName", label: "Preferred name", question: "Preferred name", category: "CONTACT", fieldType: "TEXT", semanticFieldKey: "contact.name.preferred", inputType: "text", importance: "optional", placeholder: "Only if it differs from your first name" },
  { key: "email", label: "Email address", question: "Email address", category: "CONTACT", fieldType: "EMAIL", semanticFieldKey: "contact.email", inputType: "email", importance: "required", placeholder: "you@example.com" },
  { key: "phone", label: "Phone number", question: "Phone number", category: "CONTACT", fieldType: "TEL", semanticFieldKey: "contact.phone", inputType: "tel", importance: "required", placeholder: "+1 555 555 0100" },
  { key: "linkedin", label: "LinkedIn profile", question: "LinkedIn profile URL", category: "LINKS", fieldType: "URL", semanticFieldKey: "professional.linkedin", inputType: "url", importance: "recommended", placeholder: "https://www.linkedin.com/in/…" },
  { key: "github", label: "GitHub profile", question: "GitHub profile URL", category: "LINKS", fieldType: "URL", semanticFieldKey: "professional.code_profile", inputType: "url", importance: "optional", placeholder: "https://github.com/…" },
  { key: "website", label: "Personal website", question: "Personal website URL", category: "LINKS", fieldType: "URL", semanticFieldKey: "professional.website", inputType: "url", importance: "optional", placeholder: "https://…" },
  { key: "portfolio", label: "Portfolio", question: "Portfolio URL", category: "LINKS", fieldType: "URL", semanticFieldKey: "professional.portfolio", inputType: "url", importance: "optional", placeholder: "https://…" }
];

export type ApplicationDetailRow = Readonly<{
  id: string;
  category: string;
  question: string;
  normalizedQuestion: string;
  answer: string;
  sensitive: boolean;
  isActive: boolean;
  updatedAt: Date;
}>;

export type ApplicationDetailStatus = "CONFIRMED" | "FROM_RESUME" | "NOT_USED" | "DUPLICATE" | "MISSING";

export type ApplicationDetailView = Readonly<{
  key: ApplicationDetailKey;
  label: string;
  inputType: ApplicationDetailField["inputType"];
  importance: ApplicationDetailImportance;
  placeholder: string;
  value: string;
  status: ApplicationDetailStatus;
}>;

export type ApplicationDetailsView = Readonly<{
  fields: ApplicationDetailView[];
  confirmedCount: number;
  // Labels of required details with no value from anywhere.
  missingRequired: string[];
}>;

function rowMatchesField(row: ApplicationDetailRow, field: ApplicationDetailField): boolean {
  if (row.category !== field.category) return false;
  try {
    const result = classifyApplicationQuestion({
      question: row.question,
      sectionHeading: null,
      helpText: null,
      autocomplete: null,
      fieldType: field.fieldType
    });
    return result.permittedDisposition === "PROPOSABLE" && result.semanticFieldKey === field.semanticFieldKey;
  } catch {
    return false;
  }
}

function isUsable(row: ApplicationDetailRow): boolean {
  return row.isActive && !row.sensitive;
}

function matchingRows(rows: readonly ApplicationDetailRow[], field: ApplicationDetailField): ApplicationDetailRow[] {
  // Usable rows first, then most recently updated, so the entry Fill uses is the one shown and kept.
  return rows
    .filter((row) => rowMatchesField(row, field))
    .sort(
      (left, right) =>
        Number(isUsable(right)) - Number(isUsable(left)) ||
        right.updatedAt.getTime() - left.updatedAt.getTime() ||
        left.id.localeCompare(right.id)
    );
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function withScheme(value: string): string {
  if (!value) return "";
  return /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value.replace(/^\/+/, "")}`;
}

export function resumeContactPrefill(contactInfo: unknown): Partial<Record<ApplicationDetailKey, string>> {
  if (!contactInfo || typeof contactInfo !== "object" || Array.isArray(contactInfo)) return {};
  const info = contactInfo as Record<string, unknown>;
  const name = text(info.name).replace(/\s+/g, " ");
  const parts = name ? name.split(" ") : [];
  const prefill: Partial<Record<ApplicationDetailKey, string>> = {
    fullName: name,
    firstName: parts.length > 1 ? parts[0] : name,
    lastName: parts.length > 1 ? parts[parts.length - 1] : "",
    email: text(info.email),
    phone: text(info.phone),
    linkedin: withScheme(text(info.linkedin)),
    github: withScheme(text(info.github)),
    portfolio: withScheme(text(info.portfolio))
  };
  return Object.fromEntries(Object.entries(prefill).filter(([, value]) => value)) as Partial<
    Record<ApplicationDetailKey, string>
  >;
}

export function buildApplicationDetailsView(input: {
  contactInfo: unknown;
  rows: readonly ApplicationDetailRow[];
}): ApplicationDetailsView {
  const fromResume = resumeContactPrefill(input.contactInfo);
  const fields = APPLICATION_DETAIL_FIELDS.map((field): ApplicationDetailView => {
    const matches = matchingRows(input.rows, field);
    const usable = matches.filter(isUsable);
    let value = "";
    let status: ApplicationDetailStatus = "MISSING";
    if (usable.length > 1) {
      value = usable[0].answer;
      status = "DUPLICATE";
    } else if (usable.length === 1) {
      value = usable[0].answer;
      status = "CONFIRMED";
    } else if (matches.length > 0) {
      value = matches[0].answer;
      status = "NOT_USED";
    } else if (fromResume[field.key]) {
      value = fromResume[field.key] ?? "";
      status = "FROM_RESUME";
    }
    return {
      key: field.key,
      label: field.label,
      inputType: field.inputType,
      importance: field.importance,
      placeholder: field.placeholder,
      value,
      status
    };
  });
  return {
    fields,
    confirmedCount: fields.filter((field) => field.status === "CONFIRMED").length,
    missingRequired: fields
      .filter((field) => field.importance === "required" && field.status === "MISSING")
      .map((field) => field.label)
  };
}

const nameSchema = z.string().trim().max(100);
const optionalUrl = (allowedHosts: readonly string[] | null) =>
  z
    .string()
    .trim()
    .max(300)
    .transform(withScheme)
    .refine((value) => {
      if (!value) return true;
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" && url.protocol !== "http:") return false;
        if (!allowedHosts) return true;
        const host = url.hostname.toLowerCase();
        return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
      } catch {
        return false;
      }
    }, "Enter a full web address.");

export const applicationDetailsInputSchema = z
  .object({
    firstName: nameSchema,
    lastName: nameSchema,
    fullName: z.string().trim().max(200),
    preferredName: nameSchema,
    email: z.union([z.literal(""), z.string().trim().max(254).email("Enter a valid email address.")]),
    phone: z
      .string()
      .trim()
      .max(30)
      .refine(
        (value) => !value || (/^\+?[0-9 ().-]+$/.test(value) && value.replace(/\D/g, "").length >= 7),
        "Enter a phone number using digits."
      ),
    linkedin: optionalUrl(["linkedin.com"]),
    github: optionalUrl(["github.com"]),
    website: optionalUrl(null),
    portfolio: optionalUrl(null)
  })
  .strict();

export type ApplicationDetailsInput = z.infer<typeof applicationDetailsInputSchema>;

export type ApplicationDetailCreate = Readonly<{
  category: ApplicationDetailCategory;
  question: string;
  normalizedQuestion: string;
  answer: string;
  sensitive: false;
  isActive: true;
}>;

export type ApplicationDetailUpdate = Readonly<{
  id: string;
  category: ApplicationDetailCategory;
  answer: string;
  sensitive: false;
  isActive: true;
}>;

export type ApplicationDetailsSavePlan = {
  creates: ApplicationDetailCreate[];
  updates: ApplicationDetailUpdate[];
  deactivateIds: string[];
};

export function planApplicationDetailsSave(
  input: ApplicationDetailsInput,
  rows: readonly ApplicationDetailRow[]
): ApplicationDetailsSavePlan {
  const plan: ApplicationDetailsSavePlan = { creates: [], updates: [], deactivateIds: [] };
  const claimed = new Set<string>();
  for (const field of APPLICATION_DETAIL_FIELDS) {
    const value = input[field.key];
    const matches = matchingRows(rows, field).filter((row) => !claimed.has(row.id));
    matches.forEach((row) => claimed.add(row.id));
    if (!value) {
      plan.deactivateIds.push(...matches.filter((row) => row.isActive).map((row) => row.id));
      continue;
    }
    const normalizedQuestion = normalizeText(field.question);
    const keep =
      matches[0] ??
      rows.find((row) => row.normalizedQuestion === normalizedQuestion && !claimed.has(row.id));
    if (keep) claimed.add(keep.id);
    plan.deactivateIds.push(...matches.filter((row) => row !== keep && row.isActive).map((row) => row.id));
    if (!keep) {
      plan.creates.push({
        category: field.category,
        question: field.question,
        normalizedQuestion,
        answer: value,
        sensitive: false,
        isActive: true
      });
      continue;
    }
    const unchanged =
      keep.answer === value && keep.category === field.category && isUsable(keep);
    if (!unchanged) {
      plan.updates.push({ id: keep.id, category: field.category, answer: value, sensitive: false, isActive: true });
    }
  }
  return plan;
}
