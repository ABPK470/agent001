/**
 * AgentChat — send goals to the agent and see responses.
 *
 * The primary interaction widget: type a goal, agent executes, see the answer.
 * Supports voice input via Web Speech API (any language).
 * Includes agent picker to select which configured agent to use.
 */

import { AlertCircle, Bot, ChevronDown, Mic, MicOff, Paperclip, Send, User, X } from "lucide-react"
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
  const [attachments, setAttachments] = useState<{ name: string; content: string }[]>([])
  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const selectedAgentId = useStore((s) => s.selectedAgentId)
  const setSelectedAgent = useStore((s) => s.setSelectedAgent)
  const bottomRef = useRef<HTMLDivElement>(null)
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
    if (!goal && attachments.length === 0) return
    if (sending) return

    // Build the full goal: user text + any attached file contents
    const parts: string[] = []
    if (goal) parts.push(goal)
    for (const att of attachments) {
      parts.push(`\n---\n**Attached: ${att.name}**\n\`\`\`\n${att.content}\n\`\`\``)
    }
    const fullGoal = parts.join("\n")

    setSending(true)
    setInput("")
    setAttachments([])
    if (textareaRef.current) textareaRef.current.style.height = "auto"
    try {
      const agentId = selectedAgent?.id
      const { runId } = await api.startRun(fullGoal, agentId)
      setActiveRun(runId)
    } catch (err) {
      console.error("Failed to start run:", err)
    } finally {
      setSending(false)
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    // Reset so the same file can be re-attached after removal
    e.target.value = ""
    for (const file of files) {
      // Warn and skip files over 500 KB to avoid flooding the context
      if (file.size > 500 * 1024) {
        console.warn(`File "${file.name}" is too large (${Math.round(file.size / 1024)} KB); max 500 KB`)
        continue
      }
      const reader = new FileReader()
      reader.onload = () => {
        const content = typeof reader.result === "string" ? reader.result : ""
        setAttachments((prev) => [...prev, { name: file.name, content }])
      }
      reader.readAsText(file)
    }
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
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

        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {attachments.map((att, i) => (
              <span
                key={i}
                className="flex items-center gap-1 text-[11px] bg-elevated text-text-secondary rounded-md pl-2 pr-1 py-0.5 max-w-[180px]"
              >
                <Paperclip size={10} className="shrink-0 text-accent" />
                <span className="truncate" title={att.name}>{att.name}</span>
                <button
                  className="text-text-muted hover:text-error transition-colors ml-0.5 shrink-0"
                  onClick={() => removeAttachment(i)}
                  title="Remove"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Input */}
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            rows={1}
            className="flex-1 bg-base rounded-lg px-3 py-2 text-sm text-text placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent transition-all resize-none overflow-hidden"
            style={{ maxHeight: "9rem" }}
            placeholder={listening ? "Listening..." : isRunning ? "Agent is working..." : "Enter a goal..."}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              const el = e.target
              el.style.height = "auto"
              el.style.height = `${Math.min(el.scrollHeight, 144)}px`
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend() }
            }}
            disabled={sending}
          />
          {/* Hidden file input — triggered by Paperclip button */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
          <button
            className="shrink-0 flex items-center justify-center w-11 h-11 bg-elevated text-text-muted hover:text-text hover:bg-elevated/80 rounded-lg transition-colors"
            onClick={() => fileInputRef.current?.click()}
            title="Attach file"
          >
            <Paperclip size={16} />
          </button>
          {SpeechRecognition && (
            <button
              className={`shrink-0 flex items-center justify-center w-11 h-11 rounded-lg transition-colors ${
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
            className="shrink-0 flex items-center justify-center w-11 h-11 bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-40"
            onClick={handleSend}
            disabled={sending || (!input.trim() && attachments.length === 0)}
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
