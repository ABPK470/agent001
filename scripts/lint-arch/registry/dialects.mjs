/**
 * Dialect classes — one home per concept class.
 * Detection criteria are DATA; the runner is one generic engine.
 *
 * detect.kind:
 *   export-name     — exported binding matching `re` outside owners
 *   switch-catalog  — case "…" on ids from a catalog block, outside owners/skips
 */

/** @type {import('./dialects.mjs').DialectClass[]} */
export const DIALECT_CLASSES = [
  {
    id: "presentation-labels",
    owners: ["packages/shared-types/src"],
    scanRoots: ["packages/ui/src"],
    description: "Tool/event presentation label maps — single SoT",
    detect: {
      kind: "export-name",
      re: "^(TOOL_.*LABELS?|TOOL_PAST_TENSE|TRACE_KIND_LABELS)$",
      debtKey: "presentationAllowlist",
    },
  },
  {
    id: "spawn-kernel",
    owners: ["packages/agent/src/tools/delegate-spawn"],
    scanRoots: ["packages/agent/src"],
    skipPathIncludes: ["/tools/delegate-spawn/", "/tools/delegate/"],
    description: "Child agent spawn — one kernel",
    detect: {
      kind: "export-name",
      re: "^(createDelegate|createDelegation)",
    },
  },
  {
    id: "wire-events",
    owners: [
      "packages/shared-types/src/event-catalog.ts",
      "packages/shared-enums/src/event.ts",
      "packages/ui/src/lib/events",
    ],
    scanRoots: ["packages/ui/src"],
    description: "Wire vocabulary + UI projection",
    detect: {
      kind: "switch-catalog",
      catalogFile: "packages/shared-types/src/event-catalog.ts",
      catalogConst: "TRACE_EVENT_CATALOG",
      catalogEndMarker: "SSE_EVENT_CATALOG",
      scanPrefixes: ["widgets/", "state/"],
      skipPrefixes: ["lib/events/", "components/outline/"],
      forbidIdentifiers: ["TRACE_KIND_LABELS"],
    },
  },
]
