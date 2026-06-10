import {
    BookOpen,
    CheckCircle2,
    Eye,
    History,
    Key,
    Loader2,
    MoreHorizontal,
    RefreshCw,
    Search,
    Ship,
    X,
    XCircle,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import { api } from "../../api"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { useContainerSize } from "../../hooks/useContainerSize"
import { useStore } from "../../store"
import type { PublishedSyncDefinition, SyncEntityType, SyncEnvironment, SyncPlan } from "../../types"
import { Empty, Err, Loading, ModalShell } from "./chrome"
import { DIFF, dot, ENTITY_TYPES, normalizeOptionalTableSelection } from "./constants"
import { DefinitionContent } from "./DefinitionContent"
import { completeExecFromAgent, getExecPlanId, getExecSnapshot, resetExec, startExecStream, subscribeExec } from "./exec-store"
import { ExecModal } from "./ExecModal"
import { HistoryContent } from "./HistoryContent"
import { PlanView } from "./PlanTables"
import type { ModalKind, SearchHit } from "./types"

function formatSearchHitLabel(hit: SearchHit): string {
  return hit.name ? `${hit.name} (#${hit.id})` : String(hit.id)
}

export function EnvSync() {
  const [envs, setEnvs] = useState<SyncEnvironment[]>([])
  const [definitions, setDefinitions] = useState<PublishedSyncDefinition[]>([])
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [modal, setModal] = useState<ModalKind>(null)
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
  const [planLoading, setPlanLoading] = useState(false)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [plan, setPlan] = useState<SyncPlan | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [execModalOpen, setExecModalOpen] = useState(false)
  const exec = useSyncExternalStore(subscribeExec, getExecSnapshot)
  const execPlanId = useSyncExternalStore(subscribeExec, getExecPlanId)

  const planSigRef = useRef<string | null>(null)

  const [searchResults, setSearchResults] = useState<SearchHit[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchBoxRef = useRef<HTMLDivElement>(null)
  const [searchDraft, setSearchDraft] = useState("")

  const srcEnv = useMemo(() => envs.find((entry) => entry.name === source) ?? null, [envs, source])
  const tgtEnv = useMemo(() => envs.find((entry) => entry.name === target) ?? null, [envs, target])
  const definition = useMemo(() => definitions.find((entry) => entry.id === entityType) ?? null, [definitions, entityType])
  const enabledOptionalTables = useMemo(
    () => normalizeOptionalTableSelection(definition, form.enabledOptionalTables),
    [definition, form.enabledOptionalTables],
  )
  const resolvedEntityId = entityId.trim() || (plan ? String(plan.entity.id) : "")
  const formSig = `${source}|${target}|${entityType}|${resolvedEntityId}|${force}|${searchMode}|${[...enabledOptionalTables].sort().join(",")}`
  const previewEntityId = entityId.trim() || searchDraft.trim()

  useEffect(() => {
    if (!definition) return
    if (!Array.isArray(form.enabledOptionalTables)) return
    if (
      enabledOptionalTables.length === form.enabledOptionalTables.length &&
      enabledOptionalTables.every((tableName, index) => tableName === form.enabledOptionalTables?.[index])
    ) {
      return
    }
    setForm({ enabledOptionalTables })
  }, [definition, enabledOptionalTables, form.enabledOptionalTables, setForm])

  const [searchErr, setSearchErr] = useState<string | null>(null)

  useEffect(() => {
    function handle(event: MouseEvent) {
      if (searchBoxRef.current?.contains(event.target as Node)) return
      setSearchOpen(false)
      setSearchErr(null)
    }
    document.addEventListener("click", handle)
    return () => document.removeEventListener("click", handle)
  }, [])

  function onSearchInput(value: string) {
    setSearchErr(null)
    if (entityId) setForm({ entityId: "" })
    setSearchDraft(value)
    if (!value.trim() || !source) {
      setSearchResults([])
      setSearchOpen(false)
      setSearchLoading(false)
      return
    }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    setSearchLoading(true)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const hits = await api.syncSearch({
          entityType,
          source,
          q: value.trim(),
          mode: searchMode,
        })
        setSearchResults(hits)
        setSearchOpen(hits.length > 0)
        if (hits.length === 0) setSearchErr("No matches")
      } catch (error) {
        setSearchResults([])
        setSearchOpen(false)
        setSearchErr(error instanceof Error ? error.message : String(error))
      } finally {
        setSearchLoading(false)
      }
    }, 300)
  }

  function pickSearchHit(hit: SearchHit) {
    setForm({ entityId: String(hit.id) })
    setSearchDraft(formatSearchHitLabel(hit))
    setSearchOpen(false)
    setSearchResults([])
    setSearchErr(null)
    setSearchLoading(false)
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current)
      searchTimerRef.current = null
    }
  }

  const loadedPlanIdRef = useRef<string | null>(null)

  function applyLoadedPlan(nextPlan: SyncPlan) {
    const planEntityType = getPlanEntityType(nextPlan) ?? entityType
    const entityIdStr = String(nextPlan.entity.id)
    setPlan(nextPlan)
    setPreviewErr(null)
    setExpanded(new Set())
    setForm({
      planId: nextPlan.planId,
      source: nextPlan.source,
      target: nextPlan.target,
      entityType: planEntityType,
      entityId: "",
      enabledOptionalTables: nextPlan.recipeSnapshot?.enabledOptionalTables ?? null,
    })
    setSearchDraft(
      nextPlan.entity.displayName
        ? `${nextPlan.entity.displayName} (#${entityIdStr})`
        : entityIdStr,
    )
    planSigRef.current = buildPlanFormSig(nextPlan, definitions, force, searchMode)
    loadedPlanIdRef.current = nextPlan.planId
    if (!isFirstMountRef.current) setHasNewAgentSync(true)
  }

  async function openPlanFromHistory(planId: string) {
    loadedPlanIdRef.current = planId
    planSigRef.current = null
    setModal(null)
    setHasNewAgentSync(false)
    setPreviewErr(null)
    setPlan(null)
    setExpanded(new Set())
    setExecModalOpen(false)
    if (exec.kind !== "running") resetExec()
    setForm({ planId })
    setPlanLoading(true)
    try {
      const nextPlan = await api.syncPlan(planId)
      if (nextPlan.error) {
        setPreviewErr(`Plan ${planId} not found — it may have been pruned from history.`)
        setForm({ planId: null })
        loadedPlanIdRef.current = null
        return
      }
      applyLoadedPlan(nextPlan)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      setPreviewErr(/not found|expired/i.test(msg)
        ? "Plan not found — it may have been pruned from history."
        : `Failed to load plan: ${msg}`)
      setForm({ planId: null })
      loadedPlanIdRef.current = null
    } finally {
      setPlanLoading(false)
    }
  }

  useEffect(() => {
    let dead = false
    Promise.all([api.syncEnvironments(), api.syncDefinitions()])
      .then(([nextEnvs, nextDefinitions]) => {
        if (dead) return
        setEnvs(nextEnvs)
        setDefinitions(nextDefinitions)
        const nextForm: Partial<typeof form> = {}
        if (nextEnvs.length >= 1 && !source) nextForm.source = nextEnvs[0].name
        if (nextEnvs.length >= 2 && !target) nextForm.target = nextEnvs[1].name
        else if (nextEnvs.length === 1 && !target) nextForm.target = nextEnvs[0].name
        if (Object.keys(nextForm).length) setForm(nextForm)
      })
      .catch((error) => !dead && setLoadErr(error instanceof Error ? error.message : String(error)))
    if (form.planId) loadedPlanIdRef.current = form.planId
    return () => { dead = true }
  }, [])

  useEffect(() => {
    const newPlanId = form.planId
    if (!newPlanId || newPlanId === plan?.planId || newPlanId === loadedPlanIdRef.current) return
    loadedPlanIdRef.current = newPlanId
    api.syncPlan(newPlanId).then((nextPlan) => {
      if (nextPlan.error) {
        setPreviewErr(`Plan ${newPlanId} not found — it may have been pruned from history.`)
        setForm({ planId: null })
        loadedPlanIdRef.current = null
        return
      }
      applyLoadedPlan(nextPlan)
    }).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error)
      setPreviewErr(/not found|expired/i.test(msg)
        ? "Plan not found — it may have been pruned from history."
        : `Failed to load plan: ${msg}`)
      setForm({ planId: null })
      loadedPlanIdRef.current = null
    })
  }, [form.planId, plan?.planId, definitions, form.entityType, force, searchMode, setForm])

  useEffect(() => { isFirstMountRef.current = false }, [])

  useEffect(() => {
    if (!agentSyncExecStarted) return
    startExecStream(agentSyncExecStarted)
    setExecModalOpen(true)
    setHasNewAgentSync(true)
  }, [agentSyncExecStarted])

  useEffect(() => {
    if (!agentSyncExec) return
    completeExecFromAgent(agentSyncExec.planId, agentSyncExec.success, agentSyncExec.success ? undefined : agentSyncExec.result)
    clearAgentSyncExec()
    setExecModalOpen(true)
    setHasNewAgentSync(true)
  }, [agentSyncExec, clearAgentSyncExec])

  const blocker =
    !source || !target ? "Pick source + target"
      : source === target ? "Source ≠ target"
        : !previewEntityId ? `Enter ${searchMode === "name" ? (definition?.labelColumn ?? "name") : (definition?.idColumn ?? "id")}`
          : !definition ? "No published definition" : null
  const canPreview = !blocker && !previewing

  async function onPreview() {
    if (!canPreview) return
    setPreviewing(true)
    setPreviewErr(null)
    setPlan(null)
    resetExec()
    setExpanded(new Set())
    planSigRef.current = null
    try {
      const id: string | number = /^\d+$/.test(previewEntityId) ? Number(previewEntityId) : previewEntityId
      const requestEnabledOptionalTables = Array.isArray(form.enabledOptionalTables) ? enabledOptionalTables : undefined
      const result = await api.syncPreview({ entityType, entityId: id, source, target, force, enabledOptionalTables: requestEnabledOptionalTables })
      if (result.error) {
        setPreviewErr(result.error)
        setForm({ planId: null })
      } else {
        loadedPlanIdRef.current = result.planId
        planSigRef.current = formSig
        setPlan(result)
        setForm({ planId: result.planId, entityId: String(result.entity.id) })
        setSearchDraft("")
      }
    } catch (error) {
      setPreviewErr(error instanceof Error ? error.message : String(error))
      setForm({ planId: null })
    } finally {
      setPreviewing(false)
    }
  }

  useEffect(() => {
    if (!plan || !planSigRef.current) return
    if (planSigRef.current === formSig) return
    const planEntityType = getPlanEntityType(plan)
    const planEntityId = String(plan.entity.id)
    // Definitions / optional-table normalization can update formSig after hydration
    // without the user changing the loaded plan — re-sync instead of discarding.
    if (
      plan.source === source &&
      plan.target === target &&
      planEntityType === entityType &&
      planEntityId === resolvedEntityId
    ) {
      planSigRef.current = formSig
      return
    }
    setPlan(null)
    setForm({ planId: null })
    setExpanded(new Set())
    setExecModalOpen(false)
    if (exec.kind !== "running") resetExec()
    planSigRef.current = null
  }, [formSig, plan, source, target, entityType, resolvedEntityId, exec.kind, setForm])

  function onExecConfirmed() {
    if (!plan) return
    startExecStream(plan.planId)
  }

  if (loadErr) {
    return <Err>{loadErr}</Err>
  }

  const srcOpts: ListboxOption<string>[] = envs.filter((entry) => entry.role !== "target").map((entry) => ({ value: entry.name, label: entry.displayName.toUpperCase(), dot: dot(entry.color) }))
  const tgtOpts: ListboxOption<string>[] = envs.filter((entry) => entry.role !== "source").map((entry) => ({ value: entry.name, label: entry.displayName.toUpperCase(), dot: dot(entry.color) }))
  const entOpts: ListboxOption<SyncEntityType>[] = ENTITY_TYPES.map((type) => ({
    value: type,
    label: definitions.find((entry) => entry.id === type)?.displayName ?? type,
    disabled: !definitions.find((entry) => entry.id === type),
  }))

  const hasPlan = !!plan
  const hasChanges = plan ? plan.totals.insert + plan.totals.update + plan.totals.delete > 0 : false
  const hasConflicts = plan ? (plan.totals.conflicts ?? 0) > 0 : false
  const expired = plan ? (Date.now() - plan.createdAtMs) > 3600_000 : false

  const rootRef = useRef<HTMLDivElement>(null)
  const { width: rootWidth } = useContainerSize(rootRef)
  const compact = rootWidth > 0 && rootWidth < 800
  const stacked = rootWidth > 0 && rootWidth < 580
  const tiny = rootWidth > 0 && rootWidth < 420
  const [moreOpen, setMoreOpen] = useState(false)

  return (
    <div ref={rootRef} className="h-full overflow-hidden flex flex-col gap-3 text-text pb-1">
      <div className="rounded-lg border border-border-subtle shrink-0 overflow-visible z-20">
        <div className={`px-3 py-2 overflow-visible ${stacked ? "flex flex-col gap-2" : "flex items-center gap-2"}`}>
          <div className={`flex items-center gap-2 ${stacked ? "w-full" : "shrink-0"}`}>
            {!compact && <span className="text-xs font-medium text-text-muted/50 uppercase tracking-wide shrink-0">From</span>}
            <Listbox value={source} options={srcOpts} onChange={(value) => setForm({ source: value })} size="md" variant="ghost" ariaLabel="Source" className="w-24" />
            {!compact && <span className="text-xs font-medium text-text-muted/50 uppercase tracking-wide shrink-0">To</span>}
            {compact && <span className="text-xs text-text-muted/40 shrink-0">→</span>}
            <Listbox value={target} options={tgtOpts} onChange={(value) => setForm({ target: value })} size="md" variant="ghost" ariaLabel="Target" className="w-24" />

            {!stacked && <div className="h-4 w-px bg-overlay-3 shrink-0" />}

            <Listbox
              value={entityType}
              options={entOpts}
              onChange={(value) => {
                setForm({ entityType: value, entityId: "" })
                setSearchDraft("")
                setSearchResults([])
                setSearchOpen(false)
              }}
              size="md"
              variant="ghost"
              ariaLabel="Entity type"
            />
          </div>

          <div className={`flex items-center gap-2 ${stacked ? "w-full" : "flex-1 min-w-0"}`}>
            <button
              onClick={() => {
                setForm({ searchMode: searchMode === "id" ? "name" : "id", entityId: "" })
                setSearchDraft("")
                setSearchResults([])
                setSearchOpen(false)
              }}
              className={`flex items-center justify-center gap-1 text-sm text-text-muted/60 hover:text-text py-1 rounded hover:bg-elevated transition-colors select-none shrink-0 ${tiny ? "w-9" : "w-16"}`}
              title={searchMode === "id" ? "Switch to name search" : "Switch to ID search"}
            >
              {searchMode === "id" ? <Key size={13} /> : <Search size={13} />}
              {!tiny && (searchMode === "id" ? "ID" : "Name")}
            </button>

            <div className="relative flex-1 min-w-0 overflow-visible" ref={searchBoxRef}>
              <div className={searchLoading ? "search-live-ring rounded-md p-[2px]" : "rounded-md"}>
                <div className={searchLoading ? "search-live-ring__inner relative rounded-[calc(0.375rem-2px)]" : "relative"}>
                  <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted/40 pointer-events-none z-10" />
                  <input
                    value={searchDraft}
                    onChange={(e) => onSearchInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void onPreview()}
                    onFocus={() => { if (searchResults.length) setSearchOpen(true) }}
                    placeholder={searchMode === "id" ? (definition?.idColumn ?? "id") : (definition?.labelColumn ?? "name")}
                    aria-busy={searchLoading}
                    className={[
                      "w-full bg-base text-text text-sm pl-7 py-1.5 rounded-md outline-none placeholder:text-text-muted/40",
                      entityId && !searchLoading ? "pr-7 font-sans" : "pr-7 font-mono",
                      searchLoading ? "border border-transparent" : entityId ? "border border-accent/50 focus:border-accent" : "border border-border-subtle focus:border-accent",
                    ].join(" ")}
                  />
                  {searchLoading && (
                    <Loader2
                      size={14}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-accent animate-spin pointer-events-none z-10"
                      aria-hidden
                    />
                  )}
                  {searchOpen && searchResults.length > 0 && (
                    <div className="absolute top-full left-0 mt-1 w-full max-w-[24rem] max-h-[min(280px,50vh)] overflow-y-auto bg-elevated border border-border rounded shadow-lg z-[100]">
                      {searchResults.map((hit) => (
                        <button
                          key={String(hit.id)}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault()
                            pickSearchHit(hit)
                          }}
                          className="w-full text-left px-3 py-1.5 text-sm hover:bg-surface transition-colors flex items-center gap-3"
                        >
                          <span className="text-text-muted font-mono text-sm shrink-0">{String(hit.id)}</span>
                          <span className="truncate">{hit.name ?? "—"}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {!searchOpen && !searchLoading && searchErr && (
                    <div className="absolute top-full left-0 mt-1 w-64 bg-elevated border border-border rounded shadow-lg z-[100] px-3 py-2 text-xs text-text-muted">
                      {searchErr}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {compact ? (
              <div className="relative shrink-0">
                <button onClick={() => setMoreOpen((value) => !value)} className="text-text-muted/60 hover:text-text p-1.5 rounded hover:bg-elevated transition-colors" title="More">
                  <MoreHorizontal size={16} />
                </button>
                {moreOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setMoreOpen(false)} />
                    <div className="absolute right-0 top-full mt-1 z-50 bg-elevated border border-border rounded-md shadow-2xl py-1 min-w-[160px]">
                      {hasPlan && (
                        <button onClick={() => { setPlan(null); setForm({ planId: null }); resetExec(); setExecModalOpen(false); setMoreOpen(false) }} className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-text-muted hover:text-text hover:bg-overlay-2 transition-colors">
                          <X size={14} /> Clear plan
                        </button>
                      )}
                      <button onClick={() => { setModal("definition"); setMoreOpen(false) }} className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-text-muted hover:text-text hover:bg-overlay-2 transition-colors">
                        <BookOpen size={14} /> Definition
                      </button>
                      <button onClick={() => { setModal("history"); setMoreOpen(false); setHasNewAgentSync(false) }} className="flex items-center gap-2.5 w-full px-3 py-2 text-sm text-text-muted hover:text-text hover:bg-overlay-2 transition-colors">
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
                  <button onClick={() => { setPlan(null); setForm({ planId: null }); resetExec(); setExecModalOpen(false) }} className="text-text-muted/60 hover:text-text p-1.5 rounded hover:bg-elevated transition-colors shrink-0" title="Clear plan">
                    <X size={16} />
                  </button>
                )}
                <button onClick={() => setModal("definition")} className="text-text-muted/60 hover:text-text p-1.5 rounded hover:bg-elevated transition-colors shrink-0" title="Definition">
                  <BookOpen size={16} />
                </button>
                <button onClick={() => { setModal("history"); setHasNewAgentSync(false) }} className="relative text-text-muted/60 hover:text-text p-1.5 rounded hover:bg-elevated transition-colors shrink-0" title="History">
                  <History size={16} />
                  {hasNewAgentSync && <span className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full bg-accent" />}
                </button>
              </>
            )}

            {!stacked && <div className="h-4 w-px bg-overlay-3 shrink-0" />}

            {exec.kind !== "idle" && (
              <button
                onClick={() => setExecModalOpen(true)}
                title={exec.kind === "running" ? "Execution in progress — click to view" : exec.kind === "done" && exec.success ? "Sync completed" : "Sync failed — click to view"}
                className={`flex items-center justify-center shrink-0 transition-colors rounded-lg w-9 h-9 ${exec.kind === "running" ? "bg-accent" : "border border-border-subtle hover:bg-elevated"}`}
              >
                {exec.kind === "running" && <Loader2 size={16} className="animate-spin text-text" />}
                {exec.kind === "done" && exec.success && <CheckCircle2 size={16} style={{ color: DIFF.ins }} />}
                {exec.kind === "done" && !exec.success && <XCircle size={16} style={{ color: DIFF.del }} />}
              </button>
            )}

            <button
              onClick={() => void onPreview()}
              disabled={!canPreview}
              title={blocker ?? (hasPlan && exec.kind === "idle" ? "Re-run preview" : "Preview")}
              className={`flex items-center justify-center w-9 h-9 rounded-lg shrink-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${hasPlan && exec.kind === "idle" ? "border border-border-subtle text-text-muted hover:text-text hover:bg-elevated disabled:bg-transparent" : "bg-accent hover:bg-accent-hover disabled:bg-elevated text-text"}`}
            >
              {previewing ? <Loader2 size={16} className="animate-spin" /> : hasPlan && exec.kind === "idle" ? <RefreshCw size={16} /> : <Eye size={16} />}
            </button>

            {hasPlan && exec.kind === "idle" && (
              <button
                onClick={() => setExecModalOpen(true)}
                disabled={!plan || expired || hasConflicts || !hasChanges}
                title={expired ? "Plan expired — re-preview" : hasConflicts ? "Resolve conflicts before syncing" : !hasChanges ? "No changes to sync" : "Execute sync"}
                className="flex items-center justify-center shrink-0 transition-colors rounded-lg w-9 h-9 bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_0_0_2px_var(--color-accent)]/20 ring-1 ring-accent/40"
              >
                <Ship size={16} className="text-text" />
              </button>
            )}
          </div>
        </div>
      </div>

      {previewErr ? (
        <div className="flex-1 flex items-center justify-center">
          <Err>{previewErr}</Err>
        </div>
      ) : previewing ? (
        <Loading>Building plan…</Loading>
      ) : planLoading ? (
        <Loading>Loading plan…</Loading>
      ) : plan ? (
        <PlanView plan={plan} expanded={expanded} setExpanded={setExpanded} exec={exec} />
      ) : (
        <Empty envs={envs} blocker={blocker} srcEnv={srcEnv} tgtEnv={tgtEnv} hasDefinitions={definitions.length > 0} />
      )}

      {modal === "definition" && (
        <ModalShell title="Sync Definition" subtitle={definition?.displayName ?? entityType} icon={<BookOpen size={20} className="text-text-muted" />} onClose={() => setModal(null)}>
          <DefinitionContent definition={definition} />
        </ModalShell>
      )}
      {modal === "history" && (
        <ModalShell title="Sync History" icon={<History size={20} className="text-text-muted" />} onClose={() => { setModal(null); setHasNewAgentSync(false) }}>
          <HistoryContent onOpen={(planId) => { void openPlanFromHistory(planId) }} />
        </ModalShell>
      )}
      {execModalOpen && (plan || execPlanId) && (
        <ExecModal exec={exec} plan={plan} execPlanId={execPlanId} tgtEnv={tgtEnv} onConfirm={onExecConfirmed} onClose={() => setExecModalOpen(false)} />
      )}
    </div>
  )
}

function getPlanEntityType(plan: SyncPlan): SyncEntityType | null {
  const raw = plan.executionContract?.definitionId ?? plan.recipeSnapshot?.entityType ?? plan.entity.type
  return isSyncEntityType(raw) ? raw : null
}

function buildPlanFormSig(
  plan: SyncPlan,
  definitions: PublishedSyncDefinition[],
  force: boolean,
  searchMode: "id" | "name",
): string {
  const planEntityType = getPlanEntityType(plan) ?? "contract"
  const entityIdStr = String(plan.entity.id)
  const hydratedDefinition = definitions.find((entry) => entry.id === planEntityType) ?? null
  const tables = [...normalizeOptionalTableSelection(hydratedDefinition, plan.recipeSnapshot?.enabledOptionalTables ?? null)].sort().join(",")
  return `${plan.source}|${plan.target}|${planEntityType}|${entityIdStr}|${force}|${searchMode}|${tables}`
}

function isSyncEntityType(value: string): value is SyncEntityType {
  return ENTITY_TYPES.includes(value as SyncEntityType)
}