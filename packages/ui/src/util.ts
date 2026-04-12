/** Utility functions. */

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function truncate(str: string | null | undefined, len: number): string {
  if (!str) return ""
  return str.length > len ? str.slice(0, len) + "..." : str
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

export function statusColor(status: string): string {
  switch (status) {
    case "completed": return "var(--color-success)"
    case "failed": return "var(--color-error)"
    case "running": case "pending": case "planning": return "var(--color-accent)"
    case "cancelled": return "var(--color-warning)"
    default: return "var(--color-text-muted)"
  }
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function remediationHintForValidationCode(code?: string): string {
  if (!code) return "Address the reported step failure and re-run deterministic verification before completion."
  switch (code) {
    case "empty_output":
      return "Produce substantive output with concrete implementation evidence."
    case "empty_structured_payload":
      return "Return a real payload, not empty/null/placeholder values."
    case "missing_successful_tool_evidence":
      return "Use tools successfully (read/write/run) and include the evidence in the result."
    case "missing_file_mutation_evidence":
      return "Create or modify the declared target files, not just narrative output."
    case "missing_file_artifact_evidence":
      return "List the concrete file paths that were created or modified."
    case "missing_workspace_inspection_evidence":
    case "missing_required_source_evidence":
      return "Read required source files before editing and show that evidence."
    case "missing_target_artifact_coverage":
      return "Modify the exact declared target artifacts for this step."
    case "missing_executable_verification_evidence":
      return "Run deterministic checks (runtime/tests/build) or post-write inspections before completion."
    case "acceptance_evidence_missing":
      return "Resolve placeholder/incomplete logic and satisfy acceptance requirements with concrete evidence."
    case "contradictory_completion_claim":
      return "Do not claim completion while unresolved TODO/FIXME/placeholder work remains."
    case "low_signal_browser_evidence":
      return "Use meaningful browser checks against real artifacts, not low-signal actions."
    case "all_tools_failed":
      return "Fix tool arguments and recover from failing tool calls before proceeding."
    case "unresolved_handoff_output":
      return "Complete the step end-to-end; do not return partial handoff states."
    case "blocked_phase_output":
      return "Find a workaround path and continue execution instead of returning blocked status."
    case "unresolved_artifact_references":
      return "Create referenced local artifacts (or correct references) before completion."
    default:
      return "Address the validation failure and provide objective completion evidence."
  }
}
