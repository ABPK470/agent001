/**
 * buildOutline — chronological EventAtom[] → OutlineNode[] via catalog + ViewSpec.
 *
 * Nest rules: while a parent scope (e.g. step) is open, child families
 * (call, work) attach under it instead of becoming spine peers.
 */

import {
  lookupEventDescriptor,
  type EventFamily,
  type EventPayload,
} from "@mia/shared-types"
import type { EventAtom, OutlineNode, ViewSpec, ViewSpecNestRule } from "./types"

function humanize(name: string): string {
  return name.replace(/_/g, " ")
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback
}

function allowedFamily(family: string, spec: ViewSpec): boolean {
  if (spec.includeFamilies && spec.includeFamilies.length > 0) {
    return spec.includeFamilies.includes(family)
  }
  return true
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
  if (type === "llm-request") {
    const iter = typeof payload.iteration === "number" ? payload.iteration : null
    return iter != null ? undefined : undefined
  }
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

/**
 * Build an outline tree.
 * Direct (empty-detail) plan chips are omitted — same as Trace today.
 */
export function buildOutline(atoms: EventAtom[], viewSpec: ViewSpec): OutlineNode[] {
  const roots: OutlineNode[] = []
  /** Open scopes by nestKey (mutated in place; already on tree). */
  const openByKey = new Map<string, OutlineNode>()
  /** Stack of open nestKeys for parent lookup (innermost last). */
  const stack: string[] = []
  let seq = 0

  function closeKey(key: string) {
    openByKey.delete(key)
    const idx = stack.lastIndexOf(key)
    if (idx >= 0) stack.splice(idx, 1)
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
      // Same-family leaf under open scope (e.g. llm-response under Call).
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
    if (viewSpec.excludeTypes?.includes(atom.type)) continue

    const desc = lookupEventDescriptor(atom.type)
    if (desc.outline === "ignore") continue
    if (!allowedFamily(desc.family, viewSpec)) continue

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
    if (d.outline === "ignore") continue
    if (!allowedFamily(d.family, viewSpec)) continue

    // Skip bare Direct routing chips
    if (
      type === "planner-decision" &&
      (payload.shouldPlan === false || payload.route === "direct") &&
      d.outline === "scope"
    ) {
      continue
    }

    const nestKey = d.nestKey?.(payload) ?? null
    const summary = d.summary(payload)
    const label = scopeLabel(type, payload, d.label, d.family)
    const title = scopeTitle(type, payload, d.family)

    const isTerminal =
      type === "planner-step-end" ||
      type === "planner-pipeline-end" ||
      type === "planner-delegation-end"

    if (d.outline === "scope") {
      if (nestKey && openByKey.has(nestKey)) {
        const existing = openByKey.get(nestKey)!
        existing.summary = summary
        // Keep Subagent lead once established (step-end would otherwise downgrade).
        if (!(existing.label === "Subagent" && label === "Step")) {
          existing.label = label
        }
        if (title) existing.title = title
        existing.atomIds.push(atom.id)
        existing.severity = d.severity
        // Terminal statuses close after merge
        if (isTerminal) {
          closeKey(nestKey)
        }
        continue
      }

      // Terminal after scope already closed (e.g. step-end after delegation-end)
      // — fold into the existing node; do not open a duplicate.
      if (isTerminal && nestKey) {
        const closed = findNodeByNestKey(roots, nestKey)
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

      // Opening a new family scope closes previous peers of same family
      // unless nest key continues (handled above).
      if (nestKey) {
        for (const [key, node] of [...openByKey.entries()]) {
          if (node.family === d.family && key !== nestKey) closeKey(key)
        }
      } else {
        closeFamily(d.family)
      }

      const parent = findOpenParent(d.family)
      const node: OutlineNode = {
        id: `scope-${seq++}-${nestKey ?? type}`,
        kind: "scope",
        family: d.family,
        label,
        title,
        summary,
        depth: 0,
        sticky: d.sticky,
        severity: d.severity,
        children: [],
        atomIds: [atom.id],
        nestKey: nestKey ?? undefined,
      }
      attach(node, parent)
      if (nestKey) {
        openByKey.set(nestKey, node)
        stack.push(nestKey)
      }

      // Terminal step/pipeline/verify statuses close the scope after merge
      if (isTerminal) {
        if (nestKey) closeKey(nestKey)
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
  excludeTypes: ["system-prompt", "tools-resolved", "llm-response"],
  nest: [
    { parentFamily: "step", childFamilies: ["call", "work", "input", "delegation"] },
    { parentFamily: "plan", childFamilies: [] },
    { parentFamily: "context", childFamilies: [] },
    { parentFamily: "verify", childFamilies: ["work"] },
    { parentFamily: "repair", childFamilies: ["work"] },
  ],
  foldDefault: "latest",
}

/** Pipelines compact outline for a run's debug.trace slice. */
export const PIPELINES_TRACE_VIEW_SPEC: ViewSpec = {
  id: "pipelines-trace",
  excludeTypes: ["system-prompt", "tools-resolved", "llm-response"],
  nest: [
    { parentFamily: "step", childFamilies: ["call", "work", "input"] },
  ],
  foldDefault: "collapsed",
}
