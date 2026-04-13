/**
 * IOE Chat Panel — Copilot-style conversation view of agent trace.
 * Supports simple mode (user goal → final answer) and detailed mode (full trace inline).
 */

import { AlertCircle, Brain, HelpCircle, MessageSquare, Paperclip, Send, Square, User, Wrench, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { truncate } from "../../util"
import { C, type ChatMessage } from "./constants"

export type ChatMode = "simple" | "detailed"

interface ToolCallKillInfo {
  runId: string
  toolCallId: string
  toolName: string
}

export interface FileAttachment { name: string; content: string }

export function ChatPanel({
  messages,
  goalInput,
  onGoalChange,
  onSubmit,
  isRunning,
  submitting,
  pendingInput,
  onRespond,
  executingToolCalls,
  pendingKill,
  onKillToolCall,
  onSubmitKill,
  attachments = [],
  onAttach,
  onRemoveAttachment,
}: {
  messages: ChatMessage[]
  goalInput: string
  onGoalChange: (v: string) => void
  onSubmit: () => void
  isRunning: boolean
  submitting: boolean
  pendingInput?: { question: string; options?: string[]; sensitive?: boolean } | null
  onRespond?: (response: string) => void
  executingToolCalls?: Map<string, ToolCallKillInfo>
  pendingKill?: ToolCallKillInfo | null
  onKillToolCall?: (info: ToolCallKillInfo | null) => void
  onSubmitKill?: (message: string) => void
  attachments?: FileAttachment[]
  onAttach?: (files: FileAttachment[]) => void
  onRemoveAttachment?: (index: number) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const goalTextareaRef = useRef<HTMLTextAreaElement>(null)
  const [responseInput, setResponseInput] = useState("")
  const [killMessageInput, setKillMessageInput] = useState("")
  const [chatMode, setChatMode] = useState<ChatMode>("simple")

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ""
    if (!onAttach) return
    const results: FileAttachment[] = []
    let pending = files.length
    if (pending === 0) return
    for (const file of files) {
      if (file.size > 500 * 1024) { pending--; continue }
      const reader = new FileReader()
      reader.onload = () => {
        results.push({ name: file.name, content: typeof reader.result === "string" ? reader.result : "" })
        if (--pending === 0) onAttach(results)
      }
      reader.readAsText(file)
    }
  }
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages.length, pendingInput])

  // Reset textarea height when goalInput is cleared externally (e.g. after submit)
  useEffect(() => {
    if (!goalInput && goalTextareaRef.current) goalTextareaRef.current.style.height = "auto"
  }, [goalInput])

  const hasPending = !!pendingInput && !!onRespond

  const handleRespond = () => {
    if (!hasPending || !responseInput.trim()) return
    onRespond!(responseInput.trim())
    setResponseInput("")
  }

  const handleSubmitKillMsg = () => {
    if (!pendingKill || !onSubmitKill) return
    onSubmitKill(killMessageInput.trim())
    setKillMessageInput("")
  }

  const hasExecutingTools = executingToolCalls && executingToolCalls.size > 0 && !pendingKill

  // In simple mode, show only user goals and final assistant answers
  const visibleMessages = chatMode === "simple"
    ? messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "input-request")
    : messages

  return (
    <div className="flex flex-col h-full" style={{ background: C.surface }}>
      {/* Header with mode toggle */}
      <div
        className="shrink-0 h-9 px-3 text-[13px] font-semibold flex items-center gap-2"
        style={{ borderBottom: `1px solid ${C.borderSolid}`, color: C.text }}
      >
        <MessageSquare size={16} style={{ color: C.accent }} />
        <span>Chat</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            className="px-2 py-0.5 rounded text-[13px] font-medium cursor-pointer transition-colors"
            style={{
              background: chatMode === "simple" ? C.accent + "35" : C.accent + "18",
              color: C.accent,
              border: `1px solid ${C.accent}30`,
            }}
            onClick={() => setChatMode("simple")}
            title="Show only goals and answers"
          >
            Simple
          </button>
          <button
            className="px-2 py-0.5 rounded text-[13px] font-medium cursor-pointer transition-colors"
            style={{
              background: chatMode === "detailed" ? C.accent + "35" : C.accent + "18",
              color: C.accent,
              border: `1px solid ${C.accent}30`,
            }}
            onClick={() => setChatMode("detailed")}
            title="Show full trace inline"
          >
            Detailed
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">
        {visibleMessages.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center h-full gap-2"
            style={{ color: C.dim }}
          >
            <MessageSquare size={32} />
            <span className="text-[13px]">No conversation yet</span>
            <span className="text-[13px]">Start a run to see the agent&apos;s reasoning</span>
          </div>
        ) : (
          visibleMessages.map((msg, i) => <ChatBubble key={i} message={msg} mode={chatMode} />)
        )}
      </div>

      {/* Executing tool calls — kill bar */}
      {hasExecutingTools && onKillToolCall && (
        <div className="shrink-0 px-3 py-1.5" style={{ borderTop: `1px solid ${C.borderSolid}`, background: C.elevated + "80" }}>
          <div className="text-[11px] font-mono mb-1" style={{ color: C.dim }}>Executing tools:</div>
          <div className="flex flex-wrap gap-1">
            {[...executingToolCalls.values()].map((tc) => (
              <button
                key={tc.toolCallId}
                className="flex items-center gap-1 px-2 py-1 rounded text-[12px] cursor-pointer transition-colors hover:brightness-125"
                style={{
                  background: "#ef444420",
                  color: "#ef4444",
                  border: "1px solid #ef444440",
                }}
                onClick={() => onKillToolCall(tc)}
                title={`Kill ${tc.toolName}`}
              >
                <Square size={10} />
                {tc.toolName}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Kill message dialog */}
      {pendingKill && onSubmitKill && onKillToolCall && (
        <div className="shrink-0 px-3 py-2" style={{ borderTop: `1px solid #ef444460`, background: "#ef444410" }}>
          <div className="text-[12px] mb-1.5" style={{ color: "#ef4444" }}>
            Kill <span className="font-mono font-medium">{pendingKill.toolName}</span> — provide a steering message:
          </div>
          <div
            className="flex items-center gap-2 rounded-lg px-3 py-2"
            style={{ background: C.elevated, border: "1px solid #ef444460" }}
          >
            <input
              type="text"
              className="flex-1 bg-transparent outline-none text-[13px]"
              style={{ color: C.text, caretColor: "#ef4444" }}
              placeholder="e.g. Skip this, try a different approach..."
              value={killMessageInput}
              onChange={(e) => setKillMessageInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmitKillMsg()
                if (e.key === "Escape") { onKillToolCall(null); setKillMessageInput("") }
              }}
              autoFocus
            />
            <button
              className="px-2 py-1 rounded text-[12px] cursor-pointer transition-colors hover:brightness-125"
              style={{ background: "#ef444420", color: "#ef4444", border: "1px solid #ef444440" }}
              onClick={() => { onKillToolCall(null); setKillMessageInput("") }}
            >
              Cancel
            </button>
            <button
              className="p-1 rounded transition-colors cursor-pointer hover:bg-white/10"
              style={{ color: "#ef4444" }}
              onClick={handleSubmitKillMsg}
            >
              <Send size={16} />
            </button>
          </div>
        </div>
      )}

      {/* Input area — switches between goal entry and response entry */}
      <div className="shrink-0 px-3 py-2" style={{ borderTop: `1px solid ${C.borderSolid}` }}>
        {hasPending ? (
          <div className="space-y-2">
            {pendingInput!.options && pendingInput!.options.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {pendingInput!.options.map((opt, i) => (
                  <button
                    key={i}
                    className="px-2 py-1 rounded text-[12px] cursor-pointer transition-colors hover:brightness-125"
                    style={{
                      background: C.accent + "20",
                      color: C.accent,
                      border: `1px solid ${C.accent}40`,
                    }}
                    onClick={() => { onRespond!(opt) }}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}
            <div
              className="flex items-center gap-2 rounded-lg px-3 py-2"
              style={{ background: C.elevated, border: `1px solid ${C.accent}60` }}
            >
              <input
                type={pendingInput!.sensitive ? "password" : "text"}
                className="flex-1 bg-transparent outline-none text-[13px]"
                style={{ color: C.text, caretColor: C.accent }}
                placeholder="Type your response..."
                value={responseInput}
                onChange={(e) => setResponseInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleRespond() }}
                autoFocus
              />
              <button
                className="p-1 rounded transition-colors cursor-pointer hover:bg-white/10"
                style={{ color: responseInput.trim() ? C.accent : C.dim }}
                onClick={handleRespond}
                disabled={!responseInput.trim()}
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            {/* Attachment chips */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {attachments.map((att, i) => (
                  <span
                    key={i}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] max-w-[160px]"
                    style={{ background: C.elevated, color: C.text, border: `1px solid ${C.border}` }}
                  >
                    <Paperclip size={9} style={{ color: C.accent, flexShrink: 0 }} />
                    <span className="truncate" title={att.name}>{att.name}</span>
                    {onRemoveAttachment && (
                      <button
                        className="ml-0.5"
                        style={{ color: C.dim, flexShrink: 0 }}
                        onClick={() => onRemoveAttachment(i)}
                        title="Remove"
                      >
                        <X size={10} />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
            <div
              className="flex items-end gap-2 rounded-lg px-3 py-2"
              style={{ background: C.elevated, border: `1px solid ${C.border}` }}
            >
              <textarea
                ref={goalTextareaRef}
                rows={1}
                className="flex-1 bg-transparent outline-none text-[13px] resize-none overflow-hidden"
                style={{ color: C.text, caretColor: C.accent, maxHeight: "9rem" }}
                placeholder={isRunning ? "Agent is running..." : "Enter a goal..."}
                value={goalInput}
                onChange={(e) => {
                  onGoalChange(e.target.value)
                  const el = e.target
                  el.style.height = "auto"
                  el.style.height = `${Math.min(el.scrollHeight, 144)}px`
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit() }
                }}
                disabled={isRunning || submitting}
              />
              {/* Hidden file input */}
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
              {onAttach && (
                <button
                  className="p-1 rounded transition-colors cursor-pointer hover:bg-white/10"
                  style={{ color: C.dim }}
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach file"
                >
                  <Paperclip size={14} />
                </button>
              )}
              <button
                className="p-1 rounded transition-colors cursor-pointer hover:bg-white/10"
                style={{ color: (goalInput.trim() || attachments.length > 0) ? C.accent : C.dim }}
                onClick={onSubmit}
                disabled={isRunning || submitting || (!goalInput.trim() && attachments.length === 0)}
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ChatBubble({ message: msg }: { message: ChatMessage; mode: ChatMode }) {
  if (msg.role === "user") {
    return (
      <div className="flex items-start gap-2">
        <div
          className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
          style={{ background: C.accent + "30" }}
        >
          <User size={14} style={{ color: C.accent }} />
        </div>
        <div
          className="flex-1 rounded-lg px-3 py-2 text-[13px]"
          style={{ background: C.elevated, color: C.text }}
        >
          {msg.content}
        </div>
      </div>
    )
  }
  if (msg.role === "thinking") {
    return (
      <div className="flex items-start gap-2">
        <div
          className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
          style={{ background: C.accent + "20" }}
        >
          <Brain size={14} style={{ color: C.accent }} />
        </div>
        <div
          className="flex-1 rounded-lg px-3 py-2 text-[13px] whitespace-pre-wrap"
          style={{ background: C.accent + "08", color: C.muted, border: `1px solid ${C.accent}20` }}
        >
          {msg.content}
        </div>
      </div>
    )
  }
  if (msg.role === "assistant") {
    return (
      <div className="flex items-start gap-2">
        <div
          className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
          style={{ background: C.success + "30" }}
        >
          <MessageSquare size={14} style={{ color: C.success }} />
        </div>
        <div
          className="flex-1 rounded-lg px-3 py-2 text-[13px] whitespace-pre-wrap"
          style={{ background: C.base, color: C.textSecondary, border: `1px solid ${C.border}` }}
        >
          {msg.content}
        </div>
      </div>
    )
  }
  if (msg.role === "input-request") {
    return (
      <div className="flex items-start gap-2">
        <div
          className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
          style={{ background: C.warning + "30" }}
        >
          <HelpCircle size={14} style={{ color: C.warning }} />
        </div>
        <div
          className="flex-1 rounded-lg px-3 py-2 text-[13px] whitespace-pre-wrap"
          style={{ background: C.warning + "10", color: C.text, border: `1px solid ${C.warning}40` }}
        >
          {msg.content}
        </div>
      </div>
    )
  }
  if (msg.role === "tool") {
    return (
      <div className="flex items-start gap-2 pl-9">
        <Wrench size={14} className="shrink-0 mt-1" style={{ color: C.warning }} />
        <div
          className="flex-1 rounded px-2 py-1.5 text-[13px] font-mono break-all"
          style={{ background: C.elevated, color: C.muted, border: `1px solid ${C.border}` }}
        >
          {msg.toolName && <span style={{ color: C.warning }}>{msg.toolName} </span>}
          {truncate(msg.content, 300)}
        </div>
      </div>
    )
  }
  // system
  return (
    <div className="flex items-start gap-2 pl-9">
      <AlertCircle size={14} className="shrink-0 mt-1" style={{ color: C.coral }} />
      <div className="text-[13px]" style={{ color: C.muted }}>
        {msg.content}
      </div>
    </div>
  )
}
