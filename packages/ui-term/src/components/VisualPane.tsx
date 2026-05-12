/**
 * VisualPane — live visual representation of the agent pipeline.
 *
 * Data source: `transcript` (same TranscriptRow[] that StreamPane uses,
 * already filtered to the active run) + `streamingAnswer` + `runs`.
 * This is intentionally the same data — just displayed as motion graphics
 * instead of text rows.
 *
 * Visual language
 * ───────────────
 * Four vertical wave-gate curves represent
 * the four processing layers:  IN  ·  EXEC  ·  LLM  ·  OUT
 *
 * Ambient particles flow left → right through all four gates as a calm
 * baseline rhythm.  They do NOT represent individual operations.
 *
 * Real operations appear ON TOP as named, coloured particles:
 *
 *   goal         → text anchors top-centre; wave gates brighten slightly
 *   tool         → a labelled node spawns left of the EXEC gate and
 *                  travels toward it; pins there (pulsing) while active
 *   tool-result  → node flashes and crosses the gate; continues to OUT
 *   tool-error   → node turns red and explodes
 *   thinking     → text surfaces centre-screen, fades over ~8 s
 *   answer       → final answer accumulates in a bottom strip
 *   streaming    → live token stream builds in the same strip
 *
 * Metrics: iter / tokens / in-flight tools — bottom-right, ~20 % opacity.
 *
 * ask_user: clean modal over the canvas.  Canvas keeps breathing.
 */

import type { CSSProperties } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { TranscriptRow } from "../store"
import { useStore } from "../store"

// ─────────────────────────────────────────────────────────────────────────────
// Tool category → colour
// ─────────────────────────────────────────────────────────────────────────────

type RGB = readonly [number, number, number]

const CAT_RGB: Record<string, RGB> = {
  db:       [68,  140, 255],
  file:     [68,  210, 140],
  delegate: [175, 100, 255],
  web:      [255, 140,  68],
  search:   [255, 210,  68],
  shell:    [255,  68, 140],
  llm:      [160, 255, 220],
  answer:   [200, 200, 200],
  error:    [255,  80,  80],
  other:    [150, 150, 162],
}

function categorize(name: string): string {
  const n = name.toLowerCase()
  if (/sql|db|query|mssql|database|table|schema|postgres|mongo/.test(n)) return "db"
  if (/file|read|write|path|fs|dir|folder|edit|list_file/.test(n))       return "file"
  if (/delegate|spawn|agent|sub|worker/.test(n))                          return "delegate"
  if (/browser|web|http|fetch|scrape|url|navigate/.test(n))              return "web"
  if (/search|find|grep|rg|ripgrep/.test(n))                             return "search"
  if (/shell|exec|run|bash|cmd|script/.test(n))                          return "shell"
  return "other"
}

// ─────────────────────────────────────────────────────────────────────────────
// Wave gate geometry  (mirrors index4.html shader)
// ─────────────────────────────────────────────────────────────────────────────

const G_CENTER  = [-0.82, -0.28,  0.22,  0.72] as const
const G_PH_MUL  = [0.052,  0.039, 0.061, 0.044] as const
const G_PH_OFS  = [0.000,  1.830, 3.720, 5.110] as const
const G_SIN = [
  [0.20, 2.0, 0.08, 4.7, 2.1],
  [0.12, 5.3, 0.06, 2.9, 0.7],
  [0.18, 3.4, 0.07, 6.1, 1.3],
  [0.14, 4.1, 0.09, 2.3, 1.6],
] as const
const G_LABEL = ["in", "exec", "llm", "out"] as const
const WAVE_AMP = 0.45

function gateXAt(s: number, yn: number, halfW: number, t: number): number {
  const ph = t * G_PH_MUL[s]! + G_PH_OFS[s]!
  const [a1, f1, a2, f2, pm] = G_SIN[s]!
  return halfW + (G_CENTER[s]! + a1 * Math.sin(f1 * yn + ph) + a2 * Math.sin(f2 * yn + ph * pm)) * halfW * WAVE_AMP
}

// ─────────────────────────────────────────────────────────────────────────────
// Ambient particle  (background rhythm only — not data-driven)
// ─────────────────────────────────────────────────────────────────────────────

interface Pt {
  x: number; y: number; spd: number; stage: number
  pinned: boolean; pinnedAt: number; delay: number; rnd: number
}

function spawnPt(cw: number, ch: number): Pt {
  const rnd = Math.random()
  // Particles flow through all four gates: IN (0), EXEC (1), LLM (2), OUT (3).
  const s = Math.floor(Math.random() * 4)
  const approxGateX = (0.5 + G_CENTER[s]! * WAVE_AMP * 0.5) * cw
  return {
    x:        Math.max(2, approxGateX - (0.04 + rnd * 0.18) * cw),
    y:        Math.random() * ch,
    spd:      14 + rnd * 18,
    stage:    s, pinned: false, pinnedAt: 0,
    delay:    600 + rnd * 2600, rnd,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Real operation node  (one per tool call, data-driven)
// ─────────────────────────────────────────────────────────────────────────────

interface OpNode {
  rowId: string
  toolCallId?: string   // for correlating result/error to the right node when parallel
  label: string
  cat: string
  rgb: RGB
  born: number
  y: number
  phase: "approach" | "active" | "complete" | "error"
  doneAt: number
  x: number
  targetX: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Ripple
// ─────────────────────────────────────────────────────────────────────────────

interface Ripple {
  gateIdx: number; yFrac: number; born: number; rgb: RGB; maxR: number
}

// ─────────────────────────────────────────────────────────────────────────────
// All mutable visual state  (ref — never triggers React renders)
// ─────────────────────────────────────────────────────────────────────────────

interface VS {
  t: number; lastMs: number
  pts: Pt[]
  ops: OpNode[]
  ripples: Ripple[]
  thinking: string; thinkAlpha: number; thinkAt: number
  goal: string
  answer: string
  streaming: boolean
  iter: number; tokens: number; toolsActive: number
  status: "" | "running" | "completed" | "failed"
  ingestedIdx: number
  gateHeat: Float32Array
  currentRunId: string
}

function initVS(cw: number, ch: number): VS {
  return {
    t: 0, lastMs: performance.now(),
    pts: Array.from({ length: 160 }, () => spawnPt(cw, ch)),
    ops: [], ripples: [],
    thinking: "", thinkAlpha: 0, thinkAt: 0,
    goal: "", answer: "", streaming: false,
    iter: 0, tokens: 0, toolsActive: 0,
    status: "", ingestedIdx: 0,
    gateHeat: new Float32Array(4),
    currentRunId: "",
  }
}

function heatGate(vs: VS, idx: number, sec: number) {
  vs.gateHeat[idx] = Math.max(vs.gateHeat[idx]!, sec)
}

function spawnRipple(vs: VS, gateIdx: number, yFrac: number, rgb: RGB, maxR = 45) {
  vs.ripples.push({ gateIdx, yFrac, born: performance.now(), rgb, maxR })
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingest a single TranscriptRow into visual state
// ─────────────────────────────────────────────────────────────────────────────

function ingestRow(vs: VS, row: TranscriptRow, cw: number, ch: number) {
  const now = performance.now()
  const halfW = cw * 0.5

  switch (row.kind) {
    case "goal": {
      vs.goal = row.text; vs.status = "running"
      vs.answer = ""; vs.streaming = false
      vs.iter = 0; vs.tokens = 0
      vs.ops = []; vs.thinking = ""; vs.thinkAlpha = 0
      heatGate(vs, 0, 1.2)  // IN gate lights on new goal
      heatGate(vs, 2, 0.8)
      spawnRipple(vs, 0, 0.5, [200, 200, 220], 15)
      break
    }
    case "thinking": {
      vs.thinking   = row.text.length > 180 ? row.text.slice(0, 179) + "…" : row.text
      vs.thinkAlpha = 1; vs.thinkAt = now
      heatGate(vs, 2, 1.8)
      spawnRipple(vs, 2, 0.38 + Math.random() * 0.24, [160, 255, 220], 11)
      break
    }
    case "tool": {
      const label = row.text.split(/\s{2,}/)[0]?.trim() ?? row.text
      const rgb: RGB = [255, 210, 68]  // single yellow for all tool nodes
      const yn    = Math.random() * 1.6 - 0.8
      const gx    = gateXAt(1, yn, halfW, vs.t)
      const y     = ch * 0.5 + yn * ch * 0.5
      vs.ops.push({
        rowId: row.id, toolCallId: row.toolCallId, label, cat: "tool", rgb,
        born: now, y,
        phase: "approach",
        doneAt: 0,
        x:        Math.max(0, gx - cw * 0.28),
        targetX:  gx,
      })
      heatGate(vs, 1, 2.2)
      break
    }
    case "tool-result": {
      // Match by toolCallId (parallel-safe) then fall back to last active node
      const op = (row.toolCallId
        ? vs.ops.slice().reverse().find((n) => n.toolCallId === row.toolCallId && (n.phase === "active" || n.phase === "approach"))
        : undefined
      ) ?? vs.ops.slice().reverse().find((n) => n.phase === "active" || n.phase === "approach")
      if (op) {
        op.phase = "complete"; op.doneAt = now
        spawnRipple(vs, 1, op.y / ch, op.rgb, 10)
        heatGate(vs, 1, 0.8); heatGate(vs, 2, 1.4)
      }
      break
    }
    case "tool-error": {
      const op = (row.toolCallId
        ? vs.ops.slice().reverse().find((n) => n.toolCallId === row.toolCallId && (n.phase === "active" || n.phase === "approach"))
        : undefined
      ) ?? vs.ops.slice().reverse().find((n) => n.phase === "active" || n.phase === "approach")
      if (op) {
        op.phase = "error"; op.doneAt = now
        spawnRipple(vs, 1, op.y / ch, [255, 60, 60], 14)
        heatGate(vs, 2, 0.8)
      }
      break
    }
    // Note: "info" kind is never produced by toTranscriptRow — no case needed.
    case "answer": {
      vs.answer = row.text; vs.streaming = false; vs.status = "completed"
      heatGate(vs, 3, 3.5)
      spawnRipple(vs, 3, 0.5, [200, 200, 200], 18)
      break
    }
    case "error": {
      vs.status = "failed"
      heatGate(vs, 3, 2.0)
      spawnRipple(vs, 3, 0.5, [255, 60, 60], 15)
      break
    }
    case "user-input": {
      heatGate(vs, 3, 1.0)
      break
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

interface Props {
  onAnswer: (text: string) => void
}

export function VisualPane({ onAnswer }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const vsRef     = useRef<VS | null>(null)
  const [answer, setAnswer] = useState("")

  const transcript   = useStore((s) => s.transcript)
  const streaming    = useStore((s) => s.streamingAnswer)
  const runs         = useStore((s) => s.runs)
  const activeRunId  = useStore((s) => s.activeRunId)
  const pendingInput = useStore((s) => s.pendingInput)

  const txRef       = useRef(transcript)
  const streamRef   = useRef(streaming)
  const runsRef     = useRef(runs)
  const activeRef   = useRef(activeRunId)
  txRef.current     = transcript
  streamRef.current = streaming
  runsRef.current   = runs
  activeRef.current = activeRunId

  const events      = useStore((s) => s.events)
  const eventsRef   = useRef(events)
  const evtIdxRef   = useRef(0)
  eventsRef.current = events

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    function resize() {
      const parent = canvas!.parentElement
      if (!parent) return
      const dpr = window.devicePixelRatio || 1
      const w = parent.clientWidth  || window.innerWidth
      const h = parent.clientHeight || window.innerHeight
      canvas!.width  = Math.round(w * dpr)
      canvas!.height = Math.round(h * dpr)
      canvas!.style.width  = w + "px"
      canvas!.style.height = h + "px"
      if (vsRef.current) {
        vsRef.current.pts = Array.from({ length: 160 }, () => spawnPt(w, h))
      }
    }
    resize()
    window.addEventListener("resize", resize)

    if (!vsRef.current) {
      const dpr0 = window.devicePixelRatio || 1
      vsRef.current = initVS(canvas.width / dpr0, canvas.height / dpr0)
      const ar = runsRef.current.find((r) => r.id === activeRef.current)
      if (ar) {
        vsRef.current.goal   = ar.goal
        vsRef.current.iter   = ar.llmCalls
        vsRef.current.tokens = ar.totalTokens
        vsRef.current.status = ar.status === "completed" ? "completed"
                             : ar.status === "failed"    ? "failed"
                             : ar.status === "running"   ? "running" : ""
        const ansRow = txRef.current.slice().reverse().find((r) => r.kind === "answer")
        if (ansRow) vsRef.current.answer = ansRow.text
      }
      vsRef.current.ingestedIdx = txRef.current.length
      evtIdxRef.current = eventsRef.current.length
    }

    let raf: number

    function tick() {
      raf = requestAnimationFrame(tick)
      if (!vsRef.current) return
      const dprLocal = window.devicePixelRatio || 1
      const cw = canvas!.width / dprLocal, ch = canvas!.height / dprLocal
      const vs = vsRef.current
      const now = performance.now()
      const dt  = Math.min((now - vs.lastMs) / 1000, 0.05)
      vs.lastMs = now; vs.t += dt

      // Detect run change — reset ingestion pointer when activeRunId changes
      const tx = txRef.current
      const nowRid = activeRef.current ?? ""
      if (nowRid !== vs.currentRunId) {
        vs.currentRunId = nowRid
        vs.ingestedIdx = 0
      } else if (tx.length < vs.ingestedIdx) {
        vs.ingestedIdx = 0  // safety: transcript was reset
      }

      // Ingest new transcript rows
      while (vs.ingestedIdx < tx.length) {
        ingestRow(vs, tx[vs.ingestedIdx]!, cw, ch)
        vs.ingestedIdx++
      }

      // Ingest debug.trace events for iter/token counts + LLM gate flashes
      const evts = eventsRef.current
      while (evtIdxRef.current < evts.length) {
        const e   = evts[evtIdxRef.current]!
        const aid = activeRef.current
        const rid = String(e.data["runId"] ?? "")
        if (e.type === "debug.trace" && (!aid || rid === aid)) {
          const entry = e.data["entry"] as Record<string, unknown> | undefined
          const kind  = entry?.["kind"] as string | undefined
          if (entry && kind === "iteration") {
            vs.iter = (entry["current"] as number | undefined) ?? vs.iter
          }
          if (entry && (kind === "llm-response" || kind === "usage")) {
            const u = (kind === "llm-response" ? entry["usage"] : entry) as { totalTokens?: number } | undefined
            if (u?.totalTokens) vs.tokens = u.totalTokens
            heatGate(vs, 2, 1.8)
            spawnRipple(vs, 2, 0.38 + Math.random() * 0.24, CAT_RGB.llm!, 11)
          }
          if (entry && kind === "llm-request") {
            const iter = entry["iteration"] as number | undefined
            if (iter != null) vs.iter = iter
            heatGate(vs, 2, 1.2)
          }
        }
        evtIdxRef.current++
      }

      // Streaming answer
      const s = streamRef.current
      if (s && s !== vs.answer) {
        vs.answer = s; vs.streaming = true
        heatGate(vs, 3, 0.4)
      } else if (!s && vs.streaming && vs.status === "completed") {
        vs.streaming = false
      }

      vs.toolsActive = vs.ops.filter((n) => n.phase === "approach" || n.phase === "active").length

      // Decay gate heat
      for (let i = 0; i < 4; i++) vs.gateHeat[i] = Math.max(0, vs.gateHeat[i]! - dt)

      // Thinking fade
      if (vs.thinkAlpha > 0) {
        const elapsed = (now - vs.thinkAt) / 1000
        if (elapsed > 6) vs.thinkAlpha = Math.max(0, vs.thinkAlpha - dt * 0.14)
      }

      // Advance ambient particles
      const halfW = cw * 0.5
      for (const p of vs.pts) {
        if (p.pinned) {
          if (now - p.pinnedAt > p.delay) { p.pinned = false; p.stage = p.stage < 3 ? p.stage + 1 : 4 }
          else if (p.stage < 4) { const yn = p.y / ch * 2 - 1; p.x = gateXAt(p.stage, yn, halfW, vs.t) - 0.5 }
          continue
        }
        p.x += p.spd * dt
        if (p.stage >= 4) {
          if (p.x > cw + 10) Object.assign(p, spawnPt(cw, ch))
        } else {
          const yn = p.y / ch * 2 - 1
          const gx = gateXAt(p.stage, yn, halfW, vs.t)
          if (p.x >= gx) { p.x = gx - 0.5; p.pinned = true; p.pinnedAt = now }
        }
      }

      // Advance op nodes
      for (const op of vs.ops) {
        if (op.phase === "approach") {
          const yn = op.y / ch * 2 - 1
          op.targetX = gateXAt(1, yn, halfW, vs.t)
          op.x      += (op.targetX - 10 - op.x) * Math.min(dt * 8.0, 1)  // fast snap
          if (op.x >= op.targetX - 11) op.phase = "active"
        } else if (op.phase === "active") {
          const yn = op.y / ch * 2 - 1
          op.x = gateXAt(1, yn, halfW, vs.t) - 2  // pinned at gate
        } else if (op.phase === "complete") {
          op.x += 22 * dt  // ambient speed — flows through LLM, OUT and off-screen
        } else if (op.phase === "error") {
          op.x += 60 * dt
        }
      }

      vs.ops     = vs.ops.filter((n) =>
        n.phase === "approach" || n.phase === "active" ||
        (n.phase === "complete" && n.x < cw + 20) ||
        (n.phase === "error" && (now - n.doneAt) < 1500)
      )
      vs.ripples = vs.ripples.filter((r) => (now - r.born) < 1600)

      ctx!.save()
      ctx!.scale(dprLocal, dprLocal)
      drawFrame(ctx!, cw, ch, vs, now)
      ctx!.restore()
    }

    tick()
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", resize) }
  }, [])

  const submitAnswer = useCallback(() => {
    const t = answer.trim()
    if (!t) return
    onAnswer(t); setAnswer("")
  }, [answer, onAnswer])

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, background: "#010203", overflow: "hidden" }}>
      <canvas
        ref={canvasRef}
        style={{ display: "block", position: "absolute", inset: 0 }}
      />

      {pendingInput && (
        <div style={ST_MODAL_BACKDROP}>
          <div style={ST_MODAL_BOX}>
            <div style={ST_MODAL_EYEBROW}>
              agent<span style={{ color: "rgba(160,255,220,.5)" }}>/</span>question
            </div>
            <div style={{ fontSize: 18, fontWeight: 300, color: "#fff", lineHeight: 1.6, marginBottom: 8 }}>
              {pendingInput.question}
            </div>
            {pendingInput.options && pendingInput.options.length > 0 && (
              <div style={{ fontSize: 9, letterSpacing: ".28em", color: "rgba(255,255,255,.22)",
                marginBottom: 32, textTransform: "uppercase", fontFamily: MONO }}>
                {pendingInput.options.join("  ·  ")}
              </div>
            )}
            {(!pendingInput.options || pendingInput.options.length === 0) && <div style={{ marginBottom: 32 }} />}
            <input
              autoFocus
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submitAnswer(); e.stopPropagation() }}
              style={ST_MODAL_INPUT}
              type={pendingInput.sensitive ? "password" : "text"}
              placeholder="—"
              autoComplete="off"
              spellCheck={false}
            />
            <div style={{ marginTop: 24, display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 22 }}>
              <span style={{ fontSize: 7, letterSpacing: ".55em", color: "rgba(255,255,255,.1)",
                textTransform: "uppercase", fontFamily: MONO }}>enter</span>
              <button onClick={submitAnswer} style={ST_MODAL_BTN}>send →</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const MONO = `ui-monospace,'Cascadia Code','JetBrains Mono','SF Mono',monospace`

const ST_MODAL_BACKDROP: CSSProperties = {
  position: "absolute", inset: 0,
  display: "flex", alignItems: "center", justifyContent: "center",
  background: "rgba(0,0,0,.72)", backdropFilter: "blur(6px)", zIndex: 50,
}
const ST_MODAL_BOX: CSSProperties = {
  width: "min(440px, 88vw)", padding: "48px 46px 42px",
  background: "rgba(1,2,4,.98)", border: "1px solid rgba(255,255,255,.06)",
  fontFamily: MONO,
}
const ST_MODAL_EYEBROW: CSSProperties = {
  fontSize: 7.5, letterSpacing: ".5em", color: "rgba(255,255,255,.15)",
  marginBottom: 24, textTransform: "uppercase",
}
const ST_MODAL_INPUT: CSSProperties = {
  display: "block", width: "100%", background: "none", border: "none",
  borderBottom: "1px solid rgba(255,255,255,.12)", outline: "none",
  padding: "8px 0", fontFamily: MONO, fontSize: 14,
  letterSpacing: ".05em", color: "#fff", caretColor: "#a0ffdc",
}
const ST_MODAL_BTN: CSSProperties = {
  background: "none", border: "none", cursor: "pointer",
  fontFamily: MONO, fontSize: 8.5, letterSpacing: ".45em",
  textTransform: "uppercase", color: "rgba(255,255,255,.30)", padding: "8px 0",
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas draw — called every frame
// ─────────────────────────────────────────────────────────────────────────────

const FONT = `"JetBrains Mono","Fira Code","IBM Plex Mono","Consolas","Menlo",monospace`

// ─────────────────────────────────────────────────────────────────────────────
// Answer text pre-processing
// ─────────────────────────────────────────────────────────────────────────────

/** Strip markdown inline syntax so it doesn't render literally on canvas. */
function stripMd(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")   // **bold**
    .replace(/\*([^*]+)\*/g, "$1")        // *italic*
    .replace(/__([^_]+)__/g, "$1")        // __bold__
    .replace(/_([^_]+)_/g, "$1")          // _italic_
    .replace(/`([^`]+)`/g, "$1")          // `code`
    .replace(/~~([^~]+)~~/g, "$1")        // ~~strike~~
    .replace(/^#{1,6}\s+/, "")            // # headings (strip #)
    .trim()
}

/**
 * Convert an answer string into canvas-ready display lines.
 * Respects hard newlines, formats markdown tables as "col · col",
 * strips markdown syntax, word-wraps to maxW pixels.
 */
function formatAnswer(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string[] {
  const out: string[] = []

  function wordWrap(str: string) {
    if (!str) return
    const words = str.split(" ")
    let line = ""
    for (const w of words) {
      if (!w) continue
      const test = line ? `${line} ${w}` : w
      if (ctx.measureText(test).width > maxW) { if (line) out.push(line); line = w } else line = test
    }
    if (line) out.push(line)
  }

  const rawLines = text.split("\n")
  let blankPending = false

  for (const raw of rawLines) {
    const trimmed = raw.trim()

    // Skip pure separator lines (---|---, ===, or |--|--|)
    if (trimmed && /^[\s|:=-]+$/.test(trimmed)) continue

    if (!trimmed) {
      blankPending = true
      continue
    }

    // Insert at most one blank between paragraphs (but not before the first line)
    if (blankPending && out.length > 0) out.push("")
    blankPending = false

    // Markdown table row: | col | col | ...
    if (trimmed.startsWith("|")) {
      const cols = trimmed
        .split("|")
        .map((c) => stripMd(c))
        .filter((c) => c.length > 0)
      if (cols.length >= 2) {
        // Two-col tables: "  name  ·  value" — clean key/value style
        const joined = cols.length === 2
          ? `  ${cols[0]}  ·  ${cols[1]}`
          : `  ${cols.join("  ·  ")}`
        wordWrap(joined)
        continue
      }
    }

    // List item: - text or * text
    if (/^[-*]\s+/.test(trimmed)) {
      wordWrap("· " + stripMd(trimmed.replace(/^[-*]\s+/, "")))
      continue
    }

    // Numbered list: 1. text
    if (/^\d+\.\s+/.test(trimmed)) {
      const m = trimmed.match(/^(\d+)\.\s+(.*)$/)
      if (m) wordWrap(`${m[1]}. ${stripMd(m[2]!)}`)
      continue
    }

    // Regular paragraph
    wordWrap(stripMd(trimmed))
  }

  // Remove leading/trailing blank lines
  while (out.length > 0 && out[0] === "") out.shift()
  while (out.length > 0 && out[out.length - 1] === "") out.pop()

  return out
}

function clipText(ctx: CanvasRenderingContext2D, text: string, maxPx: number): string {
  if (ctx.measureText(text).width <= maxPx) return text
  let lo = 0, hi = text.length
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxPx) lo = mid; else hi = mid
  }
  return text.slice(0, lo) + "…"
}

function drawFrame(ctx: CanvasRenderingContext2D, cw: number, ch: number, vs: VS, now: number) {
  const halfW    = cw * 0.5
  // hasOutput: anything to show in the output block (answer text OR a terminal status)
  const hasOutput = !!(vs.answer || vs.streaming || vs.status === "completed" || vs.status === "failed")

  // Background
  ctx.fillStyle = "#010203"
  ctx.fillRect(0, 0, cw, ch)

  // Subtle scanline
  ctx.fillStyle = "rgba(0,0,0,.05)"
  for (let y = 0; y < ch; y += 4) ctx.fillRect(0, y, cw, 1)

  // ── Gate curves — clearly visible, brighter when active ──────────────────
  for (let s = 0; s < 4; s++) {
    const heat  = vs.gateHeat[s]!

    const base  = s === 1 || s === 2 ? 0.32 : 0.26
    const alpha = Math.min(base + heat * 0.40, 0.85)

    ctx.beginPath()
    for (let j = 0; j <= 120; j++) {
      const yn = j / 120 * 2 - 1
      const x  = gateXAt(s, yn, halfW, vs.t)
      const y  = j / 120 * ch
      j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    }
    // LLM gate gets a hint of cyan when hot
    if (s === 2 && heat > 0.5) {
      ctx.strokeStyle = `rgba(160,255,220,${alpha.toFixed(3)})`
    } else {
      ctx.strokeStyle = `rgba(255,255,255,${alpha.toFixed(3)})`
    }
    ctx.lineWidth = heat > 0.5 ? 1.5 : 1; ctx.stroke()

    // Gate label
    const lx    = gateXAt(s, -0.92, halfW, vs.t)
    const heatN = Math.min(heat / 1.5, 1)
    const lBase = 0.48
    const lA    = lBase + heatN * 0.45
    ctx.font = `500 13px ${FONT}`; ctx.textAlign = "center"
    ctx.fillStyle = s === 2 ? `rgba(160,255,220,${lA.toFixed(3)})` : `rgba(255,255,255,${lA.toFixed(3)})`
    const cnt = vs.ops.filter((n) => n.phase === "approach" || n.phase === "active").length
    ctx.fillText(((s === 1 && cnt > 0) ? `${G_LABEL[s]}  ${cnt}` : G_LABEL[s]).toUpperCase(), lx, 22)
  }

  // ── Ripples ───────────────────────────────────────────────────────────────
  for (const rp of vs.ripples) {
    const age = (now - rp.born) / 1600
    if (age >= 1) continue
    const ease = 1 - age * age
    const a    = ease * ease * 0.42
    const gx   = gateXAt(rp.gateIdx, rp.yFrac * 2 - 1, halfW, vs.t)
    const gy   = rp.yFrac * ch
    ctx.beginPath(); ctx.arc(gx, gy, 4 + age * rp.maxR, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(${rp.rgb[0]},${rp.rgb[1]},${rp.rgb[2]},${a.toFixed(3)})`
    ctx.lineWidth = 1.5; ctx.stroke()
  }

  // ── Ambient particles — neutral white, background texture only ─────────────
  for (const p of vs.pts) {
    ctx.beginPath(); ctx.arc(p.x, p.y, p.pinned ? 1.0 : 1.3, 0, Math.PI * 2)
    ctx.fillStyle = p.pinned ? "rgba(255,255,255,.18)" : "rgba(255,255,255,.38)"
    ctx.fill()
  }

  // ── Op nodes (real tool calls) ────────────────────────────────────────────
  // Approach: bright labelled dot moving toward gate
  // Approach: yellow dot + label flying fast toward EXEC gate
  // Active:   yellow dot + label pinned at EXEC gate until done
  // Complete: morphs to small white ambient dot, flows through LLM→OUT→off-screen
  // Error:    expands red and fades
  ctx.save()
  for (const op of vs.ops) {
    const ageMs = now - op.born
    const [r, g, b] = op.rgb
    let alpha = 1, radius = 2.5
    let drawR = r, drawG = g, drawB = b

    if (op.phase === "approach") {
      alpha = 1.0; radius = 2.5
    } else if (op.phase === "active") {
      alpha = 1.0; radius = 2.5
    } else if (op.phase === "complete") {
      // Morph to white ambient dot — no fade until off-screen
      drawR = 255; drawG = 255; drawB = 255
      alpha = 0.42; radius = 1.3
    } else if (op.phase === "error") {
      const age = (now - op.doneAt) / 1500
      alpha = Math.max(0, 1 - age); radius = 4 + age * 5
      drawR = 255; drawG = 60; drawB = 60
    }
    if (alpha < 0.02) continue

    ctx.beginPath(); ctx.arc(op.x, op.y, radius, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${drawR},${drawG},${drawB},${alpha.toFixed(3)})`
    ctx.fill()

    // Label during approach and active only
    if (op.phase === "approach" || op.phase === "active") {
      ctx.font = `500 13px ${FONT}`; ctx.textAlign = "left"
      ctx.fillStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`
      const text = clipText(ctx, op.label, cw - op.x - 28)
      ctx.fillText(text, op.x + radius + 10, op.y + 4)
    }
  }
  ctx.restore()

  // ── Thinking text — centred, clear ───────────────────────────────────────
  if (vs.thinkAlpha > 0.02 && vs.thinking) {
    const words = vs.thinking.split(" ")
    const lines: string[] = []
    let line = ""
    ctx.font = `400 13px ${FONT}`
    for (const w of words) {
      const test = line ? `${line} ${w}` : w
      if (ctx.measureText(test).width > cw * 0.62) { if (line) lines.push(line); line = w } else line = test
    }
    if (line) lines.push(line)
    const lh = 22; const startY = ch * 0.40 - (lines.length * lh) / 2
    ctx.textAlign = "center"
    lines.forEach((l, i) => {
      const a = Math.max(0, vs.thinkAlpha * (1 - i * 0.04) * 0.60)
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`
      ctx.fillText(l, cw * 0.5, startY + i * lh)
    })
  }

  // ── Terminal-style output — packed at bottom, no empty space ──────────────────
  // Renders from bottom up: answer lines → status → "> goal" prompt.
  // Veil is proportional — only as tall as content needs, max 40% of screen.
  if (vs.goal || hasOutput) {
    const PAD_X   = 40
    const PAD_B   = 24    // gap from canvas bottom
    const LH      = 22    // line height
    const FONT_SZ = "13px"

    // Format answer: respect newlines, strip markdown, wrap to canvas width
    const aLines: string[] = []
    if (hasOutput && vs.answer) {
      ctx.font = `${FONT_SZ} ${FONT}`
      const maxW = cw - PAD_X * 2
      aLines.push(...formatAnswer(ctx, vs.answer, maxW))
    }
    const MAXLINES = Math.max(1, Math.floor(ch * 0.40 / LH))
    const visible  = vs.streaming ? aLines.slice(0, MAXLINES) : aLines.slice(-MAXLINES)

    // Measure how tall the output block will be
    let blockH = PAD_B
    blockH += visible.length * LH          // answer lines
    if (hasOutput) blockH += LH * 1.5      // status/streaming indicator
    blockH += LH * 1.3                     // prompt line
    blockH += 48                           // veil fade-in headroom

    // Gradient veil — lightweight, proportional to content
    const veilTop = Math.max(ch - Math.min(blockH, ch * 0.45), ch * 0.55)
    const veil = ctx.createLinearGradient(0, veilTop, 0, ch)
    veil.addColorStop(0, "rgba(1,2,3,0)")
    veil.addColorStop(1, "rgba(1,2,3,0.68)")
    ctx.fillStyle = veil; ctx.fillRect(0, veilTop, cw, ch - veilTop)

    ctx.save()
    ctx.shadowColor = "rgba(0,0,0,0.92)"; ctx.shadowBlur = 5
    ctx.textAlign = "left"
    let curY = ch - PAD_B

    // Answer lines — bottom-most
    ctx.font = `${FONT_SZ} ${FONT}`
    for (let i = visible.length - 1; i >= 0; i--) {
      const isLast = vs.streaming && i === visible.length - 1
      if (visible[i] === "") {
        // blank paragraph separator — half-height gap
        curY -= Math.round(LH * 0.45)
        continue
      }
      const cursor = isLast && (now / 500 | 0) % 2 === 0 ? "▋" : ""
      ctx.fillStyle = "rgba(255,255,255,0.88)"
      ctx.fillText(visible[i]! + cursor, PAD_X, curY)
      curY -= LH
    }

    // Status / streaming indicator
    if (hasOutput) {
      if (vs.status === "completed") {
        ctx.font = `700 13px ${FONT}`
        ctx.fillStyle = "rgba(160,255,220,0.82)"
        ctx.fillText("DONE", PAD_X, curY)
      } else if (vs.status === "failed") {
        ctx.font = `700 13px ${FONT}`
        ctx.fillStyle = "rgba(255,80,80,0.82)"
        ctx.fillText("FAILED", PAD_X, curY)
      } else if (vs.streaming) {
        const blink = 0.42 + 0.28 * Math.sin(now / 380)
        ctx.font = `500 13px ${FONT}`
        ctx.fillStyle = `rgba(160,255,220,${blink.toFixed(3)})`
        ctx.fillText("▸", PAD_X, curY)
      }
      curY -= Math.round(LH * 1.5)
    }

    // "> goal" prompt line
    if (vs.goal) {
      ctx.font = `${FONT_SZ} ${FONT}`
      const prefix = "> "
      const prefW  = ctx.measureText(prefix).width
      const goalStr = clipText(ctx, vs.goal, cw - PAD_X * 2 - prefW)
      ctx.fillStyle = "rgba(160,255,220,0.52)"
      ctx.fillText(prefix, PAD_X, curY)
      ctx.fillStyle = "rgba(255,255,255,0.48)"
      ctx.fillText(goalStr, PAD_X + prefW, curY)
    }

    ctx.restore()
  }

  // ── Metrics — top-right, away from output zone ──────────────────────────
  ctx.save()
  ctx.textAlign = "right"
  ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 4
  const mPad = 24
  let mY = 22
  ctx.font = `500 13px ${FONT}`
  if (vs.iter > 0) {
    ctx.fillStyle = "rgba(160,255,220,.72)"
    ctx.fillText(`ITER  ${vs.iter}`, cw - mPad, mY); mY += 18
  }
  if (vs.tokens > 0) {
    ctx.fillStyle = "rgba(255,255,255,.52)"
    ctx.fillText(`${(vs.tokens / 1000).toFixed(1)}k  tok`, cw - mPad, mY); mY += 18
  }
  if (vs.toolsActive > 0) {
    ctx.fillStyle = "rgba(255,255,255,.38)"
    ctx.fillText(`${vs.toolsActive}  tool${vs.toolsActive > 1 ? "s" : ""}  active`, cw - mPad, mY)
  }
  ctx.restore()

}
// (status badge removed — DONE/FAILED are always rendered inside the terminal block)
