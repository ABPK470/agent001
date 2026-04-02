/**
 * IOE Chat Panel — Copilot-style conversation view of agent trace.
 */

import { AlertCircle, HelpCircle, MessageSquare, Send, User, Wrench } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { truncate } from "../../util"
import { C, type ChatMessage } from "./constants"

export function ChatPanel({
  messages,
  goalInput,
  onGoalChange,
  onSubmit,
  isRunning,
  submitting,
  pendingInput,
  onRespond,
}: {
  messages: ChatMessage[]
  goalInput: string
  onGoalChange: (v: string) => void
  onSubmit: () => void
  isRunning: boolean
  submitting: boolean
  pendingInput?: { question: string; options?: string[]; sensitive?: boolean } | null
  onRespond?: (response: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [responseInput, setResponseInput] = useState("")
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages.length, pendingInput])

  const hasPending = !!pendingInput && !!onRespond

  const handleRespond = () => {
    if (!hasPending || !responseInput.trim()) return
    onRespond!(responseInput.trim())
    setResponseInput("")
  }

  return (
    <div className="flex flex-col h-full" style={{ background: C.surface }}>
      <div
        className="shrink-0 px-3 py-2 text-[13px] font-semibold flex items-center gap-2"
        style={{ borderBottom: `1px solid ${C.borderSolid}`, color: C.text }}
      >
        <MessageSquare size={16} style={{ color: C.accent }} />
        Chat
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">
        {messages.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center h-full gap-2"
            style={{ color: C.dim }}
          >
            <MessageSquare size={32} />
            <span className="text-[13px]">No conversation yet</span>
            <span className="text-[13px]">Start a run to see the agent&apos;s reasoning</span>
          </div>
        ) : (
          messages.map((msg, i) => <ChatBubble key={i} message={msg} />)
        )}
      </div>

      {/* Input area — switches between goal entry and response entry */}
      <div className="shrink-0 px-3 py-2" style={{ borderTop: `1px solid ${C.borderSolid}` }}>
        {hasPending ? (
          <div className="space-y-2">
            {pendingInput!.options && pendingInput!.options.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {pendingInput!.options.map((opt, i) => (
                  <button
                    key={i}
                    className="px-2 py-1 rounded text-[12px] cursor-pointer transition-colors"
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
                className="p-1 rounded transition-colors cursor-pointer"
                style={{ color: responseInput.trim() ? C.accent : C.dim }}
                onClick={handleRespond}
                disabled={!responseInput.trim()}
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        ) : (
          <div
            className="flex items-center gap-2 rounded-lg px-3 py-2"
            style={{ background: C.elevated, border: `1px solid ${C.border}` }}
          >
            <input
              type="text"
              className="flex-1 bg-transparent outline-none text-[13px]"
              style={{ color: C.text, caretColor: C.accent }}
              placeholder={isRunning ? "Agent is running..." : "Enter a goal..."}
              value={goalInput}
              onChange={(e) => onGoalChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSubmit()
              }}
              disabled={isRunning || submitting}
            />
            <button
              className="p-1 rounded transition-colors"
              style={{ color: goalInput.trim() ? C.accent : C.dim }}
              onClick={onSubmit}
              disabled={isRunning || submitting || !goalInput.trim()}
            >
              <Send size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function ChatBubble({ message: msg }: { message: ChatMessage }) {
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
