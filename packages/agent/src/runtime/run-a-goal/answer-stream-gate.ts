/**
 * Gates live answer streaming so intermediate LLM prose (pre-tool narration)
 * never appears in the user-facing answer bubble.
 *
 * Tool-capable responses are buffered silently until the complete response is
 * known to contain no tool calls and passes completion guards. A tool-free
 * response may stream live because it cannot turn into an intermediate tool
 * round. Once text is visible, it must never be revoked.
 *
 * The approved answer is released as incremental chunks so the UI can render
 * it with the live ASCII-glyph streaming effect — the reveal targets a natural
 * ~2s window regardless of length (long answers use larger chunks, short ones
 * smaller), keeping the glyph shimmer perceptible without dragging on.
 */

const MIN_CHUNK = 2
const MAX_CHUNK = 28
const PACE_MS = 20
const TARGET_REVEAL_MS = 2000

function chunkSizeFor(text: string): number {
  if (!text) return MIN_CHUNK
  const steps = Math.max(1, Math.round(TARGET_REVEAL_MS / PACE_MS))
  const size = Math.ceil(text.length / steps)
  return Math.min(MAX_CHUNK, Math.max(MIN_CHUNK, size))
}

export function emitAnswerChunks(text: string, onToken?: (chunk: string) => void): void {
  if (!text || !onToken) return
  const size = chunkSizeFor(text)
  for (let i = 0; i < text.length; i += size) {
    onToken(text.slice(i, i + size))
  }
}

export async function emitAnswerChunksPaced(
  text: string,
  onToken?: (chunk: string) => void,
  paceMs = PACE_MS
): Promise<void> {
  if (!text || !onToken) return
  const size = chunkSizeFor(text)
  for (let i = 0; i < text.length; i += size) {
    onToken(text.slice(i, i + size))
    if (i + size < text.length && paceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, paceMs))
    }
  }
}

export interface AnswerStreamGate {
  onTokenDelta(token: string): void
  onToolCallStarted(): void
  flushApproved(text: string): Promise<void>
  discard(): void
}

export function createAnswerStreamGate(opts: {
  /**
   * When false, buffer tokens until flushApproved (first iteration before tools).
   * When true, forward tokens live to the answer bubble.
   */
  allowLiveStream: boolean
  onToken?: (chunk: string) => void
  onStreamDiscard?: () => void
}): AnswerStreamGate {
  let active = true
  let discarded = false
  let streamed = ""
  let buffer = ""

  const discard = () => {
    const hadVisibleText = streamed.length > 0
    buffer = ""
    if (!active || discarded) return
    discarded = true
    active = false
    streamed = ""
    // Buffered drafts were never visible, so emitting stream.reset would
    // incorrectly erase an answer owned by another phase/gate.
    if (hadVisibleText) opts.onStreamDiscard?.()
  }

  return {
    onTokenDelta(token) {
      if (!active || discarded) return
      if (opts.allowLiveStream) {
        streamed += token
        opts.onToken?.(token)
        return
      }
      buffer += token
    },

    onToolCallStarted() {
      discard()
    },

    async flushApproved(text) {
      if (!active || discarded) return
      active = false

      if (!text) {
        buffer = ""
        return
      }

      if (opts.allowLiveStream) {
        if (streamed.length === 0) {
          await emitAnswerChunksPaced(text, opts.onToken)
          return
        }
        if (text === streamed) return
        if (text.startsWith(streamed)) {
          const suffix = text.slice(streamed.length)
          if (suffix) await emitAnswerChunksPaced(suffix, opts.onToken)
          return
        }
        // Provider token streams should equal response.content. If they do
        // not, never erase text the user has already read. The authoritative
        // completed answer will reconcile on run completion.
        return
      }

      buffer = ""
      streamed = ""
      await emitAnswerChunksPaced(text, opts.onToken)
    },

    discard
  }
}
