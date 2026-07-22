/**
 * buildOutline — chronological EventAtom[] → OutlineNode[] via catalog + ViewSpec.
 *
 * Catalog: semantic (family, label, summary, instanceKey).
 * ViewSpec: hierarchy (nest), roles (scope|leaf|omit), sticky, terminals.
 */

import {
  lookupEventDescriptor,
  type EventFamily,
  type EventPayload,
} from "@mia/shared-types"
import {
  isStickyInView,
  resolveOutlineRole,
  type EventAtom,
  type OutlineNode,
  type ViewSpec,
  type ViewSpecNestRule,
} from "./types"

function humanize(name: string): string {
  return name.replace(/_/g, " ")
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback
}

function childParents(
  family: string,
  nest: ViewSpecNestRule[],
): Set<string> {
  const parents = new Set<string>()
  for (const rule of nest) {
    if (rule.childFamilies.includes(family)) parents.add(rule.parentFamily)
  }
  return parents
}

function scopeTitle(type: string, payload: EventPayload, family: EventFamily | string): string | undefined {
  if (family === "step") {
    const name = str(payload.stepName)
    return name ? humanize(name) : undefined
  }
  void type
  return undefined
}

function scopeLabel(type: string, payload: EventPayload, catalogLabel: string, family: string): string {
  if (family === "step") {
    const stepType = str(payload.stepType)
    if (stepType === "subagent_task" || type.includes("delegation")) return "Subagent"
    if (type.startsWith("planner-step")) return "Step"
    return catalogLabel
  }
  if (type === "llm-request") {
    const iter = typeof payload.iteration === "number" ? payload.iteration + 1 : null
    return iter != null ? `Call ${iter}` : catalogLabel
  }
  return catalogLabel
}

const DEFAULT_TERMINAL_TYPES = [
  "planner-step-end",
  "planner-pipeline-end",
  "planner-delegation-end",
]

/**
 * Build an outline tree.
 * Direct (empty-detail) plan chips are omitted — same as Trace today.
 */
export function buildOutline(atoms: EventAtom[], viewSpec: ViewSpec): OutlineNode[] {
  const roots: OutlineNode[] = []
  /** Open scopes by instanceKey (mutated in place; already on tree). */
  const openByKey = new Map<string, OutlineNode>()
  /** Stack of open instanceKeys for parent lookup (innermost last). */
  const stack: string[] = []
  let seq = 0
  const terminalTypes = new Set(viewSpec.terminalTypes ?? DEFAULT_TERMINAL_TYPES)

  function closeKey(key: string) {
    const node = openByKey.get(key)
    openByKey.delete(key)
    const idx = stack.lastIndexOf(key)
    if (idx >= 0) stack.splice(idx, 1)
    // Closing a step/pipeline must release nested Call scopes — otherwise
    // `call:0` stays open and the next subagent's first LLM request merges
    // into the previous Call (empty Subagent, flat Calls after pipeline).
    if (node?.children) {
      for (const child of node.children) {
        if (child.nestKey && openByKey.has(child.nestKey)) {
          closeKey(child.nestKey)
        }
      }
    }
  }

  function closeFamily(family: string) {
    for (const [key, node] of [...openByKey.entries()]) {
      if (node.family === family) closeKey(key)
    }
  }

  function findOpenParent(childFamily: string): OutlineNode | null {
    const parents = childParents(childFamily, viewSpec.nest)
    for (let i = stack.length - 1; i >= 0; i--) {
      const node = openByKey.get(stack[i]!)
      if (!node) continue
      // Same-family leaf under open scope (e.g. detail under Call).
      if (node.family === childFamily) return node
      if (parents.has(String(node.family))) return node
    }
    return null
  }

  function pushRoot(node: OutlineNode) {
    roots.push(node)
  }

  function attach(node: OutlineNode, parent: OutlineNode | null) {
    if (parent) {
      parent.children = parent.children ?? []
      parent.children.push(node)
      node.depth = parent.depth + 1
    } else {
      node.depth = 0
      pushRoot(node)
    }
  }

  function findNodeByNestKey(nodes: OutlineNode[], key: string): OutlineNode | null {
    for (const n of nodes) {
      if (n.nestKey === key) return n
      if (n.children) {
        const hit = findNodeByNestKey(n.children, key)
        if (hit) return hit
      }
    }
    return null
  }

  for (const atom of atoms) {
    // debug.trace with embedded entry — prefer inner kind for outline
    let type = atom.type
    let payload = atom.payload
    if (type === "debug.trace" && payload.entry && typeof payload.entry === "object") {
      const inner = payload.entry as EventPayload
      const kind = str(inner.kind)
      if (kind) {
        type = kind
        payload = inner
      }
    }

    const d = lookupEventDescriptor(type)
    const role = resolveOutlineRole(type, d.family, viewSpec)
    if (role === "omit") continue

    // Skip bare Direct routing chips (Trace dialect).
    if (
      type === "planner-decision" &&
      (payload.shouldPlan === false || payload.route === "direct") &&
      role === "scope"
    ) {
      continue
    }

    const instanceKeyRaw = d.instanceKey?.(payload) ?? null
    // Qualify Call keys by the open parent step so each subagent owns its own
    // `call:0` instead of colliding on a global iteration index.
    let instanceKey = instanceKeyRaw
    if (instanceKey && d.family === "call") {
      const parent = findOpenParent(d.family)
      if (parent?.nestKey) instanceKey = `${parent.nestKey}/${instanceKey}`
    }
    const summary = d.summary(payload)
    const label = scopeLabel(type, payload, d.label, d.family)
    const title = scopeTitle(type, payload, d.family)
    const sticky = isStickyInView(type, d.family, viewSpec)
    const isTerminal = terminalTypes.has(type)

    if (role === "scope") {
      if (instanceKey && openByKey.has(instanceKey)) {
        const existing = openByKey.get(instanceKey)!
        existing.summary = summary
        // Keep Subagent lead once established (step-end would otherwise downgrade).
        if (!(existing.label === "Subagent" && label === "Step")) {
          existing.label = label
        }
        if (title) existing.title = title
        existing.atomIds.push(atom.id)
        existing.severity = d.severity
        if (isTerminal) {
          closeKey(instanceKey)
        }
        continue
      }

      // Terminal after scope already closed (e.g. step-end after delegation-end)
      // — fold into the existing node; do not open a duplicate.
      if (isTerminal && instanceKey) {
        const closed = findNodeByNestKey(roots, instanceKey)
        if (closed) {
          closed.summary = summary
          if (!(closed.label === "Subagent" && label === "Step")) {
            closed.label = label
          }
          if (title) closed.title = title
          closed.atomIds.push(atom.id)
          closed.severity = d.severity
          continue
        }
      }

      if (instanceKey) {
        for (const [key, node] of [...openByKey.entries()]) {
          if (node.family === d.family && key !== instanceKey) closeKey(key)
        }
      } else {
        closeFamily(d.family)
      }

      const parent = findOpenParent(d.family)
      const node: OutlineNode = {
        id: `scope-${seq++}-${instanceKey ?? type}`,
        kind: "scope",
        family: d.family,
        label,
        title,
        summary,
        depth: 0,
        sticky,
        severity: d.severity,
        children: [],
        atomIds: [atom.id],
        nestKey: instanceKey ?? undefined,
      }
      attach(node, parent)
      if (instanceKey) {
        openByKey.set(instanceKey, node)
        stack.push(instanceKey)
      }

      if (isTerminal && instanceKey) {
        closeKey(instanceKey)
      }
      continue
    }

    // leaf
    const parent = findOpenParent(d.family)
    const node: OutlineNode = {
      id: `leaf-${seq++}-${atom.id}`,
      kind: "leaf",
      family: d.family,
      label,
      title,
      summary,
      depth: 0,
      sticky: false,
      severity: d.severity,
      atomIds: [atom.id],
    }
    attach(node, parent)
  }

  return roots
}

/** Trace ViewSpec — step owns call + work as peers (Subagent nesting). */
export const TRACE_VIEW_SPEC: ViewSpec = {
  id: "trace",
  // Context lives in preamble; llm-response is Call body, not a spine leaf.
  excludeTypes: ["system-prompt", "tools-resolved", "llm-response", "answer.chunk", "direct_loop_fallback"],
  excludeFamilies: ["telemetry"],
  roleByFamily: {
    plan: "scope",
    pipeline: "scope",
    step: "scope",
    call: "scope",
    work: "leaf",
    verify: "scope",
    repair: "scope",
    context: "scope",
    input: "leaf",
    delegation: "leaf",
    answer: "leaf",
    error: "leaf",
    sync: "leaf",
    tool: "leaf",
    run: "leaf",
    misc: "omit",
  },
  roleByType: {
    goal: "leaf",
    "tools-filtered": "leaf",
    "planner-issue-timeline": "leaf",
    "planner-retry-skipped": "leaf",
    "planner-retry-abort": "leaf",
    "planner-delegation-decision": "leaf",
  },
  stickyFamilies: ["plan", "pipeline", "step", "call", "verify", "repair", "context"],
  nest: [
    { parentFamily: "step", childFamilies: ["call", "work", "input", "delegation"] },
    { parentFamily: "plan", childFamilies: [] },
    { parentFamily: "context", childFamilies: [] },
    { parentFamily: "verify", childFamilies: ["work"] },
    { parentFamily: "repair", childFamilies: ["work"] },
  ],
  terminalTypes: [
    "planner-step-end",
    "planner-pipeline-end",
    "planner-delegation-end",
  ],
  foldDefault: "latest",
}

/** Pipelines compact outline for a run's debug.trace slice. */
export const PIPELINES_TRACE_VIEW_SPEC: ViewSpec = {
  id: "pipelines-trace",
  excludeTypes: ["system-prompt", "tools-resolved", "llm-response", "answer.chunk"],
  excludeFamilies: ["telemetry"],
  roleByFamily: {
    plan: "scope",
    pipeline: "scope",
    step: "scope",
    call: "scope",
    work: "leaf",
    verify: "scope",
    repair: "scope",
    input: "leaf",
  },
  stickyFamilies: ["step", "call"],
  nest: [
    { parentFamily: "step", childFamilies: ["call", "work", "input"] },
  ],
  terminalTypes: [
    "planner-step-end",
    "planner-pipeline-end",
    "planner-delegation-end",
  ],
  foldDefault: "collapsed",
}
