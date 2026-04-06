/**
 * CodeSeqDiagram — Source-Code-Level Sequence Diagram
 *
 * A detailed UML sequence diagram showing the actual function-to-function
 * call chains in the agent001 codebase. Unlike UniverseViz (which shows
 * runtime WS events), this maps the static architecture: which source
 * code module calls what, with exact function names and file paths.
 *
 * Lifelines represent source modules (files/classes). Messages show
 * the actual function calls with their signatures. The diagram covers
 * the full run lifecycle from HTTP request → orchestrator → agent →
 * LLM → tools → memory → DB → WS broadcast.
 */

import type { JSX } from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useStore } from "../store"
import type { TraceEntry } from "../types"

// ── Palette ──────────────────────────────────────────────────────

const P = {
  http:    "#4DD0E1",
  router:  "#5B98D1",
  orch:    "#7B6FC7",
  prompt:  "#9575CD",
  agent:   "#E09145",
  llm:     "#D17877",
  tools:   "#5DB078",
  govern:  "#D4A64A",
  effects: "#AB7DDB",
  memory:  "#4DB6AC",
  db:      "#6B8E9B",
  ws:      "#E05252",
  queue:   "#8D6E63",
  delegate:"#5B98D1",
  audit:   "#78909C",
  text:    "#a1a1aa",
  dim:     "#3f3f46",
  dimmer:  "#27272a",
  bg:      "#09090b",
  arrow:   "#71717a",
  self:    "#52525b",
  note:    "#1c1c20",
  noteB:   "#2a2a30",
  accent:  "#7B6FC7",
}

// ── Lifeline definitions ─────────────────────────────────────────

interface Lifeline {
  id: string
  label: string
  file: string
  color: string
}

const LIFELINES: Lifeline[] = [
  { id: "http",     label: "HTTP API",       file: "routes/runs.ts",      color: P.http },
  { id: "queue",    label: "Queue",          file: "queue.ts",            color: P.queue },
  { id: "orch",     label: "Orchestrator",   file: "orchestrator.ts",     color: P.orch },
  { id: "prompt",   label: "PromptBuilder",  file: "prompt-builder.ts",   color: P.prompt },
  { id: "memory",   label: "Memory",         file: "memory.ts",           color: P.memory },
  { id: "agent",    label: "Agent Loop",     file: "agent.ts",            color: P.agent },
  { id: "llm",      label: "LLM Client",     file: "copilot.ts",          color: P.llm },
  { id: "tools",    label: "Tool Exec",      file: "tools/*.ts",          color: P.tools },
  { id: "govern",   label: "Governance",     file: "governance.ts",       color: P.govern },
  { id: "effects",  label: "Effects",        file: "effects.ts",          color: P.effects },
  { id: "delegate", label: "Delegate",       file: "delegate.ts",         color: P.delegate },
  { id: "db",       label: "SQLite",         file: "db/*.ts",             color: P.db },
  { id: "ws",       label: "WS Broadcast",   file: "ws.ts",              color: P.ws },
  { id: "audit",    label: "Audit",          file: "audit.ts",            color: P.audit },
]

// ── Message types ────────────────────────────────────────────────

type MsgKind = "call" | "return" | "self" | "note" | "alt-start" | "alt-else" | "alt-end"

interface Msg {
  kind: MsgKind
  from: string            // lifeline id
  to: string              // lifeline id (same for self)
  label: string           // function name / description
  detail?: string         // file:line, params, etc.
  color?: string          // override arrow color
  dashed?: boolean        // return arrows
  phase?: string          // for grouping/phases
  altLabel?: string       // for alt fragments
}

// ── The full call-chain specification ────────────────────────────

function buildMessages(showPhase: Set<string>): Msg[] {
  const msgs: Msg[] = []
  const add = (m: Msg) => {
    // Notes (phase headers) are always visible — they serve as toggle controls
    if (m.kind === "note") { msgs.push(m); return }
    if (m.phase && !showPhase.has(m.phase)) return
    msgs.push(m)
  }

  // ─────────────────────────────────────────
  // PHASE 1: Request Entry
  // ─────────────────────────────────────────
  add({ kind: "note", from: "http", to: "http", label: "── Phase 1: Request Entry ──", phase: "entry" })

  add({ kind: "self", from: "http", to: "http", label: "POST /api/runs", detail: "routes/runs.ts:76 → { goal, agentId? }", phase: "entry" })
  add({ kind: "call", from: "http", to: "db", label: "getAgentDefinition(agentId)", detail: "db/agents.ts → DbAgentDefinition", phase: "entry" })
  add({ kind: "return", from: "db", to: "http", label: "{ id, name, system_prompt, tools }", dashed: true, phase: "entry" })
  add({ kind: "call", from: "http", to: "tools", label: "resolveTools(toolNames)", detail: "tools.ts:47 → Tool[]", phase: "entry" })
  add({ kind: "return", from: "tools", to: "http", label: "Tool[]", dashed: true, phase: "entry" })
  add({ kind: "call", from: "http", to: "orch", label: "startRun(goal, config)", detail: "orchestrator.ts:120 → runId", phase: "entry" })
  add({ kind: "self", from: "orch", to: "orch", label: "new AbortController()", detail: "create run signal", phase: "entry" })
  add({ kind: "call", from: "orch", to: "db", label: "loadPolicyRules()", detail: "db/policy.ts → PolicyRule[]", phase: "entry" })
  add({ kind: "return", from: "db", to: "orch", label: "PolicyRule[]", dashed: true, phase: "entry" })
  add({ kind: "call", from: "orch", to: "ws", label: "broadcast('run.queued')", detail: "ws.ts:45 → clients", phase: "entry" })
  add({ kind: "return", from: "orch", to: "http", label: "runId (UUID)", dashed: true, phase: "entry" })

  // ─────────────────────────────────────────
  // PHASE 2: Queue & Initialization
  // ─────────────────────────────────────────
  add({ kind: "note", from: "http", to: "http", label: "── Phase 2: Queue & Init ──", phase: "init" })

  add({ kind: "self", from: "orch", to: "orch", label: "queueMicrotask(executeRun)", detail: "orchestrator.ts:389 — async", phase: "init" })
  add({ kind: "call", from: "orch", to: "queue", label: "acquire(runId, priority, signal)", detail: "queue.ts → await slot", phase: "init" })
  add({ kind: "return", from: "queue", to: "orch", label: "{ releaseSlot }", dashed: true, phase: "init" })
  add({ kind: "call", from: "orch", to: "db", label: "persistRun(run, 'running')", detail: "db/runs.ts → INSERT runs", phase: "init" })
  add({ kind: "call", from: "orch", to: "ws", label: "broadcast('run.started')", detail: "ws.ts:45", phase: "init" })

  // Tool wrapping chain
  add({ kind: "note", from: "orch", to: "orch", label: "── Tool Wrapping Pipeline ──", phase: "init" })
  add({ kind: "call", from: "orch", to: "effects", label: "wrapWithEffects(tool, runId)", detail: "orchestrator.ts:1075 → TrackedTool", phase: "init" })
  add({ kind: "return", from: "effects", to: "orch", label: "TrackedTool (snapshot on write)", dashed: true, phase: "init" })
  add({ kind: "call", from: "orch", to: "govern", label: "governTool(tool, services)", detail: "governance.ts → GovernedTool", phase: "init" })
  add({ kind: "return", from: "govern", to: "orch", label: "GovernedTool (pre/post hooks)", dashed: true, phase: "init" })
  add({ kind: "call", from: "orch", to: "delegate", label: "createDelegateTools(ctx)", detail: "delegate.ts → [delegate, delegate_parallel]", phase: "init" })
  add({ kind: "return", from: "delegate", to: "orch", label: "Tool[] (delegateTool, delegateParallelTool)", dashed: true, phase: "init" })

  // ─────────────────────────────────────────
  // PHASE 3: System Prompt Assembly
  // ─────────────────────────────────────────
  add({ kind: "note", from: "http", to: "http", label: "── Phase 3: Prompt Assembly ──", phase: "prompt" })

  add({ kind: "call", from: "orch", to: "prompt", label: "buildEnvironmentContext()", detail: "prompt-builder.ts → OS, shell, node", phase: "prompt" })
  add({ kind: "return", from: "prompt", to: "orch", label: "envContext string", dashed: true, phase: "prompt" })
  add({ kind: "call", from: "orch", to: "prompt", label: "buildToolContext(allTools)", detail: "prompt-builder.ts → tool descriptions", phase: "prompt" })
  add({ kind: "return", from: "prompt", to: "orch", label: "toolContext string", dashed: true, phase: "prompt" })
  add({ kind: "call", from: "orch", to: "prompt", label: "getWorkspaceContext(ws)", detail: "prompt-builder.ts → shallow dir tree", phase: "prompt" })
  add({ kind: "return", from: "prompt", to: "orch", label: "workspaceContext string", dashed: true, phase: "prompt" })

  // Memory retrieval
  add({ kind: "call", from: "orch", to: "memory", label: "retrieveContext(goal, opts)", detail: "memory.ts:653 — async, 3-tier search", color: P.memory, phase: "prompt" })
  add({ kind: "call", from: "memory", to: "db", label: "FTS5 query working tier", detail: "memory_entries_fts (34% budget)", phase: "prompt" })
  add({ kind: "return", from: "db", to: "memory", label: "working results[]", dashed: true, phase: "prompt" })
  add({ kind: "call", from: "memory", to: "db", label: "FTS5 query episodic tier", detail: "memory_entries_fts (22% budget)", phase: "prompt" })
  add({ kind: "return", from: "db", to: "memory", label: "episodic results[]", dashed: true, phase: "prompt" })
  add({ kind: "call", from: "memory", to: "db", label: "FTS5 query semantic tier", detail: "memory_entries_fts (44% budget)", phase: "prompt" })
  add({ kind: "return", from: "db", to: "memory", label: "semantic results[]", dashed: true, phase: "prompt" })
  add({ kind: "self", from: "memory", to: "memory", label: "score + dedup + pack", detail: "BM25 × confidence × activation", phase: "prompt" })
  add({ kind: "call", from: "memory", to: "db", label: "searchProcedures(goal, 3)", detail: "procedural_memories FTS", phase: "prompt" })
  add({ kind: "return", from: "db", to: "memory", label: "ProceduralMemory[]", dashed: true, phase: "prompt" })
  add({ kind: "call", from: "memory", to: "db", label: "UPDATE access_count + 1", detail: "bump retrieved entries", phase: "prompt" })
  add({ kind: "call", from: "memory", to: "ws", label: "broadcast('memory.retrieved')", detail: "ws.ts:45", phase: "prompt" })
  add({ kind: "return", from: "memory", to: "orch", label: "{ perTier: { working, episodic, semantic } }", dashed: true, color: P.memory, phase: "prompt" })

  add({ kind: "self", from: "orch", to: "orch", label: "assemble systemMessages[]", detail: "6 sections: anchor, runtime, tools, ws, memory×3", phase: "prompt" })

  // ─────────────────────────────────────────
  // PHASE 4: Agent Loop
  // ─────────────────────────────────────────
  add({ kind: "note", from: "http", to: "http", label: "── Phase 4: Agent Loop ──", phase: "agent" })

  add({ kind: "call", from: "orch", to: "agent", label: "new Agent(llm, tools, config)", detail: "agent.ts:227 — constructor", phase: "agent" })
  add({ kind: "call", from: "orch", to: "agent", label: "agent.run(goal)", detail: "agent.ts:260 — async, main loop entry", color: P.agent, phase: "agent" })

  // Iteration loop
  add({ kind: "alt-start", from: "agent", to: "agent", label: "loop [i = 0..maxIterations]", altLabel: "Agent Think-Act-Observe Loop", phase: "agent" })

  add({ kind: "self", from: "agent", to: "agent", label: "truncateMessages(messages)", detail: "agent.ts:74 — 64K token budget", phase: "agent" })

  // LLM call
  add({ kind: "call", from: "agent", to: "llm", label: "llm.chat(messages, tools, { signal })", detail: "copilot.ts:35 — async fetch", color: P.llm, phase: "agent" })
  add({ kind: "self", from: "llm", to: "llm", label: "formatMessages() + formatTools()", detail: "OpenAI-compatible format", phase: "agent" })
  add({ kind: "self", from: "llm", to: "llm", label: "resolveToken()", detail: "GITHUB_TOKEN or gh auth token", phase: "agent" })
  add({ kind: "self", from: "llm", to: "llm", label: "fetch(models.inference.ai.azure.com)", detail: "POST /chat/completions", phase: "agent" })
  add({ kind: "return", from: "llm", to: "agent", label: "{ content, toolCalls[], usage }", dashed: true, color: P.llm, phase: "agent" })

  add({ kind: "self", from: "agent", to: "agent", label: "accumulate usage tokens", detail: "prompt + completion + total", phase: "agent" })
  add({ kind: "call", from: "agent", to: "orch", label: "onThinking(content, toolCalls, i)", detail: "callback → orchestrator", phase: "agent" })
  add({ kind: "call", from: "orch", to: "db", label: "saveTrace(runId, { kind: 'thinking' })", detail: "db/runs.ts → trace_entries", phase: "agent" })
  add({ kind: "call", from: "orch", to: "ws", label: "broadcast('agent.thinking')", detail: "ws.ts:45", phase: "agent" })

  // Tool execution branch
  add({ kind: "alt-start", from: "agent", to: "agent", label: "alt [toolCalls.length > 0]", altLabel: "Tool Execution", phase: "agent" })

  add({ kind: "self", from: "agent", to: "agent", label: "messages.push(assistant + toolCalls)", detail: "add to history", phase: "agent" })

  add({ kind: "note", from: "tools", to: "tools", label: "── for each toolCall ──", phase: "agent" })

  add({ kind: "call", from: "agent", to: "tools", label: "tool.execute(call.arguments)", detail: "tools/<name>.ts — through wrapper chain", color: P.tools, phase: "agent" })

  // Governance pre-check
  add({ kind: "call", from: "tools", to: "govern", label: "policy.preExecute(tool, args)", detail: "governance.ts — check rules", phase: "agent" })
  add({ kind: "return", from: "govern", to: "tools", label: "allow | deny | require-approval", dashed: true, phase: "agent" })

  // Effect recording (write_file path)
  add({ kind: "call", from: "tools", to: "effects", label: "recordFileWrite({ runId, path, content })", detail: "effects.ts:149 — pre-write snapshot", phase: "agent" })
  add({ kind: "call", from: "effects", to: "db", label: "INSERT file_snapshots", detail: "pre-content + hash", phase: "agent" })
  add({ kind: "call", from: "effects", to: "db", label: "INSERT effects", detail: "id, run_id, seq, kind, tool", phase: "agent" })
  add({ kind: "call", from: "effects", to: "ws", label: "broadcast('effect.recorded')", detail: "ws.ts:45", phase: "agent" })
  add({ kind: "return", from: "effects", to: "tools", label: "effectId", dashed: true, phase: "agent" })

  // Actual tool execution
  add({ kind: "self", from: "tools", to: "tools", label: "originalTool.execute(args)", detail: "filesystem.ts / shell.ts", phase: "agent" })
  add({ kind: "return", from: "tools", to: "agent", label: "result string", dashed: true, color: P.tools, phase: "agent" })

  add({ kind: "self", from: "agent", to: "agent", label: "messages.push(tool result)", detail: "{ role: 'tool', toolCallId, content }", phase: "agent" })

  // Stuck detection
  add({ kind: "self", from: "agent", to: "agent", label: "stuckDetection(failures[])", detail: "if same tool+args failed 3×", phase: "agent" })

  // onStep callback → checkpoint
  add({ kind: "call", from: "agent", to: "orch", label: "onStep(messages, iteration)", detail: "callback → orchestrator checkpoint", phase: "agent" })
  add({ kind: "call", from: "orch", to: "db", label: "saveCheckpoint({ run_id, messages, iteration })", detail: "db/runs.ts:73 → UPSERT checkpoints", phase: "agent" })
  add({ kind: "call", from: "orch", to: "ws", label: "broadcast('checkpoint.saved')", detail: "ws.ts:45", phase: "agent" })

  add({ kind: "alt-end", from: "agent", to: "agent", label: "", phase: "agent" })

  // No tools → answer
  add({ kind: "alt-else", from: "agent", to: "agent", label: "else [no toolCalls → final answer]", phase: "agent" })
  add({ kind: "return", from: "agent", to: "orch", label: "answer string", dashed: true, color: P.agent, phase: "agent" })

  add({ kind: "alt-end", from: "agent", to: "agent", label: "", phase: "agent" })
  add({ kind: "alt-end", from: "agent", to: "agent", label: "", phase: "agent" })

  // ─────────────────────────────────────────
  // PHASE 5: Delegation (if used)
  // ─────────────────────────────────────────
  add({ kind: "note", from: "http", to: "http", label: "── Phase 5: Delegation (optional) ──", phase: "delegation" })

  add({ kind: "call", from: "agent", to: "delegate", label: "delegateTool.execute({ goal, agentId })", detail: "delegate.ts — sub-agent spawn", color: P.delegate, phase: "delegation" })
  add({ kind: "self", from: "delegate", to: "delegate", label: "check depth < maxDepth", detail: "flat hierarchy (max 1 level)", phase: "delegation" })
  add({ kind: "call", from: "delegate", to: "queue", label: "acquireSlot(childRunId, HIGH)", detail: "queue.ts → priority slot", phase: "delegation" })
  add({ kind: "return", from: "queue", to: "delegate", label: "{ releaseSlot }", dashed: true, phase: "delegation" })
  add({ kind: "call", from: "delegate", to: "agent", label: "new Agent(llm, childTools, config)", detail: "agent.ts:227 — child constructor", phase: "delegation" })
  add({ kind: "call", from: "delegate", to: "agent", label: "childAgent.run(goal)", detail: "agent.ts:260 — child loop", phase: "delegation" })
  add({ kind: "call", from: "delegate", to: "ws", label: "broadcast('delegation.started')", detail: "ws.ts:45", phase: "delegation" })
  add({ kind: "return", from: "agent", to: "delegate", label: "childAnswer", dashed: true, phase: "delegation" })
  add({ kind: "call", from: "delegate", to: "ws", label: "broadcast('delegation.ended')", detail: "ws.ts:45", phase: "delegation" })
  add({ kind: "call", from: "delegate", to: "audit", label: "auditService.log('delegation.completed')", detail: "audit.ts → INSERT audit_log", phase: "delegation" })
  add({ kind: "return", from: "delegate", to: "agent", label: "delegatedAnswer", dashed: true, color: P.delegate, phase: "delegation" })

  // ─────────────────────────────────────────
  // PHASE 6: Run Completion & Memory Ingestion
  // ─────────────────────────────────────────
  add({ kind: "note", from: "http", to: "http", label: "── Phase 6: Completion & Ingestion ──", phase: "completion" })

  add({ kind: "call", from: "orch", to: "db", label: "persistRun(run, 'completed')", detail: "db/runs.ts → UPDATE runs", phase: "completion" })
  add({ kind: "call", from: "orch", to: "db", label: "saveTokenUsage(runId, agent.usage)", detail: "INSERT token_usage", phase: "completion" })

  // Memory ingestion
  add({ kind: "call", from: "orch", to: "memory", label: "ingestRunTurns(run)", detail: "memory.ts:520 — ingest all turns", color: P.memory, phase: "completion" })

  add({ kind: "self", from: "memory", to: "memory", label: "ingestTurn({ tier: 'working', role: 'user' })", detail: "goal → salience check → dedup", phase: "completion" })
  add({ kind: "self", from: "memory", to: "memory", label: "computeSalience(content, role)", detail: "length×35% + action×40% + struct×25%", phase: "completion" })
  add({ kind: "alt-start", from: "memory", to: "memory", label: "alt [salience >= 0.15]", altLabel: "Salience Gate", phase: "completion" })
  add({ kind: "call", from: "memory", to: "db", label: "INSERT memory_entries", detail: "id, tier, role, content, confidence", phase: "completion" })
  add({ kind: "self", from: "memory", to: "memory", label: "embedEntry(entry).catch()", detail: "async fire-and-forget → Ollama", phase: "completion" })
  add({ kind: "call", from: "memory", to: "ws", label: "broadcast('memory.ingested')", detail: "{ tier, role, contentPreview }", phase: "completion" })
  add({ kind: "alt-else", from: "memory", to: "memory", label: "else [low salience / duplicate]", phase: "completion" })
  add({ kind: "call", from: "memory", to: "ws", label: "broadcast('memory.filtered')", detail: "{ reason, contentPreview }", phase: "completion" })
  add({ kind: "alt-end", from: "memory", to: "memory", label: "", phase: "completion" })

  add({ kind: "self", from: "memory", to: "memory", label: "×N: ingestTurn per tool-call/tool-result", detail: "each tool interaction stored", phase: "completion" })
  add({ kind: "self", from: "memory", to: "memory", label: "ingestTurn({ tier: 'working', role: 'assistant' })", detail: "answer → working memory", phase: "completion" })
  add({ kind: "self", from: "memory", to: "memory", label: "buildEpisodicSummary(run)", detail: "compact: goal + tools + status", phase: "completion" })
  add({ kind: "call", from: "memory", to: "db", label: "INSERT memory_entries (episodic)", detail: "tier: episodic, role: summary", phase: "completion" })
  add({ kind: "return", from: "memory", to: "orch", label: "void (ingestion complete)", dashed: true, color: P.memory, phase: "completion" })

  // Procedural extraction
  add({ kind: "call", from: "orch", to: "memory", label: "extractProcedural(run)", detail: "memory.ts:564 — tool sequences", phase: "completion" })
  add({ kind: "self", from: "memory", to: "memory", label: "hashToolSequence(toolCalls)", detail: "≥2 tools → procedural entry", phase: "completion" })
  add({ kind: "call", from: "memory", to: "db", label: "INSERT procedural_memories", detail: "trigger, tool_sequence, success_count", phase: "completion" })
  add({ kind: "call", from: "memory", to: "ws", label: "broadcast('procedural.stored')", detail: "{ trigger, toolCount }", phase: "completion" })
  add({ kind: "return", from: "memory", to: "orch", label: "ProceduralMemory | null", dashed: true, phase: "completion" })

  // Consolidation
  add({ kind: "call", from: "orch", to: "memory", label: "consolidate({ minAgeHours: 24 })", detail: "memory.ts:1071 — episodic→semantic", phase: "completion" })
  add({ kind: "call", from: "memory", to: "db", label: "SELECT episodic entries > 24h", detail: "candidates for promotion", phase: "completion" })
  add({ kind: "self", from: "memory", to: "memory", label: "agglomerative clustering (Jaccard≥0.4)", detail: "group similar entries", phase: "completion" })
  add({ kind: "self", from: "memory", to: "memory", label: "cross-tier dedup vs semantic", detail: "skip if already in semantic", phase: "completion" })
  add({ kind: "self", from: "memory", to: "memory", label: "ingestTurn({ tier: 'semantic' })", detail: "promoted, confidence boosted", phase: "completion" })
  add({ kind: "call", from: "memory", to: "db", label: "UPDATE confidence × 0.3 (soft-delete)", detail: "fade source entries", phase: "completion" })
  add({ kind: "call", from: "memory", to: "db", label: "DELETE WHERE confidence < 0.05", detail: "prune very low confidence", phase: "completion" })
  add({ kind: "call", from: "memory", to: "ws", label: "broadcast('memory.consolidated')", detail: "{ promoted, pruned }", phase: "completion" })
  add({ kind: "return", from: "memory", to: "orch", label: "{ promoted, pruned }", dashed: true, phase: "completion" })

  // Final broadcasts
  add({ kind: "call", from: "orch", to: "ws", label: "broadcast('run.completed')", detail: "{ runId, answer, stepCount, tokens }", phase: "completion" })
  add({ kind: "call", from: "orch", to: "ws", label: "broadcast('notification')", detail: "{ title: 'Run completed' }", phase: "completion" })
  add({ kind: "call", from: "orch", to: "queue", label: "releaseSlot()", detail: "queue.ts — free concurrency slot", phase: "completion" })

  // ─────────────────────────────────────────
  // PHASE 7: WS Broadcast Pipeline
  // ─────────────────────────────────────────
  add({ kind: "note", from: "http", to: "http", label: "── Phase 7: WS Broadcast Detail ──", phase: "broadcast" })

  add({ kind: "self", from: "ws", to: "ws", label: "addTimestamp(event)", detail: "new Date().toISOString()", phase: "broadcast" })
  add({ kind: "self", from: "ws", to: "ws", label: "JSON.stringify(msg)", detail: "serialize once for all clients", phase: "broadcast" })
  add({ kind: "self", from: "ws", to: "ws", label: "for (client of clients) client.send(json)", detail: "push to all connected WS clients", phase: "broadcast" })
  add({ kind: "call", from: "ws", to: "db", label: "saveEvent(type, data, timestamp)", detail: "INSERT event_log", phase: "broadcast" })
  add({ kind: "self", from: "ws", to: "ws", label: "pushToWebhooks(msg, json)", detail: "async, HMAC-SHA256 signature", phase: "broadcast" })

  return msgs
}

// ── All phases ───────────────────────────────────────────────────

const ALL_PHASES = [
  { id: "entry",      label: "1. Request Entry" },
  { id: "init",       label: "2. Queue & Init" },
  { id: "prompt",     label: "3. Prompt Assembly" },
  { id: "agent",      label: "4. Agent Loop" },
  { id: "delegation", label: "5. Delegation" },
  { id: "completion", label: "6. Completion" },
  { id: "broadcast",  label: "7. WS Broadcast" },
]

// ── Trace → Phase mapping ────────────────────────────────────────

/** Map the latest trace entry to which diagram phase is currently active */
function traceToPhase(trace: TraceEntry[]): {
  activePhase: string | null
  completedPhases: Set<string>
  activeLifelines: Set<string>
} {
  const completedPhases = new Set<string>()
  let activePhase: string | null = null
  const activeLifelines = new Set<string>()

  // Phase ordering for completion tracking
  const phaseOrder = ["entry", "init", "prompt", "agent", "delegation", "completion", "broadcast"]

  for (const e of trace) {
    switch (e.kind) {
      case "goal":
        activePhase = "entry"
        activeLifelines.add("http").add("orch").add("db")
        break
      case "iteration":
        // Mark earlier phases as completed
        for (const p of phaseOrder) {
          if (p === "agent") break
          completedPhases.add(p)
        }
        activePhase = "agent"
        activeLifelines.add("agent").add("orch")
        break
      case "thinking":
        activePhase = "agent"
        activeLifelines.add("agent").add("llm")
        break
      case "tool-call":
        activePhase = "agent"
        activeLifelines.add("agent").add("tools").add("govern").add("effects")
        break
      case "tool-result":
        activePhase = "agent"
        activeLifelines.add("tools").add("agent")
        break
      case "tool-error":
        activePhase = "agent"
        activeLifelines.add("tools").add("agent")
        break
      case "delegation-start":
        activePhase = "delegation"
        activeLifelines.add("delegate").add("agent").add("queue")
        break
      case "delegation-end":
        activePhase = "delegation"
        activeLifelines.add("delegate").add("agent")
        break
      case "answer":
        for (const p of phaseOrder) {
          if (p === "completion") break
          completedPhases.add(p)
        }
        activePhase = "completion"
        activeLifelines.add("orch").add("memory").add("db").add("ws")
        break
      case "error":
        // Keep current phase
        break
    }
  }

  if (activePhase) completedPhases.delete(activePhase)

  return { activePhase, completedPhases, activeLifelines }
}

// ── Geometry constants ───────────────────────────────────────────

const NOTE_PAD = 8
const HEADER_H = 52
const ROW_H = 28
const ARROW_HEAD = 7
const ALT_PAD = 4
const SELF_W = 30
const MIN_LANE_W = 80

// ── Helpers ──────────────────────────────────────────────────────

function laneIdx(id: string): number {
  return LIFELINES.findIndex((l) => l.id === id)
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

// ── Component ────────────────────────────────────────────────────

export function CodeSeqDiagram() {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [containerW, setContainerW] = useState(1200)
  const [selectedRow, setSelectedRow] = useState<number | null>(null)
  const [enabledPhases, setEnabledPhases] = useState<Set<string>>(
    () => new Set(ALL_PHASES.map((p) => p.id))
  )

  // ── Subscribe to store ──
  const trace = useStore((s) => s.trace)
  const runs = useStore((s) => s.runs)
  const isRunning = runs.some((r) => r.status === "running" || r.status === "pending")

  // Compute active phase/lifelines from trace
  const { activePhase, completedPhases, activeLifelines } = useMemo(
    () => traceToPhase(trace),
    [trace]
  )

  // Map each message row to a phase id (for highlighting)
  const getMsgPhase = useCallback((msgs: Msg[]): Map<number, string> => {
    const map = new Map<number, string>()
    let currentPhase: string | null = null
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      if (m.kind === "note") {
        // Phase header note — extract phase id
        for (const ph of ALL_PHASES) {
          if (m.label.includes(ph.label.replace(/^\d+\.\s*/, ""))) {
            currentPhase = ph.id
            break
          }
        }
      }
      if (currentPhase) map.set(i, currentPhase)
    }
    return map
  }, [])

  // Responsive width
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setContainerW(e.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Toggle phase
  const togglePhase = useCallback((phaseId: string) => {
    setEnabledPhases((prev) => {
      const next = new Set(prev)
      if (next.has(phaseId)) next.delete(phaseId)
      else next.add(phaseId)
      return next
    })
  }, [])

  // Build messages based on enabled phases
  const msgs = useMemo(() => buildMessages(enabledPhases), [enabledPhases])
  const msgPhaseMap = useMemo(() => getMsgPhase(msgs), [getMsgPhase, msgs])

  // Calculate lane width — fill full container, with a minimum per lane
  const laneW = useMemo(() => {
    return Math.max(MIN_LANE_W, (containerW) / LIFELINES.length)
  }, [containerW])

  const totalW = Math.max(LIFELINES.length * laneW, containerW)
  const bodyH = msgs.length * ROW_H + 40

  // Lane center positions
  const laneX = useCallback((idx: number) => idx * laneW + laneW / 2, [laneW])

  // Map note labels back to phase ids for toggle
  const phaseIdFromNote = useCallback((label: string): string | null => {
    for (const ph of ALL_PHASES) {
      if (label.includes(ph.label.replace(/^\d+\.\s*/, ""))) return ph.id
    }
    return null
  }, [])

  // Render sticky header (plain text column headers)
  const headerContent = useMemo(() => {
    const elements: JSX.Element[] = []
    for (let i = 0; i < LIFELINES.length; i++) {
      const ll = LIFELINES[i]
      const cx = laneX(i)
      const isActive = isRunning && activeLifelines.has(ll.id)
      elements.push(
        <g key={`hdr-${ll.id}`}>
          {isActive && (
            <circle cx={cx} cy={24} r={20} fill={ll.color + "15"} />
          )}
          <text
            x={cx}
            y={24}
            textAnchor="middle"
            fill={isActive ? ll.color : P.text}
            fontSize={13}
            fontWeight={600}
            fontFamily="monospace"
          >
            {ll.label}
          </text>
          <text
            x={cx}
            y={40}
            textAnchor="middle"
            fill={P.dim}
            fontSize={9}
            fontFamily="monospace"
          >
            {ll.file}
          </text>
        </g>
      )
    }
    // Bottom separator line
    elements.push(
      <line key="hdr-sep" x1={0} y1={HEADER_H - 1} x2={totalW} y2={HEADER_H - 1}
        stroke={P.dimmer} strokeWidth={1} />
    )
    return elements
  }, [laneW, laneX, totalW, isRunning, activeLifelines])

  // Render body (lifelines + messages)
  const bodyContent = useMemo(() => {
    const elements: JSX.Element[] = []
    let altDepth = 0

    // ── Dashed lifelines ──
    for (let i = 0; i < LIFELINES.length; i++) {
      const cx = laneX(i)
      elements.push(
        <line
          key={`life-${i}`}
          x1={cx} y1={0}
          x2={cx} y2={bodyH}
          stroke={P.dimmer}
          strokeWidth={1}
          strokeDasharray="4 3"
        />
      )
    }

    // ── Messages ──
    for (let r = 0; r < msgs.length; r++) {
      const m = msgs[r]
      const y = r * ROW_H + ROW_H / 2
      const fi = laneIdx(m.from)
      const ti = laneIdx(m.to)
      const fromX = laneX(fi)
      const toX = laneX(ti)
      // Color: explicit override > source lifeline color for calls > gray for returns
      const fromLL = LIFELINES[fi]
      const arrowColor = m.color
        ?? (m.kind === "call" || m.kind === "self" ? fromLL?.color ?? P.arrow : P.arrow)

      // Phase-based opacity when a run is active
      const rowPhase = msgPhaseMap.get(r)
      const isRowActive = isRunning && rowPhase === activePhase
      const isRowCompleted = isRunning && rowPhase != null && completedPhases.has(rowPhase)
      const rowOpacity = !isRunning ? 1 : isRowActive ? 1 : isRowCompleted ? 0.5 : 0.2

      // Clickable background
      elements.push(
        <rect
          key={`bg-${r}`}
          x={0}
          y={y - ROW_H / 2}
          width={totalW}
          height={ROW_H}
          fill={isRowActive ? "rgba(123,111,199,0.06)" : selectedRow === r ? "rgba(255,255,255,0.04)" : "transparent"}
          style={{ cursor: "pointer" }}
          opacity={rowOpacity}
          onClick={() => setSelectedRow(selectedRow === r ? null : r)}
        />
      )

      if (m.kind === "note") {
        // Phase header note — clickable toggle
        const phaseId = phaseIdFromNote(m.label)
        const isOn = phaseId ? enabledPhases.has(phaseId) : true
        const textLen = m.label.length * 7
        const noteX = totalW / 2 - textLen / 2 - NOTE_PAD
        elements.push(
          <g
            key={`note-${r}`}
            style={{ cursor: phaseId ? "pointer" : undefined }}
            opacity={isOn ? 1 : 0.35}
            onClick={phaseId ? () => togglePhase(phaseId) : undefined}
          >
            <rect
              x={noteX}
              y={y - 10}
              width={textLen + NOTE_PAD * 2}
              height={20}
              rx={3}
              fill={P.noteB}
              stroke={isOn ? P.dim : P.dimmer}
              strokeWidth={0.5}
            />
            <text
              x={totalW / 2}
              y={y + 4}
              textAnchor="middle"
              fill={P.text}
              fontSize={11}
              fontWeight={700}
              fontFamily="monospace"
              textDecoration={isOn ? "none" : "line-through"}
            >
              {m.label}
            </text>
          </g>
        )
      } else if (m.kind === "alt-start") {
        // Alt fragment header
        altDepth++
        const indent = (altDepth - 1) * ALT_PAD
        let endIdx = r + 1
        let depth = 1
        for (; endIdx < msgs.length && depth > 0; endIdx++) {
          if (msgs[endIdx].kind === "alt-start") depth++
          if (msgs[endIdx].kind === "alt-end") depth--
        }
        const fragH = (endIdx - r) * ROW_H
        elements.push(
          <g key={`alt-${r}`}>
            <rect
              x={indent + 4}
              y={y - ROW_H / 2}
              width={totalW - indent * 2 - 8}
              height={fragH}
              rx={3}
              fill="none"
              stroke={P.dim}
              strokeWidth={0.5}
              strokeDasharray="4 2"
            />
            <rect
              x={indent + 4}
              y={y - ROW_H / 2}
              width={Math.min(m.label.length * 6.5 + 14, 300)}
              height={22}
              fill={P.note}
              stroke={P.dim}
              strokeWidth={0.5}
            />
            <text
              x={indent + 12}
              y={y + 2}
              fill={P.text}
              fontSize={10}
              fontWeight={600}
              fontFamily="monospace"
            >
              {trunc(m.label, 45)}
            </text>
          </g>
        )
      } else if (m.kind === "alt-else") {
        elements.push(
          <g key={`else-${r}`}>
            <line
              x1={(altDepth - 1) * ALT_PAD + 4}
              y1={y}
              x2={totalW - (altDepth - 1) * ALT_PAD - 4}
              y2={y}
              stroke={P.dim}
              strokeWidth={0.5}
              strokeDasharray="4 2"
            />
            <text
              x={(altDepth - 1) * ALT_PAD + 12}
              y={y - 3}
              fill={P.text}
              fontSize={10}
              fontFamily="monospace"
              opacity={0.8}
            >
              {trunc(m.label, 50)}
            </text>
          </g>
        )
      } else if (m.kind === "alt-end") {
        altDepth = Math.max(0, altDepth - 1)
      } else if (m.kind === "self" || fi === ti) {
        // Self-call (including any call/return with same from/to)
        const cx = fromX
        elements.push(
          <g key={`self-${r}`}>
            <path
              d={`M ${cx} ${y - 5} L ${cx + SELF_W} ${y - 5} L ${cx + SELF_W} ${y + 5} L ${cx + 2} ${y + 5}`}
              fill="none"
              stroke={arrowColor}
              strokeWidth={1}
              strokeDasharray={m.dashed ? "4 2" : undefined}
            />
            <polygon
              points={`${cx + 2},${y + 5} ${cx + 7},${y + 2} ${cx + 7},${y + 8}`}
              fill={arrowColor}
            />
            <text
              x={cx + SELF_W + 4}
              y={y}
              fill={arrowColor}
              fontSize={11}
              fontFamily="monospace"
              fontWeight={600}
            >
              {trunc(m.label, Math.floor((totalW - cx - SELF_W - 12) / 6.5))}
            </text>
            {m.detail && (
              <text
                x={cx + SELF_W + 4}
                y={y + 12}
                fill={P.text}
                fontSize={9}
                fontFamily="monospace"
                opacity={0.6}
              >
                {trunc(m.detail, Math.floor((totalW - cx - SELF_W - 12) / 5.5))}
              </text>
            )}
          </g>
        )
      } else {
        // call or return arrow (different lifelines)
        const left = Math.min(fromX, toX)
        const right = Math.max(fromX, toX)
        const dir = toX > fromX ? 1 : -1

        elements.push(
          <g key={`msg-${r}`}>
            <line
              x1={fromX}
              y1={y}
              x2={toX - dir * ARROW_HEAD}
              y2={y}
              stroke={arrowColor}
              strokeWidth={m.dashed ? 0.8 : 1.2}
              strokeDasharray={m.dashed ? "4 2" : undefined}
            />
            {m.kind === "call" ? (
              <polygon
                points={`${toX},${y} ${toX - dir * ARROW_HEAD},${y - 3} ${toX - dir * ARROW_HEAD},${y + 3}`}
                fill={arrowColor}
              />
            ) : (
              <polyline
                points={`${toX - dir * ARROW_HEAD},${y - 3} ${toX},${y} ${toX - dir * ARROW_HEAD},${y + 3}`}
                fill="none"
                stroke={arrowColor}
                strokeWidth={0.8}
              />
            )}
            <text
              x={(left + right) / 2}
              y={y - 5}
              textAnchor="middle"
              fill={m.dashed ? P.text : arrowColor}
              fontSize={11}
              fontWeight={m.dashed ? 400 : 600}
              fontFamily="monospace"
            >
              {trunc(m.label, Math.floor((right - left) / 6.5))}
            </text>
            {m.detail && selectedRow === r && (
              <text
                x={(left + right) / 2}
                y={y + 12}
                textAnchor="middle"
                fill={P.text}
                fontSize={9}
                fontFamily="monospace"
                opacity={0.7}
              >
                {trunc(m.detail, Math.floor((right - left) / 5.5))}
              </text>
            )}
          </g>
        )
      }
    }

    // ── Active phase progress indicator ──
    if (isRunning && activePhase) {
      // Find the last row in the active phase
      let lastActiveRow = -1
      for (let r = 0; r < msgs.length; r++) {
        if (msgPhaseMap.get(r) === activePhase) lastActiveRow = r
      }
      if (lastActiveRow >= 0) {
        const markerY = lastActiveRow * ROW_H + ROW_H
        elements.push(
          <line
            key="progress-line"
            x1={0}
            y1={markerY}
            x2={totalW}
            y2={markerY}
            stroke={P.accent}
            strokeWidth={1.5}
            opacity={0.6}
            strokeDasharray="6 3"
          />
        )
        elements.push(
          <text
            key="progress-label"
            x={8}
            y={markerY - 4}
            fill={P.accent}
            fontSize={9}
            fontWeight={700}
            fontFamily="monospace"
          >
            ▶ ACTIVE
          </text>
        )
      }
    }

    return elements
  }, [msgs, msgPhaseMap, laneW, laneX, totalW, bodyH, selectedRow, enabledPhases, togglePhase, phaseIdFromNote, isRunning, activePhase, completedPhases])

  // ── Detail panel for selected row ──
  const selectedMsg = selectedRow !== null ? msgs[selectedRow] : null

  // ── Auto-scroll to active phase ──
  useEffect(() => {
    if (!isRunning || !activePhase || !scrollRef.current) return
    // Find first row in the active phase
    for (let r = 0; r < msgs.length; r++) {
      if (msgPhaseMap.get(r) === activePhase) {
        const targetY = r * ROW_H + HEADER_H - 40
        scrollRef.current.scrollTo({ top: Math.max(0, targetY), behavior: "smooth" })
        break
      }
    }
  }, [activePhase, isRunning, msgs, msgPhaseMap])

  return (
    <div ref={containerRef} className="flex flex-col h-full bg-zinc-950 text-zinc-300 overflow-hidden">
      {/* LIVE indicator */}
      {isRunning && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-1.5" style={{ background: "rgba(123,111,199,0.08)", borderBottom: `1px solid ${P.accent}30` }}>
          <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: P.accent }} />
          <span className="text-[11px] font-mono font-semibold tracking-wide" style={{ color: P.accent }}>
            LIVE — {activePhase ? ALL_PHASES.find(p => p.id === activePhase)?.label ?? activePhase : "starting"}
          </span>
          <span className="text-[10px] font-mono" style={{ color: P.dim }}>
            {trace.length} event{trace.length !== 1 ? "s" : ""}
          </span>
        </div>
      )}
      {/* Scrollable area: sticky lifeline headers + diagram body */}
      <div ref={scrollRef} className="flex-1 overflow-auto">
        <div style={{ width: totalW, minWidth: totalW, position: "relative" }}>
          {/* Sticky lifeline headers only */}
          <svg
            width={totalW}
            height={HEADER_H}
            viewBox={`0 0 ${totalW} ${HEADER_H}`}
            className="font-mono"
            style={{ position: "sticky", top: 0, zIndex: 10, display: "block", background: P.bg }}
          >
            <rect width={totalW} height={HEADER_H} fill={P.bg} />
            {headerContent}
          </svg>
          <svg
            ref={svgRef}
            width={totalW}
            height={bodyH}
            viewBox={`0 0 ${totalW} ${bodyH}`}
            className="font-mono"
            style={{ display: "block" }}
          >
            <rect width={totalW} height={bodyH} fill={P.bg} />
            {bodyContent}
          </svg>
        </div>
      </div>

      {/* Detail panel — no top border */}
      {selectedMsg && selectedMsg.kind !== "note" && selectedMsg.kind !== "alt-start" && selectedMsg.kind !== "alt-end" && selectedMsg.kind !== "alt-else" && (
        <div className="shrink-0 bg-zinc-900/60 px-3 py-2 max-h-28 overflow-auto">
          <div className="flex items-center gap-2 text-xs font-mono">
            <span className="text-zinc-600 text-[10px]">{selectedMsg.kind.toUpperCase()}</span>
            <span style={{ color: LIFELINES[laneIdx(selectedMsg.from)]?.color }}>
              {LIFELINES[laneIdx(selectedMsg.from)]?.label ?? selectedMsg.from}
            </span>
            <span className="text-zinc-700">→</span>
            <span style={{ color: LIFELINES[laneIdx(selectedMsg.to)]?.color }}>
              {LIFELINES[laneIdx(selectedMsg.to)]?.label ?? selectedMsg.to}
            </span>
          </div>
          <div className="text-xs font-mono text-zinc-200 mt-0.5">{selectedMsg.label}</div>
          {selectedMsg.detail && (
            <div className="text-[10px] font-mono text-zinc-500 mt-0.5">{selectedMsg.detail}</div>
          )}
        </div>
      )}
    </div>
  )
}
