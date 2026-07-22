export type {
  EventAtom,
  EventAtomSource,
  OutlineNode,
  OutlineNodeKind,
  ViewOutlineRole,
  ViewSpec,
  ViewSpecNestRule,
  FlatLogRow,
} from "./types"
export { resolveOutlineRole, isStickyInView } from "./types"
export { atomFromTraceEntry, atomsFromTrace, atomFromSse } from "./normalize"
export {
  buildOutline,
  TRACE_VIEW_SPEC,
  PIPELINES_TRACE_VIEW_SPEC,
} from "./build-outline"
export { buildFlatLog, flatRowFromAtom, FLAT_LOG_VIEW_SPEC } from "./build-flat-log"
export {
  OUTLINE_STICKY_ROW_H,
  OUTLINE_STICKY_MAX,
  OUTLINE_PIN_FAMILIES,
  layoutOffsetInScroll,
  listOutlineScopes,
  withScopeEnds,
  computePinnedFromEntries,
  computePinnedScopeIds,
  samePinnedIds,
  syncPinnedInFlow,
  type PinComputeOpts,
} from "./pin"
export {
  buildTraceDag,
  historyRowLabel,
  replyHeadline,
  searchCall,
  messagePreview,
} from "./build-trace-view"
export type {
  TraceSqlQuality,
  TraceToolCall,
  TracePromptMessage,
  TraceCallNode,
  TracePhaseDetail,
  TracePhaseChild,
  TracePhaseNode,
  TraceWorkNote,
  TraceWorkNode,
  TraceSpineEntry,
  TracePreamble,
  TraceDagStats,
  TraceDag,
  TraceCallSearchHit,
} from "./build-trace-view"
export {
  buildResponseParts,
  CHAT_VIEW_SPEC,
  PRIMARY_ACTIVITY_IDS,
  extractToolTarget,
  buildToolNarrative,
  buildIterationHeader,
  compactToolPreview,
  humanizeStepName,
} from "./build-chat-parts"
export type {
  ToolRow,
  ResponseProgressPart,
  ResponseToolPart,
  ResponseIterationPart,
  ResponsePlanPart,
  ResponseStepBlockPart,
  ResponseMarkdownPart,
  ResponseNarrativePart,
  ResponseInputPart,
  ResponseErrorPart,
  ResponseSyncProgressPart,
  ResponsePart,
} from "./build-chat-parts"
