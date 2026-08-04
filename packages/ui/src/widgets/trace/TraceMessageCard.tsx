/**
 * Structured message card — role badge + body for trace payload streams.
 */

import type { TracePromptMessage } from "../../lib/events/build-trace-view"
import { ExpandableText } from "./TraceExpandable"

export type TraceMessageCardRole = "user" | "answer" | "agent" | "tool" | "system"

function roleFromMessage(msg: Pick<TracePromptMessage, "speaker" | "role">): TraceMessageCardRole {
  if (msg.speaker === "User answer") return "answer"
  if (msg.speaker === "Tool result" || msg.role === "tool") return "tool"
  if (msg.speaker === "User" || msg.role === "user") return "user"
  if (msg.speaker === "System" || msg.role === "system") return "system"
  return "agent"
}

function roleBadgeLabel(role: TraceMessageCardRole): string {
  switch (role) {
    case "user":
      return "User"
    case "answer":
      return "User answer"
    case "agent":
      return "Agent"
    case "tool":
      return "Tool result"
    case "system":
      return "System"
  }
}

export function TraceMessageCard({
  speaker,
  role,
  detail,
  content,
  mono = false,
}: {
  speaker?: string
  role: TraceMessageCardRole
  detail?: string | null
  content: string | null
  mono?: boolean
}) {
  const badge = speaker ?? roleBadgeLabel(role)
  const trimmed = content?.trim() ?? ""
  const isEmpty = trimmed.length === 0

  return (
    <article className={`trace-message-card is-${role}`}>
      <header className="trace-message-card__header">
        <span className="trace-message-card__role">{badge}</span>
        {detail ? (
          <span className="trace-message-card__meta font-mono">{detail}</span>
        ) : null}
      </header>
      <div
        className={`trace-message-card__body${mono || role === "tool" || role === "system" ? " is-mono" : ""}${isEmpty ? " is-empty" : ""}`}
      >
        {isEmpty ? (
          <span className="trace-message-card__empty">empty</span>
        ) : (
          <ExpandableText text={trimmed} className="trace-message-card__text" />
        )}
      </div>
    </article>
  )
}

export function TraceMessageCardFromPrompt({ msg }: { msg: TracePromptMessage }) {
  const role = roleFromMessage(msg)
  return (
    <TraceMessageCard
      speaker={msg.speaker}
      role={role}
      detail={msg.detail ?? null}
      content={msg.content}
      mono={role === "tool" || role === "system"}
    />
  )
}

export function TracePayloadStream({ messages }: { messages: TracePromptMessage[] }) {
  if (messages.length === 0) {
    return <p className="trace-empty">No messages recorded</p>
  }
  return (
    <div className="trace-payload-stream">
      {messages.map((msg, index) => (
        <TraceMessageCardFromPrompt key={`${msg.role}-${msg.speaker}-${index}`} msg={msg} />
      ))}
    </div>
  )
}
