/**
 * AgentChat — send goals to the agent and see responses.
 *
 * The primary interaction widget: type a goal, agent executes, see the answer.
 * Supports voice input via Web Speech API (any language).
 * Includes agent picker to select which configured agent to use.
 */

import { AlertCircle, Bot, ChevronDown, Mic, MicOff, Send, User } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../api"
import { useStore } from "../store"
import type { AgentDefinition } from "../types"

// Web Speech API types
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList
}
type SpeechRecognitionInstance = EventTarget & {
  lang: string
  interimResults: boolean
  continuous: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEvent) => void) | null
  onend: (() => void) | null
  onerror: ((e: Event & { error: string }) => void) | null
}
const SpeechRecognition = (globalThis as Record<string, unknown>)["SpeechRecognition"] as
  (new () => SpeechRecognitionInstance) | undefined ??
  (globalThis as Record<string, unknown>)["webkitSpeechRecognition"] as
  (new () => SpeechRecognitionInstance) | undefined

export function AgentChat() {
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const [listening, setListening] = useState(false)
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const setSelectedAgent = useStore((s) => s.setSelectedAgent)
  const bottomRef = useRef<HTMLDivElement>(null)
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)

  const activeRun = runs.find((r) => r.id === activeRunId)
  const isRunning = activeRun?.status === "pending" || activeRun?.status === "running" || activeRun?.status === "planning"
  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? agents.find((a) => a.id === "default") ?? agents[0]

  // Load agents on mount
  useEffect(() => {
    api.listAgents().then(setAgents).catch(() => {})
  }, [])

  // Close picker on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    if (pickerOpen) document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [pickerOpen])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [runs])

  // Cleanup recognition on unmount
  useEffect(() => {
    return () => { recognitionRef.current?.abort() }
  }, [])

  async function handleSend() {
    const goal = input.trim()
    if (!goal || sending) return

    setSending(true)
    setInput("")
    try {
      const agentId = selectedAgent?.id
      // Build conversation history from recent completed runs (same agent)
      const history = runs
        .filter((r) => r.status === "completed" && r.answer && (!agentId || r.agentId === agentId))
        .slice(0, 10)
        .reverse()
        .map((r) => ({ goal: r.goal, answer: r.answer! }))
      const { runId } = await api.startRun(goal, agentId, history)
      setActiveRun(runId)
    } catch (err) {
      console.error("Failed to start run:", err)
    } finally {
      setSending(false)
    }
  }

  const toggleVoice = useCallback(() => {
    if (!SpeechRecognition) return

    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }

    const recognition = new SpeechRecognition()
    recognition.interimResults = true
    recognition.continuous = false
    // Auto-detect language — empty string lets browser use device language
    recognition.lang = ""
    recognitionRef.current = recognition

    let finalTranscript = ""

    recognition.onresult = (e: SpeechRecognitionEvent) => {
      let interim = ""
      for (let i = 0; i < e.results.length; i++) {
        const result = e.results[i]
        if (result?.[0]) {
          if (result.isFinal) {
            finalTranscript += result[0].transcript
          } else {
            interim += result[0].transcript
          }
        }
      }
      setInput(finalTranscript + interim)
    }

    recognition.onend = () => {
      setListening(false)
      recognitionRef.current = null
    }

    recognition.onerror = () => {
      setListening(false)
      recognitionRef.current = null
    }

    recognition.start()
    setListening(true)
  }, [listening])

  // Show recent runs as "conversation"
  const recentRuns = runs.slice(0, 20)

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto space-y-3 py-1">
        {recentRuns.length === 0 && (
          <div className="text-text-muted text-sm text-center pt-8">
            Send a goal to start the agent
          </div>
        )}

        {[...recentRuns].reverse().map((run) => (
          <div
            key={run.id}
            className={`space-y-2 cursor-pointer rounded-lg p-2 transition-colors ${
              run.id === activeRunId ? "bg-elevated/50" : "hover:bg-elevated/25"
            }`}
            onClick={() => setActiveRun(run.id)}
          >
            {/* Goal (user message) — right-aligned */}
            <div className="flex justify-end">
              <div className="flex items-start gap-2 max-w-[85%]">
                <span className="text-text text-sm bg-accent/10 rounded-xl rounded-tr-sm px-3 py-1.5 leading-relaxed">{run.goal}</span>
                <User size={14} className="text-accent shrink-0 mt-1.5" />
              </div>
            </div>

            {/* Answer (agent response) — left-aligned */}
            {run.answer && (
              <div className="flex items-start gap-2 max-w-[85%]">
                <Bot size={14} className="text-text-muted shrink-0 mt-1.5" />
                <span className="text-text-secondary text-sm whitespace-pre-wrap leading-relaxed">
                  {run.answer}
                </span>
              </div>
            )}

            {/* Error */}
            {run.error && (
              <div className="flex items-start gap-2">
                <AlertCircle size={14} className="text-error shrink-0 mt-0.5" />
                <span className="text-error/80 text-sm">{run.error}</span>
              </div>
            )}

            {/* Progress indicator — shown while agent is working */}
            {(run.status === "running" || run.status === "pending" || run.status === "planning") && !run.answer && (
              <div className="flex items-center gap-2 ml-5">
                <Bot size={14} className="text-accent shrink-0" />
                <div className="flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-accent animate-bounce [animation-delay:300ms]" />
                </div>
                <span className="text-[12px] text-text-muted">
                  {run.status === "pending" ? "Queued" : "Thinking"}
                </span>
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Agent picker + Input */}
      <div className="shrink-0 space-y-2">
        {/* Agent picker */}
        {agents.length > 1 && (
          <div className="relative" ref={pickerRef}>
            <button
              className="flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary transition-colors"
              onClick={() => setPickerOpen(!pickerOpen)}
            >
              <Bot size={12} className="text-accent" />
              <span className="truncate max-w-[140px]">{selectedAgent?.name ?? "Select agent"}</span>
              <ChevronDown size={12} />
            </button>

            {pickerOpen && (
              <div className="absolute bottom-full left-0 mb-1 w-56 bg-surface border border-white/[0.08] rounded-lg shadow-xl z-10 overflow-hidden">
                {agents.map((agent) => (
                  <button
                    key={agent.id}
                    className={`flex items-center gap-2 w-full px-3 py-2 text-left text-sm transition-colors ${
                      agent.id === selectedAgent?.id
                        ? "bg-accent/10 text-accent"
                        : "text-text-secondary hover:bg-white/[0.04] hover:text-text"
                    }`}
                    onClick={() => {
                      setSelectedAgent(agent.id)
                      setPickerOpen(false)
                    }}
                  >
                    <Bot size={13} className="shrink-0" />
                    <div className="min-w-0">
                      <div className="truncate">{agent.name}</div>
                      {agent.description && (
                        <div className="text-[11px] text-text-muted truncate">{agent.description}</div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Input */}
        <div className="flex gap-2">
          <input
            className="flex-1 bg-base rounded-lg px-3 py-2 text-sm text-text placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent transition-all"
            placeholder={listening ? "Listening..." : isRunning ? "Agent is working..." : "Enter a goal..."}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSend() }}
            disabled={sending}
          />
          {SpeechRecognition && (
            <button
              className={`flex items-center justify-center w-11 h-11 rounded-lg transition-colors ${
                listening
                  ? "bg-error/20 text-error hover:bg-error/30"
                  : "bg-elevated text-text-muted hover:text-text hover:bg-elevated/80"
              }`}
              onClick={toggleVoice}
              title={listening ? "Stop listening" : "Voice input"}
            >
              {listening ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
          )}
          <button
            className="flex items-center justify-center w-11 h-11 bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-40"
            onClick={handleSend}
            disabled={sending || !input.trim()}
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
