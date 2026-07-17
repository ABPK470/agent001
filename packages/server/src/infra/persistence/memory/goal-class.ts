/**
 * Goal-class tags for episodic memory recall and cross-run affinity.
 *
 * Full reference: ./README.md (class table, affinity rules, syncreconcile vs comparison).
 */

const GOAL_CLASSES_TAIL_RE = /\[goalclasses ([^\]]+)\]/

/** Env labels common in cross-environment sync / reconcile goals. */
const ENV_LABEL_RE = /\b(?:uat|dev|prod|production|staging|de|qa|test|source|target)\b/i

const CROSS_ENV_VS_RE = new RegExp(
  String.raw`\b(?:uat|dev|prod|production|staging|de|qa|test|source|target)\b\s+vs\.?\s+\b(?:uat|dev|prod|production|staging|de|qa|test|source|target)\b`,
  "i"
)

const CROSS_ENV_BETWEEN_RE = new RegExp(
  String.raw`\bbetween\s+(?:uat|dev|prod|production|staging|de|qa|test|source|target)\b\s+and\s+\b(?:uat|dev|prod|production|staging|de|qa|test|source|target)\b`,
  "i"
)

/**
 * Task-shape tags — discriminating affinity (rank vs count vs reconcile vs lookup).
 * Ambient modifiers (comparison, timefiltered) are excluded; they appear across shapes.
 */
export const AFFINITY_SHAPE_CLASSES = new Set([
  "rankbymetric",
  "aggregateby",
  "syncreconcile",
  "lookup",
  "exportfile",
  "pivotbydim"
])

const CLASSIFIERS: Array<{ tag: string; re: RegExp }> = [
  {
    tag: "rankbymetric",
    re: /\b(top|bottom)\s+\d+\b|\b(highest|lowest|biggest|smallest|largest|leading)\b/i
  },
  { tag: "aggregateby", re: /\b(sum|total|average|avg|mean|median|count|how\s+(?:many|much)|distinct)\b/i },
  {
    tag: "comparison",
    re:
      /\b(compared\s+to|comparison\s+of|difference\s+between|change\s+(?:between|in|over)|growth|trend|trends|year\s*over\s*year|yoy|mom|month\s*over\s*month|qoq|quarter\s*over\s*quarter)\b/i
  },
  {
    tag: "syncreconcile",
    re:
      /\b(?:out\s+of\s+sync|reconcil\w*|desync|(?:meta)?data\s+drift|drift(?:ed|ing|s)?|diverg(?:e|ent|ence|ing)?|mismatch(?:ed|es|ing)?|sync_diff|sync_preview|sync_execute|compare[\s._-]?catalog)\b/i
  },
  {
    tag: "timefiltered",
    re: /\b(20\d{2}|q[1-4]\b|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|ytd|mtd|qtd|wtd|fiscal\s+year|last\s+(?:month|year|quarter|week))\b/i
  },
  {
    tag: "pivotbydim",
    re: /\b(?:by|per)\s+(client|customer|product|month|year|quarter|day|week|region|branch|account|sector|industry|country|currency)s?\b/i
  },
  { tag: "lookup", re: /\b(what\s+(?:is|are|tables?)|show\s+me|list|find|look\s*up|describe|explain)\b/i },
  {
    tag: "exportfile",
    re: /\b(export|download|save\s+to|write\s+to\s+file|to\s+(?:csv|xlsx|parquet|json))\b/i
  }
]

/** Classes that imply a warehouse read/analyze task (not sync reconciliation). */
export const DATA_QUERY_GOAL_CLASSES = new Set([
  "rankbymetric",
  "aggregateby",
  "comparison",
  "lookup",
  "pivotbydim",
  "timefiltered",
  "exportfile"
])

/** Narrower subset for dbScore — excludes generic lookup phrasing ("show me"). */
export const DB_INTENT_GOAL_CLASSES = new Set([
  "rankbymetric",
  "aggregateby",
  "comparison",
  "pivotbydim",
  "timefiltered",
  "exportfile"
])

/**
 * Returns CamelCase class tags for the goal, in stable order, deduped.
 * Empty when no classifier matches.
 */
export function extractGoalClasses(goal: string): string[] {
  if (!goal) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const c of CLASSIFIERS) {
    if (seen.has(c.tag)) continue
    if (c.re.test(goal)) {
      out.push(c.tag)
      seen.add(c.tag)
    }
  }
  if (!seen.has("syncreconcile") && !seen.has("aggregateby") && hasCrossEnvReconcileShape(goal)) {
    out.push("syncreconcile")
  }
  return out
}

/** Cross-env phrasing without explicit reconcile vocabulary (uat vs dev, between uat and dev). */
function hasCrossEnvReconcileShape(goal: string): boolean {
  if (!ENV_LABEL_RE.test(goal)) return false
  if (/\b(?:how\s+many|how\s+much|count|distinct|number\s+of|total)\b/i.test(goal)) return false
  return CROSS_ENV_VS_RE.test(goal) || CROSS_ENV_BETWEEN_RE.test(goal)
}

/** Parse `[goalclasses …]` tail from a stored episodic goal line or summary. */
export function parseGoalClassesFromStored(text: string): string[] {
  const m = text.match(GOAL_CLASSES_TAIL_RE)
  if (!m?.[1]) return []
  return m[1].split(/\s+/).filter(Boolean)
}

/** True when two goal class sets share at least one task-shape tag. */
export function goalClassesShareAffinity(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return true

  const aShape = a.filter((tag) => AFFINITY_SHAPE_CLASSES.has(tag))
  const bShape = b.filter((tag) => AFFINITY_SHAPE_CLASSES.has(tag))

  if (aShape.length > 0 || bShape.length > 0) {
    if (aShape.length === 0 || bShape.length === 0) return false
    const bSet = new Set(bShape)
    return aShape.some((tag) => bSet.has(tag))
  }

  const right = new Set(b)
  return a.some((tag) => right.has(tag))
}

/**
 * Episodic shortcut is allowed when the remembered run's goal classes
 * overlap the current goal's classes (same task shape).
 */
export function episodicShortcutMatchesGoal(
  currentGoal: string,
  episodicEntries: ReadonlyArray<{ content: string; metadata?: Record<string, unknown> }>
): boolean {
  const current = extractGoalClasses(currentGoal)
  if (current.length === 0) return true
  return episodicEntries.some((entry) => {
    const fromMeta = entry.metadata?.["goalClasses"]
    const stored = Array.isArray(fromMeta)
      ? fromMeta.filter((x): x is string => typeof x === "string")
      : parseGoalClassesFromStored(entry.content)
    if (stored.length === 0) return true
    return goalClassesShareAffinity(current, stored)
  })
}

export function renderClassTail(classes: readonly string[]): string {
  if (classes.length === 0) return ""
  return `\n[goalclasses ${classes.join(" ")}]`
}

/** Augment an episodic FTS query with class tags from the current goal. */
export function augmentGoalQueryForFts(goal: string): string {
  const classes = extractGoalClasses(goal)
  return classes.length > 0 ? `${goal} ${classes.join(" ")}` : goal
}
