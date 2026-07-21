/**
 * Trace DAG types + builders — façade over lib/events (outline + bodies).
 * Widgets import from here; kind switches live in lib/events only.
 */

export {
  buildTraceDag,
  historyRowLabel,
  replyHeadline,
  searchCall,
  messagePreview,
  type TraceSqlQuality,
  type TraceToolCall,
  type TracePromptMessage,
  type TraceCallNode,
  type TracePhaseDetail,
  type TracePhaseChild,
  type TracePhaseNode,
  type TraceWorkNote,
  type TraceWorkNode,
  type TraceSpineEntry,
  type TracePreamble,
  type TraceDagStats,
  type TraceDag,
  type TraceCallSearchHit,
} from "../../lib/events/build-trace-view"
