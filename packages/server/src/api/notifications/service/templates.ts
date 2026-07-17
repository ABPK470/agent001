/**
 * F1.10 — Notification body templates.
 *
 * Intentionally tiny — no Handlebars, no Mustache, no runtime
 * dependency. Just a per-event-type function that renders
 * `{ subject, text }`. Add new templates here as you add new event
 * routings; an unmapped event falls back to a generic JSON dump.
 */

export interface RenderedBody {
  subject: string
  text: string
}

export type TemplateRenderer = (ctx: Record<string, unknown>) => RenderedBody

const TEMPLATES: Readonly<Record<string, TemplateRenderer>> = {
  "sync.proposal.created": proposalCreated,
  "sync.proposal.annotated": proposalAnnotated,
  "sync.approval.requested": approvalRequested,
  "sync.approval.granted": approvalGranted,
  "sync.approval.rejected": approvalRejected,
  "sync.evidence.sealed": evidenceSealed,
  "sync.verification.completed": verificationCompleted,
  "sync.verification.failed": verificationFailed
} as const

export function renderNotificationBody(eventType: string, ctx: Record<string, unknown>): RenderedBody {
  const fn = TEMPLATES[eventType] ?? genericFallback(eventType)
  return fn(ctx)
}

function proposalCreated(ctx: Record<string, unknown>): RenderedBody {
  const entityType = String(ctx["entityType"] ?? "?")
  const envPair = String(ctx["envPair"] ?? "?")
  const riskTier = String(ctx["riskTier"] ?? "(unannotated)")
  return {
    subject: `[mia] proposal: ${entityType} (${riskTier})`,
    text: lines([
      `A new reconciliation proposal has been created.`,
      ``,
      `Entity:   ${entityType}`,
      `Env-pair: ${envPair}`,
      `Risk:     ${riskTier}`,
      `Counts:   ${formatCounts(ctx["counts"])}`,
      `Link:     ${String(ctx["url"] ?? "(no url)")}`
    ])
  }
}

function proposalAnnotated(ctx: Record<string, unknown>): RenderedBody {
  return {
    subject: `[mia] proposal annotated: ${String(ctx["entityType"] ?? "?")} (${String(ctx["riskTier"] ?? "?")})`,
    text: lines([
      `Annotator finished a proposal.`,
      ``,
      `Entity:    ${String(ctx["entityType"] ?? "?")}`,
      `Risk tier: ${String(ctx["riskTier"] ?? "?")}`,
      `Score:     ${String(ctx["riskScore"] ?? "?")}`,
      `Rationale: ${String(ctx["rationale"] ?? "")}`,
      `Link:      ${String(ctx["url"] ?? "(no url)")}`
    ])
  }
}

function approvalRequested(ctx: Record<string, unknown>): RenderedBody {
  return {
    subject: `[mia] approval required: ${String(ctx["entityType"] ?? "?")} → ${String(ctx["target"] ?? "?")}`,
    text: lines([
      `An approval is required to execute this proposal.`,
      ``,
      `Entity:      ${String(ctx["entityType"] ?? "?")}`,
      `Env-pair:    ${String(ctx["envPair"] ?? "?")}`,
      `Policy:      ${String(ctx["policy"] ?? "?")}`,
      `Requested:   ${String(ctx["requestedBy"] ?? "?")}`,
      `Expires:     ${String(ctx["expiresAt"] ?? "?")}`,
      ``,
      `Grant:  ${String(ctx["grantUrl"] ?? "")}`,
      `Reject: ${String(ctx["rejectUrl"] ?? "")}`
    ])
  }
}

function approvalGranted(ctx: Record<string, unknown>): RenderedBody {
  return {
    subject: `[mia] approval granted: ${String(ctx["entityType"] ?? "?")}`,
    text: lines([`Approval ${String(ctx["approvalId"] ?? "")} granted by ${String(ctx["by"] ?? "?")}.`])
  }
}

function approvalRejected(ctx: Record<string, unknown>): RenderedBody {
  return {
    subject: `[mia] approval rejected: ${String(ctx["entityType"] ?? "?")}`,
    text: lines([
      `Approval ${String(ctx["approvalId"] ?? "")} rejected by ${String(ctx["by"] ?? "?")}.`,
      `Reason: ${String(ctx["reason"] ?? "")}`
    ])
  }
}

function evidenceSealed(ctx: Record<string, unknown>): RenderedBody {
  return {
    subject: `[mia] evidence sealed for plan ${String(ctx["planId"] ?? "?")}`,
    text: lines([
      `Evidence envelope sealed.`,
      `Signer:      ${String(ctx["signerId"] ?? "?")} (${String(ctx["alg"] ?? "?")})`,
      `Content hash:${String(ctx["contentHash"] ?? "?")}`,
      `JSON:        ${String(ctx["envelopeUrl"] ?? "?")}`,
      `PDF:         ${String(ctx["pdfUrl"] ?? "?")}`
    ])
  }
}

function verificationCompleted(ctx: Record<string, unknown>): RenderedBody {
  return {
    subject: `[mia] post-execute verification OK (plan ${String(ctx["planId"] ?? "?")})`,
    text: lines([`Independent post-execute verification passed for plan ${String(ctx["planId"] ?? "?")}.`])
  }
}

function verificationFailed(ctx: Record<string, unknown>): RenderedBody {
  return {
    subject: `[mia] post-execute verification FAILED (plan ${String(ctx["planId"] ?? "?")})`,
    text: lines([
      `Independent post-execute verification FAILED for plan ${String(ctx["planId"] ?? "?")}.`,
      `Issues:`,
      ...(Array.isArray(ctx["issues"]) ? (ctx["issues"] as string[]).map((i) => `  - ${i}`) : [])
    ])
  }
}

function genericFallback(eventType: string): TemplateRenderer {
  return (ctx) => ({
    subject: `[mia] ${eventType}`,
    text: `${eventType}\n\n${JSON.stringify(ctx, null, 2)}`
  })
}

function lines(xs: readonly string[]): string {
  return xs.join("\n")
}

function formatCounts(v: unknown): string {
  if (!v || typeof v !== "object") return "(none)"
  const c = v as Record<string, number>
  return `insert=${c["insert"] ?? 0} update=${c["update"] ?? 0} delete=${c["delete"] ?? 0}`
}
