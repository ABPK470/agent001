import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import ts from "typescript"
import { fail } from "../report.mjs"
import { isTestFile, walk } from "../fs-walk.mjs"
import { lineOf, parseSourceFile, relToPkg } from "../ts-context.mjs"

const AGENT_BANNED = [
  { id: "resolveAgent", detail: "resolveAgent is forbidden — cores receive resolved systemPrompt/tools, not profile IDs" },
  { id: "createDelegateTools", detail: "createDelegateTools is forbidden — one spawn kernel; planner owns fan-out" },
  { id: "createDelegationTools", detail: "createDelegationTools is forbidden — one spawn kernel; planner owns fan-out" },
  { id: "ResolvedAgent", detail: "ResolvedAgent / named agent profiles are erased" },
]

const UI_BANNED = [
  { id: "listAgents", detail: "listAgents / agent CRUD client is forbidden" },
  { id: "createAgent", detail: "createAgent is forbidden — no agent profiles" },
  { id: "updateAgent", detail: "updateAgent is forbidden — no agent profiles" },
  { id: "deleteAgent", detail: "deleteAgent is forbidden — no agent profiles" },
  { id: "selectedAgentId", detail: "selectedAgentId is forbidden — UI starts runs with goal+thread only" },
  { id: "AgentEditor", detail: "AgentEditor is forbidden — capability erased" },
  { id: "AgentDefinition", detail: "AgentDefinition is forbidden — capability erased" },
]

function lintBannedIdentifiers(files, banned, skipTests = true) {
  const names = new Set(banned.map((b) => b.id))
  const detailOf = Object.fromEntries(banned.map((b) => [b.id, b.detail]))

  for (const file of files) {
    const rel = file
    if (skipTests && (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx"))) continue
    const sf = parseSourceFile(file)
    const visit = (node) => {
      if (ts.isIdentifier(node) && names.has(node.text)) {
        // Allow property names in type positions? Ban all identifier uses —
        // capability must not reappear.
        fail(file, lineOf(sf, node), "capability-ownership", `${detailOf[node.text]}. See docs/doctrine.md`)
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

export function lintCapabilityOwnership(agentPkg, uiPkg) {
  if (existsSync(agentPkg.src)) {
    lintBannedIdentifiers(
      walk(agentPkg.src).filter((f) => !isTestFile(relToPkg(agentPkg.src, f))),
      AGENT_BANNED,
    )
  }
  if (existsSync(uiPkg.src)) {
    lintBannedIdentifiers(
      walk(uiPkg.src).filter((f) => !isTestFile(relToPkg(uiPkg.src, f))),
      UI_BANNED,
    )
  }
}

export function lintUiPlatformCheckbox(uiPkg, files) {
  const checkboxSource = join(uiPkg.src, "components/Checkbox.tsx")
  for (const file of files) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue
    if (file === checkboxSource) continue
    const sf = parseSourceFile(file)
    const visit = (node) => {
      if (ts.isJsxAttribute(node) && node.name && ts.isIdentifier(node.name) && node.name.text === "type") {
        const init = node.initializer
        if (init && ts.isStringLiteral(init) && init.text === "checkbox") {
          fail(
            file,
            lineOf(sf, node),
            "ui-platform-checkbox",
            `Raw type="checkbox" — use Checkbox / LabeledCheckbox from components/Checkbox.tsx`,
          )
        }
        if (
          init &&
          ts.isJsxExpression(init) &&
          init.expression &&
          ts.isStringLiteral(init.expression) &&
          init.expression.text === "checkbox"
        ) {
          fail(
            file,
            lineOf(sf, node),
            "ui-platform-checkbox",
            `Raw type="checkbox" — use Checkbox / LabeledCheckbox from components/Checkbox.tsx`,
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

const WIRE_KINDS = new Set([
  "llm-request",
  "llm-response",
  "system-prompt",
  "tools-resolved",
  "tool-call",
  "tool-result",
  "tool-error",
  "planner-step-start",
  "planner-step-end",
  "planner-decision",
  "planner-plan-generated",
  "delegation-start",
  "delegation-end",
])

export function lintUiEventKindSwitch(uiPkg, files) {
  for (const file of files) {
    if (!/\.(tsx?|jsx?)$/.test(file)) continue
    const rel = relToPkg(uiPkg.src, file)
    if (isTestFile(rel)) continue
    if (rel.startsWith("lib/events/")) continue
    if (rel.startsWith("components/outline/")) continue
    if (!rel.startsWith("widgets/") && !rel.startsWith("state/")) continue

    const sf = parseSourceFile(file)
    const text = sf.getFullText()
    if (/\bTRACE_KIND_LABELS\b/.test(text)) {
      fail(
        file,
        0,
        "event-catalog",
        `TRACE_KIND_LABELS is banned — use eventLabel / describeDebugTracePayload from @mia/shared-types`,
      )
    }

    const visit = (node) => {
      if (ts.isCaseClause(node) && node.expression && ts.isStringLiteral(node.expression)) {
        if (WIRE_KINDS.has(node.expression.text)) {
          fail(
            file,
            lineOf(sf, node),
            "event-catalog",
            `Widget/state must not switch on wire TraceEntry.kind for presentation. ` +
              `Use event-catalog + lib/events projection. See docs/doctrine.md`,
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
}

/**
 * Catalog coverage — every TraceEntry.kind and EventType has a descriptor.
 * Uses TS AST on shared-types / shared-enums where practical.
 */
export function lintEventCatalogCoverage(root) {
  const catalogPath = join(root, "packages/shared-types/src/event-catalog.ts")
  const typesPath = join(root, "packages/shared-types/src/index.ts")
  const eventEnumPath = join(root, "packages/shared-enums/src/event.ts")
  if (!existsSync(catalogPath) || !existsSync(typesPath) || !existsSync(eventEnumPath)) {
    fail(catalogPath, 0, "event-catalog-coverage", "missing catalog or EventType sources")
    return
  }

  // Section-bounded extraction: UNKNOWN is an intentional fallback, not EventType.
  const catalog = readFileSync(catalogPath, "utf8")
  const traceBlock = catalog.split("TRACE_EVENT_CATALOG")[1]?.split("SSE_EVENT_CATALOG")[0] ?? ""
  const sseBlock = catalog.split("SSE_EVENT_CATALOG")[1]?.split("const UNKNOWN")[0] ?? ""
  const traceIds = new Set([...traceBlock.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]))
  const sseIds = new Set([...sseBlock.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]))

  const typesSrc = readFileSync(typesPath, "utf8")
  const teMatch = typesSrc.match(/export type TraceEntry\s*=([\s\S]*?)\nexport type /)
  const teSlice = teMatch ? teMatch[1] : ""
  const traceKinds = new Set([...teSlice.matchAll(/kind:\s*"([^"]+)"/g)].map((m) => m[1]))

  for (const kind of traceKinds) {
    if (!traceIds.has(kind)) {
      fail(
        catalogPath,
        0,
        "event-catalog-coverage",
        `TraceEntry.kind "${kind}" missing from TRACE_EVENT_CATALOG — add a semantic descriptor.`,
      )
    }
  }
  for (const id of traceIds) {
    if (!traceKinds.has(id)) {
      fail(
        catalogPath,
        0,
        "event-catalog-coverage",
        `TRACE_EVENT_CATALOG "${id}" has no TraceEntry.kind — remove or add the union member.`,
      )
    }
  }

  const enumSrc = readFileSync(eventEnumPath, "utf8")
  const etBlock = enumSrc.match(/export const EventType\s*=\s*\{([\s\S]*?)\}\s*as const/)
  const precise = new Set(
    etBlock ? [...etBlock[1].matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]) : [],
  )

  for (const t of precise) {
    if (!sseIds.has(t)) {
      fail(
        catalogPath,
        0,
        "event-catalog-coverage",
        `EventType "${t}" missing from SSE_EVENT_CATALOG — add a semantic descriptor.`,
      )
    }
  }
  for (const id of sseIds) {
    if (!precise.has(id)) {
      fail(
        catalogPath,
        0,
        "event-catalog-coverage",
        `SSE_EVENT_CATALOG "${id}" is not an EventType — remove or add the enum member.`,
      )
    }
  }
}
