import {
  BookOpen,
  CheckCircle2,
  Eye,
  History,
  Key,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Rocket,
  Search,
  Ship,
  X,
  XCircle,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"

import { api } from "../../client/index"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { SetupHintStrip } from "../../components/SetupHintStrip"
import { ToastStack, useWidgetToasts } from "../../components/useWidgetToasts"
import { useContainerSize } from "../../hooks/useContainerSize"
import { useStore } from "../../state/store"
import type {
  PublishedSyncDefinition,
  SyncEntityType,
  SyncEnvironment,
  SyncPlan,
  SyncPublishStatus,
} from "../../types"
import { IconButton, TOOLBAR_ICON } from "../entity-registry/IconButton"
import { ToolbarMenu, ToolbarMenuItem } from "../entity-registry/ToolbarMenu"
import {
  WidgetToolbar,
  WidgetToolbarLeading,
  WidgetToolbarSearchSlot,
  WidgetToolbarTrailing,
} from "../widget-toolbar"
import { Empty, Loading, ModalShell } from "./chrome"
import { DIFF, dot, ENTITY_TYPES, normalizeOptionalTableSelection } from "./constants"
import { DefinitionContent } from "./DefinitionContent"
import { cancelExec, completeExecFromAgent, getExecPlanId, getExecSnapshot, resetExec, startExecStream, subscribeExec } from "./exec-store"
import { execPreflightBlocked, execPreflightBlockReason, planHasMetadataChanges } from "./exec-preflight"
import { ExecModal } from "./ExecModal"
import { HistoryContent } from "./HistoryContent"
import { net, PlanView } from "./PlanTables"
import { PreviewProgressPanel } from "./PreviewProgressPanel"
import { createPreviewProgress, isPreviewInProgress } from "../../state/env-sync-preview-progress"
import type { ModalKind, SearchHit } from "./types"
import { listSyncSourceOptions, listSyncTargetOptions } from "./sync-env-eligibility"
import {
  formatSearchHitLabel,
  getPlanEntityType,
  isPreviewEntityReady,
  planMatchesSelection,
  previewEntityRef,
  type SyncSelection,
} from "./workflow"

export function EnvSync() {
  const { toasts, dismissToast, notifyError } = useWidgetToasts()
  const [envs, setEnvs] = useState<SyncEnvironment[]>([])
  const [definitions, setDefinitions] = useState<PublishedSyncDefinition[]>([])
  const [modal, setModal] = useState<ModalKind>(null)
  const [hasNewAgentSync, setHasNewAgentSync] = useState(false)
  const isFirstMountRef = useRef(true)

  const form = useStore((s) => s.envSyncForm)
  const setForm = useStore((s) => s.setEnvSyncForm)
  const plan = useStore((s) => s.envSyncPlan)
  const setPlan = useStore((s) => s.setEnvSyncPlan)
  const previewProgress = useStore((s) => s.envSyncPreviewProgress)
  const setPreviewProgress = useStore((s) => s.setEnvSyncPreviewProgress)
  const agentSyncExec = useStore((s) => s.agentSyncExec)
  const clearAgentSyncExec = useStore((s) => s.clearAgentSyncExec)
  const agentSyncExecStarted = useStore((s) => s.agentSyncExecStarted)
  const { source, target, entityId, force } = form
  const searchMode = form.searchMode ?? "id"
  const entityType = form.entityType as SyncEntityType

  const [previewing, setPreviewing] = useState(false)
  const [planLoading, setPlanLoading] = useState(false)
  const [publishStatus, setPublishStatus] = useState<SyncPublishStatus | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [execModalOpen, setExecModalOpen] = useState(false)
  const exec = useSyncExternalStore(subscribeExec, getExecSnapshot)
  const execPlanId = useSyncExternalStore(subscribeExec, getExecPlanId)

  const [searchResults, setSearchResults] = useState<SearchHit[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchErr, setSearchErr] = useState<string | null>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchBoxRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [searchDraft, setSearchDraft] = useState("")
  const { width: widgetWidth } = useContainerSize(rootRef)
  const compact = widgetWidth > 0 && widgetWidth < 860

  const srcEnv = useMemo(() => envs.find((entry) => entry.name === source) ?? null, [envs, source])
  const tgtEnv = useMemo(() => envs.find((entry) => entry.name === target) ?? null, [envs, target])
  const definition = useMemo(() => definitions.find((entry) => entry.id === entityType) ?? null, [definitions, entityType])
  const entityPublishRequired = Boolean(
    publishStatus?.unpublishedEntityIds?.includes(entityType),
  )
  const enabledOptionalTables = useMemo(
    () => normalizeOptionalTableSelection(definition, form.enabledOptionalTables),
    [definition, form.enabledOptionalTables],
  )

  const selection = useMemo<SyncSelection>(
    () => ({
      source,
      target,
      entityType,
      committedEntityId: entityId.trim(),
      force,
      searchMode,
      enabledOptionalTables,
    }),
    [source, target, entityType, entityId, force, searchMode, enabledOptionalTables],
  )

  const previewInput = previewEntityRef(selection.committedEntityId, searchDraft)
  const displayPlan = useMemo(
    () => (plan && planMatchesSelection(plan, selection) ? plan : null),
    [plan, selection],
  )

  const loadedPlanIdRef = useRef<string | null>(null)
  const hydrateRequestRef = useRef(0)
  const hydrateOptsRef = useRef<{ showNotFoundErr: boolean }>({ showNotFoundErr: false })

  const clearPlanState = useCallback(() => {
    setPlan(null)
    setForm({ planId: null })
    loadedPlanIdRef.current = null
    setPlanLoading(false)
  }, [setForm, setPlan])

  const discardStaleWorkflow = useCallback(() => {
    clearPlanState()
    setExpanded(new Set())
    setExecModalOpen(false)
    setPreviewProgress(null)
    if (getExecSnapshot().kind !== "running") resetExec()
  }, [clearPlanState, setPreviewProgress])

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

  useEffect(() => {
    function handle(event: MouseEvent) {
      if (searchBoxRef.current?.contains(event.target as Node)) return
      setSearchOpen(false)
      setSearchErr(null)
    }
    document.addEventListener("click", handle)
    return () => document.removeEventListener("click", handle)
  }, [])

  useEffect(() => {
    if (!plan) return
    if (planMatchesSelection(plan, selection)) return
    discardStaleWorkflow()
  }, [plan, selection, discardStaleWorkflow])

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
        notifyError(error instanceof Error ? error.message : String(error))
      } finally {
        setSearchLoading(false)
      }
    }, 300)
  }

  function pickSearchHit(hit: SearchHit) {
    const nextId = String(hit.id)
    if (nextId !== selection.committedEntityId) discardStaleWorkflow()
    setForm({ entityId: nextId })
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

  function clearStalePlanId(planId: string) {
    if (useStore.getState().envSyncForm.planId === planId) {
      setForm({ planId: null })
    }
    if (useStore.getState().envSyncPlan?.planId === planId) {
      setPlan(null)
    }
    if (loadedPlanIdRef.current === planId) loadedPlanIdRef.current = null
  }

  async function fetchPlan(planId: string, opts: { showNotFoundErr: boolean }): Promise<SyncPlan | null> {
    try {
      const nextPlan = await api.syncPlan(planId)
      if (nextPlan.error) {
        if (opts.showNotFoundErr) {
          notifyError(`Plan ${planId} not found — it may have been pruned from history.`)
        }
        clearStalePlanId(planId)
        return null
      }
      return nextPlan
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (opts.showNotFoundErr) {
        notifyError(/not found|expired/i.test(msg)
          ? "Plan not found — it may have been pruned from history."
          : `Failed to load plan: ${msg}`)
      }
      clearStalePlanId(planId)
      return null
    }
  }

  function applyLoadedPlan(nextPlan: SyncPlan) {
    const planEntityType = getPlanEntityType(nextPlan) ?? entityType
    const entityIdStr = String(nextPlan.entity.id)
    setPlan(nextPlan)
    setExpanded(new Set())
    setForm({
      planId: nextPlan.planId,
      source: nextPlan.source,
      target: nextPlan.target,
      entityType: planEntityType,
      entityId: entityIdStr,
      enabledOptionalTables: nextPlan.executionContract.metadata.enabledOptionalTables ?? null,
    })
    setSearchDraft(
      nextPlan.entity.displayName
        ? formatSearchHitLabel({ id: nextPlan.entity.id, name: nextPlan.entity.displayName })
        : entityIdStr,
    )
    loadedPlanIdRef.current = nextPlan.planId
    if (!isFirstMountRef.current) setHasNewAgentSync(true)
  }

  async function openPlanFromHistory(planId: string) {
    setModal(null)
    setHasNewAgentSync(false)
    setExpanded(new Set())
    setExecModalOpen(false)
    if (getExecSnapshot().kind !== "running") resetExec()
    loadedPlanIdRef.current = null
    hydrateOptsRef.current = { showNotFoundErr: true }
    setPlan(null)
    setForm({ planId })
  }

  useEffect(() => {
    let dead = false
    // Independent reads — unpublished definitions must not wipe a successful
    // environments load (that falsely showed "need 2 environments").
    void Promise.allSettled([
      api.syncEnvironments(),
      api.syncDefinitions(),
      api.getSyncPublishStatus(),
    ]).then(([envsResult, definitionsResult, publishStatusResult]) => {
      if (dead) return

      if (envsResult.status === "fulfilled") {
        const nextEnvs = envsResult.value
        setEnvs(nextEnvs)
        const sources = listSyncSourceOptions(nextEnvs)
        const nextForm: Partial<typeof form> = {}
        if (sources.length >= 1 && !source) nextForm.source = sources[0].name
        const sourceForTargets = nextForm.source ?? source
        const targets = listSyncTargetOptions(nextEnvs, sourceForTargets || null)
        if (targets.length >= 1 && !target) {
          nextForm.target = targets.find((env) => env.name !== sourceForTargets)?.name ?? targets[0].name
        }
        if (Object.keys(nextForm).length) setForm(nextForm)
      } else {
        notifyError(
          envsResult.reason instanceof Error
            ? envsResult.reason.message
            : String(envsResult.reason ?? "Failed to load sync environments"),
        )
      }

      if (definitionsResult.status === "fulfilled") {
        setDefinitions(definitionsResult.value)
      } else {
        setDefinitions([])
        // Missing published bundle is an empty state, not a toast storm.
        const msg = definitionsResult.reason instanceof Error
          ? definitionsResult.reason.message
          : String(definitionsResult.reason ?? "")
        if (msg && !/no published sync definitions/i.test(msg)) {
          notifyError(msg)
        }
      }

      setPublishStatus(publishStatusResult.status === "fulfilled" ? publishStatusResult.value : null)
    })
    return () => { dead = true }
  }, [])

  useEffect(() => {
    const newPlanId = form.planId
    if (!newPlanId) {
      setPlanLoading(false)
      return
    }
    if (plan?.planId === newPlanId) {
      loadedPlanIdRef.current = newPlanId
      setPlanLoading(false)
      return
    }

    const requestId = ++hydrateRequestRef.current
    const fetchOpts = { ...hydrateOptsRef.current }
    hydrateOptsRef.current = { showNotFoundErr: false }
    setPlanLoading(true)
    void fetchPlan(newPlanId, fetchOpts).then((nextPlan) => {
      if (requestId !== hydrateRequestRef.current) return
      if (nextPlan) applyLoadedPlan(nextPlan)
      else loadedPlanIdRef.current = null
    }).finally(() => {
      if (requestId === hydrateRequestRef.current) setPlanLoading(false)
    })

    return () => {
      hydrateRequestRef.current += 1
    }
  }, [form.planId, plan?.planId])

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

  const entityReady = isPreviewEntityReady(selection, searchDraft, { searchLoading })
  const blocker =
    !source || !target ? "Pick source + target"
      : source === target ? "Source ≠ target"
        : !definition ? "No published definition"
          : entityPublishRequired
            ? "Publish required — catalog tip ahead of published contract for this entity"
          : searchLoading ? "Search in progress…"
            : !entityReady
              ? selection.searchMode === "name" && !selection.committedEntityId
                ? "Pick an entity from search"
                : `Enter ${searchMode === "name" ? (definition?.labelColumn ?? "name") : (definition?.idColumn ?? "id")}`
              : null
  const canPreview = !blocker && !previewing

  async function onPreview() {
    if (!canPreview) return
    setPreviewing(true)
    discardStaleWorkflow()
    setPreviewProgress(createPreviewProgress({
      entityType,
      entityId: previewInput,
      source,
      target,
    }))
    try {
      const requestEnabledOptionalTables = Array.isArray(form.enabledOptionalTables) ? enabledOptionalTables : undefined
      const result = await api.syncPreview({
        entityType,
        entityId: previewInput,
        source,
        target,
        force,
        enabledOptionalTables: requestEnabledOptionalTables,
      })
      if (result.error) {
        notifyError(result.error)
        setForm({ planId: null })
      } else {
        loadedPlanIdRef.current = result.planId
        setPlan(result)
        const entityIdStr = String(result.entity.id)
        setForm({ planId: result.planId, entityId: entityIdStr })
        setSearchDraft(
          result.entity.displayName
            ? formatSearchHitLabel({ id: result.entity.id, name: result.entity.displayName })
            : entityIdStr,
        )
        setExpanded(
          new Set(
            result.tables
              .filter((row) => net(row) > 0 || (row.conflicts?.length ?? 0) > 0)
              .map((row) => row.table),
          ),
        )
      }
    } catch (error) {
      notifyError(error instanceof Error ? error.message : String(error))
      setForm({ planId: null })
    } finally {
      setPreviewing(false)
      setPreviewProgress(null)
    }
  }

  function onExecConfirmed() {
    if (!displayPlan) return
    startExecStream(displayPlan.planId)
  }

  const srcOpts: ListboxOption<string>[] = listSyncSourceOptions(envs).map((entry) => ({
    value: entry.name,
    label: entry.displayName.toUpperCase(),
    dot: dot(entry.color),
  }))
  const tgtOpts: ListboxOption<string>[] = listSyncTargetOptions(envs, source || null).map((entry) => ({
    value: entry.name,
    label: entry.displayName.toUpperCase(),
    dot: dot(entry.color),
  }))
  const entOpts: ListboxOption<SyncEntityType>[] = ENTITY_TYPES.map((type) => ({
    value: type,
    label: definitions.find((entry) => entry.id === type)?.displayName ?? type,
    disabled: !definitions.find((entry) => entry.id === type),
  }))

  const hasPlan = !!displayPlan
  const hasMetadataChanges = displayPlan ? planHasMetadataChanges(displayPlan) : false
  const hasConflicts = displayPlan ? (displayPlan.totals.conflicts ?? 0) > 0 : false
  const preflightBlocked = displayPlan ? execPreflightBlocked(displayPlan) : false
  const preflightBlockReason = displayPlan ? execPreflightBlockReason(displayPlan) : null
  const expired = displayPlan ? Date.now() - displayPlan.createdAtMs > 3600_000 : false
  const execActive = exec.kind !== "idle"
  const execForDisplayPlan = displayPlan != null && (execPlanId === displayPlan.planId || exec.kind === "running")
  const previewActive = isPreviewInProgress(previewing, previewProgress)

  const catalogPublishArmed = Boolean(
    publishStatus?.catalogNeedsPublish || (publishStatus?.unpublishedEntityCount ?? 0) > 0,
  )
  const showPublishSetupHint = entityPublishRequired || (definitions.length === 0 && envs.length >= 2)

  return (
    <div ref={rootRef} className="relative flex h-full flex-col overflow-hidden text-text pb-1">
      {showPublishSetupHint && (
        <SetupHintStrip icon={Rocket} className="px-3">
          {definitions.length === 0 ? (
            <>
              No published sync bundle yet. Publish from Entity Registry before preview/execute.
              {catalogPublishArmed ? " Publish is armed." : ""}
            </>
          ) : (
            <>
              Published sync contract for{" "}
              <span className="font-mono font-medium">{entityType}</span> is behind the catalog tip.
              Publish from Entity Registry before preview/execute — tip edits are not applied until then.
            </>
          )}
        </SetupHintStrip>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden pt-3">
      <WidgetToolbar compact={compact} className="env-sync-toolbar overflow-visible z-20">
        <WidgetToolbarLeading>
          <label className="env-sync-field">
              <span className="field-label">From</span>
              <Listbox
                value={source}
                options={srcOpts}
                onChange={(value) => {
                  if (value !== source) discardStaleWorkflow()
                  const nextTargets = listSyncTargetOptions(envs, value)
                  const targetStillOk = nextTargets.some((env) => env.name === target)
                  setForm({
                    source: value,
                    ...(targetStillOk
                      ? {}
                      : {
                          target:
                            nextTargets.find((env) => env.name !== value)?.name ??
                            nextTargets[0]?.name ??
                            "",
                        }),
                  })
                }}
                size="sm"
                variant="default"
                ariaLabel="Source environment"
                className="env-sync-env-select"
              />
            </label>
            <label className="env-sync-field">
              <span className="field-label">To</span>
              <Listbox
                value={target}
                options={tgtOpts}
                onChange={(value) => {
                  if (value !== target) discardStaleWorkflow()
                  setForm({ target: value })
                }}
                size="sm"
                variant="default"
                ariaLabel="Target environment"
                className="env-sync-env-select"
              />
            </label>

            <div className="env-sync-toolbar-divider" aria-hidden />

            <label className="env-sync-field env-sync-field--entity">
              <span className="field-label">Entity</span>
              <Listbox
                value={entityType}
                options={entOpts}
                onChange={(value) => {
                  discardStaleWorkflow()
                  setForm({ entityType: value, entityId: "" })
                  setSearchDraft("")
                  setSearchResults([])
                  setSearchOpen(false)
                }}
                size="sm"
                variant="default"
                ariaLabel="Entity type"
                className="env-sync-entity-select"
              />
            </label>
        </WidgetToolbarLeading>

        <WidgetToolbarSearchSlot>
          <div className="widget-toolbar__search-row">
            <button
              type="button"
              onClick={() => {
                discardStaleWorkflow()
                setForm({ searchMode: searchMode === "id" ? "name" : "id", entityId: "" })
                setSearchDraft("")
                setSearchResults([])
                setSearchOpen(false)
              }}
              className="env-sync-mode-toggle shrink-0"
              title={searchMode === "id" ? "Switch to name search" : "Switch to ID search"}
            >
              {searchMode === "id" ? <Key size={14} /> : <Search size={14} />}
              <span className="env-sync-mode-toggle-label">{searchMode === "id" ? "ID" : "Name"}</span>
            </button>

            <div className="env-sync-search-wrap" ref={searchBoxRef}>
              <div className={`h-full ${searchLoading ? "search-live-ring" : ""}`}>
                <div className={`h-full ${searchLoading ? "search-live-ring__inner" : ""} relative`}>
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted/40 pointer-events-none z-10" />
                  <input
                    value={searchDraft}
                    onChange={(e) => onSearchInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void onPreview()}
                    onFocus={() => { if (searchResults.length) setSearchOpen(true) }}
                    placeholder={searchMode === "id" ? (definition?.idColumn ?? "id") : (definition?.labelColumn ?? "name")}
                    aria-busy={searchLoading}
                    className={[
                      "env-sync-search-input font-mono",
                      searchLoading ? "env-sync-search-input--loading" : "",
                      selection.committedEntityId && !searchLoading ? "env-sync-search-input--committed font-sans" : "",
                    ].join(" ")}
                  />
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
          </div>
        </WidgetToolbarSearchSlot>

        <WidgetToolbarTrailing>
          <div className="env-sync-actions-secondary env-sync-actions-secondary--compact">
            <ToolbarMenu
              title="More actions"
              ariaLabel="More actions"
              trigger={<MoreHorizontal {...TOOLBAR_ICON} />}
            >
              {hasPlan && (
                <ToolbarMenuItem
                  icon={<X size={14} />}
                  label="Clear plan"
                  onClick={() => discardStaleWorkflow()}
                />
              )}
              <ToolbarMenuItem
                icon={<BookOpen size={14} />}
                label="Definition"
                onClick={() => setModal("definition")}
              />
              <ToolbarMenuItem
                icon={<History size={14} />}
                label="History"
                onClick={() => { setModal("history"); setHasNewAgentSync(false) }}
              />
            </ToolbarMenu>
          </div>

          <div className="env-sync-actions-secondary env-sync-actions-secondary--inline">
            {hasPlan ? (
              <IconButton className="env-sync-control-btn" label="Clear plan" onClick={() => discardStaleWorkflow()}>
                <X {...TOOLBAR_ICON} />
              </IconButton>
            ) : null}
            <div className="env-sync-toolbar-icon-group">
              <IconButton
                className="env-sync-control-btn"
                label="Definition"
                variant="group"
                active={modal === "definition"}
                onClick={() => setModal("definition")}
              >
                <BookOpen {...TOOLBAR_ICON} />
              </IconButton>
              <span className="env-sync-toolbar-icon-sep" aria-hidden />
              <div className="relative h-full shrink-0">
                <IconButton
                  className="env-sync-control-btn"
                  label="History"
                  variant="group"
                  active={modal === "history"}
                  onClick={() => { setModal("history"); setHasNewAgentSync(false) }}
                >
                  <History {...TOOLBAR_ICON} />
                </IconButton>
                {hasNewAgentSync && (
                  <span className="pointer-events-none absolute top-1 right-1 h-2 w-2 rounded-full bg-accent" />
                )}
              </div>
            </div>
          </div>

          <div className="env-sync-actions-divider" aria-hidden />

          <div className="env-sync-toolbar-primary">
            {execActive && execForDisplayPlan ? (
              <IconButton
                className="env-sync-control-btn"
                label={exec.kind === "running" ? "Execution in progress — click to view" : exec.kind === "done" && exec.success ? "Sync completed" : "Sync failed — click to view"}
                variant={exec.kind === "running" ? "primary" : "default"}
                onClick={() => setExecModalOpen(true)}
              >
                {exec.kind === "running" && <Loader2 {...TOOLBAR_ICON} className="animate-spin" />}
                {exec.kind === "done" && exec.success && <CheckCircle2 {...TOOLBAR_ICON} style={{ color: DIFF.ins }} />}
                {exec.kind === "done" && !exec.success && <XCircle {...TOOLBAR_ICON} style={{ color: DIFF.del }} />}
              </IconButton>
            ) : null}

            <IconButton
              className="env-sync-control-btn"
              label={blocker ?? (hasPlan && !execActive ? "Re-run preview" : "Preview")}
              variant={hasPlan && !execActive ? "default" : "primary"}
              onClick={() => void onPreview()}
              disabled={!canPreview}
            >
              {previewing ? <Loader2 {...TOOLBAR_ICON} className="animate-spin" /> : hasPlan && !execActive ? <RefreshCw {...TOOLBAR_ICON} /> : <Eye {...TOOLBAR_ICON} />}
            </IconButton>

            {hasPlan && !execActive ? (
              <IconButton
                className="env-sync-control-btn shadow-[0_0_0_2px_var(--color-accent)]/20 ring-1 ring-accent/40"
                label={
                  searchLoading ? "Search in progress…"
                    : expired ? "Plan expired — re-preview"
                    : hasConflicts ? "Resolve conflicts before syncing"
                      : preflightBlocked ? (preflightBlockReason ?? "Preflight checks failed — open execute modal")
                        : !hasMetadataChanges ? "Run full flow — metadata already in sync"
                          : "Execute sync"
                }
                variant="primary"
                onClick={() => setExecModalOpen(true)}
                disabled={expired || hasConflicts || preflightBlocked || searchLoading}
              >
                <Ship {...TOOLBAR_ICON} />
              </IconButton>
            ) : null}
          </div>
        </WidgetToolbarTrailing>
      </WidgetToolbar>

      <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
        {previewActive ? (
          previewProgress ? (
            <PreviewProgressPanel progress={previewProgress} />
          ) : (
            <Loading>Building plan…</Loading>
          )
        ) : planLoading ? (
          <Loading>Loading plan…</Loading>
        ) : displayPlan ? (
          <PlanView plan={displayPlan} expanded={expanded} setExpanded={setExpanded} exec={exec} />
        ) : (
          <Empty
            envs={envs}
            blocker={blocker}
            srcEnv={srcEnv}
            tgtEnv={tgtEnv}
            hasDefinitions={definitions.length > 0}
            publishHintActive={showPublishSetupHint}
          />
        )}
      </div>

      {modal === "definition" && (
        <ModalShell
          title="Sync Definition"
          subtitle={definition?.displayName ?? entityType}
          icon={<BookOpen size={20} className="text-text-muted" />}
          size="focus"
          onClose={() => setModal(null)}
        >
          <DefinitionContent definition={definition} />
        </ModalShell>
      )}
      {modal === "history" && (
        <ModalShell
          title="Sync History"
          icon={<History size={20} className="text-text-muted" />}
          size="focus"
          onClose={() => { setModal(null); setHasNewAgentSync(false) }}
        >
          <HistoryContent onOpen={(planId) => { void openPlanFromHistory(planId) }} onNotifyError={notifyError} />
        </ModalShell>
      )}
      {execModalOpen && (displayPlan || execPlanId) && (
        <ExecModal
          exec={exec}
          plan={displayPlan}
          execPlanId={execPlanId}
          tgtEnv={tgtEnv}
          onConfirm={onExecConfirmed}
          onCancel={() => { void cancelExec() }}
          onClose={() => {
            if (exec.kind === "running") void cancelExec()
            setExecModalOpen(false)
          }}
        />
      )}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      </div>
    </div>
  )
}
