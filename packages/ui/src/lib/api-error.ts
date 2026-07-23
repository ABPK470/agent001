/**
 * Single user-facing formatter for API / thrown failures shown in toasts.
 * Prefer structured `code` from the client Error enrichment; fall back to
 * known PolicyViolation message shapes; never dump raw stack traces.
 */

export type ApiErrorFields = {
  message: string
  code?: string
  status?: number
  policyName?: string
  toolName?: string
  approvalId?: string
  stderr?: string[]
}

const API_TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  sync_publish: "Catalog publish",
  sync_preview: "Sync preview",
  sync_execute: "Sync execute",
  query_mssql: "Database query",
  mssql_query: "Database query",
  fetch_url: "Outbound fetch",
  read_file: "File read",
  write_file: "File write",
  run_command: "Shell command",
}

function toolLabel(toolName: string | undefined): string | null {
  if (!toolName) return null
  return API_TOOL_DISPLAY_NAMES[toolName] ?? toolName.replace(/_/g, " ")
}

function capitalize(text: string): string {
  if (!text) return text
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Normalize unknown catch values into the fields the API client attaches. */
export function asApiError(error: unknown): ApiErrorFields {
  if (error instanceof Error) {
    const extra = error as Error & Partial<ApiErrorFields>
    return {
      message: error.message || "Something went wrong",
      code: extra.code,
      status: extra.status,
      policyName: extra.policyName,
      toolName: extra.toolName,
      approvalId: extra.approvalId,
      stderr: extra.stderr,
    }
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>
    return {
      message: typeof record.message === "string"
        ? record.message
        : typeof record.error === "string"
          ? record.error
          : "Something went wrong",
      code: typeof record.code === "string" ? record.code : undefined,
      status: typeof record.status === "number" ? record.status : undefined,
      policyName: typeof record.policyName === "string" ? record.policyName : undefined,
      toolName: typeof record.toolName === "string" ? record.toolName : undefined,
      approvalId: typeof record.approvalId === "string" ? record.approvalId : undefined,
      stderr: Array.isArray(record.stderr) ? (record.stderr as string[]) : undefined,
    }
  }
  return { message: String(error || "Something went wrong") }
}

function formatPolicyDenied(err: ApiErrorFields): string {
  const action = toolLabel(err.toolName)
  const policy = err.policyName

  if (policy === "hosted_default_deny") {
    if (action) {
      return `${action} is not allowed by policy. Add an allow rule for this action in Policies, or ask an admin.`
    }
    return "This action is not allowed by policy. Add an allow rule in Policies, or ask an admin."
  }

  if (action && policy) return `${action} was blocked by policy “${policy}”.`
  if (action) return `${action} was blocked by policy.`
  if (policy) return `Blocked by policy “${policy}”.`

  const matched = err.message.match(/^Policy '([^']+)' violated:\s*(.+)$/i)
  if (matched) {
    const reason = matched[2]!.trim().replace(/\.\s*$/, "")
    return capitalize(reason) + "."
  }

  return err.message.replace(/^DENIED:\s*/i, "").trim() || "Blocked by policy."
}

function formatApprovalRequired(err: ApiErrorFields): string {
  const action = toolLabel(err.toolName)
  const policy = err.policyName
  if (action && policy) {
    return `${action} needs approval before it can continue (policy “${policy}”).`
  }
  if (action) return `${action} needs approval before it can continue.`
  if (policy) return `Approval required (policy “${policy}”).`
  return "Approval required before this action can continue."
}

/** Product copy for any failure surfaced to the operator UI. */
export function formatApiError(error: unknown): string {
  const err = asApiError(error)

  if (err.code === "policy_denied") return formatPolicyDenied(err)
  if (err.code === "approval_required") return formatApprovalRequired(err)

  const policyShape = err.message.match(/^Policy '([^']+)' violated:\s*(.+)$/i)
  if (policyShape) {
    return formatPolicyDenied({
      ...err,
      policyName: err.policyName ?? policyShape[1],
      message: err.message,
    })
  }

  if (err.status === 403 && /admin only/i.test(err.message)) {
    return "Admin access is required for this action."
  }

  const trimmed = err.message.trim()
  return trimmed || "Something went wrong."
}
