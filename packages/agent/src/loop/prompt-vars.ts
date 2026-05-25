/**
 * Prompt template variable substitution.
 *
 * Phase 7 of the de-hardcode refactor: the markdown prompts under
 * `packages/agent/prompts/` switched from literal customer-specific
 * table/column names ("publish.Revenue", "pkClient", "dim.Date") to
 * `{{placeholder}}` tokens. This module computes the substitution
 * vocabulary from the live catalog + tenant config and applies it to
 * any template string just-in-time before the prompt is shipped to
 * the model.
 *
 * The defaults preserve the original deployment's verbatim text
 * (mirrorSchema='persistedView', wideUnionView='publish.Revenue', …)
 * so existing deployments stay bit-identical when neither the catalog
 * nor the tenant config provides a tenant-specific value.
 *
 * Why mustache-lite instead of a real templating engine: prompts are
 * authored by humans, must remain valid markdown when read raw, and
 * substitutions are a flat string map. `{{foo}}` is the smallest
 * surface that meets the contract.
 */
import { getTenantConfig } from "../tenant/config.js"
import {
    type CatalogAccessor,
    calendarDimensionTable,
    dateGrainColumn,
    defaultCatalogAccessor,
    listExpensiveUnionViews,
    primaryKeyColumns,
    topNTables,
    topNUnionViews,
} from "../tools/index.js"

export interface PromptVars {
  mirrorSchema:          string
  wideUnionView:         string
  wideUnionView2:        string
  wideUnionViewBranches: string
  biggestFact:           string
  centralDim:            string
  centralDim2:           string
  dateKeyExample:        string
  keyColumnExample:      string
  calendarDim:           string
  branchExample:         string
  branchExample2:        string
}

/** Static fallbacks — match the pre-refactor literal values verbatim. */
const FALLBACK: PromptVars = Object.freeze({
  mirrorSchema:          "<mirrorSchema>",
  wideUnionView:         "<wide-union-view>",
  wideUnionView2:        "<other-wide-union-view>",
  wideUnionViewBranches: "many",
  biggestFact:           "<biggest-fact-table>",
  centralDim:            "<central-dimension-table>",
  centralDim2:           "<other-dimension-table>",
  dateKeyExample:        "<dateKeyColumn>",
  keyColumnExample:      "<keyColumn>",
  calendarDim:           "<calendar-dimension-table>",
  branchExample:         "<branch-view-A>",
  branchExample2:        "<branch-view-B>",
})

const promptVarsState = {
  cache: null as { fingerprint: string; vars: PromptVars } | null,
}

/** Test-only hook to clear the prompt-vars cache between tests. */
export function _resetPromptVarsCache(): void { promptVarsState.cache = null }

export interface BuildPromptVarsOptions {
  connection?: string
  accessor?: CatalogAccessor
}

/**
 * Build a PromptVars object from the live catalog + tenant config.
 * Cheap (catalog lookups are in-memory) and memoised on the
 * "(mirrorSchema, top-view, top-fact, top-dim)" fingerprint so
 * repeated renders in the same session pay the cost once.
 */
export function buildPromptVars(options: string | BuildPromptVarsOptions = "default"): PromptVars {
  const resolved = typeof options === "string"
    ? { connection: options }
    : options
  const tenant  = getTenantConfig()
  const catalog = (resolved.accessor ?? (() => defaultCatalogAccessor(resolved.connection ?? "default")))()
  const acc = () => catalog

  if (!catalog) return { ...FALLBACK, mirrorSchema: tenant.mirrorSchema ?? FALLBACK.mirrorSchema }

  const wideViews = [...listExpensiveUnionViews({ accessor: acc })]
    .sort((a, b) => b[1] - a[1])
  const topUnion = topNUnionViews(2, { accessor: acc })
  const wideQn  = wideViews[0]?.[0]
    ?? topUnion[0]?.table.qualifiedName
    ?? FALLBACK.wideUnionView
  const wideQn2 = wideViews[1]?.[0]
    ?? topUnion[1]?.table.qualifiedName
    ?? FALLBACK.wideUnionView2
  const wideBranches = wideViews[0]?.[1]
    ?? topUnion[0]?.branchCount
    ?? FALLBACK.wideUnionViewBranches

  // Largest fact-style table by row count.
  const tables = topNTables(20, { accessor: acc })
  const biggestFact = tables[0]?.qualifiedName ?? FALLBACK.biggestFact

  // Two central dimensions: pick from /^(dim|lookup|ref|master)/i schemas.
  const dims = tables.filter((t) => /^(dim|lookup|ref|master)/i.test(t.schema))
  const centralDim  = dims[0]?.qualifiedName ?? FALLBACK.centralDim
  const centralDim2 = dims[1]?.qualifiedName ?? FALLBACK.centralDim2

  // Date / key example columns drawn from the wide view and the
  // central dimension respectively.
  const dateKey = (wideQn !== FALLBACK.wideUnionView
    ? dateGrainColumn(wideQn, { accessor: acc })
    : null) ?? FALLBACK.dateKeyExample
  const keyCol  = (centralDim !== FALLBACK.centralDim
    ? primaryKeyColumns(centralDim, { accessor: acc })[0]
    : null) ?? FALLBACK.keyColumnExample
  const calendar = calendarDimensionTable({ accessor: acc }) ?? FALLBACK.calendarDim

  // Two example branches from wide view UNION definition.
  const branches = wideQn !== FALLBACK.wideUnionView
    ? catalog.getUnionBranches(wideQn)
    : []
  const branchExample  = branches[0] ?? FALLBACK.branchExample
  const branchExample2 = branches[1] ?? FALLBACK.branchExample2

  const vars: PromptVars = {
    mirrorSchema:          tenant.mirrorSchema ?? FALLBACK.mirrorSchema,
    wideUnionView:         wideQn,
    wideUnionView2:        wideQn2,
    wideUnionViewBranches: String(wideBranches),
    biggestFact,
    centralDim,
    centralDim2,
    dateKeyExample:        dateKey,
    keyColumnExample:      keyCol,
    calendarDim:           calendar,
    branchExample,
    branchExample2,
  }

  const fingerprint = JSON.stringify(vars)
  if (promptVarsState.cache?.fingerprint === fingerprint) return promptVarsState.cache.vars
  promptVarsState.cache = { fingerprint, vars }
  return vars
}

/**
 * Mustache-lite substitution. Replaces every occurrence of `{{key}}`
 * in `template` with `vars[key]`, leaving unknown tokens untouched
 * (deliberate — that surfaces a typo in the prompt instead of silently
 * substituting an empty string). Whitespace inside the braces is
 * tolerated.
 */
export function renderPromptVars(
  template: string,
  vars: Partial<PromptVars> = buildPromptVars(),
): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, key: string) => {
    const v = (vars as Record<string, unknown>)[key]
    return typeof v === "string" ? v : m
  })
}
