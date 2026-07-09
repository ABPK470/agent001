/**
 * Term-UI shell.
 *
 * Layout:
 *
 *   ┌──────────────── StatusBar ────────────────────────────────────┐
 *   │ STREAM (active run)         │ OPERATIONS (unified ops log)    │
 *   │                             │                                 │
 *   │                             │                                 │
 *   ├─────────────────────────────┴─────────────────────────────────┤
 *   │ > goal prompt                                                 │
 *   ├──────────────── HelpBar ──────────────────────────────────────┤
 *
 * Two panes, focusable via [1]/[2]; `/` focuses the log filter; `:`
 * focuses the goal prompt; Esc bubbles up to clear or unfocus.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { downloadAuthenticated, traceExportFilename } from "./userDownload"
import { api, createEventStream } from "./api"
import { buildCommands, matchSlash, slashSuggestions, type Command } from "./commands"
import { AdminLogin } from "./components/AdminLogin"
import { AttachmentBar, type PendingAttachment } from "./components/AttachmentBar"
import { CommandPalette } from "./components/CommandPalette"
import { GoalInput, type GoalInputHandle } from "./components/GoalInput"
import { LogPane, type LogPaneHandle } from "./components/LogPane"
import { RunPicker } from "./components/RunPicker"
import { StatusBar } from "./components/StatusBar"
import { StreamPane, type StreamPaneHandle } from "./components/StreamPane"
import { VisualPane } from "./components/VisualPane"
// ui-term still uses the legacy WelcomeFlow (intro/outro/reveal mosaic
// animation). The new conversational login lives in packages/ui only.
import { WelcomeFlowLegacy as WelcomeFlow } from "./components/WelcomeFlowLegacy"
import { isMeta, useGlobalKeybinds } from "./keybinds"
import { useStore } from "./store"
import { setUiShell, urlForShell } from "./uiPref"
import { useMe } from "./useMe"

type Pane = "stream" | "log"
type ViewMode = "tui" | "visual"

export function App() {
  const { me, loading, needsWelcome, setIdentity, switchUser, refresh } = useMe()
  const [adminOpen, setAdminOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // Single source of truth for the overlay:
  //   "loading"   — initial fetch; blank background
  //   "login"     — needs identity; WelcomeFlow handles login + intro animation as one flow
  //   "outro"     — logout; mosaic covers inward, then back to login
  //   "switching" — switching to classic UI; mosaic covers inward, then navigate
  //   "reveal"    — arriving from classic UI; mosaic dissolves outward revealing shell
  //   "shell"     — fully authenticated, no overlay
  type Phase = "loading" | "login" | "outro" | "switching" | "reveal" | "shell"
  const [phase, setPhase] = useState<Phase>("loading")
  const [focused, setFocused] = useState<Pane>("stream")
  const [viewMode, setViewMode] = useState<ViewMode>("tui")
  // Pending attachments staged for the next /api/runs call. Bytes already
  // live on the server; this list is just the chip strip + the id list we
  // hand to api.startRun. Cleared after each successful submit.
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  // Hidden file input the /attach slash command and chip-bar "+" trigger.
  const fileInputRef = useRef<HTMLInputElement>(null)
  const toggleView = useCallback(() => setViewMode((v) => v === "tui" ? "visual" : "tui"), [])

  // After initial load, decide starting phase.
  useEffect(() => {
    if (loading) return
    if (phase === "loading") {
      if (needsWelcome) {
        setPhase("login")
      } else {
        // Check if arriving from classic UI → play reveal animation
        const flag = "mia:ui-transition"
        try {
          if (window.localStorage.getItem(flag)) {
            window.localStorage.removeItem(flag)
            setPhase("reveal")
            return
          }
        } catch { /* ignore */ }
        setPhase("shell")
      }
    } else if (needsWelcome && phase === "shell") {
      setPhase("outro")
    }
  }, [loading, needsWelcome, phase])

  // Wrap switchUser: just cover the shell with outro animation.
  // switchUser() (which makes needsWelcome=true) is called ONLY after
  // the outro animation finishes — so the shell stays alive the whole time.
  const handleSwitchUser = useCallback(() => {
    setPhase("outro")
  }, [])

  // Switch to classic UI — play mosaic inward cover, then navigate.
  const handleSwitchUi = useCallback(() => {
    setPhase("switching")
  }, [])

  // Redirect non-admin users to the main UI — this shell is admin-only.
  useEffect(() => {
    if (!me || needsWelcome) return
    if (!me.isAdmin) {
      setUiShell("classic")
      window.location.assign(urlForShell("classic"))
    }
  }, [me, needsWelcome])
  const runs          = useStore((s) => s.runs)
  const activeRunId   = useStore((s) => s.activeRunId)
  const setActiveRun  = useStore((s) => s.setActiveRun)
  const resetTranscript    = useStore((s) => s.resetTranscript)
  const hydrateTranscript  = useStore((s) => s.hydrateTranscript)
  const setRuns       = useStore((s) => s.setRuns)
  const pendingInput  = useStore((s) => s.pendingInput)
  const clearPending  = useStore((s) => s.clearPendingInput)
  const pushEvent    = useStore((s) => s.pushEvent)
  const setConnected = useStore((s) => s.setConnected)
  const connected    = useStore((s) => s.connected)
  const transcript   = useStore((s) => s.transcript)
  const streaming    = useStore((s) => s.streamingAnswer)
  const events       = useStore((s) => s.events)

  const goalRef   = useRef<GoalInputHandle>(null)
  const logRef    = useRef<LogPaneHandle>(null)
  const streamRef = useRef<StreamPaneHandle>(null)

  const bootstrapThreads = useStore((s) => s.bootstrapThreads)

  useEffect(() => {
    if (!me || needsWelcome) return
    void bootstrapThreads().catch(() => {})
  }, [me, needsWelcome, bootstrapThreads])

  // ── Identity-bound SSE subscription ──
  useEffect(() => {
    const stream = createEventStream(pushEvent, setConnected)
    return () => stream.close()
  }, [pushEvent, setConnected, me?.sessionId])

  // ── Initial run list + transcript hydration ──
  useEffect(() => {
    if (!me) return

    api.listRuns().then((rs) => {
      setRuns(rs)
      if (rs.length && !activeRunId) {
        const latest = rs[0]!
        resetTranscript(latest.id)
        // Hydrate transcript for the latest run from the event_log (structured events).
        // searchEvents returns newest-first; reverse for chronological replay.
        // Uses hydrateTranscript (not pushEvent) so the ops log is not seeded with
        // run-specific DB history — the ops buffer stays SSE-only.
        api.searchEvents(latest.id, { limit: 500 }).then(({ events }) => {
          hydrateTranscript([...events].reverse(), latest.id)
        }).catch(() => { /* non-fatal */ })
      }
    }).catch(() => { /* non-fatal */ })
  }, [me?.sessionId, setRuns, setActiveRun, pushEvent, activeRunId])

  // Active run snapshot
  const activeRun = useMemo(
    () => runs.find((r) => r.id === activeRunId) ?? null,
    [runs, activeRunId],
  )
  const busy = !!activeRun && (activeRun.status === "running" || activeRun.status === "pending")

  // ── Answer to ask_user (used by both TUI banner and VisualPane modal) ──
  const onAnswer = useCallback(async (text: string) => {
    if (!pendingInput) return
    try { await api.respondToRun(pendingInput.runId, text) }
    finally { clearPending() }
  }, [pendingInput, clearPending])

  // ── Submit handler — slash command, ask_user response, or new run ──
  // commandsRef avoids a TDZ cycle: this callback resolves slash commands
  // through the registry, but the registry is built further down.
  const commandsRef = useRef<Command[]>([])
  const onSubmitGoal = useCallback(async (text: string) => {
    // Slash commands resolve through the central registry.
    const slashCmd = matchSlash(text, commandsRef.current)
    if (slashCmd) { void slashCmd.run(); return }
    // Lone "/" or unrecognised slash → open the palette pre-filled.
    if (text.trim().startsWith("/")) {
      setPaletteOpen(true)
      return
    }

    if (pendingInput) {
      try { await api.respondToRun(pendingInput.runId, text) }
      finally { clearPending() }
      return
    }

    if (busy) {
      pushEvent({
        type: "ui.notice",
        timestamp: new Date().toISOString(),
        data: { runId: activeRunId, message: "a run is still active \u2014 type /cancel (or Ctrl+.) to abort it before starting a new one." },
      })
      return
    }

    try {
      const attachmentIds = pendingAttachments.map((a) => a.id)
      const threadId = useStore.getState().activeThreadId
      if (!threadId) throw new Error("No thread selected")
      const { runId } = await api.startRun(text, undefined, attachmentIds, threadId)
      resetTranscript(runId); setActiveRun(runId)
      // Bind-once semantics: attachments are consumed by the run that
      // started, the chip strip clears so the next prompt is "fresh".
      // Bytes survive on the server and can be re-attached by id later
      // if needed.
      if (pendingAttachments.length > 0) {
        pushEvent({
          type: "ui.notice",
          timestamp: new Date().toISOString(),
          data: { runId, message: `attached ${pendingAttachments.length} file${pendingAttachments.length === 1 ? "" : "s"} to this run` },
        })
        setPendingAttachments([])
      }
    } catch (e) {
      pushEvent({ type: "ui.error", timestamp: new Date().toISOString(), data: { message: e instanceof Error ? e.message : String(e) } })
    }
  }, [pendingInput, clearPending, resetTranscript, setActiveRun, pushEvent, activeRunId, busy, pendingAttachments])

  // ── Open a specific run (used by RunPicker) ──
  const openRun = useCallback((id: string) => {
    resetTranscript(id)
    setActiveRun(id)
    // Replay structured events from event_log into transcript only.
    // Uses hydrateTranscript (not pushEvent) to keep the ops log free of
    // run-specific DB history — ops stays SSE-only, shows all event types.
    api.searchEvents(id, { limit: 500 }).then(({ events }) => {
      hydrateTranscript([...events].reverse(), id)
    }).catch(() => { /* non-fatal */ })
  }, [resetTranscript, setActiveRun, hydrateTranscript])

  // Cancel the active run (used by StatusBar [abort], Ctrl+., /cancel).
  const abortActive = useCallback(() => {
    if (!activeRunId) return
    api.cancelRun(activeRunId).catch((e) => {
      pushEvent({ type: "ui.error", timestamp: new Date().toISOString(), data: { runId: activeRunId, message: e instanceof Error ? e.message : String(e) } })
    })
  }, [activeRunId, pushEvent])

  const rerunActive = useCallback(async () => {
    if (!activeRunId) {
      pushEvent({ type: "ui.notice", timestamp: new Date().toISOString(), data: { message: "no run to rerun" } })
      return
    }
    try {
      const { runId } = await api.rerunRun(activeRunId)
      resetTranscript(runId); setActiveRun(runId)
    } catch (e) {
      pushEvent({ type: "ui.error", timestamp: new Date().toISOString(), data: { runId: activeRunId, message: e instanceof Error ? e.message : String(e) } })
    }
  }, [activeRunId, resetTranscript, setActiveRun, pushEvent])

  const rollbackActive = useCallback(async () => {
    if (!activeRunId) return
    try {
      const preview = await api.previewRollback(activeRunId)
      const n = preview.effectCount ?? preview.effects?.length ?? 0
      if (n === 0) {
        pushEvent({ type: "ui.notice", timestamp: new Date().toISOString(), data: { runId: activeRunId, message: "no reversible effects on this run" } })
        return
      }
      const ok = window.confirm(`Rollback ${n} effect${n === 1 ? "" : "s"} from run ${activeRunId.slice(0, 7)}?`)
      if (!ok) return
      const result = await api.rollbackRun(activeRunId)
      pushEvent({ type: "ui.notice", timestamp: new Date().toISOString(), data: { runId: activeRunId, message: `rolled back ${result.reverted ?? n} effect(s)` } })
    } catch (e) {
      pushEvent({ type: "ui.error", timestamp: new Date().toISOString(), data: { runId: activeRunId, message: e instanceof Error ? e.message : String(e) } })
    }
  }, [activeRunId, pushEvent])

  const exportTrace = useCallback(async () => {
    if (!activeRunId) return
    try {
      const { filename, bytes } = await downloadAuthenticated(
        `/api/runs/${encodeURIComponent(activeRunId)}/export/trace`,
        traceExportFilename(activeRunId, "txt"),
      )
      pushEvent({
        type: "ui.notice",
        timestamp: new Date().toISOString(),
        data: { runId: activeRunId, message: `downloaded ${filename} (${bytes.toLocaleString()} bytes)` },
      })
    } catch (e) {
      pushEvent({
        type: "ui.error",
        timestamp: new Date().toISOString(),
        data: { runId: activeRunId, message: `trace export failed: ${e instanceof Error ? e.message : String(e)}` },
      })
    }
  }, [activeRunId, pushEvent])

  const flagAnswer = useCallback(async () => {
    if (!activeRunId) return
    try {
      const result = await api.flagAnswer(activeRunId)
      const msg = result.action === "flagged"
        ? "answer flagged as unhelpful \u2014 memory down-weighted, agent will avoid this approach next time"
        : result.action === "no_memory_entry"
          ? "no episodic memory entry found for this run (may still be indexing)"
          : "flagged"
      pushEvent({ type: "ui.notice", timestamp: new Date().toISOString(), data: { runId: activeRunId, message: msg } })
    } catch (e) {
      pushEvent({ type: "ui.error", timestamp: new Date().toISOString(), data: { runId: activeRunId, message: `flag failed: ${e instanceof Error ? e.message : String(e)}` } })
    }
  }, [activeRunId, pushEvent])

  // ── Attachments ──
  // 32 MiB matches the server-side route cap. We warn and skip larger
  // files locally so the user gets immediate feedback instead of a 413.
  const ATTACH_MAX_BYTES = 32 * 1024 * 1024
  const uploadFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      if (file.size > ATTACH_MAX_BYTES) {
        pushEvent({
          type: "ui.error",
          timestamp: new Date().toISOString(),
          data: { message: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB \u2014 max 32 MB per attachment` },
        })
        continue
      }
      try {
        const meta = await api.uploadAttachment(file)
        setPendingAttachments((prev) => [
          ...prev,
          { id: meta.id, name: meta.normalizedName, sizeBytes: meta.sizeBytes },
        ])
        pushEvent({
          type: "ui.notice",
          timestamp: new Date().toISOString(),
          data: { message: `attached ${meta.normalizedName} (${meta.sizeBytes} bytes)` },
        })
      } catch (e) {
        pushEvent({
          type: "ui.error",
          timestamp: new Date().toISOString(),
          data: { message: `upload failed for ${file.name}: ${e instanceof Error ? e.message : String(e)}` },
        })
      }
    }
  }, [pushEvent])

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id))
    void api.deleteAttachment(id)
  }, [])

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click()
  }, [])

  // ── Command registry ── single source of truth for keybinds, slash, palette.
  const commands: Command[] = useMemo(() => buildCommands({
    ctx: { busy, activeRunId, hasPendingInput: !!pendingInput },
    openPalette:    () => setPaletteOpen(true),
    openRunPicker:  () => setPickerOpen(true),
    openAdmin:      () => setAdminOpen(true),
    focusStream:    () => { setFocused("stream"); window.requestAnimationFrame(() => streamRef.current?.focus()) },
    focusLog:       () => { setFocused("log"); window.requestAnimationFrame(() => logRef.current?.focusScroll()) },
    focusFilter:    () => { setFocused("log"); window.requestAnimationFrame(() => logRef.current?.focusFilter()) },
    followLog:      () => { setFocused("log"); window.requestAnimationFrame(() => logRef.current?.toggleFollow()) },
    jumpToBottom:   () => focused === "log" ? logRef.current?.jumpToBottom() : streamRef.current?.jumpToBottom(),
    focusPrompt:    () => window.requestAnimationFrame(() => goalRef.current?.focus()),
    clearFilter:    () => logRef.current?.clearFilter(),
    abortRun:       abortActive,
    rerunRun:       rerunActive,
    rollbackRun:    rollbackActive,
    exportTrace,
    flagAnswer,
    switchUser: handleSwitchUser,
    switchUi:       handleSwitchUi,
    toggleView,
    openAttach:     openFilePicker,
  }), [busy, activeRunId, pendingInput, focused, abortActive, rerunActive, rollbackActive, exportTrace, flagAnswer, handleSwitchUser, handleSwitchUi, toggleView, openFilePicker])
  commandsRef.current = commands

  // ── Keybinds ── a thin glue layer; everything dispatches through commands.
  const handleKey = useCallback((key: string, ev: KeyboardEvent) => {
    // Esc: close any open modal first, then blur active input.
    if (key === "Escape") {
      if (pickerOpen) { setPickerOpen(false); return true }
      if (paletteOpen) { setPaletteOpen(false); return true }
      const ae = document.activeElement as HTMLElement | null
      if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")) { ae.blur(); return true }
      return false
    }
    // "?" opens the palette (only when not typing in an input).
    if (key === "?") {
      const ae = document.activeElement as HTMLElement | null
      const inField = ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA")
      if (!inField) {
        if (pickerOpen) setPickerOpen(false)
        setPaletteOpen(true); return true
      }
      return false
    }
    // Everything else needs Ctrl.
    if (!isMeta(ev)) return false
    if (key === "k" || key === "K") {
      if (pickerOpen) setPickerOpen(false)
      setPaletteOpen(true); return true
    }

    // Resolve registry-driven keybinds.
    const want = `${ev.ctrlKey ? "Ctrl+" : ""}${key.length === 1 ? key.toUpperCase() : key}`
    for (const cmd of commands) {
      if (cmd.keybind && cmd.keybind === want) {
        // Close any open modal before firing the command action.
        if (pickerOpen) setPickerOpen(false)
        if (paletteOpen) setPaletteOpen(false)
        void cmd.run(); return true
      }
    }
    return false
  }, [commands, pickerOpen, paletteOpen])
  useGlobalKeybinds(handleKey)

  // Auto-focus prompt on first identified mount
  useEffect(() => {
    if (me && !needsWelcome) goalRef.current?.focus()
  }, [me, needsWelcome])

  // Login + intro is one unified flow now — WelcomeFlow handles both.
  if (phase === "loading") {
    return <div style={{ height: "100vh", background: "var(--bg)" }} />
  }

  // Shell — always rendered for login / shell / outro phases.
  // WelcomeFlow overlays on top via createPortal.
  return (
    <>
      <div
        style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)", position: "relative" }}
        onDragEnter={(e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); setDragOver(true) } }}
        onDragOver={(e) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy" } }}
        onDragLeave={(e) => {
          // Only clear when the drag truly leaves the shell (not when crossing into a child).
          if (e.currentTarget === e.target) setDragOver(false)
        }}
        onDrop={(e) => {
          if (!e.dataTransfer?.files || e.dataTransfer.files.length === 0) return
          e.preventDefault()
          setDragOver(false)
          void uploadFiles(Array.from(e.dataTransfer.files))
        }}
      >
          {dragOver ? (
            <div
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 100,
                pointerEvents: "none",
                border: "2px dashed var(--accent)",
                background: "color-mix(in srgb, var(--accent) 8%, transparent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--accent)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--fs-base)",
                letterSpacing: "0.06em",
              }}
            >
              drop to attach &mdash; max 32 MB per file
            </div>
          ) : null}
          <StatusBar
            me={me}
            run={activeRun}
            runs={runs}
            connected={connected}
            onSwitchUser={handleSwitchUser}
            onSwitchUi={handleSwitchUi}
            onOpenPicker={() => setPickerOpen(true)}
            onAbortRun={abortActive}
          />

          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            {viewMode === "visual" ? (
              <VisualPane onAnswer={onAnswer} />
            ) : (
              <div
                style={{ display: "flex", flex: 1, minHeight: 0 }}
                onClickCapture={(e) => {
                  const target = e.target as HTMLElement
                  const inLog = target.closest("[data-pane='log']")
                  setFocused(inLog ? "log" : "stream")
                }}
              >
                <StreamPane
                  ref={streamRef}
                  active={focused === "stream"}
                  rows={transcript}
                  streaming={streaming}
                  goalPlaceholder={activeRun?.goal ?? null}
                  activeRunId={activeRunId}
                  run={activeRun}
                />
                <div data-pane="log" style={{ display: "flex", flex: 1, minWidth: 0 }}>
                  <LogPane
                    ref={logRef}
                    active={focused === "log"}
                    events={events}
                    activeRunId={activeRunId}
                  />
                </div>
              </div>
            )}
          </div>

          {viewMode === "tui" && pendingInput ? (
            <div
              style={{
                borderTop: "1px solid var(--c-audit)",
                background: "rgba(253, 230, 138, 0.08)",
                padding: "8px 14px",
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                flexShrink: 0,
                fontSize: "var(--fs-sm)",
              }}
            >
              <span style={{ color: "var(--c-audit)", fontFamily: "var(--font-mono)", letterSpacing: "0.06em" }}>
                agent asks:
              </span>
              <span style={{ color: "var(--fg)", flex: 1, whiteSpace: "pre-wrap" }}>{pendingInput.question}</span>
              {pendingInput.options && pendingInput.options.length > 0 ? (
                <span style={{ color: "var(--fg-mute)", fontSize: "var(--fs-xs)" }}>
                  options: {pendingInput.options.join(" / ")}
                </span>
              ) : null}
            </div>
          ) : null}

          <AttachmentBar items={pendingAttachments} onRemove={removeAttachment} />

          <GoalInput
            ref={goalRef}
            busy={busy}
            pendingQuestion={pendingInput?.question ?? null}
            onSubmit={onSubmitGoal}
            getSuggestions={(text) => slashSuggestions(text, commandsRef.current)}
          />

          <HelpBar busy={busy} />

          {/* Hidden file input — driven by the /attach slash command and any
              future "+" affordance. Multiple selection is allowed; each file
              is uploaded sequentially through api.uploadAttachment. */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              const list = e.target.files
              if (!list || list.length === 0) return
              const files = Array.from(list)
              // Reset so re-picking the same file fires onChange.
              e.target.value = ""
              void uploadFiles(files)
            }}
          />

          {paletteOpen ? (
            <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />
          ) : null}

          {pickerOpen ? (
            <RunPicker
              runs={runs}
              activeId={activeRunId}
              onSelect={openRun}
              onClose={() => setPickerOpen(false)}
            />
          ) : null}

          {adminOpen ? (
            <AdminLogin
              onClose={() => setAdminOpen(false)}
              onSubmit={async (pw) => {
                const r = await fetch("/api/admin/login", {
                  method: "POST",
                  credentials: "include",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ password: pw }),
                })
                if (!r.ok) {
                  const body = await r.json().catch(() => ({})) as { error?: string }
                  throw new Error(body.error ?? `HTTP ${r.status}`)
                }
                await refresh()
                setAdminOpen(false)
              }}
            />
          ) : null}
        </div>

      {phase === "login" && (
        <WelcomeFlow
          key="login"
          onSubmit={async (n, u) => { await setIdentity(n, u) }}
          onDone={() => setPhase("shell")}
        />
      )}
      {phase === "outro" && (
        <WelcomeFlow
          key="outro"
          mode="outro"
          onSubmit={async () => {}}
          onDone={async () => {
            try { await switchUser() } catch { /* ignore */ }
            setPhase("login")
          }}
        />
      )}
      {phase === "switching" && (
        <WelcomeFlow
          key="switching"
          mode="outro"
          onSubmit={async () => {}}
          onDone={() => {
            try { window.localStorage.setItem("mia:ui-transition", "1") } catch { /* ignore */ }
            setUiShell("classic")
            window.location.assign(urlForShell("classic"))
          }}
        />
      )}
      {phase === "reveal" && (
        <WelcomeFlow
          key="reveal"
          mode="reveal"
          onSubmit={async () => {}}
          onDone={() => setPhase("shell")}
        />
      )}
    </>
  )
}

function HelpBar({ busy }: { busy: boolean }) {
  const item = (k: string, label: string, dim = false) => (
    <span style={{ marginRight: 22, display: "inline-flex", alignItems: "center", opacity: dim ? 0.5 : 1 }}>
      <span style={{
        color: "var(--accent)",
        background: "var(--bg-soft)",
        padding: "3px 9px",
        borderRadius: 4,
        marginRight: 8,
        fontSize: "var(--fs-sm)",
        letterSpacing: "0.02em",
        fontFamily: "var(--font-mono)",
      }}>{k}</span>
      <span style={{ color: "var(--fg-dim)" }}>{label}</span>
    </span>
  )
  return (
    <footer
      style={{
        borderTop: "1px solid var(--divider)",
        padding: "6px 14px",
        fontSize: "var(--fs-sm)",
        color: "var(--fg-mute)",
        userSelect: "none",
        flexShrink: 0,
        background: "var(--bg)",
        display: "flex",
        flexWrap: "wrap",
        rowGap: 4,
      }}
    >
      {item("Ctrl+K", "menu")}
      {item("?", "help")}
      {item("Ctrl+.", "abort run", !busy)}
      {item("Enter", "submit")}
      {item("Esc", "unfocus")}
    </footer>
  )
}
