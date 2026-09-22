import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MULTI_OPTION_PROPOSAL_KEYS,
  MAX_SCALAR_PROPOSAL_CODE_POINTS,
  canonicalJson,
  canonicalizeApplicationAnswerPacketInputProjection,
  canonicalizeApplicationAnswerPacketProjection,
  computeApplicationAnswerPacketHash,
  computeApplicationAnswerPacketInputHash,
  computeApplicationAnswerPacketPolicyHash,
  computeApplicationAnswerProposalHash,
  computeApplicationAnswerSourceFingerprint,
  isApplicationAnswerProposalHashValid,
  parseApplicationAnswerProposal,
  parseCompatibleApplicationAnswerProposal,
  assertApplicationAnswerDispositionWithinPermitted,
  summarizeApplicationAnswerPacket
} from "@/lib/application-runs/answer-packet-domain";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);

function numberedHash(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function compatibilityContext(
  fieldType: "TEXT" | "SELECT_ONE" | "SELECT_MANY" | "CHECKBOX_BOOLEAN" | "CHECKBOX_GROUP" | "FILE_UPLOAD",
  semanticFieldKey: string | null,
  choices: readonly { key: string; disabled: boolean }[] = []
) {
  const identity = {
    normalizedFieldKey: HASH_D,
    fieldFingerprint: HASH_E,
    fieldType,
    semanticFieldKey
  };
  return {
    expectedField: identity,
    frozenField: { ...identity, choices }
  };
}

test("proposal branches are strict and scalar content remains exact", () => {
  const scalar = parseApplicationAnswerProposal({ kind: "SCALAR", value: "  Exact résumé value  " });
  assert.deepEqual(scalar, { kind: "SCALAR", value: "  Exact résumé value  " });
  for (const value of [
    "안녕하세요",
    "A\u034f\u0301",
    "ក\u17b4",
    "ᠠ\u180b",
    "می\u200cروم",
    "👩‍💻",
    "✈️",
    "🏴\u{e0067}\u{e0062}\u{e007f}",
    "⠋\u2800⠕"
  ]) {
    assert.deepEqual(parseApplicationAnswerProposal({ kind: "SCALAR", value }), {
      kind: "SCALAR",
      value
    });
  }
  assert.deepEqual(parseApplicationAnswerProposal({ kind: "BOOLEAN", value: false }), {
    kind: "BOOLEAN",
    value: false
  });

  for (const value of [
    { kind: "SCALAR", value: "value", extra: true },
    { kind: "BOOLEAN", value: "false" },
    { kind: "SCALAR", value: "   " },
    { kind: "SCALAR", value: "\u00ad" },
    { kind: "SCALAR", value: "visible\u00advalue" },
    { kind: "SCALAR", value: "\u115f" },
    { kind: "SCALAR", value: "visible\u115fvalue" },
    { kind: "SCALAR", value: "\u1160" },
    { kind: "SCALAR", value: "\u180e" },
    { kind: "SCALAR", value: "visible\u180evalue" },
    { kind: "SCALAR", value: "\u200b" },
    { kind: "SCALAR", value: "visible\u200bvalue" },
    { kind: "SCALAR", value: "\u2060" },
    { kind: "SCALAR", value: "visible\u2060value" },
    { kind: "SCALAR", value: "\u2061" },
    { kind: "SCALAR", value: "visible\u2064value" },
    { kind: "SCALAR", value: "\u2065" },
    { kind: "SCALAR", value: "\u206a" },
    { kind: "SCALAR", value: "visible\u206fvalue" },
    { kind: "SCALAR", value: "\u2800" },
    { kind: "SCALAR", value: "\u3164" },
    { kind: "SCALAR", value: "\ufeff" },
    { kind: "SCALAR", value: "visible\ufeffvalue" },
    { kind: "SCALAR", value: "\uffa0" },
    { kind: "SCALAR", value: "\u200c" },
    { kind: "SCALAR", value: "\u200d" },
    { kind: "SCALAR", value: "\u0301" },
    { kind: "SCALAR", value: "\ufe0f" },
    { kind: "SCALAR", value: "has\u202eoverride" },
    { kind: "SCALAR", value: "bad\ud800" },
    { kind: "SCALAR", value: "bad\udc00" },
    { kind: "SCALAR", value: "before\ud800after" },
    { kind: "SCALAR", value: "before\udc00after" },
    { kind: "UNKNOWN", value: "value" }
  ]) {
    assert.throws(() => parseApplicationAnswerProposal(value));
  }

  assert.doesNotThrow(() =>
    parseApplicationAnswerProposal({ kind: "SCALAR", value: "x".repeat(MAX_SCALAR_PROPOSAL_CODE_POINTS) })
  );
  assert.throws(() =>
    parseApplicationAnswerProposal({ kind: "SCALAR", value: "x".repeat(MAX_SCALAR_PROPOSAL_CODE_POINTS + 1) })
  );
  for (const value of ["e\u0301", "العَرَبِيَّة", "עברית", "👩‍💻", "می\u200cروم"]) {
    assert.deepEqual(parseApplicationAnswerProposal({ kind: "SCALAR", value }), {
      kind: "SCALAR",
      value
    });
  }
});

test("option proposals deduplicate and sort before enforcing the canonical limit", () => {
  assert.deepEqual(
    parseApplicationAnswerProposal({ kind: "OPTIONS", optionKeys: [HASH_B, HASH_A, HASH_B] }),
    { kind: "OPTIONS", optionKeys: [HASH_A, HASH_B] }
  );

  const maximum = Array.from({ length: MAX_MULTI_OPTION_PROPOSAL_KEYS }, (_, index) => numberedHash(index));
  assert.equal(
    (parseApplicationAnswerProposal({ kind: "OPTIONS", optionKeys: [...maximum].reverse() }) as {
      optionKeys: readonly string[];
    }).optionKeys.length,
    MAX_MULTI_OPTION_PROPOSAL_KEYS
  );
  assert.throws(() =>
    parseApplicationAnswerProposal({
      kind: "OPTIONS",
      optionKeys: Array.from({ length: MAX_MULTI_OPTION_PROPOSAL_KEYS + 1 }, (_, index) => numberedHash(index))
    })
  );
});

test("proposal compatibility enforces field kind, cardinality, membership, and disabled state", () => {
  const choices = [
    { key: HASH_A, disabled: false },
    { key: HASH_B, disabled: true }
  ];
  assert.deepEqual(
    parseCompatibleApplicationAnswerProposal(
      { kind: "OPTIONS", optionKeys: [HASH_A, HASH_A] },
      compatibilityContext("SELECT_ONE", null, choices)
    ),
    { kind: "OPTIONS", optionKeys: [HASH_A] }
  );
  assert.throws(() =>
    parseCompatibleApplicationAnswerProposal(
      { kind: "OPTIONS", optionKeys: [HASH_A, HASH_B] },
      compatibilityContext("SELECT_ONE", null, choices)
    )
  );
  assert.throws(() =>
    parseCompatibleApplicationAnswerProposal(
      { kind: "OPTIONS", optionKeys: [HASH_C] },
      compatibilityContext("SELECT_MANY", null, choices)
    )
  );
  assert.throws(() =>
    parseCompatibleApplicationAnswerProposal(
      { kind: "OPTIONS", optionKeys: [HASH_B] },
      compatibilityContext("CHECKBOX_GROUP", null, choices)
    )
  );
  assert.throws(() =>
    parseCompatibleApplicationAnswerProposal(
      { kind: "SCALAR", value: "yes" },
      compatibilityContext("CHECKBOX_BOOLEAN", null)
    )
  );
  assert.deepEqual(
    parseCompatibleApplicationAnswerProposal(
      { kind: "BOOLEAN", value: true },
      compatibilityContext("CHECKBOX_BOOLEAN", null)
    ),
    { kind: "BOOLEAN", value: true }
  );
});

test("document references use strict identifiers and bind artifact identity to the semantic field", () => {
  const resume = {
    kind: "DOCUMENT_REFERENCE",
    artifactType: "RESUME",
    documentId: "resume_123",
    contentHash: HASH_C
  } as const;
  assert.deepEqual(
    parseCompatibleApplicationAnswerProposal(
      resume,
      compatibilityContext("FILE_UPLOAD", "document.resume")
    ),
    resume
  );
  assert.throws(() =>
    parseCompatibleApplicationAnswerProposal(
      resume,
      compatibilityContext("FILE_UPLOAD", "document.cover_letter")
    )
  );
  assert.throws(() =>
    parseCompatibleApplicationAnswerProposal(resume, compatibilityContext("TEXT", "document.resume"))
  );
  assert.throws(() =>
    parseApplicationAnswerProposal({ ...resume, contentHash: HASH_C.toUpperCase() })
  );
  assert.throws(() => parseApplicationAnswerProposal({ ...resume, documentId: "../../resume" }));
});

test("the public compatibility boundary strictly binds expected and frozen field identity", () => {
  const proposal = { kind: "OPTIONS", optionKeys: [HASH_A] } as const;
  const valid = compatibilityContext("SELECT_ONE", null, [{ key: HASH_A, disabled: false }]);
  assert.deepEqual(parseCompatibleApplicationAnswerProposal(proposal, valid), proposal);

  for (const disabled of [undefined, null, 0, 1, "false", "true"]) {
    assert.throws(() =>
      parseCompatibleApplicationAnswerProposal(proposal, {
        ...valid,
        frozenField: {
          ...valid.frozenField,
          choices: [{ key: HASH_A, disabled }]
        }
      })
    );
  }

  for (const malformed of [
    { ...valid, unexpected: true },
    { ...valid, expectedField: { ...valid.expectedField, unexpected: true } },
    { ...valid, frozenField: { ...valid.frozenField, unexpected: true } },
    { ...valid, frozenField: { ...valid.frozenField, fieldType: "NOT_A_FIELD" } },
    { ...valid, frozenField: { ...valid.frozenField, semanticFieldKey: "Bad Key" } },
    {
      ...valid,
      frozenField: {
        ...valid.frozenField,
        choices: [
          { key: HASH_A, disabled: false },
          { key: HASH_A, disabled: false }
        ]
      }
    },
    {
      ...valid,
      frozenField: {
        ...valid.frozenField,
        choices: Array.from({ length: 257 }, (_, index) => ({
          key: numberedHash(1_000 + index),
          disabled: false
        }))
      }
    }
  ]) {
    assert.throws(() => parseCompatibleApplicationAnswerProposal(proposal, malformed));
  }

  for (const mismatched of [
    {
      ...valid,
      expectedField: { ...valid.expectedField, normalizedFieldKey: HASH_C }
    },
    {
      ...valid,
      expectedField: { ...valid.expectedField, fieldFingerprint: HASH_C }
    },
    {
      ...valid,
      expectedField: { ...valid.expectedField, fieldType: "SELECT_MANY" }
    },
    {
      ...valid,
      expectedField: { ...valid.expectedField, semanticFieldKey: "availability.schedule" }
    }
  ]) {
    assert.throws(() => parseCompatibleApplicationAnswerProposal(proposal, mismatched));
  }

  const otherField = compatibilityContext("SELECT_ONE", null, [{ key: HASH_B, disabled: false }]);
  assert.throws(() => parseCompatibleApplicationAnswerProposal(proposal, otherField));
});

test("canonical JSON sorts recursively and preserves exact Unicode and escaping", () => {
  assert.equal(
    canonicalJson({ z: 1, nested: { beta: true, alpha: "é" }, a: [null, "line\n\"quoted\""] }),
    "{\"a\":[null,\"line\\n\\\"quoted\\\"\"],\"nested\":{\"alpha\":\"é\",\"beta\":true},\"z\":1}"
  );
  assert.equal(canonicalJson({ value: "e\u0301" }), "{\"value\":\"é\"}");
  assert.notEqual(canonicalJson({ value: "é" }), canonicalJson({ value: "e\u0301" }));
  assert.equal(canonicalJson(Object.assign(Object.create(null), { b: 2, a: 1 })), "{\"a\":1,\"b\":2}");
});

test("canonical JSON rejects ambiguous or non-JSON JavaScript values", () => {
  const sparse = new Array(2);
  sparse[1] = "value";
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  class CustomValue {
    value = 1;
  }

  for (const value of [
    undefined,
    1n,
    NaN,
    Infinity,
    -Infinity,
    1.5,
    -0,
    sparse,
    cycle,
    new Date(0),
    new Map(),
    new Set(),
    new CustomValue(),
    { omitted: undefined },
    { malformed: "\ud800" }
  ]) {
    assert.throws(() => canonicalJson(value));
  }
});

test("canonical proposal hashes match fixed independent golden vectors", () => {
  const vectors: ReadonlyArray<readonly [unknown, string]> = [
    [
      { kind: "SCALAR", value: "Exact reviewed string" },
      "58e7f138acfc10cb70e3d4fe3debc676fde71e88ece5ae295e071ade58230f70"
    ],
    [
      { kind: "BOOLEAN", value: false },
      "5b4ae86cac7b933e027853dd0f9f9596df2c70d9607eab4e8b4e7419294d2177"
    ],
    [
      { kind: "OPTIONS", optionKeys: [HASH_B, HASH_A, HASH_B] },
      "997bce92e643eba03ef61db2c0bc367ef0c8f84be5469fe520ab995f5a008136"
    ],
    [
      {
        kind: "DOCUMENT_REFERENCE",
        artifactType: "RESUME",
        documentId: "resume_123",
        contentHash: HASH_C
      },
      "c9109ba9211da91455f698531b348ce7e479823573b9a397292500c9f1ba3fd2"
    ]
  ];
  for (const [proposal, expectedHash] of vectors) {
    assert.equal(computeApplicationAnswerProposalHash(proposal), expectedHash);
    assert.equal(isApplicationAnswerProposalHashValid(proposal, expectedHash), true);
  }
  assert.equal(isApplicationAnswerProposalHashValid(vectors[0][0], HASH_A), false);
  assert.equal(isApplicationAnswerProposalHashValid(vectors[0][0], HASH_A.toUpperCase()), false);
});

test("source fingerprints bind all provenance components without returning plaintext", () => {
  const input = {
    sourceType: "ANSWER_VAULT",
    sourceId: "vault_123",
    sourceRevision: "2026-08-25T12:00:00.000Z",
    sourceCategory: "LINKS",
    exactValue: "https://example.test/private-sentinel"
  } as const;
  const baseline = computeApplicationAnswerSourceFingerprint(input);
  assert.deepEqual(Object.keys(baseline), ["sourceFingerprint"]);
  assert.equal("exactValue" in baseline, false);
  assert.equal("exactValueDigest" in baseline, false);
  assert.match(baseline.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(baseline).includes("private-sentinel"), false);

  for (const change of [
    { sourceId: "vault_124" },
    { sourceRevision: "2026-08-25T12:00:01.000Z" },
    { sourceCategory: "AVAILABILITY" },
    { exactValue: "https://example.test/changed" }
  ]) {
    const changed = computeApplicationAnswerSourceFingerprint({ ...input, ...change });
    assert.notEqual(changed.sourceFingerprint, baseline.sourceFingerprint);
  }

  const vaultHashValue = computeApplicationAnswerSourceFingerprint({
    sourceType: "ANSWER_VAULT",
    sourceId: "shared_source",
    sourceRevision: "revision_1",
    sourceCategory: "LINKS",
    exactValue: HASH_C
  });
  const documentHashValue = computeApplicationAnswerSourceFingerprint({
    sourceType: "TAILORED_RESUME",
    sourceId: "shared_source",
    sourceRevision: "revision_1",
    sourceCategory: "TAILORED_RESUME",
    exactValue: HASH_C
  });
  assert.notEqual(vaultHashValue.sourceFingerprint, documentHashValue.sourceFingerprint);

  for (const sourceCategory of [
    "GENERAL",
    "OTHER",
    "EEO",
    "WORK_AUTHORIZATION",
    "COMPENSATION",
    "EXPERIENCE"
  ]) {
    assert.throws(() => computeApplicationAnswerSourceFingerprint({ ...input, sourceCategory }));
  }

  assert.doesNotThrow(() =>
    computeApplicationAnswerSourceFingerprint({
      sourceType: "TAILORED_RESUME",
      sourceId: "resume_123",
      sourceRevision: "revision_1",
      sourceCategory: "TAILORED_RESUME",
      exactValue: HASH_C
    })
  );
  assert.throws(() =>
    computeApplicationAnswerSourceFingerprint({
      sourceType: "TAILORED_RESUME",
      sourceId: "resume_123",
      sourceRevision: "revision_1",
      sourceCategory: "LINKS",
      exactValue: HASH_C
    })
  );
  for (const invisible of [
    "\u00ad",
    "\u115f",
    "\u1160",
    "\u180e",
    "\u200b",
    "\u2060",
    "\u2061",
    "\u2065",
    "\u206f",
    "\u2800",
    "\u3164",
    "\ufeff",
    "\uffa0"
  ]) {
    assert.throws(() => computeApplicationAnswerSourceFingerprint({ ...input, exactValue: invisible }));
  }
});

test("raw shape-only answer schemas are not public authority surfaces", async () => {
  const domain = await import("@/lib/application-runs/answer-packet-domain");
  for (const unsafeExport of [
    "applicationAnswerProposalSchema",
    "applicationAnswerPacketInputProjectionSchema",
    "applicationAnswerPacketProjectionSchema"
  ]) {
    assert.equal(unsafeExport in domain, false, unsafeExport);
  }
  assert.equal("parseApplicationAnswerProposal" in domain, true);
  assert.equal("canonicalizeApplicationAnswerPacketInputProjection" in domain, true);
  assert.equal("canonicalizeApplicationAnswerPacketProjection" in domain, true);
});

test("packet-relevant policy hash is strict, deterministic, and golden", () => {
  const policy = { schemaVersion: 1, sensitiveAnswerPolicy: "EXCLUDE", finalReviewRequired: true };
  assert.equal(
    computeApplicationAnswerPacketPolicyHash(policy),
    "0e765cd2905147c36d9560f6cf4e2536ef379b2d19c65593834b4f3e2b511b0e"
  );
  assert.equal(computeApplicationAnswerPacketPolicyHash({ ...policy }), computeApplicationAnswerPacketPolicyHash(policy));
  assert.throws(() => computeApplicationAnswerPacketPolicyHash({ ...policy, enabled: true }));
  assert.throws(() =>
    computeApplicationAnswerPacketPolicyHash({ ...policy, finalReviewRequired: false })
  );
});

function inputProjection() {
  return {
    schemaVersion: 1 as const,
    inspectionVersion: 3,
    formFingerprint: HASH_A,
    builderVersion: 1,
    classifierVersion: 1,
    canonicalizerVersion: 1,
    reviewHashVersion: "CANONICAL_PROPOSAL_V1" as const,
    policyHash: HASH_B,
    documentReferences: [
      { artifactType: "RESUME" as const, documentId: "resume_123", contentHash: HASH_C },
      { artifactType: "COVER_LETTER" as const, documentId: "cover_123", contentHash: HASH_D }
    ],
    sourceLookups: [
      { normalizedFieldKey: HASH_B, candidateSourceFingerprints: [HASH_D, HASH_C] },
      { normalizedFieldKey: HASH_A, candidateSourceFingerprints: [] }
    ]
  };
}

test("input hashes sort semantic sets and change only for explicit relevant inputs", () => {
  const input = inputProjection();
  const canonical = canonicalizeApplicationAnswerPacketInputProjection(input);
  assert.deepEqual(
    canonical.documentReferences.map((reference) => reference.artifactType),
    ["COVER_LETTER", "RESUME"]
  );
  assert.deepEqual(
    canonical.sourceLookups.map((lookup) => lookup.normalizedFieldKey),
    [HASH_A, HASH_B]
  );
  const baseline = computeApplicationAnswerPacketInputHash(input);
  assert.equal(
    baseline,
    computeApplicationAnswerPacketInputHash({
      ...input,
      documentReferences: [...input.documentReferences].reverse(),
      sourceLookups: [...input.sourceLookups]
        .reverse()
        .map((lookup) => ({ ...lookup, candidateSourceFingerprints: [...lookup.candidateSourceFingerprints].reverse() }))
    })
  );
  assert.notEqual(
    baseline,
    computeApplicationAnswerPacketInputHash({ ...input, inspectionVersion: input.inspectionVersion + 1 })
  );
  assert.notEqual(
    baseline,
    computeApplicationAnswerPacketInputHash({
      ...input,
      sourceLookups: input.sourceLookups.map((lookup, index) =>
        index === 0 ? { ...lookup, candidateSourceFingerprints: [HASH_E] } : lookup
      )
    })
  );
  assert.notEqual(
    baseline,
    computeApplicationAnswerPacketInputHash({
      ...input,
      documentReferences: input.documentReferences.map((document, index) =>
        index === 0 ? { ...document, contentHash: HASH_E } : document
      )
    })
  );
  for (const changed of [
    { ...input, formFingerprint: HASH_E },
    { ...input, builderVersion: 2 },
    { ...input, classifierVersion: 2 },
    { ...input, canonicalizerVersion: 2 },
    { ...input, policyHash: HASH_E },
    {
      ...input,
      documentReferences: input.documentReferences.map((document, index) =>
        index === 0 ? { ...document, documentId: "resume_456" } : document
      )
    },
    {
      ...input,
      sourceLookups: input.sourceLookups.map((lookup, index) =>
        index === 0 ? { ...lookup, normalizedFieldKey: HASH_E } : lookup
      )
    }
  ]) {
    assert.notEqual(computeApplicationAnswerPacketInputHash(changed), baseline);
  }
  assert.throws(() => computeApplicationAnswerPacketInputHash({ ...input, unrelatedProfileRevision: 99 }));
});

test("packet input canonicalization rejects duplicate semantic source sets", () => {
  const input = inputProjection();
  assert.throws(() =>
    canonicalizeApplicationAnswerPacketInputProjection({
      ...input,
      documentReferences: [input.documentReferences[0], input.documentReferences[0]]
    })
  );
  assert.throws(() =>
    canonicalizeApplicationAnswerPacketInputProjection({
      ...input,
      sourceLookups: [input.sourceLookups[0], input.sourceLookups[0]]
    })
  );
  assert.throws(() =>
    canonicalizeApplicationAnswerPacketInputProjection({
      ...input,
      sourceLookups: [
        {
          ...input.sourceLookups[0],
          candidateSourceFingerprints: [HASH_C, HASH_C]
        }
      ]
    })
  );
});

test("algorithm and builder versions are positive provenance values", () => {
  const input = inputProjection();
  for (const key of ["builderVersion", "classifierVersion", "canonicalizerVersion"] as const) {
    assert.throws(() => computeApplicationAnswerPacketInputHash({ ...input, [key]: 0 }));
  }
  assert.throws(() => computeApplicationAnswerPacketHash({ ...packetProjection(), builderVersion: 0 }));
});

function packetProjection() {
  return {
    schemaVersion: 1 as const,
    inspectionVersion: 3,
    formFingerprint: HASH_A,
    builderVersion: 1,
    policyHash: HASH_B,
    answers: [
      {
        normalizedFieldKey: HASH_B,
        normalizedQuestion: "email address",
        semanticFieldKey: "contact.email",
        fieldFingerprint: HASH_C,
        fieldType: "EMAIL" as const,
        classification: "CONTACT" as const,
        disposition: "MANUAL_ONLY" as const,
        dispositionReason: "UNCONFIRMED_APPLICANT_CONTACT" as const,
        proposal: null,
        sourceType: null,
        sourceIds: [],
        evidenceIds: [],
        sourceFingerprint: null,
        confidence: 0,
        required: true,
        requiresReview: false,
        sensitive: false,
        valueRedacted: false
      },
      {
        normalizedFieldKey: HASH_A,
        normalizedQuestion: "linkedin profile",
        semanticFieldKey: "professional.linkedin",
        fieldFingerprint: HASH_D,
        fieldType: "URL" as const,
        classification: "PROFESSIONAL_LINK" as const,
        disposition: "PROPOSABLE" as const,
        dispositionReason: null,
        proposal: { kind: "SCALAR" as const, value: "https://example.test/profile" },
        sourceType: "ANSWER_VAULT" as const,
        sourceIds: ["source_a"],
        evidenceIds: [],
        sourceFingerprint: HASH_E,
        confidence: 100,
        required: false,
        requiresReview: true,
        sensitive: false,
        valueRedacted: false
      }
    ]
  };
}

test("packet hashes canonicalize presentation order and bind all material published fields", () => {
  const packet = packetProjection();
  const canonical = canonicalizeApplicationAnswerPacketProjection(packet);
  assert.deepEqual(
    canonical.answers.map((answer) => answer.normalizedFieldKey),
    [HASH_A, HASH_B]
  );
  assert.deepEqual(canonical.answers[0].sourceIds, ["source_a"]);
  const baseline = computeApplicationAnswerPacketHash(packet);
  assert.equal(
    baseline,
    computeApplicationAnswerPacketHash({
      ...packet,
      answers: [...packet.answers]
        .reverse()
        .map((answer) => ({ ...answer, sourceIds: [...answer.sourceIds].reverse() }))
    })
  );
  assert.notEqual(
    baseline,
    computeApplicationAnswerPacketHash({
      ...packet,
      answers: packet.answers.map((answer) =>
        answer.disposition === "PROPOSABLE"
          ? { ...answer, proposal: { kind: "SCALAR" as const, value: "https://example.test/changed" } }
          : answer
      )
    })
  );
  assert.notEqual(
    baseline,
    computeApplicationAnswerPacketHash({ ...packet, inspectionVersion: packet.inspectionVersion + 1 })
  );

  const proposableIndex = packet.answers.findIndex((answer) => answer.disposition === "PROPOSABLE");
  const manualIndex = packet.answers.findIndex((answer) => answer.disposition === "MANUAL_ONLY");
  const mutate = (index: number, patch: Record<string, unknown>) => ({
    ...packet,
    answers: packet.answers.map((answer, current) => (current === index ? { ...answer, ...patch } : answer))
  });
  const manualizedProposable = mutate(proposableIndex, {
    disposition: "MANUAL_ONLY",
    dispositionReason: "NO_ELIGIBLE_SOURCE",
    proposal: null,
    sourceType: null,
    sourceIds: [],
    sourceFingerprint: null,
    confidence: 0,
    requiresReview: false
  });
  const excludedManual = mutate(manualIndex, {
    classification: "DEMOGRAPHIC",
    semanticFieldKey: "demographic.other",
    disposition: "EXCLUDED",
    dispositionReason: "POLICY_EXCLUDED",
    sensitive: true,
    valueRedacted: true
  });
  for (const changed of [
    { ...packet, formFingerprint: HASH_E },
    { ...packet, builderVersion: 2 },
    { ...packet, policyHash: HASH_E },
    mutate(proposableIndex, { normalizedFieldKey: HASH_E }),
    mutate(proposableIndex, { normalizedQuestion: "professional profile" }),
    mutate(proposableIndex, { semanticFieldKey: "professional.website" }),
    mutate(proposableIndex, { fieldFingerprint: HASH_E }),
    mutate(proposableIndex, { fieldType: "TEXT" }),
    mutate(proposableIndex, { classification: "AVAILABILITY" }),
    mutate(proposableIndex, { sourceIds: ["source_b"] }),
    mutate(proposableIndex, { sourceFingerprint: HASH_C }),
    mutate(proposableIndex, { confidence: 99 }),
    mutate(proposableIndex, { required: true }),
    manualizedProposable,
    excludedManual
  ]) {
    assert.notEqual(computeApplicationAnswerPacketHash(changed), baseline);
  }
});

test("packet hash projection structurally excludes input, database, and review lifecycle fields", () => {
  const packet = packetProjection();
  for (const extra of [
    { id: "packet_database_id" },
    { packetVersion: 17 },
    { inputHash: HASH_C },
    { status: "APPROVED" },
    { reviewedAt: "2026-08-25T12:00:00.000Z" }
  ]) {
    assert.throws(() => computeApplicationAnswerPacketHash({ ...packet, ...extra }));
  }
  assert.throws(() =>
    computeApplicationAnswerPacketHash({
      ...packet,
      answers: packet.answers.map((answer, index) => (index === 0 ? { ...answer, answerId: "answer_db_id" } : answer))
    })
  );
  assert.deepEqual(canonicalizeApplicationAnswerPacketProjection(packet), {
    ...packet,
    answers: [...packet.answers].sort((left, right) =>
      left.normalizedFieldKey < right.normalizedFieldKey ? -1 : left.normalizedFieldKey > right.normalizedFieldKey ? 1 : 0
    )
  });
});

test("packet projection rejects contradictory proposal, privacy, evidence, and provenance states", () => {
  const packet = packetProjection();
  const proposableIndex = packet.answers.findIndex((answer) => answer.disposition === "PROPOSABLE");
  const manualIndex = packet.answers.findIndex((answer) => answer.disposition === "MANUAL_ONLY");
  const mutate = (index: number, patch: Record<string, unknown>) => ({
    ...packet,
    answers: packet.answers.map((answer, current) => (current === index ? { ...answer, ...patch } : answer))
  });
  assert.throws(() => computeApplicationAnswerPacketHash(mutate(proposableIndex, { requiresReview: false })));
  assert.throws(() => computeApplicationAnswerPacketHash(mutate(proposableIndex, { sourceFingerprint: null })));
  assert.throws(() => computeApplicationAnswerPacketHash(mutate(proposableIndex, { sourceType: "COVER_LETTER" })));
  assert.throws(() => computeApplicationAnswerPacketHash(mutate(manualIndex, { proposal: { kind: "SCALAR", value: "x" } })));
  assert.throws(() =>
    computeApplicationAnswerPacketHash(mutate(manualIndex, { dispositionReason: "UNSUPPORTED_CONTROL" }))
  );
  assert.throws(() => computeApplicationAnswerPacketHash(mutate(manualIndex, { evidenceIds: ["evidence_1"] })));
  assert.throws(() =>
    computeApplicationAnswerPacketHash(
      mutate(manualIndex, {
        disposition: "EXCLUDED",
        dispositionReason: "POLICY_EXCLUDED",
        sensitive: false,
        valueRedacted: false
      })
    )
  );
});

test("every non-proposable disposition requires zero confidence", () => {
  const packet = packetProjection();
  const manual = packet.answers.find((answer) => answer.disposition === "MANUAL_ONLY");
  assert.ok(manual);
  const excluded = {
    ...manual,
    normalizedFieldKey: HASH_C,
    fieldFingerprint: HASH_D,
    normalizedQuestion: "equal employment opportunity",
    semanticFieldKey: "demographic.other",
    classification: "DEMOGRAPHIC" as const,
    disposition: "EXCLUDED" as const,
    dispositionReason: "POLICY_EXCLUDED" as const,
    sensitive: true,
    valueRedacted: true
  };
  const unsupported = {
    ...manual,
    normalizedFieldKey: HASH_D,
    fieldFingerprint: HASH_E,
    normalizedQuestion: "unknown question",
    semanticFieldKey: null,
    classification: "UNKNOWN" as const,
    disposition: "UNSUPPORTED" as const,
    dispositionReason: "UNKNOWN_QUESTION" as const
  };

  for (const answer of [manual, excluded, unsupported]) {
    assert.doesNotThrow(() =>
      canonicalizeApplicationAnswerPacketProjection({ ...packet, answers: [{ ...answer, confidence: 0 }] })
    );
    for (const confidence of [-0, 1, 100]) {
      assert.throws(() =>
        canonicalizeApplicationAnswerPacketProjection({ ...packet, answers: [{ ...answer, confidence }] })
      );
    }
  }

  const proposable = packet.answers.find((answer) => answer.disposition === "PROPOSABLE");
  assert.ok(proposable);
  assert.doesNotThrow(() =>
    canonicalizeApplicationAnswerPacketProjection({ ...packet, answers: [{ ...proposable, confidence: 0 }] })
  );
  assert.throws(() =>
    canonicalizeApplicationAnswerPacketProjection({ ...packet, answers: [{ ...proposable, confidence: -0 }] })
  );
});

test("packet questions accept canonical empty inspection values and reject noncanonical text", () => {
  const packet = packetProjection();
  const unknown = {
    normalizedFieldKey: HASH_C,
    normalizedQuestion: "",
    semanticFieldKey: null,
    fieldFingerprint: HASH_E,
    fieldType: "TEXT" as const,
    classification: "UNKNOWN" as const,
    disposition: "UNSUPPORTED" as const,
    dispositionReason: "UNKNOWN_QUESTION" as const,
    proposal: null,
    sourceType: null,
    sourceIds: [],
    evidenceIds: [],
    sourceFingerprint: null,
    confidence: 0,
    required: false,
    requiresReview: false,
    sensitive: false,
    valueRedacted: false
  };
  assert.doesNotThrow(() => computeApplicationAnswerPacketHash({ ...packet, answers: [unknown] }));
  assert.throws(() =>
    computeApplicationAnswerPacketHash({
      ...packet,
      answers: [{ ...unknown, normalizedQuestion: " NOT canonical " }]
    })
  );
  assert.throws(() =>
    computeApplicationAnswerPacketHash({
      ...packet,
      answers: [{ ...unknown, normalizedQuestion: "e\u0301" }]
    })
  );
  for (const invisible of [
    "\u00ad",
    "\u115f",
    "\u1160",
    "\u180e",
    "\u200b",
    "\u2060",
    "\u2061",
    "\u2065",
    "\u206f",
    "\u3164",
    "\ufeff",
    "\uffa0"
  ]) {
    assert.throws(() =>
      computeApplicationAnswerPacketHash({
        ...packet,
        answers: [{ ...unknown, normalizedQuestion: `hidden${invisible}question` }]
      })
    );
  }
  for (const markOnly of ["\u200c", "\u200d", "\u0301", "\ufe0f"]) {
    assert.throws(() =>
      computeApplicationAnswerPacketHash({
        ...packet,
        answers: [{ ...unknown, normalizedQuestion: markOnly }]
      })
    );
  }
});

test("packet option proposals require validation against the frozen inspection choices", () => {
  const packet = packetProjection();
  const optionAnswer = {
    normalizedFieldKey: HASH_A,
    normalizedQuestion: "preferred schedule",
    semanticFieldKey: "availability.schedule",
    fieldFingerprint: HASH_B,
    fieldType: "SELECT_ONE" as const,
    classification: "AVAILABILITY" as const,
    disposition: "PROPOSABLE" as const,
    dispositionReason: null,
    proposal: { kind: "OPTIONS" as const, optionKeys: [HASH_C] },
    sourceType: "ANSWER_VAULT" as const,
    sourceIds: ["source_a"],
    evidenceIds: [],
    sourceFingerprint: HASH_D,
    confidence: 100,
    required: false,
    requiresReview: true,
    sensitive: false,
    valueRedacted: false
  };
  const optionPacket = { ...packet, answers: [optionAnswer] };
  const context = {
    fields: [
      {
        normalizedFieldKey: HASH_A,
        fieldFingerprint: HASH_B,
        fieldType: "SELECT_ONE" as const,
        semanticFieldKey: "availability.schedule",
        choices: [{ key: HASH_C, disabled: false }]
      }
    ]
  };
  assert.doesNotThrow(() => computeApplicationAnswerPacketHash(optionPacket, context));
  assert.throws(() => computeApplicationAnswerPacketHash(optionPacket));
  assert.throws(() =>
    computeApplicationAnswerPacketHash(optionPacket, {
      fields: [
        {
          normalizedFieldKey: HASH_A,
          fieldFingerprint: HASH_B,
          fieldType: "SELECT_ONE",
          semanticFieldKey: "availability.schedule",
          choices: [{ key: HASH_B, disabled: false }]
        }
      ]
    })
  );
  for (const fieldPatch of [
    { normalizedFieldKey: HASH_E },
    { fieldType: "SELECT_MANY" },
    { semanticFieldKey: "availability.notice_period" },
    { choices: [{ key: HASH_C, disabled: undefined }] },
    { choices: [{ key: HASH_C, disabled: false, unexpected: true }] },
    { unexpected: true }
  ]) {
    assert.throws(() =>
      computeApplicationAnswerPacketHash(optionPacket, {
        fields: [{ ...context.fields[0], ...fieldPatch }]
      })
    );
  }
  assert.throws(() =>
    computeApplicationAnswerPacketHash(optionPacket, {
      fields: [
        {
          normalizedFieldKey: HASH_A,
          fieldFingerprint: HASH_B,
          fieldType: "SELECT_ONE",
          semanticFieldKey: "availability.schedule",
          choices: [{ key: HASH_C, disabled: true }]
        }
      ]
    })
  );
  assert.throws(() =>
    computeApplicationAnswerPacketHash(optionPacket, {
      fields: [
        {
          normalizedFieldKey: HASH_A,
          fieldFingerprint: HASH_E,
          fieldType: "SELECT_ONE",
          semanticFieldKey: "availability.schedule",
          choices: [{ key: HASH_C, disabled: false }]
        }
      ]
    })
  );
  assert.throws(() =>
    computeApplicationAnswerPacketHash(
      {
        ...optionPacket,
        answers: [{ ...optionAnswer, proposal: { kind: "OPTIONS" as const, optionKeys: [HASH_B, HASH_C] } }]
      },
      {
        fields: [
          {
            normalizedFieldKey: HASH_A,
            fieldFingerprint: HASH_B,
            fieldType: "SELECT_ONE",
            semanticFieldKey: "availability.schedule",
            choices: [
              { key: HASH_B, disabled: false },
              { key: HASH_C, disabled: false }
            ]
          }
        ]
      }
    )
  );
});

test("source-resolved dispositions can preserve or downgrade but never escalate authority", () => {
  assert.doesNotThrow(() =>
    assertApplicationAnswerDispositionWithinPermitted({
      permittedDisposition: "PROPOSABLE",
      permittedDispositionReason: null,
      disposition: "MANUAL_ONLY",
      dispositionReason: "NO_ELIGIBLE_SOURCE"
    })
  );
  assert.doesNotThrow(() =>
    assertApplicationAnswerDispositionWithinPermitted({
      permittedDisposition: "MANUAL_ONLY",
      permittedDispositionReason: "V1_MANUAL_POLICY",
      disposition: "UNSUPPORTED",
      dispositionReason: "UNSUPPORTED_CONTROL"
    })
  );
  assert.doesNotThrow(() =>
    assertApplicationAnswerDispositionWithinPermitted({
      permittedDisposition: "EXCLUDED",
      permittedDispositionReason: "POLICY_EXCLUDED",
      disposition: "EXCLUDED",
      dispositionReason: "POLICY_EXCLUDED"
    })
  );
  assert.throws(() =>
    assertApplicationAnswerDispositionWithinPermitted({
      permittedDisposition: "MANUAL_ONLY",
      permittedDispositionReason: "V1_MANUAL_POLICY",
      disposition: "PROPOSABLE",
      dispositionReason: null
    })
  );
  assert.throws(() =>
    assertApplicationAnswerDispositionWithinPermitted({
      permittedDisposition: "PROPOSABLE",
      permittedDispositionReason: null,
      disposition: "EXCLUDED",
      dispositionReason: "POLICY_EXCLUDED"
    })
  );
  assert.throws(() =>
    assertApplicationAnswerDispositionWithinPermitted({
      permittedDisposition: "PROPOSABLE",
      permittedDispositionReason: null,
      disposition: "MANUAL_ONLY",
      dispositionReason: "UNSUPPORTED_CONTROL"
    })
  );
  for (const dispositionReason of [
    "LEGAL_ATTESTATION",
    "UNCONFIRMED_APPLICANT_CONTACT",
    "V1_MANUAL_POLICY"
  ] as const) {
    assert.throws(() =>
      assertApplicationAnswerDispositionWithinPermitted({
        permittedDisposition: "PROPOSABLE",
        permittedDispositionReason: null,
        disposition: "MANUAL_ONLY",
        dispositionReason
      })
    );
  }
  assert.throws(() =>
    assertApplicationAnswerDispositionWithinPermitted({
      permittedDisposition: "MANUAL_ONLY",
      permittedDispositionReason: "LEGAL_ATTESTATION",
      disposition: "MANUAL_ONLY",
      dispositionReason: "V1_MANUAL_POLICY"
    })
  );
  assert.throws(() =>
    assertApplicationAnswerDispositionWithinPermitted({
      permittedDisposition: "MANUAL_ONLY",
      permittedDispositionReason: "NO_ELIGIBLE_SOURCE",
      disposition: "MANUAL_ONLY",
      dispositionReason: "NO_ELIGIBLE_SOURCE"
    })
  );
});

function summaryPacket() {
  const base = {
    sourceIds: [] as string[],
    evidenceIds: [] as string[],
    proposal: null,
    sourceType: null,
    sourceFingerprint: null,
    confidence: 0,
    requiresReview: false,
    sensitive: false,
    valueRedacted: false
  };
  return {
    schemaVersion: 1 as const,
    inspectionVersion: 9,
    formFingerprint: numberedHash(300),
    builderVersion: 1,
    policyHash: numberedHash(301),
    answers: [
      {
        ...base,
        normalizedFieldKey: numberedHash(101),
        normalizedQuestion: "linkedin profile",
        semanticFieldKey: "professional.linkedin",
        fieldFingerprint: numberedHash(201),
        fieldType: "URL" as const,
        classification: "PROFESSIONAL_LINK" as const,
        disposition: "PROPOSABLE" as const,
        dispositionReason: null,
        proposal: { kind: "SCALAR" as const, value: "https://example.test/profile" },
        sourceType: "ANSWER_VAULT" as const,
        sourceIds: ["source_link"],
        sourceFingerprint: numberedHash(401),
        confidence: 100,
        required: false,
        requiresReview: true
      },
      {
        ...base,
        normalizedFieldKey: numberedHash(102),
        normalizedQuestion: "availability",
        semanticFieldKey: "availability.general",
        fieldFingerprint: numberedHash(202),
        fieldType: "CHECKBOX_BOOLEAN" as const,
        classification: "AVAILABILITY" as const,
        disposition: "PROPOSABLE" as const,
        dispositionReason: null,
        proposal: { kind: "BOOLEAN" as const, value: true },
        sourceType: "ANSWER_VAULT" as const,
        sourceIds: ["source_availability"],
        sourceFingerprint: numberedHash(402),
        confidence: 90,
        required: true,
        requiresReview: true
      },
      {
        ...base,
        normalizedFieldKey: numberedHash(103),
        normalizedQuestion: "email address",
        semanticFieldKey: "contact.email",
        fieldFingerprint: numberedHash(203),
        fieldType: "EMAIL" as const,
        classification: "CONTACT" as const,
        disposition: "MANUAL_ONLY" as const,
        dispositionReason: "UNCONFIRMED_APPLICANT_CONTACT" as const,
        required: true
      },
      {
        ...base,
        normalizedFieldKey: numberedHash(104),
        normalizedQuestion: "equal employment opportunity",
        semanticFieldKey: "demographic.other",
        fieldFingerprint: numberedHash(204),
        fieldType: "SELECT_ONE" as const,
        classification: "DEMOGRAPHIC" as const,
        disposition: "EXCLUDED" as const,
        dispositionReason: "POLICY_EXCLUDED" as const,
        required: true,
        sensitive: true,
        valueRedacted: true
      },
      {
        ...base,
        normalizedFieldKey: numberedHash(105),
        normalizedQuestion: "unknown question",
        semanticFieldKey: null,
        fieldFingerprint: numberedHash(205),
        fieldType: "TEXT" as const,
        classification: "UNKNOWN" as const,
        disposition: "UNSUPPORTED" as const,
        dispositionReason: "UNKNOWN_QUESTION" as const,
        required: false
      }
    ]
  };
}

function summaryRows(
  packet: ReturnType<typeof summaryPacket>,
  statuses: Readonly<Record<string, "PENDING" | "APPROVED" | "REJECTED">>,
  packetVersion = 7
) {
  const packetHash = computeApplicationAnswerPacketHash(packet);
  return packet.answers.map((answer) => {
    const status =
      statuses[answer.normalizedFieldKey] ??
      (answer.disposition === "PROPOSABLE" ? "PENDING" : "PENDING");
    const approved = answer.disposition === "PROPOSABLE" && status === "APPROVED";
    return {
      packetVersion,
      packetHash,
      normalizedFieldKey: answer.normalizedFieldKey,
      status,
      finalValueHash: approved ? computeApplicationAnswerProposalHash(answer.proposal) : null,
      reviewHashVersion: approved ? ("CANONICAL_PROPOSAL_V1" as const) : null
    };
  });
}

test("packet summary derives counts from a complete canonical packet and retains approved hash verification", () => {
  const packet = summaryPacket();
  const statuses = {
    [numberedHash(101)]: "APPROVED",
    [numberedHash(102)]: "REJECTED"
  } as const;
  const rows = summaryRows(packet, statuses);
  const input = {
    currentPacketVersion: 7,
    packetVersion: 7,
    packet,
    rows
  };
  assert.deepEqual(summarizeApplicationAnswerPacket(input), {
    fieldCount: 5,
    proposableCount: 2,
    pendingReviewCount: 0,
    approvedCount: 1,
    rejectedCount: 1,
    manualOnlyCount: 1,
    excludedCount: 1,
    unsupportedCount: 1,
    manualRequiredCount: 3,
    readyForRunResolution: true
  });
  assert.equal(
    summarizeApplicationAnswerPacket({ ...input, currentPacketVersion: 8 }).readyForRunResolution,
    false
  );

  const wrongApprovedHash = rows.map((row) =>
    row.normalizedFieldKey === numberedHash(101) ? { ...row, finalValueHash: HASH_A } : row
  );
  assert.equal(
    summarizeApplicationAnswerPacket({ ...input, rows: wrongApprovedHash }).readyForRunResolution,
    false
  );
});

test("packet summary rejects empty, missing, extra, duplicate, substituted, or mixed packet rows", () => {
  const packet = summaryPacket();
  const statuses = {
    [numberedHash(101)]: "APPROVED",
    [numberedHash(102)]: "PENDING"
  } as const;
  const rows = summaryRows(packet, statuses);
  const input = {
    currentPacketVersion: 7,
    packetVersion: 7,
    packet,
    rows
  };

  assert.equal(summarizeApplicationAnswerPacket(input).readyForRunResolution, false);
  assert.throws(() =>
    summarizeApplicationAnswerPacket({ ...input, packet: { ...packet, answers: [] }, rows: [] })
  );
  for (const omittedKey of [numberedHash(102), numberedHash(103), numberedHash(104)]) {
    assert.throws(() =>
      summarizeApplicationAnswerPacket({
        ...input,
        rows: rows.filter((row) => row.normalizedFieldKey !== omittedKey)
      })
    );
  }
  assert.throws(() => summarizeApplicationAnswerPacket({ ...input, rows: [...rows, rows[0]] }));
  assert.throws(() =>
    summarizeApplicationAnswerPacket({
      ...input,
      rows: [
        ...rows,
        { ...rows[0], normalizedFieldKey: numberedHash(999) }
      ]
    })
  );
  assert.throws(() =>
    summarizeApplicationAnswerPacket({
      ...input,
      rows: rows.map((row, index) =>
        index === 0 ? { ...row, normalizedFieldKey: numberedHash(999) } : row
      )
    })
  );
  assert.throws(() =>
    summarizeApplicationAnswerPacket({
      ...input,
      rows: rows.map((row, index) => (index === 0 ? { ...row, packetVersion: 8 } : row))
    })
  );
  assert.throws(() =>
    summarizeApplicationAnswerPacket({
      ...input,
      rows: rows.map((row, index) => (index === 0 ? { ...row, packetHash: HASH_A } : row))
    })
  );
  assert.throws(() =>
    summarizeApplicationAnswerPacket({
      ...input,
      rows: rows.map((row) => ({ ...row, packetHash: HASH_A }))
    })
  );
});

test("packet summary rejects lifecycle metadata on non-proposable rows and exact-set truncation cannot alter counts", () => {
  const packet = summaryPacket();
  const statuses = {
    [numberedHash(101)]: "APPROVED",
    [numberedHash(102)]: "REJECTED"
  } as const;
  const rows = summaryRows(packet, statuses);
  const input = {
    currentPacketVersion: 7,
    packetVersion: 7,
    packet,
    rows
  };
  const manualIndex = rows.findIndex((row) => row.normalizedFieldKey === numberedHash(103));
  assert.throws(() =>
    summarizeApplicationAnswerPacket({
      ...input,
      rows: rows.map((row, index) =>
        index === manualIndex
          ? {
              ...row,
              status: "APPROVED",
              finalValueHash: HASH_A,
              reviewHashVersion: "CANONICAL_PROPOSAL_V1"
            }
          : row
      )
    })
  );
  assert.throws(() =>
    summarizeApplicationAnswerPacket({
      ...input,
      rows: rows.filter((row) => row.normalizedFieldKey !== numberedHash(102))
    })
  );
  assert.throws(() =>
    summarizeApplicationAnswerPacket({
      ...input,
      rows: rows.filter((row) => row.normalizedFieldKey !== numberedHash(103))
    })
  );

  const staleRows = summaryRows(packet, statuses, 6);
  assert.equal(
    summarizeApplicationAnswerPacket({
      currentPacketVersion: 7,
      packetVersion: 6,
      packet,
      rows: staleRows
    }).readyForRunResolution,
    false
  );
});
