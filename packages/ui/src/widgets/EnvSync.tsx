/**
 * EnvSync — ABI Environment Sync widget  (v6 — platform-native)
 *
 * Design:
 *   - Matches the platform's accent-violet design language
 *   - Compact toolbar: direction + entity + send-style preview on left,
 *     recipe/history actions on right — all one row
 *   - No extra colors — everything uses var(--color-accent) and muted tones
 *   - Preview button = circular filled accent, same as chat send button
 */

import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  Eye,
  History,
  Key,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Ship,
  View,
  X,
  XCircle
} from "lucide-react"
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { createPortal } from "react-dom"
import { api, syncExecuteStream } from "../api"
import { Listbox, type ListboxOption } from "../components/Listbox"
import { useContainerSize } from "../hooks/useContainerSize"
import { useStore } from "../store"
import type {
  SyncEntityType,
  SyncEnvironment,
  SyncExecuteProgress,
  SyncPlan,
  SyncPlanTable,
  SyncRecipe,
  SyncRecipeBundle,
} from "../types"
import { timeAgo } from "../util"

// ─────────────────────────────────────────────────────────────────

const ENTITY_TYPES: SyncEntityType[] = [
  "contract", "dataset", "rule", "pipelineActivity", "gateMetadata", "content",
]

function recipeDefaultOptionalTables(recipe: SyncRecipe | null): string[] {
  if (!recipe) return []
  return recipe.tables
    .filter((table) => table.userControllable && table.enabledByDefault)
    .map((table) => table.name)
}

function normalizeOptionalTableSelection(recipe: SyncRecipe | null, selected: string[] | null): string[] {
  if (!recipe) return Array.isArray(selected) ? [...selected] : []
  const allowed = new Set(recipe.tables.filter((table) => table.userControllable).map((table) => table.name))
  const base = Array.isArray(selected) ? selected : recipeDefaultOptionalTables(recipe)
  return base.filter((tableName, index, arr) => allowed.has(tableName) && arr.indexOf(tableName) === index)
}

type ExecState =
  | { kind: "idle" }
  | { kind: "running"; events: SyncExecuteProgress[] }
  | { kind: "done"; success: boolean; events: SyncExecuteProgress[]; error?: string }
type HistoryRow = { planId: string; actor: string; action: string; detail: unknown; timestamp: string }
type ModalKind = null | "recipe" | "history"

// ── Module-level exec store ──────────────────────────────────────
// Survives component unmounts (view switches). The SSE stream keeps
// running and events accumulate here. Components subscribe via
// useSyncExternalStore so they re-render on every update.

let _execState: ExecState = { kind: "idle" }
let _execPlanId: string | null = null
let _execStream: { close: () => void } | null = null
const _execListeners = new Set<() => void>()

function _notifyExec() { _execListeners.forEach((l) => l()) }

function getExecSnapshot(): ExecState { return _execState }
function getExecPlanId(): string | null { return _execPlanId }
function subscribeExec(cb: () => void): () => void {
  _execListeners.add(cb)
  return () => { _execListeners.delete(cb) }
}

function startExecStream(planId: string) {
  _execStream?.close()
  const events: SyncExecuteProgress[] = []
  _execState = { kind: "running", events }
  _execPlanId = planId
  _notifyExec()

  _execStream = syncExecuteStream(planId,
    (ev) => {
      events.push(ev)
      if (ev.type === "completed" || ev.type === "failed") {
        _execState = { kind: "done", success: ev.type === "completed", events: [...events], error: ev.error }
        _execStream?.close()
        _execStream = null
      } else {
        _execState = { kind: "running", events: [...events] }
      }
      _notifyExec()
    },
    (err) => {
      _execState = { kind: "done", success: false, events: [...events], error: err }
      _execStream?.close()
      _execStream = null
      _notifyExec()
    },
  )
}

function resetExec() {
  _execStream?.close()
  _execStream = null
  _execState = { kind: "idle" }
  _execPlanId = null
  _notifyExec()
}

function dot(c: string): string {
  const m: Record<string, string> = {
    slate:   "var(--color-text-muted)",
    blue:    "var(--color-accent-soft)",
    teal:    "var(--color-accent)",
    indigo:  "var(--color-accent-hover)",
    pink:    "var(--color-accent-soft)",
    cyan:    "var(--color-accent)",
    amber:   "var(--color-accent-soft)",
    emerald: "var(--color-accent)",
    rose:    "var(--color-accent-hover)",
  }
  return m[c] ?? "var(--color-text-muted)"
}

// ── Platform-native palette ────────────────────────────────────
// Uses the platform's accent violet throughout. No foreign colors.
const DIFF = {
  ins:    "var(--color-accent)",
  upd:    "var(--color-viz-peach)",
  del:    "var(--color-viz-coral)",
  eqDim:  "var(--color-text-muted)",
  oldRow: "var(--color-text-muted)",
  newRow: "var(--color-accent)",
} as const

// ── Main ─────────────────────────────────────────────────────────

export function EnvSync() {
  const [envs, setEnvs] = useState<SyncEnvironment[]>([])
  const [recipes, setRecipes] = useState<SyncRecipeBundle | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [modal, setModal] = useState<ModalKind>(null)
  /** Badge shown on the History button when an agent-triggered sync arrives and history hasn't been reviewed. */
  const [hasNewAgentSync, setHasNewAgentSync] = useState(false)
  const isFirstMountRef = useRef(true)

  const form = useStore((s) => s.envSyncForm)
  const setForm = useStore((s) => s.setEnvSyncForm)
  const agentSyncExec = useStore((s) => s.agentSyncExec)
  const clearAgentSyncExec = useStore((s) => s.clearAgentSyncExec)
  const agentSyncExecStarted = useStore((s) => s.agentSyncExecStarted)
  const { source, target, entityId, force } = form
  const searchMode = form.searchMode ?? "id"
  const entityType = form.entityType as SyncEntityType

  const [previewing, setPreviewing] = useState(false)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [plan, setPlan] = useState<SyncPlan | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [execModalOpen, setExecModalOpen] = useState(false)
  const exec = useSyncExternalStore(subscribeExec, getExecSnapshot)
  const execPlanId = useSyncExternalStore(subscribeExec, getExecPlanId)

  /**
   * Signature of the form values that produced the current `plan`.
   * When the user changes any of these (new id/name, swaps env, etc.) we
   * treat it as a new "session": clear the stale plan so the Execute
   * button can't ship the previously-previewed payload by accident.
   * A live (running) execution is kept — only `done` exec state is reset.
   */
  const planSigRef = useRef<string | null>(null)

  // ── Name search state ──
  type SearchHit = { id: string | number; name: string | null }
  const [searchResults, setSearchResults] = useState<SearchHit[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchBoxRef = useRef<HTMLDivElement>(null)
  /** When user picks a name-search hit, we show the name but store the id in entityId. */
  const [displayLabel, setDisplayLabel] = useState<string | null>(null)

  const srcEnv = useMemo(() => envs.find((e) => e.name === source) ?? null, [envs, source])
  const tgtEnv = useMemo(() => envs.find((e) => e.name === target) ?? null, [envs, target])
  const recipe: SyncRecipe | null = recipes?.recipes[entityType] ?? null
  const enabledOptionalTables = useMemo(
    () => normalizeOptionalTableSelection(recipe, form.enabledOptionalTables),
    [recipe, form.enabledOptionalTables],
  )
  const formSig = `${source}|${target}|${entityType}|${entityId}|${force}|${searchMode}|${[...enabledOptionalTables].sort().join(",")}`

  useEffect(() => {
    if (!recipe) return
    if (!Array.isArray(form.enabledOptionalTables)) return
    if (
      enabledOptionalTables.length === form.enabledOptionalTables.length &&
      enabledOptionalTables.every((tableName, index) => tableName === form.enabledOptionalTables?.[index])
    ) {
      return
    }
    setForm({ enabledOptionalTables })
  }, [enabledOptionalTables, form.enabledOptionalTables, recipe, setForm])

  const [searchErr, setSearchErr] = useState<string | null>(null)

  // Close search dropdown on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (searchBoxRef.current?.contains(e.target as Node)) return
      setSearchOpen(false); setSearchErr(null)
    }
    document.addEventListener("mousedown", handle)
    return () => document.removeEventListener("mousedown", handle)
  }, [])

  // Debounced name search

  function onSearchInput(value: string) {
    setDisplayLabel(null) // user is typing — clear any picked label
    setSearchErr(null)
    setForm({ entityId: value })
    if (searchMode !== "name" || !value.trim() || !source) {
      setSearchResults([]); setSearchOpen(false); return
    }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(async () => {
      setSearchLoading(true)
      try {
        const hits = await api.syncSearch({ entityType, source, q: value.trim() })
        setSearchResults(hits); setSearchOpen(hits.length > 0)
        if (hits.length === 0) setSearchErr("No matches")
      } catch (e) {
        setSearchResults([]); setSearchOpen(false)
        setSearchErr(e instanceof Error ? e.message : String(e))
      }
      finally { setSearchLoading(false) }
    }, 300)
  }

  function pickSearchHit(hit: SearchHit) {
    setForm({ entityId: String(hit.id) })
    setDisplayLabel(hit.name ? `${hit.name} (${hit.id})` : String(hit.id))
    setSearchOpen(false); setSearchResults([]); setSearchErr(null)
  }

  // Tracks which planId the reactive hydrate-effect has already loaded.
  // Declared early so the mount effect can mark a hydrated planId as
  // "already loaded" to suppress auto-fetch on cold start.
  const loadedPlanIdRef = useRef<string | null>(null)

  useEffect(() => {
    let dead = false
    Promise.all([api.syncEnvironments(), api.syncRecipes()])
      .then(([e, r]) => {
        if (dead) return
        setEnvs(e); setRecipes(r)
        const p: Partial<typeof form> = {}
        if (e.length >= 1 && !source) p.source = e[0].name
        if (e.length >= 2 && !target) p.target = e[1].name
        else if (e.length === 1 && !target) p.target = e[0].name
        if (Object.keys(p).length) setForm(p)
      })
      .catch((err) => !dead && setLoadErr(err instanceof Error ? err.message : String(err)))
    // Do NOT auto-load any previous plan/preview on mount — user must
    // explicitly initiate a sync (or open History) to load past data.
    // Mark any persisted planId as "already loaded" so the reactive effect
    // below doesn't fetch it on hydration.
    if (form.planId) loadedPlanIdRef.current = form.planId
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── React to agent-triggered preview (chat → sync widget) ────
  // When the agent calls sync_preview from chat, the store sets form.planId.
  // Load and display the plan automatically so the user can see the full diff.
  useEffect(() => {
    const newPlanId = form.planId
    if (!newPlanId || newPlanId === plan?.planId || newPlanId === loadedPlanIdRef.current) return
    loadedPlanIdRef.current = newPlanId
    api.syncPlan(newPlanId).then((p) => {
      if (p.error) {
        setPreviewErr(`Plan expired or not found — preview data is no longer available (plans have a 1h TTL).`)
        setForm({ planId: null }); loadedPlanIdRef.current = null; return
      }
      setPlan(p); setPreviewErr(null); setExpanded(new Set())
      // Populate form fields from the plan so toolbar reflects what the agent used.
      // Show entity display name in the search input if available.
      const entityName = p.entity.displayName ?? null
      const entityIdStr = String(p.entity.id)
      setForm({
        source: p.source,
        target: p.target,
        entityType: p.recipeSnapshot?.entityType ?? form.entityType,
        entityId: entityIdStr,
        enabledOptionalTables: p.recipeSnapshot?.enabledOptionalTables ?? null,
      })
      if (entityName) setDisplayLabel(`${entityName} (${entityIdStr})`)
      planSigRef.current = `${p.source}|${p.target}|${p.recipeSnapshot?.entityType ?? form.entityType}|${entityIdStr}|false|id|${[...normalizeOptionalTableSelection(recipes?.recipes[p.recipeSnapshot?.entityType ?? form.entityType] ?? null, p.recipeSnapshot?.enabledOptionalTables ?? null)].sort().join(",")}`
      // Mark history as having new data (skip on the very first mount hydration)
      if (!isFirstMountRef.current) setHasNewAgentSync(true)
    }).catch(() => { setForm({ planId: null }); loadedPlanIdRef.current = null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.planId])

  // Clear first-mount flag after initial render
  useEffect(() => { isFirstMountRef.current = false }, [])

  // ── React to agent execute started (chat → sync widget: live streaming) ────
  // When the agent calls sync_execute from chat, start the SSE execute stream
  // so the widget shows live per-table progress, exactly as if the user had
  // clicked Execute themselves. Also auto-open the exec modal.
  useEffect(() => {
    if (!agentSyncExecStarted) return
    startExecStream(agentSyncExecStarted)
    setExecModalOpen(true)
    setHasNewAgentSync(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSyncExecStarted])

  // ── React to agent-triggered execute completion (chat → sync widget) ────
  // When the agent execute finishes and the store has the final result,
  // show it in the exec state and open the modal so the user sees the outcome.
  useEffect(() => {
    if (!agentSyncExec) return
    _execState = {
      kind: "done",
      success: agentSyncExec.success,
      events: [{
        type: agentSyncExec.success ? "completed" : "failed",
        error: agentSyncExec.success ? undefined : agentSyncExec.result,
      } as SyncExecuteProgress],
    }
    _execPlanId = agentSyncExec.planId
    _notifyExec()
    clearAgentSyncExec()
    setExecModalOpen(true)
    setHasNewAgentSync(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSyncExec])

  const blocker =
    !source || !target ? "Pick source + target"
    : source === target ? "Source ≠ target"
    : !entityId.trim() ? `Enter ${searchMode === "name" ? (recipe?.rootNameColumn ?? "name") : (recipe?.rootKeyColumn ?? "id")}`
    : !recipe ? "No recipe" : null
  const canPreview = !blocker && !previewing

  async function onPreview() {
    if (!canPreview) return
    setPreviewing(true); setPreviewErr(null); setPlan(null)
    resetExec(); setExpanded(new Set())
    planSigRef.current = null
    try {
      const id: string | number = /^\d+$/.test(entityId.trim()) ? Number(entityId.trim()) : entityId.trim()
      const requestEnabledOptionalTables = Array.isArray(form.enabledOptionalTables) ? enabledOptionalTables : undefined
      const r = await api.syncPreview({ entityType, entityId: id, source, target, force, enabledOptionalTables: requestEnabledOptionalTables })
      if (r.error) { setPreviewErr(r.error); setForm({ planId: null }) }
      else {
        setPlan(r); setForm({ planId: r.planId })
        // Snapshot the inputs that produced this plan, so we can detect drift.
        planSigRef.current = `${source}|${target}|${entityType}|${entityId}|${force}|${searchMode}|${[...enabledOptionalTables].sort().join(",")}`
      }
    } catch (e) { setPreviewErr(e instanceof Error ? e.message : String(e)); setForm({ planId: null }) }
    finally { setPreviewing(false) }
  }

  // If the user changes any input after a plan was built, invalidate it.
  // Keep a live (running) execution visible via the indicator; only clear
  // a finished (done) exec, since the user has clearly moved on.
  useEffect(() => {
    if (!plan || !planSigRef.current) return
    if (planSigRef.current === formSig) return
    setPlan(null); setForm({ planId: null }); setExpanded(new Set())
    setExecModalOpen(false)
    if (exec.kind !== "running") resetExec()
    planSigRef.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formSig])

  function onExecConfirmed() {
    if (!plan) return
    startExecStream(plan.planId)
  }

  if (loadErr) {
    return <Err>{loadErr}</Err>
  }

  const srcOpts: ListboxOption<string>[] = envs.filter((e) => e.role !== "target").map((e) => ({ value: e.name, label: e.displayName.toUpperCase(), dot: dot(e.color) }))
  const tgtOpts: ListboxOption<string>[] = envs.filter((e) => e.role !== "source").map((e) => ({ value: e.name, label: e.displayName.toUpperCase(), dot: dot(e.color) }))
  const entOpts: ListboxOption<SyncEntityType>[] = ENTITY_TYPES.map((t) => ({
    value: t, label: recipes?.recipes[t]?.displayName ?? t, disabled: !recipes?.recipes[t],
  }))

  const hasPlan = !!plan
  const hasChanges = plan ? plan.totals.insert + plan.totals.update + plan.totals.delete > 0 : false
  const hasConflicts = plan ? (plan.totals.conflicts ?? 0) > 0 : false
  const expired = plan ? (Date.now() - plan.createdAtMs) > 3600_000 : false

  // ── Container-aware layout ─────────────────────────────
  const rootRef = useRef<HTMLDivElement>(null)
  const { width: rootWidth } = useContainerSize(rootRef)
  const compact = rootWidth > 0 && rootWidth < 800
  const stacked = rootWidth > 0 && rootWidth < 580
  const tiny    = rootWidth > 0 && rootWidth < 420
  const [moreOpen, setMoreOpen] = useState(false)

  return (
    <div ref={rootRef} className="h-full overflow-hidden flex flex-col gap-3 text-text pb-1">
      {/* ── Header card — controls ────────────────────────── */}
      <div className="rounded-lg border border-border-subtle shrink-0">
        <div className={`px-3 py-2 ${stacked ? "flex flex-col gap-2" : "flex items-center gap-2"}`}>

          {/* ── Row 1 (or full row when wide): env + entity ── */}
          <div className={`flex items-center gap-2 ${stacked ? "w-full" : "shrink-0"}`}>
            {!compact && <span className="text-xs font-medium text-text-muted/50 uppercase tracking-wide shrink-0">From</span>}
            <Listbox value={source} options={srcOpts} onChange={(v) => setForm({ source: v })} size="md" variant="ghost" ariaLabel="Source" className="w-24" />
            {!compact && <span className="text-xs font-medium text-text-muted/50 uppercase tracking-wide shrink-0">To</span>}
            {compact && <span className="text-xs text-text-muted/40 shrink-0">→</span>}
            <Listbox value={target} options={tgtOpts} onChange={(v) => setForm({ target: v })} size="md" variant="ghost" ariaLabel="Target" className="w-24" />

            {!stacked && <div className="h-4 w-px bg-overlay-3 shrink-0" />}

            <Listbox value={entityType} options={entOpts} onChange={(v) => setForm({ entityType: v })} size="md" variant="ghost" ariaLabel="Entity type" />
          </div>

          {/* ── Row 2 (when stacked) or middle (when wide): search + ID/Name ── */}
          <div className={`flex items-center gap-2 ${stacked ? "w-full" : "flex-1 min-w-0"}`}>
            {/* ID / Name toggle */}
            <button
              onClick={() => { setForm({ searchMode: searchMode === "id" ? "name" : "id", entityId: "" }); setDisplayLabel(null); setSearchResults([]); setSearchOpen(false) }}
              className={`flex items-center justify-center gap-1 text-sm text-text-muted/60 hover:text-text py-1 rounded hover:bg-elevated transition-colors select-none shrink-0 ${tiny ? "w-9" : "w-16"}`}
              title={searchMode === "id" ? "Switch to name search" : "Switch to ID search"}
            >
              {searchMode === "id" ? <Key size={13} /> : <Search size={13} />}
              {!tiny && (searchMode === "id" ? "ID" : "Name")}
            </button>

            {/* Search input with typeahead */}
            <div className="relative flex-1 min-w-0" ref={searchBoxRef}>
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted/40 pointer-events-none" />
              <input
                value={displayLabel ?? entityId}
                onChange={(e) => onSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && onPreview()}
                onFocus={() => { if (searchMode === "name" && searchResults.length) setSearchOpen(true) }}
                placeholder={searchMode === "id" ? (recipe?.rootKeyColumn ?? "id") : (recipe?.rootNameColumn ?? "name")}
                className={`w-full bg-base text-text text-sm pl-7 pr-2 py-1.5 rounded border border-border-subtle outline-none focus:border-accent placeholder:text-text-muted/40 ${displayLabel ? "" : "font-mono"}`}
              />
              {searchLoading && (
                <Loader2 size={12} className="absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-text-muted/40" />
              )}
              {searchOpen && searchResults.length > 0 && (
                <div className="absolute top-full left-0 mt-1 w-full max-w-[24rem] max-h-[min(280px,50vh)] overflow-y-auto bg-elevated border border-border rounded shadow-lg z-50">
                  {searchResults.map((h) => (
                    <button
                      key={String(h.id)}
                      onClick={() => pickSearchHit(h)}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-surface transition-colors flex items-center gap-3"
                    >
                      <span className="text-text-muted font-mono text-sm shrink-0">{String(h.id)}</span>
                      <span className="truncate">{h.name ?? "—"}</span>
                    </button>
                  ))}
                </div>
              )}
              {!searchOpen && !searchLoading && searchErr && (
                <div className="absolute top-full left-0 mt-1 w-64 bg-elevated border border-border rounded shadow-lg z-50 px-3 py-2 text-xs text-text-muted">
                  {searchErr}
                </div>
              )}
            </div>

            {/* Right: actions — collapse into ⋯ menu when compact */}
            {compact ? (
              <div className="relative shrink-0">
                <button
                  onClick={() => setMoreOpen((v) => !v)}
                  className="text-text-muted/60 hover:text-text p-1.5 rounded hover:bg-elevated transition-colors"
                  title="More"
                >
                  <MoreHorizontal size={16} />
                </button>
                {moreOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 bg-elevated border border-border rounded-md shadow-2xl py-1 min-w-[160px]">
                      {hasPlan && (
                        <button
                          onClick={() => { setPlan(null); setForm({ planId: null }); resetExec(); setExecModalOpen(false); setMoreOpen(false) }}
                          className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-text-muted hover:text-text hover:bg-overlay-2 transition-colors"
                        >
                          <X size={14} /> Clear plan
                        </button>
                      )}
                      <button
                        onClick={() => { setModal("recipe"); setMoreOpen(false) }}
                        className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-text-muted hover:text-text hover:bg-overlay-2 transition-colors"
                      >
                        <BookOpen size={14} /> Recipe
                      </button>
                      <button
                        onClick={() => { setModal("history"); setMoreOpen(false); setHasNewAgentSync(false) }}
                        className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-text-muted hover:text-text hover:bg-overlay-2 transition-colors"
                      >
                        <History size={14} /> History
                        {hasNewAgentSync && <span className="ml-auto w-2 h-2 rounded-full bg-accent shrink-0" />}
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <>
                {hasPlan && (
                  <button
                    onClick={() => { setPlan(null); setForm({ planId: null }); resetExec(); setExecModalOpen(false) }}
                    className="text-text-muted/60 hover:text-text p-1.5 rounded hover:bg-elevated transition-colors shrink-0"
                    title="Clear plan"
                  >
                    <X size={16} />
                  </button>
                )}
                <button
                  onClick={() => setModal("recipe")}
                  className="text-text-muted/60 hover:text-text p-1.5 rounded hover:bg-elevated transition-colors shrink-0"
                  title="Recipe"
                >
                  <BookOpen size={16} />
                </button>
                <button
                  onClick={() => { setModal("history"); setHasNewAgentSync(false) }}
                  className="relative text-text-muted/60 hover:text-text p-1.5 rounded hover:bg-elevated transition-colors shrink-0"
                  title="History"
                >
                  <History size={16} />
                  {hasNewAgentSync && (
                    <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-accent" />
                  )}
                </button>
              </>
            )}

            {!stacked && <div className="h-4 w-px bg-overlay-3 shrink-0" />}

            {/* Live execution indicator */}
            {exec.kind !== "idle" && (
              <button
                onClick={() => setExecModalOpen(true)}
                title={exec.kind === "running" ? "Execution in progress — click to view" : exec.kind === "done" && exec.success ? "Sync completed" : "Sync failed — click to view"}
                className={`flex items-center justify-center shrink-0 transition-colors rounded-lg w-9 h-9 ${
                  exec.kind === "running"
                    ? "bg-accent"
                    : "border border-border-subtle hover:bg-elevated"
                }`}
              >
                {exec.kind === "running" && <Loader2 size={16} className="animate-spin text-text" />}
                {exec.kind === "done" && exec.success && <CheckCircle2 size={16} style={{ color: DIFF.ins }} />}
                {exec.kind === "done" && !exec.success && <XCircle size={16} style={{ color: DIFF.del }} />}
              </button>
            )}

            {/* Preview */}
            {/*
             * Preview button.
             * When a fresh plan exists and Execute is the next suggested action,
             * we demote Preview to a ghost/outlined style so the user's eye lands
             * on the (filled) Execute button instead. Preview stays clickable so
             * the user can always re-run it (e.g. to refresh after a remote change).
             */}
            <button
              onClick={onPreview}
              disabled={!canPreview}
              title={blocker ?? (hasPlan && exec.kind === "idle" ? "Re-run preview" : "Preview")}
              className={`flex items-center justify-center w-9 h-9 rounded-lg shrink-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                hasPlan && exec.kind === "idle"
                  ? "border border-border-subtle text-text-muted hover:text-text hover:bg-elevated disabled:bg-transparent"
                  : "bg-accent hover:bg-accent-hover disabled:bg-elevated text-text"
              }`}
            >
              {previewing
                ? <Loader2 size={16} className="animate-spin" />
                : hasPlan && exec.kind === "idle"
                  ? <RefreshCw size={16} />
                  : <Eye size={16} />}
            </button>

            {/* Execute — primary CTA once a plan is ready */}
            {hasPlan && exec.kind === "idle" && (
              <button
                onClick={() => setExecModalOpen(true)}
                disabled={!plan || expired || hasConflicts || !hasChanges}
                title={
                  expired ? "Plan expired — re-preview"
                  : hasConflicts ? "Resolve conflicts before syncing"
                  : !hasChanges ? "No changes to sync"
                  : "Execute sync"
                }
                className="flex items-center justify-center shrink-0 transition-colors rounded-lg w-9 h-9 bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_0_0_2px_var(--color-accent)]/20 ring-1 ring-accent/40"
              >
                <Ship size={16} className="text-text" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Body — plan / empty state ─────────────────── */}
      {previewErr ? (
        <div className="flex-1 flex items-center justify-center">
          <Err>{previewErr}</Err>
        </div>
      ) : previewing ? (
        <Loading>Building plan…</Loading>
      ) : plan ? (
        <PlanView
          plan={plan}
          srcEnv={srcEnv}
          tgtEnv={tgtEnv}
          expanded={expanded}
          setExpanded={setExpanded}
          exec={exec}
        />
      ) : (
        <Empty
          envs={envs}
          blocker={blocker}
          srcEnv={srcEnv}
          tgtEnv={tgtEnv}
          hasRecipes={!!recipes?.introspectedFrom}
        />
      )}

      {/* ── Modals ────────────────────────────────────────────── */}
      {modal === "recipe" && (
        <ModalShell title="Sync Recipe" subtitle={recipe?.displayName} icon={<BookOpen size={20} className="text-text-muted" />} onClose={() => setModal(null)}>
          <RecipeContent recipes={recipes} entityType={entityType} />
        </ModalShell>
      )}
      {modal === "history" && (
        <ModalShell title="Sync History" icon={<History size={20} className="text-text-muted" />} onClose={() => { setModal(null); setHasNewAgentSync(false) }}>
          <HistoryContent onOpen={(planId) => {
            // Reset stale ref so the plan-load effect isn't blocked by a previously
            // loaded planId that was since cleared by the user.
            loadedPlanIdRef.current = null
            setPlan(null)
            setForm({ planId }); setModal(null); setHasNewAgentSync(false)
          }} />
        </ModalShell>
      )}
      {execModalOpen && (plan || execPlanId) && (
        <ExecModal
          exec={exec}
          plan={plan}
          execPlanId={execPlanId}
          srcEnv={srcEnv}
          tgtEnv={tgtEnv}
          onConfirm={onExecConfirmed}
          onClose={() => setExecModalOpen(false)}
        />
      )}
    </div>
  )
}

// ── Modal shell ──────────────────────────────────────────────────

function ModalShell({ title, subtitle, icon, onClose, children }: { title: string; subtitle?: string; icon?: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  // Portal to <body> so `position: fixed` escapes any transformed ancestor
  // (react-grid-layout sets `transform` on grid items, which would otherwise
  // confine the backdrop to the widget's tile and cause it to overflow when
  // the widget is short or other widgets sit below it).
  return createPortal(
    <div className="fixed inset-0 z-[200] bg-scrim flex items-center justify-center p-2 sm:p-4" onClick={onClose}>
      <div className="w-full h-full max-w-5xl sm:max-h-[85vh] bg-surface flex flex-col shadow-2xl overflow-hidden rounded-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border-subtle shrink-0">
          <div className="flex items-center gap-2.5">
            {icon}
            <h2 className="text-lg font-semibold text-text">{title}</h2>
            {subtitle && <span className="text-sm text-text-muted font-mono">{subtitle}</span>}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text p-1.5 rounded-lg hover:bg-overlay-3 transition-colors"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

// ── Empty / Loading / Error ──────────────────────────────────────

function Err({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-3 m-3 text-sm text-error bg-error/10 border border-error/30 rounded flex items-start gap-2 min-w-0">
      <XCircle size={14} className="mt-0.5 shrink-0" />
      <span className="font-mono whitespace-pre-wrap break-all min-w-0">{children}</span>
    </div>
  )
}

function Loading({ children }: { children: React.ReactNode }) {
  return <div className="flex-1 flex items-center justify-center gap-2 text-text-muted text-sm"><Loader2 size={14} className="animate-spin" />{children}</div>
}

function Empty({ envs, blocker, srcEnv, tgtEnv, hasRecipes }: {
  envs: SyncEnvironment[]; blocker: string | null
  srcEnv: SyncEnvironment | null; tgtEnv: SyncEnvironment | null; hasRecipes: boolean
}) {
  if (envs.length < 2) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="max-w-md px-6 text-sm text-text-muted text-center space-y-2">
          <AlertTriangle size={20} className="mx-auto text-warning opacity-60" />
          <p>Need at least 2 environments.</p>
          <p className="text-xs">Add another to <span className="font-mono text-text">MSSQL_DATABASES</span> in <span className="font-mono text-text">.env</span>.</p>
        </div>
      </div>
    )
  }
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center gap-3">
      <Ship size={20} className="text-text-muted opacity-40" />
      <p className="text-sm text-text-muted">{blocker ?? "Select entity and click Preview"}</p>
      {!hasRecipes && <p className="text-xs text-warning">No recipe bundle loaded</p>}
      {srcEnv && tgtEnv && !blocker && (
        <p className="text-xs text-text-muted font-mono">{srcEnv.displayName} → {tgtEnv.displayName}</p>
      )}
    </div>
  )
}

// ── Plan view ────────────────────────────────────────────────────

function PlanView({ plan, expanded, setExpanded, exec }: {
  plan: SyncPlan; srcEnv: SyncEnvironment | null; tgtEnv: SyncEnvironment | null
  expanded: Set<string>; setExpanded: (s: Set<string>) => void; exec: ExecState
}) {
  const t = plan.totals
  const hasConflicts = (t.conflicts ?? 0) > 0
  const expired = (Date.now() - plan.createdAtMs) > 3600_000
  const sorted = useMemo(() => [...plan.tables].sort((a, b) => net(b) - net(a)), [plan])

  const execStatus = useMemo(() => {
    const m = new Map<string, "running" | "done" | "failed">()
    if (exec.kind === "idle") return m
    for (const ev of exec.events) {
      if (ev.table) {
        if (ev.type === "table-started") m.set(ev.table, "running")
        if (ev.type === "table-done") m.set(ev.table, "done")
      }
      if (ev.type === "failed") {
        for (const [t, st] of m) { if (st === "running") m.set(t, "failed") }
      }
    }
    return m
  }, [exec])

  const warns = [...plan.preflight.issues, ...plan.warnings]

  return (
    <>
      {/* ── Plan summary card (fixed) ─────────────────────── */}
      <div className="rounded-lg border border-border-subtle overflow-hidden shrink-0">
        <div className="px-4 py-4">
          {/* Top: entity name */}
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h3 className="text-base font-semibold text-text truncate">
                {plan.entity.displayName ?? `${plan.recipeSnapshot.entityType}#${plan.entity.id}`}
              </h3>
              <div className="flex items-center gap-2 mt-1 text-sm text-text-muted">
                <span className="flex items-center gap-1 text-text-muted/60">
                  <Clock size={11} />{timeAgo(new Date(plan.createdAtMs).toISOString())}
                </span>
                {expired && <span className="text-warning font-medium text-xs px-1.5 py-0.5 rounded bg-warning/10">expired</span>}
              </div>
            </div>
          </div>

          {/* Stats strip */}
          <div className="flex items-center gap-4 mt-3">
            <div className="flex items-center gap-3 font-mono text-sm tabular-nums">
              {t.insert > 0  && <span style={{ color: DIFF.ins }}><span className="text-lg font-semibold">{t.insert}</span> <span className="text-xs">ins</span></span>}
              {t.update > 0  && <span style={{ color: DIFF.upd }}><span className="text-lg font-semibold">{t.update}</span> <span className="text-xs">upd</span></span>}
              {t.delete > 0  && <span style={{ color: DIFF.del }}><span className="text-lg font-semibold">{t.delete}</span> <span className="text-xs">del</span></span>}
              {hasConflicts && <span className="text-warning font-semibold">{t.conflicts} conflict{t.conflicts === 1 ? "" : "s"}</span>}
              {t.unchanged > 0 && <span className="text-text-muted"><span className="text-lg font-semibold">{t.unchanged}</span> <span className="text-xs">eq</span></span>}
            </div>
            <span className="text-text-muted/30">·</span>
            <span className="text-sm text-text-muted">{t.tablesCount} tables</span>
          </div>
        </div>
      </div>

      {/* ── Warnings ──────────────────────────────────────── */}
      {warns.length > 0 && (
        <div className="rounded-lg border border-warning/20 bg-warning/5 px-4 py-2.5 flex items-start gap-2 text-sm text-warning shrink-0">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <div className="space-y-0.5 font-mono">
            {warns.map((w, i) => <div key={i}>{w}</div>)}
          </div>
        </div>
      )}

      {/* ── Table rows — scrollable, fills remaining space ── */}
      <div className="rounded-lg overflow-hidden flex-1 min-h-0 flex flex-col">
      <div className="flex-1 overflow-y-auto min-h-0">
      {sorted.map((row) => {
        const isOpen = expanded.has(row.table)
        const st = execStatus.get(row.table)
        return (
          <div key={row.table}>
            <button
              onClick={() => {
                const s = new Set(expanded)
                isOpen ? s.delete(row.table) : s.add(row.table)
                setExpanded(s)
              }}
              className="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-elevated/30 transition-colors"
            >
              {isOpen ? <ChevronDown size={13} className="text-text-muted shrink-0" /> : <ChevronRight size={13} className="text-text-muted shrink-0" />}
              <span className="text-sm font-mono text-text flex-1 truncate">{row.table}</span>
              {st === "running" && <Loader2 size={13} className="animate-spin text-accent shrink-0" />}
              {st === "done"    && <CheckCircle2 size={13} className="shrink-0" style={{ color: DIFF.ins }} />}
              {st === "failed"  && <XCircle size={13} className="shrink-0" style={{ color: DIFF.del }} />}
              <Ct n={row.counts.insert}    color={DIFF.ins}   label="ins" />
              <Ct n={row.counts.update}    color={DIFF.upd}   label="upd" />
              <Ct n={row.counts.delete}    color={DIFF.del}   label="del" />
              {(row.counts.conflicts ?? 0) > 0 && <Ct n={row.counts.conflicts} color="var(--color-warning)" label="conflict" />}
              <Ct n={row.counts.unchanged} color={DIFF.eqDim} label="eq" dim />
            </button>
            {isOpen && <Detail row={row} />}
          </div>
        )
      })}
      </div>
      </div>
    </>
  )
}

function net(t: SyncPlanTable) { return t.counts.insert + t.counts.update + t.counts.delete + t.counts.conflicts }

function Ct({ n, color, label, dim }: { n: number; color: string; label: string; dim?: boolean }) {
  if (n <= 0) return null
  return (
    <span className="text-sm font-mono tabular-nums shrink-0" style={{ color, opacity: dim ? 0.4 : 1 }}>
      {n.toLocaleString()} <span className="opacity-60">{label}</span>
    </span>
  )
}

// ── Table detail ─────────────────────────────────────────────────

function Detail({ row }: { row: SyncPlanTable }) {
  return (
    <div className="px-4 py-3 bg-base/30 space-y-2 text-sm border-t border-border/30">
      <div className="flex items-center gap-2 text-text-muted font-mono">
        <span className="text-text-muted/50">scope</span>
        <span className="break-all">{row.scopePredicate}</span>
      </div>
      {row.warnings.length > 0 && row.warnings.map((w, i) => (
        <div key={i} className="flex items-start gap-1.5 text-warning font-mono">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />{w}
        </div>
      ))}
      {(row.conflicts ?? []).length > 0 && (
        <div className="border border-warning/40 rounded overflow-hidden">
          <div className="px-3 py-1.5 bg-warning/5 border-b border-warning/20 flex justify-between items-center">
            <span className="text-warning font-medium">scope misattribution — blocks execute</span>
            <span className="font-mono tabular-nums text-text-muted">{row.conflicts.length}/{(row.counts.conflicts ?? 0).toLocaleString()}</span>
          </div>
          <div className="px-3 py-2 space-y-1.5 font-mono leading-relaxed text-text">
            {row.conflicts.slice(0, 10).map((c, i) => (
              <div key={i} className="flex items-start gap-2">
                <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
                <span className="break-all">{c.summary}</span>
              </div>
            ))}
            {row.conflicts.length > 10 && (
              <div className="text-text-muted">… and {row.conflicts.length - 10} more</div>
            )}
          </div>
        </div>
      )}
      {(["insert", "update", "delete"] as const).map((kind) => {
        const s = row.samples[kind]
        if (!s.length) return null
        const color = kind === 'insert' ? DIFF.ins : kind === 'update' ? DIFF.upd : DIFF.del
        const total = row.counts[kind]
        return (
          <SampleSection key={kind} kind={kind} samples={s} total={total} color={color} />
        )
      })}
      <div className="text-sm text-text-muted/40 text-right tabular-nums font-mono">{row.diffDurationMs}ms</div>
    </div>
  )
}

const INITIAL_ROWS = 5

function SampleSection({ kind, samples, total, color }: {
  kind: "insert" | "update" | "delete"; samples: SyncPlanTable["samples"]["insert"]; total: number; color: string
}) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? samples : samples.slice(0, INITIAL_ROWS)
  const canExpand = samples.length > INITIAL_ROWS

  return (
    <div className="border border-border/40 rounded overflow-hidden">
      <div className="px-3 py-1.5 bg-surface/40 border-b border-border/30 flex justify-between items-center">
        <span className="font-medium" style={{ color }}>{kind}</span>
        <div className="flex items-center gap-2">
          {canExpand && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="text-xs text-text-muted/50 hover:text-text transition-colors"
            >
              {showAll ? `show ${INITIAL_ROWS}` : `show all ${samples.length}`}
            </button>
          )}
          <span className="font-mono tabular-nums text-text-muted">{samples.length}/{total.toLocaleString()}</span>
        </div>
      </div>
      <div className="overflow-x-auto show-scrollbar">
        <SampleTbl kind={kind} samples={visible} />
      </div>
    </div>
  )
}

function SampleTbl({ kind, samples }: { kind: "insert" | "update" | "delete"; samples: SyncPlanTable["samples"]["insert"] }) {
  const MAX_COLS = 12
  // Always show changed columns first (so the diff is never hidden by the column cap),
  // then fill the remaining slots with the rest in original order.
  const cols = useMemo(() => {
    const all: string[] = []
    const seen = new Set<string>()
    const add = (k: string) => { if (!seen.has(k)) { seen.add(k); all.push(k) } }
    for (const r of samples) {
      for (const k of Object.keys(r.values ?? {})) add(k)
      for (const k of Object.keys(r.newValues ?? {})) add(k)
      for (const k of Object.keys(r.oldValues ?? {})) add(k)
    }
    if (kind !== "update") return all.slice(0, MAX_COLS)
    const changed = new Set<string>()
    for (const r of samples) for (const c of r.changedColumns ?? []) changed.add(c)
    if (changed.size === 0) return all.slice(0, MAX_COLS)
    const changedFirst = all.filter((c) => changed.has(c))
    const rest = all.filter((c) => !changed.has(c))
    // Guarantee every changed column is shown; fill the remainder up to MAX_COLS.
    const head = changedFirst.slice(0, Math.max(MAX_COLS, changedFirst.length))
    const tailBudget = Math.max(0, MAX_COLS - head.length)
    return [...head, ...rest.slice(0, tailBudget)]
  }, [samples, kind])
  return (
    // `w-auto` (NOT w-full) lets the table grow past its container so the
    // horizontal scrollbar on the wrapper actually has something to scroll.
    // `whitespace-nowrap` on every cell prevents long values from wrapping
    // and squishing other columns.
    <table className="w-auto text-sm font-mono border-separate border-spacing-0">
      <thead><tr className="text-text-muted">
        {cols.map((c) => (
          <th
            key={c}
            className="text-left px-2.5 py-1.5 font-normal whitespace-nowrap border-b border-border/30 bg-surface/30 sticky top-0"
          >{c}</th>
        ))}
      </tr></thead>
      <tbody>
        {samples.map((s, i) => {
          if (kind === "update") {
            const ch = new Set(s.changedColumns ?? [])
            return (<tr key={i} className="border-b border-border/20">
              {cols.map((c) => {
                const ov = fv(s.oldValues?.[c]), nv = fv(s.newValues?.[c])
                return <td key={c} className="px-2.5 py-1 align-top whitespace-nowrap border-b border-border/20">
                  {ch.has(c)
                    ? <><div className="line-through" style={{ color: DIFF.oldRow }}>{ov}</div><div style={{ color: DIFF.upd, fontWeight: 500 }}>{nv}</div></>
                    : <span className="text-text">{nv}</span>}
                </td>
              })}
            </tr>)
          }
          return <tr key={i}>
            {cols.map((c) => <td key={c} className="px-2.5 py-1 text-text whitespace-nowrap border-b border-border/20">{fv(s.values?.[c])}</td>)}
          </tr>
        })}
      </tbody>
    </table>
  )
}

function fv(v: unknown): string {
  if (v == null) return "null"
  if (typeof v === "object") return JSON.stringify(v)
  const s = String(v)
  return s.length > 80 ? s.slice(0, 77) + "…" : s
}

// ── History (modal content) ───────────────────────────────────────

function HistoryContent({ onOpen }: { onOpen?: (planId: string) => void }) {
  const [rows, setRows] = useState<HistoryRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  function reload() { setErr(null); api.syncHistory(200).then(setRows).catch((e) => setErr(e instanceof Error ? e.message : String(e))) }
  useEffect(reload, [])

  // Auto-refresh when an agent-triggered sync preview or execute arrives.
  // Subscribe to all three store signals so history stays live regardless
  // of whether the user has the modal open before or after the agent runs.
  const agentSyncExec = useStore((s) => s.agentSyncExec)
  const agentSyncExecStarted = useStore((s) => s.agentSyncExecStarted)
  const syncFormPlanId = useStore((s) => s.envSyncForm.planId)
  const prevPlanIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (syncFormPlanId && syncFormPlanId !== prevPlanIdRef.current) {
      prevPlanIdRef.current = syncFormPlanId
      reload()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncFormPlanId])
  // Reload when execute starts (shows "started" row immediately)
  useEffect(() => {
    if (agentSyncExecStarted) reload()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSyncExecStarted])
  // Reload when execute finishes (updates row to completed/failed)
  useEffect(() => {
    if (agentSyncExec) reload()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentSyncExec])

  if (err) return <Err>{err}</Err>
  if (!rows) return <Loading>Loading history…</Loading>
  if (!rows.length) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[200px] text-text-muted gap-2 py-12">
        <History size={20} className="opacity-40" />
        <p className="text-sm">No sync history yet</p>
      </div>
    )
  }

  const groups = groupByPlan(rows)
  return (
    <div>
      <div className="flex items-center justify-between text-sm text-text-muted px-4 py-2 border-b border-border/40">
        <span>{groups.length} sync run{groups.length === 1 ? "" : "s"}</span>
        <button onClick={reload} className="hover:text-text" title="Refresh"><RefreshCw size={16} /></button>
      </div>
      {groups.map((g) => <HRow key={g.planId} g={g} onOpen={onOpen} />)}
    </div>
  )
}

type PlanGroup = { planId: string; actor: string; isAgent: boolean; firstAt: string; lastAt: string; status: "preview"|"executing"|"completed"|"failed"; preview?: HistoryRow; events: HistoryRow[] }
function groupByPlan(rows: HistoryRow[]): PlanGroup[] {
  const m = new Map<string, PlanGroup>()
  for (const r of [...rows].reverse()) {
    let g = m.get(r.planId)
    if (!g) { g = { planId: r.planId, actor: r.actor, isAgent: r.actor === "agent", firstAt: r.timestamp, lastAt: r.timestamp, status: "preview", events: [] }; m.set(r.planId, g) }
    g.lastAt = r.timestamp; g.actor = r.actor;
    g.isAgent = g.actor === "agent"
    g.events.push(r)
    if (r.action === "sync.preview") g.preview = r
    if (r.action === "sync.execute.start") g.status = "executing"
    if (r.action === "sync.execute.completed") g.status = "completed"
    if (r.action === "sync.execute.failed" || r.action === "sync.preview.failed") g.status = "failed"
  }
  return Array.from(m.values()).sort((a, b) => b.lastAt.localeCompare(a.lastAt))
}

function HRow({ g, onOpen }: { g: PlanGroup; onOpen?: (planId: string) => void }) {
  const [open, setOpen] = useState(false)
  const d = (g.preview?.detail ?? g.events.find((e) => e.action === "sync.execute.start")?.detail ?? g.events[0]?.detail ?? {}) as Record<string, unknown>
  const totals = (d.totals ?? null) as null | { insert: number; update: number; delete: number }
  const ent = String(d.entityType ?? ""); const eid = String(d.entityId ?? "")
  const entityName = d.entityName ? String(d.entityName) : null
  const src = String(d.source ?? ""); const tgt = String(d.target ?? "")
  const sc = g.status === "completed" ? DIFF.ins : g.status === "failed" ? DIFF.del : g.status === "executing" ? "var(--color-accent)" : "var(--color-text-muted)"
  const rawPlanId = g.planId.replace(/^sync:/, "")

  return (
    <div className="border-b border-border/40">
      <button onClick={() => setOpen(!open)} className="w-full text-left px-4 py-2 flex items-center gap-2 hover:bg-elevated/30 transition-colors text-sm">
        {open ? <ChevronDown size={13} className="text-text-muted" /> : <ChevronRight size={13} className="text-text-muted" />}
        <span className={`w-2 h-2 shrink-0${g.isAgent ? "" : " rounded-full"}`} style={{ background: sc }} title={g.isAgent ? "agent" : "manual"} />
        <span className="text-text font-mono truncate flex-1">
          {entityName ? entityName : (ent || "—")}
          {!entityName && eid && <span className="text-text-muted">#{eid}</span>}
          {g.isAgent && <span className="ml-1 text-[10px] text-accent/70 font-sans">(agent)</span>}
        </span>
        {src && tgt && <span className="text-text-muted font-mono">{src}<ArrowRight size={10} className="inline mx-0.5 align-[0px]" />{tgt}</span>}
        {totals && <span className="font-mono tabular-nums flex gap-2">
          {totals.insert > 0 && <span style={{ color: DIFF.ins }}>{totals.insert} ins</span>}
          {totals.update > 0 && <span style={{ color: DIFF.upd }}>{totals.update} upd</span>}
          {totals.delete > 0 && <span style={{ color: DIFF.del }}>{totals.delete} del</span>}
        </span>}
        <span className="text-text-muted capitalize">{g.status}</span>
        <span className="text-text-muted flex items-center gap-1"><Clock size={11} />{timeAgo(g.lastAt)}</span>
        <span className="text-text-muted font-mono truncate max-w-[6rem]">{g.actor}</span>
      </button>
      {open && (
        <div className="px-4 py-3 bg-base/30 border-t border-border/30 text-sm space-y-2">
          {/* Plan ID + open button */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-text-muted/50 font-mono">
              <span>plan</span>
              <span className="text-text-muted">{rawPlanId}</span>
            </div>
            {onOpen && (
              <button
                className="text-text-muted hover:text-accent/80 transition-colors"
                onClick={() => onOpen(rawPlanId)}
                title="View plan"
              >
                <View size={16} />
              </button>
            )}
          </div>

          {/* Events */}
          <div className="space-y-1.5">
            {g.events.map((e, i) => (
              <HEvent key={i} event={e} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function HEvent({ event }: { event: HistoryRow }) {
  const [jsonOpen, setJsonOpen] = useState(false)
  const x = event.detail as Record<string, unknown> | null
  const hasError = x && typeof x.error === "string" && x.error
  const detailKeys = x ? Object.keys(x).filter((k) => k !== "error" || x[k]) : []
  const hasJson = detailKeys.length > 0 && !(detailKeys.length === 1 && detailKeys[0] === "error")

  // Derive a short human label from the action
  const actionLabel = event.action.replace(/^sync\./, "").replace(/\./g, " ")
  const actionColor = event.action.includes("failed") ? DIFF.del
    : event.action.includes("completed") ? DIFF.ins
    : event.action.includes("start") ? "var(--color-accent)"
    : undefined

  return (
    <div className="rounded border border-border-subtle bg-overlay-1">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <span
          className="text-xs font-medium capitalize shrink-0"
          style={actionColor ? { color: actionColor } : undefined}
        >{actionLabel}</span>
        <span className="flex-1" />
        <span className="text-xs text-text-muted/40 font-mono tabular-nums">
          {new Date(event.timestamp).toLocaleTimeString()}
        </span>
        {hasJson && (
          <button
            onClick={() => setJsonOpen(!jsonOpen)}
            className="text-xs text-text-muted/40 hover:text-text-muted px-1 py-0.5 rounded hover:bg-elevated transition-colors"
          >
            {jsonOpen ? "hide" : "json"}
          </button>
        )}
      </div>
      {hasError && (
        <div className="px-3 pb-2 text-xs font-mono break-all" style={{ color: DIFF.del }}>
          {(x as Record<string, string>).error}
        </div>
      )}
      {hasJson && jsonOpen && (
        <div className="px-3 pb-2 border-t border-border-subtle">
          <pre className="text-xs text-text-muted/60 font-mono whitespace-pre-wrap break-all leading-relaxed pt-1.5 max-h-48 overflow-y-auto show-scrollbar">
            {JSON.stringify(x, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

// ── Recipe (modal content) ───────────────────────────────────────

function RecipeContent({ recipes, entityType }: { recipes: SyncRecipeBundle | null; entityType: SyncEntityType }) {
  const enabledOptionalTablesRaw = useStore((s) => s.envSyncForm.enabledOptionalTables)
  const setForm = useStore((s) => s.setEnvSyncForm)
  if (!recipes) return <Loading>Loading recipes…</Loading>
  const recipe = recipes.recipes[entityType]
  if (!recipe) return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-text-muted">
      <BookOpen size={24} className="opacity-30" />
      <p className="text-sm">No recipe for <span className="font-mono text-text">{entityType}</span></p>
      <p className="text-xs">Run the introspection script to generate recipes.</p>
    </div>
  )

  const verified = recipe.tables.filter((t) => t.verified).length
  const total = recipe.tables.length
  const allVerified = verified === total
  const optionalTables = recipe.tables.filter((table) => table.userControllable)
  const enabledOptionalTables = normalizeOptionalTableSelection(recipe, enabledOptionalTablesRaw)
  const enabledOptional = new Set(enabledOptionalTables)

  function toggleOptionalTable(tableName: string) {
    const next = enabledOptional.has(tableName)
      ? enabledOptionalTables.filter((name) => name !== tableName)
      : [...enabledOptionalTables, tableName]
    setForm({ enabledOptionalTables: next })
  }

  return (
    <div className="pb-4">
      {/* ── Identity section ──────────────────────────── */}
      <div className="px-5 py-4 border-b border-border/40">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2.5 text-sm">
          <div className="flex items-center gap-2">
            <Database size={13} className="text-text-muted/50 shrink-0" />
            <span className="text-text-muted">Root table</span>
            <span className="font-mono text-text ml-auto">{recipe.rootTable}</span>
          </div>
          <div className="flex items-center gap-2">
            <Key size={13} className="text-text-muted/50 shrink-0" />
            <span className="text-text-muted">Primary key</span>
            <span className="font-mono text-text ml-auto">{recipe.rootKeyColumn}</span>
          </div>
          <div className="flex items-center gap-2">
            <Ship size={13} className="text-text-muted/50 shrink-0" />
            <span className="text-text-muted">Legacy sproc</span>
            <span className="font-mono text-text ml-auto text-xs">{recipe.legacyEntrySproc ?? "—"}</span>
          </div>
          <div className="flex items-center gap-2">
            {allVerified
              ? <ShieldCheck size={13} className="shrink-0 text-accent" />
              : <ShieldAlert size={13} className="text-warning shrink-0" />}
            <span className="text-text-muted">Verified</span>
            <span className={`font-mono ml-auto ${allVerified ? "text-accent" : "text-warning"}`}
            >{verified}/{total} tables</span>
          </div>
        </div>
      </div>

      {optionalTables.length > 0 && (
        <div className="px-5 pt-4">
          <div className="rounded border border-border-subtle bg-elevated/20 px-3 py-3 text-sm text-text-muted">
            <div className="flex items-center justify-between gap-3">
              <span>FK-only tables are inferred from relational closure and stay off until you enable them.</span>
              <span className="font-mono text-text">{enabledOptionalTables.length}/{optionalTables.length} enabled</span>
            </div>
          </div>
        </div>
      )}

      {/* ── Table list ────────────────────────────────── */}
      <div className="px-5 pt-3">
        <div className="text-xs text-text-muted/60 mb-2">Dependency tables ({total})</div>
        <div className="border border-border/40 rounded overflow-hidden">
          {/* Column header */}
          <div className="grid grid-cols-[2rem_1fr_auto_auto_auto_auto] gap-2 px-3 py-1.5 bg-elevated/30 border-b border-border/40 text-xs text-text-muted/60">
            <span className="text-right">#</span>
            <span>Table</span>
            <span className="w-28 text-right">Scope column</span>
            <span className="w-20 text-center">Source</span>
            <span className="w-16 text-center">Status</span>
            <span className="w-20 text-center">Use</span>
          </div>
          {recipe.tables.map((t, i) => (
            <div
              key={t.name}
              className={`grid grid-cols-[2rem_1fr_auto_auto_auto_auto] gap-2 px-3 py-2 items-center text-sm ${i < recipe.tables.length - 1 ? "border-b border-border/20" : ""} hover:bg-elevated/20 transition-colors`}
              title={t.predicate}
            >
              <span className="font-mono text-text-muted/40 text-right tabular-nums text-xs">{i + 1}</span>
              <span className="font-mono text-text truncate">{t.name}</span>
              <span className="font-mono text-text-muted text-right w-28 truncate text-xs">{t.scopeColumn ?? "—"}</span>
              <span className="w-20 text-center">
                <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                  t.source === "fk+pipeline" ? "bg-accent/10 text-accent"
                    : t.source === "pipeline-only" ? "bg-warning/10 text-warning"
                    : "bg-info-soft text-info"
                }`}>{t.source === "fk+pipeline" ? "fk+pl" : t.source === "pipeline-only" ? "pl" : "fk"}</span>
              </span>
              <span className="w-16 text-center">
                {t.verified
                  ? <CheckCircle2 size={14} className="inline" style={{ color: DIFF.ins }} />
                  : <AlertTriangle size={14} className="inline text-warning" />}
              </span>
              <span className="w-20 text-center">
                {t.userControllable ? (
                  <button
                    onClick={() => toggleOptionalTable(t.name)}
                    className={`min-w-[3.5rem] rounded px-2 py-1 text-xs font-mono transition-colors ${enabledOptional.has(t.name) ? "bg-accent/15 text-accent hover:bg-accent/20" : "bg-overlay-2 text-text-muted hover:text-text hover:bg-overlay-3"}`}
                  >
                    {enabledOptional.has(t.name) ? "on" : "off"}
                  </button>
                ) : (
                  <span className="inline-block min-w-[3.5rem] rounded px-2 py-1 text-[10px] font-mono uppercase tracking-wide bg-overlay-2 text-text-muted/70">auto</span>
                )}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Discrepancies ─────────────────────────────── */}
      {recipe.discrepancies.length > 0 && (
        <div className="px-5 pt-4">
          <div className="border border-warning/30 rounded overflow-hidden">
            <div className="px-3 py-2 bg-warning/5 border-b border-warning/20 flex items-center gap-2">
              <AlertTriangle size={13} className="text-warning" />
              <span className="text-sm text-warning font-medium">{recipe.discrepancies.length} discrepanc{recipe.discrepancies.length === 1 ? "y" : "ies"}</span>
            </div>
            <div className="px-3 py-2 space-y-2">
              {recipe.discrepancies.map((d, i) => (
                <div key={i} className="text-sm flex items-start gap-2">
                  <span className="text-warning font-mono text-xs bg-warning/10 px-1.5 py-0.5 rounded shrink-0 mt-0.5">{d.kind}</span>
                  <div>
                    {d.table !== "*" && <span className="font-mono text-text">{d.table} — </span>}
                    <span className="text-text-muted">{d.note}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Footer ────────────────────────────────────── */}
      <div className="px-5 pt-3 flex items-center justify-between text-xs text-text-muted/40">
        <span className="font-mono">pipeline {recipe.legacyPipelineId ?? "—"}</span>
        <span>Generated {recipe.generatedAt ? new Date(recipe.generatedAt).toLocaleDateString() : "—"}</span>
      </div>
    </div>
  )
}

// ── Execution modal ──────────────────────────────────────────────

function ExecModal({ exec, plan, execPlanId, tgtEnv, onConfirm, onClose }: {
  exec: ExecState; plan: SyncPlan | null; execPlanId: string | null
  srcEnv: SyncEnvironment | null; tgtEnv: SyncEnvironment | null
  onConfirm: () => void; onClose: () => void
}) {
  const t = plan?.totals ?? { insert: 0, update: 0, delete: 0, unchanged: 0, conflicts: 0, tablesCount: 0 }
  const planId = plan?.planId ?? execPlanId ?? ""
  const isIdle = exec.kind === "idle" && !!plan
  const isRunning = exec.kind === "running"
  const isDone = exec.kind === "done"
  const success = isDone && (exec as Extract<ExecState, { kind: "done" }>).success
  const failed = isDone && !(exec as Extract<ExecState, { kind: "done" }>).success

  // Only tables with actual changes are executed
  const affectedTables = useMemo(
    () => plan ? plan.tables.filter((tb) => tb.counts.insert + tb.counts.update + tb.counts.delete > 0).map((tb) => tb.table) : [],
    [plan],
  )
  const total = affectedTables.length
  const done = useMemo(
    () => exec.kind === "idle" ? 0 : new Set(exec.events.filter((e) => e.type === "table-done").map((e) => e.table)).size,
    [exec],
  )
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0

  // Narrowed events array — safe to use in the non-idle phases
  const events: SyncExecuteProgress[] = exec.kind !== "idle" ? exec.events : []

  const execStatus = useMemo(() => {
    const m = new Map<string, "running" | "done" | "failed">()
    if (exec.kind === "idle") return m
    for (const ev of exec.events) {
      if (ev.table) {
        if (ev.type === "table-started") m.set(ev.table, "running")
        if (ev.type === "table-done") m.set(ev.table, "done")
      }
      if (ev.type === "failed") {
        for (const [t, st] of m) { if (st === "running") m.set(t, "failed") }
      }
    }
    return m
  }, [exec])

  const stats = [
    { n: t.insert, label: "insert", color: DIFF.ins },
    { n: t.update, label: "update", color: DIFF.upd },
    { n: t.delete, label: "delete", color: DIFF.del },
  ].filter((s) => s.n > 0)

  // Auto-scroll event log
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [exec])

  const title = isIdle ? "Execute Sync"
    : isRunning ? "Executing…"
    : success ? "Sync Complete"
    : "Sync Failed"

  const headerIcon = isIdle ? <Ship size={20} className="text-accent" />
    : isRunning ? <Loader2 size={20} className="animate-spin text-accent" />
    : success ? <CheckCircle2 size={20} style={{ color: DIFF.ins }} />
    : <XCircle size={20} style={{ color: DIFF.del }} />

  return createPortal(
    <div className="fixed inset-0 z-[200] bg-scrim flex items-center justify-center p-2 sm:p-4" onClick={isRunning ? undefined : onClose}>
      <div
        className={`bg-surface flex flex-col shadow-2xl overflow-hidden w-full rounded-xl sm:rounded-2xl transition-all duration-300 ${
          isIdle ? "h-auto max-h-full" : "h-full sm:h-[85vh]"
        }`}
        style={{ maxWidth: isIdle ? "24rem" : "48rem" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ─────────────────────────────── */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-border-subtle shrink-0">
          <div className="flex items-center gap-2.5">
            {headerIcon}
            <h3 className="text-lg font-semibold text-text">{title}</h3>
            {!isIdle && <span className="text-sm text-text-muted font-mono tabular-nums">{done}/{total}</span>}
          </div>
          {!isRunning && (
            <button onClick={onClose} className="text-text-muted hover:text-text p-1.5 rounded-lg hover:bg-overlay-3 transition-colors"><X size={18} /></button>
          )}
        </div>

        {/* ── Phase: Confirmation ─────────────────── */}
        {isIdle && (
          <>
            <div className="px-5 pt-4 pb-3 text-center">
              <p className="text-sm text-text-muted">
                Apply changes to <span className="font-semibold text-text">{tgtEnv?.displayName ?? plan?.target ?? "target"}</span>
              </p>
            </div>

            <div className="mx-5 rounded-lg border border-border-subtle bg-overlay-1 px-4 py-3">
              <div className="flex items-center justify-center gap-5 font-mono text-sm tabular-nums">
                {stats.map((s) => (
                  <div key={s.label} className="text-center">
                    <div className="text-lg font-semibold" style={{ color: s.color }}>{s.n}</div>
                    <div className="text-xs text-text-muted">{s.label}</div>
                  </div>
                ))}
                <div className="text-center">
                  <div className="text-lg font-semibold text-text-muted">{t.tablesCount}</div>
                  <div className="text-xs text-text-muted">tables</div>
                </div>
              </div>
            </div>

            <div className="px-5 pt-3 pb-1.5 text-center">
              <p className="text-[11px] text-text-muted/50 font-mono">
                single txn · rollback on error · {planId.slice(0, 8)}
              </p>
            </div>

            <div className="px-5 pb-5 pt-3 flex gap-2">
              <button onClick={onClose} className="flex-1 h-9 text-sm text-text-muted hover:text-text rounded-lg border border-border-subtle hover:bg-elevated transition-colors">
                Cancel
              </button>
              <button onClick={onConfirm} className="flex-1 h-9 text-sm text-text bg-accent hover:bg-accent-hover rounded-lg flex items-center justify-center gap-1.5 transition-colors">
                <Ship size={14} /> Execute
              </button>
            </div>
          </>
        )}

        {/* ── Phase: Execution / Results ──────────── */}
        {!isIdle && (
          <div className="flex flex-col min-h-0 flex-1">
            {/* Progress bar */}
            <div className="px-5 py-2.5 shrink-0">
              <div className="h-1.5 bg-elevated rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${pct}%`, background: failed ? DIFF.del : "var(--color-accent)" }}
                />
              </div>
            </div>

            {/* Table status chips — only tables with changes */}
            <div className="px-5 pb-3 shrink-0">
              <div className="flex flex-wrap gap-x-3 gap-y-1.5 text-sm font-mono">
                {affectedTables.map((tableName) => {
                  const st = execStatus.get(tableName)
                  const short = tableName.split(".").pop() ?? tableName
                  return (
                    <span key={tableName} className="flex items-center gap-1.5">
                      {st === "running" && <Loader2 size={11} className="animate-spin text-accent" />}
                      {st === "done"    && <CheckCircle2 size={11} style={{ color: DIFF.ins }} />}
                      {st === "failed"  && <XCircle size={11} style={{ color: DIFF.del }} />}
                      {!st              && <span className="w-[11px] h-[11px] rounded-full border border-border" />}
                      <span
                        className={st === "done" ? "text-text-muted/40" : st === "failed" ? "" : "text-text"}
                        style={st === "failed" ? { color: DIFF.del } : undefined}
                      >{short}</span>
                    </span>
                  )
                })}
              </div>
            </div>

            {/* Event log */}
            <div ref={logRef} className="flex-1 overflow-y-auto min-h-0 border-t border-border-subtle">
              <div className="font-mono text-sm px-5 py-3 space-y-0.5">
                {events.map((e, i) => (
                  <div key={i} className="flex items-baseline gap-2 min-w-0">
                    <span className={`text-xs w-28 shrink-0 ${e.type === "step" ? "text-accent/60" : "text-text-muted/40"}`}>
                      {e.type === "step" ? (e.step ?? "step") : e.type}
                    </span>
                    {e.table && <span className="text-accent shrink-0">{e.table.split(".").pop()}</span>}
                    {typeof e.rowsApplied === "number" && <span className="text-text-muted tabular-nums shrink-0">{e.rowsApplied} rows</span>}
                    {e.type === "step" && e.message && <span className="text-text-muted/60 break-all min-w-0">{e.message}</span>}
                    {e.type !== "step" && e.message && <span className="text-text break-all min-w-0">{e.message}</span>}
                    {/* Error text on terminal events (failed/completed) is shown in the banner below — skip inline to avoid redundancy */}
                    {e.error && e.type !== "failed" && <span className="break-all min-w-0" style={{ color: DIFF.del }}>{e.error}</span>}
                  </div>
                ))}
                {exec.kind === "done" && exec.error && (
                  <div className="mt-2 px-3 py-2 rounded-lg bg-error/10 border border-error/20 whitespace-pre-wrap break-all text-sm" style={{ color: DIFF.del }}>
                    {exec.error}
                  </div>
                )}
              </div>
            </div>

            {/* Done footer */}
            {isDone && (
              <div className="px-5 py-3 border-t border-border-subtle shrink-0 flex items-center justify-between">
                <span className="text-xs text-text-muted/50 font-mono">{planId.slice(0, 8)}</span>
                <button
                  onClick={onClose}
                  className="h-8 px-4 text-sm text-text-muted hover:text-text rounded-lg border border-border-subtle hover:bg-elevated transition-colors"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
// DependencyGraph removed — the execution-order chain inside the summary card
// is the authoritative dependency visualization.
