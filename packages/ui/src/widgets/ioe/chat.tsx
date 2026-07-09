/**
 * IOE Chat Panel — Copilot-style conversation view of agent trace.
 * Supports simple mode (user goal → final answer) and detailed mode (full trace inline).
 */

import { AlertCircle, Brain, HelpCircle, MessageSquare, Paperclip, Send, Square, User, Wrench, X } from "lucide-react"
import type React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../../api"
import { ChatScrollProvider } from "../../components/ChatScrollContext"
import { CodeBlock, extractToolCode } from "../../components/CodeBlock"
import { ScrollToLatestButton } from "../../components/ScrollToLatestButton"
import { SmartAnswer } from "../../components/SmartAnswer"
import { StickyUserGoal } from "../../components/StickyUserGoal"
import { TypewriterAnswer } from "../../components/TypewriterAnswer"
import { ChatMode } from "../../enums"
import { useStickToBottomScroll } from "../../hooks/useStickToBottomScroll"
import { CHAT_SCROLL_HOST_ATTR } from "../../lib/chatScroll"
import { ChatComposerShell } from "../../chat/ChatComposerShell"
import { useSlashCommandInput } from "../../chat/useSlashCommandInput"
import type { ChatSlashCatalogEntry } from "../../chat/commands"
import type { CommandConsoleState } from "../../chat/useCommandConsole"
import { C, type ChatMessage } from "./constants"

export { ChatMode } from "../../enums"

interface ToolCallKillInfo {
  runId: string
  toolCallId: string
  toolName: string
}

/**
 * Metadata for a single user-uploaded attachment bound to the goal
 * input. Bytes live on the server; we keep only what the chip UI and
 * the run-start call need.
 */
export interface FileAttachment {
  id:        string
  name:      string
  sizeBytes: number
}

export function ChatPanel({
  messages,
  goalInput,
  onGoalChange,
  onSubmit,
  isRunning,
  slashOnlyMode = false,
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
  currentActivity,
  streamingAnswer,
  fileInputRef: fileInputRefProp,
  commandConsole,
  slashCommands = [],
}: {
  messages: ChatMessage[]
  goalInput: string
  onGoalChange: (v: string) => void
  onSubmit: () => void
  isRunning: boolean
  slashOnlyMode?: boolean
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
  currentActivity?: string
  streamingAnswer?: string
  fileInputRef?: React.RefObject<HTMLInputElement | null>
  commandConsole: CommandConsoleState
  slashCommands?: ChatSlashCatalogEntry[]
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const goalTextareaRef = useRef<HTMLTextAreaElement>(null)
  const slashInput = goalInput.trimStart().startsWith("/")
  const canSend = slashOnlyMode
    ? slashInput && goalInput.trim().length > 1 && !submitting
    : (Boolean(goalInput.trim()) || attachments.length > 0) && !submitting
  const showStop = isRunning && !slashInput && !pendingInput

  const collapseComposer = useCallback(() => {
    commandConsole.clear()
    onGoalChange("")
  }, [commandConsole, onGoalChange])

  const hasResult = commandConsole.pinnedOpen && commandConsole.lines.length > 0
  const { palette: slashPalette, handleKeyDown: handleSlashKeyDown } = useSlashCommandInput({
    value: goalInput,
    onChange: onGoalChange,
    commands: slashCommands,
    disabled: !!pendingInput || submitting,
    variant: "ioe",
    onCollapse: collapseComposer,
    hasResult,
  })

  const bindFileInputRef = (el: HTMLInputElement | null) => {
    fileInputRef.current = el
    if (fileInputRefProp) fileInputRefProp.current = el
  }
  const [responseInput, setResponseInput] = useState("")
  const [killMessageInput, setKillMessageInput] = useState("")
  const [chatMode, setChatMode] = useState<ChatMode>(ChatMode.Simple)

  const {
    scrollHostRef: scrollRef,
    contentRef: messagesInnerRef,
    onScroll,
    scrollToBottom,
    pauseAutoScroll,
    showJumpButton,
  } = useStickToBottomScroll({
    initialScroll: "none",
    followWhen: isRunning || Boolean(streamingAnswer),
  })

  const didInitialAnchorRef = useRef(false)

  const chatTurns = useMemo(() => {
    const visible = chatMode === ChatMode.Simple
      ? messages.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "input-request")
      : messages
    return groupChatTurns(visible)
  }, [messages, chatMode])

  useEffect(() => {
    if (chatTurns.length === 0 && !isRunning) return
    if (didInitialAnchorRef.current) return
    didInitialAnchorRef.current = true
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollToBottom("instant", { stick: isRunning || Boolean(streamingAnswer) })
      })
    })
  }, [chatTurns.length, isRunning, streamingAnswer, scrollToBottom])

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ""
    if (!onAttach || files.length === 0) return
    const results: FileAttachment[] = []
    for (const file of files) {
      // The server caps uploads at 32 MiB; warn early so the user knows
      // before the round-trip if they pick something obviously too big.
      if (file.size > 32 * 1024 * 1024) {
        console.warn(`File "${file.name}" is too large (${Math.round(file.size / 1024)} KB); max 32768 KB`)
        continue
      }
      try {
        const meta = await api.uploadAttachment(file, { scope: "user_draft" })
        results.push({ id: meta.id, name: meta.normalizedName, sizeBytes: meta.sizeBytes })
      } catch (err) {
        console.error(`Upload failed for "${file.name}":`, err)
      }
    }
    if (results.length > 0) onAttach(results)
  }
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
  const visibleMessages = chatMode === ChatMode.Simple
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
              background: chatMode === ChatMode.Simple ? C.accent + "35" : C.accent + "18",
              color: C.accent,
              border: `1px solid ${C.accent}30`,
            }}
            onClick={() => setChatMode(ChatMode.Simple)}
            title="Show only goals and answers"
          >
            Simple
          </button>
          <button
            className="px-2 py-0.5 rounded text-[13px] font-medium cursor-pointer transition-colors"
            style={{
              background: chatMode === ChatMode.Detailed ? C.accent + "35" : C.accent + "18",
              color: C.accent,
              border: `1px solid ${C.accent}30`,
            }}
            onClick={() => setChatMode(ChatMode.Detailed)}
            title="Show full trace inline"
          >
            Detailed
          </button>
        </div>
      </div>

      <ChatScrollProvider pauseAutoScroll={pauseAutoScroll} scrollHostRef={scrollRef}>
      <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollRef}
        {...{ [CHAT_SCROLL_HOST_ATTR]: "" }}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-3 py-3 min-h-0"
        style={{ overflowAnchor: "none" }}
      >
        <div ref={messagesInnerRef} className="space-y-3" style={{ overflowAnchor: "none" }}>
        {visibleMessages.length === 0 && !isRunning ? (
          <div
            className="flex flex-col items-center justify-center h-full gap-2"
            style={{ color: C.dim }}
          >
            <MessageSquare size={32} />
            <span className="text-[13px]">No conversation yet</span>
            <span className="text-[13px]">Start a run to see the agent&apos;s reasoning</span>
          </div>
        ) : (
          <>
            {chatTurns.map((turn, turnIndex) => (
              <div key={`turn-${turnIndex}`} className="relative mb-4">
                <StickyUserGoal align="start">
                  <UserGoalBubble content={turn.user.content} />
                </StickyUserGoal>
                <div className="space-y-3">
                  {turn.responses.map((msg, i) => (
                    <ChatBubble key={`${turnIndex}-${i}`} message={msg} mode={chatMode} />
                  ))}
                  {isRunning && turnIndex === chatTurns.length - 1 && !hasPending && (
                    streamingAnswer
                      ? <StreamingAnswerBubble text={streamingAnswer} activity={currentActivity} />
                      : <ActivityBubble activity={currentActivity ?? "Thinking"} />
                  )}
                </div>
              </div>
            ))}
          </>
        )}
        </div>
      </div>

      {showJumpButton && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
          <div className="pointer-events-auto">
            <ScrollToLatestButton onClick={() => scrollToBottom("instant", { stick: false })} />
          </div>
        </div>
      )}
      </div>
      </ChatScrollProvider>

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
                  background: "color-mix(in oklab, var(--color-error) 12%, transparent)",
                  color: "var(--color-error)",
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
        <div className="shrink-0 px-3 py-2" style={{ borderTop: `1px solid color-mix(in oklab, var(--color-error) 38%, transparent)`, background: "color-mix(in oklab, var(--color-error) 6%, transparent)" }}>
          <div className="text-[12px] mb-1.5" style={{ color: "var(--color-error)" }}>
            Kill <span className="font-mono font-medium">{pendingKill.toolName}</span> — provide a steering message:
          </div>
          <div
            className="flex items-center gap-2 rounded-lg px-3 py-2"
            style={{ background: C.elevated, border: "1px solid #ef444460" }}
          >
            <input
              type="text"
              className="flex-1 bg-transparent outline-none text-[13px]"
              style={{ color: C.text, caretColor: "var(--color-error)" }}
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
              style={{ background: "color-mix(in oklab, var(--color-error) 12%, transparent)", color: "var(--color-error)", border: "1px solid #ef444440" }}
              onClick={() => { onKillToolCall(null); setKillMessageInput("") }}
            >
              Cancel
            </button>
            <button
              className="p-1 rounded transition-colors cursor-pointer hover:bg-overlay-3"
              style={{ color: "var(--color-error)" }}
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
                className="p-1 rounded transition-colors cursor-pointer hover:bg-overlay-3"
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
            {!slashOnlyMode && attachments.length > 0 && (
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
              className="composer-input-shell overflow-hidden rounded-lg"
              style={{ background: C.elevated, border: `1px solid ${C.border}` }}
            >
            <ChatComposerShell console={commandConsole} slashPalette={slashPalette} variant="ioe" density="compact">
            <div className="flex items-end gap-2 px-3 py-2">
              <textarea
                ref={goalTextareaRef}
                rows={1}
                autoComplete="off"
                spellCheck={false}
                className="flex-1 min-w-0 bg-transparent outline-none text-[13px] resize-none overflow-hidden"
                  style={{ color: C.text, caretColor: C.accent, maxHeight: "9rem" }}
                  placeholder={
                    pendingInput
                      ? "Respond in the prompt above ↑"
                      : slashOnlyMode
                        ? "Type /cancel, /trace, /status…"
                        : "Enter a goal or press / for commands"
                  }
                  value={goalInput}
                  onChange={(e) => {
                    onGoalChange(e.target.value)
                    const el = e.target
                    el.style.height = "auto"
                    el.style.height = `${Math.min(el.scrollHeight, 144)}px`
                  }}
                  onKeyDown={(e) => {
                    if (handleSlashKeyDown(e)) return
                    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit() }
                  }}
                  disabled={!!pendingInput || submitting}
                />
              {/* Hidden file input */}
              <input ref={bindFileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
              {onAttach && !slashOnlyMode && (
                <button
                  className="p-1 rounded transition-colors cursor-pointer hover:bg-overlay-3"
                  style={{ color: C.dim }}
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach file"
                >
                  <Paperclip size={14} />
                </button>
              )}
              <button
                className="p-1 rounded transition-colors cursor-pointer hover:bg-overlay-3"
                style={{ color: canSend ? C.accent : C.dim }}
                onClick={onSubmit}
                disabled={!canSend && !showStop}
              >
                <Send size={16} />
              </button>
            </div>
            </ChatComposerShell>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function groupChatTurns(messages: ChatMessage[]): Array<{ user: ChatMessage; responses: ChatMessage[] }> {
  const turns: Array<{ user: ChatMessage; responses: ChatMessage[] }> = []
  let current: { user: ChatMessage; responses: ChatMessage[] } | null = null

  for (const msg of messages) {
    if (msg.role === "user") {
      if (current) turns.push(current)
      current = { user: msg, responses: [] }
    } else if (current) {
      current.responses.push(msg)
    }
  }
  if (current) turns.push(current)
  return turns
}

function UserGoalBubble({ content }: { content: string }) {
  return (
    <div className="flex items-start gap-2 max-w-full">
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
        {content}
      </div>
    </div>
  )
}

function ChatBubble({ message: msg }: { message: ChatMessage; mode: ChatMode }) {
  if (msg.role === "user") {
    return <UserGoalBubble content={msg.content} />
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
          className="flex-1 min-w-0 rounded-lg px-3 py-2"
          style={{ background: C.base, border: `1px solid ${C.border}` }}
        >
          <SmartAnswer text={msg.content} />
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
    // Tool-call message (has toolName): show code extracted from args, or args summary
    if (msg.toolName) {
      const extracted = msg.argsFormatted ? extractToolCode(msg.toolName, msg.argsFormatted) : null
      return (
        <div className="flex items-start gap-2 pl-9">
          <Wrench size={14} className="shrink-0 mt-1" style={{ color: C.warning }} />
          <div className="flex-1 min-w-0 space-y-1">
            <div className="text-[12px] font-mono font-semibold" style={{ color: C.warning }}>
              {msg.toolName}
            </div>
            {extracted ? (
              <CodeBlock code={extracted.code} lang={extracted.lang} maxHeight={180} />
            ) : (
              // Render the FULL argsFormatted JSON inside a scroll-capped
              // pre block instead of truncating at 420 chars. Truncation
              // hid the actual command/query the agent dispatched (e.g.
              // long SQL, multi-line `command` strings) — defeating the
              // whole point of the tool-call card.
              <pre
                className="rounded-lg px-3 py-2 text-[12px] font-mono whitespace-pre-wrap break-words overflow-auto"
                style={{ background: C.elevated, color: C.muted, border: `1px solid ${C.border}`, maxHeight: 180 }}
              >
                {msg.argsFormatted ?? msg.content}
              </pre>
            )}
          </div>
        </div>
      )
    }
    // Tool-result message (no toolName): render with SmartAnswer for tables/markdown support
    return (
      <div className="flex items-start gap-2 pl-9">
        <span className="w-1 h-1 rounded-full shrink-0 mt-2" style={{ background: C.success + "80" }} />
        <div
          className="flex-1 min-w-0 rounded px-2 py-1.5 text-[13px]"
          style={{ background: C.elevated, border: `1px solid ${C.border}` }}
        >
          <SmartAnswer text={msg.content.length > 6000 ? msg.content.slice(0, 6000) + "\n…(truncated)" : msg.content} />
        </div>
      </div>
    )
  }
  // system
  return (
    <div className="flex items-start gap-2 pl-9">
      <AlertCircle size={14} className="shrink-0 mt-1" style={{ color: systemTone(msg.content).icon }} />
      <div
        className="flex-1 min-w-0 rounded-lg px-3 py-2"
        style={{
          background: systemTone(msg.content).bg,
          border: `1px solid ${systemTone(msg.content).border}`,
        }}
      >
        <div className="flex items-center gap-2 mb-1">
          <span
            className="text-[10px] font-semibold uppercase tracking-[0.12em] px-1.5 py-0.5 rounded-full"
            style={{ color: systemTone(msg.content).label, background: systemTone(msg.content).pill }}
          >
            {systemTone(msg.content).title}
          </span>
        </div>
        <div className="text-[13px] whitespace-pre-wrap" style={{ color: C.textSecondary }}>
          {msg.content}
        </div>
      </div>
    </div>
  )
}

function systemTone(content: string) {
  const text = content.toLowerCase()
  if (text.startsWith("error") || text.includes("failed")) {
    return { title: "Issue", icon: C.coral, label: C.coral, bg: `${C.coral}12`, border: `${C.coral}35`, pill: `${C.coral}18` }
  }
  if (text.startsWith("planner") || text.startsWith("plan generated") || text.startsWith("pipeline") || text.startsWith("verification")) {
    return { title: "Planner", icon: C.accent, label: C.accentHover, bg: `${C.accent}12`, border: `${C.accent}30`, pill: `${C.accent}18` }
  }
  if (text.startsWith("delegat")) {
    return { title: "Delegation", icon: C.warning, label: C.warning, bg: `${C.warning}12`, border: `${C.warning}30`, pill: `${C.warning}18` }
  }
  if (text.startsWith("workspace diff")) {
    return { title: "Workspace", icon: C.success, label: C.success, bg: `${C.success}12`, border: `${C.success}30`, pill: `${C.success}18` }
  }
  return { title: "System", icon: C.dim, label: C.textSecondary, bg: C.elevated, border: C.borderSolid, pill: "rgba(255,255,255,0.06)" }
}

function StreamingAnswerBubble({ text, activity }: { text: string; activity?: string }) {
  const label = (activity ?? "Writing response").charAt(0).toUpperCase() + (activity ?? "Writing response").slice(1).replace(/\.+$/, "")
  return (
    <div className="flex items-start gap-2">
      <div
        className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
        style={{ background: C.accent + "18" }}
      >
        <Brain size={14} style={{ color: C.accent }} />
      </div>
      <div
        className="flex-1 min-w-0 rounded-lg px-3 py-2 space-y-2"
        style={{ background: C.base, border: `1px solid ${C.border}` }}
      >
        <TypewriterAnswer text={text} streaming />
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: C.accent + "90" }} />
          <span
            className="activity-shimmer font-mono text-[11px]"
            style={{ "--sa": "var(--color-text-secondary)", "--sd": "var(--color-text-muted)" } as React.CSSProperties}
          >
            {label}
          </span>
        </div>
      </div>
    </div>
  )
}

function ActivityBubble({ activity }: { activity: string }) {
  const label = activity.charAt(0).toUpperCase() + activity.slice(1).replace(/\.+$/, "")
  return (
    <div className="flex items-center gap-2 py-0.5">
      <span
        className="shrink-0 w-1.5 h-1.5 rounded-full"
        style={{ background: C.accent + "90" }}
      />
      <span
        className="activity-shimmer font-mono text-[13px]"
        style={{ "--sa": "var(--color-text-secondary)", "--sd": "var(--color-text-muted)" } as React.CSSProperties}
      >
        {label}
      </span>
    </div>
  )
}
