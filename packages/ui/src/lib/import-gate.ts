/**
 * Pure enablement rules for the platform import gate UI.
 */

import type { PlatformImportGateResult } from "@mia/shared-types"

export function fingerprintPayload(payload: string): string {
  return `${payload.length}:${payload.slice(0, 64)}:${payload.slice(-64)}`
}

export function canValidate(payload: string | null | undefined): boolean {
  return typeof payload === "string" && payload.length > 0
}

export function previewMatchesPayload(
  preview: PlatformImportGateResult | null,
  payloadFingerprint: string | null,
  currentFingerprint: string | null,
): boolean {
  if (!preview || !payloadFingerprint || !currentFingerprint) return false
  return payloadFingerprint === currentFingerprint
}

export function canApply(args: {
  preview: PlatformImportGateResult | null
  payloadFingerprint: string | null
  currentFingerprint: string | null
  reason: string
}): boolean {
  if (!args.preview?.ok || args.preview.applied) return false
  if (!previewMatchesPayload(args.preview, args.payloadFingerprint, args.currentFingerprint)) {
    return false
  }
  return args.reason.trim().length > 0
}
